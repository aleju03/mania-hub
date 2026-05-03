#!/usr/bin/env node
// Validate mania replay simulation against real osu! score counts.
//
// Usage:
//   npm run replay:validate -- 123456789
//   npm run replay:validate -- --refresh 123456789 987654321

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ScoreDecoder } from "osu-parsers";
import { parseManiaBeatmap } from "../src/lib/beatmap-parser.ts";
import { getModAcronyms, isLazerScore } from "../src/lib/score.ts";
import type { OsuScore } from "../src/lib/types.ts";
import type { ReplayFrame } from "../src/lib/types.ts";
import type { ReplayHitCounts, ReplayValidationResult } from "../src/lib/replay-validation.ts";
import { getReplayHitCountTotal, validateReplaySimulation } from "../src/lib/replay-validation.ts";

interface CliOptions {
  cacheDir: string;
  json: boolean;
  refresh: boolean;
  scoreIds: number[];
  tolerance: number;
}

interface FixturePaths {
  beatmap: string;
  dir: string;
  replay: string;
  score: string;
}

interface LoadedFixture {
  beatmapContent: string;
  replayBuffer: Buffer;
  score: OsuScore;
}

const API_BASE = "https://osu.ppy.sh/api/v2";
const DEFAULT_CACHE_DIR = "cache/replay-fixtures";

function usage(exitCode = 2): never {
  const output = [
    "Usage: npm run replay:validate -- [--refresh] [--json] [--tolerance N] [--cache-dir DIR] <scoreId...>",
    "",
    "Examples:",
    "  npm run replay:validate -- 123456789",
    "  npm run replay:validate -- --refresh --tolerance 2 123456789 987654321",
  ].join("\n");
  if (exitCode === 0) console.log(output);
  else console.error(output);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cacheDir: DEFAULT_CACHE_DIR,
    json: false,
    refresh: false,
    scoreIds: [],
    tolerance: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--cache-dir") {
      const value = argv[++i];
      if (!value) usage();
      options.cacheDir = value;
    } else if (arg === "--tolerance") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) usage();
      options.tolerance = value;
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      const scoreId = Number(arg);
      if (!Number.isInteger(scoreId) || scoreId <= 0) usage();
      options.scoreIds.push(scoreId);
    }
  }

  if (options.scoreIds.length === 0) usage();
  return options;
}

function fixturePaths(cacheDir: string, scoreId: number): FixturePaths {
  const dir = path.resolve(process.cwd(), cacheDir, String(scoreId));
  return {
    beatmap: path.join(dir, "beatmap.osu"),
    dir,
    replay: path.join(dir, "replay.osr"),
    score: path.join(dir, "score.json"),
  };
}

async function readCachedText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readCachedBuffer(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fetchWithTimeout(input: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;

  const clientId = Number(process.env.OSU_CLIENT_ID);
  const clientSecret = process.env.OSU_CLIENT_SECRET;
  if (!Number.isFinite(clientId) || !clientSecret) {
    throw new Error("Missing OSU_CLIENT_ID / OSU_CLIENT_SECRET. Run with `.env` available.");
  }

  const res = await fetchWithTimeout("https://osu.ppy.sh/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "public",
    }),
  }, 10_000);

  if (!res.ok) {
    throw new Error(`OAuth token request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

async function osuFetchJson<T>(pathName: string): Promise<T> {
  const token = await getToken();
  const res = await fetchWithTimeout(`${API_BASE}${pathName}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-api-version": "20220705",
    },
  }, 15_000);

  if (!res.ok) {
    throw new Error(`${res.status} ${pathName}: ${await res.text()}`);
  }

  return res.json() as Promise<T>;
}

async function osuFetchBinary(pathName: string): Promise<Buffer> {
  const token = await getToken();
  const res = await fetchWithTimeout(`${API_BASE}${pathName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }, 15_000);

  if (!res.ok) {
    throw new Error(`${res.status} ${pathName}: ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function fetchScore(scoreId: number): Promise<OsuScore> {
  try {
    return await osuFetchJson<OsuScore>(`/scores/mania/${scoreId}`);
  } catch {
    return await osuFetchJson<OsuScore>(`/scores/${scoreId}`);
  }
}

async function fetchReplay(scoreId: number): Promise<Buffer> {
  try {
    return await osuFetchBinary(`/scores/mania/${scoreId}/download`);
  } catch {
    return await osuFetchBinary(`/scores/${scoreId}/download`);
  }
}

async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const res = await fetchWithTimeout(`https://osu.ppy.sh/osu/${beatmapId}`, undefined, 15_000);
  if (!res.ok) throw new Error(`Failed to fetch beatmap ${beatmapId}: ${res.status}`);
  return res.text();
}

async function loadFixture(scoreId: number, options: CliOptions): Promise<LoadedFixture> {
  const paths = fixturePaths(options.cacheDir, scoreId);
  await mkdir(paths.dir, { recursive: true });

  let scoreText = options.refresh ? null : await readCachedText(paths.score);
  let replayBuffer = options.refresh ? null : await readCachedBuffer(paths.replay);
  let beatmapContent = options.refresh ? null : await readCachedText(paths.beatmap);

  let score = scoreText ? JSON.parse(scoreText) as OsuScore : null;
  if (!score) {
    score = await fetchScore(scoreId);
    await writeFile(paths.score, `${JSON.stringify(score, null, 2)}\n`);
  }

  if (!replayBuffer) {
    replayBuffer = await fetchReplay(scoreId);
    await writeFile(paths.replay, replayBuffer);
  }

  const beatmapId = score.beatmap?.id ?? score.beatmap_id;
  if (!beatmapId) throw new Error(`Score ${scoreId} does not include a beatmap id.`);

  if (!beatmapContent) {
    beatmapContent = await fetchBeatmapFile(beatmapId);
    await writeFile(paths.beatmap, beatmapContent);
  }

  return { beatmapContent, replayBuffer, score };
}

function countFromScore(score: OsuScore): ReplayHitCounts {
  const stats = score.statistics ?? {};
  return {
    countGeki: stats.count_geki ?? stats.perfect ?? 0,
    count300: stats.count_300 ?? stats.great ?? 0,
    countKatu: stats.count_katu ?? stats.good ?? 0,
    count100: stats.count_100 ?? stats.ok ?? 0,
    count50: stats.count_50 ?? stats.meh ?? 0,
    countMiss: stats.count_miss ?? stats.miss ?? 0,
  };
}

function countFromDecodedReplayInfo(info: any): ReplayHitCounts {
  return {
    countGeki: Number(info?.countGeki ?? 0),
    count300: Number(info?.count300 ?? 0),
    countKatu: Number(info?.countKatu ?? 0),
    count100: Number(info?.count100 ?? 0),
    count50: Number(info?.count50 ?? 0),
    countMiss: Number(info?.countMiss ?? 0),
  };
}

function pickExpectedCounts(score: OsuScore, decodedInfo: any): ReplayHitCounts {
  const apiCounts = countFromScore(score);
  if (getReplayHitCountTotal(apiCounts) > 0) return apiCounts;
  return countFromDecodedReplayInfo(decodedInfo);
}

function pickExpectedMaxCombo(score: OsuScore, decodedInfo: any): number | null {
  const apiMaxCombo = Number(score.max_combo);
  if (Number.isFinite(apiMaxCombo) && apiMaxCombo > 0) return apiMaxCombo;

  const replayMaxCombo = Number(decodedInfo?.maxCombo);
  return Number.isFinite(replayMaxCombo) && replayMaxCombo > 0 ? replayMaxCombo : null;
}

function decodeFrames(decodedScore: any): ReplayFrame[] {
  const rawFrames = (decodedScore.replay?.frames ?? []) as any[];
  return rawFrames
    .map((frame): ReplayFrame => ({
      time: Number(frame.startTime ?? frame.time ?? 0),
      keyState: Math.round(Number(frame.mouseX ?? frame.position?.x ?? frame.buttonState ?? 0)) & 0xffff,
    }))
    .filter((frame) => Number.isFinite(frame.time) && frame.time >= 0);
}

async function validateScoreId(scoreId: number, options: CliOptions): Promise<ReplayValidationResult & { scoreId: number; title: string; version: string; player: string; mods: string[]; keyCount: number }> {
  const fixture = await loadFixture(scoreId, options);
  const beatmap = parseManiaBeatmap(fixture.beatmapContent);
  const decoder = new ScoreDecoder();
  const decoded = await decoder.decodeFromBuffer(fixture.replayBuffer);
  const frames = decodeFrames(decoded);
  const mods = getModAcronyms(fixture.score.mods, false);
  const isLazer = isLazerScore(fixture.score);
  const keyCount = beatmap.keyCount || Math.round(Number(fixture.score.beatmap?.cs)) || decoded.keyCount || 4;
  const result = validateReplaySimulation({
    expectedCounts: pickExpectedCounts(fixture.score, decoded.info),
    expectedMaxCombo: pickExpectedMaxCombo(fixture.score, decoded.info),
    frames,
    isConvert: fixture.score.beatmap?.convert ?? false,
    isLazer,
    keyCount,
    legacyReplayFrameRounding: true,
    mods,
    notes: beatmap.notes,
    od: beatmap.od,
  });

  return {
    ...result,
    scoreId,
    title: fixture.score.beatmapset?.title ?? beatmap.title,
    version: fixture.score.beatmap?.version ?? beatmap.version,
    player: fixture.score.user?.username ?? decoded.info?.username ?? "Unknown",
    mods,
    keyCount,
  };
}

function formatPct(value: number): string {
  return `${value.toFixed(4)}%`;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function printResult(result: ReplayValidationResult & { scoreId: number; title: string; version: string; player: string; mods: string[]; keyCount: number }, tolerance: number): void {
  const comboMatched = result.maxComboDiff == null || result.maxComboDiff === 0;
  const status = result.totalCountDiff <= tolerance && comboMatched ? "PASS" : "FAIL";
  const mods = result.mods.length > 0 ? ` +${result.mods.join("")}` : "";

  console.log(`\n[${status}] ${result.scoreId} ${result.accuracyMode} ${result.keyCount}K${mods}`);
  console.log(`${result.player} - ${result.title} [${result.version}]`);
  console.log(`Accuracy expected ${formatPct(result.expectedAccuracy)} simulated ${formatPct(result.simulatedAccuracy)} (${result.accuracyDiff >= 0 ? "+" : ""}${result.accuracyDiff.toFixed(4)}pp)`);
  if (result.legacyReplayResolution === "score-header") {
    console.log("Resolved using stored stable score counts after replay timing data was insufficient.");
  } else if (result.legacyReplayAmbiguityResolved) {
    console.log("Resolved via legacy .osr frame timing ambiguity.");
  }
  console.log(`Hits expected ${result.totalExpected} simulated ${result.totalSimulated} (total abs diff ${result.totalCountDiff})`);
  console.log(`Max combo expected ${result.expectedMaxCombo ?? "unknown"} simulated ${result.simulatedMaxCombo}${result.maxComboDiff == null ? "" : ` (${formatSigned(result.maxComboDiff)})`}`);
  console.log("       expected  simulated  diff");

  const rows: Array<[string, keyof ReplayHitCounts]> = [
    ["MAX", "countGeki"],
    ["300", "count300"],
    ["200", "countKatu"],
    ["100", "count100"],
    ["50", "count50"],
    ["Miss", "countMiss"],
  ];

  for (const [label, key] of rows) {
    const expected = result.expectedCounts[key];
    const simulated = result.simulatedCounts[key];
    const diff = result.diffs[key];
    console.log(`${label.padStart(5)} ${String(expected).padStart(9)} ${String(simulated).padStart(10)} ${formatSigned(diff).padStart(6)}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const results = [];

for (const scoreId of options.scoreIds) {
  try {
    const result = await validateScoreId(scoreId, options);
    results.push(result);
    if (!options.json) printResult(result, options.tolerance);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      results.push({ scoreId, error: message });
    } else {
      console.error(`\n[ERROR] ${scoreId}: ${message}`);
    }
    process.exitCode = 1;
  }
}

if (options.json) {
  console.log(JSON.stringify(results, null, 2));
}

if (results.some((result: any) => !result.error && (
  result.totalCountDiff > options.tolerance ||
  (result.maxComboDiff != null && result.maxComboDiff !== 0)
))) {
  process.exitCode = 1;
}
