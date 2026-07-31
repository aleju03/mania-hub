import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { recordMapsFarmedScore, refreshUserMapsFarmedScores } from "../src/features/maps.js";
import { JobQueue } from "../src/jobs/queue.js";
import { compactMapsFarmedOverlay } from "../src/maintenance/maps-farmed-compaction.js";
import type { OscScore } from "../src/shared/types.js";

// The farmed-scores overlay drops the full score payload (score_json stays
// '{}'), so peer accuracy must land in its own columns at write time and
// survive (or be backfilled by) storage compaction. The stored accuracy is the
// 320-weighted mania pp accuracy (getStoredScoreAccuracy), which is what the
// farm helper's (5 * acc - 4) pp scaling consumes.

const STATISTICS = { count_geki: 900, count_300: 300, count_katu: 20, count_100: 5, count_50: 0, count_miss: 0 };
const NOTE_COUNT = 1225;
const CUSTOM_ACCURACY = (900 * 320 + 300 * 300 + 20 * 200 + 5 * 100) / (NOTE_COUNT * 320);

function makeScore(overrides: Partial<OscScore> = {}): OscScore {
  return {
    id: 9001,
    user_id: 101,
    ruleset_id: 3,
    accuracy: 0.987,
    beatmap_id: 501,
    mods: [{ acronym: "DT" }],
    score: 987654,
    total_score: 987654,
    max_combo: 1234,
    passed: true,
    rank: "S",
    statistics: { ...STATISTICS },
    pp: 252.4,
    beatmap: {
      id: 501,
      beatmapset_id: 50,
      difficulty_rating: 5.6,
      mode: "mania",
      status: "ranked",
      cs: 4,
      bpm: 180,
      max_combo: 1234,
      version: "Another",
      url: "https://osu.ppy.sh/beatmaps/501",
    },
    beatmapset: {
      id: 50,
      title: "Fixture Song",
      artist: "Fixture Artist",
      creator: "mapper",
      covers: {},
      status: "ranked",
    },
    user: { id: 101, username: "Sniper", avatar_url: "https://a.ppy.sh/101", country_code: "CR" },
    created_at: "2026-05-12T00:00:00.000Z",
    ended_at: "2026-05-12T00:02:00.000Z",
    type: "solo_score",
    ...overrides,
  } as OscScore;
}

describe("maps farmed peer accuracy columns", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-accuracy-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readCountryRow(userId: number, beatmapId: number) {
    return (await exec(
      db,
      "select score_json, accuracy, note_count from country_maps_farmed_scores where country = 'CR' and user_id = ? and beatmap_id = ?",
      [userId, beatmapId],
    )).rows[0];
  }

  it("stores pp-linear custom accuracy and note count on live ingest, mirrored into the global projection", async () => {
    await recordMapsFarmedScore(db, "CR", makeScore(), "2026-05-12T00:05:00.000Z");

    const row = await readCountryRow(101, 501);
    // Not the API accuracy (0.987): the stored value is derived from the
    // judgement counts with Perfect weighted at 320.
    expect(Number(row.accuracy)).toBeCloseTo(CUSTOM_ACCURACY, 6);
    expect(Number(row.note_count)).toBe(NOTE_COUNT);

    const globalRow = (await exec(
      db,
      "select accuracy, note_count from global_maps_farmed_scores where beatmap_id = 501 and user_id = 101",
    )).rows[0];
    expect(Number(globalRow.accuracy)).toBeCloseTo(CUSTOM_ACCURACY, 6);
    expect(Number(globalRow.note_count)).toBe(NOTE_COUNT);
  });

  it("stores the same accuracy for stable-submitted scores (judgement counts, not the API accuracy)", async () => {
    const stableScore = makeScore({ legacy_score_id: 777, legacy_total_score: 987654 });
    await recordMapsFarmedScore(db, "CR", stableScore, "2026-05-12T00:05:00.000Z");

    const row = await readCountryRow(101, 501);
    expect(Number(row.accuracy)).toBeCloseTo(CUSTOM_ACCURACY, 6);
    expect(Number(row.note_count)).toBe(NOTE_COUNT);
  });

  it("populates the columns when the top-200 refresh replaces a user's overlay", async () => {
    const queue = new JobQueue(db);
    const osu = {
      getUserBestScoresWindow: vi.fn(async () => [makeScore()]),
    };

    const result = await refreshUserMapsFarmedScores(db, osu, queue, { country: "CR", userId: 101 });

    expect(result.scoreCount).toBe(1);
    const row = await readCountryRow(101, 501);
    expect(Number(row.accuracy)).toBeCloseTo(CUSTOM_ACCURACY, 6);
    expect(Number(row.note_count)).toBe(NOTE_COUNT);
  });

  it("backfills the columns from full score_json during compaction and preserves already-blanked rows", async () => {
    const now = "2026-05-12T00:05:00.000Z";
    // Legacy row: full score payload, accuracy columns never written.
    await exec(
      db,
      `insert into country_maps_farmed_scores
         (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at)
       values ('CR', 101, 501, 9001, 252.4, ?, null, null, null, ?, ?)`,
      [JSON.stringify(makeScore()), now, now],
    );
    // Already-compacted row: score_json blanked before this run; its columns
    // must come through untouched.
    await exec(
      db,
      `insert into country_maps_farmed_scores
         (country, user_id, beatmap_id, score_id, pp, score_json, mods_json, score_url, played_at, detected_at, updated_at, accuracy, note_count)
       values ('CR', 202, 502, 9002, 210.1, '{}', '[]', null, null, ?, ?, 0.9, 500)`,
      [now, now],
    );

    const result = await compactMapsFarmedOverlay(db, 100);

    expect(result).toMatchObject({ scanned: 1, compacted: 1, failed: 0 });
    const compacted = await readCountryRow(101, 501);
    expect(String(compacted.score_json)).toBe("{}");
    expect(Number(compacted.accuracy)).toBeCloseTo(CUSTOM_ACCURACY, 6);
    expect(Number(compacted.note_count)).toBe(NOTE_COUNT);
    const untouched = await readCountryRow(202, 502);
    expect(Number(untouched.accuracy)).toBeCloseTo(0.9, 6);
    expect(Number(untouched.note_count)).toBe(500);
  });
});
