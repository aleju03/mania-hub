import { describe, expect, it } from "vitest";
import { createDb, exec, migrate } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { OsuApiError } from "../src/osu/client.js";
import {
  backfillActivityModsRow,
  runActivityModsBackfillChunk,
  scoreMatchesRow,
  selectActivityModsBackfillRows,
  ACTIVITY_MODS_BACKFILL_DONE_META_KEY,
  ACTIVITY_MODS_BACKFILL_JOB_TYPE,
  ACTIVITY_MODS_BACKFILL_MAX_ROWS,
  ACTIVITY_MODS_BACKFILL_START,
  buildActivityModsBackfillQueue,
  ensureActivityModsBackfillSeeded,
  readActivityModsBackfillProgress,
  runActivityModsBackfillJob,
  writeActivityModsBackfillProgress,
  type ActivityModsBackfillRow,
} from "../src/features/activity-mods-backfill.js";

const ROW: ActivityModsBackfillRow = {
  rowid: 1,
  country: "CR",
  userId: 12345678,
  day: "2026-07-09",
  beatmapId: 4133106,
  scoreId: 7044060995,
  dan: 11.34,
};

function maniaScore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleset_id: 3,
    user_id: ROW.userId,
    beatmap_id: ROW.beatmapId,
    id: ROW.scoreId,
    legacy_score_id: null,
    ended_at: `${ROW.day}T19:07:59Z`,
    mods: [],
    statistics: { great: 852, perfect: 1733, miss: 7 },
    ...overrides,
  };
}

async function seedDb() {
  const db = await createDb({ ...readConfig(), databaseUrl: ":memory:" });
  await migrate(db);
  await exec(db, "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, updated_at) values (?, ?, 'mania', 'x', '2026-01-01')", [ROW.beatmapId, 1]);
  await exec(
    db,
    `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, raw_dan, updated_at)
     values (?, 1, 'ready', 4, ?, '2026-01-01')`,
    [ROW.beatmapId, ROW.dan],
  );
  await exec(
    db,
    `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_score_id, best_accuracy, updated_at)
     values (?, ?, ?, ?, 1, ?, 0.9696, '2026-07-09')`,
    [ROW.country, ROW.userId, ROW.day, ROW.beatmapId, ROW.scoreId],
  );
  await exec(db, "insert into country_rosters (country, user_id, source, is_tracked, refreshed_at) values (?, ?, 'test', 1, '2026-01-01')", [ROW.country, ROW.userId]);
  await exec(
    db,
    `insert into activity_mods_backfill_queue (position, country, user_id, day, beatmap_id, score_id, dan)
     values (1, ?, ?, ?, ?, ?, ?)`,
    [ROW.country, ROW.userId, ROW.day, ROW.beatmapId, ROW.scoreId, ROW.dan],
  );
  return db;
}

async function storedRow(db: Awaited<ReturnType<typeof seedDb>>) {
  return (await exec(db, "select best_mods_json, best_statistics_json from player_activity_maps limit 1")).rows[0];
}

describe("scoreMatchesRow", () => {
  it("accepts the score the row asked for", () => {
    expect(scoreMatchesRow(maniaScore(), ROW)).toBe(true);
  });

  // The load-bearing case: the two osu! id spaces overlap, so the wrong route
  // returns a real 200 for someone else's score rather than a 404.
  it("rejects another player's score, another chart, and another ruleset", () => {
    expect(scoreMatchesRow(maniaScore({ user_id: 7912786 }), ROW)).toBe(false);
    expect(scoreMatchesRow(maniaScore({ beatmap_id: 677310 }), ROW)).toBe(false);
    expect(scoreMatchesRow(maniaScore({ ruleset_id: 0 }), ROW)).toBe(false);
    expect(scoreMatchesRow(null, ROW)).toBe(false);
  });

  it("does not compare accuracy, which legitimately drifts from the stored day best", () => {
    expect(scoreMatchesRow(maniaScore({ accuracy: 0.5 }), ROW)).toBe(true);
  });

  it("accepts the row's id in either space", () => {
    expect(scoreMatchesRow(maniaScore({ id: 99, legacy_score_id: ROW.scoreId }), ROW)).toBe(true);
  });

  // Right player, right chart, right day - but a score this row never recorded.
  it("rejects a score that is not the one the row stored", () => {
    expect(scoreMatchesRow(maniaScore({ id: 12345, legacy_score_id: 6789 }), ROW)).toBe(false);
  });

  // The gap ruleset/user/beatmap/id all leave open: the same player's other
  // attempt on the same chart, which would overwrite this day with another's.
  it("rejects the same player's attempt from a different day", () => {
    expect(scoreMatchesRow(maniaScore({ ended_at: "2026-07-20T19:07:59Z" }), ROW)).toBe(false);
  });

  // Local-day bucketing puts a late-night play on the next UTC date.
  it("tolerates a timezone's worth of drift around the day bucket", () => {
    expect(scoreMatchesRow(maniaScore({ ended_at: `${ROW.day}T23:59:00Z` }), ROW)).toBe(true);
    expect(scoreMatchesRow(maniaScore({ ended_at: "2026-07-10T11:00:00Z" }), ROW)).toBe(true);
  });

  it("rejects a score with no usable timestamp", () => {
    expect(scoreMatchesRow(maniaScore({ ended_at: null }), ROW)).toBe(false);
  });
});

describe("backfillActivityModsRow", () => {
  it("stores an empty mods array as a real nomod value", async () => {
    const db = await seedDb();
    const outcome = await backfillActivityModsRow(db, { getScoreById: async () => maniaScore() }, ROW, "test");
    expect(outcome).toBe("filled");
    const row = await storedRow(db);
    expect(String(row.best_mods_json)).toBe("[]");
    expect(JSON.parse(String(row.best_statistics_json)).miss).toBe(7);
    db.close();
  });

  it("falls through to the other id space when the first one answers with a foreign score", async () => {
    const db = await seedDb();
    const seen: string[] = [];
    const outcome = await backfillActivityModsRow(db, {
      getScoreById: async (_id, space) => {
        seen.push(space);
        // A solo-id lookup that lands on an unrelated osu! score, then the
        // legacy route holding the real one.
        return space === "solo" ? maniaScore({ ruleset_id: 0, user_id: 1, beatmap_id: 2 }) : maniaScore({ mods: [{ acronym: "DT" }] });
      },
    }, ROW, "test");
    expect(outcome).toBe("filled");
    expect(seen).toEqual(["solo", "legacy"]);
    expect(JSON.parse(String((await storedRow(db)).best_mods_json))).toEqual([{ acronym: "DT" }]);
    db.close();
  });

  it("writes nothing when neither id space matches the row", async () => {
    const db = await seedDb();
    const outcome = await backfillActivityModsRow(db, {
      getScoreById: async () => maniaScore({ user_id: 999 }),
    }, ROW, "test");
    expect(outcome).toBe("mismatched");
    expect((await storedRow(db)).best_mods_json).toBeNull();
    db.close();
  });

  it("reports a pruned score when both id spaces 404", async () => {
    const db = await seedDb();
    const outcome = await backfillActivityModsRow(db, {
      getScoreById: async () => { throw new OsuApiError(404, "/scores/1"); },
    }, ROW, "test");
    expect(outcome).toBe("missing");
    expect((await storedRow(db)).best_mods_json).toBeNull();
    db.close();
  });

  it("propagates transient errors instead of burning the row", async () => {
    const db = await seedDb();
    await expect(backfillActivityModsRow(db, {
      getScoreById: async () => { throw new OsuApiError(429, "/scores/1"); },
    }, ROW, "test")).rejects.toBeInstanceOf(OsuApiError);
    db.close();
  });
});

describe("selectActivityModsBackfillRows", () => {
  it("walks the work list and drops rows something else already filled", async () => {
    const db = await seedDb();
    expect(await selectActivityModsBackfillRows(db, ACTIVITY_MODS_BACKFILL_START, 10, 0.96)).toHaveLength(1);
    expect(await selectActivityModsBackfillRows(db, { position: 1 }, 10, 0.96)).toHaveLength(0);
    await exec(db, "update player_activity_maps set best_mods_json = '[]'");
    expect(await selectActivityModsBackfillRows(db, ACTIVITY_MODS_BACKFILL_START, 10, 0.96)).toHaveLength(0);
    db.close();
  });

  it("caps the built work list at the sizing ceiling", async () => {
    const db = await seedDb();
    await exec(db, "delete from activity_mods_backfill_queue");
    const size = await buildActivityModsBackfillQueue(db, 0.96);
    // One player with one eligible row is below quorum, so nothing is chosen.
    expect(size).toBe(0);
    expect(size).toBeLessThanOrEqual(ACTIVITY_MODS_BACKFILL_MAX_ROWS);
    db.close();
  });
});

describe("runActivityModsBackfillChunk", () => {
  it("advances the cursor past the processed row and reports the touched user", async () => {
    const db = await seedDb();
    const result = await runActivityModsBackfillChunk(db, { getScoreById: async () => maniaScore() }, {
      cursor: ACTIVITY_MODS_BACKFILL_START,
      limit: 10,
      minAccuracy: 0.96,
      caller: "test",
    });
    expect(result).toMatchObject({ processed: 1, filled: 1, missing: 0, mismatched: 0, done: true });
    expect(result.users).toEqual([ROW.userId]);
    expect(result.cursor).toEqual({ position: 1 });
    db.close();
  });
});

describe("the chained job", () => {
  async function jobRig() {
    const db = await seedDb();
    const enqueued: Array<{ type: string; key: string; payload: unknown; options: Record<string, unknown> }> = [];
    const queue = {
      enqueue: async (type: string, key: string, payload: unknown, options: Record<string, unknown>) => {
        enqueued.push({ type, key, payload, options });
      },
    } as never;
    return { db, queue, enqueued };
  }

  it("seeds one link on boot and no more while one is pending", async () => {
    const { db, queue, enqueued } = await jobRig();
    await ensureActivityModsBackfillSeeded(db, queue);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe(ACTIVITY_MODS_BACKFILL_JOB_TYPE);
    await exec(db, "insert into jobs (type, dedupe_key, payload_json, status, priority, run_after, attempts, created_at, updated_at) values (?, 'k', '{}', 'queued', 0, '2026-01-01', 0, '2026-01-01', '2026-01-01')", [ACTIVITY_MODS_BACKFILL_JOB_TYPE]);
    await ensureActivityModsBackfillSeeded(db, queue);
    expect(enqueued).toHaveLength(1);
    db.close();
  });

  it("stops chaining and writes the done key once the scope is exhausted", async () => {
    const { db, queue, enqueued } = await jobRig();
    await runActivityModsBackfillJob(db, queue, { getScoreById: async () => maniaScore() }, undefined);
    expect(enqueued).toHaveLength(0);
    const done = (await exec(db, "select 1 as ok from live_meta where key = ?", [ACTIVITY_MODS_BACKFILL_DONE_META_KEY])).rows[0];
    expect(done?.ok).toBe(1);
    // Never reseeds after finishing, so a restart cannot replay the sweep.
    await ensureActivityModsBackfillSeeded(db, queue);
    expect(enqueued).toHaveLength(0);
    db.close();
  });

  it("marks the filled player's rating stale so the recovered clear reaches their dan", async () => {
    const { db, queue } = await jobRig();
    await exec(db, "insert into player_skill_ratings (user_id, analysis_version, status, computed_at, updated_at) values (?, 17, 'ready', ?, ?)", [ROW.userId, new Date().toISOString(), new Date().toISOString()]);
    await runActivityModsBackfillJob(db, queue, { getScoreById: async () => maniaScore() }, undefined);
    const row = (await exec(db, "select computed_at from player_skill_ratings limit 1")).rows[0];
    expect(Date.now() - Date.parse(String(row.computed_at))).toBeGreaterThan(12 * 60 * 60_000);
    db.close();
  });

  it("checkpoints the rows a failed chunk did finish before the error reaches the queue", async () => {
    const { db, queue } = await jobRig();
    // A second row behind the first, so the chunk fills one and then dies.
    await exec(
      db,
      `insert into player_activity_maps (country, user_id, day, beatmap_id, play_count, best_score_id, best_accuracy, updated_at)
       values (?, ?, '2026-07-10', ?, 1, ?, 0.97, '2026-07-10')`,
      [ROW.country, ROW.userId, ROW.beatmapId, ROW.scoreId + 1],
    );
    await exec(
      db,
      `insert into activity_mods_backfill_queue (position, country, user_id, day, beatmap_id, score_id, dan)
       values (2, ?, ?, '2026-07-10', ?, ?, ?)`,
      [ROW.country, ROW.userId, ROW.beatmapId, ROW.scoreId + 1, ROW.dan],
    );

    await expect(runActivityModsBackfillJob(db, queue, {
      getScoreById: async (scoreId: number) => {
        if (scoreId !== ROW.scoreId) throw new OsuApiError(429, "/scores/x");
        return maniaScore();
      },
    }, undefined)).rejects.toThrow();

    const stored = await readActivityModsBackfillProgress(db);
    expect(stored.cursor.position).toBe(1);
    expect(stored.filled).toBe(1);

    // The retry starts after the row already paid for and only calls for the
    // one that failed.
    const asked: number[] = [];
    await expect(runActivityModsBackfillJob(db, queue, {
      getScoreById: async (scoreId: number) => {
        asked.push(scoreId);
        throw new OsuApiError(429, "/scores/x");
      },
    }, undefined)).rejects.toThrow();
    expect(asked).toEqual([ROW.scoreId + 1]);
    db.close();
  });

  it("ignores a payload cursor that would rewind past stored progress", async () => {
    const { db, queue } = await jobRig();
    await writeActivityModsBackfillProgress(db, {
      cursor: { position: 1 },
      processed: 1, filled: 1, missing: 0, mismatched: 0, updatedAt: "",
    });
    let calls = 0;
    // A retried link replaying an old cursor must not re-spend calls on rows
    // the stored progress already passed.
    await runActivityModsBackfillJob(db, queue, {
      getScoreById: async () => { calls += 1; return maniaScore(); },
    }, { cursor: { position: 0 } });
    expect(calls).toBe(0);
    db.close();
  });
});

describe("pinned players", () => {
  it("adds a pinned player's rows even when the headroom ranking would not pick them", async () => {
    const db = await seedDb();
    await exec(db, "delete from activity_mods_backfill_queue");
    // One eligible row is below the 4-row quorum, so the ranking drops them.
    expect(await buildActivityModsBackfillQueue(db, 0.96)).toBe(0);
    process.env.ACTIVITY_MODS_BACKFILL_PIN_USERS = String(ROW.userId);
    try {
      expect(await buildActivityModsBackfillQueue(db, 0.96)).toBe(1);
    } finally {
      delete process.env.ACTIVITY_MODS_BACKFILL_PIN_USERS;
    }
    db.close();
  });
});

describe("the default pin list", () => {
  // The owner is pinned without a VPS env change; the sweep must cover him on
  // a plain deploy, not only when someone remembers to set the variable.
  it("pins the owner out of the box", () => {
    delete process.env.ACTIVITY_MODS_BACKFILL_PIN_USERS;
    expect(readConfig().activityModsBackfillPinUsers).toContain(7095193);
  });

  it("still honours an explicit override", () => {
    process.env.ACTIVITY_MODS_BACKFILL_PIN_USERS = "123,456";
    try {
      expect(readConfig().activityModsBackfillPinUsers).toEqual([123, 456]);
    } finally {
      delete process.env.ACTIVITY_MODS_BACKFILL_PIN_USERS;
    }
  });
});
