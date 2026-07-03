import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { isLocalBeatmapFileName, matchLocalBeatmapFile } from "./replay-local-beatmap";

const OSU_CONTENT = [
  "osu file format v14",
  "",
  "[General]",
  "AudioFilename: audio.mp3",
  "Mode: 3",
  "",
  "[Events]",
  '0,0,"bg.jpg",0,0',
  "",
  "[HitObjects]",
  "64,192,1000,1,0,0:0:0:0:",
].join("\r\n");

const OTHER_CONTENT = OSU_CONTENT.replace("1000", "2000");

function md5Of(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

function makeFile(data: ArrayBuffer | Uint8Array | string, name: string): File {
  return new File([data as BlobPart], name);
}

async function makeOsz(files: Record<string, string | Uint8Array>): Promise<File> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  return makeFile(buffer, "map.osz");
}

describe("isLocalBeatmapFileName", () => {
  it("accepts .osz, .zip and .osu, rejects everything else", () => {
    expect(isLocalBeatmapFileName("Map.OSZ")).toBe(true);
    expect(isLocalBeatmapFileName("map.zip")).toBe(true);
    expect(isLocalBeatmapFileName("chart.osu")).toBe(true);
    expect(isLocalBeatmapFileName("replay.osr")).toBe(false);
    expect(isLocalBeatmapFileName("song.mp3")).toBe(false);
  });
});

describe("matchLocalBeatmapFile", () => {
  it("finds the difficulty matching the checksum inside an .osz and extracts audio + background", async () => {
    const file = await makeOsz({
      "other [easy].osu": OTHER_CONTENT,
      "song [hard].osu": OSU_CONTENT,
      "audio.mp3": new Uint8Array([1, 2, 3]),
      "bg.jpg": new Uint8Array([4, 5, 6]),
    });

    const match = await matchLocalBeatmapFile(file, md5Of(OSU_CONTENT));
    expect(match.osuFilename).toBe("song [hard].osu");
    expect(match.content).toBe(OSU_CONTENT);
    expect(match.audioFilename).toBe("audio.mp3");
    expect(match.backgroundFilename).toBe("bg.jpg");
    expect(match.audioBlob).not.toBeNull();
    expect(match.backgroundBlob).not.toBeNull();
    expect((match.audioBlob as Blob).size).toBe(3);
  });

  it("matches audio filenames case-insensitively and survives missing assets", async () => {
    const file = await makeOsz({
      "song.osu": OSU_CONTENT,
      "AUDIO.MP3": new Uint8Array([9]),
    });

    const match = await matchLocalBeatmapFile(file, md5Of(OSU_CONTENT));
    expect(match.audioBlob).not.toBeNull();
    expect(match.backgroundBlob).toBeNull();
  });

  it("rejects an .osz where no difficulty matches", async () => {
    const file = await makeOsz({
      "a.osu": OTHER_CONTENT,
      "b.osu": `${OTHER_CONTENT}\r\n`,
    });

    await expect(matchLocalBeatmapFile(file, md5Of(OSU_CONTENT))).rejects.toThrow(
      /None of the 2 difficulties/,
    );
  });

  it("rejects an archive without difficulties", async () => {
    const file = await makeOsz({ "readme.txt": "hi" });
    await expect(matchLocalBeatmapFile(file, md5Of(OSU_CONTENT))).rejects.toThrow(
      /no \.osu difficulty files/,
    );
  });

  it("rejects a file that is not an archive", async () => {
    const file = makeFile("not a zip", "map.osz");
    await expect(matchLocalBeatmapFile(file, md5Of(OSU_CONTENT))).rejects.toThrow(
      /valid \.osz/,
    );
  });

  it("accepts a bare .osu file with the right checksum", async () => {
    const file = makeFile(OSU_CONTENT, "song.osu");
    const match = await matchLocalBeatmapFile(file, md5Of(OSU_CONTENT).toUpperCase());
    expect(match.content).toBe(OSU_CONTENT);
    expect(match.audioBlob).toBeNull();
  });

  it("rejects a bare .osu file with the wrong checksum", async () => {
    const file = makeFile(OTHER_CONTENT, "song.osu");
    await expect(matchLocalBeatmapFile(file, md5Of(OSU_CONTENT))).rejects.toThrow(
      /different version of the map/,
    );
  });

  it("rejects unsupported file types", async () => {
    const file = makeFile("audio", "song.mp3");
    await expect(matchLocalBeatmapFile(file, md5Of(OSU_CONTENT))).rejects.toThrow(
      /\.osz archive/,
    );
  });
});
