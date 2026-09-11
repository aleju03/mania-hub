import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { analyzeVibroSections } from "../src/dan/vibro-sections.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { PLAYER_SKILLS_VERSION, computePlaySsrValues, type StoredPlaySsr } from "../src/features/player-skills.js";
import {
  UNRATED_PLAYS_SWEEP_META_KEY,
  collectUnratedCandidates,
  computeUnratedPlayPp,
  fillRawSsrTargets,
  getPlayerUnratedPlays,
  getUnratedPlaysBoard,
  goalToBp,
  readRawSsrValues,
  refreshUnratedPlaysForUser,
  resetUnratedPlaysBoardCache,
  runUnratedPlaysSweepChunk,
  runUnratedPlaysSweepJob,
  selectBoardRows,
} from "../src/features/unrated-plays.js";
import { JobQueue } from "../src/jobs/queue.js";

const NOW = "2026-09-09T00:00:00.000Z";
const GOAL = 0.93;

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-unrated-plays-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

/**
 * A 4K rice chart whose middle burst is a single-column wall: enough of one to
 * be detected, small enough that the section policy trims it rather than
 * throwing the whole chart out, which is the only case where rating with and
 * without the adjustment can disagree.
 */
function localizedVibroChart(): string {
  const rows: string[] = [];
  const x = (column: number) => Math.floor(((column + 0.5) * 512) / 4);
  let time = 1000;
  const stream = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      rows.push(`${x(index % 4)},192,${time},1,0,0:0:0:0:`);
      time += 125;
    }
  };
  stream(400);
  for (let index = 0; index < 120; index += 1) {
    rows.push(`${x(0)},192,${time},1,0,0:0:0:0:`);
    if (index % 8 === 0) rows.push(`${x(2)},192,${time},1,0,0:0:0:0:`);
    time += 60;
  }
  stream(400);
  return [
    "osu file format v14", "", "[General]", "AudioFilename: audio.mp3", "Mode: 3", "",
    "[Metadata]", "Title: slop", "Artist: t", "Creator: m", "Version: 4K", "",
    "[Difficulty]", "CircleSize:4", "OverallDifficulty:8", "",
    "[TimingPoints]", "0,500,4,2,0,100,1,0", "",
    "[HitObjects]", ...rows, "",
  ].join("\n");
}

async function seedChart(db: Db, beatmapId: number, classification: Record<string, unknown> = { vibro: true, lnRatio: 0 }): Promise<void> {
  await storeCachedBeatmapFile(db, beatmapId, localizedVibroChart(), { source: "test" });
  await exec(db, `insert into beatmap_chart_analysis
    (beatmap_id, analysis_version, status, key_count, classification_json, computed_at, updated_at)
    values (?, ?, 'ready', 4, ?, ?, ?)`,
  [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify(classification), NOW, NOW]);
}

const STATISTICS = { perfect: 700, great: 200, good: 10, ok: 5, meh: 3, miss: 2 };

function play(overrides: Partial<StoredPlaySsr> & Record<string, unknown> = {}): StoredPlaySsr {
  return {
    identity: "official:1", beatmapId: 101, keyCount: 4, rate: 1, goal: GOAL, pp: 0, values: {}, patterns: [],
    accuracy: 0.98, endedAt: "2026-09-08T12:00:00Z", mods: [],
    score: { statistics: STATISTICS, maxCombo: 900, totalScore: 900_000, rank: "S", scoreUrl: null },
    ...overrides,
  };
}

async function seedPlayer(db: Db, userId: number, plays: unknown, vibroExcluded: unknown = [], danOnly: unknown = []): Promise<void> {
  await exec(db, `insert into player_skill_ratings
    (user_id, analysis_version, status, modes_json, plays_json, updated_at)
    values (?, ?, 'ready', '{}', ?, ?)`,
  [userId, PLAYER_SKILLS_VERSION, JSON.stringify({ plays, danOnly, vibroExcluded }), NOW]);
  await exec(db, `insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, '', ?, ?)`,
    [userId, `player${userId}`, userId % 2 === 0 ? "CR" : "US", NOW]);
}

describe("unrated plays candidates", () => {
  it("lists the vibro rejections and the plays on ineligible charts, and nothing the ratings kept", () => {
    const candidates = collectUnratedCandidates({
      plays: [
        play({ identity: "clean", beatmapId: 1 }),
        play({ identity: "stacked", beatmapId: 2, values: { Overall: 12 } }),
        play({ identity: "floor", beatmapId: 2, rate: 1.5, ratingExcluded: true }),
      ],
      danOnly: [play({ identity: "stacked-dan-only", beatmapId: 2, rate: 0.75, values: { Overall: 8 } })],
      vibroExcluded: [
        { play: play({ identity: "wall", beatmapId: 3 }), reason: "chart_vibro", checkedVersion: 1 },
        { play: play({ identity: "fast", beatmapId: 4, rate: 1.5 }), reason: "rate_vibro", checkedVersion: 1 },
      ],
    }, (beatmapId) => beatmapId === 2);
    expect(candidates.map((candidate) => [candidate.play.identity, candidate.reason, candidate.rawSsr]).sort()).toEqual([
      ["fast", "rate_vibro", true],
      ["stacked", "chart_ineligible", false],
      ["stacked-dan-only", "chart_ineligible", false],
      ["wall", "chart_vibro", true],
    ]);
  });

  it("keeps one play per slot, the more accurate one, and the Invert variant apart", () => {
    const candidates = collectUnratedCandidates({
      plays: [],
      vibroExcluded: [
        { play: play({ identity: "worse", accuracy: 0.95 }), reason: "chart_vibro", checkedVersion: 1 },
        { play: play({ identity: "better", accuracy: 0.99 }), reason: "chart_vibro", checkedVersion: 1 },
        { play: play({ identity: "inverted", inverse: true }), reason: "chart_vibro", checkedVersion: 1 },
      ],
    }, () => false);
    expect(candidates.map((candidate) => candidate.play.identity).sort()).toEqual(["better", "inverted"]);
  });

  it("drops plays the calc could never rate", () => {
    const candidates = collectUnratedCandidates({
      plays: [],
      vibroExcluded: [
        { play: play({ beatmapId: 0 }), reason: "chart_vibro", checkedVersion: 1 },
        { play: play({ rate: 0 }), reason: "chart_vibro", checkedVersion: 1 },
      ],
    }, () => false);
    expect(candidates).toEqual([]);
  });
});

describe("unrated play pp", () => {
  it("prices a play from the chart's star rating and its own judgement counts", () => {
    const pp = computeUnratedPlayPp(localizedVibroChart(), play(), STATISTICS);
    expect(pp).not.toBeNull();
    expect(pp!).toBeGreaterThan(0);
    // Faster is harder, and NF pays three quarters.
    expect(computeUnratedPlayPp(localizedVibroChart(), play({ rate: 1.5 }), STATISTICS)!).toBeGreaterThan(pp!);
    expect(computeUnratedPlayPp(localizedVibroChart(), play({ mods: ["NF"] }), STATISTICS)!).toBeCloseTo(pp! * 0.75, 1);
  });

  it("refuses to guess without counts or on a keymode the file does not rate", () => {
    expect(computeUnratedPlayPp(localizedVibroChart(), play(), null)).toBeNull();
    expect(computeUnratedPlayPp(localizedVibroChart(), play({ keyCount: 7 }), STATISTICS)).toBeNull();
  });
});

describe("raw SSR cache", () => {
  it("rates the whole chart, walls included, and serves the second pull from the cache", async () => {
    const db = await makeDb();
    await seedChart(db, 101);
    // The fixture has to be the trimmed case for the two ratings to differ.
    expect(analyzeVibroSections(parseManiaBeatmap(localizedVibroChart())).status).toBe("adjusted");
    const target = { slot: "101:1", goalBp: goalToBp(GOAL), beatmapId: 101, rate: 1, inverse: false, keyCount: 4 };
    const filled = await fillRawSsrTargets(db, [target]);
    expect(filled).toMatchObject({ computed: 1, cached: 0, deferred: 0, unavailable: 0 });
    expect(filled.calcRuns).toBeGreaterThan(0);
    const raw = await readRawSsrValues(db, "101:1", goalToBp(GOAL));
    const adjusted = await computePlaySsrValues(localizedVibroChart(), { rate: 1, keyCount: 4, goal: GOAL, adjustVibro: true });
    expect(raw?.Overall).toBeGreaterThan((adjusted?.values.Overall ?? 0) * 2);
    expect(await fillRawSsrTargets(db, [target])).toMatchObject({ computed: 0, cached: 1 });
  }, 60_000);

  it("defers what the budget cannot reach and leaves uncached charts for a later run", async () => {
    const db = await makeDb();
    await seedChart(db, 101);
    const targets = [
      { slot: "101:1", goalBp: goalToBp(GOAL), beatmapId: 101, rate: 1, inverse: false, keyCount: 4 },
      { slot: "202:1", goalBp: goalToBp(GOAL), beatmapId: 202, rate: 1, inverse: false, keyCount: 4 },
    ];
    expect(await fillRawSsrTargets(db, targets, { maxCalcRuns: 0 })).toMatchObject({ computed: 0, deferred: 2 });
    expect(await fillRawSsrTargets(db, targets)).toMatchObject({ computed: 1, unavailable: 1 });
  }, 60_000);
});

describe("refreshing one player", () => {
  it("writes a row per play with pp, the every-note MSD and the chart's dan, and clears them when the pool empties", async () => {
    const db = await makeDb();
    await seedChart(db, 101);
    await seedChart(db, 202, { vibro: false, lnRatio: 0, danEligibility: { eligible: false }, rc: { rawDan: 5, displayName: "5" } });
    await seedPlayer(db, 7,
      [play({ identity: "official:2", beatmapId: 202, values: { Overall: 12.5, Stream: 11 } }), play({ identity: "official:3", beatmapId: 303 })],
      [{ play: play({ identity: "official:1", beatmapId: 101, rate: 1.5, mods: ["DT"] }), reason: "rate_vibro", checkedVersion: 1 }]);

    const result = await refreshUnratedPlaysForUser(db, 7);
    expect(result).toMatchObject({ rows: 2, computed: 1, deferred: 0 });
    const rows = (await exec(db, "select slot, reason, pp, msd, dan, dan_label from unrated_plays where user_id = 7 order by slot")).rows;
    expect(rows.map((row) => [row.slot, row.reason])).toEqual([["101:1.5", "rate_vibro"], ["202:1", "chart_ineligible"]]);
    const vibro = rows[0];
    const stacked = rows[1];
    expect(Number(vibro.pp)).toBeGreaterThan(0);
    expect(Number(vibro.msd)).toBeGreaterThan(0);
    expect(Number(stacked.msd)).toBe(12.5);
    expect(Number(stacked.dan)).toBeGreaterThan(0);
    expect(stacked.dan_label).toBe("5");

    await exec(db, "update player_skill_ratings set plays_json = ? where user_id = 7", [JSON.stringify({ plays: [play({ beatmapId: 303 })], vibroExcluded: [] })]);
    expect(await refreshUnratedPlaysForUser(db, 7)).toMatchObject({ rows: 0 });
    expect((await exec(db, "select count(*) as n from unrated_plays where user_id = 7")).rows[0].n).toBe(0);
  }, 60_000);

  it("stores a rejected play without an MSD when the budget cannot rate it, and fills it next time", async () => {
    const db = await makeDb();
    await seedChart(db, 101);
    await seedPlayer(db, 8, [], [{ play: play({ identity: "official:1" }), reason: "chart_vibro", checkedVersion: 1 }]);
    expect(await refreshUnratedPlaysForUser(db, 8, { maxCalcRuns: 0 })).toMatchObject({ rows: 1, deferred: 1 });
    expect((await exec(db, "select msd, pp from unrated_plays where user_id = 8")).rows[0]).toMatchObject({ msd: null });
    expect(await refreshUnratedPlaysForUser(db, 8)).toMatchObject({ rows: 1, computed: 1, deferred: 0 });
    expect(Number((await exec(db, "select msd from unrated_plays where user_id = 8")).rows[0].msd)).toBeGreaterThan(0);
  }, 60_000);
});

describe("the board", () => {
  it("keeps one row per player and chart, chosen by the number being sorted on", () => {
    const rows = [
      { user: { id: 1 }, beatmapId: 5, accuracy: 0.99, playedAtMs: 1, pp: 100, msd: 20 },
      { user: { id: 1 }, beatmapId: 5, accuracy: 0.95, playedAtMs: 2, pp: 80, msd: 25 },
      { user: { id: 2 }, beatmapId: 5, accuracy: 0.97, playedAtMs: 3, pp: 90, msd: null },
    ];
    expect(selectBoardRows(rows, (row) => row.pp).map((row) => [row.user.id, row.pp])).toEqual([[1, 100], [2, 90]]);
    expect(selectBoardRows(rows, (row) => row.msd).map((row) => [row.user.id, row.msd])).toEqual([[1, 25]]);
  });

  it("scopes by country, keymode and week, and pages the ranking", async () => {
    const db = await makeDb();
    await seedChart(db, 202, { vibro: false, lnRatio: 0, danEligibility: { eligible: false } });
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await seedPlayer(db, 2, [play({ identity: "official:20", beatmapId: 202, values: { Overall: 15 }, endedAt: recent })]);
    await seedPlayer(db, 3, [play({ identity: "official:30", beatmapId: 202, values: { Overall: 18 }, accuracy: 0.9, endedAt: "2026-08-01T00:00:00Z" })]);
    await seedPlayer(db, 4, [play({ identity: "official:40", beatmapId: 202, rate: 1.5, values: { Overall: 21 }, endedAt: recent })]);
    for (const userId of [2, 3, 4]) await refreshUnratedPlaysForUser(db, userId);

    resetUnratedPlaysBoardCache(db);
    const global = await getUnratedPlaysBoard(db, { country: "GLOBAL", keyCount: 4, sort: "msd" });
    expect(global.ranking.map((entry) => [entry.user.id, entry.msd])).toEqual([[4, 21], [3, 18], [2, 15]]);
    expect(global.keyCounts).toEqual([4]);
    expect(global.ranking[0]).toMatchObject({ rank: 1, beatmapId: 202, rate: 1.5, rateMod: "DT", reason: "chart_ineligible", title: "Unknown map" });

    const cr = await getUnratedPlaysBoard(db, { country: "CR", keyCount: 4, sort: "msd" });
    expect(cr.ranking.map((entry) => entry.user.id)).toEqual([4, 2]);

    const week = await getUnratedPlaysBoard(db, { country: "GLOBAL", keyCount: 4, sort: "msd", range: "week" });
    expect(week.ranking.map((entry) => entry.user.id)).toEqual([4, 2]);

    const paged = await getUnratedPlaysBoard(db, { country: "GLOBAL", keyCount: 4, sort: "msd", page: 2, pageSize: 2 });
    expect(paged.total).toBe(3);
    expect(paged.ranking.map((entry) => entry.rank)).toEqual([3]);

    expect((await getUnratedPlaysBoard(db, { country: "GLOBAL", keyCount: 7, sort: "msd" })).ranking).toEqual([]);
    const mixed = await getUnratedPlaysBoard(db, { country: "GLOBAL", keyCount: null, sort: "msd" });
    expect(mixed.keyCount).toBeNull();
    expect(mixed.ranking.map((entry) => entry.user.id)).toEqual([4, 3, 2]);
  }, 60_000);

  it("lists one player's rows in the asked order, unpriced rows last", async () => {
    const db = await makeDb();
    await seedChart(db, 202, { vibro: false, lnRatio: 0, danEligibility: { eligible: false } });
    await seedPlayer(db, 6, [
      play({ identity: "official:60", beatmapId: 202, values: { Overall: 15 }, endedAt: "2026-09-01T00:00:00Z" }),
      play({ identity: "official:61", beatmapId: 202, rate: 1.5, values: { Overall: 21 }, endedAt: "2026-08-01T00:00:00Z", score: null }),
    ]);
    await refreshUnratedPlaysForUser(db, 6);
    const byMsd = await getPlayerUnratedPlays(db, 6, 4, { sort: "msd" });
    expect(byMsd.total).toBe(2);
    expect(byMsd.keyCounts).toEqual([4]);
    expect(byMsd.items.map((item) => [item.play.rate, item.msd, item.play.rating])).toEqual([[1.5, 21, 21], [1, 15, 15]]);
    // The DT play has no counts, so no pp: it drops to the bottom of the pp order.
    const byPp = await getPlayerUnratedPlays(db, 6, 4, { sort: "pp" });
    expect(byPp.items.map((item) => item.play.rate)).toEqual([1, 1.5]);
    expect(byPp.items[0].pp).toBeGreaterThan(0);
    expect(byPp.items[0].play.pp).toBe(byPp.items[0].pp);
    expect(byPp.items[1].pp).toBeNull();
    const recent = await getPlayerUnratedPlays(db, 6, 4, { sort: "recent" });
    expect(recent.items.map((item) => item.play.rate)).toEqual([1, 1.5]);
  }, 60_000);
});

describe("the boot sweep", () => {
  it("walks the players with something to list and skips the rest", async () => {
    const db = await makeDb();
    await seedChart(db, 101);
    await seedChart(db, 202, { vibro: false, lnRatio: 0, danEligibility: { eligible: false } });
    await seedPlayer(db, 1, [play({ beatmapId: 303 })]);
    await seedPlayer(db, 2, [play({ identity: "official:20", beatmapId: 202, values: { Overall: 10 } })]);
    await seedPlayer(db, 3, [], [{ play: play({ identity: "official:30", beatmapId: 101 }), reason: "chart_vibro", checkedVersion: 1 }]);
    const chunk = await runUnratedPlaysSweepChunk(db, 0);
    expect(chunk).toMatchObject({ players: 2, rows: 2, computed: 1, deferred: 0, done: true, nextCursor: 3 });
    expect((await exec(db, "select count(*) as n from unrated_plays")).rows[0].n).toBe(2);
  }, 60_000);

  it("holds its cursor while the calc budget leaves a page half-rated, then marks itself done", async () => {
    const db = await makeDb();
    const queue = new JobQueue(db);
    await seedChart(db, 101);
    await seedChart(db, 102);
    await seedPlayer(db, 3, [], [
      { play: play({ identity: "official:30", beatmapId: 101 }), reason: "chart_vibro", checkedVersion: 1 },
      { play: play({ identity: "official:31", beatmapId: 102 }), reason: "chart_vibro", checkedVersion: 1 },
    ]);
    const held = await runUnratedPlaysSweepChunk(db, 0, 200, { maxCalcRuns: 1 });
    expect(held.deferred).toBe(1);
    expect(held.computed).toBe(1);

    await runUnratedPlaysSweepJob(db, queue, { cursor: 0, revision: UNRATED_PLAYS_SWEEP_META_KEY });
    const done = (await exec(db, "select 1 from live_meta where key = ?", [UNRATED_PLAYS_SWEEP_META_KEY])).rows[0];
    expect(done).toBeTruthy();
    const msds = (await exec(db, "select msd from unrated_plays where user_id = 3")).rows.map((row) => Number(row.msd));
    expect(msds).toHaveLength(2);
    expect(msds.every((msd) => msd > 0)).toBe(true);
  }, 90_000);
});
