import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { ScoreIngestor } from "../src/ingest/score-ingestor.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { compressScoreJson } from "../src/maintenance/score-json-compaction.js";
import { replaceUserTopScores, readStoredUserTopScores } from "../src/shared/score-storage.js";
import { unpackJson } from "../src/shared/compressed-json.js";
import { clearStreakMetricsCache, getStreakPlayerMetrics } from "../src/features/pack-games.js";
import { getCachedPlayerProfileSnapshot, getPlayerRecentScores } from "../src/features/player-profiles.js";
import { getUserTopPlaysFeed, getUserTrackedFeed } from "../src/features/my-data.js";
import { createUserGoal, listUserGoalsWithProgress, refreshGoalUserIndex } from "../src/features/goals.js";
import { confirmTopPlay, getTopPlaysSnapshot } from "../src/features/top-plays.js";
import { resetUserBestScoresCache } from "../src/features/user-best-scores-cache.js";
import { backfillActivityPlayDetails } from "../src/features/activity-play-details-backfill.js";
import type { OscScore } from "../src/shared/types.js";

let dir: string;
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;
let ingestor: ScoreIngestor;
let score: OscScore;
const stamp = "2026-05-12T12:00:00.000Z";
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(stamp));
  vi.stubEnv("SCORE_JSON_COMPRESSION_ENABLED", "false");
  resetUserBestScoresCache();
  dir = await mkdtemp(join(tmpdir(), "score-json-features-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db); events = new LiveEventLog(db);
  ingestor = new ScoreIngestor(db, queue, events, { topPlayMarginPp: 5, trackedCountries: ["CR"], countryWarmTtlMs: 86400000, osuClientId: "test", osuClientSecret: "test" });
  score = JSON.parse(await readFile(new URL("../fixtures/scores.json", import.meta.url), "utf8"))[0];
  await refreshGoalUserIndex(db);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearStreakMetricsCache(); resetUserBestScoresCache();
  db?.close(); await rm(dir, { recursive: true, force: true });
});

async function snapshot() {
  clearStreakMetricsCache();
  const recent = await getPlayerRecentScores(db, 101);
  return {
    best: await readStoredUserTopScores(db, 101),
    profile: await getCachedPlayerProfileSnapshot(db, "101"),
    recent: recent.payload,
    arcade: await getStreakPlayerMetrics(db, [101]),
    goals: await listUserGoalsWithProgress(db, 101),
    top: await getUserTopPlaysFeed(db, 101, 20, 0, { mods: "modded", sort: "accuracy_desc" }),
    search: await getUserTopPlaysFeed(db, 101, 20, 0, { search: "Fixture", key: 4 }),
    tracked: await getUserTrackedFeed(db, 101, 20, 0, { mods: "modded" }),
  };
}

describe("compressed score feature compatibility", () => {
  it("keeps profiles, arcade, goals, mod filters, search and activity details identical after migration", async () => {
    const played = { ...score, mods: [{ acronym: "NC", settings: { speed_change: 1.2 } }] };
    await ingestor.ingestBatch([played]);
    await replaceUserTopScores(db, 101, [played], stamp);
    await exec(db, `insert into top_play_events
      (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at, score_time, score_beatmap_id, key_count)
      values ('CR', 9001, 101, 252.4, 252.4, 25, ?, ?, ?, 501, 4)`,
    [JSON.stringify({ score: played, pp: 252.4, weightedPP: 252.4, ppGain: 25, time: stamp }), stamp, stamp]);
    await createUserGoal(db, queue, { userId: 101, country: "CR", kind: "play_pp", targetValue: 500 });
    const before = await snapshot();
    expect(before.best).toHaveLength(1);
    expect(before.top.total).toBe(1); expect(before.tracked.total).toBeGreaterThan(0);
    const activityBefore = (await exec(db, `select best_max_combo, best_has_replay, best_solo_score_id, best_total_score, best_played_at from player_activity_maps where user_id = 101`)).rows;
    const result = await compressScoreJson(db, { batchSize: 1 });
    expect(result.map((r) => r.compressed)).toEqual([1, 1, 1]);
    expect(await snapshot()).toEqual(before);
    // Force the cold lookup backfill to read compressed tracker/top-play rows.
    await exec(db, `update player_activity_maps set best_max_combo=null, best_has_replay=null, best_solo_score_id=null, best_total_score=null, best_played_at=null`);
    await backfillActivityPlayDetails(db);
    expect((await exec(db, `select best_max_combo, best_has_replay, best_solo_score_id, best_total_score, best_played_at from player_activity_maps where user_id = 101`)).rows).toEqual(activityBefore);
    // A writer still using text is safe even if it leaves stale promoted values.
    await exec(db, "update user_top_scores set score_json = ?", [JSON.stringify({ ...played, mods: [], beatmap_id: 999 })]);
    clearStreakMetricsCache();
    const metrics = await getStreakPlayerMetrics(db, [101]);
    expect(metrics[101]).not.toEqual(before.arcade[101]);
  });

  it("retains embedded search fallbacks when metadata joins are missing", async () => {
    await exec(db, `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
      values ('CR', 9001, 101, 252.4, 252.4, 25, ?, ?)`, [JSON.stringify({ score, pp: 252.4 }), stamp]);
    const before = await getUserTopPlaysFeed(db, 101, 20, 0, { search: "Fixture", key: 4, mods: "nomod" });
    expect(before.total).toBe(1);
    await compressScoreJson(db);
    expect(await getUserTopPlaysFeed(db, 101, 20, 0, { search: "Fixture", key: 4, mods: "nomod" })).toEqual(before);
  });

  it.each([false, true])("protects custom-rate evidence from ordinary reingest (existing compressed=%s)", async (compressed) => {
    vi.stubEnv("SCORE_JSON_COMPRESSION_ENABLED", String(compressed));
    const played = { ...score, mods: [{ acronym: "NC", settings: { speed_change: 1.2 } }] };
    expect((await ingestor.ingestBatch([played])).inserted).toBe(1);
    vi.stubEnv("SCORE_JSON_COMPRESSION_ENABLED", "true");
    expect((await ingestor.ingestBatch([{ ...score, mods: [{ acronym: "NC" }] }])).inserted).toBe(0);
    const row = (await exec(db, "select score_json from score_events")).rows[0];
    expect(unpackJson<OscScore>(row.score_json, {} as OscScore).mods).toEqual(played.mods);
  });

  it("resolves the JSON-id fallback and best_id from a compressed legacy identity", async () => {
    await ingestor.ingestBatch([{ ...score, best_id: 9100 }]);
    await exec(db, "update score_events set score_id = 99001, legacy_score_id = null");
    await compressScoreJson(db);
    vi.stubEnv("SCORE_JSON_COMPRESSION_ENABLED", "true");
    const osu = { getUserBestScores: async () => [{ ...score, id: 9100 }], getBeatmapUserScoresAll: async () => [] };
    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).toBe(true);
    expect((await getUserTopPlaysFeed(db, 101)).items[0].score.id).toBe(9100);
  });

  it("writes compressed events/windows and confirms against the old compressed top window", async () => {
    vi.stubEnv("SCORE_JSON_COMPRESSION_ENABLED", "true");
    await ingestor.ingestBatch([score]);
    await replaceUserTopScores(db, 101, [{ ...score, id: 8001, pp: 200 }], stamp);
    const osu = { getUserBestScores: async () => [score], getBeatmapUserScoresAll: async () => [] };
    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).toBe(true);
    for (const [table, col] of [["user_top_scores", "score_json"], ["top_play_events", "payload_json"], ["score_events", "score_json"]]) {
      expect((await exec(db, `select typeof(${col}) as kind from ${table}`)).rows.every((r) => r.kind === "blob")).toBe(true);
    }
    expect((await readStoredUserTopScores(db, 101))[0].id).toBe(9001);
    expect((await getUserTopPlaysFeed(db, 101)).items[0].score.id).toBe(9001);
    expect((await getTopPlaysSnapshot(db, "CR", "7d")).popoffs[0].score.id).toBe(9001);
    expect(await confirmTopPlay(db, events, osu, { userId: 101, scoreId: 9001, country: "CR" })).toBe(false);
  });
});
