// The Skills tab plays explorer's server side: the list order, the two filters
// that have to run before the page is sliced, and the rejected-play reasons
// the dan list shows a block icon for.
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  comparePlayerSkillPlays,
  filterPlayerSkillPlays,
  isRankedBeatmapStatus,
  isPlayerSkillAxis,
  readBeatmapStatus,
  type DanClearReject,
  type StoredPlaySsr,
} from "../src/features/player-skills.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-plays-explorer-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function play(overrides: Partial<StoredPlaySsr> & { beatmapId: number }): StoredPlaySsr {
  return {
    identity: `official:${overrides.beatmapId}`,
    keyCount: 4,
    rate: 1,
    goal: 0.95,
    pp: 100,
    values: { Overall: 26 },
    patterns: [],
    accuracy: 0.97,
    stableAccuracy: 0.97,
    ...overrides,
  };
}

describe("readBeatmapStatus", () => {
  it("normalizes both spellings and rejects the rest", () => {
    expect(readBeatmapStatus("Ranked")).toBe("ranked");
    expect(readBeatmapStatus(" LOVED ")).toBe("loved");
    expect(readBeatmapStatus(1)).toBe("ranked");
    expect(readBeatmapStatus(-2)).toBe("graveyard");
    expect(readBeatmapStatus(null)).toBeNull();
    expect(readBeatmapStatus("")).toBeNull();
    expect(readBeatmapStatus(99)).toBeNull();
  });

  it("counts only the leaderboard statuses as ranked, so loved charts survive the filter", () => {
    // The dan tables live in loved, so folding it in would empty the dan list
    // the moment a reader hid ranked maps.
    expect(isRankedBeatmapStatus("ranked")).toBe(true);
    expect(isRankedBeatmapStatus("approved")).toBe(true);
    expect(isRankedBeatmapStatus("qualified")).toBe(true);
    expect(isRankedBeatmapStatus("loved")).toBe(false);
    expect(isRankedBeatmapStatus("graveyard")).toBe(false);
    expect(isRankedBeatmapStatus(null)).toBe(false);
  });
});

describe("comparePlayerSkillPlays", () => {
  const entries = [
    { play: play({ beatmapId: 1, endedAt: "2026-01-01T00:00:00Z" }), rating: 20 },
    { play: play({ beatmapId: 2, endedAt: "2026-06-01T00:00:00Z" }), rating: 30 },
    { play: play({ beatmapId: 3, endedAt: null }), rating: 25 },
  ];

  it("ranks by rating first by default", () => {
    expect([...entries].sort(comparePlayerSkillPlays("rating")).map((entry) => entry.play.beatmapId))
      .toEqual([2, 3, 1]);
  });

  it("ranks by when the play was set on a recent read", () => {
    expect([...entries].sort(comparePlayerSkillPlays("recent")).map((entry) => entry.play.beatmapId))
      .toEqual([2, 1, 3]);
  });

  it("sorts a play with no timestamp last rather than first", () => {
    // An empty string compares above every real ISO instant, so the untimed
    // play would otherwise lead a list that is meant to be newest-first.
    const sorted = [...entries].sort(comparePlayerSkillPlays("recent"));
    expect(sorted[sorted.length - 1].play.beatmapId).toBe(3);
  });
});

describe("filterPlayerSkillPlays", () => {
  const rates = [
    { play: play({ beatmapId: 10, rate: 1.5 }), rating: 30 },
    { play: play({ beatmapId: 10, rate: 1.3 }), rating: 28 },
    { play: play({ beatmapId: 10, rate: 1 }), rating: 24 },
    { play: play({ beatmapId: 11, rate: 1 }), rating: 22 },
  ];

  it("passes the list straight through when neither filter is on", () => {
    expect(filterPlayerSkillPlays(rates)).toBe(rates);
  });

  it("keeps at most n plays of one chart, in the order it was given", () => {
    const capped = filterPlayerSkillPlays(rates, { maxPerChart: 2 });
    expect(capped.map((entry) => entry.play.rate)).toEqual([1.5, 1.3, 1]);
    // The cap is per chart, so the second map keeps its only play.
    expect(capped.filter((entry) => entry.play.beatmapId === 11)).toHaveLength(1);
  });

  it("caps against whatever the active order put on top", () => {
    const byRecency = [...rates].reverse();
    expect(filterPlayerSkillPlays(byRecency, { maxPerChart: 1 }).map((entry) => entry.play.rate))
      .toEqual([1, 1]);
  });

  it("drops ranked charts and keeps loved, graveyard and unknown ones", () => {
    const mixed = [
      { play: play({ beatmapId: 20 }), rating: 30 },
      { play: play({ beatmapId: 21 }), rating: 29 },
      { play: play({ beatmapId: 22 }), rating: 28 },
      { play: play({ beatmapId: 23 }), rating: 27 },
    ];
    const statuses = new Map<number, string | null>([
      [20, "ranked"],
      [21, "loved"],
      [22, "graveyard"],
      // 23 is absent: a chart the catalog has never stored a row for.
    ]);
    expect(filterPlayerSkillPlays(mixed, { statuses }).map((entry) => entry.play.beatmapId))
      .toEqual([21, 22, 23]);
  });

  it("applies both filters together", () => {
    const statuses = new Map<number, string | null>([[11, "ranked"]]);
    expect(filterPlayerSkillPlays(rates, { statuses, maxPerChart: 1 }).map((entry) => entry.play.beatmapId))
      .toEqual([10]);
  });
});

describe("isPlayerSkillAxis", () => {
  it("accepts Overall, so the explorer can rank a whole keymode", () => {
    expect(isPlayerSkillAxis("Overall")).toBe(true);
    expect(isPlayerSkillAxis("Technical")).toBe(true);
    expect(isPlayerSkillAxis("pattern:jack")).toBe(true);
    expect(isPlayerSkillAxis("nonsense")).toBe(false);
  });
});

// --- Dan rejections: the block-icon rows ----------------------------------

describe("collectDanClears rejections", () => {
  it("names the rule that turned each rated play away, and stays silent without a sink", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const { collectDanClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const now = new Date().toISOString();
      const insertBeatmap = "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at) values (?, ?, 'mania', 'x', ?, ?)";
      const analyze = (beatmapId: number, classification: Record<string, unknown>) => exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (?, ?, 'ready', ?, ?)`,
        [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify(classification), now],
      );

      // One chart per rule, all rated, all cleared by the same player.
      await exec(db, insertBeatmap, [301, 1, JSON.stringify({ accuracy: 8 }), now]);
      await analyze(301, { lnRatio: 0, patterns: [], rc: { rawDan: 11 } });
      await exec(db, insertBeatmap, [302, 1, JSON.stringify({ accuracy: 5.4 }), now]);
      await analyze(302, { lnRatio: 0, patterns: [], rc: { rawDan: 11 } });
      await exec(db, insertBeatmap, [303, 1, JSON.stringify({ accuracy: 8 }), now]);
      await analyze(303, { lnRatio: 0, patterns: [], rc: { rawDan: 11 }, danEligibility: { eligible: false, reason: "stacked_same_column_heads" } });
      await exec(db, insertBeatmap, [304, 1, JSON.stringify({ accuracy: 8 }), now]);
      // Analyzed, but the chart carries no rice dan at all.
      await analyze(304, { lnRatio: 0, patterns: [] });

      const info = await loadChartSkillInfo(db, [301, 302, 303, 304]);
      const plays = [
        // Clears the bar on an ordinary chart.
        play({ beatmapId: 301, accuracy: 0.97, stableAccuracy: 0.97 }),
        // Same chart, far under the bar.
        play({ beatmapId: 301, identity: "official:301b", accuracy: 0.5, stableAccuracy: 0.5 }),
        // OD 5.4 is under the floor.
        play({ beatmapId: 302, accuracy: 0.97, stableAccuracy: 0.97 }),
        // Structurally ineligible chart.
        play({ beatmapId: 303, accuracy: 0.999, stableAccuracy: 0.999 }),
        // No dan on the chart at this rate.
        play({ beatmapId: 304, accuracy: 0.97, stableAccuracy: 0.97 }),
        // EZ widened the windows.
        play({ beatmapId: 301, identity: "official:301c", accuracy: 0.99, stableAccuracy: 0.99, ezWindows: true }),
        // No judgement counts left to measure.
        play({ beatmapId: 301, identity: "official:301d", accuracy: undefined, stableAccuracy: null }),
        // Never analyzed at all.
        play({ beatmapId: 999, accuracy: 0.97, stableAccuracy: 0.97 }),
      ];

      const rejects: DanClearReject[] = [];
      const clears = collectDanClearsForTest(4, plays, info, new Map(), rejects);
      expect(clears).toHaveLength(1);
      expect(clears[0].play.identity).toBe("official:301");

      expect(rejects.map((entry) => entry.reason).sort()).toEqual([
        "below_bar",
        "chart_ineligible",
        "chart_unanalyzed",
        "ez_windows",
        "low_od",
        "no_accuracy",
        "no_chart_dan",
      ]);
      // A rejected play still names what it was aiming at, which is most of
      // what makes the row readable; the OD reject carries the number too.
      expect(rejects.find((entry) => entry.reason === "below_bar")?.chartDan).toBe(11);
      expect(rejects.find((entry) => entry.reason === "low_od")?.od).toBe(5.4);
      expect(rejects.find((entry) => entry.reason === "chart_unanalyzed")?.chartDan).toBeNull();

      // Without the sink the clears are byte-identical and nothing is
      // collected: the verdict compute must not pay for the explanation.
      const quiet = collectDanClearsForTest(4, plays, info);
      expect(quiet).toEqual(clears);
    });
  });

  it("lets 7K LN clear at OD 5, the OD the official JinJin courses are set at", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const { collectDanClearsForTest, loadChartSkillInfo } = await import("../src/features/player-skills.js");
      const now = new Date().toISOString();
      const insertBeatmap = "insert into beatmaps (beatmap_id, beatmapset_id, mode, version, metadata_json, updated_at) values (?, ?, 'mania', 'x', ?, ?)";
      const analyze = (beatmapId: number, classification: Record<string, unknown>) => exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
         values (?, ?, 'ready', ?, ?)`,
        [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify(classification), now],
      );

      // An LN chart at the course OD, the same chart a hair under it, and a
      // rice chart at the course OD: only 7K LN gets the lower floor.
      await exec(db, insertBeatmap, [311, 1, JSON.stringify({ accuracy: 5 }), now]);
      await analyze(311, { lnRatio: 0.6, patterns: [], ln: { rawDan: 11 } });
      await exec(db, insertBeatmap, [312, 1, JSON.stringify({ accuracy: 4.9 }), now]);
      await analyze(312, { lnRatio: 0.6, patterns: [], ln: { rawDan: 11 } });
      await exec(db, insertBeatmap, [313, 1, JSON.stringify({ accuracy: 5 }), now]);
      await analyze(313, { lnRatio: 0, patterns: [], rc: { rawDan: 11 } });

      const info = await loadChartSkillInfo(db, [311, 312, 313]);
      const plays = [
        play({ beatmapId: 311, keyCount: 7, accuracy: 0.96, stableAccuracy: 0.96 }),
        play({ beatmapId: 312, keyCount: 7, accuracy: 0.96, stableAccuracy: 0.96 }),
        play({ beatmapId: 313, keyCount: 7, accuracy: 0.97, stableAccuracy: 0.97 }),
      ];

      const rejects: DanClearReject[] = [];
      const clears = collectDanClearsForTest(7, plays, info, new Map(), rejects);
      expect(clears.map((clear) => clear.play.beatmapId)).toEqual([311]);
      expect(rejects.map((entry) => [entry.play.beatmapId, entry.reason])).toEqual([
        [312, "low_od"],
        [313, "low_od"],
      ]);

      // 4K LN keeps the 5.5 floor: only the 7K ladder has OD 5 courses.
      const fourKey = collectDanClearsForTest(4, [play({ beatmapId: 311, accuracy: 0.98, stableAccuracy: 0.98, scoreV2Accuracy: 0.98 })], info);
      expect(fourKey).toHaveLength(0);
    });
  });
});

// --- The read the MSD list makes -----------------------------------------

describe("getPlayerSkillPlays filters", () => {
  const storedPlays = [
    // One chart played at three rates, plus two others: a ranked one and a
    // loved one, so the ranked filter has something to keep and something to
    // drop that is not just "unranked".
    { identity: "official:1", beatmapId: 401, keyCount: 4, rate: 1.5, goal: 0.95, pp: 200, values: { Overall: 30 }, patterns: [], source: "top", accuracy: 0.97, endedAt: "2026-01-01T00:00:00Z" },
    { identity: "official:2", beatmapId: 401, keyCount: 4, rate: 1.3, goal: 0.95, pp: 190, values: { Overall: 28 }, patterns: [], source: "top", accuracy: 0.97, endedAt: "2026-02-01T00:00:00Z" },
    { identity: "official:3", beatmapId: 401, keyCount: 4, rate: 1, goal: 0.95, pp: 180, values: { Overall: 26 }, patterns: [], source: "top", accuracy: 0.97, endedAt: "2026-03-01T00:00:00Z" },
    { identity: "official:4", beatmapId: 402, keyCount: 4, rate: 1, goal: 0.95, pp: 170, values: { Overall: 24 }, patterns: [], source: "top", accuracy: 0.97, endedAt: "2026-04-01T00:00:00Z" },
    { identity: "official:5", beatmapId: 403, keyCount: 4, rate: 1, goal: 0.95, pp: 160, values: { Overall: 22 }, patterns: [], source: "top", accuracy: 0.97, endedAt: "2026-05-01T00:00:00Z" },
  ];

  async function seed(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
    const { PLAYER_SKILLS_VERSION } = await import("../src/features/player-skills.js");
    const now = new Date().toISOString();
    await exec(
      db,
      `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
       values (40, 'Explorer Song', 'Explorer Artist', 'Explorer Mapper', 'graveyard', '{}', '{}', ?)`,
      [now],
    );
    for (const [beatmapId, status] of [[401, "graveyard"], [402, "ranked"], [403, "loved"]] as const) {
      await exec(
        db,
        `insert into beatmaps
         (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
         values (?, 40, 'mania', ?, 4, 5, 180, 1000, 'x', null, '{}', ?)`,
        [beatmapId, status, now],
      );
    }
    await exec(
      db,
      `insert into player_skill_ratings
       (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
       values (77, ?, 'ready', '{}', ?, ?, ?)`,
      [PLAYER_SKILLS_VERSION, JSON.stringify({ version: PLAYER_SKILLS_VERSION, plays: storedPlays }), now, now],
    );
  }

  it("orders by rating by default and by recency on request", async () => {
    await withDb(async (db) => {
      const { getPlayerSkillPlays } = await import("../src/features/player-skills.js");
      await seed(db);
      const best = await getPlayerSkillPlays(db, 77, 4, "Overall");
      expect(best.items.map((item) => item.rating)).toEqual([30, 28, 26, 24, 22]);
      const recent = await getPlayerSkillPlays(db, 77, 4, "Overall", { sort: "recent" });
      expect(recent.items.map((item) => item.playedAt)).toEqual([
        "2026-05-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        "2026-03-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      ]);
    });
  });

  it("hides ranked charts and reports how many the filter took", async () => {
    await withDb(async (db) => {
      const { getPlayerSkillPlays } = await import("../src/features/player-skills.js");
      await seed(db);
      const page = await getPlayerSkillPlays(db, 77, 4, "Overall", { hideRanked: true });
      expect(page.items.map((item) => item.beatmapId)).toEqual([401, 401, 401, 403]);
      expect(page.total).toBe(4);
      // The loved chart survives; only the ranked one is gone.
      expect(page.unfilteredTotal).toBe(5);
      expect(page.items.every((item) => item.beatmapStatus !== "ranked")).toBe(true);
    });
  });

  it("labels a chart loved when only its metadata_json knows, and keeps a settled column over an in-flux JSON", async () => {
    await withDb(async (db) => {
      const { getPlayerSkillPlays } = await import("../src/features/player-skills.js");
      await seed(db);
      // 401: the column still says pending from first sight, the enrich job's JSON says loved.
      await exec(db, `update beatmaps set status = 'pending', metadata_json = '{"status":"loved"}' where beatmap_id = 401`);
      // 402: the farmed path moved the column to ranked while the JSON still says qualified.
      await exec(db, `update beatmaps set metadata_json = '{"status":"qualified"}' where beatmap_id = 402`);
      const page = await getPlayerSkillPlays(db, 77, 4, "Overall");
      const byId = new Map(page.items.map((item) => [item.beatmapId, item.beatmapStatus]));
      expect(byId.get(401)).toBe("loved");
      expect(byId.get(402)).toBe("ranked");
      expect(byId.get(403)).toBe("loved");
    });
  });

  it("caps the rates of one chart before the page is sliced, so no page comes back short", async () => {
    await withDb(async (db) => {
      const { getPlayerSkillPlays } = await import("../src/features/player-skills.js");
      await seed(db);
      const page = await getPlayerSkillPlays(db, 77, 4, "Overall", { maxPerChart: 2 });
      expect(page.total).toBe(4);
      expect(page.items.map((item) => item.beatmapId)).toEqual([401, 401, 402, 403]);
      // The cap keeps the best two rates on a rating list.
      expect(page.items.filter((item) => item.beatmapId === 401).map((item) => item.rate)).toEqual([1.5, 1.3]);

      // Paging over the filtered list, not the raw one: the second page is
      // the tail of what `total` counted.
      const second = await getPlayerSkillPlays(db, 77, 4, "Overall", { maxPerChart: 2, limit: 2, offset: 2 });
      expect(second.items.map((item) => item.beatmapId)).toEqual([402, 403]);
      expect(second.total).toBe(4);
    });
  });

  it("keeps the newest rates when the list is ordered by recency", async () => {
    await withDb(async (db) => {
      const { getPlayerSkillPlays } = await import("../src/features/player-skills.js");
      await seed(db);
      const page = await getPlayerSkillPlays(db, 77, 4, "Overall", { sort: "recent", maxPerChart: 1 });
      // 1.0x is the most recent of the three rates on 401, so it is the one
      // the cap keeps here - the opposite of the rating list above.
      expect(page.items.filter((item) => item.beatmapId === 401).map((item) => item.rate)).toEqual([1]);
      expect(page.total).toBe(3);
    });
  });

  it("bounds Best and Recent to their own 200-play osu-style cohorts", async () => {
    await withDb(async (db) => {
      const { PLAYER_SKILLS_VERSION, getPlayerSkillPlays } = await import("../src/features/player-skills.js");
      const now = new Date().toISOString();
      const plays = Array.from({ length: 205 }, (_, index) => {
        const beatmapId = index + 1;
        return {
          identity: `official:${beatmapId}`,
          beatmapId,
          keyCount: 4,
          rate: 1,
          goal: 0.95,
          pp: beatmapId,
          values: { Overall: beatmapId },
          patterns: [],
          source: "top",
          accuracy: 0.97,
          // Low ids are newest, deliberately opposite to their ratings.
          endedAt: new Date(Date.UTC(2026, 0, 1) + (206 - beatmapId) * 1_000).toISOString(),
        };
      });
      await exec(
        db,
        `insert into player_skill_ratings
         (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (99, ?, 'ready', '{}', ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify({ version: PLAYER_SKILLS_VERSION, plays }), now, now],
      );

      const best = await getPlayerSkillPlays(db, 99, 4, "Overall", { limit: 200 });
      expect(best.total).toBe(200);
      expect(best.unfilteredTotal).toBe(200);
      expect(best.items).toHaveLength(200);
      expect(best.items[0].beatmapId).toBe(205);
      expect(best.items.at(-1)?.beatmapId).toBe(6);

      const recent = await getPlayerSkillPlays(db, 99, 4, "Overall", { limit: 200, sort: "recent" });
      expect(recent.total).toBe(200);
      expect(recent.items).toHaveLength(200);
      expect(recent.items[0].beatmapId).toBe(1);
      expect(recent.items.at(-1)?.beatmapId).toBe(200);
    });
  });
});

// --- Which tile a play was read as --------------------------------------

describe("dan evidence skillset tiles", () => {
  it("names the tile on both a credited clear and a play that credited nothing", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const { PLAYER_SKILLS_VERSION, getPlayerSkillDanEvidence } = await import("../src/features/player-skills.js");
      const now = new Date().toISOString();
      await exec(
        db,
        `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
         values (50, 'Tile Song', 'Tile Artist', 'Tile Mapper', 'loved', '{}', '{}', ?)`,
        [now],
      );
      for (const beatmapId of [501, 502]) {
        await exec(
          db,
          `insert into beatmaps
           (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
           values (?, 50, 'mania', 'loved', 4, 5, 180, 1000, 'x', null, ?, ?)`,
          [beatmapId, JSON.stringify({ accuracy: 8 }), now],
        );
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [{ id: "jack", score: 1 }], rc: { rawDan: 11 } }), now],
        );
      }
      // Same chart shape twice: one pass over the bar, one far under it. The
      // tile comes off the play and its chart, not off the credit, so the
      // rejected row must name the same tile the credited one does.
      const plays = [
        { identity: "official:501", beatmapId: 501, keyCount: 4, rate: 1, goal: 0.95, pp: 100, values: { Overall: 26, JackSpeed: 26 }, patterns: ["jack"], source: "top", accuracy: 0.97, stableAccuracy: 0.97, endedAt: now },
        { identity: "official:502", beatmapId: 502, keyCount: 4, rate: 1, goal: 0.95, pp: 100, values: { Overall: 26, JackSpeed: 26 }, patterns: ["jack"], source: "top", accuracy: 0.5, stableAccuracy: 0.5, endedAt: now },
      ];
      await exec(
        db,
        `insert into player_skill_ratings
         (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (88, ?, 'ready', '{}', ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify({ version: PLAYER_SKILLS_VERSION, plays }), now, now],
      );

      const evidence = await getPlayerSkillDanEvidence(db, 88, 4, "rc", null, { includeRejected: true });
      expect(evidence).not.toBeNull();
      expect(evidence!.clears).toHaveLength(1);
      expect(evidence!.clears[0].skillsets).toContain("jack");
      // The turned-away play is filed the same way, so the row can say what it
      // would have counted toward.
      const rejected = evidence!.rejected ?? [];
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe("below_bar");
      expect(rejected[0].skillsets).toEqual(evidence!.clears[0].skillsets);

      // And the tiles a clear reports are the tiles it was actually grouped
      // under, not a second opinion computed for display.
      for (const id of evidence!.clears[0].skillsets) {
        expect(evidence!.skillsets.find((skillset) => skillset.id === id)?.clears).toBeGreaterThan(0);
      }
    });
  });

  it("pages recent clears by timestamp without changing the best-first dan calculation", async () => {
    await withDb(async (db) => {
      const { CHART_ANALYSIS_VERSION } = await import("../src/features/chart-analysis.js");
      const { PLAYER_SKILLS_VERSION, getPlayerSkillDanEvidence } = await import("../src/features/player-skills.js");
      const now = new Date().toISOString();
      await exec(
        db,
        `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
         values (60, 'Order Song', 'Order Artist', 'Order Mapper', 'loved', '{}', '{}', ?)`,
        [now],
      );
      for (const [beatmapId, rawDan] of [[601, 12], [602, 10]] as const) {
        await exec(
          db,
          `insert into beatmaps
           (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
           values (?, 60, 'mania', 'loved', 4, 5, 180, 1000, 'x', null, ?, ?)`,
          [beatmapId, JSON.stringify({ accuracy: 8 }), now],
        );
        await exec(
          db,
          `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, classification_json, updated_at)
           values (?, ?, 'ready', ?, ?)`,
          [beatmapId, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0, patterns: [], rc: { rawDan } }), now],
        );
      }
      const plays = [
        { identity: "official:601", beatmapId: 601, keyCount: 4, rate: 1, goal: 0.95, pp: 100, values: { Overall: 30 }, patterns: [], source: "top", accuracy: 0.97, stableAccuracy: 0.97, endedAt: "2026-01-01T00:00:00Z" },
        { identity: "official:602", beatmapId: 602, keyCount: 4, rate: 1, goal: 0.95, pp: 100, values: { Overall: 25 }, patterns: [], source: "top", accuracy: 0.97, stableAccuracy: 0.97, endedAt: "2026-08-01T00:00:00Z" },
      ];
      await exec(
        db,
        `insert into player_skill_ratings
         (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (100, ?, 'ready', '{}', ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify({ version: PLAYER_SKILLS_VERSION, plays }), now, now],
      );

      const best = await getPlayerSkillDanEvidence(db, 100, 4, "rc");
      const recent = await getPlayerSkillDanEvidence(db, 100, 4, "rc", null, { sort: "recent" });
      expect(best?.clears.map((entry) => entry.play.beatmapId)).toEqual([601, 602]);
      expect(recent?.clears.map((entry) => entry.play.beatmapId)).toEqual([602, 601]);
      expect(recent?.dan?.rawDan).toBe(best?.dan?.rawDan);
    });
  });
});
