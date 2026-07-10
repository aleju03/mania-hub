import { describe, expect, it } from "vitest";
import { applyManiaReplayModsToNotes, buildReplaySegments, calculateReplayAccuracy, getManiaRandomColumnMap, getManiaReplayHitWindows, getManiaReplayRuleset, simulateManiaReplayJudgements } from "./mania-replay-judgement";
import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

describe("mania replay judgement helpers", () => {
  it("uses stable classic windows for legacy scores", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);

    expect(windows.perfect).toBe(16.5);
    expect(windows.great).toBe(40.5);
    expect(windows.good).toBe(73.5);
    expect(windows.ok).toBe(103.5);
    expect(windows.meh).toBe(127.5);
    expect(windows.miss).toBe(164.5);
  });

  it("falls back to od 8 for a non-finite od instead of producing NaN windows", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const fallback = getManiaReplayHitWindows(8, ruleset);

    expect(getManiaReplayHitWindows(Number.NaN, ruleset)).toEqual(fallback);
    expect(getManiaReplayHitWindows(Number.POSITIVE_INFINITY, ruleset)).toEqual(fallback);
    // Out-of-range values clamp to the valid od range.
    expect(getManiaReplayHitWindows(99, ruleset)).toEqual(getManiaReplayHitWindows(10, ruleset));
    expect(getManiaReplayHitWindows(-5, ruleset)).toEqual(getManiaReplayHitWindows(0, ruleset));
  });

  it("applies stable HR and EZ as classic window multipliers", () => {
    const hardRock = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["HR"]));
    const easy = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["EZ"]));

    expect(hardRock.great).toBe(28.5);
    expect(hardRock.good).toBe(52.5);
    expect(easy.great).toBe(56.5);
    expect(easy.good).toBe(102.5);
  });

  it("applies stable replay-time hit windows for rate-changing mods", () => {
    const normal = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, []));
    const doubleTime = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["DT"]));
    const halfTime = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["HT"]));
    const daycore = getManiaReplayHitWindows(8, getManiaReplayRuleset(false, ["DC"]));

    expect(doubleTime.great).toBe(60.5);
    expect(halfTime.great).toBe(30.5);
    expect(daycore).toEqual(halfTime);
    expect(normal.great).toBe(40.5);
  });

  it("uses lazer windows for lazer scores", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(5, ruleset);

    expect(windows.perfect).toBe(19.5);
    expect(windows.great).toBe(49.5);
    expect(windows.good).toBe(82.5);
    expect(windows.ok).toBe(112.5);
    expect(windows.meh).toBe(136.5);
    expect(windows.miss).toBe(173.5);
  });

  it("uses the correct accuracy weights per ruleset", () => {
    const counts = [0, 1, 1, 0, 0, 0, 0];

    expect(calculateReplayAccuracy(counts, "stable")).toBe(100);
    expect(calculateReplayAccuracy(counts, "lazer")).toBeCloseTo(((305 + 300) / (2 * 305)) * 100, 6);
  });

  it("mirrors mania notes for the MR mod before replay judgement", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 3, time: 1100, endTime: 1500, isHold: true },
    ];

    expect(applyManiaReplayModsToNotes(notes, 4, ["MR"])).toEqual([
      { column: 3, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 1100, endTime: 1500, isHold: true },
    ]);
    expect(applyManiaReplayModsToNotes(notes, 4, [])).toEqual(notes);
    expect(applyManiaReplayModsToNotes(notes, 4, [])).not.toBe(notes);
  });

  it("inverts mania notes into holds for the IN mod like lazer's ManiaModInvert", () => {
    // 500ms beat (120 BPM): the hold reaches a 1/4 beat (125ms) short of the
    // next object unless that would halve the gap.
    const timingPoints = [{ time: 0, beatLength: 500 }];
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 2000, endTime: 2000, isHold: false },
      { column: 0, time: 2200, endTime: 2600, isHold: true },
      { column: 1, time: 1500, endTime: 1500, isHold: false },
    ];

    expect(applyManiaReplayModsToNotes(notes, 4, ["IN"], { timingPoints })).toEqual([
      // 1000 -> 2000 gap: 1000 - 125 = 875ms hold.
      { column: 0, time: 1000, endTime: 1875, isHold: true, sample: undefined },
      // 2000 -> 2200 gap: max(100, 200 - 125) = 100ms hold; the hold's own end
      // is ignored as a location, and the last object per column is dropped.
      { column: 0, time: 2000, endTime: 2100, isHold: true, sample: undefined },
    ]);
  });

  it("replaces holds with notes for the HO mod", () => {
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1400, isHold: true },
      { column: 1, time: 1200, endTime: 1200, isHold: false },
    ];

    expect(applyManiaReplayModsToNotes(notes, 4, ["HO"])).toEqual([
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 1, time: 1200, endTime: 1200, isHold: false },
    ]);
  });

  it("reproduces .NET's seeded System.Random for the RD column shuffle", () => {
    // new Random(0).Next() yields 1559595546, 1755192844, 1649316166, ... -
    // the shuffle must be bit-exact with lazer's ManiaModRandom.
    const map = getManiaRandomColumnMap(4, 0);
    expect(new Set(map).size).toBe(4);
    // Keys drawn per column: [1559595546, 1755192844, 1649316166, 1198642031]
    // -> sorted column order [3, 0, 2, 1].
    expect(map).toEqual([3, 0, 2, 1]);

    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 3, time: 1100, endTime: 1500, isHold: true },
    ];
    expect(applyManiaReplayModsToNotes(notes, 4, [{ acronym: "RD", settings: { seed: 0 } }])).toEqual([
      { column: 3, time: 1000, endTime: 1000, isHold: false },
      { column: 1, time: 1100, endTime: 1500, isHold: true },
    ]);
    // Without a seed the shuffle is unknowable; columns stay put.
    expect(applyManiaReplayModsToNotes(notes, 4, ["RD"])).toEqual(notes);
  });

  it("awards Perfect tails while holding through the tail with the NR mod", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1600, isHold: true }];
    // Head on time, released 120ms late: normally a worse-than-Perfect tail,
    // but NR judges Perfect the moment the tail is reached while held.
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1720, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const withNoRelease = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer", {
      lazerNoReleaseTails: true,
    });

    expect(withNoRelease.events).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-tail", judgment: 1, time: 1600, offsetMs: 0 }),
    ]);
  });

  it("stable mode misses tap notes after the late OK window instead of awarding late 50s", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1120, keyState: 1 },
      { time: 1130, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "note", judgment: 6, time: 1103.5 }),
    ]);
  });

  it("stable mode still allows early 50s on tap notes", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 880, keyState: 1 },
      { time: 890, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "note", judgment: 5, time: 880 }),
    ]);
  });

  it("stable sampled replay timing judges the observed coarse press edge", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 890, keyState: 1 },
      { time: 910, keyState: 0 },
      { time: 993, keyState: 0 },
      { time: 995, keyState: 1 },
      { time: 1010, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "note", judgment: 5, time: 890 }),
    ]);
  });

  it("lazer mode emits separate head and tail judgements for a hold", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events.filter((event) => event.judgment != null)).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-tail", judgment: 1, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: null,
      headJudgment: 1,
      tailJudgment: 1,
      tailTime: 2000,
    }));
  });

  it("lazer mode caps the tail to 50 after a dropped hold", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1200, keyState: 0 },
      { time: 1800, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-break", judgment: null, time: 1200 }),
      expect.objectContaining({ part: "hold-tail", judgment: 5, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: 1200,
      headJudgment: 1,
      tailJudgment: 5,
    }));
  });

  it("lazer mode times out untouched tap notes after the 50 window", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1000, isHold: false }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1135, keyState: 1 },
      { time: 1145, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "note", judgment: 6, time: 1127.5 }),
    ]);
  });

  it("lazer mode times out untouched hold tails after the lenient 50 window", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events.filter((event) => event.judgment != null)).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 1, time: 1000 }),
      expect.objectContaining({ part: "hold-tail", judgment: 6, time: 2191.25 }),
    ]);
  });

  it("lazer mode times out untouched hold heads after the 50 window", () => {
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 2500, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events.filter((event) => event.judgment != null)).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 6, time: 1127.5 }),
      expect.objectContaining({ part: "hold-tail", judgment: 6, time: 2191.25 }),
    ]);
  });

  it("lazer mode lets a mid-body press re-grab a hold with a timed-out head", () => {
    // DrawableHoldNote.OnPressed calls beginHoldAt before Head.UpdateResult()
    // consumes the input, so a press after the head miss still starts holding
    // and the release judges the tail, capped to Meh by the head miss.
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1500, keyState: 1 },
      { time: 1990, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-head", judgment: 6, time: 1127.5 }),
      expect.objectContaining({ part: "hold-tail", judgment: 5, time: 1990, offsetMs: -10 }),
    ]);
  });

  it("lazer mode blocks the re-grab when the press lands at or past the next alive note", () => {
    // OrderedHitPolicy.IsHittable: the hold is only pressable strictly before
    // the next alive object's start time.
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 2000, isHold: true },
      { column: 0, time: 2100, endTime: 2100, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 2110, keyState: 1 },
      { time: 2150, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events.filter((event) => event.part === "hold-tail")).toEqual([
      expect.objectContaining({ judgment: 6, time: 2191.25 }),
    ]);
    expect(simulated.events.filter((event) => event.part === "note")).toEqual([
      expect.objectContaining({ judgment: 1, time: 2110 }),
    ]);
  });

  it("lazer mode force-misses the tail when the re-grab press hits the next note", () => {
    // OrderedHitPolicy.HandleHit: a successful hit force-misses earlier
    // unjudged nested objects, so a press that hits the next note cannot save
    // this tail even though it began holding first.
    const ruleset = getManiaReplayRuleset(true, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 2000, isHold: true },
      { column: 0, time: 2100, endTime: 2100, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 2050, keyState: 1 },
      { time: 2140, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "lazer");

    expect(simulated.events.filter((event) => event.part === "hold-tail")).toEqual([
      expect.objectContaining({ judgment: 6, time: 2191.25 }),
    ]);
    expect(simulated.events.filter((event) => event.part === "note")).toEqual([
      expect.objectContaining({ judgment: 3, time: 2050 }),
    ]);
  });

  it("stable mode emits a single combined judgement for a perfectly held LN", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events.filter((event) => event.part !== "hold-break")).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 1, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: null,
      headJudgment: 1,
      tailJudgment: 1,
      displayJudgment: 1,
      tailTime: 2000,
    }));
  });

  it("stable mode scores a broken LN from the recovery press when it crosses the actual tail", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1200, keyState: 0 },
      { time: 1950, keyState: 1 },
      { time: 2000, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-break", judgment: null, time: 1200 }),
      expect.objectContaining({ part: "hold-combined", judgment: 5, time: 2000 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: 1200,
      headJudgment: 1,
      tailJudgment: 5,
      displayJudgment: 5,
    }));
  });

  it("stable mode scores a recovered LN as 50 when the recovery releases before the actual tail", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1200, keyState: 0 },
      { time: 1950, keyState: 1 },
      { time: 1990, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-break", judgment: null, time: 1200 }),
      expect.objectContaining({ part: "hold-combined", judgment: 5, time: 1990 }),
    ]);
    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      bodyBreakTime: 1200,
      headJudgment: 1,
      tailJudgment: 5,
      displayJudgment: 5,
    }));
  });

  it("stable mode truncates LN combined judgement thresholds", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 2039, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 2, time: 2039 }),
    ]);
  });

  it("stable mode downgrades via the combined hit error tier", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    // windows.perfect = 16.5 → perfect*1.2 = 19.8, perfect*2.4 = 39.6
    // head offset 15 (within 19.8), tail offset 25 (combined = 40) → exceeds perfect tier combined bound
    // Should drop to GREAT (great*1.1 = 44.55, great*2.2 = 89.1) → GREAT passes
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1015, keyState: 1 },
      { time: 2025, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    const combined = simulated.events.find((event) => event.part === "hold-combined");
    expect(combined?.judgment).toBe(2);
    expect(simulated.noteStates[0].headJudgment).toBe(1);
  });

  it("does not flag a hidden body break for LNs held with normal sample cadence", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [];
    for (let time = 950; time < 1000; time += 17) frames.push({ time, keyState: 0 });
    for (let time = 1000; time <= 2000; time += 17) frames.push({ time, keyState: 1 });
    frames.push({ time: 2003, keyState: 0 });

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });
    const combined = simulated.events.find((event) => event.part === "hold-combined");

    expect(combined?.judgment).toBe(1);
    expect(combined?.possibleJudgments ?? []).not.toContain(5);
  });

  it("flags a hidden body break when the gap between pressed samples is anomalous", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 2000, isHold: true }];
    const frames: ReplayFrame[] = [];
    for (let time = 950; time < 1000; time += 17) frames.push({ time, keyState: 0 });
    frames.push({ time: 1000, keyState: 1 });
    frames.push({ time: 1500, keyState: 1 });
    frames.push({ time: 1998, keyState: 1 });
    frames.push({ time: 2000, keyState: 0 });

    const segments = buildReplaySegments(frames, 1, 2500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });
    const combined = simulated.events.find((event) => event.part === "hold-combined");

    expect(combined?.judgment).toBe(1);
    expect(combined?.possibleJudgments ?? []).toContain(5);
  });

  it("applies note lock so earlier notes do not steal later presses", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 1100, endTime: 1100, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1110, keyState: 1 },
      { time: 1120, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable");

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 1,
      headJudgment: 1,
    }));
  });

  it("keeps stable sampled tap edges that straddle the next note boundary on the earlier note", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 1100, endTime: 1100, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1098, keyState: 0 },
      { time: 1102, keyState: 1 },
      { time: 1118, keyState: 1 },
      { time: 1120, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 4,
      headJudgment: 4,
      headOffsetMs: 102,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
  });

  it("keeps stable sampled tap edges just past the next note boundary on the earlier note", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 1100, endTime: 1100, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1101, keyState: 0 },
      { time: 1102, keyState: 1 },
      { time: 1118, keyState: 1 },
      { time: 1120, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 4,
      headJudgment: 4,
      headOffsetMs: 102,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
  });

  it("bridges stable sampled LN tail-edge gaps that straddle the early tail window", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1200, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1060, keyState: 0 },
      { time: 1065, keyState: 1 },
      { time: 1200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
      stableTailEdgeGrace: 8,
    });

    expect(simulated.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ part: "hold-break" }),
    ]));
    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 1, time: 1200 }),
    ]);
  });

  it("does not bridge stable sampled LN tail-edge gaps wider than the edge grace", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1200, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1054, keyState: 0 },
      { time: 1065, keyState: 1 },
      { time: 1200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ part: "hold-break", time: 1054 }),
      expect.objectContaining({ part: "hold-combined", judgment: 3, time: 1200 }),
    ]));
  });

  it("scores stable LNs released before the body starts and records the recovered combo break", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1200, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 900, keyState: 1 },
      { time: 990, keyState: 0 },
      { time: 1058, keyState: 0 },
      { time: 1060, keyState: 1 },
      { time: 1200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-break", judgment: null, time: 990 }),
      expect.objectContaining({ part: "hold-combined", judgment: 3, time: 1200 }),
    ]);
    expect(simulated.noteStates[0]?.bodyBreakTimes).toEqual([990]);
  });

  it("misses stable LNs released before the body starts when recovery starts after the tail edge", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1200, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 900, keyState: 1 },
      { time: 990, keyState: 0 },
      { time: 1070, keyState: 0 },
      { time: 1075, keyState: 1 },
      { time: 1200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 6, time: 1000 }),
    ]);
  });

  it("does not miss stable tail-edge releases exactly on the early tail edge", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1200, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1064, keyState: 0 },
      { time: 1070, keyState: 1 },
      { time: 1200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 3, time: 1064 }),
    ]);
  });

  it("misses stable tail-edge releases just before the early tail edge when recovery starts after it", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1200, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1054, keyState: 0 },
      { time: 1066, keyState: 0 },
      { time: 1070, keyState: 1 },
      { time: 1200, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-combined", judgment: 6, time: 1054 }),
    ]);
  });

  it("scores rate-adjusted stable LNs released before the body starts and records the recovered combo break", () => {
    const ruleset = getManiaReplayRuleset(false, ["DT"]);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1400, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 900, keyState: 1 },
      { time: 990, keyState: 0 },
      { time: 1188, keyState: 0 },
      { time: 1190, keyState: 1 },
      { time: 1400, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.events).toEqual([
      expect.objectContaining({ part: "hold-break", judgment: null, time: 990 }),
      expect.objectContaining({ part: "hold-combined", judgment: 5, time: 1400 }),
    ]);
    expect(simulated.noteStates[0]?.bodyBreakTimes).toEqual([990]);
  });

  it("uses the first held sample after stable LN tail timeout by default", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [{ column: 0, time: 1000, endTime: 1200, isHold: true }];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1330, keyState: 1 },
      { time: 1345, keyState: 1 },
      { time: 1370, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1500);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });
    const timeoutSimulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
      stableHeldTailTimeoutMode: "timeout",
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      scoringTailOffsetMs: 145,
      stableTailWasHeldAtJudgement: true,
      tailOffsetMs: 145,
      tailTime: 1336,
    }));
    expect(timeoutSimulated.noteStates[0]).toEqual(expect.objectContaining({
      scoringTailOffsetMs: 136,
      tailOffsetMs: 136,
      tailTime: 1336,
    }));
  });

  it("does not promote stable hidden re-presses across long replay stalls", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1000, isHold: false },
      { column: 0, time: 1100, endTime: 1100, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1000, keyState: 1 },
      { time: 1040, keyState: 1 },
      { time: 1160, keyState: 1 },
      { time: 1180, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 1,
      headJudgment: 1,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
  });

  it("lets stable LN heads consume valid late presses after the next note starts", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1150, isHold: true },
      { column: 0, time: 1050, endTime: 1050, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1080, keyState: 1 },
      { time: 1150, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      headOffsetMs: 80,
      headJudgment: 3,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
  });

  it("lets stable LN heads consume late Meh presses after the next note starts", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(5, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1150, isHold: true },
      { column: 0, time: 1050, endTime: 1050, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1130, keyState: 1 },
      { time: 1150, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 5,
      headJudgment: 5,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
  });

  it("consumes sampled segments held across a passive stable LN timeout", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1063, isHold: true },
      { column: 0, time: 1127, endTime: 1127, isHold: false },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1120, keyState: 0 },
      { time: 1129, keyState: 1 },
      { time: 1138, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });
    const withoutTimeoutConsumption = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
      stableConsumeHeldSegmentAtLongNoteTimeout: false,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
    expect(simulated.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 6,
    }));
    expect(withoutTimeoutConsumption.noteStates[1]).toEqual(expect.objectContaining({
      displayJudgment: 1,
      headJudgment: 1,
    }));
  });

  it("grades held stable LN OK timeouts as miss by default on 4K", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 0, time: 1000, endTime: 1063, isHold: true },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1035, keyState: 0 },
      { time: 1040, keyState: 1 },
      { time: 1189, keyState: 1 },
      { time: 1194, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 1, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
    });
    const asKatu = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
      stableHeldOkTimeoutJudgment: 3,
    });
    const keepOk = simulateManiaReplayJudgements(notes, segments, 1, windows, "stable", {
      legacyReplayFrameRounding: true,
      stableHeldOkTimeoutAsMiss: false,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      headJudgment: 2,
      tailJudgment: 6,
    }));
    expect(asKatu.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 3,
      tailJudgment: 3,
    }));
    expect(keepOk.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 4,
      tailJudgment: 4,
    }));
  });

  it("keeps held stable LN OK timeouts as OK on high key counts", () => {
    const ruleset = getManiaReplayRuleset(false, []);
    const windows = getManiaReplayHitWindows(8, ruleset);
    const notes: ManiaNote[] = [
      { column: 3, time: 1000, endTime: 1063, isHold: true },
    ];
    const frames: ReplayFrame[] = [
      { time: 0, keyState: 0 },
      { time: 1035, keyState: 0 },
      { time: 1040, keyState: 1 << 3 },
      { time: 1189, keyState: 1 << 3 },
      { time: 1194, keyState: 0 },
    ];

    const segments = buildReplaySegments(frames, 7, 1300);
    const simulated = simulateManiaReplayJudgements(notes, segments, 7, windows, "stable", {
      legacyReplayFrameRounding: true,
    });
    const asMiss = simulateManiaReplayJudgements(notes, segments, 7, windows, "stable", {
      legacyReplayFrameRounding: true,
      stableHeldOkTimeoutAsMiss: true,
    });

    expect(simulated.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 4,
      headJudgment: 2,
      tailJudgment: 4,
    }));
    expect(asMiss.noteStates[0]).toEqual(expect.objectContaining({
      displayJudgment: 6,
      tailJudgment: 6,
    }));
  });
});
