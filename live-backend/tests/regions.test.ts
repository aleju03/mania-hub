import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countryScopeSql, resolveCountryScope } from "../src/countries.js";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { getGlobalRankingsSnapshot, getRegionRankingsSnapshot } from "../src/features/global-rankings.js";
import { getSnipesSnapshot } from "../src/features/snipes.js";
import { getTopPlaysSnapshot } from "../src/features/top-plays.js";
import { getTrackerSnapshot } from "../src/features/tracker.js";
import { normalizeCountryParam } from "../src/http/abuse-guard.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { CONTINENTS, REGIONS } from "../src/regions.js";

describe("region table", () => {
  it("keeps codes namespaced away from ISO countries and members unique", () => {
    const codes = new Set<string>();
    const members = new Map<string, string>();
    for (const region of REGIONS) {
      expect(region.code).toMatch(/^R-[A-Z]+$/);
      expect(region.code).not.toMatch(/^[A-Z]{2}$/);
      expect(codes.has(region.code)).toBe(false);
      codes.add(region.code);
      expect(region.countries.length).toBeGreaterThan(0);
      for (const country of region.countries) {
        expect(country).toMatch(/^[A-Z]{2}$/);
        // A country in two regions would double-count in every union filter.
        expect(members.get(country), `${country} in ${region.code} and ${members.get(country)}`).toBeUndefined();
        members.set(country, region.code);
      }
    }
  });

  it("partitions every subregion member into exactly one continent", () => {
    const subregionMembers = new Set(REGIONS.flatMap((region) => region.countries));
    const seen = new Map<string, string>();
    for (const continent of CONTINENTS) {
      expect(continent.code).toMatch(/^R-[A-Z]+$/);
      for (const country of continent.countries) {
        expect(subregionMembers.has(country), `${country} in ${continent.code} but no subregion`).toBe(true);
        expect(seen.get(country), `${country} in ${continent.code} and ${seen.get(country)}`).toBeUndefined();
        seen.set(country, continent.code);
      }
    }
    // No subregion member falls outside every continent either.
    expect(seen.size).toBe(subregionMembers.size);
  });
});

describe("region scope resolution", () => {
  it("accepts region codes through the country param validator", () => {
    expect(normalizeCountryParam("R-SEASIA")).toBe("R-SEASIA");
    expect(normalizeCountryParam("r-seasia")).toBe("R-SEASIA");
    expect(normalizeCountryParam("r-europe")).toBe("R-EUROPE");
    expect(normalizeCountryParam("GLOBAL")).toBe("GLOBAL");
    expect(normalizeCountryParam("CR")).toBe("CR");
    expect(normalizeCountryParam("R-NOPE")).toBeNull();
    expect(normalizeCountryParam("R-")).toBeNull();
  });

  it("resolves the three scope kinds", () => {
    expect(resolveCountryScope("CR")).toEqual({ kind: "country", code: "CR", codes: ["CR"] });
    expect(resolveCountryScope("GLOBAL")).toEqual({ kind: "global", code: "GLOBAL", codes: null });
    const region = resolveCountryScope("R-CAMERICA");
    expect(region.kind).toBe("region");
    expect(region.codes).toContain("CR");
    expect(region.codes).toContain("GT");
    expect(region.codes).not.toContain("BR");
    // Mexico reads as North America, not M49's Central America.
    expect(region.codes).not.toContain("MX");
    expect(resolveCountryScope("R-NAMERICA").codes).toContain("MX");
    // A continent unions its subregions.
    const continent = resolveCountryScope("R-AMERICAS");
    expect(continent.kind).toBe("region");
    expect(continent.codes).toEqual(expect.arrayContaining(["BR", "CR", "MX"]));
    expect(continent.codes).not.toContain("ES");
  });

  it("builds equality for one code, IN for many, nothing for global", () => {
    expect(countryScopeSql(resolveCountryScope("CR"), "se.country")).toEqual({ clause: "se.country = ?", args: ["CR"] });
    const regionSql = countryScopeSql(resolveCountryScope("R-CAMERICA"), "se.country");
    expect(regionSql?.clause).toMatch(/^se\.country in \((\?,)*\?\)$/);
    expect(regionSql?.args).toContain("GT");
    expect(countryScopeSql(resolveCountryScope("GLOBAL"), "se.country")).toBeNull();
  });
});

describe("region read filters", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-regions-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function seedScoreEvent(scoreId: number, country: string, userId: number): Promise<void> {
    const endedAt = new Date().toISOString();
    const scoreJson = JSON.stringify({
      id: scoreId,
      user_id: userId,
      ended_at: endedAt,
      statistics: {},
      beatmap: { id: 55, difficulty_rating: 4.2 },
      beatmapset: { id: 66, title: "Chart", artist: "Artist", covers: {} },
      user: { id: userId, username: `user-${userId}`, country_code: country },
    });
    await exec(
      db,
      `insert into score_events (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json, passed, processed, is_lazer, has_replay, ended_at, received_at, source)
       values (?, ?, ?, ?, 55, 3, ?, 1, 1, 0, 0, ?, ?, 'test')`,
      [scoreId, `region-${scoreId}`, userId, country, scoreJson, endedAt, endedAt],
    );
  }

  it("aggregates tracker rows across a region's member countries only", async () => {
    await seedScoreEvent(1, "CR", 101);
    await seedScoreEvent(2, "GT", 102);
    await seedScoreEvent(3, "BR", 103);

    const region = await getTrackerSnapshot(db, "R-CAMERICA", 10);
    expect(region.total).toBe(2);
    expect(region.scores.map((score) => score.user_id).sort()).toEqual([101, 102]);
    expect((await getTrackerSnapshot(db, "R-AMERICAS", 10)).total).toBe(3);
    expect((await getTrackerSnapshot(db, "CR", 10)).total).toBe(1);
    expect((await getTrackerSnapshot(db, "GLOBAL", 10)).total).toBe(3);
  });

  it("aggregates top plays across a region's member countries only", async () => {
    const now = new Date().toISOString();
    for (const [country, scoreId, userId] of [["CR", 1, 101], ["GT", 2, 102], ["BR", 3, 103]] as const) {
      await exec(
        db,
        `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at, score_time)
         values (?, ?, ?, 100, 95, 20, '{}', ?, ?)`,
        [country, scoreId, userId, now, now],
      );
    }
    expect((await getTopPlaysSnapshot(db, "R-CAMERICA", "7d")).total).toBe(2);
    expect((await getTopPlaysSnapshot(db, "CR", "7d")).total).toBe(1);
    expect((await getTopPlaysSnapshot(db, "GLOBAL", "7d")).total).toBe(3);
  });

  it("aggregates snipes across a region while GLOBAL stays empty", async () => {
    const now = new Date().toISOString();
    for (const [country, scoreId] of [["CR", 1], ["GT", 2], ["BR", 3]] as const) {
      await exec(
        db,
        `insert into snipe_events (country, beatmap_id, lane_key, score_id, sniper_id, victim_id, board_rank, payload_json, detected_at)
         values (?, 55, '4k', ?, 101, 102, 1, '{}', ?)`,
        [country, scoreId, now],
      );
    }
    expect((await getSnipesSnapshot(db, "R-CAMERICA", 10)).events).toHaveLength(2);
    expect((await getSnipesSnapshot(db, "CR", 10)).events).toHaveLength(1);
    expect((await getSnipesSnapshot(db, "GLOBAL", 10)).events).toHaveLength(0);
  });

  async function seedPlayer(userId: number, username: string, pp: number, country: string): Promise<void> {
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, pp, global_rank, country_rank, profile_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, username, `https://a.ppy.sh/${userId}`, country, pp, userId, 1, JSON.stringify({ statistics: { hit_accuracy: 98.5, play_count: 1000, ranked_score: 12345 } }), new Date().toISOString()],
    );
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values (?, ?, 1, 'test', 1, ?)`,
      [country, userId, new Date().toISOString()],
    );
  }

  it("serves region rankings as the filtered, renumbered global board", async () => {
    await seedPlayer(1, "tico", 9000, "CR");
    await seedPlayer(2, "chapin", 12000, "GT");
    await seedPlayer(3, "hue", 15000, "BR");

    const region = await getRegionRankingsSnapshot(db, "R-CAMERICA", { page: 1, pageSize: 50 });
    expect(region.total).toBe(2);
    expect(region.ranking.map((entry) => entry.user.username)).toEqual(["chapin", "tico"]);
    // Renumbered within the region: chapin is #2 globally but #1 here.
    expect(region.ranking.map((entry) => entry.rank)).toEqual([1, 2]);

    const continent = await getRegionRankingsSnapshot(db, "R-AMERICAS", { page: 1, pageSize: 50 });
    expect(continent.total).toBe(3);
    expect(continent.ranking.map((entry) => entry.user.username)).toEqual(["hue", "chapin", "tico"]);

    const global = await getGlobalRankingsSnapshot(db, { page: 1, pageSize: 50 });
    expect(global.total).toBe(3);
    expect(global.ranking[0].user.username).toBe("hue");
  });

  it("replays event-log entries for a region's member countries plus site-wide events", async () => {
    const events = new LiveEventLog(db);
    await events.append("test_event", "CR", { n: 1 });
    await events.append("test_event", "MX", { n: 2 });
    await events.append("test_event", "BR", { n: 3 });
    await events.append("test_event", null, { n: 4 });

    const region = await events.replay(["CR", "MX"], 0);
    expect(region.map((event) => event.country).sort()).toEqual(["CR", "MX", null].sort());
    expect(await events.replay(null, 0)).toHaveLength(4);
    expect((await events.replay("CR", 0)).map((event) => event.country).sort()).toEqual(["CR", null].sort());
  });
});
