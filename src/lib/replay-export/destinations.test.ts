import { AudioSample, AudioSampleSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, Mp4OutputFormat, Output, WavOutputFormat } from "mediabunny";
import { describe, expect, it, vi } from "vitest";

import { createBufferDestination, createFileDestination, type ReplayExportDestination } from "./destinations";

// WAV muxing needs no WebCodecs (PCM is passed through), and it finishes by
// rewriting its header at the front of the file. That makes it the right
// stand-in here for MP4's habit of revisiting byte ranges it already wrote.

type Write = { position: number; length: number };

function fakeHandle() {
  const writes: Write[] = [];
  const bytes: number[] = [];
  const state = { closed: false, aborted: false, truncatedTo: -1 };
  const handle = {
    createWritable: vi.fn(async () => ({
      write: async (chunk: { type: "write"; position: number; data: Uint8Array }) => {
        writes.push({ position: chunk.position, length: chunk.data.byteLength });
        for (let i = 0; i < chunk.data.byteLength; i++) bytes[chunk.position + i] = chunk.data[i];
      },
      truncate: async (size: number) => {
        state.truncatedTo = size;
      },
      close: async () => {
        state.closed = true;
      },
      abort: async () => {
        state.aborted = true;
      },
    })),
  } as unknown as FileSystemFileHandle;
  return { handle, writes, bytes, state };
}

async function muxSilentWav(destination: ReplayExportDestination, blocks = 4): Promise<void> {
  const output = new Output({ format: new WavOutputFormat(), target: destination.target });
  const source = new AudioSampleSource({ codec: "pcm-f32" });
  output.addAudioTrack(source);
  await output.start();
  for (let index = 0; index < blocks; index++) {
    const data = new Float32Array(480 * 2);
    const sample = new AudioSample({
      data,
      format: "f32",
      numberOfChannels: 2,
      sampleRate: 48_000,
      timestamp: (index * 480) / 48_000,
    });
    await source.add(sample);
    sample.close();
  }
  source.close();
  await output.finalize();
}

describe("file destination", () => {
  it("writes every chunk at its own offset, including the header rewrite", async () => {
    const { handle, writes, bytes, state } = fakeHandle();
    const destination = await createFileDestination({
      handle,
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 1024 * 1024,
      // Small enough that the data flushes before the header is rewritten.
      chunkSize: 1024,
    });
    await muxSilentWav(destination);
    // The muxer went back to the start to finish the RIFF header.
    expect(writes.some((write) => write.position === 0)).toBe(true);
    expect(writes.length).toBeGreaterThan(1);
    // Nothing is committed until the manager says so.
    expect(state.closed).toBe(false);

    const result = await destination.commit();
    expect(state.closed).toBe(true);
    expect(state.truncatedTo).toBe(destination.bytesWritten);
    expect(result.byteLength).toBe(destination.bytesWritten);
    expect(bytes.length).toBe(destination.bytesWritten);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
  });

  it("tracks the highest offset written, not the sum of every rewrite", async () => {
    const { handle, writes } = fakeHandle();
    const destination = await createFileDestination({
      handle,
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 1024 * 1024,
      chunkSize: 1024,
    });
    await muxSilentWav(destination);
    const total = writes.reduce((sum, write) => sum + write.length, 0);
    const highest = Math.max(...writes.map((write) => write.position + write.length));
    expect(destination.bytesWritten).toBe(highest);
    expect(destination.bytesWritten).toBeLessThan(total);
    await destination.abort();
  });

  it("leaves an existing file intact when the export is cancelled", async () => {
    const { handle, state } = fakeHandle();
    const destination = await createFileDestination({
      handle,
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 1024 * 1024,
    });
    await muxSilentWav(destination);
    // The muxer closing its stream is not authorization to replace the file.
    await destination.abort();
    expect(state.closed).toBe(false);
    expect(state.aborted).toBe(true);
  });

  it("stops the muxer once the output passes its byte limit", async () => {
    const { handle } = fakeHandle();
    const destination = await createFileDestination({
      handle,
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 2_000,
    });
    await expect(muxSilentWav(destination, 40)).rejects.toThrow();
    await destination.abort();
  });

  it("refuses to settle twice", async () => {
    const { handle } = fakeHandle();
    const destination = await createFileDestination({
      handle,
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 1024 * 1024,
    });
    await muxSilentWav(destination);
    await destination.commit();
    await expect(destination.commit()).rejects.toMatchObject({ code: "storage_write_failed" });
  });

  it("surfaces a failure to open as a storage error", async () => {
    const handle = {
      createWritable: vi.fn(async () => {
        throw new Error("denied");
      }),
    } as unknown as FileSystemFileHandle;
    await expect(createFileDestination({ handle, filename: "a.mp4", mimeType: "video/mp4", maxBytes: 1 }))
      .rejects.toMatchObject({ code: "storage_write_failed" });
  });
});

describe("buffer destination", () => {
  it("rejects MP4 output that crosses its cap only when the muxer finalizes", async () => {
    const destination = createBufferDestination({ filename: "out.mp4", mimeType: "video/mp4", maxBytes: 1000 });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: destination.target });
    const source = new EncodedAudioPacketSource("aac");
    output.addAudioTrack(source);
    await output.start();
    for (let i = 0; i < 10; i++) {
      await source.add(new EncodedPacket(new Uint8Array(128), "key", i * 1024 / 48_000, 1024 / 48_000), {
        decoderConfig: { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) },
      });
    }
    expect(destination.bytesWritten).toBeLessThan(1000);
    source.close();
    await expect(output.finalize()).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect((destination.target as BufferTarget).buffer).toBeNull();
    await destination.abort();
    await expect(destination.commit()).rejects.toMatchObject({ code: "storage_write_failed" });
  });

  it("rechecks the final buffer before making a Blob, even without a finalize notification", async () => {
    const destination = createBufferDestination({ filename: "out.mp4", mimeType: "video/mp4", maxBytes: 1000 });
    (destination.target as BufferTarget).buffer = new ArrayBuffer(1001);
    await expect(destination.commit()).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect((destination.target as BufferTarget).buffer).toBeNull();
  });

  it("admits a finalized buffer exactly at the cap", async () => {
    const destination = createBufferDestination({ filename: "out.mp4", mimeType: "video/mp4", maxBytes: 1000 });
    (destination.target as BufferTarget).buffer = new ArrayBuffer(1000);
    expect((await destination.commit()).byteLength).toBe(1000);
  });

  it("hands back a Blob of exactly what was muxed", async () => {
    const destination = createBufferDestination({
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 1024 * 1024,
    });
    await muxSilentWav(destination);
    const result = await destination.commit();
    expect(result.kind).toBe("blob");
    expect(result.blob?.size).toBe(result.byteLength);
    expect(result.byteLength).toBe(destination.bytesWritten);
  });

  it("fails rather than hand back an empty result when nothing was muxed", async () => {
    const destination = createBufferDestination({
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 1024,
    });
    await expect(destination.commit()).rejects.toMatchObject({ code: "encoder_failed" });
  });

  it("drops its buffer on abort", async () => {
    const destination = createBufferDestination({
      filename: "out.wav",
      mimeType: "audio/wav",
      maxBytes: 1024 * 1024,
    });
    await muxSilentWav(destination);
    await destination.abort();
    await expect(destination.commit()).rejects.toMatchObject({ code: "storage_write_failed" });
  });
});
