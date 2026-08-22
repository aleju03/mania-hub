import { describe, expect, it } from "vitest";
import {
  createManiaScoreSimulator,
  formatLazerScore,
  formatStableScore,
  getLazerManiaScoreMultiplier,
  getScoreScaleToReal,
  getStableManiaScoreModFactors,
} from "./mania-score-simulation";
import type { Judgment } from "./mania-replay-judgement";

function runAll(sim: ReturnType<typeof createManiaScoreSimulator>, judgments: Judgment[]) {
  for (const judgment of judgments) sim.applyJudgment(judgment);
  return sim.value;
}

describe("stable ScoreV1 simulator", () => {
  it("reaches exactly 1,000,000 on an all-MAX nomod play", () => {
    const sim = createManiaScoreSimulator({ mode: "stable", totalJudgements: 1000, mods: [], rate: 1 });
    expect(runAll(sim, Array(1000).fill(1))).toBe(1_000_000);
  });

  it("caps an all-300 play at 968,750 (300/320 base + full bonus)", () => {
    // Base half: 500k * 300/320 = 468,750. Bonus stays pinned at 100, so the
    // bonus half stays maxed: 500k * 32*sqrt(100)/320 / 32... = 500k.
    const sim = createManiaScoreSimulator({ mode: "stable", totalJudgements: 320, mods: [], rate: 1 });
    expect(runAll(sim, Array(320).fill(2))).toBe(968_750);
  });

  it("zeroes the bonus counter on a miss", () => {
    const withMiss = createManiaScoreSimulator({ mode: "stable", totalJudgements: 3, mods: [], rate: 1 });
    withMiss.applyJudgment(1);
    withMiss.applyJudgment(6);
    withMiss.applyJudgment(1);
    // Third note's bonus term uses sqrt(2) (bonus rebuilt from 0 by one MAX),
    // well below the sqrt(100) an unbroken run keeps.
    const clean = createManiaScoreSimulator({ mode: "stable", totalJudgements: 3, mods: [], rate: 1 });
    clean.applyJudgment(1);
    clean.applyJudgment(1);
    clean.applyJudgment(1);
    expect(withMiss.value).toBeLessThan(clean.value - 150_000);
  });

  it("monotonically increases while playing", () => {
    const sim = createManiaScoreSimulator({ mode: "stable", totalJudgements: 6, mods: [], rate: 1 });
    let previous = 0;
    for (const judgment of [1, 2, 5, 6, 3, 1] as Judgment[]) {
      sim.applyJudgment(judgment);
      expect(sim.value).toBeGreaterThanOrEqual(previous);
      previous = sim.value;
    }
  });

  it("halves the score for EZ/NF/HT and softens punishment for DT/HR/HD", () => {
    expect(getStableManiaScoreModFactors(["EZ"]).multiplier).toBe(0.5);
    expect(getStableManiaScoreModFactors(["NF", "HT"]).multiplier).toBe(0.25);
    expect(getStableManiaScoreModFactors(["DT"]).divider).toBeCloseTo(1.1);
    expect(getStableManiaScoreModFactors(["HR", "HD"]).divider).toBeCloseTo(1.08 * 1.06);
    const sim = createManiaScoreSimulator({ mode: "stable", totalJudgements: 100, mods: ["EZ"], rate: 1 });
    expect(runAll(sim, Array(100).fill(1))).toBe(500_000);
  });

  it("resets cleanly", () => {
    const sim = createManiaScoreSimulator({ mode: "stable", totalJudgements: 10, mods: [], rate: 1 });
    sim.applyJudgment(1);
    sim.applyJudgment(6);
    sim.reset();
    expect(sim.value).toBe(0);
    expect(runAll(sim, Array(10).fill(1))).toBe(1_000_000);
  });
});

describe("lazer mania simulator", () => {
  it("reaches exactly 1,000,000 on an all-Perfect nomod play", () => {
    const sim = createManiaScoreSimulator({ mode: "lazer", totalJudgements: 500, mods: [], rate: 1 });
    expect(runAll(sim, Array(500).fill(1))).toBe(1_000_000);
  });

  it("keeps the combo portion full on an all-300 play (Great combo score == Perfect)", () => {
    const sim = createManiaScoreSimulator({ mode: "lazer", totalJudgements: 500, mods: [], rate: 1 });
    const total = runAll(sim, Array(500).fill(2));
    const accuracy = 300 / 305;
    const expected = Math.round(150_000 + 850_000 * Math.pow(accuracy, 2 + 2 * accuracy));
    expect(total).toBe(expected);
  });

  it("loses combo portion after a miss", () => {
    const clean = createManiaScoreSimulator({ mode: "lazer", totalJudgements: 100, mods: [], rate: 1 });
    runAll(clean, Array(100).fill(1));
    const broken = createManiaScoreSimulator({ mode: "lazer", totalJudgements: 100, mods: [], rate: 1 });
    const judgments = Array(100).fill(1) as Judgment[];
    judgments[50] = 6;
    runAll(broken, judgments);
    expect(broken.value).toBeLessThan(clean.value);
  });

  it("uses lazer's truncated rate multiplier formula", () => {
    // DT/NC register no multiplier in ManiaScoreMultiplierCalculator; only
    // rate reductions (HT/DC) scale the score.
    expect(getLazerManiaScoreMultiplier([], 1.5)).toBe(1);
    expect(getLazerManiaScoreMultiplier([], 0.75)).toBeCloseTo(0.3);
    expect(getLazerManiaScoreMultiplier(["EZ"], 1)).toBe(0.5);
    expect(getLazerManiaScoreMultiplier(["NF", "EZ"], 1)).toBe(0.25);
    expect(getLazerManiaScoreMultiplier(["NR"], 1)).toBeCloseTo(0.9);
  });
});

describe("score scale to real", () => {
  it("pins the sim to the real final score within sane bounds", () => {
    expect(getScoreScaleToReal(950_000, 998_861)).toBeCloseTo(998_861 / 950_000);
    expect(getScoreScaleToReal(950_000, null)).toBe(1);
    expect(getScoreScaleToReal(0, 998_861)).toBe(1);
    expect(getScoreScaleToReal(100, 998_861)).toBe(1);
  });
});

describe("score formatting", () => {
  it("pads stable scores to 8 digits like the stable HUD", () => {
    expect(formatStableScore(295_750)).toBe("00295750");
    expect(formatStableScore(0)).toBe("00000000");
    expect(formatStableScore(1_000_000)).toBe("01000000");
  });

  it("comma-separates lazer scores", () => {
    expect(formatLazerScore(998_861)).toBe("998,861");
    expect(formatLazerScore(0)).toBe("0");
  });
});
