#!/usr/bin/env node
// Diagnose mania dan/LN classifier output for local beatmaps and beatmapsets.
//
// Usage:
//   npm run dan:analyze -- 2474010 --rate 1,1.5
//   npm run dan:analyze -- https://osu.ppy.sh/beatmapsets/2243057#mania/4767800 --json
//   npm run dan:analyze -- ./map.osu --sr 7.28 --rate 1.1

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { parseManiaBeatmap, type ManiaBeatmap } from "../src/lib/beatmap-parser.ts";
import { estimateDan } from "../src/lib/dan-estimator.ts";
import { getLnReferenceComparisonMetrics, getLnReferenceNeighbors } from "../src/lib/dan-estimator/ln.ts";
import type { DanFeatureMetrics } from "../src/lib/dan-estimator/types.ts";

interface CliOptions {
  cacheDir: string;
  explain: boolean;
  json: boolean;
  neighbors: number;
  rates: number[];
  segments: boolean;
  sources: string[];
  starRating: number | null;
}

interface BeatmapMeta {
  beatmapId: number | null;
  source: string;
  starRating: number | null;
  text: string;
}

interface CatboyBeatmapset {
  ChildrenBeatmaps?: Array<{
    BeatmapID?: number;
    DifficultyRating?: number;
    DiffName?: string;
  }>;
}

const DEFAULT_CACHE_DIR = "cache/dan-analyze";

function usage(exitCode = 2): never {
  const output = [
    "Usage: npm run dan:analyze -- [options] <path|beatmapsetId|osuUrl...>",
    "",
    "Options:",
    "  --rate 1,1.5       Comma-separated playback rates. Default: 1",
    "  --sr N             Star rating override for local files or single-chart checks",
    "  --neighbors N      Include nearest LN references. Default: 5",
    "  --segments         Split courses on break periods and analyze each component",
    "  --cache-dir DIR    Download cache directory. Default: cache/dan-analyze",
    "  --explain          Print readable per-chart diagnostics for calibration work",
    "  --json             Print full JSON with reference deltas and LN distributions",
    "",
    "Examples:",
    "  npm run dan:analyze -- 2474010 --rate 1,1.5",
    "  npm run dan:analyze -- https://osu.ppy.sh/beatmapsets/2243057#mania/4767800 --rate 1",
    "  npm run dan:analyze -- ./chart.osu --sr 7.28 --rate 1.1",
  ].join("\n");
  if (exitCode === 0) process.stdout.write(`${output}\n`);
  else process.stderr.write(`${output}\n`);
  process.exit(exitCode);
}

function parseRates(value: string): number[] {
  const rates = value.split(",")
    .map((part) => Number(part.trim()))
    .filter((rate) => Number.isFinite(rate) && rate > 0.4 && rate < 2.5);
  if (rates.length === 0) usage();
  return [...new Set(rates)];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cacheDir: DEFAULT_CACHE_DIR,
    explain: false,
    json: false,
    neighbors: 5,
    rates: [1],
    segments: false,
    sources: [],
    starRating: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--explain") {
      options.explain = true;
    } else if (arg === "--segments") {
      options.segments = true;
    } else if (arg === "--rate" || arg === "--rates") {
      const value = argv[++i];
      if (!value) usage();
      options.rates = parseRates(value);
    } else if (arg === "--sr" || arg === "--star-rating") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) usage();
      options.starRating = value;
    } else if (arg === "--neighbors") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) usage();
      options.neighbors = value;
    } else if (arg === "--cache-dir") {
      const value = argv[++i];
      if (!value) usage();
      options.cacheDir = value;
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      options.sources.push(arg);
    }
  }

  if (options.sources.length === 0) usage();
  return options;
}

async function fetchWithTimeout(input: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { signal: controller.signal, headers: { Accept: "*/*" } });
  } finally {
    clearTimeout(timeout);
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

async function downloadBeatmapset(beatmapsetId: number, cacheDir: string): Promise<Buffer> {
  const dir = path.resolve(process.cwd(), cacheDir);
  const filePath = path.join(dir, `${beatmapsetId}.osz`);
  const cached = await readCachedBuffer(filePath);
  if (cached) return cached;

  await mkdir(dir, { recursive: true });
  const res = await fetchWithTimeout(`https://catboy.best/d/${beatmapsetId}`, 60_000);
  if (!res.ok) throw new Error(`Failed to download beatmapset ${beatmapsetId}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buffer);
  return buffer;
}

async function fetchCatboyBeatmapset(beatmapsetId: number): Promise<CatboyBeatmapset | null> {
  const res = await fetchWithTimeout(`https://catboy.best/api/search?query=${encodeURIComponent(String(beatmapsetId))}&mode=3`, 20_000);
  if (!res.ok) return null;
  const data = await res.json() as Array<CatboyBeatmapset & { SetID?: number }>;
  return data.find((set) => set.SetID === beatmapsetId) ?? null;
}

async function fetchCatboyBeatmapsetByTitle(beatmapsetId: number, title: string): Promise<CatboyBeatmapset | null> {
  const res = await fetchWithTimeout(`https://catboy.best/api/search?query=${encodeURIComponent(title)}&mode=3`, 20_000);
  if (!res.ok) return null;
  const data = await res.json() as Array<CatboyBeatmapset & { SetID?: number }>;
  return data.find((set) => set.SetID === beatmapsetId) ?? null;
}

async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const res = await fetchWithTimeout(`https://osu.ppy.sh/osu/${beatmapId}`, 20_000);
  if (!res.ok) throw new Error(`Failed to fetch beatmap ${beatmapId}: ${res.status}`);
  return res.text();
}

function parseBeatmapId(content: string): number | null {
  const match = content.match(/^BeatmapID\s*:\s*(\d+)/m);
  return match ? Number(match[1]) : null;
}

function parseUrlSource(source: string): { beatmapsetId: number | null; beatmapId: number | null } {
  const beatmapset = source.match(/beatmapsets\/(\d+)/)?.[1];
  const hashBeatmap = source.match(/#mania\/(\d+)/)?.[1];
  const beatmap = source.match(/\/(?:b|beatmaps)\/(\d+)/)?.[1];
  return {
    beatmapsetId: beatmapset ? Number(beatmapset) : null,
    beatmapId: hashBeatmap || beatmap ? Number(hashBeatmap ?? beatmap) : null,
  };
}

function starForBeatmap(beatmapId: number | null, apiData: CatboyBeatmapset | null): number | null {
  if (!beatmapId || !apiData?.ChildrenBeatmaps) return null;
  return apiData.ChildrenBeatmaps.find((child) => child.BeatmapID === beatmapId)?.DifficultyRating ?? null;
}

async function extractOsz(buffer: Buffer, source: string, apiData: CatboyBeatmapset | null): Promise<BeatmapMeta[]> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".osu"));
  const beatmaps: BeatmapMeta[] = [];

  for (const entry of entries) {
    const text = await entry.async("string");
    const beatmapId = parseBeatmapId(text);
    beatmaps.push({
      beatmapId,
      source: `${source}:${entry.name}`,
      starRating: starForBeatmap(beatmapId, apiData),
      text,
    });
  }

  return beatmaps;
}

async function loadLocalSource(source: string, options: CliOptions): Promise<BeatmapMeta[]> {
  const absolute = path.resolve(process.cwd(), source);
  const stats = await stat(absolute);
  if (stats.isDirectory()) {
    const names = await readdir(absolute);
    const nested = await Promise.all(
      names
        .filter((name) => /\.(osu|osz)$/i.test(name))
        .map((name) => loadLocalSource(path.join(absolute, name), options)),
    );
    return nested.flat();
  }

  if (/\.osz$/i.test(source)) {
    return extractOsz(await readFile(absolute), source, null);
  }
  if (!/\.osu$/i.test(source)) throw new Error(`Unsupported local source: ${source}`);

  const text = await readFile(absolute, "utf8");
  return [{ beatmapId: parseBeatmapId(text), source, starRating: options.starRating, text }];
}

async function loadSource(source: string, options: CliOptions): Promise<BeatmapMeta[]> {
  const url = source.startsWith("http://") || source.startsWith("https://") ? parseUrlSource(source) : null;
  if (url?.beatmapId && !url.beatmapsetId) {
    const text = await fetchBeatmapFile(url.beatmapId);
    return [{ beatmapId: url.beatmapId, source, starRating: options.starRating, text }];
  }

  const beatmapsetId = url?.beatmapsetId ?? (/^\d+$/.test(source) ? Number(source) : null);
  if (beatmapsetId) {
    const buffer = await downloadBeatmapset(beatmapsetId, options.cacheDir);
    let apiData = await fetchCatboyBeatmapset(beatmapsetId);
    let beatmaps = await extractOsz(buffer, source, apiData);
    if (!apiData && beatmaps[0]) {
      const map = parseManiaBeatmap(beatmaps[0].text);
      apiData = await fetchCatboyBeatmapsetByTitle(beatmapsetId, map.title);
      beatmaps = await extractOsz(buffer, source, apiData);
    }
    if (url?.beatmapId) return beatmaps.filter((beatmap) => beatmap.beatmapId === url.beatmapId);
    return beatmaps;
  }

  return loadLocalSource(source, options);
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

function lnDistributionStats(map: ManiaBeatmap, rate: number) {
  const holdDurations = map.notes
    .filter((note) => note.isHold && note.endTime > note.time)
    .map((note) => (note.endTime - note.time) / rate);
  const releaseTimes = map.notes
    .filter((note) => note.isHold && note.endTime > note.time)
    .map((note) => note.endTime / rate)
    .sort((left, right) => left - right);
  const releaseGaps = releaseTimes.slice(1).map((time, index) => time - releaseTimes[index]);

  return {
    holds: holdDurations.length,
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

function segmentationSummary(map: ManiaBeatmap) {
  const rawGaps = rawNoteGaps(map);
  const explicitBreaks = map.breakPeriods.filter((period) => period.endTime > period.startTime);
  return {
    explicitBreaks: explicitBreaks.length,
    rawGaps: rawGaps.length,
    rawGapMs: rawGaps.map((gap) => fmt(gap.duration, 1)),
    likelyRawGapCourse: rawGaps.length === 3,
  };
}

function lnReferenceDeltas(metrics: DanFeatureMetrics, rate: number, durationSeconds: number, neighbor: ReturnType<typeof getLnReferenceNeighbors>[number]) {
  const comparison = getLnReferenceComparisonMetrics(metrics, rate);
  const reference = neighbor.metrics;
  return {
    duration: fmt(durationSeconds - reference.s, 1),
    notes: metrics.noteCount - reference.n,
    holdRatio: fmt(comparison.holdRatio - reference.h, 4),
    density: fmt(comparison.lnDensity - reference.d, 4),
    overlap: fmt(comparison.lnOverlapPressure - reference.o, 3),
    release: fmt(comparison.lnReleasePressure - reference.r, 3),
    lnChord: fmt(comparison.lnChordPressure - reference.c, 4),
    peak5: fmt(comparison.peakNps5s - reference.p, 2),
    sustain10: fmt(comparison.sustainedNps10s - reference.u, 2),
    chordRatio: fmt(comparison.chordRatio - reference.q, 4),
  };
}

function topSkillScores(scores: Record<string, number>) {
  return Object.entries(scores)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 4)
    .map(([family, score]) => ({ family, score: fmt(score, 3) }));
}

function sliceMap(map: ManiaBeatmap, start: number, end: number, index: number): ManiaBeatmap {
  const notes = map.notes
    .filter((note) => note.time >= start && note.time < end)
    .map((note) => ({
      ...note,
      time: note.time - start,
      endTime: Math.max(note.time, note.endTime) - start,
    }));

  return {
    ...map,
    notes,
    totalLength: Math.max(0, end - start),
    breakPeriods: [],
    version: `${map.version} #${index + 1}`,
  };
}

function segmentMaps(map: ManiaBeatmap): ManiaBeatmap[] {
  const breaks = map.breakPeriods.map((period) => [period.startTime, period.endTime] as [number, number]);
  if (breaks.length === 0) return [map];

  const starts = [map.notes[0]?.time ?? 0, ...breaks.map(([, end]) => end + 1)];
  const ends = [...breaks.map(([start]) => start), map.totalLength];
  return starts
    .map((start, index) => sliceMap(map, start, ends[index], index))
    .filter((segment) => segment.totalLength >= 5000 && segment.notes.length > 0);
}

function analyzeParsedMap(meta: BeatmapMeta, map: ManiaBeatmap, source: string, options: CliOptions) {
  return options.rates.map((rate) => {
    const baseStarRating = options.starRating ?? meta.starRating ?? 0;
    const effectiveStarRating = baseStarRating > 0 ? baseStarRating * Math.pow(rate, 0.7) : 0;
    const estimate = estimateDan(map, {
      rate,
      starRating: baseStarRating,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
    });
    const metrics = estimate.metrics;
    const durationSeconds = (map.totalLength / 1000) / rate;
    const lnStats = lnDistributionStats(map, rate);
    const segmentation = segmentationSummary(map);
    const lnNeighbors = getLnReferenceNeighbors(metrics, rate, options.neighbors, durationSeconds).map((neighbor) => ({
      level: neighbor.level,
      distance: fmt(neighbor.distance, 3),
      n: neighbor.metrics.n,
      duration: neighbor.metrics.s,
      holdRatio: neighbor.metrics.h,
      peak5: neighbor.metrics.p,
      sustain10: neighbor.metrics.u,
      release: neighbor.metrics.r,
      density: neighbor.metrics.d,
      overlap: neighbor.metrics.o,
      chord: neighbor.metrics.c,
      chordRatio: neighbor.metrics.q,
      delta: lnReferenceDeltas(metrics, rate, durationSeconds, neighbor),
    }));
    return {
      source,
      beatmapId: meta.beatmapId,
      title: map.title,
      artist: map.artist,
      creator: map.creator,
      version: map.version,
      keys: map.keyCount,
      bpm: map.bpm,
      rate,
      starRating: baseStarRating || null,
      effectiveStarRating: effectiveStarRating ? fmt(effectiveStarRating, 3) : null,
      estimate: estimate.displayName,
      rawDan: fmt(estimate.rawDan, 4),
      family: estimate.family,
      confidence: fmt(estimate.confidence, 3),
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
      lnStats,
      segmentation,
      topSkillScores: topSkillScores(estimate.skillScores),
      warnings: estimate.warnings,
      lnNeighbors,
    };
  });
}

function analyzeBeatmap(meta: BeatmapMeta, options: CliOptions) {
  const map = parseManiaBeatmap(meta.text);
  const maps = options.segments ? segmentMaps(map) : [map];
  return maps.flatMap((currentMap) => analyzeParsedMap(meta, currentMap, meta.source, options));
}

function pad(value: unknown, width: number): string {
  const text = String(value ?? "");
  return text.length >= width ? text.slice(0, width - 1) + "…" : text.padEnd(width, " ");
}

function signed(value: number, digits = 2): string {
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

function compactPair(label: string, value: unknown): string {
  return `${label} ${value}`;
}

function printExplain(rows: ReturnType<typeof analyzeBeatmap>[number][]): void {
  for (const [index, row] of rows.entries()) {
    const chart = `${row.artist} - ${row.title} [${row.version}]`;
    if (index > 0) process.stdout.write("\n");
    process.stdout.write(`${chart}\n`);
    process.stdout.write(`${"=".repeat(Math.min(88, chart.length))}\n`);
    process.stdout.write(`Source: ${row.source}${row.beatmapId ? ` (#${row.beatmapId})` : ""}\n`);
    process.stdout.write(`Estimate: ${row.estimate} ${row.family} | raw ${row.rawDan} | confidence ${row.confidence} | ${row.reason ?? "unknown"}\n`);
    process.stdout.write(`Chart: ${[
      compactPair("rate", `${row.rate}x`),
      compactPair("SR", row.effectiveStarRating ?? row.starRating ?? "n/a"),
      compactPair("duration", `${row.duration}s`),
      compactPair("notes", row.notes),
      compactPair("holds", row.holds),
      compactPair("hold%", row.holdRatio),
      compactPair("chord%", row.chordRatio),
    ].join(" | ")}\n`);
    process.stdout.write(`Pressure: ${[
      compactPair("peak5", row.peak5),
      compactPair("sustain10", row.sustain10),
      compactPair("release", row.lnRelease),
      compactPair("density", row.lnDensity),
      compactPair("overlap", row.lnOverlap),
      compactPair("lnChord", row.lnChord),
    ].join(" | ")}\n`);
    process.stdout.write(`LN distribution: holds avg ${row.lnStats.holdMs.avg}ms, p50 ${row.lnStats.holdMs.p50}ms, p90 ${row.lnStats.holdMs.p90}ms, p95 ${row.lnStats.holdMs.p95}ms, max ${row.lnStats.holdMs.max}ms\n`);
    process.stdout.write(`Releases: peak1s ${row.lnStats.releases.peak1s}, peak2s ${row.lnStats.releases.peak2s}, gaps p10/p50/p90 ${row.lnStats.releases.gapP10Ms}/${row.lnStats.releases.gapP50Ms}/${row.lnStats.releases.gapP90Ms}ms\n`);
    process.stdout.write(`Segmentation: explicit breaks ${row.segmentation.explicitBreaks}, raw gaps ${row.segmentation.rawGaps}, likely raw-gap course ${row.segmentation.likelyRawGapCourse ? "yes" : "no"}\n`);
    if (row.segmentation.rawGapMs.length > 0) {
      process.stdout.write(`Raw gaps: ${row.segmentation.rawGapMs.slice(0, 8).map((gap) => `${gap}ms`).join(", ")}${row.segmentation.rawGapMs.length > 8 ? ", ..." : ""}\n`);
    }
    process.stdout.write(`Top families: ${row.topSkillScores.map((score) => `${score.family} ${score.score}`).join(" | ")}\n`);
    if (row.warnings.length > 0) process.stdout.write(`Warnings: ${row.warnings.join(" | ")}\n`);

    if (row.lnNeighbors.length > 0) {
      process.stdout.write("Nearest LN references:\n");
      for (const neighbor of row.lnNeighbors) {
        process.stdout.write(`  LN ${neighbor.level} dist ${neighbor.distance} | ref notes ${neighbor.n}, dur ${neighbor.duration}s, rel ${neighbor.release}, dens ${neighbor.density}, peak5 ${neighbor.peak5}, s10 ${neighbor.sustain10}\n`);
        process.stdout.write(`    delta: dur ${signed(neighbor.delta.duration, 1)}s, notes ${signed(neighbor.delta.notes, 0)}, rel ${signed(neighbor.delta.release)}, dens ${signed(neighbor.delta.density, 4)}, peak5 ${signed(neighbor.delta.peak5)}, s10 ${signed(neighbor.delta.sustain10)}, chord ${signed(neighbor.delta.chordRatio, 4)}\n`);
      }
    }
  }
}

function printTable(rows: ReturnType<typeof analyzeBeatmap>[number][]): void {
  const headers = ["chart", "rate", "sr", "est", "raw", "conf", "why", "dur", "notes", "hold", "p5", "s10", "rel", "h50", "h90", "r1", "gap", "seg", "refs"];
  const widths = [34, 5, 5, 8, 7, 5, 17, 5, 6, 6, 5, 5, 5, 5, 5, 4, 5, 7, 18];
  process.stdout.write(`${headers.map((header, index) => pad(header, widths[index])).join("  ")}\n`);
  process.stdout.write(`${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of rows) {
    const chart = `${row.artist} - ${row.title} [${row.version}]`;
    const refs = row.lnNeighbors.map((neighbor) => `${neighbor.level}:${neighbor.distance}`).join(" ");
    const seg = `${row.segmentation.explicitBreaks}b/${row.segmentation.rawGaps}g`;
    process.stdout.write(`${[
      chart,
      row.rate,
      row.effectiveStarRating ?? row.starRating ?? "",
      row.estimate,
      row.rawDan,
      row.confidence,
      row.reason ?? "",
      row.duration,
      row.notes,
      row.holdRatio,
      row.peak5,
      row.sustain10,
      row.lnRelease,
      row.lnStats.holdMs.p50,
      row.lnStats.holdMs.p90,
      row.lnStats.releases.peak1s,
      row.lnStats.releases.gapP50Ms,
      seg,
      refs,
    ].map((value, index) => pad(value, widths[index])).join("  ")}\n`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loaded = (await Promise.all(options.sources.map((source) => loadSource(source, options)))).flat();
  const rows = loaded.flatMap((beatmap) => analyzeBeatmap(beatmap, options));

  if (options.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else if (options.explain) printExplain(rows);
  else printTable(rows);
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
