import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  getUserBestScoresWindowCached,
  resetUserBestScoresCache,
  USER_BEST_SCORES_CACHE_TTL_MS,
} from "../src/features/user-best-scores-cache.js";
import type { OscScore } from "../src/shared/types.js";

// refresh_user_top_scores and refresh_user_maps_farmed_scores fetch the same
// top-200 window for the same player minutes apart (26k calls/day between
// them in production). Reusing one window across both is only safe while the
// rules below hold, so each of them is pinned here.

function makeScore(overrides: Partial<OscScore> = {}): OscScore {
  return {
    id: 9001,
    user_id: 101,
    ruleset_id: 3,
    accuracy: 0.98,
    beatmap_id: 501,
    mods: [],
    score: 900000,
    total_score: 900000,
    max_combo: 1000,
    passed: true,
    rank: "S",
    statistics: { count_geki: 900, count_300: 300, count_katu: 20, count_100: 5, count_50: 0, count_miss: 0 },
    pp: 250,
    ...overrides,
  } as OscScore;
}

describe("shared user best-scores window cache", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-best-cache-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    resetUserBestScoresCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetUserBestScoresCache();
    await rm(dir, { recursive: true, force: true });
  });

  async function insertScoreEvent(userId: number, receivedAt: string, scoreId = 1): Promise<void> {
    await exec(
      db,
      `insert into score_events
         (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (?, ?, ?, 'CR', 501, 3, '{}', 1, 1, 1, 0, ?, ?, 'test')`,
      [scoreId, `id:${scoreId}`, userId, receivedAt, receivedAt],
    );
  }

  it("serves a second caller from the window the first one fetched", async () => {
    const fetchWindow = vi.fn(async () => [makeScore()]);

    const first = await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    const second = await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });

    expect(fetchWindow).toHaveBeenCalledTimes(1);
    expect(second.map((score) => score.id)).toEqual(first.map((score) => score.id));
  });

  it("matches a trigger given as a legacy score id or a string", async () => {
    const fetchWindow = vi.fn(async () => [makeScore({ id: 9001, legacy_score_id: 4242 })]);

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: ["4242"] });

    expect(fetchWindow).toHaveBeenCalledTimes(1);
  });

  it("refetches once the hard TTL passes, and a hit never extends it", async () => {
    const fetchWindow = vi.fn(async () => [makeScore()]);

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    vi.advanceTimersByTime(USER_BEST_SCORES_CACHE_TTL_MS - 1_000);
    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    expect(fetchWindow).toHaveBeenCalledTimes(1);

    // Sliding would have bought the entry another full TTL from the hit above.
    vi.advanceTimersByTime(2_000);
    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it("drops the entry when a score arrived after the window was fetched", async () => {
    const fetchWindow = vi.fn(async () => [makeScore()]);

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    await insertScoreEvent(101, new Date(Date.now() + 1_000).toISOString());

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it("ignores a score another player set", async () => {
    const fetchWindow = vi.fn(async () => [makeScore()]);

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    await insertScoreEvent(202, new Date(Date.now() + 1_000).toISOString());

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    expect(fetchWindow).toHaveBeenCalledTimes(1);
  });

  it("refetches when the caller's trigger score is not in the cached window", async () => {
    const fetchWindow = vi.fn(async () => [makeScore()]);

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    // A pending top-play retry must never be handed the window that predates
    // its score, or it would keep failing to confirm until the TTL expired.
    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9999] });

    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it("refetches for a caller that names no trigger score", async () => {
    const fetchWindow = vi.fn(async () => [makeScore()]);

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    await getUserBestScoresWindowCached(db, 101, fetchWindow);

    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed fetch", async () => {
    const fetchWindow = vi.fn(async () => {
      throw new Error("osu! 404");
    });

    await expect(getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] })).rejects.toThrow("osu! 404");
    await expect(getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] })).rejects.toThrow("osu! 404");

    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure from evicting the last good window", async () => {
    const good = vi.fn(async () => [makeScore()]);
    const bad = vi.fn(async () => {
      throw new Error("osu! 503");
    });

    await getUserBestScoresWindowCached(db, 101, good, { requireScoreIds: [9001] });
    await expect(getUserBestScoresWindowCached(db, 101, bad, { requireScoreIds: [9999] })).rejects.toThrow("osu! 503");
    await getUserBestScoresWindowCached(db, 101, good, { requireScoreIds: [9001] });

    // The failed attempt was for a trigger the window did not hold, so it had
    // already dropped the entry: the third call pays for a real fetch.
    expect(good).toHaveBeenCalledTimes(2);
  });

  it("keeps players separate", async () => {
    const fetchWindow = vi.fn(async () => [makeScore()]);

    await getUserBestScoresWindowCached(db, 101, fetchWindow, { requireScoreIds: [9001] });
    await getUserBestScoresWindowCached(db, 202, fetchWindow, { requireScoreIds: [9001] });

    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });
});
