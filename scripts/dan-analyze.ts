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
import { getLnReferenceNeighbors } from "../src/lib/dan-estimator/ln.ts";

interface CliOptions {
  cacheDir: string;
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
    "  --json             Print full JSON instead of a compact table",
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

function breakRanges(content: string): Array<[number, number]> {
  return [...content.matchAll(/^2,(\d+),(\d+)/gm)].map((match) => [Number(match[1]), Number(match[2])]);
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
    version: `${map.version} #${index + 1}`,
  };
}

function segmentMaps(map: ManiaBeatmap, content: string): ManiaBeatmap[] {
  const breaks = breakRanges(content);
  if (breaks.length === 0) return [map];

  const starts = [map.notes[0]?.time ?? 0, ...breaks.map(([, end]) => end + 1)];
  const ends = [...breaks.map(([start]) => start), map.totalLength];
  return starts
    .map((start, index) => sliceMap(map, start, ends[index], index))
    .filter((segment) => segment.totalLength >= 5000 && segment.notes.length > 0);
}

function analyzeParsedMap(meta: BeatmapMeta, map: ManiaBeatmap, source: string, options: CliOptions) {
  return options.rates.map((rate) => {
    const starRating = options.starRating ?? meta.starRating ?? 0;
    const estimate = estimateDan(map, {
      rate,
      starRating,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
    });
    const metrics = estimate.metrics;
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
      starRating: starRating || null,
      estimate: estimate.displayName,
      rawDan: fmt(estimate.rawDan, 4),
      family: estimate.family,
      reason: estimate.debug?.familyChoice.reason ?? null,
      notes: metrics.noteCount,
      holds: map.notes.filter((note) => note.isHold).length,
      duration: fmt((map.totalLength / 1000) / rate, 1),
      holdRatio: fmt(metrics.holdRatio, 4),
      chordRatio: fmt(metrics.chordRatio, 4),
      peak5: fmt(metrics.peakNps5s),
      sustain10: fmt(metrics.sustainedNps10s),
      lnRelease: fmt(metrics.lnReleasePressure),
      lnDensity: fmt(metrics.lnDensity, 4),
      lnOverlap: fmt(metrics.lnOverlapPressure),
      lnChord: fmt(metrics.lnChordPressure, 4),
      lnP90: fmt(metrics.lnHoldDurationP90, 1),
      warnings: estimate.warnings,
      lnNeighbors: getLnReferenceNeighbors(metrics, rate, options.neighbors).map((neighbor) => ({
        level: neighbor.level,
        distance: fmt(neighbor.distance, 3),
        n: neighbor.metrics.n,
        peak5: neighbor.metrics.p,
        sustain10: neighbor.metrics.u,
        release: neighbor.metrics.r,
        density: neighbor.metrics.d,
        overlap: neighbor.metrics.o,
        chord: neighbor.metrics.c,
      })),
    };
  });
}

function analyzeBeatmap(meta: BeatmapMeta, options: CliOptions) {
  const map = parseManiaBeatmap(meta.text);
  const maps = options.segments ? segmentMaps(map, meta.text) : [map];
  return maps.flatMap((currentMap) => analyzeParsedMap(meta, currentMap, meta.source, options));
}

function pad(value: unknown, width: number): string {
  const text = String(value ?? "");
  return text.length >= width ? text.slice(0, width - 1) + "…" : text.padEnd(width, " ");
}

function printTable(rows: ReturnType<typeof analyzeBeatmap>[number][]): void {
  const headers = ["chart", "rate", "sr", "est", "raw", "why", "notes", "hold", "p5", "s10", "rel", "dens", "ov", "lnc", "p90", "refs"];
  const widths = [38, 5, 5, 8, 7, 17, 6, 6, 5, 5, 5, 6, 5, 5, 5, 18];
  process.stdout.write(`${headers.map((header, index) => pad(header, widths[index])).join("  ")}\n`);
  process.stdout.write(`${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of rows) {
    const chart = `${row.artist} - ${row.title} [${row.version}]`;
    const refs = row.lnNeighbors.map((neighbor) => `${neighbor.level}:${neighbor.distance}`).join(" ");
    process.stdout.write(`${[
      chart,
      row.rate,
      row.starRating ?? "",
      row.estimate,
      row.rawDan,
      row.reason ?? "",
      row.notes,
      row.holdRatio,
      row.peak5,
      row.sustain10,
      row.lnRelease,
      row.lnDensity,
      row.lnOverlap,
      row.lnChord,
      row.lnP90,
      refs,
    ].map((value, index) => pad(value, widths[index])).join("  ")}\n`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loaded = (await Promise.all(options.sources.map((source) => loadSource(source, options)))).flat();
  const rows = loaded.flatMap((beatmap) => analyzeBeatmap(beatmap, options));

  if (options.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else printTable(rows);
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
