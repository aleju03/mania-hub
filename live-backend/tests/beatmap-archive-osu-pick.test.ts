import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  __findBeatmapOsuFileInArchiveBufferForTest as findBeatmapOsuFileInArchiveBuffer,
  beatmapFileMatchesBeatmapId,
  beatmapFileMatchesVersion,
} from "../src/audio/beatmap-archive.js";

// Cannonball Circuit (set 2016782) is the shape this guards: four of the set's
// five .osu files carry BeatmapID 4198735 because the mapper's rate edits were
// copied from the ranked diff, and the 1.4x one is the smallest, so the old
// "first id match wins" pick cached it as the ranked chart.
function osuFile(version: string, beatmapId: number, padding = 0): string {
  return [
    "osu file format v14",
    "",
    "[Metadata]",
    "Title:Cannonball Circuit",
    `Version:${version}`,
    `BeatmapID:${beatmapId}`,
    "BeatmapSetID:2016782",
    "",
    "[HitObjects]",
    ..."x".repeat(padding).split(""),
  ].join("\r\n");
}

async function archiveOf(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

const RATE_EDIT = "Ryuji Iuchi - Cannonball Circuit (chxu) [Eddie Van Halen 1.4x].osu";
const RANKED = "Ryuji Iuchi - Cannonball Circuit (chxu) [Eddie Van Halen].osu";

describe("archive .osu selection", () => {
  it("picks the named difficulty over a rate edit that kept its BeatmapID", async () => {
    const buffer = await archiveOf({
      // Smaller, so it sorts first without the version hint.
      [RATE_EDIT]: osuFile("Eddie Van Halen 1.4x", 4198735),
      [RANKED]: osuFile("Eddie Van Halen", 4198735, 400),
    });

    const found = findBeatmapOsuFileInArchiveBuffer(buffer, 4198735, { version: "[4K] Eddie Van Halen" });

    expect(found.path).toBe(RANKED);
  });

  it("falls back to an id match when no file carries the named difficulty", async () => {
    const buffer = await archiveOf({ [RATE_EDIT]: osuFile("Eddie Van Halen 1.4x", 4198735) });

    const found = findBeatmapOsuFileInArchiveBuffer(buffer, 4198735, { version: "[4K] Eddie Van Halen" });

    expect(found.path).toBe(RATE_EDIT);
  });

  it("refuses to guess when several mismatched files carry the id", async () => {
    const buffer = await archiveOf({
      [RATE_EDIT]: osuFile("Eddie Van Halen 1.4x", 4198735),
      "Ryuji Iuchi - Cannonball Circuit (chxu) [Eddie Van Halen 1.3x].osu": osuFile("Eddie Van Halen 1.3x", 4198735),
    });

    expect(() => findBeatmapOsuFileInArchiveBuffer(buffer, 4198735, { version: "[4K] Eddie Van Halen" }))
      .toThrow(/2 id matches/);
  });

  it("also refuses copied edits that retained both BeatmapID and Version", async () => {
    const buffer = await archiveOf({
      [RATE_EDIT]: osuFile("Eddie Van Halen", 4198735),
      "Ryuji Iuchi - Cannonball Circuit (chxu) [Eddie Van Halen 1.3x].osu": osuFile("Eddie Van Halen", 4198735),
    });

    expect(() => findBeatmapOsuFileInArchiveBuffer(buffer, 4198735, { version: "[4K] Eddie Van Halen" }))
      .toThrow(/2 id matches/);
  });

  it("does not erase symbol-only difficulty names while matching", async () => {
    const ranked = "Artist - Title (Creator) [†].osu";
    const buffer = await archiveOf({
      "Artist - Title (Creator) [† 1.4x].osu": osuFile("† 1.4x", 4198735),
      [ranked]: osuFile("†", 4198735, 400),
    });

    const found = findBeatmapOsuFileInArchiveBuffer(buffer, 4198735, { version: "[4K] †" });

    expect(found.path).toBe(ranked);
  });

  it("still matches on the id alone when the difficulty is unknown", async () => {
    const buffer = await archiveOf({
      [RATE_EDIT]: osuFile("Eddie Van Halen 1.4x", 4198735),
      [RANKED]: osuFile("Eddie Van Halen", 4198735, 400),
    });

    const found = findBeatmapOsuFileInArchiveBuffer(buffer, 4198735, {});

    expect(found.path).toBe(RATE_EDIT);
  });

  it("throws when nothing in the archive carries the id", async () => {
    const buffer = await archiveOf({ [RANKED]: osuFile("Eddie Van Halen", 4198732) });

    expect(() => findBeatmapOsuFileInArchiveBuffer(buffer, 4198735, { version: "[4K] Eddie Van Halen" }))
      .toThrow(/BeatmapID 4198735 not found/);
  });
});

describe("beatmapFileMatchesVersion", () => {
  it("ignores the keymode prefix osu! puts on mania difficulty names", () => {
    expect(beatmapFileMatchesVersion(osuFile("Eddie Van Halen", 4198735), "[4K] Eddie Van Halen")).toBe(true);
  });

  it("reports a rate edit stored under the ranked difficulty", () => {
    expect(beatmapFileMatchesVersion(osuFile("Eddie Van Halen 1.4x", 4198735), "[4K] Eddie Van Halen")).toBe(false);
  });

  it("allows an unknown expected name but rejects a missing stored Version", () => {
    expect(beatmapFileMatchesVersion(osuFile("Eddie Van Halen 1.4x", 4198735), null)).toBe(true);
    expect(beatmapFileMatchesVersion("osu file format v14\r\n", "[4K] Eddie Van Halen")).toBe(false);
  });

  it("keeps punctuation and symbols significant in Version equality", () => {
    expect(beatmapFileMatchesVersion(osuFile("EX+", 4198735), "[4K] EX")).toBe(false);
    expect(beatmapFileMatchesVersion(osuFile("†", 4198735), "[4K] †")).toBe(true);
  });

  it("checks the file's own BeatmapID", () => {
    expect(beatmapFileMatchesBeatmapId(osuFile("Chart", 4198735), 4198735)).toBe(true);
    expect(beatmapFileMatchesBeatmapId(osuFile("Chart", 4198734), 4198735)).toBe(false);
  });
});
