import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readConfig } from "../config.js";
import { createDb, exec, migrate, type Db } from "../db.js";
import { unpackJson } from "../shared/compressed-json.js";
import { buildFarmHelperSnapshotForBacktest, type FarmHelperKeyMode } from "../features/farm-helper.js";
import {
  buildAccSamples,
  evaluateAccHoldout,
  fitAccModelFromSamples,
  loadAccChartDifficulty,
  readPlayerAccModel,
  type AccModelPlay,
  type PlayerAccModel,
} from "../features/player-acc-model.js";
import { hydrateScoresDisplayMetadata } from "../shared/score-storage.js";
import type { OscScore } from "../shared/types.js";

// Offline backtest for the farm helper. Measures recommendation quality on the
// local prod-synced DB (never calls the osu! API; reconstructs each subject's
// snapshot "as of" a past cutoff from stored data). Run before AND after every
// redesign stage and compare the deltas against the baseline.
//
// Method: for each eligible subject, cut at T = latest top-play event - CUT_DAYS.
// Reconstruct the snapshot as of T (subject best scores filtered to ended_at<=T,
// peer farmed rows filtered to played_at<=T), then score the recs against the
// ground truth G = beatmaps that actually entered the subject's top plays after T
// (top_play_events with detected_at>T).
//
// Usage:
//   npm run backtest:farm-helper -- --label baseline
//   npm run backtest:farm-helper -- --label stage2 --limit 150 --out ./backtest-out
//   npm run backtest:farm-helper -- --acc-only        (accuracy-model holdout only)
//   npm run backtest:farm-helper -- --no-acc-scaling  (A/B: disable the A8
//                                    predicted-accuracy benchmark scaling)
//   npm run backtest:farm-helper -- --no-survival     (A/B: disable the A10
//                                    survival ranking discount)
//
// NOTE ON A8 LEAKAGE: the personal accuracy model comes from the CURRENT
// player_skill_ratings row (stored acc_model_json, or fitted on the fly from
// the stored plays when the skills job has not persisted one yet), i.e. from
// plays that may postdate the as-of cutoff. The before/after comparison
// (--no-acc-scaling vs default) is still apples-to-apples; absolute numbers
// carry that mild optimism.
//
// Accuracy-model holdout (A7): for each subject with stored skill ratings,
// hold out ~20% of their rated plays (deterministic identity hash), fit the
// personal accuracy model on the rest, and report the MAE of the median
// predicted custom accuracy on the holdout, next to the naive baseline
// (player-mean accuracy per keymode). --acc-only skips the heavy snapshot
// reconstruction and reports just this metric.
//
// NOTE ON WINDOW: the plan specified a >=60-day event span, but the live event
// log only covers ~85 days, which leaves just 8 eligible subjects. The default
// span is relaxed to 45 days (yields ~151 subjects, matching the plan's ~150
// target and 30-day cut). Override with --min-span-days if the window grows.

interface Args {
  label: string;
  out: string;
  limit: number;
  minEvents: number;
  minSpanDays: number;
  cutDays: number;
  recLimit: number;
  keyMode: FarmHelperKeyMode;
  accOnly: boolean;
  noAccScaling: boolean;
  noSurvival: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const keyModeRaw = get("--key-mode") ?? "any";
  const keyMode: FarmHelperKeyMode = keyModeRaw === "4k" || keyModeRaw === "7k" ? keyModeRaw : "any";
  return {
    label: get("--label") ?? "baseline",
    out: get("--out") ?? "./backtest-out",
    limit: num("--limit", 150),
    minEvents: num("--min-events", 40),
    minSpanDays: num("--min-span-days", 45),
    cutDays: num("--cut-days", 30),
    recLimit: num("--rec-limit", 100),
    keyMode,
    accOnly: argv.includes("--acc-only"),
    noAccScaling: argv.includes("--no-acc-scaling"),
    noSurvival: argv.includes("--no-survival"),
  };
}

interface AccHoldoutSubject {
  userId: number;
  n: number;
  mae: number;
  naiveMae: number;
}

// The subject's stored skill row (plays + per-keymode Overall ratings), the
// input both the acc holdout and the on-the-fly model fit need.
async function readStoredSkillPlays(
  db: Db,
  userId: number,
): Promise<{ plays: AccModelPlay[]; ratingByKeys: Map<number, number> } | null> {
  const row = (await exec(
    db,
    `select modes_json, plays_json from player_skill_ratings
     where user_id = ? and status = 'ready'
     order by analysis_version desc limit 1`,
    [userId],
  )).rows[0];
  if (!row) return null;
  let modes: { modes?: Array<{ keyCount: number; ratings?: Record<string, number> }> };
  let playsWrap: { plays?: AccModelPlay[] };
  try {
    modes = JSON.parse(String(row.modes_json ?? ""));
    playsWrap = JSON.parse(String(row.plays_json ?? ""));
  } catch {
    return null;
  }
  const plays = playsWrap.plays ?? [];
  const ratingByKeys = new Map<number, number>();
  for (const mode of modes.modes ?? []) {
    const rating = Number(mode.ratings?.Overall ?? 0);
    if (rating > 0) ratingByKeys.set(mode.keyCount, rating);
  }
  if (ratingByKeys.size === 0) return null;
  return { plays, ratingByKeys };
}

// 80/20 holdout of the subject's rated plays against the personal accuracy
// model (player-acc-model.ts). Reads the stored skill row; null when the
// subject has no ready ratings or too few joinable plays.
async function runAccHoldout(db: Db, userId: number): Promise<AccHoldoutSubject | null> {
  const stored = await readStoredSkillPlays(db, userId);
  if (!stored || stored.plays.length < 20) return null;
  const { plays, ratingByKeys } = stored;
  const chartData = await loadAccChartDifficulty(db, plays.map((play) => play.beatmapId));
  const samples = buildAccSamples(plays, ratingByKeys, chartData);
  const result = evaluateAccHoldout(
    samples,
    [...ratingByKeys.entries()].map(([keyCount, rating]) => ({ keyCount, rating })),
  );
  if (!result) return null;
  return { userId, ...result };
}

// The subject's acc model for the A8 scaling run: the stored acc_model_json
// when the skills job already fitted one, else a fresh fit from the stored
// plays via the exact machinery the job uses (fitAccModelFromSamples). Keeps
// the backtest read-only on DBs synced before the job's first A7 pass. Null
// when the subject has no ready ratings (scaling then simply stays off).
async function loadOrFitAccModel(db: Db, userId: number): Promise<PlayerAccModel | null> {
  const stored = await readPlayerAccModel(db, userId).catch(() => null);
  if (stored) return stored;
  const skillRow = await readStoredSkillPlays(db, userId);
  if (!skillRow) return null;
  const chartData = await loadAccChartDifficulty(db, skillRow.plays.map((play) => play.beatmapId));
  const samples = buildAccSamples(skillRow.plays, skillRow.ratingByKeys, chartData);
  return fitAccModelFromSamples(
    samples,
    [...skillRow.ratingByKeys.entries()].map(([keyCount, rating]) => ({ keyCount, rating })),
  );
}

interface SubjectRow {
  userId: number;
  userJson: string;
  bestScoresJson: string;
  maxDetectedAt: string;
  eventCount: number;
}

async function selectSubjects(db: Db, args: Args): Promise<SubjectRow[]> {
  const rows = (await exec(
    db,
    `select t.user_id, p.user_json, p.best_scores_json,
       max(t.detected_at) as max_detected_at,
       count(*) as event_count,
       (julianday(max(t.detected_at)) - julianday(min(t.detected_at))) as span_days
     from top_play_events t
     join profile_snapshots p on p.user_id = t.user_id
     where length(p.best_scores_json) > 100
     group by t.user_id
     having event_count >= ? and span_days >= ?
     order by t.user_id asc
     limit ?`,
    [args.minEvents, args.minSpanDays, args.limit],
  )).rows;
  return rows.map((row) => ({
    userId: Number(row.user_id),
    userJson: JSON.stringify(unpackJson<Record<string, unknown>>(row.user_json, {})),
    bestScoresJson: JSON.stringify(unpackJson<unknown[]>(row.best_scores_json, [])),
    maxDetectedAt: String(row.max_detected_at),
    eventCount: Number(row.event_count),
  }));
}

interface GroundTruth {
  beatmaps: Set<number>;
  actualPp: Map<number, number>;
}

async function readGroundTruth(db: Db, userId: number, cutIso: string): Promise<GroundTruth> {
  const rows = (await exec(
    db,
    "select payload_json from top_play_events where user_id = ? and detected_at > ?",
    [userId, cutIso],
  )).rows;
  const beatmaps = new Set<number>();
  const actualPp = new Map<number, number>();
  for (const row of rows) {
    let payload: { pp?: unknown; score?: { beatmap_id?: unknown; pp?: unknown } };
    try {
      payload = JSON.parse(String(row.payload_json));
    } catch {
      continue;
    }
    const beatmapId = Number(payload.score?.beatmap_id);
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) continue;
    beatmaps.add(beatmapId);
    const pp = Number(payload.pp ?? payload.score?.pp);
    if (Number.isFinite(pp) && pp > 0) {
      actualPp.set(beatmapId, Math.max(actualPp.get(beatmapId) ?? 0, pp));
    }
  }
  return { beatmaps, actualPp };
}

interface SubjectResult {
  userId: number;
  username: string;
  pp: number;
  cohortCount: number;
  effectiveCount: number;
  recCount: number;
  groundTruthCount: number;
  precisionAt25: number;
  precisionAt50: number;
  recallAt100: number;
  hitsInTop100: number;
  benchMae: number | null;
  nullFitFraction: number;
}

function precisionAtK(recBeatmaps: number[], g: Set<number>, k: number): number {
  const n = Math.min(k, recBeatmaps.length);
  if (n === 0) return 0;
  let hits = 0;
  for (let i = 0; i < n; i++) if (g.has(recBeatmaps[i])) hits++;
  return hits / n;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let gitRev = "unknown";
  try {
    gitRev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    // running outside a checkout is fine; the label still identifies the run.
  }

  const config = readConfig();
  const db = await createDb(config);
  await migrate(db);

  // Log the played_at null fraction of the candidate pool: as-of reconstruction
  // keeps null-played_at rows, so a high fraction means more potential leakage.
  const nullStats = (await exec(
    db,
    `select
       sum(case when played_at is null then 1 else 0 end) as null_count,
       count(*) as total
     from country_maps_farmed_scores`,
  )).rows[0];
  const nullCount = Number(nullStats?.null_count ?? 0);
  const totalFarmed = Number(nullStats?.total ?? 0);
  const nullFraction = totalFarmed > 0 ? nullCount / totalFarmed : 0;

  const subjects = await selectSubjects(db, args);
  console.log(
    `[backtest] label=${args.label} rev=${gitRev} keyMode=${args.keyMode} cutDays=${args.cutDays} `
    + `accScaling=${args.noAccScaling ? "off" : "on"} survival=${args.noSurvival ? "off" : "on"} `
    + `subjects=${subjects.length} (>=${args.minEvents} events, span>=${args.minSpanDays}d) `
    + `farmed played_at null fraction=${round(nullFraction, 4)}`,
  );

  const results: SubjectResult[] = [];
  let subjectsWithRecs = 0;
  let subjectsWithEmptyG = 0;
  let subjectsWithAccModel = 0;
  const pooledBenchErrors: number[] = [];
  const accResults: AccHoldoutSubject[] = [];
  let accSkipped = 0;

  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];

    // Accuracy-model holdout runs for every subject with stored ratings,
    // independent of the ground-truth window the rec metrics need.
    const accResult = await runAccHoldout(db, subject.userId).catch(() => null);
    if (accResult) accResults.push(accResult);
    else accSkipped++;
    if (args.accOnly) {
      if ((i + 1) % 25 === 0) console.log(`[backtest] processed ${i + 1}/${subjects.length}...`);
      continue;
    }

    let user: Record<string, unknown>;
    let rawScores: OscScore[];
    try {
      user = JSON.parse(subject.userJson) as Record<string, unknown>;
      rawScores = JSON.parse(subject.bestScoresJson) as OscScore[];
    } catch {
      continue;
    }
    if (!Array.isArray(rawScores) || rawScores.length === 0) continue;

    const asOf = Date.parse(subject.maxDetectedAt) - args.cutDays * 86_400_000;
    if (!Number.isFinite(asOf)) continue;
    const cutIso = new Date(asOf).toISOString();

    const ground = await readGroundTruth(db, subject.userId, cutIso);
    if (ground.beatmaps.size === 0) {
      subjectsWithEmptyG++;
      continue;
    }

    const hydrated = await hydrateScoresDisplayMetadata(db, rawScores);
    // A8 scaling: serve the stored model or fit one on the fly (read-only).
    let accModel: PlayerAccModel | null = null;
    if (!args.noAccScaling) {
      accModel = await loadOrFitAccModel(db, subject.userId).catch(() => null);
      if (accModel) subjectsWithAccModel++;
    }
    const snapshot = await buildFarmHelperSnapshotForBacktest(db, user, hydrated, {
      asOf,
      keyMode: args.keyMode,
      view: "gain",
      limit: args.recLimit,
      noAccScaling: args.noAccScaling,
      noSurvival: args.noSurvival,
      accModel,
    });

    const recBeatmaps = snapshot.recs.map((rec) => rec.beatmapId);
    if (recBeatmaps.length > 0) subjectsWithRecs++;

    const top100 = recBeatmaps.slice(0, 100);
    let hitsInTop100 = 0;
    for (const id of top100) if (ground.beatmaps.has(id)) hitsInTop100++;

    const benchErrors: number[] = [];
    let nullFitCount = 0;
    for (const rec of snapshot.recs) {
      const patternFit = "patternFit" in rec ? (rec as { patternFit: number | null }).patternFit : null;
      if (patternFit == null) nullFitCount++;
      if (ground.beatmaps.has(rec.beatmapId)) {
        const actual = ground.actualPp.get(rec.beatmapId);
        if (actual != null && actual > 0) {
          const err = Math.abs(rec.benchmarkPp - actual);
          benchErrors.push(err);
          pooledBenchErrors.push(err);
        }
      }
    }

    const effectiveCount = snapshot.peerBand.effectiveCount;

    results.push({
      userId: subject.userId,
      username: String((user as { username?: unknown }).username ?? ""),
      pp: Math.round(Number((user as { statistics?: { pp?: unknown } }).statistics?.pp ?? 0)),
      cohortCount: snapshot.peerBand.count,
      effectiveCount,
      recCount: recBeatmaps.length,
      groundTruthCount: ground.beatmaps.size,
      precisionAt25: precisionAtK(recBeatmaps, ground.beatmaps, 25),
      precisionAt50: precisionAtK(recBeatmaps, ground.beatmaps, 50),
      recallAt100: ground.beatmaps.size > 0 ? hitsInTop100 / ground.beatmaps.size : 0,
      hitsInTop100,
      benchMae: benchErrors.length > 0 ? mean(benchErrors) : null,
      nullFitFraction: recBeatmaps.length > 0 ? nullFitCount / recBeatmaps.length : 1,
    });

    if ((i + 1) % 25 === 0) console.log(`[backtest] processed ${i + 1}/${subjects.length}...`);
  }

  const p25 = results.map((r) => r.precisionAt25);
  const p50 = results.map((r) => r.precisionAt50);
  const rec100 = results.map((r) => r.recallAt100);
  const cohort = results.map((r) => r.cohortCount);
  const effective = results.map((r) => r.effectiveCount);
  const recCounts = results.map((r) => r.recCount);
  const nullFit = results.map((r) => r.nullFitFraction);
  const perSubjectMae = results.map((r) => r.benchMae).filter((v): v is number => v != null);

  console.log("");
  console.log(`==== Accuracy-model holdout: ${args.label} (rev ${gitRev}) ====`);
  if (accResults.length > 0) {
    const maes = accResults.map((r) => r.mae);
    const naives = accResults.map((r) => r.naiveMae);
    const totalN = accResults.reduce((sum, r) => sum + r.n, 0);
    const pooledMae = accResults.reduce((sum, r) => sum + r.mae * r.n, 0) / totalN;
    const pooledNaive = accResults.reduce((sum, r) => sum + r.naiveMae * r.n, 0) / totalN;
    console.log(`subjects: ${accResults.length} (skipped: ${accSkipped}) | holdout plays: ${totalN}`);
    console.log(`model MAE   mean=${round(mean(maes), 5)} median=${round(median(maes), 5)} pooled=${round(pooledMae, 5)}`);
    console.log(`naive MAE   mean=${round(mean(naives), 5)} median=${round(median(naives), 5)} pooled=${round(pooledNaive, 5)} (player-mean accuracy baseline)`);
  } else {
    console.log(`no subjects with stored skill ratings (skipped: ${accSkipped})`);
  }

  if (args.accOnly) {
    db.close();
    process.exit(0);
  }

  console.log("");
  console.log(`==== Farm helper backtest: ${args.label} (rev ${gitRev}) ====`);
  console.log(
    `subjects scored: ${results.length} | with recs: ${subjectsWithRecs} | skipped (empty ground truth): ${subjectsWithEmptyG}`
    + ` | acc models served: ${args.noAccScaling ? "off" : subjectsWithAccModel}`,
  );
  const table: Array<[string, string, string]> = [
    ["metric", "mean", "median"],
    ["precision@25", round(mean(p25)).toString(), round(median(p25)).toString()],
    ["precision@50", round(mean(p50)).toString(), round(median(p50)).toString()],
    ["recall@100", round(mean(rec100)).toString(), round(median(rec100)).toString()],
    ["benchmark MAE (pp)", round(mean(perSubjectMae), 2).toString(), round(median(perSubjectMae), 2).toString()],
    ["cohort size", round(mean(cohort), 1).toString(), round(median(cohort), 1).toString()],
    ["effective peers", round(mean(effective), 1).toString(), round(median(effective), 1).toString()],
    ["recs per subject", round(mean(recCounts), 1).toString(), round(median(recCounts), 1).toString()],
    ["null-fit fraction", round(mean(nullFit)).toString(), round(median(nullFit)).toString()],
  ];
  const widths = [0, 1, 2].map((col) => Math.max(...table.map((r) => r[col].length)));
  for (const r of table) {
    console.log(r.map((cell, col) => cell.padEnd(widths[col])).join("  "));
  }
  console.log(`pooled benchmark MAE across all in-G recs: ${round(mean(pooledBenchErrors), 2)} pp (n=${pooledBenchErrors.length})`);

  mkdirSync(args.out, { recursive: true });
  const csvPath = `${args.out.replace(/\/$/, "")}/farm-helper-backtest-${args.label}-${gitRev}.csv`;
  const header = "user_id,username,pp,cohort_count,effective_count,rec_count,ground_truth,precision_at_25,precision_at_50,recall_at_100,hits_in_top100,bench_mae,null_fit_fraction";
  const lines = results.map((r) => [
    r.userId,
    JSON.stringify(r.username),
    r.pp,
    r.cohortCount,
    r.effectiveCount,
    r.recCount,
    r.groundTruthCount,
    round(r.precisionAt25),
    round(r.precisionAt50),
    round(r.recallAt100),
    r.hitsInTop100,
    r.benchMae == null ? "" : round(r.benchMae, 2),
    round(r.nullFitFraction),
  ].join(","));
  writeFileSync(csvPath, [header, ...lines].join("\n") + "\n");
  console.log(`per-subject CSV written to ${csvPath}`);

  db.close();
  process.exit(0);
}

await main();
