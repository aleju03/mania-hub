import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { getCachedPlayerProfileSnapshot } from "../src/features/player-profiles.js";
import type { OscScore } from "../src/shared/types.js";

let dir = "";
let db: Db;

const USER_ID = 36228152;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-player-profiles-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("player profile snapshots", () => {
  it("overlays fresh cached recent top-score candidates onto stale best-score snapshots", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const oldBest = score({
      id: 1,
      beatmapId: 101,
      title: "Old top play",
      pp: 25.45,
      endedAt: snapshotFetchedAt,
    });
    const freshRecentTop = score({
      id: 2,
      beatmapId: 102,
      title: "Fresh recent top play",
      pp: 64.73,
      endedAt: "2026-06-07T22:23:05Z",
    });
    const failedRecent = score({
      id: 3,
      beatmapId: 103,
      title: "Failed recent play",
      pp: 120,
      endedAt: "2026-06-07T22:24:05Z",
      passed: false,
    });

    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER_ID,
        "mnshiny",
        JSON.stringify({
          id: USER_ID,
          username: "MnShiny",
          country_code: "CR",
          avatar_url: "https://example.test/avatar.png",
          statistics: { pp: 1000 },
        }),
        JSON.stringify([oldBest]),
        200,
        snapshotFetchedAt,
        snapshotFetchedAt,
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into profile_section_cache (cache_key, user_id, section, payload_json, fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
      [
        `recent:${USER_ID}`,
        USER_ID,
        "recent",
        JSON.stringify([failedRecent, freshRecentTop]),
        "2026-06-07T22:25:00Z",
        "2026-06-07T22:25:00Z",
      ],
    );

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.bestScores.map((entry) => entry.id)).toEqual([2, 1]);
    expect(snapshot?.projection.appliedRecentScores).toBe(1);
    expect(snapshot?.projection.projectedPp).toBeGreaterThan(1000);
    expect((snapshot?.user.statistics as { pp?: number } | undefined)?.pp).toBe(1000);
    expect(snapshot?.projection.provenanceByScoreId[2]).toBe("profile_recent_score");
    expect(snapshot?.projection.provenanceByScoreId[3]).toBeUndefined();
  });

  it("does not overlay a fresh recent score that is not the player's map best", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const existingMapBest = score({
      id: 10,
      beatmapId: 101,
      title: "Existing map PB",
      pp: 120,
      endedAt: snapshotFetchedAt,
    });
    const recentNonPb = score({
      id: 11,
      beatmapId: 101,
      title: "Recent non-PB",
      pp: 118,
      endedAt: "2026-06-07T22:23:05Z",
      bestId: existingMapBest.id,
    });

    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER_ID,
        "mnshiny",
        JSON.stringify({
          id: USER_ID,
          username: "MnShiny",
          country_code: "CR",
          avatar_url: "https://example.test/avatar.png",
          statistics: { pp: 1000 },
        }),
        JSON.stringify([existingMapBest]),
        200,
        snapshotFetchedAt,
        snapshotFetchedAt,
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into profile_section_cache (cache_key, user_id, section, payload_json, fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
      [
        `recent:${USER_ID}`,
        USER_ID,
        "recent",
        JSON.stringify([recentNonPb]),
        "2026-06-07T22:25:00Z",
        "2026-06-07T22:25:00Z",
      ],
    );

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.bestScores.map((entry) => entry.id)).toEqual([10]);
    expect(snapshot?.projection.appliedRecentScores).toBe(0);
    expect(snapshot?.projection.provenanceByScoreId[11]).toBeUndefined();
  });

  it("does not append a same-map recent score below the cached map best", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const existingMapBest = score({
      id: 20,
      beatmapId: 101,
      title: "Existing map PB",
      pp: 120,
      endedAt: snapshotFetchedAt,
    });
    const recentLowerPp = score({
      id: 21,
      beatmapId: 101,
      title: "Recent lower PP",
      pp: 118,
      endedAt: "2026-06-07T22:23:05Z",
    });

    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER_ID,
        "mnshiny",
        JSON.stringify({
          id: USER_ID,
          username: "MnShiny",
          country_code: "CR",
          avatar_url: "https://example.test/avatar.png",
          statistics: { pp: 1000 },
        }),
        JSON.stringify([existingMapBest]),
        200,
        snapshotFetchedAt,
        snapshotFetchedAt,
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into profile_section_cache (cache_key, user_id, section, payload_json, fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
      [
        `recent:${USER_ID}`,
        USER_ID,
        "recent",
        JSON.stringify([recentLowerPp]),
        "2026-06-07T22:25:00Z",
        "2026-06-07T22:25:00Z",
      ],
    );

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.bestScores.map((entry) => entry.id)).toEqual([20]);
    expect(snapshot?.projection.appliedRecentScores).toBe(0);
    expect(snapshot?.projection.provenanceByScoreId[21]).toBeUndefined();
  });

  it("hydrates compact cached best-score snapshots from normalized metadata", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const best = score({
      id: 11,
      beatmapId: 201,
      title: "Compact best",
      pp: 88.12,
      endedAt: snapshotFetchedAt,
    });
    const { user: _user, beatmap, beatmapset, ...compactBest } = best;
    if (!beatmap || !beatmapset) throw new Error("profile fixture is missing beatmap metadata");

    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
      [
        USER_ID,
        "MnShiny",
        "https://example.test/avatar.png",
        "CR",
        JSON.stringify({ id: USER_ID, username: "MnShiny", country_code: "CR", avatar_url: "https://example.test/avatar.png", statistics: { pp: 1000 } }),
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        beatmapset.id,
        beatmapset.title,
        beatmapset.artist,
        beatmapset.creator ?? null,
        beatmapset.status ?? null,
        JSON.stringify(beatmapset.covers ?? {}),
        JSON.stringify({ ...beatmapset, play_count: 1234, preview_url: "https://b.ppy.sh/preview.mp3" }),
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        beatmap.id,
        beatmap.beatmapset_id,
        beatmap.mode,
        beatmap.status ?? null,
        beatmap.cs,
        beatmap.difficulty_rating,
        beatmap.bpm,
        beatmap.max_combo ?? null,
        beatmap.version,
        beatmap.url,
        JSON.stringify({ ...beatmap, total_length: 95, drain: 4 }),
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER_ID,
        "mnshiny",
        JSON.stringify({
          id: USER_ID,
          username: "MnShiny",
          country_code: "CR",
          avatar_url: "https://example.test/avatar.png",
          statistics: { pp: 1000 },
        }),
        JSON.stringify([compactBest]),
        200,
        snapshotFetchedAt,
        snapshotFetchedAt,
        snapshotFetchedAt,
      ],
    );

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.bestScores[0]).toMatchObject({
      id: 11,
      user: { id: USER_ID, username: "MnShiny" },
      beatmap: { id: 201, version: "[4K] Normal", total_length: 95 },
      beatmapset: { title: "Compact best", play_count: 1234 },
    });
  });

  it("attaches note-weighted BPM from chart analysis onto served best scores", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const analyzed = score({ id: 30, beatmapId: 301, title: "Analyzed", pp: 90, endedAt: snapshotFetchedAt });
    const unanalyzed = score({ id: 31, beatmapId: 302, title: "Unanalyzed", pp: 80, endedAt: snapshotFetchedAt });

    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER_ID,
        "mnshiny",
        JSON.stringify({
          id: USER_ID,
          username: "MnShiny",
          country_code: "CR",
          avatar_url: "https://example.test/avatar.png",
          statistics: { pp: 1000 },
        }),
        JSON.stringify([analyzed, unanalyzed]),
        200,
        snapshotFetchedAt,
        snapshotFetchedAt,
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, computed_at, updated_at)
       values (?, ?, 'ready', ?, ?, ?)`,
      [301, CHART_ANALYSIS_VERSION, JSON.stringify({ keyCount: 4, noteBpm: 160.5 }), snapshotFetchedAt, snapshotFetchedAt],
    );

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.bestScores.find((entry) => entry.id === 30)?.beatmap?.note_bpm).toBe(160.5);
    expect(snapshot?.bestScores.find((entry) => entry.id === 31)?.beatmap?.note_bpm).toBeUndefined();
  });
});

function score(options: {
  id: number;
  beatmapId: number;
  title: string;
  pp: number;
  endedAt: string;
  bestId?: number | null;
  passed?: boolean;
}): OscScore {
  return {
    id: options.id,
    best_id: options.bestId,
    legacy_score_id: options.id + 1000,
    user_id: USER_ID,
    accuracy: 0.98,
    beatmap_id: options.beatmapId,
    ruleset_id: 3,
    mods: [{ acronym: "CL" }],
    score: 900000,
    total_score: 900000,
    max_combo: 500,
    passed: options.passed ?? true,
    rank: "S",
    statistics: {},
    pp: options.pp,
    ended_at: options.endedAt,
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
      title: options.title,
      artist: "Artist",
      covers: {},
      status: "ranked",
    },
  };
}
