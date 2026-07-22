import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  fetchAndStoreProfileSnapshotShared,
  getCachedPlayerProfileSnapshot,
  persistSessionProfileSnapshot,
  warmProfileSnapshots,
} from "../src/features/player-profiles.js";
import { replaceUserTopScores } from "../src/shared/score-storage.js";
import type { OscScore } from "../src/shared/types.js";

let dir = "";
let db: Db;

const USER_ID = 4242;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-session-snapshot-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("persistSessionProfileSnapshot", () => {
  it("materializes a durable snapshot from the ingested projection with no osu! client", async () => {
    await insertUser({ topScoresRefreshedAt: "2026-07-21T10:00:00.000Z" });
    await replaceUserTopScores(db, USER_ID, [score({ id: 1, beatmapId: 101, pp: 300 }), score({ id: 2, beatmapId: 102, pp: 250 })], "2026-07-21T10:00:00.000Z");

    // No profile_snapshots row yet, no osu client anywhere in this call path.
    const result = await persistSessionProfileSnapshot(db, USER_ID);
    expect(result).toBe("written");

    const stored = await storedSnapshotRow();
    expect(stored).toBeTruthy();
    const served = await getCachedPlayerProfileSnapshot(db, String(USER_ID));
    expect(served?.bestScores.map((s) => s.id)).toEqual([1, 2]);
    expect((served?.user.statistics as { pp?: number } | undefined)?.pp).toBe(1000);
  });

  it("does not blank an existing snapshot when the projection is empty", async () => {
    // Snapshot has real scores; projection refreshed AFTER it (gate would pass)
    // but user_top_scores is empty - the cold-fill mint owns this, not us.
    await insertUser({ topScoresRefreshedAt: "2026-07-21T12:00:00.000Z" });
    await insertSnapshot({ fetchedAt: "2026-07-21T09:00:00.000Z", scores: [score({ id: 7, beatmapId: 701, pp: 400 })] });

    const result = await persistSessionProfileSnapshot(db, USER_ID);
    expect(result).toBe("skipped");

    const served = await getCachedPlayerProfileSnapshot(db, String(USER_ID));
    expect(served?.bestScores.map((s) => s.id)).toEqual([7]);
    expect((await storedSnapshotRow())?.fetched_at).toBe("2026-07-21T09:00:00.000Z");
  });

  it("skips at the equal-timestamp boundary (projection not strictly newer than the snapshot)", async () => {
    // Pins the gate operator `<=`: a projection stamped at the same instant the
    // snapshot was written carries nothing new, so it must be a no-op. If the
    // operator regressed to `<`, this would rewrite (scores -> [8], fresh fetched_at).
    await insertUser({ topScoresRefreshedAt: "2026-07-21T09:00:00.000Z" });
    await insertSnapshot({ fetchedAt: "2026-07-21T09:00:00.000Z", scores: [score({ id: 5, beatmapId: 501, pp: 350 })] });
    await replaceUserTopScores(db, USER_ID, [score({ id: 8, beatmapId: 801, pp: 500 })], "2026-07-21T09:00:00.000Z");

    const result = await persistSessionProfileSnapshot(db, USER_ID);
    expect(result).toBe("skipped");

    expect((await storedSnapshotRow())?.fetched_at).toBe("2026-07-21T09:00:00.000Z");
    const served = await getCachedPlayerProfileSnapshot(db, String(USER_ID));
    expect(served?.bestScores.map((s) => s.id)).toEqual([5]);
  });

  it("skips (no downgrade, no redundant write) when the projection is not newer than the snapshot", async () => {
    await insertUser({ topScoresRefreshedAt: "2026-07-21T08:00:00.000Z" });
    await insertSnapshot({ fetchedAt: "2026-07-21T09:00:00.000Z", scores: [score({ id: 5, beatmapId: 501, pp: 350 })] });
    await replaceUserTopScores(db, USER_ID, [score({ id: 99, beatmapId: 999, pp: 999 })], "2026-07-21T08:00:00.000Z");

    const result = await persistSessionProfileSnapshot(db, USER_ID);
    expect(result).toBe("skipped");

    const stored = await storedSnapshotRow();
    expect(stored?.fetched_at).toBe("2026-07-21T09:00:00.000Z");
    const served = await getCachedPlayerProfileSnapshot(db, String(USER_ID));
    expect(served?.bestScores.map((s) => s.id)).toEqual([5]);
  });

  it("rewrites when the projection carries newer top-play data than the snapshot", async () => {
    await insertUser({ topScoresRefreshedAt: "2026-07-21T11:00:00.000Z" });
    await insertSnapshot({ fetchedAt: "2026-07-21T09:00:00.000Z", scores: [score({ id: 5, beatmapId: 501, pp: 350 })] });
    await replaceUserTopScores(db, USER_ID, [score({ id: 8, beatmapId: 801, pp: 500 }), score({ id: 5, beatmapId: 501, pp: 350 })], "2026-07-21T11:00:00.000Z");

    const result = await persistSessionProfileSnapshot(db, USER_ID);
    expect(result).toBe("written");

    const served = await getCachedPlayerProfileSnapshot(db, String(USER_ID));
    expect(served?.bestScores.map((s) => s.id)).toEqual([8, 5]);
    expect((await storedSnapshotRow())?.fetched_at).not.toBe("2026-07-21T09:00:00.000Z");
  });
});

describe("warmProfileSnapshots no longer re-mints served players", () => {
  it("skips players who already have a snapshot or a populated projection, mints only never-seen ids", async () => {
    // hasSnapshot: stale row present; hasProjection: only user_top_scores.
    await insertUser({ userId: 10, topScoresRefreshedAt: "2026-07-01T00:00:00.000Z" });
    await insertSnapshot({ userId: 10, fetchedAt: "2026-01-01T00:00:00.000Z", scores: [score({ userId: 10, id: 1, beatmapId: 1, pp: 100 })] });
    await insertUser({ userId: 20, topScoresRefreshedAt: "2026-07-01T00:00:00.000Z" });
    await replaceUserTopScores(db, 20, [score({ userId: 20, id: 2, beatmapId: 2, pp: 100 })], "2026-07-01T00:00:00.000Z");

    let osuCalls = 0;
    const osu = {
      getUserByKey: async () => { osuCalls++; return { id: 30, username: "Cold" }; },
      getUserBestScoresWindow: async () => { osuCalls++; return [] as OscScore[]; },
    };

    // id 10 (stale snapshot) and id 20 (projection) must be skipped; only 30 is cold.
    const { warming } = await warmProfileSnapshots(db, osu, [10, 20, 30]);
    expect(warming).toBe(1);
    // Let the background mint for the one cold id settle before teardown.
    await new Promise((r) => setTimeout(r, 30));
    expect(osuCalls).toBeGreaterThan(0);
  });
});

describe("mint caller lane parameterization", () => {
  it("threads a job-lane caller through to the osu client (user lookup and best-scores), default stays interactive", async () => {
    const callers: string[] = [];
    const osu = {
      getUserByKey: async (_key: string, caller: string, _lookup?: "id" | "username") => {
        callers.push(caller);
        return { id: USER_ID, username: "Cold" } as Record<string, unknown>;
      },
      getUserBestScoresWindow: async (_userId: number, _limit: number, caller: string) => {
        callers.push(caller);
        return [] as OscScore[];
      },
    };

    // Background/session path must run on the job lane (classifyLimiterLane maps
    // the `job:` prefix -> job lane, `api:` -> interactive).
    await fetchAndStoreProfileSnapshotShared(db, osu, String(USER_ID), "userId", "job:refresh_profile_snapshot");
    expect(callers).toContain("job:refresh_profile_snapshot");
    expect(callers).toContain("job:refresh_profile_snapshot:best");

    // The default (request path) is unchanged - still the interactive caller.
    callers.length = 0;
    await fetchAndStoreProfileSnapshotShared(db, osu, String(USER_ID), "userId");
    expect(callers).toContain("api:profile_snapshot");
    expect(callers).toContain("api:profile_snapshot:best");
  });
});

async function storedSnapshotRow(userId = USER_ID): Promise<{ fetched_at: string } | undefined> {
  const row = (await exec(db, "select fetched_at from profile_snapshots where user_id = ?", [userId])).rows[0];
  return row ? { fetched_at: String(row.fetched_at) } : undefined;
}

async function insertUser(opts: { userId?: number; topScoresRefreshedAt: string }): Promise<void> {
  const userId = opts.userId ?? USER_ID;
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at, pp, global_rank, top_scores_refreshed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      `User${userId}`,
      "https://example.test/a.png",
      "CR",
      JSON.stringify({ id: userId, username: `User${userId}`, statistics: { pp: 1000, global_rank: 500 } }),
      "2026-07-21T10:00:00.000Z",
      1000,
      500,
      opts.topScoresRefreshedAt,
    ],
  );
}

async function insertSnapshot(opts: { userId?: number; fetchedAt: string; scores: OscScore[] }): Promise<void> {
  const userId = opts.userId ?? USER_ID;
  await exec(
    db,
    `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      `user${userId}`,
      JSON.stringify({ id: userId, username: `User${userId}`, statistics: { pp: 1000 } }),
      JSON.stringify(opts.scores),
      200,
      opts.fetchedAt,
      opts.fetchedAt,
      opts.fetchedAt,
    ],
  );
}

function score(options: { id: number; beatmapId: number; pp: number; userId?: number }): OscScore {
  const userId = options.userId ?? USER_ID;
  return {
    id: options.id,
    best_id: options.id,
    legacy_score_id: options.id + 1000,
    user_id: userId,
    accuracy: 0.98,
    beatmap_id: options.beatmapId,
    ruleset_id: 3,
    mods: [{ acronym: "CL" }],
    score: 900000,
    total_score: 900000,
    max_combo: 500,
    passed: true,
    rank: "S",
    statistics: {},
    pp: options.pp,
    ended_at: "2026-07-21T09:30:00.000Z",
    ranked: true,
    beatmap: {
      id: options.beatmapId,
      beatmapset_id: options.beatmapId + 100,
      difficulty_rating: 3.5,
      mode: "mania",
      status: "ranked",
      cs: 4,
      bpm: 180,
      version: "[4K] Normal",
      url: `https://osu.ppy.sh/beatmaps/${options.beatmapId}`,
    },
    beatmapset: {
      id: options.beatmapId + 100,
      title: "Song",
      artist: "Artist",
      covers: {},
      status: "ranked",
    },
  };
}
