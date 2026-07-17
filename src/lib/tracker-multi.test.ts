import { describe, expect, it } from "vitest";

import {
  detectTrackerMultis,
  TRACKER_MULTI_SESSION_GAP_MS,
  TRACKER_MULTI_WINDOW_MS,
} from "./tracker-multi";
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
  it("does not flag a single co-finish round (fresh farm map burst)", () => {
    const scores = [1, 2, 3, 4, 5].map((userId, index) =>
      makeScore({ userId, beatmapId: 100, endedAt: at(index * 3) }),
    );
    expect(detectTrackerMultis(scores).size).toBe(0);
  });

  it("flags the same pair co-finishing on two maps", () => {
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(180) });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(184) });
    const multis = detectTrackerMultis([r1a, r1b, r2a, r2b]);
    const group = multis.get(getScoreIdentity(r1a));
    expect(group).toBeDefined();
    expect(group).toBe(multis.get(getScoreIdentity(r2b)));
    expect(group?.playerCount).toBe(2);
    expect(group?.rounds.map((round) => round.scores)).toEqual([[r1a, r1b], [r2a, r2b]]);
  });

  it("requires co-finish gaps of at most the window", () => {
    const gapSeconds = TRACKER_MULTI_WINDOW_MS / 1000 + 2;
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(gapSeconds) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(180) });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(180 + gapSeconds) });
    expect(detectTrackerMultis([r1a, r1b, r2a, r2b]).size).toBe(0);
  });

  it("does not link rounds played by different pairs", () => {
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    const r2a = makeScore({ userId: 3, beatmapId: 200, endedAt: at(180) });
    const r2b = makeScore({ userId: 4, beatmapId: 200, endedAt: at(184) });
    expect(detectTrackerMultis([r1a, r1b, r2a, r2b]).size).toBe(0);
  });

  it("splits rounds separated by more than the session gap", () => {
    const laterSeconds = TRACKER_MULTI_SESSION_GAP_MS / 1000 + 60;
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(laterSeconds) });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(laterSeconds + 4) });
    expect(detectTrackerMultis([r1a, r1b, r2a, r2b]).size).toBe(0);
  });

  it("trims players seen in only one round of the session", () => {
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    const bystander = makeScore({ userId: 9, beatmapId: 100, endedAt: at(5) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(180) });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(184) });
    const multis = detectTrackerMultis([r1a, r1b, bystander, r2a, r2b]);
    const group = multis.get(getScoreIdentity(r1a));
    expect(group?.playerCount).toBe(2);
    expect(group?.rounds[0]?.scores).toEqual([r1a, r1b]);
    expect(multis.has(getScoreIdentity(bystander))).toBe(false);
  });

  it("ignores one player retrying the same map quickly", () => {
    const scores = [
      makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) }),
      makeScore({ userId: 1, beatmapId: 100, endedAt: at(4) }),
      makeScore({ userId: 1, beatmapId: 200, endedAt: at(180) }),
      makeScore({ userId: 1, beatmapId: 200, endedAt: at(184) }),
    ];
    expect(detectTrackerMultis(scores).size).toBe(0);
  });

  it("does not mix rates: a DT play is not in a round with a nomod play", () => {
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0), mods: ["DT"] });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(180), mods: ["DT"] });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(184) });
    expect(detectTrackerMultis([r1a, r1b, r2a, r2b]).size).toBe(0);
  });

  it("orders each round's plays by finish time", () => {
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(4) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(0) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(180) });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(183) });
    const multis = detectTrackerMultis([r1a, r1b, r2a, r2b]);
    expect(multis.get(getScoreIdentity(r1a))?.rounds[0]?.scores).toEqual([r1b, r1a]);
  });

  it("keeps the lobby key stable when later rounds arrive", () => {
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(180) });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(184) });
    const r3a = makeScore({ userId: 1, beatmapId: 300, endedAt: at(360) });
    const r3b = makeScore({ userId: 2, beatmapId: 300, endedAt: at(363) });
    const before = detectTrackerMultis([r1a, r1b, r2a, r2b]).get(getScoreIdentity(r1a));
    const after = detectTrackerMultis([r1a, r1b, r2a, r2b, r3a, r3b]).get(getScoreIdentity(r1a));
    expect(before?.key).toBe(after?.key);
    expect(after?.rounds).toHaveLength(3);
  });

  it("dedupes overlapping pools by score identity", () => {
    const r1a = makeScore({ userId: 1, beatmapId: 100, endedAt: at(0) });
    const r1b = makeScore({ userId: 2, beatmapId: 100, endedAt: at(3) });
    const r2a = makeScore({ userId: 1, beatmapId: 200, endedAt: at(180) });
    const r2b = makeScore({ userId: 2, beatmapId: 200, endedAt: at(184) });
    const multis = detectTrackerMultis([r1a, r1b, r2a, r2b, r1a, r2b]);
    expect(multis.get(getScoreIdentity(r1a))?.rounds[0]?.scores).toEqual([r1a, r1b]);
  });

  it("skips scores without usable timestamps", () => {
    const a = makeScore({ userId: 1, beatmapId: 100, endedAt: "" });
    const b = makeScore({ userId: 2, beatmapId: 100, endedAt: "" });
    expect(detectTrackerMultis([a, b]).size).toBe(0);
  });
});
