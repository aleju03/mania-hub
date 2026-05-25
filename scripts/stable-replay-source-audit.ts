#!/usr/bin/env node
// Cross-check local osu!stable scores.db rows against Data/r replay files.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ScoreDecoder } from "osu-parsers";
import { parseStableScoresDb, type StableScoreRow } from "./stable-scores-db-inspect.ts";
import { decodeStableManiaReplayFrames } from "../src/lib/replay-frames.ts";
import type { ReplayFrame } from "../src/lib/types.ts";

interface AuditCase {
  hash: string;
  label: string;
  scores: number[];
}

interface CliOptions {
  cases: AuditCase[];
  dataRPath: string;
  legacyScoreId?: bigint;
  limit: number;
  scoresDbPath: string;
  versions: Set<number>;
}

interface StableOsgSummary {
  count: number;
  finalCounts: string;
  maxCombo: number;
  score: number;
  version: number;
}

interface StableOsrSummary {
  counts: string;
  frameSummary: string;
  score: number | null;
  scoreId: number | null;
}

const WINDOWS_FILETIME_EPOCH_TICKS = 504911232000000000n;

function usage(exitCode = 2): never {
  const output = [
    "Usage:",
    "  node scripts/stable-replay-source-audit.ts --scores-db FILE --data-r DIR [--case LABEL:BEATMAP_MD5:SCORE[,SCORE...]] [--version N] [--legacy-score-id N] [--limit N]",
    "",
    "Example:",
    "  node scripts/stable-replay-source-audit.ts --scores-db /mnt/c/Users/me/AppData/Local/osu!/scores.db --data-r /mnt/c/Users/me/AppData/Local/osu!/Data/r --case penguin:c8c4...:696441,696439,696720",
  ].join("\n");
  if (exitCode === 0) console.log(output);
  else console.error(output);
  process.exit(exitCode);
}

function parseCase(value: string): AuditCase {
  const [label, rawHash, rawScores] = value.split(":");
  const hash = rawHash?.toLowerCase();
  const scores = rawScores?.split(",").map((score) => Number(score.trim())).filter(Number.isInteger) ?? [];

  if (!label || !hash || hash.length !== 32 || scores.length === 0) usage();
  return { hash, label, scores };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cases: [],
    dataRPath: "",
    limit: 20,
    scoresDbPath: "",
    versions: new Set(),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--case") options.cases.push(parseCase(argv[++index] ?? ""));
    else if (arg === "--data-r") options.dataRPath = argv[++index] ?? "";
    else if (arg === "--legacy-score-id") options.legacyScoreId = BigInt(argv[++index] ?? "");
    else if (arg === "--limit") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1) usage();
      options.limit = value;
    }
    else if (arg === "--scores-db") options.scoresDbPath = argv[++index] ?? "";
    else if (arg === "--version") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value)) usage();
      options.versions.add(value);
    }
    else usage();
  }

  if (!options.scoresDbPath || !options.dataRPath) usage();
  if (options.cases.length === 0 && options.versions.size === 0 && options.legacyScoreId == null) usage();
  return options;
}

function formatCounts(row: StableScoreRow): string {
  return [
    row.countGeki,
    row.count300,
    row.countKatu,
    row.count100,
    row.count50,
    row.countMiss,
  ].join("/");
}

function stableDataRSuffix(row: StableScoreRow): string {
  return String(row.timestamp - WINDOWS_FILETIME_EPOCH_TICKS);
}

function numberOrNull(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function countsFromDecodedInfo(info: any): string {
  return [
    Number(info?.countGeki ?? 0),
    Number(info?.count300 ?? 0),
    Number(info?.countKatu ?? 0),
    Number(info?.count100 ?? 0),
    Number(info?.count50 ?? 0),
    Number(info?.countMiss ?? 0),
  ].join("/");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sameTimeFrameStats(frames: ReplayFrame[]): { frames: number; groups: number; max: number } {
  let groups = 0;
  let frameCount = 0;
  let max = 0;
  let current = 1;

  for (let index = 1; index < frames.length; index++) {
    if (frames[index].time === frames[index - 1].time) {
      current++;
      continue;
    }

    if (current > 1) {
      groups++;
      frameCount += current;
      max = Math.max(max, current);
    }
    current = 1;
  }

  if (current > 1) {
    groups++;
    frameCount += current;
    max = Math.max(max, current);
  }

  return { frames: frameCount, groups, max };
}

function summarizeFrames(frames: ReplayFrame[]): string {
  const positiveDeltas: number[] = [];
  for (let index = 1; index < frames.length; index++) {
    const delta = frames[index].time - frames[index - 1].time;
    if (delta > 0) positiveDeltas.push(delta);
  }

  const sameTime = sameTimeFrameStats(frames);
  const first = frames[0]?.time ?? 0;
  const last = frames[frames.length - 1]?.time ?? 0;
  return [
    `frames ${frames.length}`,
    `time ${first}->${last}`,
    `dtMedian ${median(positiveDeltas)}`,
    `sameTime ${sameTime.groups}/${sameTime.frames}/max${sameTime.max}`,
  ].join(" ");
}

function fileState(files: Set<string>, hash: string, suffix: string): string {
  const osr = files.has(`${hash}-${suffix}.osr`) ? "osr" : "";
  const osg = files.has(`${hash}-${suffix}.osg`) ? "osg" : "";
  return [osr, osg].filter(Boolean).join("+") || "missing";
}

async function readStableOsgSummary(dataRPath: string, fileName: string): Promise<StableOsgSummary | null> {
  const buffer = await readFile(path.resolve(process.cwd(), dataRPath, fileName));
  if (buffer.length < 8) return null;

  const version = buffer.readInt32LE(0);
  const count = buffer.readInt32LE(4);
  const stride = 29;
  const finalOffset = 8 + (count - 1) * stride;
  if (count <= 0 || finalOffset + stride > buffer.length) return null;

  const finalCounts = [
    buffer.readUInt16LE(finalOffset + 11),
    buffer.readUInt16LE(finalOffset + 5),
    buffer.readUInt16LE(finalOffset + 13),
    buffer.readUInt16LE(finalOffset + 7),
    buffer.readUInt16LE(finalOffset + 9),
    buffer.readUInt16LE(finalOffset + 15),
  ].join("/");

  return {
    count,
    finalCounts,
    maxCombo: buffer.readUInt16LE(finalOffset + 21),
    score: buffer.readInt32LE(finalOffset + 17),
    version,
  };
}

async function readStableOsrSummary(dataRPath: string, fileName: string): Promise<StableOsrSummary | null> {
  const buffer = await readFile(path.resolve(process.cwd(), dataRPath, fileName));
  const decoded = await new ScoreDecoder().decodeFromBuffer(buffer);
  const frames = decodeStableManiaReplayFrames((decoded.replay?.frames ?? []) as any[]);

  return {
    counts: countsFromDecodedInfo(decoded.info),
    frameSummary: summarizeFrames(frames),
    score: numberOrNull(decoded.info?.totalScore),
    scoreId: numberOrNull(decoded.info?.id),
  };
}

function rowMatchesFilters(row: StableScoreRow, options: CliOptions): boolean {
  if (options.versions.size > 0 && !options.versions.has(row.version)) return false;
  if (options.legacyScoreId != null && row.legacyScoreId !== options.legacyScoreId) return false;
  return true;
}

async function printFilteredRows(options: CliOptions, rows: StableScoreRow[], files: Set<string>, dataRPath: string): Promise<void> {
  const matches = rows
    .filter((row) => rowMatchesFilters(row, options))
    .filter((row) => {
      const suffix = stableDataRSuffix(row);
      return files.has(`${row.beatmapHash}-${suffix}.osr`) && files.has(`${row.beatmapHash}-${suffix}.osg`);
    })
    .sort((a, b) => Number(b.timestamp - a.timestamp))
    .slice(0, options.limit);

  console.log(`\nFiltered paired rows: ${matches.length} shown (limit ${options.limit})`);
  for (const row of matches) {
    const suffix = stableDataRSuffix(row);
    const osgFileName = `${row.beatmapHash}-${suffix}.osg`;
    const osrFileName = `${row.beatmapHash}-${suffix}.osr`;
    const [osr, osg] = await Promise.all([
      readStableOsrSummary(dataRPath, osrFileName),
      readStableOsgSummary(dataRPath, osgFileName),
    ]);

    console.log(
      `  ${row.beatmapHash} score ${row.score} counts ${formatCounts(row)} version ${row.version} `
      + `mods ${row.mods} maxCombo ${row.maxCombo} legacy ${row.legacyScoreId} suffix ${suffix}`
      + (osr ? ` osrScore ${osr.score ?? "?"} osrScoreId ${osr.scoreId ?? "?"} ${osr.frameSummary}` : "")
      + (osg ? ` osgRecords ${osg.count} osgScore ${osg.score} osgCounts ${osg.finalCounts}` : ""),
    );
  }
}

async function printCase(auditCase: AuditCase, rows: StableScoreRow[], files: Set<string>, dataRPath: string): Promise<void> {
  const hashRows = rows
    .filter((row) => row.beatmapHash === auditCase.hash)
    .sort((a, b) => b.score - a.score);
  const hashFiles = [...files].filter((file) => file.startsWith(`${auditCase.hash}-`)).sort();
  const rowsByScore = new Map(hashRows.map((row) => [row.score, row]));
  const osgSummaries = new Map<string, StableOsgSummary | null>();
  const osrSummaries = new Map<string, StableOsrSummary | null>();

  await Promise.all(hashRows.map(async (row) => {
    const suffix = stableDataRSuffix(row);
    const osgFileName = `${row.beatmapHash}-${suffix}.osg`;
    const osrFileName = `${row.beatmapHash}-${suffix}.osr`;
    if (files.has(osgFileName)) {
      osgSummaries.set(osgFileName, await readStableOsgSummary(dataRPath, osgFileName));
    }
    if (files.has(osrFileName)) {
      osrSummaries.set(osrFileName, await readStableOsrSummary(dataRPath, osrFileName));
    }
  }));

  console.log(`\n${auditCase.label}`);
  console.log(`  hash ${auditCase.hash}`);
  console.log(`  scores.db rows ${hashRows.length}, Data/r files ${hashFiles.length}`);
  console.log(`  requested scores: ${auditCase.scores.map((score) => `${score}:${rowsByScore.has(score) ? "present" : "absent"}`).join(", ")}`);

  if (hashRows.length > 0) {
    console.log("  rows:");
    for (const row of hashRows) {
      const suffix = stableDataRSuffix(row);
      const osgFileName = `${row.beatmapHash}-${suffix}.osg`;
      const osrFileName = `${row.beatmapHash}-${suffix}.osr`;
      const osg = osgSummaries.get(osgFileName);
      const osr = osrSummaries.get(osrFileName);
      console.log(
        `    score ${row.score} counts ${formatCounts(row)} version ${row.version} `
        + `maxCombo ${row.maxCombo} unknownId ${row.unknownScoreId} legacy ${row.legacyScoreId} `
        + `replayHash ${row.replayHash} Data/r ${fileState(files, row.beatmapHash, suffix)} suffix ${suffix}`
        + (osr ? ` osrScore ${osr.score ?? "?"} osrScoreId ${osr.scoreId ?? "?"} osrCounts ${osr.counts} ${osr.frameSummary}` : "")
        + (osg ? ` osgVersion ${osg.version} osgRecords ${osg.count} osgScore ${osg.score} osgMaxCombo ${osg.maxCombo} osgCounts ${osg.finalCounts}` : ""),
      );
    }
  }

  const unpairedFiles = hashFiles.filter((file) => {
    return !hashRows.some((row) => file.startsWith(`${row.beatmapHash}-${stableDataRSuffix(row)}.`));
  });
  if (unpairedFiles.length > 0) {
    console.log(`  unpaired Data/r files: ${unpairedFiles.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [db, dataRFiles] = await Promise.all([
    parseStableScoresDb(options.scoresDbPath),
    readdir(path.resolve(process.cwd(), options.dataRPath)),
  ]);

  const files = new Set(dataRFiles);
  console.log(
    `scores.db version ${db.dbVersion}, beatmaps ${db.beatmapCount}, scores ${db.totalScores}, `
    + `Data/r files ${files.size}`,
  );

  if (options.versions.size > 0 || options.legacyScoreId != null) {
    await printFilteredRows(options, db.rows, files, options.dataRPath);
  }

  for (const auditCase of options.cases) {
    await printCase(auditCase, db.rows, files, options.dataRPath);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
