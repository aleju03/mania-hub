import { describe, expect, it } from "vitest";

import { HighwayJudge, highwayKeyLegend, highwayStockNotes } from "./highway-play";
import type { HighwayChart } from "./supporter-profile-themes";

/* Two lanes: lane 0 has notes at 1000 and 2000 ms, lane 1 at 1500. */
function chart(): HighwayChart {
  const notes = new Float32Array(1024 * 4);
  [[1000, 1000], [2000, 2000], [1500, 1500]].forEach(([start, end], i) => notes.set([start, end, 0, 0], i * 4));
  return { lanes: 2, notes, notesWidth: 1024, notesHeight: 1, index: new Float32Array(2), buckets: 1, bucketMs: 100, laneEnd: [2, 3], period: 5000, key: "test" };
}

describe("HighwayJudge", () => {
  it("judges a press by its distance from the earliest note in reach and takes that note", () => {
    const judge = new HighwayJudge(chart(), 0);
    expect(judge.press(0, 500)).toBeNull();
    expect(judge.press(0, 1010)).toEqual({ judgement: "MAX", error: 10 });
    expect(judge.hitUntil[0]).toBe(1000);
    // the same note cannot be hit twice
    expect(judge.press(0, 1020)).toBeNull();
    expect(judge.press(1, 1440)).toEqual({ judgement: "200", error: -60 });
    expect(judge.press(0, 2130)?.judgement).toBe("50");
    expect(judge.stats).toMatchObject({ combo: 3, maxCombo: 3 });
    expect(judge.stats.accuracy).toBeCloseTo(((300 + 200 + 50) / 900) * 100);
  });

  it("counts a note left behind as a miss, breaks the combo and starts over when the loop wraps", () => {
    const judge = new HighwayJudge(chart(), 0);
    expect(judge.press(0, 1000)?.judgement).toBe("MAX");
    expect(judge.advance(1700)).toEqual({ misses: 1, wrapped: false });
    expect(judge.stats).toMatchObject({ combo: 0, maxCombo: 1 });
    expect(judge.advance(4900).misses).toBe(1);
    expect(judge.advance(100)).toEqual({ misses: 0, wrapped: true });
    expect(judge.hitUntil).toEqual([-1, -1]);
    expect(judge.press(0, 990)?.judgement).toBe("MAX");
  });

  it("owes nothing for notes that passed before it started", () => {
    const judge = new HighwayJudge(chart(), 1800);
    expect(judge.advance(1900).misses).toBe(0);
    expect(judge.press(0, 2000)?.judgement).toBe("MAX");
  });
});

describe("the highway's own notes and keycaps", () => {
  it("fills every lane at the shader's own pace, about two notes a row, the same every time", () => {
    const notes = highwayStockNotes(4, 24_000);
    expect(notes.every((note) => note.column >= 0 && note.column < 4 && note.time % 190 === 0 && note.time <= 24_000)).toBe(true);
    const rows = 24_000 / 190;
    expect(notes.length / rows).toBeGreaterThan(1.6);
    expect(notes.length / rows).toBeLessThan(2.4);
    expect(highwayStockNotes(4, 24_000)).toEqual(notes);
    // seven lanes thin out so a row still holds about two
    expect(highwayStockNotes(7, 24_000).length / rows).toBeLessThan(2.5);
  });

  it("names keys the way a keycap would", () => {
    expect(["KeyD", "Space", "Semicolon", "Digit4"].map(highwayKeyLegend)).toEqual(["D", " ", ";", "4"]);
  });
});
