import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getTrackerSnapshot, readTrackerSnapshot } from "../src/features/tracker.js";
import { getStreakPlayerMetrics } from "../src/features/pack-games.js";
import { readStatusAggregates } from "../src/http/status-reads.js";
import { registerServingReadThreads } from "../src/serving-read-thread.js";
import { packJson } from "../src/shared/compressed-json.js";
import { listPackCollectionCards, readPackCollectionCards, packCardKey, type PackCollectionOptions } from "../src/features/pack-wallets.js";
import { seedCollectionCard } from "./helpers/pack-cards.js";
import { getPlayerSkillPlays, readPlayerSkillPlays, getPlayerSkillDanEvidence, readPlayerSkillDanEvidence, PLAYER_SKILLS_VERSION, type PlayerSkillBreakdown } from "../src/features/player-skills.js";
import { decoratePlayerSkillBreakdown, readDecoratedPlayerSkillBreakdown, SKILL_BASELINE_CURVES_META_KEY } from "../src/features/skill-baseline.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";

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
  // Vitest infers only execute's last (string) overload; calls can also use
  // libsql's statement-object overload, as the DB helper does here.
  const counts = () => query.mock.calls.filter(([statement]: [InStatement, ...unknown[]]) => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    return sql.includes("select count(*) as count from score_events");
  });
  expect(counts()).toHaveLength(1);
  await getTrackerSnapshot(db, "BR", 1);
  expect(counts()).toHaveLength(2);
});

it("reads shelf pages and all counts off-thread and sees other owners' serials and committed shelf changes", async () => {
  const owner = 101;
  for (const id of [11, 12, 13, owner]) await seedCollectionCard(db, owner, id, { copies: id === 12 ? 3 : 1 });
  const serial = async (writer: Db, card: number, holder: number, value: number) => exec(writer,
    "insert into pack_card_serials (card_key, card_user_id, owner_user_id, serial, minted_at) values (?, ?, ?, ?, 1000)",
    [packCardKey(card, "rare"), card, holder, value]);
  await serial(db, 11, owner, 1);
  await serial(db, 12, owner, 2);
  await serial(db, 13, owner, 3);
  const options: PackCollectionOptions[] = [
    { page: 0, pageSize: 2, withMarkCounts: true },
    { page: 1, pageSize: 2, withMarkCounts: true },
    { page: 0, pageSize: 10, mark: "only", withMarkCounts: true },
    { page: 0, pageSize: 10, sort: "copies", duplicatesOnly: true, withMarkCounts: true },
    { page: 0, pageSize: 10, query: "player1", tier: "rare", restrictToCardUserIds: [12, 13], withMarkCounts: true },
  ];
  const expected = await Promise.all(options.map(option => readPackCollectionCards(db, owner, option)));
  expect(expected[0].markCounts).toEqual({ only: 1, first: 0, second: 1, third: 1, self: 1 });
  readers = registerServingReadThreads(db, config);
  const servingRead = vi.spyOn(db, "execute").mockRejectedValue(new Error("shelf must not read on serving connection"));
  expect(await Promise.all(options.map(option => listPackCollectionCards(db, owner, option)))).toEqual(expected);
  const writer = await createDb(config);
  try {
    // This owner receives no write: somebody else's first copy changes their mark.
    await serial(writer, 11, 999, 2);
    const changed = await listPackCollectionCards(db, owner, options[2]);
    expect(changed.total).toBe(0);
    expect(changed.markCounts).toMatchObject({ only: 0, first: 1 });
    await seedCollectionCard(writer, owner, 14);
    await serial(writer, 14, owner, 1);
    await exec(writer, "update pack_collection_cards set granted_at = 1000, gifted_by_user_id = 999 where owner_user_id = ? and card_user_id = 14", [owner]);
    await exec(writer, "update pack_collection_cards set copies = 0, recycled_copies = copies where owner_user_id = ? and card_user_id = 12", [owner]);
    const after = await listPackCollectionCards(db, owner, { page: 0, pageSize: 10, withMarkCounts: true });
    expect(after).toEqual(await readPackCollectionCards(writer, owner, { page: 0, pageSize: 10, withMarkCounts: true }));
    expect(after.markCounts).toEqual({ only: 0, first: 1, second: 0, third: 1, self: 1 });
    expect(after.duplicateCardCount).toBe(0);
    expect(after.cards.find(card => card.userId === 14)?.giftedBy?.userId).toBe(999);
    await readers!.packCollection.close();
    await expect(listPackCollectionCards(db, owner, options[0])).rejects.toThrow("unavailable");
    expect(servingRead).not.toHaveBeenCalled();
  } finally { writer.close(); }
}, 20_000);

it("reads skill plays, dan evidence and the percentile fallback off-thread while preserving bounded repair jobs", async () => {
  const plays = Array.from({ length: 24 }, (_, i) => ({
    identity: `official:${1000 + i}`, beatmapId: 1000 + i, keyCount: 4, rate: i < 4 ? 1 : 1.25, goal: 0.96,
    accuracy: 0.99, stableAccuracy: 0.99, pp: 100, values: { Overall: 20 + i, Stream: 18 + i },
    patterns: ["stream"], source: "top", endedAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  for (const play of plays) {
    await exec(db, "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at) values (?, 10, 'mania', 'chart', ?, '')",
      [play.beatmapId, JSON.stringify({ accuracy: 8, total_length: 120 })]);
    await exec(db, `insert into beatmap_chart_analysis
      (beatmap_id, analysis_version, status, key_count, classification_json, msd_json, updated_at)
      values (?, ?, 'ready', 4, ?, ?, '')`, [play.beatmapId, CHART_ANALYSIS_VERSION,
      JSON.stringify({ lnRatio: 0, patterns: [{ id: "stream", score: 1 }], rc: { rawDan: 10, displayName: "Alpha" } }),
      JSON.stringify({ values: { Overall: 20, Stream: 18 } })]);
  }
  const payload = { plays, danOnly: [{ ...plays[0], identity: "official:9999", ratingExcluded: true, values: {} }] };
  await exec(db, `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
    values (101, ?, 'ready', '{}', ?, '2026-09-01', '2026-09-01')`, [PLAYER_SKILLS_VERSION, packJson(payload)]);
  await exec(db, "insert into live_meta (key, value_json, updated_at) values (?, ?, '')", [SKILL_BASELINE_CURVES_META_KEY,
    JSON.stringify({ computedAt: "2026-09-01", baselineVersion: 2, playerSkillsVersion: PLAYER_SKILLS_VERSION,
      gamma: { Overall: 1, Stream: 1 }, accSlope: 1.09, minPlays: 1,
      curves: { "4": { Overall: { count: 50, curve: [10, 20, 30] } } }, users: { "4": 50 } })]);
  const breakdown: PlayerSkillBreakdown = { status: "ready", version: PLAYER_SKILLS_VERSION, computedAt: "2026-09-01",
    totalPlays: 24, analyzedPlays: 24, pendingPlays: 0, unsupportedPlays: 0,
    modes: [{ keyCount: 4, analyzedPlays: 24, ratings: { Overall: 30, Stream: 28 }, patterns: [] }] };
  const playOptions = { sort: "recent" as const, limit: 5, offset: 2, includeRejected: true };
  const evidenceOptions = { sort: "recent" as const, includeRejected: true };
  const expectedPlays = await readPlayerSkillPlays(db, 101, 4, "Overall", playOptions);
  const expectedEvidence = await readPlayerSkillDanEvidence(db, 101, 4, "rc", evidenceOptions);
  const expectedDecoration = await readDecoratedPlayerSkillBreakdown(db, 101, breakdown);
  expect(expectedPlays.items).toHaveLength(5);
  expect(expectedEvidence.missingVerdicts).toHaveLength(16);
  expect(expectedDecoration.modes[0].percentiles?.Overall).toBeDefined();
  readers = registerServingReadThreads(db, config);
  expect(readers!.skillPlays).toBe(readers!.danEvidence);
  expect(readers!.skillPlays).not.toBe(readers!.packCollection);
  const servingRead = vi.spyOn(db, "execute").mockRejectedValue(new Error("profile must not read on serving connection"));
  const writer = await createDb(config);
  try {
    const queue = new JobQueue(writer);
    const [page, evidence, decorated] = await Promise.all([
      getPlayerSkillPlays(db, 101, 4, "Overall", playOptions),
      getPlayerSkillDanEvidence(db, 101, 4, "rc", queue, evidenceOptions),
      decoratePlayerSkillBreakdown(db, 101, breakdown),
    ]);
    // JSON bytes have the same wire semantics as the existing HTTP responses.
    expect(page).toEqual(JSON.parse(JSON.stringify(expectedPlays)));
    expect(evidence).toEqual(JSON.parse(JSON.stringify(expectedEvidence.evidence)));
    expect(decorated).toEqual(JSON.parse(JSON.stringify(expectedDecoration)));
    const jobs = (await exec(writer, "select payload_json from jobs where type = 'compute_dan_estimate'")).rows;
    expect(jobs).toHaveLength(16);
    expect(jobs.map(row => JSON.parse(String(row.payload_json)).beatmapId).sort()).toEqual(expectedEvidence.missingVerdicts.map(pair => pair.beatmapId).sort());
    await getPlayerSkillDanEvidence(db, 101, 4, "rc", queue, evidenceOptions);
    expect((await exec(writer, "select count(*) as n from jobs where type = 'compute_dan_estimate'")).rows[0].n).toBe(16);
    await exec(writer, "update player_skill_ratings set plays_json = ? where user_id = 101", [packJson({ plays: [plays[0]] })]);
    expect((await getPlayerSkillPlays(db, 101, 4, "Overall")).total).toBe(1);
    await readers!.skillPlays.close();
    await expect(getPlayerSkillPlays(db, 101, 4, "Overall")).rejects.toThrow("unavailable");
    await expect(getPlayerSkillDanEvidence(db, 101, 4, "rc", queue)).rejects.toThrow("unavailable");
    expect(servingRead).not.toHaveBeenCalled();
  } finally { writer.close(); }
}, 20_000);
