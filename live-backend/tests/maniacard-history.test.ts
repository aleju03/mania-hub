import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { estimateManiacardMapChanges, getManiacardHistory, writeProfileWithManiacardHistory } from "../src/features/maniacard-history.js";
import { computeManiaSkills, type ManiaCardScore } from "../src/shared/maniacard.js";
import { persistSessionProfileSnapshot } from "../src/features/player-profiles.js";
import { handleProfileRoutes } from "../src/http/routes/profiles.js";
import type { HttpContext } from "../src/http/context.js";
import { wipeUserProjections } from "../src/users.js";

let db: Db;
const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`;
function score(id = 1, pp = 200, day = 1, beatmapId = id): ManiaCardScore {
  return {
    id, user_id: 99, pp, accuracy: 0.99, max_combo: 900, statistics: { count_geki: 890, count_300: 10 },
    mods: [], score: 990000, passed: true, rank: "S", type: "score", created_at: at(day),
    beatmap: { id: beatmapId, beatmapset_id: beatmapId, mode: "mania", difficulty_rating: 6, cs: 4,
      bpm: 180, accuracy: 8, drain: 6, total_length: 120, count_circles: 900, count_sliders: 0,
      version: "4K", url: `https://osu.ppy.sh/beatmaps/${beatmapId}` },
    beatmapset: { id: beatmapId, title: `Song ${beatmapId}`, artist: "Artist", covers: {} },
  };
}
beforeEach(async () => {
  db = await createDb({ databaseUrl: ":memory:" });
  await migrate(db);
  await exec(db, "insert into users (user_id, username, avatar_url, updated_at) values (99, 'HistoryPlayer', '', ?)", [at(1)]);
});
afterEach(() => db.close());

async function write(scores: ManiaCardScore[], day: number, pp = 5000, guard = false) {
  await writeProfileWithManiacardHistory(db, 99, { scores, globalPp: pp, recordedAt: at(day) }, "session", guard ? {
    sql: "update profile_snapshots set updated_at = ? where user_id = 999", args: [at(day)],
  } : {
    sql: `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
      values (99, 'historyplayer', ?, ?, 200, ?, ?, ?) on conflict(user_id) do update set
      user_json = excluded.user_json, best_scores_json = excluded.best_scores_json,
      fetched_at = excluded.fetched_at, user_fetched_at = excluded.user_fetched_at, updated_at = excluded.updated_at`,
    args: [json({ id: 99, username: "HistoryPlayer", statistics: { pp } }), json(scores), at(day), at(day), at(day)],
  });
}

describe("Maniacard history", () => {
  it("records exact shared-model ratings, map estimates and tier changes, ignoring unchanged refreshes", async () => {
    await write([score()], 1);
    await write([score(2, 800, 2), score()], 2, 15000);
    await write([score(2, 800, 2), score()], 3, 15000);
    const page = await getManiacardHistory(db, 99);
    expect(page.items).toHaveLength(2);
    const entry = page.items[0];
    expect(entry.snapshot.rating).toBe(computeManiaSkills([score(2, 800, 2), score()], { globalPp: 15000 })!.cardPower);
    expect(entry.snapshot.tier).not.toBe(entry.previous!.tier);
    expect(entry.maps).toMatchObject([{ beatmapId: 2, title: "Song 2" }]);
    expect(entry.maps[0].ratingChange).toBeGreaterThan(0);
    expect(entry.maps.reduce((sum, map) => sum + map.ratingChange, entry.otherRatingChange))
      .toBe(entry.snapshot.rating - entry.previous!.rating);
    expect(page.items[1]).toMatchObject({ reason: "baseline", previous: null, maps: [] });
  });

  it("preserves a pre-existing snapshot as baseline and reads it without writes", async () => {
    await write([score()], 1);
    await exec(db, "delete from player_maniacard_history");
    expect((await getManiacardHistory(db, 99)).items).toMatchObject([{ id: 0, reason: "baseline", previous: null }]);
    expect((await exec(db, "select * from player_maniacard_history")).rows).toHaveLength(0);
    await write([score(2, 500, 2), score()], 2);
    expect((await getManiacardHistory(db, 99)).items.at(-1)?.recordedAt).toBe(at(1));
    expect(await getManiacardHistory(db, 999)).toEqual({ items: [], nextBefore: null });
  });

  it("records drops and keeps map estimates separate from pp-only changes", async () => {
    await write([score()], 1, 15000);
    await write([score()], 2, 4000);
    const entry = (await getManiacardHistory(db, 99)).items[0];
    expect(entry.maps).toEqual([]);
    expect(entry.otherRatingChange).toBeLessThan(0);
    expect(entry.otherRatingChange).toBe(entry.snapshot.rating - entry.previous!.rating);
  });

  it("replaces the previous score on a map and does not attribute old imported plays", () => {
    const previous = { scores: [score()], globalPp: 5000, recordedAt: at(1) };
    const current = { scores: [score(3, 500, 3, 1), score(2, 300, 2)], globalPp: 6000, recordedAt: at(3) };
    const maps = estimateManiacardMapChanges(previous, current);
    expect(maps.map((map) => map.beatmapId)).toEqual([2, 1]);
    const baseRating = computeManiaSkills(previous.scores, { globalPp: 5000 })!.cardPower;
    const finalRating = computeManiaSkills([score(3, 500, 3, 1), score(2, 300, 2)], { globalPp: 5585 })!.cardPower;
    expect(maps.reduce((sum, map) => sum + map.ratingChange, baseRating)).toBe(finalRating);
    expect(estimateManiacardMapChanges(previous, { ...current, scores: [score(9, 900, 1)] })).toEqual([]);
  });

  it("keeps pagination stable and preserves the delta across its boundary", async () => {
    await write([score()], 1);
    await write([score()], 2, 15000);
    const first = await getManiacardHistory(db, 99, { limit: 1 });
    expect(first.items[0].previous).not.toBeNull();
    await write([score()], 3, 25000);
    const older = await getManiacardHistory(db, 99, { before: first.nextBefore! });
    expect(older.items).toHaveLength(1);
    expect(older.items[0].snapshot).toEqual(first.items[0].previous);
    expect(older.nextBefore).toBeNull();
  });

  it("does not record failed guarded writes and is removed by a user wipe", async () => {
    await write([score()], 1);
    await write([score()], 2, 15000, true);
    expect((await getManiacardHistory(db, 99)).items).toHaveLength(1);
    await wipeUserProjections(db, 99);
    expect((await exec(db, "select * from player_maniacard_history")).rows).toHaveLength(0);
  });

  it("records through the actual session-end snapshot path without osu! calls", async () => {
    await write([score()], 1);
    await exec(db, "update users set top_scores_refreshed_at = ? where user_id = 99", [at(2)]);
    await exec(db, `insert into user_top_scores (user_id, score_id, position, pp, weighted_pp, score_json, refreshed_at)
      values (99, 2, 1, 500, 500, ?, ?)`, [json(score(2, 500, 2)), at(2)]);
    expect(await persistSessionProfileSnapshot(db, 99)).toBe("written");
    const latest = (await getManiacardHistory(db, 99)).items[0];
    expect(latest.reason).toBe("session");
    expect(latest.maps.map((map) => map.beatmapId)).toEqual([2]);
    expect(latest.maps[0].beatmapsetId).toBe(2);

    // Old history rows predate covers. Resolve their IDs at read time without
    // copying artwork URLs or rewriting the durable snapshot.
    const legacyMaps = latest.maps.map(({ beatmapsetId: _setId, ...map }) => map);
    await exec(db, "update player_maniacard_history set maps_json = ? where id = ?", [json(legacyMaps), latest.id]);
    expect((await getManiacardHistory(db, 99)).items[0].maps[0].beatmapsetId).toBe(2);
    expect((await exec(db, "select maps_json from player_maniacard_history where id = ?", [latest.id])).rows[0].maps_json).toBe(json(legacyMaps));
  });

  it("serves anonymous read-only history and rejects invalid cursors", async () => {
    await write([score()], 1);
    for (const [query, status] of [["", 200], ["?before=0", 400], ["?before=oops", 400]] as const) {
      const req = new IncomingMessage(new Socket());
      req.method = "GET";
      req.url = `/api/profiles/99/maniacard-history${query}`;
      const res = new ServerResponse(req);
      let body = "";
      res.end = ((chunk: unknown) => { body = String(chunk); return res; }) as typeof res.end;
      const ctx = { db, config: { allowedOrigins: [] } } as unknown as HttpContext;
      expect(await handleProfileRoutes(req, res, ctx, new URL(req.url, "http://localhost"), "CR")).toBe(true);
      expect(res.statusCode).toBe(status);
      if (status === 200) {
        expect(JSON.parse(body).items).toHaveLength(1);
        expect(res.getHeader("cache-control")).toBe("private, no-store");
      }
    }
  });
});
