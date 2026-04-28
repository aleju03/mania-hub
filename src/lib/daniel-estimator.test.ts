import { describe, expect, it } from "vitest";
import type { ManiaBeatmap } from "./beatmap-parser";
import { estimateDanielDan } from "./daniel-estimator";

function makeMap(notes: ManiaBeatmap["notes"], keyCount = 4): ManiaBeatmap {
  return {
    title: "Synthetic",
    artist: "Test",
    version: "4K",
    creator: "mania-hub",
    keyCount,
    od: 9,
    bpm: 180,
    notes,
    totalLength: notes.at(-1)?.endTime ?? 0,
    audioFilename: "",
    previewTime: 0,
    backgroundFilename: "",
    scrollVelocities: [],
  };
}

describe("estimateDanielDan", () => {
  it("returns a finite Daniel estimate for a 4K rice map", () => {
    const notes = Array.from({ length: 320 }, (_, index) => ({
      column: index % 4,
      time: index * 120,
      endTime: index * 120,
      isHold: false,
    }));

    const estimate = estimateDanielDan(makeMap(notes));

    expect(Number.isFinite(estimate.estimatedSr)).toBe(true);
    expect(Number.isFinite(estimate.rawDan)).toBe(true);
    expect(estimate.family).toBe("dan");
    expect(estimate.metrics.noteCount).toBe(notes.length);
    expect(estimate.warnings[0]).toContain("Daniel port");
  });

  it("rejects non-4K maps", () => {
    expect(() => estimateDanielDan(makeMap([], 7))).toThrow("4K");
  });
});
