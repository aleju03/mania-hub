import { describe, expect, it } from "vitest";
import { computeManiaRulesetWhatIf } from "./replay-what-if";
import { getManiaReplayHitWindows, getManiaReplayRuleset } from "./mania-replay-judgement";
import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

// 1 column: a tap and an LN, both hit exactly on time.
const notes: ManiaNote[] = [
  { column: 0, time: 1000, endTime: 1000, isHold: false },
  { column: 0, time: 2000, endTime: 2600, isHold: true },
];

const frames: ReplayFrame[] = [
  { time: 0, keyState: 0 },
  { time: 1000, keyState: 1 },
  { time: 1040, keyState: 0 },
  { time: 2000, keyState: 1 },
  { time: 2600, keyState: 0 },
  { time: 3400, keyState: 0 },
];

const base = { frames, notes, keyCount: 1, od: 8 };

describe("computeManiaRulesetWhatIf", () => {
  it("re-judges a stable replay under lazer LN rules (head and tail judged separately)", () => {
    const result = computeManiaRulesetWhatIf({ ...base, sourceIsLazer: false });
    expect(result).not.toBeNull();
    expect(result!.targetIsLazer).toBe(true);
    // tap + hold head + hold tail
    expect(result!.totalJudgements).toBe(3);
    expect(result!.counts[1]).toBe(3);
    expect(result!.accuracy).toBe(100);
    expect(result!.pp).toBeGreaterThan(0);
  });

  it("re-judges a lazer replay under stable's single combined LN judgement", () => {
    const result = computeManiaRulesetWhatIf({ ...base, sourceIsLazer: true });
    expect(result).not.toBeNull();
    expect(result!.targetIsLazer).toBe(false);
    // tap + one combined hold judgement
    expect(result!.totalJudgements).toBe(2);
    expect(result!.counts[1]).toBe(2);
    expect(result!.accuracy).toBe(100);
  });

  it("strips CL from the lazer target so converted stable scores get real lazer windows", () => {
    // At OD0, stable/classic MAX is +-16.5ms while lazer PERFECT is ~+-22.9ms;
    // a +20ms tap discriminates which windows judged it.
    const classicPerfect = getManiaReplayHitWindows(0, getManiaReplayRuleset(true, ["CL"], false)).perfect;
    const lazerPerfect = getManiaReplayHitWindows(0, getManiaReplayRuleset(true, [], false)).perfect;
    expect(classicPerfect).toBeLessThan(20);
    expect(lazerPerfect).toBeGreaterThan(20);

    const lateTap: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const lateFrames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1020, keyState: 1 },
      { time: 1060, keyState: 0 },
      { time: 1400, keyState: 0 },
    ];
    const result = computeManiaRulesetWhatIf({
      frames: lateFrames,
      notes: lateTap,
      keyCount: 1,
      od: 0,
      mods: [{ acronym: "CL" }],
      sourceIsLazer: false,
    });
    expect(result).not.toBeNull();
    // Judged with lazer windows (CL stripped): +20ms is still a MAX.
    expect(result!.counts[1]).toBe(1);
  });

  it("returns null without frames or notes", () => {
    expect(computeManiaRulesetWhatIf({ ...base, frames: [], sourceIsLazer: false })).toBeNull();
    expect(computeManiaRulesetWhatIf({ ...base, notes: [], sourceIsLazer: false })).toBeNull();
  });
});
