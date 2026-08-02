#!/usr/bin/env node
// Run the dan classifier against the curated benchmark beatmapsets and compare
// predicted dan vs the expected labels stored in the live backend (the same
// data the admin /admin/dan-classifier benchmark tab uses).
//
// Usage:
//   npm run dan:benchmark
//   npm run dan:benchmark -- --family ln --classifier daniel
//   npm run dan:benchmark -- --json

import { readFile } from "node:fs/promises";
import { parseManiaBeatmap, type ManiaBeatmap } from "../src/lib/beatmap-parser.ts";
import { estimateDan } from "../src/lib/dan-estimator.ts";
import { getLnReferenceComparisonMetrics, getLnReferenceNeighbors } from "../src/lib/dan-estimator/ln.ts";
import { estimateDanielDan } from "../src/lib/daniel-estimator.ts";
import { estimateLeoBlackDan } from "../src/lib/leoblack-estimator.ts";
import { classifyChart } from "../src/lib/chart-classifier.ts";
import { classifyChartWithCompanella } from "../src/lib/companella.ts";
import type { DanEstimate, DanFeatureMetrics } from "../src/lib/dan-estimator/types.ts";
import {
  type DanBenchmarkFamily,
  getBenchmarkBeatmapIds,
  getBenchmarkExpectedLabelOverride,
  getBenchmarkBeatmapStarRating,
  getBenchmarkBeatmapsetIds,
  RANKED_BENCHMARK_BEATMAP_IDS,
} from "../src/lib/dan-benchmark-sets.ts";
import {
  type BeatmapMeta,
  type CatboyBeatmapset,
  downloadBeatmapset,
  extractOsz,
  fetchCatboyBeatmapset,
  fetchCatboyBeatmapsetByTitle,
  fetchBeatmapFile,
} from "./_dan-shared.ts";

type ClassifierId = "unified" | "aleju" | "daniel" | "leoblack";
type MatchKind = "exact" | "base" | "wrong" | "unlabeled";

interface CliOptions {
  beatmapIds: Set<number> | null;
  beatmapsetIds: number[] | null;
  cacheDir: string;
  classifier: ClassifierId;
  compareFiles: [string, string] | null;
  expectedLabels: Set<string> | null;
  family: DanBenchmarkFamily;
  familySpecified: boolean;
  failuresFrom: string | null;
  grepText: string | null;
  includeUnlabeled: boolean;
  debug: boolean;
  explainWrong: boolean;
  json: boolean;
  matchKinds: Set<MatchKind> | null;
  neighbors: number;
  noCompanella: boolean;
  rate: number;
  showChangesFrom: string | null;
  summaryBySet: boolean;
}

interface BenchmarkDiagnostics {
  reason: string | null;
  notes: number;
  holds: number;
  duration: number;
  holdRatio: number;
  chordRatio: number;
  peak5: number;
  sustain10: number;
  lnRelease: number;
  lnDensity: number;
  lnOverlap: number;
  lnChord: number;
  lnP90: number;
  lnStats: {
    holdMs: {
      avg: number;
      p50: number;
      p90: number;
      p95: number;
      max: number;
    };
    releases: {
      peak1s: number;
      peak2s: number;
      gapP10Ms: number;
      gapP50Ms: number;
      gapP90Ms: number;
    };
  };
  segmentation: {
    explicitBreaks: number;
    rawGaps: number;
    rawGapMs: number[];
    likelyRawGapCourse: boolean;
  };
  topSkillScores: Array<{ family: string; score: number }>;
  warnings: string[];
  lnNeighbors: Array<{
    level: number;
    distance: number;
    n: number;
    duration: number;
    release: number;
    density: number;
    peak5: number;
    sustain10: number;
    delta: {
      duration: number;
      notes: number;
      release: number;
      density: number;
      peak5: number;
      sustain10: number;
      chordRatio: number;
    };
  }>;
}

interface RowResult {
  beatmapId: number | null;
  version: string;
  starRating: number | null;
  expected: string | null;
  predicted: string | null;
  predictedFamily: string | null;
  predictedConfidence: number | null;
  predictedRawDan: number | null;
  predictedSrProxy: number | null;
  debug?: Pick<DanEstimate, "metrics" | "skillScores" | "debug">;
  diagnostics?: BenchmarkDiagnostics;
  match: MatchKind;
  error: string | null;
}

interface SetResult {
  beatmapsetId: number;
  title: string | null;
  artist: string | null;
  rows: RowResult[];
  error: string | null;
}

const DEFAULT_CACHE_DIR = "cache/dan-analyze";

function parseBeatmapVersion(text: string): string {
  return text.match(/^Version\s*:\s*(.+)$/m)?.[1]?.trim() ?? "";
}

interface BenchmarkJson {
  family?: DanBenchmarkFamily;
  classifier?: ClassifierId;
  rate?: number;
  filters?: string[];
  summary?: ReturnType<typeof summarize> & {
    exactPct?: number;
    basePct?: number;
  };
  sets: SetResult[];
}

interface RowWithSet {
  set: SetResult;
  row: RowResult;
}

interface ChangedRow {
  beatmapsetId: number;
  beatmapId: number | null;
  version: string;
  expected: string | null;
  before: {
    predicted: string | null;
    family: string | null;
    match: MatchKind;
    srProxy: number | null;
  };
  after: {
    predicted: string | null;
    family: string | null;
    match: MatchKind;
    srProxy: number | null;
  };
  direction: "wrong-to-ok" | "ok-to-wrong" | "changed-correctness" | "changed-prediction";
}

function usage(exitCode = 2): never {
  const output = [
    "Usage: npm run dan:benchmark -- [options]",
    "",
    "Options:",
    "  --family normal|ln|ranked Benchmark family. Default: normal",
    "  --classifier unified|aleju|daniel|leoblack  Estimator to run. Default: unified (the production classifier); the rest are baselines",
    "  --no-companella          unified only: skip the Companella pass and keep the Sunny fallback on the 4K LN-hybrid slice",
    "  --rate N                 Playback rate. Default: 1",
    "  --set IDS                Comma-separated beatmapset IDs to run",
    "  --beatmap IDS            Comma-separated beatmap IDs/diffs to run",
    "  --expected LABELS        Comma-separated expected labels to run",
    "  --label LABELS           Alias for --expected",
    "  --match KINDS            Keep current exact/base/wrong/unlabeled rows after scoring",
    "  --grep TEXT              Keep rows whose set title, artist, or diff version contains text",
    "  --failures-from FILE     Rerun beatmaps that were wrong in a previous --json output",
    "  --show-changes FILE      After scoring, compare current output to a previous --json file",
    "  --compare BEFORE AFTER   Compare two existing --json outputs without running the classifier",
    "  --summary-by-set         Print per-beatmapset exact/base/wrong totals",
    "  --explain-wrong          Print calibration diagnostics for current wrong rows",
    "  --neighbors N            LN reference neighbors for --explain-wrong. Default: 5",
    "  --cache-dir DIR          Beatmapset download cache. Default: cache/dan-analyze",
    "  --include-unlabeled      Show diffs without an expected label (never counted toward accuracy)",
    "  --debug                  Include metrics and scoring internals in JSON output",
    "  --json                   Emit structured JSON instead of a table",
    "",
    "Examples:",
    "  npm run dan:benchmark -- --set 2172412",
    "  npm run dan:benchmark -- --beatmap 4767800 --explain-wrong",
    "  npm run dan:benchmark -- --json > before.json",
    "  npm run dan:benchmark -- --failures-from before.json --match wrong --explain-wrong",
    "  npm run dan:benchmark -- --compare before.json after.json --summary-by-set",
    "  npm run dan:benchmark -- --set 2192368 --grep Sendan",
    "",
    "Requires LIVE_BACKEND_URL and LIVE_ADMIN_TOKEN in the environment (or .env).",
  ].join("\n");
  if (exitCode === 0) process.stdout.write(`${output}\n`);
  else process.stderr.write(`${output}\n`);
  process.exit(exitCode);
}

function parseNumberList(value: string | undefined, option: string): number[] {
  if (!value) usage();
  const values = value.split(",").map((part) => Number(part.trim()));
  if (values.length === 0 || values.some((number) => !Number.isInteger(number) || number <= 0)) {
    process.stderr.write(`Invalid ${option}: ${value}\n`);
    usage();
  }
  return values;
}

function parseStringSet(value: string | undefined): Set<string> {
  if (!value) usage();
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (values.length === 0) usage();
  return new Set(values);
}

function parseMatchKinds(value: string | undefined): Set<MatchKind> {
  const values = parseStringSet(value);
  const kinds = new Set<MatchKind>();
  for (const kind of values) {
    if (kind !== "exact" && kind !== "base" && kind !== "wrong" && kind !== "unlabeled") {
      process.stderr.write(`Invalid --match kind: ${kind}\n`);
      usage();
    }
    kinds.add(kind);
  }
  return kinds;
}

function appendNumberTargets(existing: number[] | null, values: number[]): number[] {
  return [...new Set([...(existing ?? []), ...values])];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    beatmapIds: null,
    beatmapsetIds: null,
    cacheDir: DEFAULT_CACHE_DIR,
    classifier: "unified",
    compareFiles: null,
    noCompanella: false,
    debug: false,
    expectedLabels: null,
    explainWrong: false,
    family: "normal",
    familySpecified: false,
    failuresFrom: null,
    grepText: null,
    includeUnlabeled: false,
    json: false,
    matchKinds: null,
    neighbors: 5,
    rate: 1,
    showChangesFrom: null,
    summaryBySet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--debug") {
      options.debug = true;
    } else if (arg === "--include-unlabeled") {
      options.includeUnlabeled = true;
    } else if (arg === "--family") {
      const value = argv[++i];
      if (value !== "normal" && value !== "ln" && value !== "ranked") usage();
      options.family = value;
      options.familySpecified = true;
    } else if (arg === "--classifier") {
      const value = argv[++i];
      if (value !== "unified" && value !== "aleju" && value !== "daniel" && value !== "leoblack") usage();
      options.classifier = value;
    } else if (arg === "--no-companella") {
      options.noCompanella = true;
    } else if (arg === "--rate") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0.4 || value >= 2.5) usage();
      options.rate = value;
    } else if (arg === "--cache-dir") {
      const value = argv[++i];
      if (!value) usage();
      options.cacheDir = value;
    } else if (arg === "--set" || arg === "--sets" || arg === "--beatmapset" || arg === "--beatmapsets") {
      options.beatmapsetIds = appendNumberTargets(options.beatmapsetIds, parseNumberList(argv[++i], arg));
    } else if (arg === "--beatmap" || arg === "--beatmaps") {
      options.beatmapIds = new Set([
        ...(options.beatmapIds ?? []),
        ...parseNumberList(argv[++i], arg),
      ]);
    } else if (arg === "--expected" || arg === "--label") {
      options.expectedLabels = parseStringSet(argv[++i]);
    } else if (arg === "--match") {
      options.matchKinds = parseMatchKinds(argv[++i]);
    } else if (arg === "--grep") {
      const value = argv[++i];
      if (!value) usage();
      options.grepText = value;
    } else if (arg === "--failures-from") {
      const value = argv[++i];
      if (!value) usage();
      options.failuresFrom = value;
    } else if (arg === "--show-changes") {
      const value = argv[++i];
      if (!value) usage();
      options.showChangesFrom = value;
    } else if (arg === "--compare") {
      const before = argv[++i];
      const after = argv[++i];
      if (!before || !after) usage();
      options.compareFiles = [before, after];
    } else if (arg === "--summary-by-set") {
      options.summaryBySet = true;
    } else if (arg === "--explain-wrong") {
      options.explainWrong = true;
    } else if (arg === "--neighbors") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) usage();
      options.neighbors = value;
    } else {
      usage();
    }
  }

  return options;
}

function splitVariant(label: string): { base: string; variant: string } {
  const match = label.match(/^(.+?)(\+\+|--|\+|-)?$/);
  if (!match) return { base: label, variant: "" };
  return { base: match[1], variant: match[2] ?? "" };
}

async function runClassifier(
  classifier: ClassifierId,
  family: DanBenchmarkFamily,
  text: string,
  rate: number,
  starRating: number | null,
  beatmapId: number | null,
  noCompanella: boolean,
): Promise<{ estimate: DanEstimate; map: ManiaBeatmap; version: string; title: string; artist: string }> {
  const map = parseManiaBeatmap(text);
  if (map.keyCount !== 4) {
    throw new Error(`beatmap ${beatmapId ?? "?"} is ${map.keyCount}K, benchmark requires 4K`);
  }
  const input = {
    rate,
    starRating: starRating ?? 0,
    totalLength: map.totalLength / 1000,
    title: map.title,
    version: map.version,
  };
  let estimate: DanEstimate;
  if (classifier === "unified") {
    const classifyInput = { ...input, preferFamily: (family === "ln" ? "ln" : "rc") as "ln" | "rc" };
    // --no-companella reproduces the pre-Companella verdicts (the Sunny
    // fallback on the 4K LN-hybrid slice), so the two runs can be --compare'd.
    const classification = noCompanella
      ? classifyChart(map, text, classifyInput)
      : await classifyChartWithCompanella(map, text, classifyInput);
    if (!classification.estimate) {
      throw new Error(`unified classifier produced no dan verdict (${classification.verdictText ?? "no verdict"})`);
    }
    estimate = classification.estimate;
  } else if (classifier === "daniel") {
    estimate = estimateDanielDan(map, input);
  } else if (classifier === "leoblack") {
    estimate = estimateLeoBlackDan(map, text, { ...input, preferFamily: family === "ln" ? "ln" : "rc" });
  } else {
    estimate = estimateDan(map, input);
  }
  return { estimate, map, version: map.version, title: map.title, artist: map.artist };
}

function liveBackendBase(): string | null {
  const base = process.env.LIVE_BACKEND_URL?.trim();
  if (!base || !process.env.LIVE_ADMIN_TOKEN) return null;
  return base.replace(/\/$/, "");
}

async function fetchDanBenchmark<T>(path: string): Promise<T> {
  const base = liveBackendBase();
  if (!base) throw new Error("LIVE_BACKEND_URL / LIVE_ADMIN_TOKEN missing.");
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${process.env.LIVE_ADMIN_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Dan benchmark fetch failed (${response.status}) for ${path}`);
  return await response.json() as T;
}

async function loadExpectedLabels(family: DanBenchmarkFamily): Promise<Map<number, string>> {
  const payload = await fetchDanBenchmark<{ labels: Array<{ beatmapId: number; expectedLabel: string }> }>(
    `/api/admin/dan-benchmark/labels?family=${family}`,
  );
  return new Map(payload.labels.map((label) => [label.beatmapId, label.expectedLabel]));
}

async function loadHiddenDiffs(family: DanBenchmarkFamily): Promise<Set<number>> {
  const payload = await fetchDanBenchmark<{ hidden: number[] }>(
    `/api/admin/dan-benchmark/hidden?family=${family}`,
  );
  return new Set(payload.hidden);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

interface DiffWork {
  beatmapsetId: number;
  meta: BeatmapMeta;
  expected: string | null;
}

async function fetchSet(
  beatmapsetId: number,
  cacheDir: string,
): Promise<{ beatmapsetId: number; metas: BeatmapMeta[]; apiData: CatboyBeatmapset | null; error: string | null }> {
  try {
    const buffer = await downloadBeatmapset(beatmapsetId, cacheDir);
    let apiData = await fetchCatboyBeatmapset(beatmapsetId);
    let metas = await extractOsz(buffer, String(beatmapsetId), apiData);
    if (!apiData && metas[0]) {
      const map = parseManiaBeatmap(metas[0].text);
      apiData = await fetchCatboyBeatmapsetByTitle(beatmapsetId, map.title);
      metas = await extractOsz(buffer, String(beatmapsetId), apiData);
    }
    return { beatmapsetId, metas, apiData, error: null };
  } catch (error) {
    return {
      beatmapsetId,
      metas: [],
      apiData: null,
      error: error instanceof Error ? error.message : "Failed to fetch beatmapset.",
    };
  }
}

function computeMatch(predicted: string | null, expected: string | null, predictedBase: string | null): MatchKind {
  if (!expected) return "unlabeled";
  if (!predicted) return "wrong";
  if (predicted === expected) return "exact";
  const expectedBase = splitVariant(expected).base;
  if (predictedBase && predictedBase === expectedBase) return "base";
  return "wrong";
}

interface FailureTargets {
  family: DanBenchmarkFamily | null;
  beatmapsetIds: number[];
  beatmapIds: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function loadFailureTargets(filePath: string): Promise<FailureTargets> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.sets)) {
    throw new Error(`--failures-from expects a JSON file emitted by dan:benchmark --json: ${filePath}`);
  }

  const family = parsed.family === "normal" || parsed.family === "ln" || parsed.family === "ranked" ? parsed.family : null;
  const beatmapsetIds: number[] = [];
  const beatmapIds: number[] = [];
  for (const set of parsed.sets) {
    if (!isRecord(set) || !Array.isArray(set.rows)) continue;
    const setId = Number(set.beatmapsetId);
    let hasFailure = false;
    for (const row of set.rows) {
      if (!isRecord(row)) continue;
      if (row.match !== "wrong" && !row.error) continue;
      const beatmapId = Number(row.beatmapId);
      if (Number.isInteger(beatmapId) && beatmapId > 0) {
        beatmapIds.push(beatmapId);
        hasFailure = true;
      }
    }
    if (hasFailure && Number.isInteger(setId) && setId > 0) beatmapsetIds.push(setId);
  }

  return {
    family,
    beatmapsetIds: [...new Set(beatmapsetIds)],
    beatmapIds: [...new Set(beatmapIds)],
  };
}

async function loadBenchmarkJson(filePath: string): Promise<BenchmarkJson> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.sets)) {
    throw new Error(`Expected a JSON file emitted by dan:benchmark --json: ${filePath}`);
  }
  return parsed as unknown as BenchmarkJson;
}

function rowKey(set: SetResult, row: RowResult): string {
  return row.beatmapId != null ? `beatmap:${row.beatmapId}` : `set:${set.beatmapsetId}:${row.version}`;
}

function isOkMatch(match: MatchKind): boolean {
  return match === "exact" || match === "base";
}

function flattenRows(sets: SetResult[]): RowWithSet[] {
  return sets.flatMap((set) => set.rows.map((row) => ({ set, row })));
}

function filterSetsByText(sets: SetResult[], text: string | null): SetResult[] {
  const query = text?.trim().toLowerCase();
  if (!query) return sets;
  return sets
    .map((set) => {
      const setText = `${set.title ?? ""} ${set.artist ?? ""}`.toLowerCase();
      return {
        ...set,
        rows: set.rows.filter((row) => `${setText} ${row.version}`.toLowerCase().includes(query)),
      };
    })
    .filter((set) => set.error || set.rows.length > 0);
}

function compareRows(beforeSets: SetResult[], afterSets: SetResult[]): ChangedRow[] {
  const beforeByKey = new Map(flattenRows(beforeSets).map(({ set, row }) => [rowKey(set, row), { set, row }]));
  const changes: ChangedRow[] = [];

  for (const { set, row: after } of flattenRows(afterSets)) {
    const beforeEntry = beforeByKey.get(rowKey(set, after));
    if (!beforeEntry) continue;
    const before = beforeEntry.row;
    const changedPrediction = before.predicted !== after.predicted
      || before.predictedFamily !== after.predictedFamily
      || before.match !== after.match;
    if (!changedPrediction) continue;

    const beforeOk = isOkMatch(before.match);
    const afterOk = isOkMatch(after.match);
    const direction: ChangedRow["direction"] = !beforeOk && afterOk
      ? "wrong-to-ok"
      : beforeOk && !afterOk
        ? "ok-to-wrong"
        : beforeOk !== afterOk
          ? "changed-correctness"
          : "changed-prediction";

    changes.push({
      beatmapsetId: set.beatmapsetId,
      beatmapId: after.beatmapId,
      version: after.version || before.version,
      expected: after.expected ?? before.expected,
      before: {
        predicted: before.predicted,
        family: before.predictedFamily,
        match: before.match,
        srProxy: before.predictedSrProxy,
      },
      after: {
        predicted: after.predicted,
        family: after.predictedFamily,
        match: after.match,
        srProxy: after.predictedSrProxy,
      },
      direction,
    });
  }

  return changes;
}

function comparableDanLabel(estimate: DanEstimate): string {
  return `${estimate.label}${estimate.variant ?? ""}`;
}

function pad(value: unknown, width: number, align: "left" | "right" = "left"): string {
  const text = String(value ?? "");
  if (text.length >= width) return text.length === width ? text : text.slice(0, width - 1) + "…";
  return align === "right" ? text.padStart(width, " ") : text.padEnd(width, " ");
}

function formatStars(value: number | null): string {
  return value == null ? "-" : value.toFixed(2);
}

function fmt(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function quantile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function maxCountInWindow(times: number[], windowMs: number): number {
  let best = 0;
  let left = 0;
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > windowMs) left++;
    best = Math.max(best, right - left + 1);
  }
  return best;
}

function lnDistributionStats(map: ManiaBeatmap, rate: number): BenchmarkDiagnostics["lnStats"] {
  const holdDurations = map.notes
    .filter((note) => note.isHold && note.endTime > note.time)
    .map((note) => (note.endTime - note.time) / rate);
  const releaseTimes = map.notes
    .filter((note) => note.isHold && note.endTime > note.time)
    .map((note) => note.endTime / rate)
    .sort((left, right) => left - right);
  const releaseGaps = releaseTimes.slice(1).map((time, index) => time - releaseTimes[index]);

  return {
    holdMs: {
      avg: fmt(holdDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, holdDurations.length), 1),
      p50: fmt(quantile(holdDurations, 0.5), 1),
      p90: fmt(quantile(holdDurations, 0.9), 1),
      p95: fmt(quantile(holdDurations, 0.95), 1),
      max: fmt(Math.max(0, ...holdDurations), 1),
    },
    releases: {
      peak1s: maxCountInWindow(releaseTimes, 1000),
      peak2s: maxCountInWindow(releaseTimes, 2000),
      gapP10Ms: fmt(quantile(releaseGaps, 0.1), 1),
      gapP50Ms: fmt(quantile(releaseGaps, 0.5), 1),
      gapP90Ms: fmt(quantile(releaseGaps, 0.9), 1),
    },
  };
}

function rawNoteGaps(map: ManiaBeatmap, minGapMs = 4500): Array<{ start: number; end: number; duration: number }> {
  const notes = [...map.notes].sort((left, right) => left.time - right.time);
  const gaps: Array<{ start: number; end: number; duration: number }> = [];
  for (let index = 0; index < notes.length - 1; index++) {
    const currentEnd = Math.max(notes[index].time, notes[index].endTime);
    const nextStart = notes[index + 1].time;
    if (nextStart - currentEnd >= minGapMs) gaps.push({ start: currentEnd, end: nextStart, duration: nextStart - currentEnd });
  }
  return gaps;
}

function segmentationSummary(map: ManiaBeatmap): BenchmarkDiagnostics["segmentation"] {
  const rawGaps = rawNoteGaps(map);
  const explicitBreaks = map.breakPeriods.filter((period) => period.endTime > period.startTime);
  return {
    explicitBreaks: explicitBreaks.length,
    rawGaps: rawGaps.length,
    rawGapMs: rawGaps.map((gap) => fmt(gap.duration, 1)),
    likelyRawGapCourse: rawGaps.length === 3,
  };
}

function lnReferenceDeltas(
  metrics: DanFeatureMetrics,
  rate: number,
  durationSeconds: number,
  neighbor: ReturnType<typeof getLnReferenceNeighbors>[number],
): BenchmarkDiagnostics["lnNeighbors"][number]["delta"] {
  const comparison = getLnReferenceComparisonMetrics(metrics, rate);
  const reference = neighbor.metrics;
  return {
    duration: fmt(durationSeconds - reference.s, 1),
    notes: metrics.noteCount - reference.n,
    release: fmt(comparison.lnReleasePressure - reference.r, 3),
    density: fmt(comparison.lnDensity - reference.d, 4),
    peak5: fmt(comparison.peakNps5s - reference.p, 2),
    sustain10: fmt(comparison.sustainedNps10s - reference.u, 2),
    chordRatio: fmt(comparison.chordRatio - reference.q, 4),
  };
}

function topSkillScores(scores: Record<string, number>): BenchmarkDiagnostics["topSkillScores"] {
  return Object.entries(scores)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 4)
    .map(([family, score]) => ({ family, score: fmt(score, 3) }));
}

function buildDiagnostics(map: ManiaBeatmap, estimate: DanEstimate, rate: number, neighbors: number): BenchmarkDiagnostics {
  const metrics = estimate.metrics;
  const durationSeconds = (map.totalLength / 1000) / rate;
  return {
    reason: estimate.debug?.familyChoice.reason ?? null,
    notes: metrics.noteCount,
    holds: map.notes.filter((note) => note.isHold).length,
    duration: fmt(durationSeconds, 1),
    holdRatio: fmt(metrics.holdRatio, 4),
    chordRatio: fmt(metrics.chordRatio, 4),
    peak5: fmt(metrics.peakNps5s),
    sustain10: fmt(metrics.sustainedNps10s),
    lnRelease: fmt(metrics.lnReleasePressure),
    lnDensity: fmt(metrics.lnDensity, 4),
    lnOverlap: fmt(metrics.lnOverlapPressure),
    lnChord: fmt(metrics.lnChordPressure, 4),
    lnP90: fmt(metrics.lnHoldDurationP90, 1),
    lnStats: lnDistributionStats(map, rate),
    segmentation: segmentationSummary(map),
    topSkillScores: topSkillScores(estimate.skillScores),
    warnings: estimate.warnings,
    lnNeighbors: getLnReferenceNeighbors(metrics, rate, neighbors, durationSeconds).map((neighbor) => ({
      level: neighbor.level,
      distance: fmt(neighbor.distance, 3),
      n: neighbor.metrics.n,
      duration: neighbor.metrics.s,
      release: neighbor.metrics.r,
      density: neighbor.metrics.d,
      peak5: neighbor.metrics.p,
      sustain10: neighbor.metrics.u,
      delta: lnReferenceDeltas(metrics, rate, durationSeconds, neighbor),
    })),
  };
}

function matchSymbol(kind: MatchKind): string {
  switch (kind) {
    case "exact": return "OK";
    case "base":  return "~";
    case "wrong": return "X";
    case "unlabeled": return "?";
  }
}

function describeActiveFilters(options: CliOptions): string[] {
  const filters: string[] = [];
  if (options.beatmapsetIds) filters.push(`sets ${options.beatmapsetIds.join(",")}`);
  if (options.beatmapIds) filters.push(`beatmaps ${[...options.beatmapIds].join(",")}`);
  if (options.expectedLabels) filters.push(`expected ${[...options.expectedLabels].join(",")}`);
  if (options.matchKinds) filters.push(`match ${[...options.matchKinds].join(",")}`);
  if (options.grepText) filters.push(`grep ${options.grepText}`);
  if (options.failuresFrom) filters.push(`failures from ${options.failuresFrom}`);
  if (options.showChangesFrom) filters.push(`show changes from ${options.showChangesFrom}`);
  return filters;
}

function signed(value: number, digits = 2): string {
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

function compactPair(label: string, value: unknown): string {
  return `${label} ${value}`;
}

function accuracyPct(summary: ReturnType<typeof summarize>): { exactPct: number; basePct: number } {
  return {
    exactPct: summary.labeled > 0 ? (summary.exact / summary.labeled) * 100 : 0,
    basePct: summary.labeled > 0 ? ((summary.exact + summary.base) / summary.labeled) * 100 : 0,
  };
}

function formatSummary(summary: ReturnType<typeof summarize>): string {
  const pct = accuracyPct(summary);
  return `${summary.exact} exact + ${summary.base} base / ${summary.labeled} labeled, ${summary.wrong} wrong (${pct.basePct.toFixed(2)}% base)`;
}

function printSummaryBySet(sets: SetResult[]): void {
  const rows = sets
    .map((set) => {
      const summary = summarize([set]);
      const pct = accuracyPct(summary);
      const title = set.title ? `${set.artist ? `${set.artist} - ` : ""}${set.title}` : `Beatmapset ${set.beatmapsetId}`;
      return { set, summary, pct, title };
    })
    .filter(({ summary, set }) => set.error || summary.total > 0);

  if (rows.length === 0) return;

  const widths = { set: 10, title: 42, exact: 7, base: 7, wrong: 7, pct: 9 };
  process.stdout.write("\nSummary by set\n");
  process.stdout.write("==============\n");
  process.stdout.write([
    pad("Set", widths.set, "right"),
    pad("Title", widths.title),
    pad("Exact", widths.exact, "right"),
    pad("Base", widths.base, "right"),
    pad("Wrong", widths.wrong, "right"),
    pad("Base %", widths.pct, "right"),
  ].join("  ") + "\n");
  process.stdout.write("-".repeat(widths.set + widths.title + widths.exact + widths.base + widths.wrong + widths.pct + 10) + "\n");
  for (const { set, summary, pct, title } of rows) {
    process.stdout.write([
      pad(set.beatmapsetId, widths.set, "right"),
      pad(title, widths.title),
      pad(summary.exact, widths.exact, "right"),
      pad(summary.base, widths.base, "right"),
      pad(summary.wrong, widths.wrong, "right"),
      pad(`${pct.basePct.toFixed(1)}%`, widths.pct, "right"),
    ].join("  ") + "\n");
  }
}

function compareSetSummaries(beforeSets: SetResult[], afterSets: SetResult[]) {
  const beforeById = new Map(beforeSets.map((set) => [set.beatmapsetId, set]));
  const afterById = new Map(afterSets.map((set) => [set.beatmapsetId, set]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort((left, right) => left - right);

  return ids.map((id) => {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    const beforeSummary = summarize(before ? [before] : []);
    const afterSummary = summarize(after ? [after] : []);
    const beforePct = accuracyPct(beforeSummary);
    const afterPct = accuracyPct(afterSummary);
    return {
      beatmapsetId: id,
      title: after?.title ?? before?.title ?? null,
      artist: after?.artist ?? before?.artist ?? null,
      before: { ...beforeSummary, ...beforePct },
      after: { ...afterSummary, ...afterPct },
      delta: {
        exact: afterSummary.exact - beforeSummary.exact,
        base: afterSummary.base - beforeSummary.base,
        wrong: afterSummary.wrong - beforeSummary.wrong,
        basePct: afterPct.basePct - beforePct.basePct,
      },
    };
  });
}

function printCompareSummaryBySet(beforeSets: SetResult[], afterSets: SetResult[]): void {
  const summaries = compareSetSummaries(beforeSets, afterSets);
  if (summaries.length === 0) return;

  const widths = { set: 10, title: 38, before: 12, after: 12, delta: 10 };
  process.stdout.write("\nSummary by set\n");
  process.stdout.write("==============\n");
  process.stdout.write([
    pad("Set", widths.set, "right"),
    pad("Title", widths.title),
    pad("Before", widths.before, "right"),
    pad("After", widths.after, "right"),
    pad("Delta", widths.delta, "right"),
  ].join("  ") + "\n");
  process.stdout.write("-".repeat(widths.set + widths.title + widths.before + widths.after + widths.delta + 8) + "\n");

  for (const summary of summaries) {
    const title = summary.title ? `${summary.artist ? `${summary.artist} - ` : ""}${summary.title}` : `Beatmapset ${summary.beatmapsetId}`;
    process.stdout.write([
      pad(summary.beatmapsetId, widths.set, "right"),
      pad(title, widths.title),
      pad(`${summary.before.basePct.toFixed(1)}%`, widths.before, "right"),
      pad(`${summary.after.basePct.toFixed(1)}%`, widths.after, "right"),
      pad(signed(summary.delta.basePct, 1), widths.delta, "right"),
    ].join("  ") + "\n");
  }
}

function printChanges(changes: ChangedRow[], heading = "Prediction changes"): void {
  if (changes.length === 0) {
    process.stdout.write(`\n${heading}: none\n`);
    return;
  }

  const widths = { id: 10, set: 10, diff: 32, expected: 10, before: 15, after: 15, match: 16 };
  process.stdout.write(`\n${heading}\n`);
  process.stdout.write("=".repeat(heading.length) + "\n");
  process.stdout.write([
    pad("Beatmap", widths.id, "right"),
    pad("Set", widths.set, "right"),
    pad("Diff", widths.diff),
    pad("Expected", widths.expected),
    pad("Before", widths.before),
    pad("After", widths.after),
    pad("Match", widths.match),
  ].join("  ") + "\n");
  process.stdout.write("-".repeat(widths.id + widths.set + widths.diff + widths.expected + widths.before + widths.after + widths.match + 12) + "\n");

  for (const change of changes) {
    const before = `${change.before.predicted ?? "-"}${change.before.family ? `/${change.before.family}` : ""}`;
    const after = `${change.after.predicted ?? "-"}${change.after.family ? `/${change.after.family}` : ""}`;
    process.stdout.write([
      pad(change.beatmapId ?? "-", widths.id, "right"),
      pad(change.beatmapsetId, widths.set, "right"),
      pad(change.version || "-", widths.diff),
      pad(change.expected ?? "-", widths.expected),
      pad(before, widths.before),
      pad(after, widths.after),
      pad(`${change.before.match}->${change.after.match}`, widths.match),
    ].join("  ") + "\n");
  }
}

function printComparison(before: BenchmarkJson, after: BenchmarkJson, options: CliOptions): void {
  const beforeSets = filterSetsByText(before.sets, options.grepText);
  const afterSets = filterSetsByText(after.sets, options.grepText);
  const beforeSummary = summarize(beforeSets);
  const afterSummary = summarize(afterSets);
  const changes = compareRows(beforeSets, afterSets);
  const wrongToOk = changes.filter((change) => change.direction === "wrong-to-ok").length;
  const okToWrong = changes.filter((change) => change.direction === "ok-to-wrong").length;

  if (options.json) {
    process.stdout.write(JSON.stringify({
      before: {
        family: before.family,
        classifier: before.classifier,
        rate: before.rate,
        summary: { ...beforeSummary, ...accuracyPct(beforeSummary) },
      },
      after: {
        family: after.family,
        classifier: after.classifier,
        rate: after.rate,
        summary: { ...afterSummary, ...accuracyPct(afterSummary) },
      },
      delta: {
        exact: afterSummary.exact - beforeSummary.exact,
        base: afterSummary.base - beforeSummary.base,
        wrong: afterSummary.wrong - beforeSummary.wrong,
        basePct: accuracyPct(afterSummary).basePct - accuracyPct(beforeSummary).basePct,
        wrongToOk,
        okToWrong,
      },
      changes,
      setSummaries: options.summaryBySet ? compareSetSummaries(beforeSets, afterSets) : undefined,
    }, null, 2) + "\n");
    return;
  }

  process.stdout.write("Benchmark comparison\n");
  process.stdout.write("====================\n");
  if (options.grepText) process.stdout.write(`Filter: ${options.grepText}\n`);
  process.stdout.write(`Before: ${formatSummary(beforeSummary)}\n`);
  process.stdout.write(`After:  ${formatSummary(afterSummary)}\n`);
  process.stdout.write(`Delta:  exact ${signed(afterSummary.exact - beforeSummary.exact, 0)}, base ${signed(afterSummary.base - beforeSummary.base, 0)}, wrong ${signed(afterSummary.wrong - beforeSummary.wrong, 0)}, base% ${signed(accuracyPct(afterSummary).basePct - accuracyPct(beforeSummary).basePct, 2)}\n`);
  process.stdout.write(`Changed rows: ${changes.length}; wrong->ok ${wrongToOk}; ok->wrong ${okToWrong}\n`);
  if (options.summaryBySet) printCompareSummaryBySet(beforeSets, afterSets);
  printChanges(changes);
}

function printTable(sets: SetResult[], options: CliOptions, summary: ReturnType<typeof summarize>): void {
  const widths = { id: 10, diff: 28, sr: 6, expected: 10, predicted: 12, match: 5 };
  const header = [
    pad("Beatmap", widths.id, "right"),
    pad("Diff", widths.diff),
    pad("SR", widths.sr, "right"),
    pad("Expected", widths.expected),
    pad("Predicted", widths.predicted),
    pad("Match", widths.match),
  ].join("  ");
  const divider = "-".repeat(header.length);

  process.stdout.write(`Family: ${options.family}  Classifier: ${options.classifier}  Rate: ${options.rate}\n`);
  const activeFilters = describeActiveFilters(options);
  if (activeFilters.length > 0) process.stdout.write(`Filters: ${activeFilters.join(" | ")}\n`);
  process.stdout.write("\n");

  for (const set of sets) {
    const title = set.title ? `${set.artist ? `${set.artist} - ` : ""}${set.title}` : `Beatmapset ${set.beatmapsetId}`;
    process.stdout.write(`# ${set.beatmapsetId}  ${title}\n`);
    if (set.error) {
      process.stdout.write(`  ! ${set.error}\n\n`);
      continue;
    }
    if (set.rows.length === 0) {
      process.stdout.write(`  (no visible 4K mania diffs)\n\n`);
      continue;
    }
    process.stdout.write(`  ${header}\n`);
    process.stdout.write(`  ${divider}\n`);
    for (const row of set.rows) {
      const diffLabel = row.error ? `${row.version}  [${row.error}]` : row.version;
      process.stdout.write(`  ${[
        pad(row.beatmapId ?? "-", widths.id, "right"),
        pad(diffLabel, widths.diff),
        pad(formatStars(row.starRating), widths.sr, "right"),
        pad(row.expected ?? "-", widths.expected),
        pad(row.predicted ?? "-", widths.predicted),
        pad(matchSymbol(row.match), widths.match),
      ].join("  ")}\n`);
    }
    process.stdout.write("\n");
  }

  const exactPct = summary.labeled > 0 ? (summary.exact / summary.labeled) * 100 : 0;
  const basePct = summary.labeled > 0 ? ((summary.exact + summary.base) / summary.labeled) * 100 : 0;
  process.stdout.write(
    `Summary: ${summary.total} diffs, ${summary.labeled} labeled, ` +
    `${summary.exact} exact + ${summary.base} base, ${summary.wrong} wrong` +
    (summary.errors > 0 ? `, ${summary.errors} errors` : "") +
    (summary.unlabeled > 0 ? `, ${summary.unlabeled} unlabeled` : "") +
    `\n`,
  );
  process.stdout.write(
    `Accuracy: ${exactPct.toFixed(1)}% exact, ${basePct.toFixed(1)}% base-or-better\n`,
  );
}

function printWrongExplanations(sets: SetResult[]): void {
  const wrongRows = sets.flatMap((set) => set.rows
    .filter((row) => row.match === "wrong" && row.diagnostics)
    .map((row) => ({ set, row, diagnostics: row.diagnostics! })));

  if (wrongRows.length === 0) return;

  process.stdout.write("\nWrong-row diagnostics\n");
  process.stdout.write("=====================\n");
  for (const [index, { set, row, diagnostics }] of wrongRows.entries()) {
    const title = set.title ? `${set.artist ? `${set.artist} - ` : ""}${set.title}` : `Beatmapset ${set.beatmapsetId}`;
    if (index > 0) process.stdout.write("\n");
    process.stdout.write(`${title} [${row.version}]${row.beatmapId ? ` (#${row.beatmapId})` : ""}\n`);
    process.stdout.write(`Expected ${row.expected ?? "-"} | predicted ${row.predicted ?? "-"} | raw ${row.predictedRawDan?.toFixed(4) ?? "-"} | confidence ${row.predictedConfidence?.toFixed(3) ?? "-"} | ${diagnostics.reason ?? "unknown"}\n`);
    process.stdout.write(`Chart: ${[
      compactPair("SR", formatStars(row.starRating)),
      compactPair("duration", `${diagnostics.duration}s`),
      compactPair("notes", diagnostics.notes),
      compactPair("holds", diagnostics.holds),
      compactPair("hold%", diagnostics.holdRatio),
      compactPair("chord%", diagnostics.chordRatio),
    ].join(" | ")}\n`);
    process.stdout.write(`Pressure: ${[
      compactPair("peak5", diagnostics.peak5),
      compactPair("sustain10", diagnostics.sustain10),
      compactPair("release", diagnostics.lnRelease),
      compactPair("density", diagnostics.lnDensity),
      compactPair("overlap", diagnostics.lnOverlap),
      compactPair("lnChord", diagnostics.lnChord),
    ].join(" | ")}\n`);
    process.stdout.write(`LN distribution: holds avg ${diagnostics.lnStats.holdMs.avg}ms, p50 ${diagnostics.lnStats.holdMs.p50}ms, p90 ${diagnostics.lnStats.holdMs.p90}ms, p95 ${diagnostics.lnStats.holdMs.p95}ms, max ${diagnostics.lnStats.holdMs.max}ms\n`);
    process.stdout.write(`Releases: peak1s ${diagnostics.lnStats.releases.peak1s}, peak2s ${diagnostics.lnStats.releases.peak2s}, gaps p10/p50/p90 ${diagnostics.lnStats.releases.gapP10Ms}/${diagnostics.lnStats.releases.gapP50Ms}/${diagnostics.lnStats.releases.gapP90Ms}ms\n`);
    process.stdout.write(`Segmentation: explicit breaks ${diagnostics.segmentation.explicitBreaks}, raw gaps ${diagnostics.segmentation.rawGaps}, likely raw-gap course ${diagnostics.segmentation.likelyRawGapCourse ? "yes" : "no"}\n`);
    if (diagnostics.segmentation.rawGapMs.length > 0) {
      process.stdout.write(`Raw gaps: ${diagnostics.segmentation.rawGapMs.slice(0, 8).map((gap) => `${gap}ms`).join(", ")}${diagnostics.segmentation.rawGapMs.length > 8 ? ", ..." : ""}\n`);
    }
    process.stdout.write(`Top families: ${diagnostics.topSkillScores.map((score) => `${score.family} ${score.score}`).join(" | ")}\n`);
    if (diagnostics.warnings.length > 0) process.stdout.write(`Warnings: ${diagnostics.warnings.join(" | ")}\n`);

    if (diagnostics.lnNeighbors.length > 0) {
      process.stdout.write("Nearest LN references:\n");
      for (const neighbor of diagnostics.lnNeighbors) {
        process.stdout.write(`  LN ${neighbor.level} dist ${neighbor.distance} | ref notes ${neighbor.n}, dur ${neighbor.duration}s, rel ${neighbor.release}, dens ${neighbor.density}, peak5 ${neighbor.peak5}, s10 ${neighbor.sustain10}\n`);
        process.stdout.write(`    delta: dur ${signed(neighbor.delta.duration, 1)}s, notes ${signed(neighbor.delta.notes, 0)}, rel ${signed(neighbor.delta.release)}, dens ${signed(neighbor.delta.density, 4)}, peak5 ${signed(neighbor.delta.peak5)}, s10 ${signed(neighbor.delta.sustain10)}, chord ${signed(neighbor.delta.chordRatio, 4)}\n`);
      }
    }
  }
}

function summarize(sets: SetResult[]) {
  let total = 0, labeled = 0, exact = 0, base = 0, wrong = 0, unlabeled = 0, errors = 0;
  for (const set of sets) {
    for (const row of set.rows) {
      total += 1;
      if (row.error) errors += 1;
      if (row.match === "unlabeled") unlabeled += 1;
      else {
        labeled += 1;
        if (row.match === "exact") exact += 1;
        else if (row.match === "base") base += 1;
        else wrong += 1;
      }
    }
  }
  return { total, labeled, exact, base, wrong, unlabeled, errors };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.compareFiles) {
    const [before, after] = await Promise.all([
      loadBenchmarkJson(options.compareFiles[0]),
      loadBenchmarkJson(options.compareFiles[1]),
    ]);
    printComparison(before, after, options);
    return;
  }

  if (options.failuresFrom) {
    const targets = await loadFailureTargets(options.failuresFrom);
    if (targets.family && !options.familySpecified) options.family = targets.family;
    options.beatmapsetIds = appendNumberTargets(options.beatmapsetIds, targets.beatmapsetIds);
    options.beatmapIds = new Set([...(options.beatmapIds ?? []), ...targets.beatmapIds]);
  }

  if (!liveBackendBase()) {
    process.stderr.write(
      "ERROR: live backend credentials missing. Set LIVE_BACKEND_URL and LIVE_ADMIN_TOKEN " +
      "in .env. Expected labels are loaded from the backend dan_benchmark_labels table.\n",
    );
    process.exit(1);
  }

  const beatmapsetIds = options.beatmapsetIds ?? getBenchmarkBeatmapsetIds(options.family);
  const benchmarkBeatmapIds = options.beatmapIds ?? getBenchmarkBeatmapIds(options.family);
  const includeUnlabeled = options.includeUnlabeled || options.family === "ranked";
  const [expectedLabels, hiddenDiffs] = await Promise.all([
    loadExpectedLabels(options.family),
    loadHiddenDiffs(options.family),
  ]);

  // build the flat work list (one entry per visible 4K diff) so we can run
  // estimates with bounded concurrency across all sets at once
  const work: Array<{ setIndex: number; rowIndex: number } & DiffWork> = [];
  let setShells: SetResult[];

  if (options.family === "ranked" && !options.beatmapsetIds) {
    const rankedBeatmapIds = RANKED_BENCHMARK_BEATMAP_IDS.filter((beatmapId) =>
      !benchmarkBeatmapIds || benchmarkBeatmapIds.has(beatmapId),
    );
    const fetchedRanked = await mapWithConcurrency(rankedBeatmapIds, 4, async (beatmapId) => {
      try {
        const text = await fetchBeatmapFile(beatmapId);
        const setIdMatch = text.match(/^BeatmapSetID\s*:\s*(\d+)/m);
        return {
          beatmapId,
          beatmapsetId: setIdMatch ? Number(setIdMatch[1]) : beatmapId,
          meta: {
            beatmapId,
            source: String(beatmapId),
            starRating: getBenchmarkBeatmapStarRating(beatmapId),
            text,
          } satisfies BeatmapMeta,
          error: null as string | null,
        };
      } catch (error) {
        return {
          beatmapId,
          beatmapsetId: beatmapId,
          meta: null,
          error: error instanceof Error ? error.message : "Failed to fetch beatmap.",
        };
      }
    });

    setShells = fetchedRanked.map((entry, setIndex) => {
      const shell: SetResult = {
        beatmapsetId: entry.beatmapsetId,
        title: null,
        artist: null,
        rows: [],
        error: entry.error,
      };
      if (!entry.meta || entry.error) return shell;
      if (hiddenDiffs.has(entry.beatmapId)) return shell;
      const expected = expectedLabels.get(entry.beatmapId) ?? null;
      if (options.expectedLabels && (!expected || !options.expectedLabels.has(expected))) return shell;
      const rowIndex = shell.rows.length;
      shell.rows.push({
        beatmapId: entry.beatmapId,
        version: "",
        starRating: entry.meta.starRating,
        expected,
        predicted: null,
        predictedFamily: null,
        predictedConfidence: null,
        predictedRawDan: null,
        predictedSrProxy: null,
        match: "unlabeled",
        error: null,
      });
      work.push({ setIndex, rowIndex, beatmapsetId: entry.beatmapsetId, meta: entry.meta, expected });
      return shell;
    });
  } else {
    const fetched = await mapWithConcurrency(beatmapsetIds, 4, (id) => fetchSet(id, options.cacheDir));
    setShells = fetched.map((set, setIndex) => {
      if (set.error) {
        return {
          beatmapsetId: set.beatmapsetId,
          title: null,
          artist: null,
          rows: [],
          error: set.error,
        };
      }
      const shell: SetResult = {
        beatmapsetId: set.beatmapsetId,
        title: null,
        artist: null,
        rows: [],
        error: null,
      };
      for (const meta of set.metas) {
        if (meta.beatmapId == null) continue;
        const explicitlyTargetedBeatmap = benchmarkBeatmapIds?.has(meta.beatmapId) ?? false;
        if (benchmarkBeatmapIds && !explicitlyTargetedBeatmap) continue;
        if (hiddenDiffs.has(meta.beatmapId)) continue;
        const version = parseBeatmapVersion(meta.text);
        const expected = getBenchmarkExpectedLabelOverride(options.family, set.beatmapsetId, meta.beatmapId, version)
          ?? expectedLabels.get(meta.beatmapId)
          ?? null;
        if (options.expectedLabels && (!expected || !options.expectedLabels.has(expected))) continue;
        const shouldIncludeUnlabeled = includeUnlabeled
          || explicitlyTargetedBeatmap
          || (options.matchKinds?.has("unlabeled") ?? false);
        if (!expected && !shouldIncludeUnlabeled) continue;
        const rowIndex = shell.rows.length;
        shell.rows.push({
          beatmapId: meta.beatmapId,
          version,
          starRating: meta.starRating,
          expected,
          predicted: null,
          predictedFamily: null,
          predictedConfidence: null,
          predictedRawDan: null,
          predictedSrProxy: null,
          match: "unlabeled",
          error: null,
        });
        work.push({ setIndex, rowIndex, beatmapsetId: set.beatmapsetId, meta, expected });
      }
      return shell;
    });
  }

  await mapWithConcurrency(work, 4, async ({ setIndex, rowIndex, meta }) => {
    const target = setShells[setIndex].rows[rowIndex];
    try {
      const { estimate, map, version, title, artist } = await runClassifier(
        options.classifier,
        options.family,
        meta.text,
        options.rate,
        meta.starRating,
        meta.beatmapId,
        options.noCompanella,
      );
      target.version = version;
      target.predicted = estimate.displayName;
      target.predictedFamily = estimate.family;
      target.predictedConfidence = estimate.confidence;
      target.predictedRawDan = estimate.rawDan;
      target.predictedSrProxy = estimate.estimatedSr;
      if (options.debug) {
        target.debug = {
          metrics: estimate.metrics,
          skillScores: estimate.skillScores,
          debug: estimate.debug,
        };
      }
      target.match = computeMatch(comparableDanLabel(estimate), target.expected, estimate.label);
      if (options.explainWrong && target.match === "wrong") {
        target.diagnostics = buildDiagnostics(map, estimate, options.rate, options.neighbors);
      }
      if (!setShells[setIndex].title) {
        setShells[setIndex].title = title;
        setShells[setIndex].artist = artist;
      }
    } catch (error) {
      target.error = error instanceof Error ? error.message : "estimate failed";
      target.match = target.expected ? "wrong" : "unlabeled";
    }
  });

  if (options.matchKinds) {
    for (const set of setShells) {
      set.rows = set.rows.filter((row) => options.matchKinds?.has(row.match));
    }
  }

  // strip empty sets that ended up with no visible rows after filtering
  let populated = setShells.filter((set) => set.error || set.rows.length > 0);
  populated = filterSetsByText(populated, options.grepText);
  const summary = summarize(populated);
  const previous = options.showChangesFrom ? await loadBenchmarkJson(options.showChangesFrom) : null;
  const changes = previous ? compareRows(filterSetsByText(previous.sets, options.grepText), populated) : [];

  if (options.json) {
    const payload: Record<string, unknown> = {
      family: options.family,
      classifier: options.classifier,
      rate: options.rate,
      filters: describeActiveFilters(options),
      summary: {
        ...summary,
        ...accuracyPct(summary),
      },
      sets: populated,
    };
    if (options.summaryBySet) {
      payload.setSummaries = compareSetSummaries([], populated).map((entry) => ({
        beatmapsetId: entry.beatmapsetId,
        title: entry.title,
        artist: entry.artist,
        summary: entry.after,
      }));
    }
    if (previous) payload.changes = changes;
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  printTable(populated, options, summary);
  if (options.summaryBySet) printSummaryBySet(populated);
  if (previous) printChanges(changes, `Changes from ${options.showChangesFrom}`);
  if (options.explainWrong) printWrongExplanations(populated);
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
