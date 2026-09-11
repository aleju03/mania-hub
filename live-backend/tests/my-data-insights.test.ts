import { describe, expect, it } from "vitest";
import {
  summarizeGrind,
  summarizeJudgements,
  summarizePlayDiet,
  summarizeSessions,
} from "../src/features/my-data-insights.js";

const MINUTE = 60_000;

function at(minutes: number): number {
  return Date.parse("2026-09-01T12:00:00Z") + minutes * MINUTE;
}

describe("summarizePlayDiet", () => {
  it("counts each pattern tag once per play and reports the share of the keymode", () => {
    const diet = summarizePlayDiet([
      { keyCount: 7, patterns: ["jack", "tech"] },
      { keyCount: 7, patterns: ["jack"] },
      { keyCount: 7, patterns: ["jack", "jack"] },
      { keyCount: 7, patterns: [] },
      { keyCount: 4, patterns: ["ln"] },
    ]);
    const sevenKey = diet.find((mode) => mode.keyCount === 7);
    expect(sevenKey).toMatchObject({ analyzed: 4, untagged: 1 });
    expect(sevenKey?.tags).toEqual([
      { id: "jack", plays: 3, pct: 75 },
      { id: "tech", plays: 1, pct: 25 },
    ]);
    expect(diet.find((mode) => mode.keyCount === 4)).toMatchObject({ analyzed: 1, untagged: 0 });
  });

  it("skips plays with no usable keymode", () => {
    expect(summarizePlayDiet([{ keyCount: 0, patterns: ["jack"] }, { patterns: ["jack"] }])).toEqual([]);
  });
});

describe("summarizeSessions", () => {
  it("splits on the 45 minute gap and measures the longest sitting", () => {
    const shape = summarizeSessions([
      at(0), at(20), at(40), // one 40 minute session of 3 plays
      at(120), at(130), // a second, 10 minute session after an 80 minute break
    ]);
    expect(shape?.sessions).toBe(2);
    expect(shape?.plays).toBe(5);
    expect(shape?.avgPlays).toBeCloseTo(2.5);
    expect(shape?.avgMinutes).toBeCloseTo(25);
    expect(shape?.longest).toMatchObject({ minutes: 40, plays: 3 });
    expect(shape?.busiest).toMatchObject({ plays: 3 });
  });

  it("keeps a sitting together across a gap of exactly the limit", () => {
    expect(summarizeSessions([at(0), at(45)])?.sessions).toBe(1);
    expect(summarizeSessions([at(0), at(46)])?.sessions).toBe(2);
  });

  it("counts a lone play as a zero length session", () => {
    expect(summarizeSessions([at(0)])).toMatchObject({ sessions: 1, plays: 1, avgMinutes: 0 });
  });

  it("returns null with nothing tracked", () => {
    expect(summarizeSessions([])).toBeNull();
    expect(summarizeSessions([Number.NaN])).toBeNull();
  });
});

describe("summarizeGrind", () => {
  it("sums a map's plays across days", () => {
    const grind = summarizeGrind([
      { beatmapId: 10, playCount: 6 },
      { beatmapId: 10, playCount: 4 },
      { beatmapId: 20, playCount: 5 },
    ]);
    expect(grind.mostPlayedId).toBe(10);
    expect(grind.mostPlayedPlays).toBe(10);
  });

  it("has no record with nothing played", () => {
    expect(summarizeGrind([])).toEqual({ mostPlayedId: null, mostPlayedPlays: 0 });
  });
});

describe("summarizeJudgements", () => {
  function play(statistics: Record<string, number>, options: { keyCount?: number | null; mods?: string[]; playedAt?: string } = {}) {
    return {
      statisticsJson: JSON.stringify(statistics),
      modsJson: JSON.stringify(options.mods ?? []),
      keyCount: options.keyCount === undefined ? 4 : options.keyCount,
      playedAt: options.playedAt ?? "2026-09-01T12:00:00Z",
    };
  }

  it("reads the MAX:300 ratio, misses per 1k notes and the earliest row in the sample", () => {
    const fingerprint = summarizeJudgements([
      play({ perfect: 700, great: 250, ok: 40, miss: 10 }, { playedAt: "2026-09-02T00:00:00Z" }),
      play({ perfect: 800, great: 200 }, { playedAt: "2026-08-30T00:00:00Z" }),
    ]);
    expect(fingerprint?.plays).toBe(2);
    expect(fingerprint?.notes).toBe(2000);
    expect(fingerprint?.maxShare).toBeCloseTo(0.75);
    // 1500 MAX against 450 300s.
    expect(fingerprint?.maxRatio).toBeCloseTo(3.333, 3);
    expect(fingerprint?.missPer1k).toBeCloseTo(5);
    expect(fingerprint?.since).toBe("2026-08-30T00:00:00Z");
  });

  it("leaves the ratio null when the sample dropped no 300", () => {
    expect(summarizeJudgements([play({ perfect: 500 })])?.maxRatio).toBeNull();
  });

  it("splits accuracy by keymode and lets a key mod override the chart", () => {
    const fingerprint = summarizeJudgements([
      ...Array.from({ length: 5 }, () => play({ perfect: 1000 })),
      ...Array.from({ length: 5 }, () => play({ perfect: 900, miss: 100 }, { keyCount: 4, mods: ["7K"] })),
      play({ perfect: 500 }, { keyCount: 6 }),
    ]);
    expect(fingerprint?.byKey).toEqual([
      { keyCount: 4, plays: 5, accuracy: 1 },
      { keyCount: 7, plays: 5, accuracy: 0.9 },
    ]);
  });

  it("ignores payloads with no judgement counts", () => {
    expect(summarizeJudgements([{ statisticsJson: "{}", modsJson: "[]", keyCount: 4, playedAt: null }])).toBeNull();
    expect(summarizeJudgements([play({})])).toBeNull();
  });
});
