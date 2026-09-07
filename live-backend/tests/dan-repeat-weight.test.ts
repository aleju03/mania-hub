import { describe, expect, it } from "vitest";
import {
  danSideFromClearEvidenceForTest,
  weightedDanClearWindow,
  type ChartSkillInfo,
  type DanClearEvidence,
} from "../src/features/player-skills.js";

function clear(id: number, creditedDan: number, rate = 1): DanClearEvidence {
  return {
    play: { identity: `${id}:${rate}`, beatmapId: id, rate, keyCount: 4, goal: 0.93, pp: 0,
      values: { Overall: 20, Chordjack: 20 }, patterns: [] },
    side: "rc", chartDan: creditedDan, chartDanLabel: null, creditedDan, accuracy: 0.96, bar: 0.96,
  };
}

const noFamilies = new Map<number, ChartSkillInfo>();

describe("repeated-chart dan influence", () => {
  it("gently discounts two rates while keeping the stronger result fully weighted", () => {
    const plays = [clear(1, 10, 1), clear(1, 11, 1.05), clear(2, 9), clear(3, 9)];
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.have).toBeCloseTo(3.9);
    expect(selected.window[0]).toMatchObject({ clear: plays[1], weight: 1 });
    expect(selected.window[1]).toMatchObject({ clear: plays[0], weight: 0.9 });
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(9.74);
    expect(plays[0].creditedDan).toBe(10);
  });

  it("keeps unique-chart averages unchanged and stops after twenty", () => {
    const plays = Array.from({ length: 25 }, (_, i) => clear(i + 1, 12 - i / 10));
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.window).toHaveLength(20);
    expect(selected.have).toBe(20);
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(11.05);
  });

  it("refills from deeper clears and clips the final contribution to the remaining space", () => {
    const plays = [clear(1, 12, 1.1), clear(1, 11.9), ...Array.from({ length: 20 }, (_, i) => clear(i + 2, 10))];
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.have).toBe(20);
    expect(selected.window).toHaveLength(21);
    expect(selected.window.at(-1)?.weight).toBeCloseTo(0.1);
    expect(selected.entries.at(-1)?.weight).toBe(0);
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(10.19);
  });

  it("keeps a thin family rateable without treating its missing evidence as zero", () => {
    const plays = Array.from({ length: 5 }, (_, i) => clear(1, 10, 1 + i / 100));
    const dan = danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)!;
    expect(dan.rawDan).toBe(10);
    expect(weightedDanClearWindow(plays, noFamilies).have).toBeCloseTo(4.0951);
    expect(dan.skillsets?.jack.clearWindow?.have).toBeCloseTo(4.0951);
    expect(danSideFromClearEvidenceForTest(4, "rc", plays.slice(0, 3), noFamilies)).toBeNull();
  });

  it("bounds a twenty-rate stack without removing any of its clears", () => {
    const plays = Array.from({ length: 20 }, (_, i) => clear(1, 10, 0.9 + i / 100));
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.window).toHaveLength(20);
    expect(selected.have).toBeCloseTo(8.78423345);
    expect(selected.window.every((entry) => entry.weight > 0)).toBe(true);
  });

  it("groups verified reuploads but keeps Invert as a different structure", () => {
    const families = new Map<number, ChartSkillInfo>([
      [1, { chartFamily: "verified-family" } as ChartSkillInfo],
      [2, { chartFamily: "verified-family" } as ChartSkillInfo],
    ]);
    const plays = [clear(1, 12), clear(2, 11), clear(2, 10, 1.1)];
    plays[2].play.inverse = true;
    expect(weightedDanClearWindow(plays, families).window.map((entry) => entry.weight)).toEqual([1, 0.9, 1]);
  });

  it("rewards an improved personal best and does not depend on input order", () => {
    const plays = [clear(1, 10, 1.1), clear(1, 9.9), ...Array.from({ length: 25 }, (_, i) => clear(i + 2, 9))];
    const before = danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)!.rawDan;
    plays[1] = clear(1, 11);
    const after = danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)!.rawDan;
    expect(after).toBeGreaterThan(before);
    expect(danSideFromClearEvidenceForTest(4, "rc", [...plays].reverse(), noFamilies)?.rawDan).toBe(after);
    expect(weightedDanClearWindow(plays, noFamilies).window[0]).toMatchObject({ clear: plays[1], weight: 1 });
  });

  it("assigns the strongest position independently in each skillset", () => {
    const plays = Array.from({ length: 8 }, (_, i) => clear(1, 12 - i / 10, 1 + i / 100));
    for (const play of plays.slice(4)) play.play.values = { Overall: 20, Stream: 20 };
    const dan = danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)!;
    expect(dan.skillsets?.jack.clearWindow?.have).toBeCloseTo(3.439);
    expect(dan.skillsets?.speed.clearWindow?.have).toBeCloseTo(3.439);
    expect(dan.skillsets?.speed.rawDan).toBeCloseTo(dan.skillsets!.jack.rawDan - 0.4);
  });

  it("keeps stray exclusions in the evidence window while excluding their weight from the mean", () => {
    const plays = [clear(1, 12), clear(1, 12, 1.1), clear(2, 12), clear(3, 12), clear(4, 12), clear(5, 2)];
    const selected = weightedDanClearWindow(plays, noFamilies);
    expect(selected.window.at(-1)?.ignoredAsStray).toBe(true);
    expect(selected.have).toBeCloseTo(5.9);
    expect(danSideFromClearEvidenceForTest(4, "rc", plays, noFamilies)?.rawDan).toBe(12);
  });
});
