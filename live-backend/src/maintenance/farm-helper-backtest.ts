import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readConfig } from "../config.js";
import { createDb, exec, migrate, type Db } from "../db.js";
import { buildFarmHelperSnapshotForBacktest, type FarmHelperKeyMode } from "../features/farm-helper.js";
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
  };
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
    userJson: String(row.user_json),
    bestScoresJson: String(row.best_scores_json),
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
    + `subjects=${subjects.length} (>=${args.minEvents} events, span>=${args.minSpanDays}d) `
    + `farmed played_at null fraction=${round(nullFraction, 4)}`,
  );

  const results: SubjectResult[] = [];
  let subjectsWithRecs = 0;
  let subjectsWithEmptyG = 0;
  const pooledBenchErrors: number[] = [];

  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
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
    const snapshot = await buildFarmHelperSnapshotForBacktest(db, user, hydrated, {
      asOf,
      keyMode: args.keyMode,
      view: "gain",
      limit: args.recLimit,
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

    const effectiveCount = "effectiveCount" in snapshot.peerBand
      ? Number((snapshot.peerBand as { effectiveCount: number }).effectiveCount)
      : snapshot.peerBand.farmDataCount;

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
  console.log(`==== Farm helper backtest: ${args.label} (rev ${gitRev}) ====`);
  console.log(`subjects scored: ${results.length} | with recs: ${subjectsWithRecs} | skipped (empty ground truth): ${subjectsWithEmptyG}`);
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
