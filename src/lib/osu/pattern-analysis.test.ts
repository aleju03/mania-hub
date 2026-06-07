import { describe, expect, it } from "vitest";
import { countChartBreaks, getChartBreakRanges } from "./pattern-analysis";
import type { ManiaBeatmap } from "../beatmap-parser";

function note(time: number): ManiaBeatmap["notes"][number] {
  return { column: 0, time, endTime: time, isHold: false };
}

describe("countChartBreaks", () => {
  it("counts long low-density rest sections even when sparse notes remain", () => {
    const notes: ManiaBeatmap["notes"] = [];

    for (let time = 0; time < 20_000; time += 80) notes.push(note(time));
    for (let time = 25_000; time <= 55_000; time += 1_400) notes.push(note(time));
    for (let time = 60_000; time < 80_000; time += 80) notes.push(note(time));

    expect(countChartBreaks({ breakPeriods: [], notes, totalLength: 80_000 })).toBe(1);
    expect(getChartBreakRanges({ breakPeriods: [], notes, totalLength: 80_000 })).toEqual([
      expect.objectContaining({ kind: "inferred" }),
    ]);
  });

  it("does not count sparse intro sections as breaks", () => {
    const notes: ManiaBeatmap["notes"] = [];

    for (let time = 0; time <= 30_000; time += 1_400) notes.push(note(time));
    for (let time = 35_000; time < 55_000; time += 80) notes.push(note(time));

    expect(countChartBreaks({ breakPeriods: [], notes, totalLength: 55_000 })).toBe(0);
  });

  it("counts declared break periods when the chart has no inferred rest", () => {
    const notes: ManiaBeatmap["notes"] = [];
    for (let time = 0; time < 80_000; time += 120) notes.push(note(time));

    expect(countChartBreaks({
      breakPeriods: [{ startTime: 30_000, endTime: 40_000 }],
      notes,
      totalLength: 80_000,
    })).toBe(1);
    expect(getChartBreakRanges({
      breakPeriods: [{ startTime: 30_000, endTime: 40_000 }],
      notes,
      totalLength: 80_000,
    })).toEqual([{ startTime: 30_000, endTime: 40_000, kind: "declared" }]);
  });

  it("evaluates inferred rest gaps at the chart playback rate", () => {
    const notesForShortGap: ManiaBeatmap["notes"] = [];
    for (let time = 0; time < 10_000; time += 80) notesForShortGap.push(note(time));
    notesForShortGap.push(note(14_000));
    for (let time = 14_080; time < 24_000; time += 80) notesForShortGap.push(note(time));

    const notesForLongGap: ManiaBeatmap["notes"] = [];
    for (let time = 0; time < 10_000; time += 80) notesForLongGap.push(note(time));
    notesForLongGap.push(note(16_000));
    for (let time = 16_080; time < 26_000; time += 80) notesForLongGap.push(note(time));

    expect(countChartBreaks({ breakPeriods: [], notes: notesForShortGap, totalLength: 24_000 })).toBe(0);
    expect(countChartBreaks({ breakPeriods: [], notes: notesForShortGap, totalLength: 24_000 }, 0.75)).toBe(1);
    expect(countChartBreaks({ breakPeriods: [], notes: notesForLongGap, totalLength: 26_000 }, 1.5)).toBe(0);
  });
});
