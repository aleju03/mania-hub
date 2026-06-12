import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
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
});

function score(options: {
  id: number;
  beatmapId: number;
  title: string;
  pp: number;
  endedAt: string;
  passed?: boolean;
}): OscScore {
  return {
    id: options.id,
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
