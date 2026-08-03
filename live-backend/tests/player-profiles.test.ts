import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { getCachedPackCardSnapshot, getCachedPackCardSnapshots, getCachedPlayerProfileSnapshot, getPlayerRecentScoresFromOsu } from "../src/features/player-profiles.js";
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
  it("uses the latest tracked play when osu!'s last visit is older", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const osuLastVisit = "2026-06-06T10:00:00Z";
    const trackedPlayAt = "2026-06-07T22:24:05Z";
    await insertProfileSnapshot({ snapshotFetchedAt, lastVisit: osuLastVisit });
    await insertTrackedScore(score({
      id: 1,
      beatmapId: 101,
      title: "Latest tracked play",
      pp: 40,
      endedAt: trackedPlayAt,
    }));

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.user.last_visit).toBe(trackedPlayAt);
  });

  it("drops a stale payload's newer osu! last visit for the tracked play", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const trackedPlayAt = "2026-06-07T22:24:05Z";
    const osuLastVisit = "2026-06-08T10:00:00Z";
    await insertProfileSnapshot({ snapshotFetchedAt, lastVisit: osuLastVisit });
    await insertTrackedScore(score({
      id: 1,
      beatmapId: 101,
      title: "Older tracked play",
      pp: 40,
      endedAt: trackedPlayAt,
    }));

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.user.last_visit).toBe(trackedPlayAt);
    expect(snapshot?.user.is_online).toBe(false);
  });

  it("keeps the last visit of a payload that was just fetched, but not its online flag", async () => {
    // Online on Bancho without a play is not a session, so it reads as a last
    // seen rather than a green dot.
    const osuLastVisit = new Date(Date.now() - 60_000).toISOString();
    await insertProfileSnapshot({
      snapshotFetchedAt: "2026-06-01T03:28:53Z",
      userFetchedAt: new Date().toISOString(),
      lastVisit: osuLastVisit,
      isOnline: true,
    });
    await insertTrackedScore(score({
      id: 1,
      beatmapId: 101,
      title: "Ancient tracked play",
      pp: 40,
      endedAt: "2026-06-07T22:24:05Z",
    }));

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.user.last_visit).toBe(osuLastVisit);
    expect(snapshot?.user.is_online).toBe(false);
  });

  it("reads a play inside the session window as still online", async () => {
    const trackedPlayAt = new Date(Date.now() - 2 * 60_000).toISOString();
    await insertProfileSnapshot({ snapshotFetchedAt: "2026-06-01T03:28:53Z", lastVisit: null });
    await insertTrackedScore(score({
      id: 1,
      beatmapId: 101,
      title: "Mid-session play",
      pp: 40,
      endedAt: trackedPlayAt,
    }));

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.user.is_online).toBe(true);
  });

  it("has no last seen for a player we have never tracked a play for", async () => {
    // The stored payload's own last_visit aged out with it, and nothing in our
    // projections can stand in for it, so the profile shows no last seen at all.
    await insertProfileSnapshot({ snapshotFetchedAt: "2026-06-01T03:28:53Z", lastVisit: "2026-06-06T10:00:00Z" });

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.user.last_visit).toBeNull();
    expect(snapshot?.user.is_online).toBe(false);
  });

  it("uses durable activity after the raw tracked score has expired", async () => {
    const snapshotFetchedAt = "2026-06-01T03:28:53Z";
    const trackedPlayAt = "2026-06-07T22:24:05Z";
    await insertProfileSnapshot({
      snapshotFetchedAt,
      lastVisit: "2026-06-06T10:00:00Z",
    });
    await exec(
      db,
      `insert into player_activity_score_refs
       (country, score_identity, user_id, day, beatmap_id, passed, ended_at, created_at)
       values ('CR', 'official:1', ?, '2026-06-07', 101, 1, ?, ?)`,
      [USER_ID, trackedPlayAt, trackedPlayAt],
    );

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.user.last_visit).toBe(trackedPlayAt);
  });

  it("overlays fresh tracked top-score candidates onto stale best-score snapshots", async () => {
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
    await insertTrackedScore(failedRecent);
    await insertTrackedScore(freshRecentTop);

    const snapshot = await getCachedPlayerProfileSnapshot(db, "MnShiny");

    expect(snapshot?.bestScores.map((entry) => entry.id)).toEqual([2, 1]);
    expect(snapshot?.projection.appliedRecentScores).toBe(1);
    expect(snapshot?.projection.projectedPp).toBeGreaterThan(1000);
    expect((snapshot?.user.statistics as { pp?: number } | undefined)?.pp).toBe(1000);
    expect(snapshot?.projection.provenanceByScoreId[2]).toBe("tracked_recent_score");
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
    await insertTrackedScore(recentNonPb);

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
    await insertTrackedScore(recentLowerPp);

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

describe("pack card snapshot projection", () => {
  it("trims scores and user to the fields the maniacard reads", async () => {
    const snapshotFetchedAt = new Date().toISOString();
    const best = score({ id: 41, beatmapId: 401, title: "Card play", pp: 412.5, endedAt: snapshotFetchedAt });
    // The stored osu! beatmap carries the full difficulty block; the lean
    // OsuBeatmap type just doesn't declare these fields.
    best.beatmap = {
      ...best.beatmap!,
      accuracy: 8,
      drain: 7.5,
      total_length: 121,
      count_circles: 900,
      count_sliders: 120,
      max_combo: 1315,
    } as typeof best.beatmap;

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
          statistics: { pp: 1000, global_rank: 777, play_count: 55555 },
        }),
        JSON.stringify([best]),
        200,
        snapshotFetchedAt,
        snapshotFetchedAt,
        snapshotFetchedAt,
      ],
    );

    const card = await getCachedPackCardSnapshot(db, "MnShiny");
    expect(card).not.toBeNull();

    expect(card!.view).toBe("card");
    expect(card!.isStale).toBe(false);
    expect(card!.user).toEqual({
      id: USER_ID,
      username: "MnShiny",
      avatar_url: "https://example.test/avatar.png",
      country_code: "CR",
      statistics: { pp: 1000, global_rank: 777 },
    });

    expect(card!.bestScores).toHaveLength(1);
    const entry = card!.bestScores[0];
    expect(entry).toMatchObject({
      id: 41,
      pp: 412.5,
      accuracy: 0.98,
      max_combo: 500,
      mods: [{ acronym: "CL" }],
      statistics: {},
      beatmap: {
        id: 401,
        difficulty_rating: 3.5,
        cs: 4,
        bpm: 180,
        accuracy: 8,
        drain: 7.5,
        total_length: 121,
        count_circles: 900,
        count_sliders: 120,
        max_combo: 1315,
      },
    });

    // The envelope and per-score hydration the card never reads must not ship.
    const raw = JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
    expect(raw.projection).toBeUndefined();
    const rawScore = (raw.bestScores as Record<string, unknown>[])[0];
    expect(rawScore.beatmapset).toBeUndefined();
    expect(rawScore.user).toBeUndefined();
    const rawBeatmap = rawScore.beatmap as Record<string, unknown>;
    expect(rawBeatmap.url).toBeUndefined();
    expect(rawBeatmap.version).toBeUndefined();
    const rawUser = raw.user as Record<string, unknown>;
    expect((rawUser.statistics as Record<string, unknown>).play_count).toBeUndefined();
  });

  it("keeps a score's own beatmap numbers where the stored row has none", async () => {
    // The seeded archived players (the GOAT pool) store uncompacted scores, and
    // the beatmaps table has no max_combo for most maps - so the merge has to
    // be per field, or those cards mint against a different combo ratio.
    const fetchedAt = new Date().toISOString();
    const best = score({ id: 71, beatmapId: 701, title: "Archived play", pp: 700, endedAt: fetchedAt });
    best.beatmap = { ...best.beatmap!, max_combo: 13516, count_circles: 3023, count_sliders: 2510 } as typeof best.beatmap;
    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, 'mnshiny', ?, ?, 200, ?, ?, ?)`,
      [USER_ID, JSON.stringify({ id: USER_ID, username: "MnShiny" }), JSON.stringify([best]), fetchedAt, fetchedAt, fetchedAt],
    );
    await exec(
      db,
      `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
       values (701, 801, 'mania', 'ranked', 4, 6.5, 200, null, '[4K] Insane', 'https://osu.ppy.sh/beatmaps/701', '{}', ?)`,
      [fetchedAt],
    );

    const card = await getCachedPackCardSnapshot(db, String(USER_ID), { lookupMode: "userId" });

    expect(card!.bestScores[0].beatmap).toMatchObject({
      // Stored row wins where it has a value...
      difficulty_rating: 6.5,
      bpm: 200,
      // ...and the score's copy fills the rest.
      max_combo: 13516,
      count_circles: 3023,
      count_sliders: 2510,
    });
  });

  it("mints from the live window: top-play events and tracked plays newer than the snapshot", async () => {
    // A stored window is 12 days old on average, so a card that ignored the
    // overlay would under-rate every player who has played since.
    const snapshotFetchedAt = "2026-06-01T00:00:00.000Z";
    const stored = score({ id: 61, beatmapId: 601, title: "Old best", pp: 300, endedAt: "2026-05-30T00:00:00.000Z" });
    const confirmed = score({ id: 62, beatmapId: 602, title: "New top play", pp: 500, endedAt: "2026-06-02T00:00:00.000Z" });
    const tracked = score({ id: 63, beatmapId: 603, title: "Just set", pp: 400, endedAt: "2026-06-03T00:00:00.000Z" });
    // Older than the snapshot: already inside the stored window, never re-added.
    const older = score({ id: 64, beatmapId: 604, title: "Before the bake", pp: 900, endedAt: "2026-05-20T00:00:00.000Z" });
    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, 'mnshiny', ?, ?, 200, ?, ?, ?)`,
      [
        USER_ID,
        JSON.stringify({ id: USER_ID, username: "MnShiny", statistics: { pp: 1000 } }),
        JSON.stringify([stored]),
        snapshotFetchedAt,
        snapshotFetchedAt,
        snapshotFetchedAt,
      ],
    );
    await exec(
      db,
      `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
       values ('CR', 62, ?, 500, 500, 200, ?, '2026-06-02T00:05:00.000Z')`,
      [USER_ID, JSON.stringify({ score: confirmed })],
    );
    await insertTrackedScore(tracked);
    await insertTrackedScore(older);

    const card = await getCachedPackCardSnapshot(db, String(USER_ID), { lookupMode: "userId" });

    expect(card!.bestScores.map((entry) => entry.id)).toEqual([62, 63, 61]);
  });

  it("reads a whole hand at once, from snapshots and from the top-score projection", async () => {
    const fetchedAt = new Date().toISOString();
    const other = 42;
    // Player one: a stored snapshot, with the score compacted the way the
    // storage path writes it (no inline beatmap).
    const stored = score({ id: 51, beatmapId: 501, title: "Stored", pp: 300, endedAt: fetchedAt });
    delete stored.beatmap;
    delete stored.beatmapset;
    await exec(
      db,
      `insert into profile_snapshots
       (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, 'mnshiny', ?, ?, 200, ?, ?, ?)`,
      [
        USER_ID,
        JSON.stringify({ id: USER_ID, username: "MnShiny", statistics: { pp: 1000, global_rank: 7 } }),
        JSON.stringify([stored]),
        fetchedAt,
        fetchedAt,
        fetchedAt,
      ],
    );
    await exec(
      db,
      `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
       values (501, 601, 'mania', 'ranked', 7, 5.25, 190, 2200, '[7K] Hard', 'https://osu.ppy.sh/beatmaps/501', ?, ?)`,
      [JSON.stringify({ accuracy: 8.5, drain: 8, total_length: 140, count_circles: 1500, count_sliders: 300 }), fetchedAt],
    );

    // Player two: no snapshot row, only the user_top_scores projection.
    await exec(
      db,
      "insert into users (user_id, username, country_code, avatar_url, updated_at) values (?, 'Runner', 'CR', 'https://example.test/r.png', ?)",
      [other, fetchedAt],
    );
    await exec(
      db,
      `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
       values (?, 52, 1, ?, 250, 250, ?, ?)`,
      [other, JSON.stringify({ ...score({ id: 52, beatmapId: 501, title: "Projected", pp: 250, endedAt: fetchedAt }), user_id: other }), fetchedAt, fetchedAt],
    );

    const cards = await getCachedPackCardSnapshots(db, [USER_ID, other, 999999]);

    // Uncached players are absent rather than blank; the client mints them.
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.user.id)).toEqual([USER_ID, other]);
    // Compacted scores get their difficulty numbers from the beatmaps table,
    // including the fields that live only in the stored osu! payload.
    expect(cards[0].bestScores[0].beatmap).toEqual({
      id: 501,
      difficulty_rating: 5.25,
      cs: 7,
      bpm: 190,
      accuracy: 8.5,
      drain: 8,
      total_length: 140,
      count_circles: 1500,
      count_sliders: 300,
      max_combo: 2200,
    });
    expect(cards[1].bestScores.map((entry) => entry.id)).toEqual([52]);
    expect(cards[1].isStale).toBe(true);
  });

  it("bounds the overlay read per player, not per hand", async () => {
    // Both overlay tables are per player, so one player active since their
    // snapshot must not drag their whole retention window through a read that
    // only ever keeps the newest 100 rows of it.
    const OVERLAY_SCAN_LIMIT = 100;
    const ROWS = 120;
    const other = 42;
    const snapshotFetchedAt = "2026-06-01T00:00:00.000Z";
    const at = (index: number) => new Date(Date.parse(snapshotFetchedAt) + (index + 1) * 60_000).toISOString();
    // The rows past the limit are the oldest, and they are the valuable ones:
    // if the bound is missing they get read, and then they win the card.
    const ppFor = (index: number) => (index < ROWS - OVERLAY_SCAN_LIMIT ? 999 : 200);

    await insertPackCardSnapshot(USER_ID, "mnshiny", "MnShiny", snapshotFetchedAt);
    await insertPackCardSnapshot(other, "runner", "Runner", snapshotFetchedAt);
    for (let index = 0; index < ROWS; index += 1) {
      await insertTrackedScore(score({
        id: 1000 + index,
        beatmapId: 2000 + index,
        title: `Tracked ${index}`,
        pp: ppFor(index),
        endedAt: at(index),
      }));
      const event = { ...score({ id: 5000 + index, beatmapId: 6000 + index, title: `Confirmed ${index}`, pp: ppFor(index), endedAt: at(index) }), user_id: other };
      await exec(
        db,
        `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at)
         values ('CR', ?, ?, ?, ?, 10, ?, ?)`,
        [event.id, other, event.pp, event.pp, JSON.stringify({ score: event }), at(index)],
      );
    }

    const reads: { sql: string; rows: number }[] = [];
    const cards = await getCachedPackCardSnapshots(spyOnReads(db, reads), [USER_ID, other]);

    const rowsFrom = (table: string) => reads.filter((read) => read.sql.includes(`from ${table}`)).map((read) => read.rows);
    expect(rowsFrom("score_events")).toEqual([OVERLAY_SCAN_LIMIT]);
    expect(rowsFrom("top_play_events")).toEqual([OVERLAY_SCAN_LIMIT]);
    // And the dropped rows really were out of the window, not merely unread.
    expect(cards[0].bestScores.every((entry) => entry.pp !== 999)).toBe(true);
    expect(cards[1].bestScores.every((entry) => entry.pp !== 999)).toBe(true);
  });
});

/* Counts the rows each statement actually hands back, so a missing per-player
   LIMIT shows up as the read it is rather than as a slow test. */
function spyOnReads(target: Db, reads: { sql: string; rows: number }[]): Db {
  return new Proxy(target, {
    get(db, prop) {
      const value = Reflect.get(db, prop);
      if (prop !== "execute" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(db) : value;
      }
      return async (statement: { sql: string } | string) => {
        const result = await target.execute(statement as never);
        reads.push({ sql: typeof statement === "string" ? statement : statement.sql, rows: result.rows.length });
        return result;
      };
    },
  });
}

async function insertPackCardSnapshot(userId: number, usernameKey: string, username: string, fetchedAt: string): Promise<void> {
  await exec(
    db,
    `insert into profile_snapshots
     (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
     values (?, ?, ?, '[]', 200, ?, ?, ?)`,
    [userId, usernameKey, JSON.stringify({ id: userId, username, statistics: { pp: 1000 } }), fetchedAt, fetchedAt, fetchedAt],
  );
}

async function insertProfileSnapshot({
  snapshotFetchedAt,
  userFetchedAt = snapshotFetchedAt,
  lastVisit,
  isOnline = false,
}: {
  snapshotFetchedAt: string;
  userFetchedAt?: string;
  lastVisit: string | null;
  isOnline?: boolean;
}): Promise<void> {
  await exec(
    db,
    `insert into profile_snapshots
     (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
     values (?, ?, ?, '[]', 200, ?, ?, ?)`,
    [
      USER_ID,
      "mnshiny",
      JSON.stringify({
        id: USER_ID,
        username: "MnShiny",
        country_code: "CR",
        avatar_url: "https://example.test/avatar.png",
        last_visit: lastVisit,
        is_online: isOnline,
        statistics: { pp: 1000 },
      }),
      snapshotFetchedAt,
      userFetchedAt,
      snapshotFetchedAt,
    ],
  );
}

// The profile "Load osu! recents" button pays for an osu! call that fetches
// exactly what the reconcile job fetches, so the handler reuses the payload to
// top up the tracker. That hand-off rides on this callback.
describe("profile recent osu! hand-off", () => {
  it("hands over the untrimmed payload once, and never on a cache hit", async () => {
    const now = Date.now();
    const fresh = score({ id: 1, beatmapId: 101, title: "Fresh", pp: 40, endedAt: new Date(now - 60_000).toISOString() });
    // Older than the profile's display window: the UI drops it, but the tracker
    // still wants it, so the callback must see the untrimmed list.
    const old = score({ id: 2, beatmapId: 102, title: "Old", pp: 30, endedAt: new Date(now - 25 * 60 * 60_000).toISOString() });
    const getUserRecentScores = vi.fn(async () => [fresh, old]);

    const handed: OscScore[][] = [];
    const first = await getPlayerRecentScoresFromOsu(db, { getUserRecentScores }, USER_ID, {
      onFreshScores: (scores) => handed.push(scores),
    });

    expect(getUserRecentScores).toHaveBeenCalledTimes(1);
    expect(handed).toHaveLength(1);
    expect(handed[0].map((entry) => entry.id)).toEqual([1, 2]);
    // The response itself stays trimmed to the display window.
    expect(first.payload).toHaveLength(1);

    // Second call is served from profile_section_cache: no API call, and
    // nothing to hand over, or every click would re-ingest the same scores.
    const second = await getPlayerRecentScoresFromOsu(db, { getUserRecentScores }, USER_ID, {
      onFreshScores: (scores) => handed.push(scores),
    });

    expect(getUserRecentScores).toHaveBeenCalledTimes(1);
    expect(handed).toHaveLength(1);
    expect(second.payload).toHaveLength(1);
  });
});

async function insertTrackedScore(trackedScore: OscScore): Promise<void> {
  const endedAt = trackedScore.ended_at ?? trackedScore.created_at ?? new Date().toISOString();
  const beatmapId = trackedScore.beatmap_id ?? trackedScore.beatmap?.id;
  if (!beatmapId) throw new Error("tracked profile score fixture is missing a beatmap id");
  await exec(
    db,
    `insert into score_events
     (score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json, pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
     values (?, ?, ?, ?, 'CR', ?, 3, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'osc_socket')`,
    [
      trackedScore.id,
      `official:${trackedScore.id}`,
      trackedScore.legacy_score_id ?? null,
      trackedScore.user_id,
      beatmapId,
      JSON.stringify(trackedScore),
      trackedScore.pp ?? null,
      trackedScore.total_score ?? trackedScore.score ?? null,
      trackedScore.accuracy ?? null,
      trackedScore.rank ?? null,
      trackedScore.passed ? 1 : 0,
      endedAt,
      endedAt,
    ],
  );
}

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
