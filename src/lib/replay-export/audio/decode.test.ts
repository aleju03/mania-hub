import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({
  canDecode: vi.fn(), duration: vi.fn(), firstTimestamp: vi.fn(), channels: vi.fn(), dispose: vi.fn(),
}));
vi.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  AudioSampleSink: class {},
  Input: class {
    dispose = media.dispose;
    async getPrimaryAudioTrack() {
      return {
        canDecode: media.canDecode, computeDuration: media.duration,
        getFirstTimestamp: media.firstTimestamp, getNumberOfChannels: media.channels,
      };
    }
  },
}));

import { openSongPcmSource } from "./decode";

const decode = vi.fn();
const createContext = vi.fn();
const budget = 256 * 1024 * 1024;
const options = { startSeconds: 1199, endSeconds: 1200, memoryBudgetBytes: budget };

beforeEach(() => {
  media.canDecode.mockReset().mockResolvedValue(false);
  media.duration.mockReset().mockResolvedValue(1);
  media.firstTimestamp.mockReset().mockResolvedValue(0);
  media.channels.mockReset().mockResolvedValue(2);
  media.dispose.mockReset();
  decode.mockReset();
  createContext.mockReset();
  vi.stubGlobal("OfflineAudioContext", class {
    decodeAudioData = decode;
    constructor(...args: unknown[]) { createContext(...args); }
  });
});
afterEach(() => vi.unstubAllGlobals());

function fakeFile(size = 1000) {
  return { size, arrayBuffer: vi.fn(async () => new ArrayBuffer(size)) } as unknown as Blob;
}

function decodedAudio(channels = 2, frames = 48_000) {
  const planes = Array.from({ length: channels }, () => new Float32Array(Math.min(frames, 48_000)).fill(0.25));
  return {
    duration: frames / 48_000, length: frames, sampleRate: 48_000, numberOfChannels: channels,
    getChannelData: vi.fn((channel: number) => planes[channel]),
  };
}

describe("whole-song decode admission", () => {
  it("rejects a long song before allocating or decoding even for a one-second late clip", async () => {
    media.duration.mockResolvedValue(1200);
    const file = fakeFile();
    await expect(openSongPcmSource(file, options)).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it("includes the encoded input copies in the pre-decode budget", async () => {
    // Stereo PCM + one second padding is 768,000 bytes. The two encoded
    // copies put this over 900,000 bytes before any full input is read.
    const file = fakeFile(100_000);
    await expect(openSongPcmSource(file, { ...options, memoryBudgetBytes: 900_000 }))
      .rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, 0, -1])("does not decode when duration %s cannot be budgeted", async (duration) => {
    media.duration.mockResolvedValue(duration);
    const file = fakeFile();
    await expect(openSongPcmSource(file, options)).rejects.toMatchObject({ code: "unsupported_audio_decode" });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it("does not decode when channel metadata is unavailable", async () => {
    media.channels.mockResolvedValue(0);
    await expect(openSongPcmSource(fakeFile(), options)).rejects.toMatchObject({ code: "unsupported_audio_decode" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("counts negative packet timestamps and decoder padding", async () => {
    media.duration.mockResolvedValue(1);
    media.firstTimestamp.mockResolvedValue(-2);
    await expect(openSongPcmSource(fakeFile(), { ...options, memoryBudgetBytes: 1_000_000 }))
      .rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("decodes an admitted source at 48 kHz without duplicating its channel planes", async () => {
    const buffer = decodedAudio();
    const planes = [buffer.getChannelData(0), buffer.getChannelData(1)];
    const copies = planes.map((plane) => vi.spyOn(plane, "slice"));
    decode.mockResolvedValue(buffer);
    const source = await openSongPcmSource(fakeFile(), options);
    expect(createContext).toHaveBeenCalledWith(2, 1, 48_000);
    expect(source.window.sample(0, 0)).toBe(0.25);
    expect(copies.every((copy) => copy.mock.calls.length === 0)).toBe(true);
    expect(source.estimatedBytes).toBe(2000 + 48_000 * 2 * 4);
    await source.close();
    expect(source.window.bufferedFrames).toBe(0);
  });

  it("still rejects unexpected decoder expansion without copying PCM", async () => {
    const buffer = decodedAudio(2, 48_000 * 1200);
    decode.mockResolvedValue(buffer);
    await expect(openSongPcmSource(fakeFile(), options)).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect(buffer.getChannelData).not.toHaveBeenCalled();
  });

  it("releases the demuxer if metadata inspection fails", async () => {
    media.duration.mockRejectedValue(new Error("invalid packet table"));
    await expect(openSongPcmSource(fakeFile(), options)).rejects.toMatchObject({ code: "unsupported_audio_decode" });
    expect(media.dispose).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });
});
