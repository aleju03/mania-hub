import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { refreshUserMapsFarmedScores } from "../src/features/maps.js";
import { JobQueue } from "../src/jobs/queue.js";
import type { OscScore } from "../src/shared/types.js";

// A top-200 refresh replaces the user's whole overlay, but only maps whose
// stored row materially changed may reach global_maps_farmed_changes: every
// id published there makes every serving process re-materialize that map's
// full global player list on its next board patch. Pack probes re-run these
// refreshes thousands of times a day on unchanged users — publishing no-ops
// is what ground the site down on 2026-08-04.

const STATISTICS = { count_geki: 900, count_300: 300, count_katu: 20, count_100: 5, count_50: 0, count_miss: 0 };

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

function makeSecondScore(overrides: Partial<OscScore> = {}): OscScore {
  return makeScore({
    id: 9002,
    beatmap_id: 502,
    pp: 199.9,
    beatmap: { ...makeScore().beatmap!, id: 502, url: "https://osu.ppy.sh/beatmaps/502" },
    ...overrides,
  });
}

describe("farmed overlay refresh diffs before publishing global changes", () => {
  let dir = "";
  let db: Db;
  let queue: JobQueue;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-farmed-diff-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    queue = new JobQueue(db);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readChangeRevisions(): Promise<Map<number, number>> {
    const rows = (await exec(db, "select beatmap_id, revision from global_maps_farmed_changes")).rows;
    return new Map(rows.map((row) => [Number(row.beatmap_id), Number(row.revision)]));
  }

  async function readStateRevision(): Promise<number> {
    const row = (await exec(db, "select revision from global_maps_farmed_state where singleton = 1")).rows[0];
    return Number(row?.revision ?? 0);
  }

  async function readOverlayStamp(): Promise<string | null> {
    const row = (await exec(
      db,
      "select value_json from live_meta where key = 'maps_farmed_overlay_updated_at:CR'",
    )).rows[0];
    return row?.value_json == null ? null : String(row.value_json);
  }

  it("publishes nothing when the refreshed top 200 is identical", async () => {
    const osu = { getUserBestScoresWindow: vi.fn(async () => [makeScore(), makeSecondScore()]) };
    await refreshUserMapsFarmedScores(db, osu, queue, { country: "CR", userId: 101 });

    const revisionAfterSeed = await readStateRevision();
    const changesAfterSeed = await readChangeRevisions();
    const stampAfterSeed = await readOverlayStamp();
    expect(changesAfterSeed.size).toBe(2);

    await refreshUserMapsFarmedScores(db, osu, queue, { country: "CR", userId: 101 });

    expect(await readStateRevision()).toBe(revisionAfterSeed);
    expect(await readChangeRevisions()).toEqual(changesAfterSeed);
    // The country stamp did not move either, so the snapshot mint stays quiet.
    expect(await readOverlayStamp()).toBe(stampAfterSeed);
  });

  it("publishes only the map whose stored play actually changed", async () => {
    const osu = { getUserBestScoresWindow: vi.fn(async () => [makeScore(), makeSecondScore()]) };
    await refreshUserMapsFarmedScores(db, osu, queue, { country: "CR", userId: 101 });
    const before = await readChangeRevisions();

    const improved = makeSecondScore({ id: 9003, pp: 210.3 });
    osu.getUserBestScoresWindow = vi.fn(async () => [makeScore(), improved]);
    await refreshUserMapsFarmedScores(db, osu, queue, { country: "CR", userId: 101 });

    const after = await readChangeRevisions();
    expect(after.get(501)).toBe(before.get(501));
    expect(after.get(502)).toBeGreaterThan(before.get(502)!);
    const globalRow = (await exec(
      db,
      "select pp from global_maps_farmed_scores where beatmap_id = 502 and user_id = 101",
    )).rows[0];
    expect(Number(globalRow.pp)).toBeCloseTo(210.3, 6);
  });

  it("publishes a map that fell out of the top 200", async () => {
    const osu = { getUserBestScoresWindow: vi.fn(async () => [makeScore(), makeSecondScore()]) };
    await refreshUserMapsFarmedScores(db, osu, queue, { country: "CR", userId: 101 });
    const before = await readChangeRevisions();

    osu.getUserBestScoresWindow = vi.fn(async () => [makeScore()]);
    await refreshUserMapsFarmedScores(db, osu, queue, { country: "CR", userId: 101 });

    const after = await readChangeRevisions();
    expect(after.get(501)).toBe(before.get(501));
    expect(after.get(502)).toBeGreaterThan(before.get(502)!);
    const globalRow = (await exec(
      db,
      "select pp from global_maps_farmed_scores where beatmap_id = 502 and user_id = 101",
    )).rows[0];
    expect(globalRow).toBeUndefined();
  });
});
