import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getTrackerSnapshot, readTrackerSnapshot } from "../src/features/tracker.js";
import { getStreakPlayerMetrics } from "../src/features/pack-games.js";
import { readStatusAggregates } from "../src/http/status-reads.js";
import { registerServingReadThreads } from "../src/serving-read-thread.js";
import { packJson } from "../src/shared/compressed-json.js";

let dir: string;
let db: Db;
let config: { databaseUrl: string; journalDatabaseUrl: string };
let readers: ReturnType<typeof registerServingReadThreads>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-serving-reads-"));
  config = { databaseUrl: `file:${join(dir, "main.db")}`, journalDatabaseUrl: `file:${join(dir, "journal.db")}` };
  db = await createDb(config);
  await migrate(db);
  const journal = await createDb({ databaseUrl: config.journalDatabaseUrl });
  await migrate(journal);
  await exec(journal, "insert into api_rate_limit_reservations (provider, started_at_ms, created_at_ms, caller, path, lane) values ('osu', ?, 0, 'test', '/users/101', 'test')", [Date.now()]);
  journal.close();
  for (const [id, country, stars] of [[1, "CR", 4], [2, "GT", 6], [3, "BR", 8]] as const) {
    const ended = `2026-09-05T12:00:0${id}.000Z`;
    const score = { id, user_id: id + 100, ended_at: ended, pp: 100, rank: "A", statistics: { count_miss: 0 },
      beatmap: { id: 55, cs: 4, difficulty_rating: stars },
      beatmapset: { id: 66, title: "Chart", artist: "Artist", covers: {} },
      user: { id: id + 100, username: `user-${id}`, country_code: country } };
    await exec(db, `insert into score_events (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
      values (?, ?, ?, ?, 55, 3, ?, 1, 1, 0, 0, ?, ?, 'test')`, [id, `test-${id}`, id + 100, country, JSON.stringify(score), ended, ended]);
  }
  await exec(db, `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
    values (101, 1, 1, ?, 100, 100, '2026-09-05T12:00:01.000Z', '')`, [JSON.stringify({ beatmap_id: 55, mods: [{ acronym: "NC" }] })]);
  await exec(db, `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
    values (101, 'user-1', ?, '[]', 100, '', '', '')`, [packJson({ join_date: "2020-01-01T00:00:00Z", follower_count: 20, statistics: { play_time: 7200, replays_watched_by_others: 30 } })]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (readers) await Promise.all(Object.values(readers).map((reader) => reader.close()));
  readers = null;
  db?.close();
  await rm(dir, { recursive: true, force: true });
});

it("hydrates, filters and pages tracker off-thread and returns matching compact metrics", async () => {
  const expectedMetrics = await getStreakPlayerMetrics(db, [101, 999]);
  const options = { sort: "stars", filters: { grade: "A", miss: "fc" } } as const;
  const expectedTracker = await readTrackerSnapshot(db, "R-CAMERICA", 1, 0, options);
  readers = registerServingReadThreads(db, config);
  const servingRead = vi.spyOn(db, "execute").mockRejectedValue(new Error("serving DB must not read"));
  const region = await getTrackerSnapshot(db, "R-CAMERICA", 1, 0, options);
  expect({ ...region, fetchedAt: 0 }).toEqual({ ...expectedTracker, fetchedAt: 0 });
  expect((await getTrackerSnapshot(db, "CR", 10)).total).toBe(1);
  expect((await getTrackerSnapshot(db, "GLOBAL", 1, 1)).scores[0].id).toBe(2);
  expect(await getStreakPlayerMetrics(db, [101, 999])).toEqual(expectedMetrics);
  expect(expectedMetrics[101]).toMatchObject({ dtTop: 1, k7Top: 0, playTimeHours: 2, followers: 20 });
  expect(servingRead).not.toHaveBeenCalled();
}, 20_000);

it("reads status aggregates on the worker and uses the separate journal", async () => {
  const expected = await readStatusAggregates(db, db, { snapshotCountry: "CR", includeWorkerActivity: true });
  readers = registerServingReadThreads(db, config);
  vi.spyOn(db, "execute").mockRejectedValue(new Error("serving DB must not read"));
  const actual = await readers!.status.run({ kind: "status", options: { snapshotCountry: "CR", includeWorkerActivity: true } });
  expect(actual.analysis).toEqual(expected.analysis);
  expect({ ...actual.osuFileBackfill, updatedAt: null }).toEqual({ ...expected.osuFileBackfill, updatedAt: null });
  expect(actual.queuePressure).toEqual(expected.queuePressure);
  expect(actual.snapshotStats?.trackerScores).toBe(1);
  expect(actual.sharedRate?.usedLastMinute).toBe(1);
  expect(expected.sharedRate?.usedLastMinute).toBe(0);
}, 20_000);

it("uses the passed-country index and shares one total across page sizes and offsets", async () => {
  const plan = await exec(db, `explain query plan select count(*) from score_events se
    where se.country = 'CR' and se.passed = 1 and not exists
    (select 1 from users suppressed where suppressed.user_id = se.user_id and suppressed.is_active = 0)`);
  expect(plan.rows.map((row) => row.detail).join(" ")).toContain("idx_score_events_country_passed_time_user");
  const query = vi.spyOn(db, "execute");
  const [first, duplicate] = await Promise.all([getTrackerSnapshot(db, "CR", 1), getTrackerSnapshot(db, "CR", 1)]);
  expect(first).toBe(duplicate);
  await getTrackerSnapshot(db, "CR", 2, 1);
  const counts = () => query.mock.calls.filter(([statement]) => typeof statement !== "string" && statement.sql.includes("select count(*) as count from score_events"));
  expect(counts()).toHaveLength(1);
  await getTrackerSnapshot(db, "BR", 1);
  expect(counts()).toHaveLength(2);
});
