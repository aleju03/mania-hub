import { describe, expect, it } from "vitest";
import { invertManiaOsuText } from "../src/dan/invert-mod.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";

function file(hitObjects: string[], options: { keys?: number; timing?: string[]; events?: string[] } = {}): string {
  return [
    "osu file format v14",
    "",
    "[General]",
    "AudioFilename: audio.mp3",
    "Mode: 3",
    "",
    "[Difficulty]",
    `CircleSize:${options.keys ?? 4}`,
    "OverallDifficulty:8",
    "",
    "[Events]",
    ...(options.events ?? []),
    "",
    "[TimingPoints]",
    ...(options.timing ?? ["0,500,4,2,0,100,1,0"]),
    "",
    "[HitObjects]",
    ...hitObjects,
    "",
  ].join("\n");
}

function objects(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf("[HitObjects]");
  return lines.slice(start + 1).filter((line) => line.trim() !== "");
}

describe("invertManiaOsuText", () => {
  it("turns each gap into a hold shortened by a quarter beat and drops the last object per column", () => {
    // Column 0 (x 64): taps at 1000, 2000, 4000. Beat length 500ms, so a quarter
    // beat is 125ms: 1000 -> 1875 and 2000 -> 3875. The 4000 tap is the column's
    // last location and gets nothing.
    const text = file(["64,192,1000,1,0,0:0:0:0:", "64,192,2000,1,0,0:0:0:0:", "64,192,4000,1,0,0:0:0:0:"]);
    expect(objects(invertManiaOsuText(text)!)).toEqual([
      "64,192,1000,128,0,1875:0:0:0:0:",
      "64,192,2000,128,0,3875:0:0:0:0:",
    ]);
  });

  it("never shortens a hold below half its gap", () => {
    // 100ms gap, quarter beat 125ms: the hold keeps half the gap, 50ms.
    const text = file(["64,192,1000,1,0,0:0:0:0:", "64,192,1100,1,0,0:0:0:0:"]);
    expect(objects(invertManiaOsuText(text)!)).toEqual(["64,192,1000,128,0,1050:0:0:0:0:"]);
  });

  it("ignores a hold's end: only object starts are locations, as in ManiaModInvert", () => {
    // Hold 1000-1600, then a tap at 2000: lazer emits one hold 1000 -> 1875,
    // the same as if the hold had been a tap.
    const text = file(["64,192,1000,128,0,1600:0:0:0:0:", "64,192,2000,1,0,0:0:0:0:"]);
    expect(objects(invertManiaOsuText(text)!)).toEqual(["64,192,1000,128,0,1875:0:0:0:0:"]);
  });

  it("reads the beat length from the red line in force at the next location", () => {
    // 500ms beats until 3000, then 200ms beats (quarter = 50ms).
    const text = file(
      ["64,192,1000,1,0,0:0:0:0:", "64,192,2000,1,0,0:0:0:0:", "64,192,4000,1,0,0:0:0:0:", "64,192,5000,1,0,0:0:0:0:"],
      { timing: ["0,500,4,2,0,100,1,0", "2500,-100,4,2,0,100,0,0", "3000,200,4,2,0,100,1,0"] },
    );
    expect(objects(invertManiaOsuText(text)!)).toEqual([
      "64,192,1000,128,0,1875:0:0:0:0:",
      "64,192,2000,128,0,3950:0:0:0:0:",
      "64,192,4000,128,0,4950:0:0:0:0:",
    ]);
  });

  it("works per column and keeps the rest of the file, minus the breaks", () => {
    const text = file(
      ["64,192,1000,1,0,0:0:0:0:", "192,192,1000,1,0,0:0:0:0:", "64,192,3000,1,0,0:0:0:0:", "192,192,2000,1,0,0:0:0:0:"],
      { events: ["//Background and Video events", "0,0,\"bg.jpg\",0,0", "//Break Periods", "2,1200,1800"] },
    );
    const inverted = invertManiaOsuText(text)!;
    expect(objects(inverted)).toEqual([
      "64,192,1000,128,0,2875:0:0:0:0:",
      "192,192,1000,128,0,1875:0:0:0:0:",
    ]);
    expect(inverted).toContain("Mode: 3");
    expect(inverted).toContain("CircleSize:4");
    expect(inverted).toContain("0,0,\"bg.jpg\",0,0");
    expect(inverted).not.toContain("2,1200,1800");
    const parsed = parseManiaBeatmap(inverted);
    expect(parsed.keyCount).toBe(4);
    expect(parsed.notes.every((note) => note.isHold)).toBe(true);
    expect(parsed.breakPeriods).toEqual([]);
  });

  it("returns null for a file it cannot rebuild", () => {
    expect(invertManiaOsuText("osu file format v14\n[General]\nMode: 3\n")).toBeNull();
    expect(invertManiaOsuText(file([]))).toBeNull();
  });
});
