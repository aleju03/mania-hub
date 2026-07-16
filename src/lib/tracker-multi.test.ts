import { describe, expect, it } from "vitest";

import { detectTrackerMultis, TRACKER_MULTI_WINDOW_MS } from "./tracker-multi";
import { getScoreIdentity } from "./score";
import type { LeanTrackerScore, OsuMod } from "./types";

let nextId = 1;

function makeScore(overrides: {
  userId: number;
  username?: string;
  beatmapId: number;
  endedAt: string;
  mods?: string[];
}): LeanTrackerScore {
  return {
    id: nextId++,
    user_id: overrides.userId,
    accuracy: 0.97,
    mods: (overrides.mods ?? []).map((acronym) => ({ acronym })) as OsuMod[],
    score: 900_000,
    max_combo: 500,
    passed: true,
    rank: "S",
    statistics: {},
    pp: 100,
    beatmap: {
      id: overrides.beatmapId,
      beatmapset_id: 1,
      difficulty_rating: 4,
      mode: "mania",
      cs: 4,
      bpm: 180,
      max_combo: 800,
      version: "4K Hard",
      url: "",
    },
    beatmapset: { id: 1, title: "Song", artist: "Artist", covers: {} as never },
    user: {
      id: overrides.userId,
      username: overrides.username ?? `player${overrides.userId}`,
      avatar_url: "",
      country_code: "CR",
    },
    ended_at: overrides.endedAt,
  };
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 6, 16, 12, 0, offsetSeconds)).toISOString();
}

describe("detectTrackerMultis", () => {
  it("flags two players finishing the same map within the window", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(8) });
    const multis = detectTrackerMultis([a, b]);
    expect(multis.get(getScoreIdentity(a))).toEqual({ playerCount: 2, others: ["player2"] });
    expect(multis.get(getScoreIdentity(b))).toEqual({ playerCount: 2, others: ["player1"] });
  });

  it("ignores same-map plays outside the window", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(TRACKER_MULTI_WINDOW_MS / 1000 + 5) });
    expect(detectTrackerMultis([a, b]).size).toBe(0);
  });

  it("ignores simultaneous plays on different maps", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(1) });
    expect(detectTrackerMultis([a, b]).size).toBe(0);
  });

  it("ignores one player retrying the same map quickly", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const b = makeScore({ userId: 1, beatmapId: 100, endedAt: at(10) });
    expect(detectTrackerMultis([a, b]).size).toBe(0);
  });

  it("does not mix rates: a DT play is not in a lobby with a nomod play", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0), mods: ["DT"] });
    const b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    expect(detectTrackerMultis([a, b]).size).toBe(0);
  });

  it("groups a full lobby and lists co-players by finish order", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(5) });
    const c = makeScore({ userId: 3, beatmapId: 100, endedAt: at(12) });
    const multis = detectTrackerMultis([c, a, b]);
    expect(multis.get(getScoreIdentity(b))).toEqual({ playerCount: 3, others: ["player1", "player3"] });
  });

  it("chains within the window but splits separate rounds", () => {
    const round1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const round1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(6) });
    const round2a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(300) });
    const round2b = makeScore({ userId: 3, beatmapId: 100, endedAt: at(306) });
    const multis = detectTrackerMultis([round1a, round1b, round2a, round2b]);
    expect(multis.get(getScoreIdentity(round1a))?.others).toEqual(["player2"]);
    expect(multis.get(getScoreIdentity(round2a))?.others).toEqual(["player3"]);
  });

  it("dedupes overlapping pools by score identity", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(4) });
    const multis = detectTrackerMultis([a, b, a, b]);
    expect(multis.get(getScoreIdentity(a))).toEqual({ playerCount: 2, others: ["player2"] });
  });

  it("skips scores without usable timestamps", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: "" });
    const b = makeScore({ userId: 2, beatmapId: 100, endedAt: "" });
    expect(detectTrackerMultis([a, b]).size).toBe(0);
  });
});
