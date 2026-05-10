#!/usr/bin/env node
// Run the dan classifier against the curated benchmark beatmapsets and compare
// predicted dan vs the expected labels stored in Turso (the same data the
// admin /admin/dan-classifier benchmark tab uses).
//
// Usage:
//   npm run dan:benchmark
//   npm run dan:benchmark -- --family ln --classifier daniel
//   npm run dan:benchmark -- --json

import { parseManiaBeatmap } from "../src/lib/beatmap-parser.ts";
import { estimateDan } from "../src/lib/dan-estimator.ts";
import { estimateDanielDan } from "../src/lib/daniel-estimator.ts";
import type { DanEstimate } from "../src/lib/dan-estimator/types.ts";
import {
  type DanBenchmarkFamily,
  getBenchmarkBeatmapsetIds,
} from "../src/lib/dan-benchmark-sets.ts";
import { db, hasDb } from "../src/lib/db.ts";
import {
  type BeatmapMeta,
  type CatboyBeatmapset,
  downloadBeatmapset,
  extractOsz,
  fetchCatboyBeatmapset,
  fetchCatboyBeatmapsetByTitle,
} from "./_dan-shared.ts";

type ClassifierId = "aleju" | "daniel";
type MatchKind = "exact" | "base" | "wrong" | "unlabeled";

interface CliOptions {
  cacheDir: string;
  classifier: ClassifierId;
  family: DanBenchmarkFamily;
  includeUnlabeled: boolean;
  json: boolean;
  rate: number;
}

interface RowResult {
  beatmapId: number | null;
  version: string;
  starRating: number | null;
  expected: string | null;
  predicted: string | null;
  predictedFamily: string | null;
  predictedConfidence: number | null;
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

function usage(exitCode = 2): never {
  const output = [
    "Usage: npm run dan:benchmark -- [options]",
    "",
    "Options:",
    "  --family normal|ln       Benchmark family. Default: normal",
    "  --classifier aleju|daniel  Estimator to run. Default: aleju",
    "  --rate N                 Playback rate. Default: 1",
    "  --cache-dir DIR          Beatmapset download cache. Default: cache/dan-analyze",
    "  --include-unlabeled      Show diffs without an expected label (never counted toward accuracy)",
    "  --json                   Emit structured JSON instead of a table",
    "",
    "Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment (or .env).",
  ].join("\n");
  if (exitCode === 0) process.stdout.write(`${output}\n`);
  else process.stderr.write(`${output}\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cacheDir: DEFAULT_CACHE_DIR,
    classifier: "aleju",
    family: "normal",
    includeUnlabeled: false,
    json: false,
    rate: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--include-unlabeled") {
      options.includeUnlabeled = true;
    } else if (arg === "--family") {
      const value = argv[++i];
      if (value !== "normal" && value !== "ln") usage();
      options.family = value;
    } else if (arg === "--classifier") {
      const value = argv[++i];
      if (value !== "aleju" && value !== "daniel") usage();
      options.classifier = value;
    } else if (arg === "--rate") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0.4 || value >= 2.5) usage();
      options.rate = value;
    } else if (arg === "--cache-dir") {
      const value = argv[++i];
      if (!value) usage();
      options.cacheDir = value;
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

function runClassifier(
  classifier: ClassifierId,
  text: string,
  rate: number,
  starRating: number | null,
  beatmapId: number | null,
): { estimate: DanEstimate; version: string; title: string; artist: string } {
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
  const estimate = classifier === "daniel" ? estimateDanielDan(map, input) : estimateDan(map, input);
  return { estimate, version: map.version, title: map.title, artist: map.artist };
}

async function loadExpectedLabels(family: DanBenchmarkFamily): Promise<Map<number, string>> {
  if (!hasDb() || !db) return new Map();
  const result = await db.execute({
    sql: `SELECT beatmap_id, expected_label FROM dan_benchmark_labels WHERE family = ?`,
    args: [family],
  });
  const out = new Map<number, string>();
  for (const row of result.rows) {
    out.set(Number(row.beatmap_id), String(row.expected_label));
  }
  return out;
}

async function loadHiddenDiffs(family: DanBenchmarkFamily): Promise<Set<number>> {
  if (!hasDb() || !db) return new Set();
  const result = await db.execute({
    sql: `SELECT beatmap_id FROM dan_benchmark_hidden_diffs WHERE family = ?`,
    args: [family],
  });
  return new Set(result.rows.map((row) => Number(row.beatmap_id)));
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

function pad(value: unknown, width: number, align: "left" | "right" = "left"): string {
  const text = String(value ?? "");
  if (text.length >= width) return text.length === width ? text : text.slice(0, width - 1) + "…";
  return align === "right" ? text.padStart(width, " ") : text.padEnd(width, " ");
}

function formatStars(value: number | null): string {
  return value == null ? "-" : value.toFixed(2);
}

function matchSymbol(kind: MatchKind): string {
  switch (kind) {
    case "exact": return "OK";
    case "base":  return "~";
    case "wrong": return "X";
    case "unlabeled": return "?";
  }
}

function printTable(sets: SetResult[], options: CliOptions, summary: ReturnType<typeof summarize>): void {
  const widths = { diff: 28, sr: 6, expected: 10, predicted: 12, match: 5 };
  const header = [
    pad("Diff", widths.diff),
    pad("SR", widths.sr, "right"),
    pad("Expected", widths.expected),
    pad("Predicted", widths.predicted),
    pad("Match", widths.match),
  ].join("  ");
  const divider = "-".repeat(header.length);

  process.stdout.write(`Family: ${options.family}  Classifier: ${options.classifier}  Rate: ${options.rate}\n`);
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

  if (!hasDb()) {
    process.stderr.write(
      "ERROR: Turso credentials missing. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN " +
      "in .env. Expected labels are loaded from the dan_benchmark_labels table.\n",
    );
    process.exit(1);
  }

  const beatmapsetIds = getBenchmarkBeatmapsetIds(options.family);
  const [expectedLabels, hiddenDiffs] = await Promise.all([
    loadExpectedLabels(options.family),
    loadHiddenDiffs(options.family),
  ]);

  const fetched = await mapWithConcurrency(beatmapsetIds, 4, (id) => fetchSet(id, options.cacheDir));

  // build the flat work list (one entry per visible 4K diff) so we can run
  // estimates with bounded concurrency across all sets at once
  const work: Array<{ setIndex: number; rowIndex: number } & DiffWork> = [];
  const setShells: SetResult[] = fetched.map((set, setIndex) => {
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
      if (hiddenDiffs.has(meta.beatmapId)) continue;
      const expected = expectedLabels.get(meta.beatmapId) ?? null;
      if (!expected && !options.includeUnlabeled) continue;
      const rowIndex = shell.rows.length;
      shell.rows.push({
        beatmapId: meta.beatmapId,
        version: "",
        starRating: meta.starRating,
        expected,
        predicted: null,
        predictedFamily: null,
        predictedConfidence: null,
        match: "unlabeled",
        error: null,
      });
      work.push({ setIndex, rowIndex, beatmapsetId: set.beatmapsetId, meta, expected });
    }
    return shell;
  });

  await mapWithConcurrency(work, 4, async ({ setIndex, rowIndex, meta }) => {
    const target = setShells[setIndex].rows[rowIndex];
    try {
      const { estimate, version, title, artist } = runClassifier(
        options.classifier,
        meta.text,
        options.rate,
        meta.starRating,
        meta.beatmapId,
      );
      target.version = version;
      target.predicted = estimate.displayName;
      target.predictedFamily = estimate.family;
      target.predictedConfidence = estimate.confidence;
      target.match = computeMatch(estimate.displayName, target.expected, estimate.label);
      if (!setShells[setIndex].title) {
        setShells[setIndex].title = title;
        setShells[setIndex].artist = artist;
      }
    } catch (error) {
      target.error = error instanceof Error ? error.message : "estimate failed";
      target.match = target.expected ? "wrong" : "unlabeled";
    }
  });

  // strip empty sets that ended up with no visible rows after filtering
  const populated = setShells.filter((set) => set.error || set.rows.length > 0);
  const summary = summarize(populated);

  if (options.json) {
    process.stdout.write(JSON.stringify({
      family: options.family,
      classifier: options.classifier,
      rate: options.rate,
      summary: {
        ...summary,
        exactPct: summary.labeled > 0 ? (summary.exact / summary.labeled) * 100 : 0,
        basePct: summary.labeled > 0 ? ((summary.exact + summary.base) / summary.labeled) * 100 : 0,
      },
      sets: populated,
    }, null, 2) + "\n");
    return;
  }

  printTable(populated, options, summary);
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
