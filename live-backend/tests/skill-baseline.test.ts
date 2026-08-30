import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, parseJson } from "../src/db.js";
import { JobQueue } from "../src/jobs/queue.js";
import { CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { PLAYER_SKILLS_VERSION, SKILL_RATING_SKILLSETS } from "../src/features/player-skills.js";
import {
  EXACT_SKILL_CURVES_META_KEY,
  SKILL_BASELINE_CURVES_META_KEY,
  SKILL_BASELINE_JOB,
  SKILL_BASELINE_VERSION,
  computeApproxRatings,
  decoratePlayerSkillBreakdown,
  enqueueSkillBaselineIfDue,
  readExactSkillCurves,
  runSkillBaselineJob,
  type BaselineChartEntry,
  type BaselineCurves,
  type ExactSkillCurves,
} from "../src/features/skill-baseline.js";

async function withDb(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-baseline-"));
  try {
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    await run(db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function chartEntry(overrides: Partial<BaselineChartEntry> & { msdValues?: Record<string, number>; dtValues?: Record<string, number> }): BaselineChartEntry {
  const msd = new Float64Array(SKILL_RATING_SKILLSETS.length);
  for (let i = 0; i < SKILL_RATING_SKILLSETS.length; i += 1) {
    msd[i] = overrides.msdValues?.[SKILL_RATING_SKILLSETS[i]] ?? 0;
  }
  let dtMsd: Float64Array | null = null;
  if (overrides.dtValues) {
    dtMsd = new Float64Array(SKILL_RATING_SKILLSETS.length);
    for (let i = 0; i < SKILL_RATING_SKILLSETS.length; i += 1) {
      dtMsd[i] = overrides.dtValues[SKILL_RATING_SKILLSETS[i]] ?? 0;
    }
  }
  return {
    keyCount: overrides.keyCount ?? 4,
    msd,
    dtMsd,
    lnRatio: overrides.lnRatio ?? 0,
    od: overrides.od ?? null,
    patterns: overrides.patterns ?? [],
  };
}

const NEUTRAL_PARAMS = { gamma: Object.fromEntries(SKILL_RATING_SKILLSETS.map((axis) => [axis, 1])), accSlope: 1.09 };

describe("computeApproxRatings", () => {
  it("aggregates per-keymode axes plus pattern axes from chart tags", () => {
    const charts = new Map([[1, chartEntry({ msdValues: { Overall: 20, Stream: 18 }, patterns: ["stream"] })]]);
    const plays = [1, 2, 3].map(() => ({ beatmapId: 1, rate: 1, goal: 0.93, patterns: ["stream"] }));
    const result = computeApproxRatings(plays, charts, NEUTRAL_PARAMS);
    const mode = result.get(4)!;
    expect(mode.analyzedPlays).toBe(3);
    // At the 0.93 anchor goal the approximate SSR is the chart's MSD itself;
    // three stacked plays aggregate close to (but under) it.
    expect(mode.ratings.Overall).toBeGreaterThan(10);
    expect(mode.ratings.Overall).toBeLessThan(20);
    expect(mode.ratings.Stream).toBeGreaterThan(0);
    expect(mode.ratings["pattern:stream"]).toBeGreaterThan(0);
    expect(mode.ratings.Chordjack).toBeUndefined();
  });

  it("prefers the exact DT ratio over the power law and derates by goal", () => {
    const powerLawOnly = new Map([[1, chartEntry({ msdValues: { Overall: 20 } })]]);
    const withDtMsd = new Map([[1, chartEntry({ msdValues: { Overall: 20 }, dtValues: { Overall: 24 } })]]);
    const dtPlay = [{ beatmapId: 1, rate: 1.5, goal: 0.93, patterns: [] }];
    // gamma 1 puts the power law at 20 * 1.5 = 30; the stored DT pair says 24.
    const lawRating = computeApproxRatings(dtPlay, powerLawOnly, NEUTRAL_PARAMS).get(4)!.ratings.Overall;
    const exactRating = computeApproxRatings(dtPlay, withDtMsd, NEUTRAL_PARAMS).get(4)!.ratings.Overall;
    expect(exactRating).toBeLessThan(lawRating);

    const lowGoal = computeApproxRatings([{ beatmapId: 1, rate: 1, goal: 0.895, patterns: [] }], powerLawOnly, NEUTRAL_PARAMS).get(4)!;
    const highGoal = computeApproxRatings([{ beatmapId: 1, rate: 1, goal: 0.965, patterns: [] }], powerLawOnly, NEUTRAL_PARAMS).get(4)!;
    expect(lowGoal.ratings.Overall).toBeLessThan(highGoal.ratings.Overall);
  });
});

describe("skill baseline job", () => {
  it("builds per-user approximate ratings, quantile curves, and percentiles", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      const now = new Date().toISOString();
      await exec(
        db,
        `insert into beatmap_chart_analysis (beatmap_id, analysis_version, status, key_count, msd_json, classification_json, updated_at)
         values (500, ?, 'ready', 4, ?, ?, ?)`,
        [
          CHART_ANALYSIS_VERSION,
          JSON.stringify({ values: { Overall: 20, Stream: 18, Jumpstream: 10, Handstream: 8, Stamina: 15, JackSpeed: 9, Chordjack: 7, Technical: 12 } }),
          JSON.stringify({ lnRatio: 0, patterns: [{ id: "stream", score: 0.9 }] }),
          now,
        ],
      );
      // 25 users x 20 plays on the analyzed chart, with a per-user MAX:300
      // ratio gradient so the approximate ratings spread into a real curve.
      for (let user = 0; user < 25; user += 1) {
        const userId = 1000 + user;
        for (let scoreId = 0; scoreId < 20; scoreId += 1) {
          const perfect = 300 + user * 15;
          const score = {
            id: userId * 100 + scoreId,
            user_id: userId,
            beatmap_id: 500,
            accuracy: 0.98,
            mods: [],
            statistics: { perfect, great: 1000 - perfect, good: 4, miss: 1 },
            pp: 100,
            passed: true,
          };
          await exec(
            db,
            `insert into user_top_scores (user_id, score_id, position, score_json, pp, weighted_pp, ended_at, refreshed_at)
             values (?, ?, ?, ?, 100, 100, ?, ?)`,
            [userId, score.id, scoreId + 1, JSON.stringify(score), now, now],
          );
        }
      }

      await runSkillBaselineJob(db, queue, { runId: "test-run", cursor: 0 });

      const baselineRows = (await exec(
        db,
        "select user_id, analyzed_plays, ratings_json from player_skill_baseline where baseline_version = ? and key_count = 4",
        [SKILL_BASELINE_VERSION],
      )).rows;
      expect(baselineRows).toHaveLength(25);
      expect(Number(baselineRows[0].analyzed_plays)).toBe(20);

      const blobRow = (await exec(db, "select value_json from live_meta where key = ?", [SKILL_BASELINE_CURVES_META_KEY])).rows[0];
      const curves = parseJson<BaselineCurves | null>(String(blobRow?.value_json ?? ""), null);
      expect(curves).not.toBeNull();
      expect(curves!.users["4"]).toBe(25);
      const overall = curves!.curves["4"].Overall;
      expect(overall.count).toBe(25);
      expect(overall.curve.length).toBe(200);
      expect(overall.curve[0]).toBeLessThanOrEqual(overall.curve[overall.curve.length - 1]);
      expect(curves!.curves["4"]["pattern:stream"].count).toBe(25);

      // A subject with stored exact plays gets percentiles by interpolating
      // their own approximate rating into the curves.
      const breakdown = {
        status: "ready" as const,
        version: PLAYER_SKILLS_VERSION,
        computedAt: now,
        totalPlays: 20,
        analyzedPlays: 20,
        pendingPlays: 0,
        unsupportedPlays: 0,
        modes: [{ keyCount: 4, analyzedPlays: 20, ratings: { Overall: 21 }, patterns: [] }],
      };
      const plays = Array.from({ length: 20 }, (_, index) => ({
        identity: `official:${index}`,
        beatmapId: 500,
        keyCount: 4,
        rate: 1,
        goal: 0.96,
        pp: 100,
        values: {},
        patterns: ["stream"],
      }));
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (1012, ?, 'ready', ?, ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify(breakdown), JSON.stringify({ plays }), now, now],
      );
      const decorated = await decoratePlayerSkillBreakdown(db, 1012, breakdown);
      expect(decorated.baseline).not.toBeNull();
      const percentiles = decorated.modes[0].percentiles!;
      expect(percentiles.Overall.population).toBe(25);
      expect(percentiles.Overall.value).toBeGreaterThanOrEqual(0);
      expect(percentiles.Overall.value).toBeLessThanOrEqual(100);
      expect(percentiles["pattern:stream"]).toBeDefined();
      // 20 analyzed plays clears the provisional bar; the served rating is
      // the evidence-shrunk value (never above the raw aggregate).
      expect(decorated.modes[0].provisional).toBeUndefined();
      expect(decorated.modes[0].ratings.Overall).toBeGreaterThan(0);
      expect(decorated.modes[0].ratings.Overall).toBeLessThanOrEqual(21);

      // A thin pool (9 all-killer plays) must not read as a standing: the
      // rating shrinks hard toward the population median, the keymode is
      // flagged provisional, and no percentile is published below the
      // population's own min-plays floor.
      const thinBreakdown = {
        ...breakdown,
        totalPlays: 9,
        analyzedPlays: 9,
        modes: [{ keyCount: 4, analyzedPlays: 9, ratings: { Overall: 25.03 }, patterns: [] }],
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (1013, ?, 'ready', ?, ?, ?, ?)`,
        [PLAYER_SKILLS_VERSION, JSON.stringify(thinBreakdown), JSON.stringify({ plays: plays.slice(0, 9) }), now, now],
      );
      const thin = await decoratePlayerSkillBreakdown(db, 1013, thinBreakdown);
      expect(thin.modes[0].provisional).toBe(true);
      // w = 9/(9+k): the served value sits well below the raw 25.03 aggregate,
      // pulled toward (but staying above) the population median.
      expect(thin.modes[0].ratings.Overall).toBeLessThan(24.2);
      expect(thin.modes[0].ratings.Overall).toBeGreaterThan(15);
      expect(thin.modes[0].percentiles).toBeUndefined();

      // Fresh curves mean the due-check stays quiet.
      expect(await enqueueSkillBaselineIfDue(db, queue)).toBe(false);
    });
  });

  it("enqueues a chunked run when no curves exist", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      expect(await enqueueSkillBaselineIfDue(db, queue)).toBe(true);
      const jobs = (await exec(db, "select type from jobs where type = ?", [SKILL_BASELINE_JOB])).rows;
      expect(jobs).toHaveLength(1);
      // A pending chain link blocks a duplicate seed.
      expect(await enqueueSkillBaselineIfDue(db, queue)).toBe(false);
    });
  });
});

describe("exact skill curves", () => {
  async function seedRatedRoster(db: Awaited<ReturnType<typeof createDb>>): Promise<void> {
    const now = new Date().toISOString();
    // 25 roster members with an exact Overall gradient across 4K and 7K plus
    // a 4K pattern axis, all above the population min-plays floor.
    for (let user = 0; user < 25; user += 1) {
      const userId = 2000 + user;
      await exec(
        db,
        "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', ?, ?, 'test', 1, ?)",
        [userId, user + 1, now],
      );
      const summary = {
        totalPlays: 120,
        analyzedPlays: 120,
        pendingPlays: 0,
        unsupportedPlays: 0,
        modes: [
          {
            keyCount: 4,
            analyzedPlays: 100,
            ratings: { Overall: 20 + user * 0.2, Stream: 18 + user * 0.2 },
            patterns: [{ id: "stream", label: "Stream", rating: 19 + user * 0.2, plays: 12 }],
          },
          {
            keyCount: 7,
            analyzedPlays: 60,
            ratings: { Overall: 21 + user * 0.2, Stream: 17 + user * 0.2 },
            patterns: [],
          },
        ],
      };
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
         values (?, ?, 'ready', ?, ?, ?, ?)`,
        [userId, PLAYER_SKILLS_VERSION, JSON.stringify(summary), JSON.stringify({ plays: [] }), now, now],
      );
    }
  }

  it("folds stored exact ratings into curves that rank the displayed rating", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await seedRatedRoster(db);
      await runSkillBaselineJob(db, queue, { runId: "exact-run", cursor: 0 });

      const blobRow = (await exec(db, "select value_json from live_meta where key = ?", [EXACT_SKILL_CURVES_META_KEY])).rows[0];
      const exact = parseJson<ExactSkillCurves | null>(String(blobRow?.value_json ?? ""), null);
      expect(exact).not.toBeNull();
      expect(exact!.playerSkillsVersion).toBe(PLAYER_SKILLS_VERSION);
      expect(exact!.users["4"]).toBe(25);
      expect(exact!.curves["4"].Overall.count).toBe(25);
      expect(exact!.curves["4"].Overall.median).toBeGreaterThan(0);
      expect(exact!.curves["4"].Stream).toBeDefined();
      expect(exact!.curves["4"]["pattern:stream"].count).toBe(25);
      // Non-4K keymodes publish Overall only: MinaCalc's skillset names are
      // unreliable there, same rule as the approximate axes.
      expect(exact!.curves["7"].Overall.count).toBe(25);
      expect(exact!.curves["7"].Stream).toBeUndefined();

      const breakdownFor = (overall: number, analyzedPlays: number) => ({
        status: "ready" as const,
        version: PLAYER_SKILLS_VERSION,
        computedAt: new Date().toISOString(),
        totalPlays: analyzedPlays,
        analyzedPlays,
        pendingPlays: 0,
        unsupportedPlays: 0,
        modes: [
          {
            keyCount: 4,
            analyzedPlays,
            ratings: { Overall: overall },
            patterns: [
              { id: "stream", label: "Stream", rating: overall, plays: 5 },
              { id: "jack", label: "Jack", rating: overall, plays: 2 },
            ],
          },
        ],
      });

      // The whole point of the exact scale: a higher headline rating can
      // never show a worse standing. No plays_json row is needed - the
      // percentile comes from the same ratings the breakdown carries.
      const stronger = await decoratePlayerSkillBreakdown(db, 9001, breakdownFor(24.8, 250));
      const weaker = await decoratePlayerSkillBreakdown(db, 9002, breakdownFor(21.0, 250));
      expect(stronger.baseline?.users["4"]).toBe(25);
      const strongPct = stronger.modes[0].percentiles!.Overall;
      const weakPct = weaker.modes[0].percentiles!.Overall;
      expect(strongPct.population).toBe(25);
      expect(strongPct.value).toBeGreaterThan(weakPct.value);
      // Pattern axes need the subject to have a rated pool of that pattern.
      expect(stronger.modes[0].percentiles!["pattern:stream"]).toBeDefined();
      expect(stronger.modes[0].percentiles!["pattern:jack"]).toBeUndefined();
      // Displayed ratings stay evidence-shrunk (never above the raw value).
      expect(stronger.modes[0].ratings.Overall).toBeLessThanOrEqual(24.8);

      // A subject above the whole population is ranked by the exact tail, not
      // pinned to a flat 100: one player out of 25 is a top-4% share, and the
      // profile can say so instead of rounding every leader to "top 1%".
      const top = await decoratePlayerSkillBreakdown(db, 9003, breakdownFor(40, 500));
      expect(top.modes[0].percentiles!.Overall.value).toBe(96);

      // Thin pools stay provisional and unranked.
      const thin = await decoratePlayerSkillBreakdown(db, 9004, breakdownFor(24.8, 9));
      expect(thin.modes[0].provisional).toBe(true);
      expect(thin.modes[0].percentiles).toBeUndefined();

      // Both blobs fresh at the current version: the due-check stays quiet.
      expect(await enqueueSkillBaselineIfDue(db, queue)).toBe(false);
    });
  });

  it("re-runs the chain once when only the approximate curves exist", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await seedRatedRoster(db);
      const now = new Date().toISOString();
      const approxOnly: BaselineCurves = {
        computedAt: now,
        baselineVersion: SKILL_BASELINE_VERSION,
        playerSkillsVersion: PLAYER_SKILLS_VERSION,
        gamma: {},
        accSlope: 1.09,
        minPlays: 20,
        curves: {},
        users: {},
      };
      await exec(
        db,
        "insert into live_meta (key, value_json, updated_at) values (?, ?, ?)",
        [SKILL_BASELINE_CURVES_META_KEY, JSON.stringify(approxOnly), now],
      );
      // Fresh approximate curves alone are no longer enough: the missing
      // exact blob makes the chain due (the deploy-transition case).
      expect(await enqueueSkillBaselineIfDue(db, queue)).toBe(true);
    });
  });

  it("becomes due again when the stored blob predates the current curve shape", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await seedRatedRoster(db);
      await runSkillBaselineJob(db, queue, { runId: "shape-run", cursor: 0 });
      await exec(db, "delete from jobs");
      // Everything fresh: nothing to do.
      expect(await enqueueSkillBaselineIfDue(db, queue)).toBe(false);

      // Rewrite the exact blob in the pre-median shape, as a deploy that
      // changes the shape would find it.
      const row = (await exec(db, "select value_json from live_meta where key = ?", [EXACT_SKILL_CURVES_META_KEY])).rows[0];
      const stored = parseJson<ExactSkillCurves>(String(row?.value_json ?? ""), {} as ExactSkillCurves);
      delete stored.format;
      await exec(
        db,
        "update live_meta set value_json = ? where key = ?",
        [JSON.stringify(stored), EXACT_SKILL_CURVES_META_KEY],
      );
      expect(await enqueueSkillBaselineIfDue(db, queue)).toBe(true);
      // And the old blob keeps serving in the meantime: no percentile gap
      // while the fold runs.
      expect((await readExactSkillCurves(db))?.curves["4"].Overall.count).toBe(25);
    });
  });

  it("caches the served curves per database, not per process", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await seedRatedRoster(db);
      await runSkillBaselineJob(db, queue, { runId: "cache-run", cursor: 0 });
      expect(await readExactSkillCurves(db)).not.toBeNull();
    });
    // A second database with no baseline at all must read as having none: a
    // module-level cache would hand it the first one's curves and every
    // downstream surface would claim a population baseline it does not have.
    await withDb(async (db) => {
      expect(await readExactSkillCurves(db)).toBeNull();
    });
  });

  it("publishes a median for a sparse axis but no curve to quantile it", async () => {
    await withDb(async (db) => {
      const queue = new JobQueue(db);
      await seedRatedRoster(db);
      const now = new Date().toISOString();
      // Six more members carrying one extra pattern axis: over the median
      // floor, under the curve floor.
      for (let user = 0; user < 6; user += 1) {
        const userId = 3000 + user;
        await exec(
          db,
          "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', ?, ?, 'test', 1, ?)",
          [userId, 100 + user, now],
        );
        const summary = {
          totalPlays: 120,
          analyzedPlays: 120,
          pendingPlays: 0,
          unsupportedPlays: 0,
          modes: [
            {
              keyCount: 4,
              analyzedPlays: 100,
              ratings: { Overall: 20 + user * 0.2 },
              patterns: [{ id: "bracket", label: "Bracket", rating: 19 + user * 0.2, plays: 12 }],
            },
          ],
        };
        await exec(
          db,
          `insert into player_skill_ratings (user_id, analysis_version, status, modes_json, plays_json, computed_at, updated_at)
           values (?, ?, 'ready', ?, ?, ?, ?)`,
          [userId, PLAYER_SKILLS_VERSION, JSON.stringify(summary), JSON.stringify({ plays: [] }), now, now],
        );
      }
      await runSkillBaselineJob(db, queue, { runId: "sparse-run", cursor: 0 });

      const exact = await readExactSkillCurves(db);
      const bracket = exact!.curves["4"]["pattern:bracket"];
      // Without a median this axis would be the one axis served raw while
      // every neighbour is served shrunk, and the profile page would disagree.
      expect(bracket.count).toBe(6);
      expect(bracket.median).toBeGreaterThan(0);
      expect(bracket.curve).toEqual([]);
      // The wide axis keeps its quantiles.
      expect(exact!.curves["4"]["pattern:stream"].curve.length).toBeGreaterThan(0);

      // A one-player axis stays absent: its "median" is just that player.
      expect(exact!.curves["4"]["pattern:delay"]).toBeUndefined();
    });
  });
});
