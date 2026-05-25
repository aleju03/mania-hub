#!/usr/bin/env node
// Capture osu!stable replay truth from a local tosu/gosumemory API.
//
// Usage:
//   npm run replay:capture-stable -- 6698595595
//   npm run replay:capture-stable -- --duration 150000 --interval 8 --all 6698595595

import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

interface CaptureOptions {
  allSamples: boolean;
  baseUrl: string;
  durationMs: number | null;
  endpoint: string | null;
  includeRaw: boolean;
  intervalMs: number;
  label: string | null;
  outDir: string;
  outPath: string | null;
  quiet: boolean;
  timeoutMs: number;
}

interface StableHitCounts {
  countGeki: number;
  count300: number;
  countKatu: number;
  count100: number;
  count50: number;
  countMiss: number;
}

interface NormalizedStableSnapshot {
  accuracy: number | null;
  beatmap: {
    artist: string | null;
    beatmapId: number | null;
    beatmapsetId: number | null;
    checksum: string | null;
    title: string | null;
    version: string | null;
  };
  combo: number | null;
  counts: StableHitCounts;
  currentTime: number | null;
  keys: Record<string, { count: number | null; pressed: boolean | null }> | null;
  maxCombo: number | null;
  playerName: string | null;
  score: number | null;
  stateName: string | null;
  totalHits: number;
}

interface CaptureStats {
  countChangeCount: number;
  errorCount: number;
  lastErrorMessage: string | null;
  sampleCount: number;
  scoreboardChangeCount: number;
  writtenSamples: number;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_BASE_URL = "http://127.0.0.1:24050";
const DEFAULT_OUT_DIR = "capture-replays";
const DEFAULT_ENDPOINTS = ["/json/v2", "/json"];
const countKeys: Array<keyof StableHitCounts> = [
  "countGeki",
  "count300",
  "countKatu",
  "count100",
  "count50",
  "countMiss",
];

function usage(exitCode = 2): never {
  const output = [
    "Usage: npm run replay:capture-stable -- [options] [label-or-score-id]",
    "",
    "Options:",
    "  --base-url URL       tosu/gosumemory base URL (default: http://127.0.0.1:24050)",
    "  --endpoint PATH      JSON endpoint to poll (default: auto-detect /json/v2 then /json)",
    "  --interval MS       Poll interval in milliseconds (default: 16)",
    "  --duration MS       Stop after this many milliseconds (default: until Ctrl+C)",
    "  --out FILE          Write NDJSON capture to this file",
    `  --out-dir DIR       Output directory when --out is omitted (default: ${DEFAULT_OUT_DIR})`,
    "  --all               Write every poll sample, not only scoreboard/key-count changes",
    "  --no-raw            Omit raw API snapshots from NDJSON rows",
    "  --quiet             Do not print live scoreboard changes",
    "",
    "Examples:",
    "  npm run replay:capture-stable -- 6698595595",
    "  npm run replay:capture-stable -- --duration 145000 --interval 8 6698595595",
  ].join("\n");

  if (exitCode === 0) console.log(output);
  else console.error(output);
  process.exit(exitCode);
}

function parsePositiveNumber(value: string | undefined, label: string, integer = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be a positive ${integer ? "integer" : "number"}.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CaptureOptions {
  const options: CaptureOptions = {
    allSamples: false,
    baseUrl: process.env.TOSU_BASE_URL || DEFAULT_BASE_URL,
    durationMs: null,
    endpoint: process.env.TOSU_ENDPOINT || null,
    includeRaw: true,
    intervalMs: 16,
    label: null,
    outDir: DEFAULT_OUT_DIR,
    outPath: null,
    quiet: false,
    timeoutMs: 750,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--all") {
      options.allSamples = true;
    } else if (arg === "--no-raw") {
      options.includeRaw = false;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--base-url") {
      options.baseUrl = argv[++i] ?? usage();
    } else if (arg === "--endpoint") {
      options.endpoint = argv[++i] ?? usage();
    } else if (arg === "--interval") {
      options.intervalMs = parsePositiveNumber(argv[++i], "--interval", true);
    } else if (arg === "--duration") {
      options.durationMs = parsePositiveNumber(argv[++i], "--duration", true);
    } else if (arg === "--out") {
      options.outPath = argv[++i] ?? usage();
    } else if (arg === "--out-dir") {
      options.outDir = argv[++i] ?? usage();
    } else if (arg === "--timeout") {
      options.timeoutMs = parsePositiveNumber(argv[++i], "--timeout", true);
    } else if (arg === "--score-id" || arg === "--label") {
      options.label = argv[++i] ?? usage();
    } else if (arg.startsWith("--")) {
      usage();
    } else if (options.label == null) {
      options.label = arg;
    } else {
      usage();
    }
  }

  return options;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPathValue(root: unknown, pathName: string): unknown {
  let current = root;

  for (const part of pathName.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }

  return current;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const parsed = Number(value.trim().replace(/[% ,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (["1", "true", "yes", "pressed"].includes(normalised)) return true;
    if (["0", "false", "no", "released"].includes(normalised)) return false;
  }
  return null;
}

function numberFromPaths(root: unknown, paths: string[]): number | null {
  for (const pathName of paths) {
    const value = asNumber(getPathValue(root, pathName));
    if (value != null) return value;
  }
  return null;
}

function stringFromPaths(root: unknown, paths: string[]): string | null {
  for (const pathName of paths) {
    const value = asString(getPathValue(root, pathName));
    if (value != null) return value;
  }
  return null;
}

function recordFromPaths(root: unknown, paths: string[]): JsonRecord | null {
  for (const pathName of paths) {
    const value = getPathValue(root, pathName);
    if (isRecord(value)) return value;
  }
  return null;
}

function countFromHitObject(hits: JsonRecord, keys: string[]): number {
  for (const key of keys) {
    const value = asNumber(hits[key]);
    if (value != null) return Math.max(0, Math.trunc(value));
  }
  return 0;
}

function totalCounts(counts: StableHitCounts): number {
  return countKeys.reduce((sum, key) => sum + counts[key], 0);
}

function countsFromHitObject(hits: JsonRecord): StableHitCounts {
  return {
    countGeki: countFromHitObject(hits, ["geki", "max", "perfect", "countGeki"]),
    count300: countFromHitObject(hits, ["300", "great", "count300"]),
    countKatu: countFromHitObject(hits, ["katu", "200", "good", "countKatu"]),
    count100: countFromHitObject(hits, ["100", "ok", "count100"]),
    count50: countFromHitObject(hits, ["50", "meh", "count50"]),
    countMiss: countFromHitObject(hits, ["0", "miss", "misses", "countMiss"]),
  };
}

function pickHitCounts(root: unknown): StableHitCounts {
  if (stringFromPaths(root, ["state.name", "state"]) === "play") {
    const playHits = getPathValue(root, "play.hits");
    if (isRecord(playHits)) return countsFromHitObject(playHits);
  }

  const candidates = [
    "play.hits",
    "gameplay.hits",
    "resultsScreen.hits",
    "score.hits",
    "hits",
  ];
  let fallback: StableHitCounts | null = null;

  for (const pathName of candidates) {
    const record = getPathValue(root, pathName);
    if (!isRecord(record)) continue;

    const counts = countsFromHitObject(record);
    fallback ??= counts;
    if (totalCounts(counts) > 0) return counts;
  }

  return fallback ?? {
    countGeki: 0,
    count300: 0,
    countKatu: 0,
    count100: 0,
    count50: 0,
    countMiss: 0,
  };
}

function pickKeys(root: unknown): NormalizedStableSnapshot["keys"] {
  const record = recordFromPaths(root, ["keys", "play.keys", "gameplay.keyOverlay", "keyOverlay"]);
  if (!record) return null;

  const keys: NormalizedStableSnapshot["keys"] = {};

  for (const [key, value] of Object.entries(record)) {
    if (isRecord(value)) {
      keys[key] = {
        count: numberFromPaths(value, ["count", "pressCount"]),
        pressed: asBoolean(value.isPressed ?? value.pressed ?? value.down),
      };
    } else {
      keys[key] = {
        count: null,
        pressed: asBoolean(value),
      };
    }
  }

  return Object.keys(keys).length > 0 ? keys : null;
}

function normalizeAccuracy(value: number | null): number | null {
  if (value == null) return null;
  return value > 0 && value <= 1 ? value * 100 : value;
}

function normalizeSnapshot(raw: unknown): NormalizedStableSnapshot {
  const counts = pickHitCounts(raw);

  return {
    accuracy: normalizeAccuracy(numberFromPaths(raw, [
      "play.accuracy",
      "gameplay.accuracy",
      "resultsScreen.accuracy",
      "accuracy",
    ])),
    beatmap: {
      artist: stringFromPaths(raw, ["beatmap.artist", "beatmap.metadata.artist", "menu.bm.metadata.artist"]),
      beatmapId: numberFromPaths(raw, ["beatmap.id", "beatmap.beatmapId", "menu.bm.id"]),
      beatmapsetId: numberFromPaths(raw, ["beatmap.set", "beatmap.beatmapsetId", "menu.bm.set"]),
      checksum: stringFromPaths(raw, ["beatmap.checksum", "menu.bm.checksum"]),
      title: stringFromPaths(raw, ["beatmap.title", "beatmap.metadata.title", "menu.bm.metadata.title"]),
      version: stringFromPaths(raw, ["beatmap.version", "beatmap.metadata.difficulty", "menu.bm.metadata.difficulty"]),
    },
    combo: numberFromPaths(raw, [
      "play.combo.current",
      "gameplay.combo.current",
      "resultsScreen.combo.current",
      "combo.current",
    ]),
    counts,
    currentTime: numberFromPaths(raw, [
      "beatmap.time.live",
      "beatmap.time.current",
      "menu.bm.time.current",
      "gameplay.time.current",
      "time.current",
    ]),
    keys: pickKeys(raw),
    maxCombo: numberFromPaths(raw, [
      "play.combo.max",
      "gameplay.combo.max",
      "resultsScreen.combo.max",
      "combo.max",
    ]),
    playerName: stringFromPaths(raw, [
      "play.playerName",
      "gameplay.name",
      "resultsScreen.name",
      "player.name",
    ]),
    score: numberFromPaths(raw, [
      "play.score",
      "gameplay.score",
      "resultsScreen.score",
      "score",
    ]),
    stateName: stringFromPaths(raw, [
      "state.name",
      "state",
      "menu.state.name",
      "menu.state",
    ]),
    totalHits: totalCounts(counts),
  };
}

function stableScoreboardSignature(snapshot: NormalizedStableSnapshot): string {
  return JSON.stringify({
    accuracy: snapshot.accuracy == null ? null : Number(snapshot.accuracy.toFixed(6)),
    beatmap: snapshot.beatmap,
    combo: snapshot.combo,
    counts: snapshot.counts,
    maxCombo: snapshot.maxCombo,
    playerName: snapshot.playerName,
    score: snapshot.score,
    stateName: snapshot.stateName,
  });
}

function diffCounts(previous: StableHitCounts | null, next: StableHitCounts): Partial<StableHitCounts> | null {
  if (!previous) return totalCounts(next) > 0 ? next : null;

  const diff: Partial<StableHitCounts> = {};
  let changed = false;

  for (const key of countKeys) {
    const delta = next[key] - previous[key];
    if (delta === 0) continue;
    diff[key] = delta;
    changed = true;
  }

  return changed ? diff : null;
}

function makeCaptureUrl(baseUrl: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;

  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const pathName = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  return new URL(pathName, base).toString();
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 120)}` : ""}`);
    }

    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveEndpoint(options: CaptureOptions): Promise<{ initialSnapshot: unknown; url: string }> {
  const endpoints = options.endpoint ? [options.endpoint] : DEFAULT_ENDPOINTS;
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    const url = makeCaptureUrl(options.baseUrl, endpoint);
    try {
      return {
        initialSnapshot: await fetchJsonWithTimeout(url, options.timeoutMs),
        url,
      };
    } catch (error) {
      errors.push(`${url}: ${formatError(error)}`);
    }
  }

  throw new Error([
    "Could not read a JSON stream from tosu/gosumemory.",
    "Start tosu or gosumemory, open osu!stable, then try again.",
    ...errors.map((error) => `  ${error}`),
  ].join("\n"));
}

function safeFileLabel(label: string | null): string {
  const cleaned = (label ?? "stable-replay")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90);
  return cleaned || "stable-replay";
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function resolveOutputPath(options: CaptureOptions, startedAt: Date): string {
  if (options.outPath) return path.resolve(process.cwd(), options.outPath);
  return path.resolve(
    process.cwd(),
    options.outDir,
    `${safeFileLabel(options.label)}-${timestampForFile(startedAt)}.ndjson`,
  );
}

function summaryPathFor(outPath: string): string {
  return outPath.endsWith(".ndjson")
    ? outPath.slice(0, -".ndjson".length) + ".summary.json"
    : `${outPath}.summary.json`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function formatReplayTime(time: number | null): string {
  if (time == null || !Number.isFinite(time)) return "?:??.???";

  const totalMs = Math.max(0, Math.floor(time));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function formatCounts(counts: StableHitCounts): string {
  return [
    `MAX ${counts.countGeki}`,
    `300 ${counts.count300}`,
    `200 ${counts.countKatu}`,
    `100 ${counts.count100}`,
    `50 ${counts.count50}`,
    `Miss ${counts.countMiss}`,
  ].join(" / ");
}

function formatCountDelta(delta: Partial<StableHitCounts> | null): string {
  if (!delta) return "";

  const labels: Array<[string, keyof StableHitCounts]> = [
    ["MAX", "countGeki"],
    ["300", "count300"],
    ["200", "countKatu"],
    ["100", "count100"],
    ["50", "count50"],
    ["Miss", "countMiss"],
  ];

  return labels
    .filter(([, key]) => delta[key] != null)
    .map(([label, key]) => `${label}${formatSigned(delta[key] ?? 0)}`)
    .join(" ");
}

function printLiveChange(snapshot: NormalizedStableSnapshot, delta: Partial<StableHitCounts> | null): void {
  const accuracy = snapshot.accuracy == null ? "acc ?" : `${snapshot.accuracy.toFixed(2)}%`;
  const combo = snapshot.combo == null ? "combo ?" : `${snapshot.combo}x`;
  const score = snapshot.score == null ? "score ?" : String(snapshot.score);
  const deltaText = delta ? ` | ${formatCountDelta(delta)}` : "";
  console.log(`[${formatReplayTime(snapshot.currentTime)}] ${accuracy} ${combo} ${score} | ${formatCounts(snapshot.counts)}${deltaText}`);
}

async function writeJsonLine(file: Awaited<ReturnType<typeof open>>, value: unknown): Promise<void> {
  await file.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  let options: CaptureOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(formatError(error));
    usage();
  }

  const startedAt = new Date();
  const startedMonotonic = performance.now();
  const outPath = resolveOutputPath(options, startedAt);
  const summaryPath = summaryPathFor(outPath);
  await mkdir(path.dirname(outPath), { recursive: true });

  const endpoint = await resolveEndpoint(options);
  const file = await open(outPath, "w");
  const stats: CaptureStats = {
    countChangeCount: 0,
    errorCount: 0,
    lastErrorMessage: null,
    sampleCount: 0,
    scoreboardChangeCount: 0,
    writtenSamples: 0,
  };

  let stopRequested = false;
  let previousCounts: StableHitCounts | null = null;
  let previousSignature: string | null = null;
  let firstSnapshot: NormalizedStableSnapshot | null = null;
  let lastSnapshot: NormalizedStableSnapshot | null = null;
  let queuedInitialSnapshot: unknown | null = endpoint.initialSnapshot;

  process.once("SIGINT", () => {
    stopRequested = true;
    if (!options.quiet) console.log("\nStopping capture...");
  });
  process.once("SIGTERM", () => {
    stopRequested = true;
  });

  await writeJsonLine(file, {
    type: "start",
    baseUrl: options.baseUrl,
    endpoint: endpoint.url,
    includeRaw: options.includeRaw,
    intervalMs: options.intervalMs,
    label: options.label,
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    tool: "replay-capture-stable",
  });

  if (!options.quiet) {
    console.log(`Capturing ${endpoint.url}`);
    console.log(`Writing ${outPath}`);
    console.log(options.durationMs == null ? "Press Ctrl+C to stop." : `Stopping after ${options.durationMs}ms.`);
  }

  try {
    while (!stopRequested) {
      const elapsedMs = performance.now() - startedMonotonic;
      if (options.durationMs != null && elapsedMs >= options.durationMs) break;

      try {
        const raw = queuedInitialSnapshot ?? await fetchJsonWithTimeout(endpoint.url, options.timeoutMs);
        queuedInitialSnapshot = null;
        const normalized = normalizeSnapshot(raw);
        const signature = stableScoreboardSignature(normalized);
        const countDelta = diffCounts(previousCounts, normalized.counts);
        const scoreboardChanged = previousSignature == null || signature !== previousSignature;
        const shouldWrite = options.allSamples || scoreboardChanged || countDelta != null;

        stats.sampleCount++;
        if (scoreboardChanged) stats.scoreboardChangeCount++;
        if (countDelta) stats.countChangeCount++;
        firstSnapshot ??= normalized;
        lastSnapshot = normalized;

        if (shouldWrite) {
          await writeJsonLine(file, {
            type: "sample",
            capturedAt: new Date().toISOString(),
            changed: scoreboardChanged,
            countDelta,
            elapsedMs: Math.round(elapsedMs * 1000) / 1000,
            normalized,
            raw: options.includeRaw ? raw : undefined,
            sequence: stats.sampleCount,
          });
          stats.writtenSamples++;
        }

        if (!options.quiet && scoreboardChanged) {
          printLiveChange(normalized, countDelta);
        }

        previousCounts = normalized.counts;
        previousSignature = signature;
      } catch (error) {
        const message = formatError(error);
        stats.errorCount++;
        stats.lastErrorMessage = message;
        await writeJsonLine(file, {
          type: "error",
          capturedAt: new Date().toISOString(),
          elapsedMs: Math.round((performance.now() - startedMonotonic) * 1000) / 1000,
          message,
          sequence: stats.sampleCount + 1,
        });
        if (!options.quiet) console.error(`[capture warning] ${message}`);
      }

      await sleep(options.intervalMs);
    }
  } finally {
    const endedAt = new Date();
    const summary = {
      type: "summary",
      durationMs: Math.round((performance.now() - startedMonotonic) * 1000) / 1000,
      endedAt: endedAt.toISOString(),
      endpoint: endpoint.url,
      firstSnapshot,
      lastSnapshot,
      outPath,
      startedAt: startedAt.toISOString(),
      stats,
      tool: "replay-capture-stable",
    };

    await writeJsonLine(file, summary);
    await file.close();
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    if (!options.quiet) {
      console.log(`Capture written: ${outPath}`);
      console.log(`Summary written: ${summaryPath}`);
      console.log(`Samples polled ${stats.sampleCount}, samples written ${stats.writtenSamples}, count changes ${stats.countChangeCount}, errors ${stats.errorCount}.`);
    }
  }
}

await main();
