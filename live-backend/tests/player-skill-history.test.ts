import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createDb, exec, json, migrate, type Db } from "../src/db.js";
import { getPlayerSkillHistory, writePlayerSkillRatingWithHistory } from "../src/features/player-skill-history.js";
import { EXACT_SKILL_CURVES_META_KEY, shrinkRating } from "../src/features/skill-baseline.js";
import type { PlayerSkillModeBreakdown } from "../src/features/player-skills.js";
import { wipeUserProjections } from "../src/users.js";
import { handleProfileRoutes } from "../src/http/routes/profiles.js";
import type { HttpContext } from "../src/http/context.js";

let db: Db;
const initialAt = "2026-09-01T12:00:00.000Z";
const mode = (overall = 25): PlayerSkillModeBreakdown => ({
  keyCount: 7, analyzedPlays: 100, ratings: { Overall: overall, Stream: 22 },
  patterns: [{ id: "ln", rating: 24, plays: 40 }],
});

beforeEach(async () => {
  db = await createDb({ databaseUrl: ":memory:" });
  await migrate(db);
});
afterEach(() => db.close());

async function seed(modes = [mode()], userId = 99) {
  await exec(db, `insert into player_skill_ratings
    (user_id, analysis_version, status, modes_json, computed_at, updated_at)
    values (?, 24, 'ready', ?, ?, ?)`, [userId, json({ modes }), initialAt, initialAt]);
}

async function update(modes: PlayerSkillModeBreakdown[], day: number, guard?: string) {
  const at = `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`;
  return writePlayerSkillRatingWithHistory(db, 99, 24, modes, at, {
    sql: `update player_skill_ratings set status = 'ready', modes_json = ?, computed_at = ?, updated_at = ?
      where user_id = 99 and analysis_version = 24 ${guard ? "and updated_at = ?" : ""}`,
    args: [json({ modes }), at, at, ...(guard ? [guard] : [])],
  });
}

async function historyRequest(authorization?: string, adminToken = "test-admin-token") {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/profiles/99/skill-history?keys=7";
  req.headers = authorization ? { authorization } : {};
  const res = new ServerResponse(req);
  let body = "";
  res.end = ((chunk: unknown) => { body = String(chunk); return res; }) as typeof res.end;
  const ctx = { db, config: { liveAdminToken: adminToken, liveBridgeToken: "test-bridge-token", allowedOrigins: [] } } as unknown as HttpContext;
  expect(await handleProfileRoutes(req, res, ctx, new URL(req.url, "http://localhost"), "CR")).toBe(true);
  return { status: res.statusCode, cacheControl: res.getHeader("cache-control"), body: JSON.parse(body) };
}

describe("skill history HTTP admin gate", () => {
  it("rejects anonymous, invalid-token and bridge callers of the previously public URL", async () => {
    await seed();
    for (const token of [undefined, "Bearer wrong-token", "Bearer test-bridge-token"]) {
      expect(await historyRequest(token)).toEqual({ status: 401, cacheControl: "private, no-store", body: { error: "unauthorized" } });
    }
  });

  it("keeps recording in the background and serves those changes to an admin", async () => {
    await seed();
    await update([mode(26)], 2);
    const response = await historyRequest("Bearer test-admin-token");
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe("private, no-store");
    expect(response.body.items.map((entry: { snapshot: { ratings: { Overall: number } } }) => entry.snapshot.ratings.Overall)).toEqual([26, 25]);
  });

  it("fails closed when the backend admin token is missing", async () => {
    expect((await historyRequest("Bearer test-admin-token", "")).status).toBe(401);
  });
});

describe("player skill history", () => {
  it("serves a stored starting rating without writes or made-up older changes", async () => {
    await seed();
    const page = await getPlayerSkillHistory(db, 99, 7);
    expect(page.items).toMatchObject([{ recordedAt: initialAt, previous: null, snapshot: { ratings: { Overall: 25, "pattern:ln": 24 } } }]);
    expect((await exec(db, "select * from player_skill_history")).rows).toHaveLength(0);
    expect(await getPlayerSkillHistory(db, 999, 7)).toEqual({ items: [], nextBefore: null });
  });

  it("records rises, drops and pattern-only changes while ignoring unchanged refreshes", async () => {
    await seed();
    await update([mode(26)], 2);
    await update([{ ...mode(26.001), analyzedPlays: 101 }], 3);
    const changed = { ...mode(26), patterns: [{ id: "ln", rating: 25, plays: 41 }] };
    await update([changed], 4);
    await update([mode(23)], 5);
    const page = await getPlayerSkillHistory(db, 99, 7);
    expect(page.items.map((entry) => entry.snapshot.ratings.Overall)).toEqual([23, 26, 26, 25]);
    expect(page.items[1].previous?.ratings["pattern:ln"]).toBe(24);
    expect(page.items.at(-1)?.previous).toBeNull();
    expect(page.items.at(-1)?.recordedAt).toBe(initialAt);
    expect(await getPlayerSkillHistory(db, 99, 4)).toEqual({ items: [], nextBefore: null });
  });

  it("records dan-only changes and removed keymodes", async () => {
    await seed();
    await update([{ ...mode(), dan: { rc: { rawDan: 10, label: "10th", clears: 4 }, ln: null } }], 2);
    expect((await getPlayerSkillHistory(db, 99, 7)).items[0].snapshot.dan.rc?.label).toBe("10th");
    await update([], 3);
    expect((await getPlayerSkillHistory(db, 99, 7)).items[0].snapshot.ratings).toEqual({ Overall: 0 });
  });

  it("keeps paging stable when new entries arrive, including the boundary delta", async () => {
    await seed();
    await update([mode(26)], 2);
    await update([mode(27)], 3);
    const first = await getPlayerSkillHistory(db, 99, 7, { limit: 1 });
    expect(first.items[0].previous?.ratings.Overall).toBe(26);
    await update([mode(28)], 4);
    const older = await getPlayerSkillHistory(db, 99, 7, { before: first.nextBefore! });
    expect(older.items.map((entry) => entry.snapshot.ratings.Overall)).toEqual([26, 25]);
    expect(older.nextBefore).toBeNull();
  });

  it("does not log a stale sweep that lost its conditional update", async () => {
    await seed();
    await update([mode(26)], 2);
    const result = await update([mode(40)], 3, initialAt);
    expect(Number(result.rowsAffected)).toBe(0);
    expect((await getPlayerSkillHistory(db, 99, 7)).items).toHaveLength(2);
  });

  it("freezes display-adjusted values and retains history across version cleanup", async () => {
    await exec(db, "insert into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
      EXACT_SKILL_CURVES_META_KEY,
      json({ curves: { "7": { Overall: { median: 10, curve: [], count: 100 } } } }), initialAt,
    ]);
    await seed();
    await update([mode(26)], 2);
    await exec(db, "delete from live_meta where key = ?", [EXACT_SKILL_CURVES_META_KEY]);
    await exec(db, "delete from player_skill_ratings where user_id = 99");
    expect((await getPlayerSkillHistory(db, 99, 7)).items[0].snapshot.ratings.Overall).toBe(shrinkRating(26, 100, 10));
    await exec(db, "insert into users (user_id, username, avatar_url, updated_at) values (99, 'HistoryPlayer', '', ?)", [initialAt]);
    await wipeUserProjections(db, 99);
    expect((await getPlayerSkillHistory(db, 99, 7)).items).toHaveLength(0);
  });
});
