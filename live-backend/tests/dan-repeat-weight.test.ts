import { describe, expect, it } from "vitest";
import {
  danSideFromClearEvidenceForTest,
  selectDanRatingClears,
  weightedDanClearWindow,
  type ChartSkillInfo,
  type DanClearEvidence,
} from "../src/features/player-skills.js";

function clear(id: number, creditedDan: number, rate = 1): DanClearEvidence {
  return {
    play: { identity: `${id}:${rate}`, beatmapId: id, rate, keyCount: 4, goal: 0.93, pp: 0,
      values: { Overall: 20, Chordjack: 20 }, patterns: [] },
    side: "rc", chartDan: creditedDan, chartDanLabel: null, creditedDan, accuracy: 0.96, bar: 0.96, currency: "stable",
  };
}

const noFamilies = new Map<number, ChartSkillInfo>();

describe("repeated-chart dan influence", () => {
  it("counts both best rates at full weight", () => {
    const plays = [clear(1, 10, 1), clear(1, 11, 1.05), clear(2, 9), clear(3, 9)];
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.have).toBe(4);
    expect(selected.window[0]).toMatchObject({ clear: plays[1], weight: 1 });
    expect(selected.window[1]).toMatchObject({ clear: plays[0], weight: 1 });
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(9.75);
    expect(plays[0].creditedDan).toBe(10);
  });

  it("keeps unique-chart averages unchanged and stops after twenty", () => {
    const plays = Array.from({ length: 25 }, (_, i) => clear(i + 1, 12 - i / 10));
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.window).toHaveLength(20);
    expect(selected.have).toBe(20);
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(11.05);
  });

  it("fills twenty whole slots from other charts after ignoring further rate farms", () => {
    const plays = [clear(1, 12, 1.1), clear(1, 11.9), clear(1, 11.8, 1.2),
      ...Array.from({ length: 20 }, (_, i) => clear(i + 2, 10))];
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.have).toBe(20);
    expect(selected.window).toHaveLength(20);
    expect(selected.window.at(-1)?.weight).toBe(1);
    expect(selected.entries.some((entry) => entry.clear === plays[2])).toBe(false);
    expect(selected.entries.at(-1)?.weight).toBe(0);
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(10.2);
  });

  it("does not let farms of one chart satisfy the four-clear quorum", () => {
    const plays = Array.from({ length: 5 }, (_, i) => clear(1, 10, 1 + i / 100));
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)).toBeNull();
    expect(weightedDanClearWindow(plays, noFamilies).have).toBe(2);
    const withOtherCharts = [...plays, clear(2, 9), clear(3, 9)];
    const dan = danSideFromClearEvidenceForTest(4, "rc", withOtherCharts, noFamilies)!;
    expect(dan.rawDan).toBe(9.5);
    expect(dan.skillsets?.jack.clearWindow?.have).toBe(4);
  });

  it("keeps only two plays from a twenty-rate stack", () => {
    const plays = Array.from({ length: 20 }, (_, i) => clear(1, 10, 0.9 + i / 100));
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.window).toHaveLength(2);
    expect(selected.have).toBe(2);
    expect(selected.window.every((entry) => entry.weight === 1)).toBe(true);
    expect(plays).toHaveLength(20);
  });

  it("groups verified reuploads but keeps Invert as a different structure", () => {
    const families = new Map<number, ChartSkillInfo>([
      [1, { chartFamily: "verified-family" } as ChartSkillInfo],
      [2, { chartFamily: "verified-family" } as ChartSkillInfo],
    ]);
    const plays = [clear(1, 12), clear(2, 11), clear(2, 10, 1.1), clear(2, 9, 1.2)];
    plays[3].play.inverse = true;
    expect(selectDanRatingClears(plays, families)).toEqual([plays[0], plays[1], plays[3]]);
    expect(weightedDanClearWindow(plays, families).window.map((entry) => entry.weight)).toEqual([1, 1, 1]);
  });

  it("rewards an improved personal best and does not depend on input order", () => {
    const plays = [clear(1, 10, 1.1), clear(1, 9.9), clear(1, 9.8, 1.2),
      ...Array.from({ length: 25 }, (_, i) => clear(i + 2, 9))];
    const before = danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)!.rawDan;
    plays[2] = clear(1, 11, 1.2);
    const after = danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)!.rawDan;
    expect(after).toBeGreaterThan(before);
    expect(danSideFromClearEvidenceForTest(4, "rc", [...plays].reverse(), noFamilies)?.rawDan).toBe(after);
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.window[0]).toMatchObject({ clear: plays[2], weight: 1 });
    expect(selected.entries.some((entry) => entry.clear === plays[1])).toBe(false);
  });

  it("selects the two strongest clears before skillset grouping", () => {
    const plays = Array.from({ length: 8 }, (_, i) => clear(1, 12 - i / 10, 1 + i / 100));
    for (const play of plays.slice(4)) play.play.values = { Overall: 20, Stream: 20 };
    const dan = danSideFromClearEvidenceForTest(4, "rc", [...plays, clear(2, 10), clear(3, 10)], noFamilies)!;
    expect(dan.skillsets?.jack.clearWindow?.have).toBe(4);
    expect(dan.skillsets?.speed).toBeUndefined();
    expect(dan.clearWindow?.have).toBe(4);
  });

  it("keeps stray exclusions in the evidence window while excluding their weight from the mean", () => {
    const plays = [clear(1, 12), clear(1, 12, 1.1), clear(2, 12), clear(3, 12), clear(4, 12), clear(5, 2)];
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.window.at(-1)?.ignoredAsStray).toBe(true);
    expect(selected.have).toBe(6);
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(12);
  });

  it("deduplicates one rate before taking two and ranks by credited Dan rather than MSD or speed", () => {
    const best = clear(1, 12, 1);
    best.play.values.Overall = 10;
    const duplicate = { ...clear(1, 11, 1), play: { ...best.play, identity: "other-attempt", values: { Overall: 99 } } };
    const faster = clear(1, 10, 1.5);
    const fastest = clear(1, 9, 2);
    const plays = [fastest, duplicate, faster, best];
    expect(selectDanRatingClears(plays, noFamilies)).toEqual([best, faster]);
    expect(selectDanRatingClears([...plays].reverse(), noFamilies)).toEqual([best, faster]);
  });
});
