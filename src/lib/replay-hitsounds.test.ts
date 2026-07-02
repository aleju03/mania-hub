import { describe, expect, it } from "vitest";
import {
  buildComboBreakSoundTimes,
  buildHitsoundAnchorsByColumn,
  getNoteSamplePlays,
  selectHitsoundAnchor,
} from "./replay-hitsounds";
import type { ManiaNoteSample } from "./beatmap-parser";

function sample(overrides: Partial<ManiaNoteSample> = {}): ManiaNoteSample {
  return {
    bank: "normal",
    additionBank: "normal",
    index: 0,
    volume: 100,
    additions: 0,
    normalIsLayered: false,
    ...overrides,
  };
}

describe("getNoteSamplePlays", () => {
  it("plays a plain hitnormal when no additions are set", () => {
    expect(getNoteSamplePlays(sample(), false)).toEqual([
      { name: "hitnormal", bank: "normal", index: 0, volume: 100 },
    ]);
  });

  it("adds whistle/finish/clap from the addition bank", () => {
    const plays = getNoteSamplePlays(sample({ additionBank: "drum", additions: 2 | 4 | 8, volume: 60 }), false);
    expect(plays.map((play) => play.name)).toEqual(["hitnormal", "hitwhistle", "hitfinish", "hitclap"]);
    expect(plays.slice(1).every((play) => play.bank === "drum" && play.volume === 60)).toBe(true);
  });

  it("mutes layered hitnormals for mania-native maps but keeps them for converts", () => {
    const layered = sample({ additions: 8, normalIsLayered: true });
    expect(getNoteSamplePlays(layered, false).map((play) => play.name)).toEqual(["hitclap"]);
    expect(getNoteSamplePlays(layered, true).map((play) => play.name)).toEqual(["hitnormal", "hitclap"]);
  });

  it("replaces the hitnormal with the keysound file", () => {
    const plays = getNoteSamplePlays(sample({ filename: "piano/c4.wav", additions: 2 }), false);
    expect(plays[0]).toMatchObject({ name: "hitnormal", filename: "piano/c4.wav" });
    expect(plays[1]).toMatchObject({ name: "hitwhistle" });
  });

  it("falls back to a plain hitnormal when parser data is missing", () => {
    expect(getNoteSamplePlays(undefined, false)).toEqual([
      { name: "hitnormal", bank: "normal", index: 0, volume: 100 },
    ]);
  });
});

describe("buildHitsoundAnchorsByColumn / selectHitsoundAnchor", () => {
  const MISS = 100;

  it("targets the earliest unjudged note at press time", () => {
    const notes = [
      { column: 0, time: 1000, endTime: 1000, isHold: false, sample: sample({ additions: 2 }) },
      { column: 0, time: 2000, endTime: 2000, isHold: false, sample: sample({ additions: 8 }) },
    ];
    const states = [
      { headTime: 1005, releaseTime: 1005, tailTime: null },
      { headTime: 2100, releaseTime: 2100, tailTime: null }, // missed at window end
    ];
    const anchors = buildHitsoundAnchorsByColumn(notes, states, 4, MISS, false)[0];

    // Press that hits the first note plays the first note's samples.
    expect(selectHitsoundAnchor(anchors, 1005, MISS)?.plays[1]?.name).toBe("hitwhistle");
    // Ghost press after the first note is judged targets the second note.
    expect(selectHitsoundAnchor(anchors, 1900, MISS)?.plays[1]?.name).toBe("hitclap");
  });

  it("keeps the previous note's sound when the next note is too far away", () => {
    const notes = [
      { column: 0, time: 1000, endTime: 1000, isHold: false, sample: sample({ additions: 2 }) },
      { column: 0, time: 9000, endTime: 9000, isHold: false, sample: sample({ additions: 8 }) },
    ];
    const states = [
      { headTime: 1000, releaseTime: 1000, tailTime: null },
      { headTime: 9000, releaseTime: 9000, tailTime: null },
    ];
    const anchors = buildHitsoundAnchorsByColumn(notes, states, 4, MISS, false)[0];

    // Press mid-break: the next note is more than 2x the miss window away.
    expect(selectHitsoundAnchor(anchors, 5000, MISS)?.plays[1]?.name).toBe("hitwhistle");
    // Close enough to the next note: switch to it.
    expect(selectHitsoundAnchor(anchors, 8900, MISS)?.plays[1]?.name).toBe("hitclap");
  });

  it("targets the first note when mashing before the map starts", () => {
    const notes = [{ column: 0, time: 5000, endTime: 5000, isHold: false, sample: sample({ additions: 4 }) }];
    const states = [{ headTime: 5000, releaseTime: 5000, tailTime: null }];
    const anchors = buildHitsoundAnchorsByColumn(notes, states, 4, MISS, false)[0];

    expect(selectHitsoundAnchor(anchors, 100, MISS)?.plays[1]?.name).toBe("hitfinish");
  });

  it("keeps replaying the last note's sound after the map ends", () => {
    const notes = [{ column: 0, time: 1000, endTime: 1000, isHold: false, sample: sample({ additions: 4 }) }];
    const states = [{ headTime: 1000, releaseTime: 1000, tailTime: null }];
    const anchors = buildHitsoundAnchorsByColumn(notes, states, 4, MISS, false)[0];

    expect(selectHitsoundAnchor(anchors, 20000, MISS)?.plays[1]?.name).toBe("hitfinish");
  });

  it("silences ghost presses while a hold note is in flight", () => {
    const notes = [
      { column: 0, time: 1000, endTime: 3000, isHold: true, sample: sample({ additions: 2 }) },
      { column: 0, time: 3500, endTime: 3500, isHold: false, sample: sample({ additions: 8 }) },
    ];
    const states = [
      { headTime: 1000, releaseTime: 2990, tailTime: 3000 },
      { headTime: 3500, releaseTime: 3500, tailTime: null },
    ];
    const anchors = buildHitsoundAnchorsByColumn(notes, states, 4, MISS, false)[0];

    // Press at the head plays the hold's samples.
    expect(selectHitsoundAnchor(anchors, 1000, MISS)?.plays.length).toBeGreaterThan(0);
    // Ghost press mid-hold targets the silent tail anchor.
    expect(selectHitsoundAnchor(anchors, 2000, MISS)?.plays).toEqual([]);
    // After the tail resolves, presses target the next note.
    expect(selectHitsoundAnchor(anchors, 3400, MISS)?.plays[1]?.name).toBe("hitclap");
  });

  it("returns null for a column with no notes", () => {
    const anchors = buildHitsoundAnchorsByColumn([], null, 4, MISS, false);
    expect(selectHitsoundAnchor(anchors[0], 1000, MISS)).toBeNull();
  });
});

describe("buildComboBreakSoundTimes", () => {
  function hits(count: number, startTime: number): Array<{ kind: "hit"; time: number }> {
    return Array.from({ length: count }, (_, i) => ({ kind: "hit" as const, time: startTime + i * 10 }));
  }

  it("always plays the first break, even from a small combo", () => {
    const events = [...hits(3, 0), { kind: "break" as const, time: 100 }];
    expect(buildComboBreakSoundTimes(events)).toEqual([100]);
  });

  it("requires combo above 20 for later breaks", () => {
    const events = [
      ...hits(5, 0),
      { kind: "break" as const, time: 100 }, // first break: plays
      ...hits(10, 200),
      { kind: "break" as const, time: 400 }, // only 10 combo: silent
      ...hits(21, 500),
      { kind: "break" as const, time: 800 }, // 21 combo: plays
    ];
    expect(buildComboBreakSoundTimes(events)).toEqual([100, 800]);
  });

  it("plays one sound for stacked misses", () => {
    const events = [
      ...hits(30, 0),
      { kind: "break" as const, time: 500 },
      { kind: "break" as const, time: 510 },
      { kind: "break" as const, time: 520 },
    ];
    expect(buildComboBreakSoundTimes(events)).toEqual([500]);
  });

  it("counts initial combo for the threshold", () => {
    const events = [{ kind: "break" as const, time: 100 }];
    expect(buildComboBreakSoundTimes(events, 50)).toEqual([100]);
    expect(buildComboBreakSoundTimes([], 50)).toEqual([]);
  });
});
