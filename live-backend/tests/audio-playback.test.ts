import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preparePlaybackAudio } from "../src/audio/beatmap-audio.js";

const ffmpeg = process.env.FFMPEG_PATH || ffmpegStaticPath || "ffmpeg";

function readOggAudioPages(buffer: Buffer) {
  const pages: { granule: number; packets: number }[] = [];
  for (let offset = 0; offset < buffer.length;) {
    expect(buffer.toString("ascii", offset, offset + 4)).toBe("OggS");
    const granule = Number(buffer.readBigInt64LE(offset + 6));
    const lacing = buffer.subarray(offset + 27, offset + 27 + buffer[offset + 26]);
    if (granule > 0) pages.push({ granule, packets: [...lacing].filter((size) => size < 255).length });
    offset += 27 + lacing.length + lacing.reduce((sum, size) => sum + size, 0);
  }
  return pages;
}

describe("seekable beatmap audio", () => {
  let directory: string;

  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "mania-audio-test-")); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("gives every Ogg audio packet a timestamp without changing decoded samples", async () => {
    const sourcePath = join(directory, "source.ogg");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=44100:duration=3", "-c:a", "libvorbis", sourcePath]);
    const source = await readFile(sourcePath);
    const prepared = await preparePlaybackAudio({ buffer: source, mimeType: "audio/ogg" }, "SONG.OGG");
    expect(prepared.mimeType).toBe("audio/ogg");
    const repeated = await preparePlaybackAudio({ buffer: source, mimeType: "audio/ogg" }, "other-name.ogg");
    expect(repeated.buffer.equals(prepared.buffer)).toBe(true);
    const before = readOggAudioPages(source);
    const after = readOggAudioPages(prepared.buffer);
    expect(before.some((page) => page.packets > 1)).toBe(true);
    expect(after.length).toBeGreaterThan(100);
    expect(after.every((page) => page.packets === 1)).toBe(true);
    expect(after.at(-1)?.granule).toBe(before.at(-1)?.granule);
    const preparedPath = join(directory, "prepared.ogg");
    await writeFile(preparedPath, prepared.buffer);
    const pcmHash = (path: string) => execFileSync(ffmpeg, ["-v", "error", "-i", path, "-f", "hash", "-hash", "sha256", "-"], { encoding: "utf8" });
    expect(pcmHash(preparedPath)).toBe(pcmHash(sourcePath));
  });

  it("keeps the existing lossless MP3-in-MP4 playback format", async () => {
    const sourcePath = join(directory, "source.mp3");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "libmp3lame", sourcePath]);
    const prepared = await preparePlaybackAudio({ buffer: await readFile(sourcePath), mimeType: "audio/mpeg" }, "song.mp3");
    expect(prepared.mimeType).toBe("audio/mp4");
    expect(prepared.buffer.toString("ascii", 4, 8)).toBe("ftyp");
  });

  it("leaves other playback formats untouched", async () => {
    const source = { buffer: Buffer.from("wav"), mimeType: "audio/wav" };
    expect(await preparePlaybackAudio(source, "song.wav")).toBe(source);
  });
});
