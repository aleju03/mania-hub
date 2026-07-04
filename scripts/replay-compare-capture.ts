#!/usr/bin/env node
// Compare a tosu/gosumemory stable replay capture against our replay simulator.
//
// Usage:
//   npm run replay:compare-capture -- 6698595595 6698595595-....ndjson
//
// Fixture files are read from cache/replay-fixtures/<scoreId>. Run
// `npm run replay:validate -- --refresh <scoreId>` first if they are missing.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ScoreDecoder } from "osu-parsers";
import { parseManiaBeatmap } from "../src/lib/beatmap-parser.ts";
import {
  applyManiaReplayModsToNotes,
  buildReplaySegments,
  calculateReplayAccuracy,
  getManiaReplayHitWindows,
  getManiaReplayRuleset,
  type ManiaReplaySimulationOptions,
  type ReplayNoteState,
  simulateManiaReplayJudgements,
  type Judgment,
} from "../src/lib/mania-replay-judgement.ts";
import type { ReplayHitCounts } from "../src/lib/replay-validation.ts";
import {
  countReplayJudgements,
  diffReplayHitCounts,
  emptyReplayHitCounts,
  getReplayHitCountTotal,
  replayHitCountsToArray,
  resolveReplayJudgementEvents,
} from "../src/lib/replay-validation.ts";
import { getManiaParseKeyCount, getModAcronyms, isLazerScore } from "../src/lib/score.ts";
import { decodeStableManiaReplayFrames } from "../src/lib/replay-frames.ts";
import type { OsuScore, ReplayFrame } from "../src/lib/types.ts";

interface CliOptions {
  aroundTime?: number;
  aroundTotal?: number;
  alignmentCandidates: boolean;
  beatmapPath?: string;
  breakTimeline: boolean;
  cacheDir: string;
  candidateEvidence: boolean;
  capturePath: string;
  compareTarget: CompareTarget;
  componentExposure: boolean;
  componentIntervals: boolean;
  column?: number;
  context: number;
  counterTail: boolean;
  diffIntervals: boolean;
  driftAttribution: boolean;
  driftSummary: boolean;
  eventOrderSweep: boolean;
  featureProbes: boolean;
  frameSweep: boolean;
  globalAlignment: boolean;
  hitErrorFit: boolean;
  intervalMaxTotal?: number;
  intervalMinTotal?: number;
  json: boolean;
  isLazer: boolean;
  label?: string;
  limit: number;
  mods?: string[];
  osgAlign: boolean;
  osgClusters: boolean;
  osgEvents: boolean;
  osgRawExposure: boolean;
  osgResidueRuns: boolean;
  osgResidueTrace: boolean;
  replayPath?: string;
  resolveFinal: boolean;
  resolveIntervals: boolean;
  ruleProbes: boolean;
  scoreDiagnostics: boolean;
  scoreResolve: boolean;
  sourceFit: boolean;
  stableHeldOkTimeoutJudgment?: Judgment;
  stableNextNoteEdgeGrace?: number;
  stableOsgPath?: string;
  stableThresholdGrid: boolean;
  stableThresholdSweep: boolean;
  stableTimingDeltaVariant?: string;
  stableTimingSweep: boolean;
  scoreId?: number;
  timeIntervals: boolean;
  updateLoopTrace: boolean;
  visibleIntervals: boolean;
}

type CompareTarget = "play" | "header" | "replay" | "result-screen" | "stable-osg";

interface PlaySnapshot {
  accuracy: number | null;
  combo: number | null;
  counts: ReplayHitCounts;
  elapsedMs: number | null;
  hitErrors: number[];
  maxCombo: number | null;
  score: number | null;
  sequence: number;
  sliderBreaks: number | null;
  time: number;
  total: number;
}

interface CaptureSegment {
  endTime: number;
  maxTotal: number;
  samples: PlaySnapshot[];
  startSequence: number;
  startTime: number;
}

interface ResultScreenSnapshot {
  counts: ReplayHitCounts;
  createdAt: string | null;
  elapsedMs: number | null;
  playerName: string | null;
  score: number | null;
  scoreId: number | null;
  sequence: number;
  time: number | null;
  total: number;
}

interface LeaderboardSnapshot {
  entries: LeaderboardEntry[];
  elapsedMs: number | null;
  sequence: number;
  time: number | null;
}

interface LeaderboardEntry {
  count100: number;
  count300: number;
  count50: number;
  countMiss: number;
  accuracy: number | null;
  comboMax: number | null;
  id: number | null;
  name: string | null;
  position: number | null;
  score: number | null;
}

interface CaptureData {
  leaderboardSnapshots: LeaderboardSnapshot[];
  playSamples: PlaySnapshot[];
  resultScreens: ResultScreenSnapshot[];
  selectedSegment: CaptureSegment;
  segments: CaptureSegment[];
  finalLeaderboard: LeaderboardSnapshot | null;
}

interface StableOsgData {
  count: number;
  path: string;
  segment: CaptureSegment;
  version: number;
}

interface ComparisonTarget {
  counts: ReplayHitCounts;
  label: string;
  target: CompareTarget;
}

const DEFAULT_CACHE_DIR = "cache/replay-fixtures";
const checkpointTotals = [3, 10, 100, 200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000];

function usage(exitCode = 2): never {
  const output = [
    "Usage:",
    "  npm run replay:compare-capture -- [--json] [--limit N] [--target play|header|replay|result-screen|stable-osg] [--stable-osg FILE.osg] [--stable-held-ok-timeout-judgment N] [--stable-next-note-edge-grace MS] [--osg-events] [--osg-align] [--osg-clusters] [--osg-raw-exposure] [--osg-residue-trace] [--osg-residue-runs] [--event-order-sweep] [--around-total N] [--diff-intervals] [--drift-summary] [--drift-attribution] [--global-alignment] [--alignment-candidates] [--hit-error-fit] [--visible-intervals] [--time-intervals] [--component-intervals] [--component-exposure] [--break-timeline] [--counter-tail] [--resolve-intervals] [--resolve-final] [--candidate-evidence] [--rule-probes] [--feature-probes] [--score-diagnostics] [--score-resolve] [--source-fit] [--threshold-sweep] [--threshold-grid] [--timing-sweep] [--timing-delta-variant LABEL] [--frame-sweep] [--update-loop-trace] [--column N] [--cache-dir DIR] <scoreId> <capture.ndjson>",
    "  npm run replay:compare-capture -- [--json] [--limit N] [--target play|header|replay|result-screen|stable-osg] [--stable-osg FILE.osg] [--stable-held-ok-timeout-judgment N] [--stable-next-note-edge-grace MS] [--osg-events] [--osg-align] [--osg-clusters] [--osg-raw-exposure] [--osg-residue-trace] [--osg-residue-runs] [--event-order-sweep] [--around-time MS] [--diff-intervals] [--drift-summary] [--drift-attribution] [--global-alignment] [--alignment-candidates] [--hit-error-fit] [--visible-intervals] [--time-intervals] [--component-intervals] [--component-exposure] [--break-timeline] [--counter-tail] [--resolve-intervals] [--resolve-final] [--candidate-evidence] [--rule-probes] [--feature-probes] [--score-diagnostics] [--score-resolve] [--source-fit] [--threshold-sweep] [--threshold-grid] [--timing-sweep] [--timing-delta-variant LABEL] [--frame-sweep] [--update-loop-trace] [--column N] --beatmap FILE.osu --replay FILE.osr [--mods DT,MR] [--lazer] [--label NAME] <capture.ndjson>",
    "",
    "Example:",
    "  npm run replay:compare-capture -- 6698595595 6698595595-2026-05-17T06-28-47-807Z.ndjson",
    "  npm run replay:compare-capture -- --beatmap map.osu --replay play.osr local-capture.ndjson",
  ].join("\n");
  if (exitCode === 0) console.log(output);
  else console.error(output);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    alignmentCandidates: false,
    breakTimeline: false,
    cacheDir: DEFAULT_CACHE_DIR,
    candidateEvidence: false,
    compareTarget: "play",
    componentExposure: false,
    componentIntervals: false,
    context: 8,
    counterTail: false,
    diffIntervals: false,
    driftAttribution: false,
    driftSummary: false,
    eventOrderSweep: false,
    featureProbes: false,
    frameSweep: false,
    globalAlignment: false,
    hitErrorFit: false,
    isLazer: false,
    json: false,
    limit: 8,
    osgAlign: false,
    osgClusters: false,
    osgEvents: false,
    osgResidueTrace: false,
    osgResidueRuns: false,
    resolveFinal: false,
    resolveIntervals: false,
    ruleProbes: false,
    scoreDiagnostics: false,
    scoreResolve: false,
    sourceFit: false,
    stableThresholdGrid: false,
    stableThresholdSweep: false,
    stableTimingSweep: false,
    timeIntervals: false,
    updateLoopTrace: false,
    visibleIntervals: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--alignment-candidates") options.alignmentCandidates = true;
    else if (arg === "--break-timeline") options.breakTimeline = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--beatmap") options.beatmapPath = argv[++i] ?? usage();
    else if (arg === "--cache-dir") options.cacheDir = argv[++i] ?? usage();
    else if (arg === "--candidate-evidence") options.candidateEvidence = true;
    else if (arg === "--target") {
      const value = argv[++i] ?? usage();
      if (
        value !== "play"
        && value !== "header"
        && value !== "replay"
        && value !== "result-screen"
        && value !== "stable-osg"
      ) usage();
      options.compareTarget = value;
    }
    else if (arg === "--component-intervals") options.componentIntervals = true;
    else if (arg === "--component-exposure") options.componentExposure = true;
    else if (arg === "--column") {
      const column = Number(argv[++i]);
      if (!Number.isInteger(column) || column < 0) usage();
      options.column = column;
    }
    else if (arg === "--counter-tail") options.counterTail = true;
    else if (arg === "--diff-intervals") options.diffIntervals = true;
    else if (arg === "--drift-attribution") options.driftAttribution = true;
    else if (arg === "--drift-summary") options.driftSummary = true;
    else if (arg === "--event-order-sweep") options.eventOrderSweep = true;
    else if (arg === "--feature-probes") options.featureProbes = true;
    else if (arg === "--frame-sweep") options.frameSweep = true;
    else if (arg === "--global-alignment") options.globalAlignment = true;
    else if (arg === "--hit-error-fit") options.hitErrorFit = true;
    else if (arg === "--osg-align") options.osgAlign = true;
    else if (arg === "--osg-clusters") options.osgClusters = true;
    else if (arg === "--osg-events") options.osgEvents = true;
    else if (arg === "--osg-raw-exposure") options.osgRawExposure = true;
    else if (arg === "--osg-residue-trace") options.osgResidueTrace = true;
    else if (arg === "--osg-residue-runs") options.osgResidueRuns = true;
    else if (arg === "--resolve-final") options.resolveFinal = true;
    else if (arg === "--resolve-intervals") options.resolveIntervals = true;
    else if (arg === "--rule-probes") options.ruleProbes = true;
    else if (arg === "--score-diagnostics") options.scoreDiagnostics = true;
    else if (arg === "--score-resolve") options.scoreResolve = true;
    else if (arg === "--source-fit") options.sourceFit = true;
    else if (arg === "--stable-held-ok-timeout-judgment") {
      const judgment = Number(argv[++i]);
      if (!Number.isInteger(judgment) || judgment < 1 || judgment > 6) usage();
      options.stableHeldOkTimeoutJudgment = judgment as Judgment;
    } else if (arg === "--stable-next-note-edge-grace") {
      const grace = Number(argv[++i]);
      if (!Number.isFinite(grace) || grace < 0) usage();
      options.stableNextNoteEdgeGrace = grace;
    }
    else if (arg === "--stable-osg") options.stableOsgPath = argv[++i] ?? usage();
    else if (arg === "--threshold-grid") options.stableThresholdGrid = true;
    else if (arg === "--threshold-sweep") options.stableThresholdSweep = true;
    else if (arg === "--timing-delta-variant") options.stableTimingDeltaVariant = argv[++i] ?? usage();
    else if (arg === "--timing-sweep") options.stableTimingSweep = true;
    else if (arg === "--time-intervals") options.timeIntervals = true;
    else if (arg === "--update-loop-trace") options.updateLoopTrace = true;
    else if (arg === "--visible-intervals") options.visibleIntervals = true;
    else if (arg === "--context") {
      const context = Number(argv[++i]);
      if (!Number.isInteger(context) || context <= 0) usage();
      options.context = context;
    } else if (arg === "--max-total") {
      const intervalMaxTotal = Number(argv[++i]);
      if (!Number.isInteger(intervalMaxTotal) || intervalMaxTotal <= 0) usage();
      options.intervalMaxTotal = intervalMaxTotal;
    } else if (arg === "--min-total") {
      const intervalMinTotal = Number(argv[++i]);
      if (!Number.isInteger(intervalMinTotal) || intervalMinTotal <= 0) usage();
      options.intervalMinTotal = intervalMinTotal;
    } else if (arg === "--around-time") {
      const aroundTime = Number(argv[++i]);
      if (!Number.isFinite(aroundTime) || aroundTime < 0) usage();
      options.aroundTime = aroundTime;
    } else if (arg === "--around-total") {
      const aroundTotal = Number(argv[++i]);
      if (!Number.isInteger(aroundTotal) || aroundTotal <= 0) usage();
      options.aroundTotal = aroundTotal;
    }
    else if (arg === "--label") options.label = argv[++i] ?? usage();
    else if (arg === "--lazer") options.isLazer = true;
    else if (arg === "--limit") {
      const limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit <= 0) usage();
      options.limit = limit;
    } else if (arg === "--mods") {
      options.mods = parseModList(argv[++i] ?? usage());
    } else if (arg === "--replay") {
      options.replayPath = argv[++i] ?? usage();
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      positionals.push(arg);
    }
  }

  const isLocal = options.beatmapPath != null || options.replayPath != null;
  if (isLocal) {
    if (!options.beatmapPath || !options.replayPath || positionals.length !== 1) usage();
    return {
      beatmapPath: options.beatmapPath,
      alignmentCandidates: options.alignmentCandidates ?? false,
      breakTimeline: options.breakTimeline ?? false,
      cacheDir: options.cacheDir ?? DEFAULT_CACHE_DIR,
      candidateEvidence: options.candidateEvidence ?? false,
      capturePath: positionals[0],
      compareTarget: options.compareTarget ?? "play",
      aroundTime: options.aroundTime,
      aroundTotal: options.aroundTotal,
      column: options.column,
      componentExposure: options.componentExposure ?? false,
      componentIntervals: options.componentIntervals ?? false,
      context: options.context ?? 8,
      counterTail: options.counterTail ?? false,
      diffIntervals: options.diffIntervals ?? false,
      driftAttribution: options.driftAttribution ?? false,
      driftSummary: options.driftSummary ?? false,
      eventOrderSweep: options.eventOrderSweep ?? false,
      featureProbes: options.featureProbes ?? false,
      frameSweep: options.frameSweep ?? false,
      globalAlignment: options.globalAlignment ?? false,
      hitErrorFit: options.hitErrorFit ?? false,
      intervalMaxTotal: options.intervalMaxTotal,
      intervalMinTotal: options.intervalMinTotal,
      isLazer: options.isLazer ?? false,
      json: options.json ?? false,
      label: options.label,
      limit: options.limit ?? 8,
      mods: options.mods,
      osgAlign: options.osgAlign ?? false,
      osgClusters: options.osgClusters ?? false,
      osgEvents: options.osgEvents ?? false,
      osgRawExposure: options.osgRawExposure ?? false,
      osgResidueRuns: options.osgResidueRuns ?? false,
      osgResidueTrace: options.osgResidueTrace ?? false,
      replayPath: options.replayPath,
      resolveFinal: options.resolveFinal ?? false,
      resolveIntervals: options.resolveIntervals ?? false,
      ruleProbes: options.ruleProbes ?? false,
      scoreDiagnostics: options.scoreDiagnostics ?? false,
      scoreResolve: options.scoreResolve ?? false,
      sourceFit: options.sourceFit ?? false,
      stableHeldOkTimeoutJudgment: options.stableHeldOkTimeoutJudgment,
      stableNextNoteEdgeGrace: options.stableNextNoteEdgeGrace,
      stableOsgPath: options.stableOsgPath,
      stableThresholdGrid: options.stableThresholdGrid ?? false,
      stableThresholdSweep: options.stableThresholdSweep ?? false,
      stableTimingDeltaVariant: options.stableTimingDeltaVariant,
      stableTimingSweep: options.stableTimingSweep ?? false,
      timeIntervals: options.timeIntervals ?? false,
      updateLoopTrace: options.updateLoopTrace ?? false,
      visibleIntervals: options.visibleIntervals ?? false,
    };
  }

  if (positionals.length !== 2) usage();
  const scoreId = Number(positionals[0]);
  if (!Number.isInteger(scoreId) || scoreId <= 0) usage();

  return {
    alignmentCandidates: options.alignmentCandidates ?? false,
    breakTimeline: options.breakTimeline ?? false,
    cacheDir: options.cacheDir ?? DEFAULT_CACHE_DIR,
    candidateEvidence: options.candidateEvidence ?? false,
    capturePath: positionals[1],
    compareTarget: options.compareTarget ?? "play",
    aroundTime: options.aroundTime,
    aroundTotal: options.aroundTotal,
    column: options.column,
    componentExposure: options.componentExposure ?? false,
    componentIntervals: options.componentIntervals ?? false,
    context: options.context ?? 8,
    counterTail: options.counterTail ?? false,
    diffIntervals: options.diffIntervals ?? false,
    driftAttribution: options.driftAttribution ?? false,
    driftSummary: options.driftSummary ?? false,
    eventOrderSweep: options.eventOrderSweep ?? false,
    featureProbes: options.featureProbes ?? false,
    frameSweep: options.frameSweep ?? false,
    globalAlignment: options.globalAlignment ?? false,
    hitErrorFit: options.hitErrorFit ?? false,
    intervalMaxTotal: options.intervalMaxTotal,
    intervalMinTotal: options.intervalMinTotal,
    isLazer: options.isLazer ?? false,
    json: options.json ?? false,
    limit: options.limit ?? 8,
    osgAlign: options.osgAlign ?? false,
    osgClusters: options.osgClusters ?? false,
    osgEvents: options.osgEvents ?? false,
    osgRawExposure: options.osgRawExposure ?? false,
    osgResidueRuns: options.osgResidueRuns ?? false,
    osgResidueTrace: options.osgResidueTrace ?? false,
    resolveFinal: options.resolveFinal ?? false,
    resolveIntervals: options.resolveIntervals ?? false,
    ruleProbes: options.ruleProbes ?? false,
    scoreDiagnostics: options.scoreDiagnostics ?? false,
    scoreResolve: options.scoreResolve ?? false,
    sourceFit: options.sourceFit ?? false,
    scoreId,
    stableHeldOkTimeoutJudgment: options.stableHeldOkTimeoutJudgment,
    stableNextNoteEdgeGrace: options.stableNextNoteEdgeGrace,
    stableOsgPath: options.stableOsgPath,
    stableThresholdGrid: options.stableThresholdGrid ?? false,
    stableThresholdSweep: options.stableThresholdSweep ?? false,
    stableTimingDeltaVariant: options.stableTimingDeltaVariant,
    stableTimingSweep: options.stableTimingSweep ?? false,
    timeIntervals: options.timeIntervals ?? false,
    updateLoopTrace: options.updateLoopTrace ?? false,
    visibleIntervals: options.visibleIntervals ?? false,
  };
}

function parseModList(raw: string): string[] {
  const value = raw.trim().toUpperCase();
  if (!value || value === "NM") return [];

  const tokens = /[,+\s]/.test(value)
    ? value.split(/[,+\s]+/)
    : value.match(/.{1,2}/g) ?? [];

  return tokens
    .map((token) => token.trim())
    .filter((token) => token && token !== "NM");
}

function countsFromHitObject(hits: Record<string, unknown> | undefined): ReplayHitCounts {
  const value = (key: string) => {
    const raw = hits?.[key];
    return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  };
  return {
    countGeki: value("geki"),
    count300: value("300"),
    countKatu: value("katu"),
    count100: value("100"),
    count50: value("50"),
    countMiss: value("0"),
  };
}

function countsFromScore(score: OsuScore): ReplayHitCounts {
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

function countsFromDecodedInfo(info: any): ReplayHitCounts {
  const stats = info?.statistics ?? {};
  const value = (...keys: string[]) => {
    for (const key of keys) {
      const raw = info?.[key] ?? stats[key];
      if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
    }
    return 0;
  };

  return {
    countGeki: value("countGeki", "perfect", "geki"),
    count300: value("count300", "great", "300"),
    countKatu: value("countKatu", "good", "katu"),
    count100: value("count100", "ok", "100"),
    count50: value("count50", "meh", "50"),
    countMiss: value("countMiss", "miss", "0"),
  };
}

function countsSignature(counts: ReplayHitCounts): string {
  return [
    counts.countGeki,
    counts.count300,
    counts.countKatu,
    counts.count100,
    counts.count50,
    counts.countMiss,
  ].join("/");
}

function countsEqual(a: ReplayHitCounts, b: ReplayHitCounts): boolean {
  return countsSignature(a) === countsSignature(b);
}

function addJudgment(counts: ReplayHitCounts, judgment: Judgment | null): void {
  switch (judgment) {
    case 1:
      counts.countGeki++;
      break;
    case 2:
      counts.count300++;
      break;
    case 3:
      counts.countKatu++;
      break;
    case 4:
      counts.count100++;
      break;
    case 5:
      counts.count50++;
      break;
    case 6:
      counts.countMiss++;
      break;
  }
}

function cloneCounts(counts: ReplayHitCounts): ReplayHitCounts {
  return { ...counts };
}

function subtractCounts(a: ReplayHitCounts, b: ReplayHitCounts): ReplayHitCounts {
  return {
    countGeki: a.countGeki - b.countGeki,
    count300: a.count300 - b.count300,
    countKatu: a.countKatu - b.countKatu,
    count100: a.count100 - b.count100,
    count50: a.count50 - b.count50,
    countMiss: a.countMiss - b.countMiss,
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseCaptureSnapshot(row: any): PlaySnapshot | null {
  if (row?.type !== "sample") return null;
  const raw = row.raw;
  if (raw?.state?.name !== "play") return null;

  const time = asNumber(raw?.beatmap?.time?.live) ?? asNumber(row.normalized?.currentTime);
  if (time == null) return null;

  const counts = countsFromHitObject(raw?.play?.hits);
  const hitErrors = Array.isArray(raw?.play?.hitErrorArray)
    ? raw.play.hitErrorArray.filter((value: unknown): value is number => typeof value === "number" && Number.isFinite(value))
    : [];
  return {
    accuracy: asNumber(raw?.play?.accuracy) ?? asNumber(row.normalized?.accuracy),
    combo: asNumber(raw?.play?.combo?.current) ?? asNumber(row.normalized?.combo),
    counts,
    elapsedMs: asNumber(row.elapsedMs),
    hitErrors,
    maxCombo: asNumber(raw?.play?.combo?.max) ?? asNumber(row.normalized?.maxCombo),
    score: asNumber(raw?.play?.score) ?? asNumber(row.normalized?.score),
    sequence: Number(row.sequence ?? 0),
    sliderBreaks: asNumber(raw?.play?.hits?.sliderBreaks),
    time,
    total: getReplayHitCountTotal(counts),
  };
}

function parseResultScreenSnapshot(row: any): ResultScreenSnapshot | null {
  if (row?.type !== "sample") return null;

  const resultsScreen = row.raw?.resultsScreen;
  if (!resultsScreen || typeof resultsScreen !== "object") return null;

  const counts = countsFromHitObject(resultsScreen.hits);
  const total = getReplayHitCountTotal(counts);
  if (total <= 0) return null;

  return {
    counts,
    createdAt: asString(resultsScreen.createdAt),
    elapsedMs: asNumber(row.elapsedMs),
    playerName: asString(resultsScreen.playerName) ?? asString(resultsScreen.name),
    score: asNumber(resultsScreen.score),
    scoreId: asNumber(resultsScreen.scoreId),
    sequence: Number(row.sequence ?? 0),
    time: asNumber(row.raw?.beatmap?.time?.live) ?? asNumber(row.normalized?.currentTime),
    total,
  };
}

function parseLeaderboardSnapshot(row: any): LeaderboardSnapshot | null {
  if (row?.type !== "sample") return null;
  if (row.raw?.state?.name !== "play") return null;
  if (!Array.isArray(row.raw?.leaderboard) || row.raw.leaderboard.length === 0) return null;

  const entries = row.raw.leaderboard
    .map((entry: any): LeaderboardEntry | null => {
      const hits = entry?.hits;
      if (!hits || typeof hits !== "object") return null;

      return {
        accuracy: asNumber(entry.accuracy),
        comboMax: asNumber(entry.combo?.max),
        count100: asNumber(hits["100"]) ?? 0,
        count300: asNumber(hits["300"]) ?? 0,
        count50: asNumber(hits["50"]) ?? 0,
        countMiss: asNumber(hits["0"]) ?? 0,
        id: asNumber(entry.id),
        name: asString(entry.name),
        position: asNumber(entry.position),
        score: asNumber(entry.score),
      };
    })
    .filter((entry: LeaderboardEntry | null): entry is LeaderboardEntry => entry != null);

  if (entries.length === 0) return null;

  return {
    elapsedMs: asNumber(row.elapsedMs),
    entries,
    sequence: Number(row.sequence ?? 0),
    time: asNumber(row.raw?.beatmap?.time?.live) ?? asNumber(row.normalized?.currentTime),
  };
}

function splitCaptureSegments(samples: PlaySnapshot[]): CaptureSegment[] {
  const segments: CaptureSegment[] = [];
  let current: PlaySnapshot[] = [];
  let previous: PlaySnapshot | null = null;

  function flush() {
    if (current.length === 0) return;
    segments.push({
      endTime: current[current.length - 1].time,
      maxTotal: Math.max(...current.map((sample) => sample.total)),
      samples: current,
      startSequence: current[0].sequence,
      startTime: current[0].time,
    });
    current = [];
  }

  for (const sample of samples) {
    const timeReset = previous && sample.time < previous.time - 1000;
    const countReset = previous && sample.total < previous.total;
    if (timeReset || countReset) flush();
    current.push(sample);
    previous = sample;
  }

  flush();
  return segments;
}

async function readCapture(capturePath: string): Promise<CaptureData> {
  const text = await readFile(path.resolve(process.cwd(), capturePath), "utf8");
  const allPlaySamples: PlaySnapshot[] = [];
  const samples: PlaySnapshot[] = [];
  const leaderboardSnapshots: LeaderboardSnapshot[] = [];
  const resultScreens: ResultScreenSnapshot[] = [];
  let lastSignature = "";
  let lastResultScreenSignature = "";
  let finalLeaderboard: LeaderboardSnapshot | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);

    const resultScreen = parseResultScreenSnapshot(row);
    if (resultScreen) {
      const signature = [
        resultScreen.scoreId,
        resultScreen.score,
        resultScreen.createdAt,
        countsSignature(resultScreen.counts),
      ].join(":");
      if (signature !== lastResultScreenSignature) {
        resultScreens.push(resultScreen);
        lastResultScreenSignature = signature;
      }
    }

    const leaderboard = parseLeaderboardSnapshot(row);
    if (leaderboard) {
      leaderboardSnapshots.push(leaderboard);
      finalLeaderboard = leaderboard;
    }

    const sample = parseCaptureSnapshot(row);
    if (!sample) continue;
    allPlaySamples.push(sample);
    const signature = countsSignature(sample.counts);
    if (signature === lastSignature) continue;
    samples.push(sample);
    lastSignature = signature;
  }

  const segments = splitCaptureSegments(samples);
  const segment = segments
    .filter((candidate) => candidate.maxTotal > 0)
    .sort((a, b) => b.maxTotal - a.maxTotal || b.startSequence - a.startSequence)[0];
  if (!segment) throw new Error("Capture does not contain a playable segment with non-zero play.hits.");
  return {
    finalLeaderboard,
    leaderboardSnapshots,
    playSamples: allPlaySamples,
    resultScreens,
    selectedSegment: segment,
    segments,
  };
}

async function readStableOsg(osgPath: string): Promise<StableOsgData> {
  const resolvedPath = path.resolve(process.cwd(), osgPath);
  const buffer = await readFile(resolvedPath);
  if (buffer.length < 8) throw new Error(`Stable .osg file is too short: ${osgPath}`);

  const version = buffer.readInt32LE(0);
  const count = buffer.readInt32LE(4);
  const stride = 29;
  const expectedBytes = 8 + count * stride;
  if (count < 0 || expectedBytes > buffer.length) {
    throw new Error(`Stable .osg has an invalid record count: ${osgPath}`);
  }

  const samples: PlaySnapshot[] = [];
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * stride;
    const counts: ReplayHitCounts = {
      count300: buffer.readUInt16LE(offset + 5),
      count100: buffer.readUInt16LE(offset + 7),
      count50: buffer.readUInt16LE(offset + 9),
      countGeki: buffer.readUInt16LE(offset + 11),
      countKatu: buffer.readUInt16LE(offset + 13),
      countMiss: buffer.readUInt16LE(offset + 15),
    };

    samples.push({
      accuracy: null,
      combo: buffer.readUInt16LE(offset + 23),
      counts,
      elapsedMs: buffer.readInt32LE(offset),
      hitErrors: [],
      maxCombo: buffer.readUInt16LE(offset + 21),
      score: buffer.readInt32LE(offset + 17),
      sequence: index + 1,
      sliderBreaks: null,
      time: buffer.readInt32LE(offset),
      total: getReplayHitCountTotal(counts),
    });
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) throw new Error(`Stable .osg has no score records: ${osgPath}`);

  return {
    count,
    path: resolvedPath,
    segment: {
      endTime: last.time,
      maxTotal: Math.max(...samples.map((sample) => sample.total)),
      samples,
      startSequence: first.sequence,
      startTime: first.time,
    },
    version,
  };
}

function fixturePaths(cacheDir: string, scoreId: number) {
  const dir = path.resolve(process.cwd(), cacheDir, String(scoreId));
  return {
    beatmap: path.join(dir, "beatmap.osu"),
    replay: path.join(dir, "replay.osr"),
    score: path.join(dir, "score.json"),
  };
}

function decodeFrames(decodedScore: any): ReplayFrame[] {
  const rawFrames = (decodedScore.replay?.frames ?? []) as any[];
  return decodeStableManiaReplayFrames(rawFrames);
}

function buildStableSimulationOptions(
  options: Pick<CliOptions, "stableHeldOkTimeoutJudgment" | "stableNextNoteEdgeGrace">,
  speedMultiplier: number,
): ManiaReplaySimulationOptions {
  return {
    legacyReplayFrameRounding: true,
    speedMultiplier,
    ...(options.stableHeldOkTimeoutJudgment != null
      ? { stableHeldOkTimeoutJudgment: options.stableHeldOkTimeoutJudgment }
      : {}),
    ...(options.stableNextNoteEdgeGrace != null
      ? { stableNextNoteEdgeGrace: options.stableNextNoteEdgeGrace }
      : {}),
  };
}

async function simulateScore(options: CliOptions) {
  const scoreId = options.scoreId;
  if (scoreId == null) throw new Error("Score simulation requires a score id.");
  const cacheDir = options.cacheDir;
  const paths = fixturePaths(cacheDir, scoreId);
  let scoreText: string;
  let beatmapContent: string;
  let replayBuffer: Buffer;

  try {
    [scoreText, beatmapContent, replayBuffer] = await Promise.all([
      readFile(paths.score, "utf8"),
      readFile(paths.beatmap, "utf8"),
      readFile(paths.replay),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing replay fixture for ${scoreId}. Run: npm run replay:validate -- --refresh ${scoreId}`);
    }
    throw error;
  }

  const score = JSON.parse(scoreText) as OsuScore;
  // Converts only honor the xK keymod; the convert column formula decides otherwise.
  const parseKeyCount = getManiaParseKeyCount(score.beatmap, score.mods) ?? undefined;
  const beatmap = parseManiaBeatmap(beatmapContent, { keyCount: parseKeyCount });
  const decoded = await new ScoreDecoder().decodeFromBuffer(replayBuffer);
  const frames = decodeFrames(decoded);
  const mods = getModAcronyms(score.mods, false);
  const ruleset = getManiaReplayRuleset(isLazerScore(score), mods, score.beatmap?.convert ?? false);
  const notes = applyManiaReplayModsToNotes(beatmap.notes, beatmap.keyCount, mods);
  const windows = getManiaReplayHitWindows(beatmap.od, ruleset);
  const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
  const noteDuration = notes.length > 0 ? Math.max(...notes.map((note) => note.endTime)) : 0;
  const segments = buildReplaySegments(frames, beatmap.keyCount, Math.max(frameDuration, noteDuration + windows.miss * 1.5));
  const simulated = simulateManiaReplayJudgements(
    notes,
    segments,
    beatmap.keyCount,
    windows,
    ruleset.accuracyMode,
    buildStableSimulationOptions(options, ruleset.speedMultiplier),
  );
  const allEvents = [...simulated.events]
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const events = allEvents
    .filter((event) => event.judgment != null)
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const cumulativeByOrdinal: ReplayHitCounts[] = [];
  const cumulative = emptyReplayHitCounts();

  for (const event of events) {
    addJudgment(cumulative, event.judgment);
    cumulativeByOrdinal.push(cloneCounts(cumulative));
  }

  return {
    accuracyMode: ruleset.accuracyMode,
    allEvents,
    beatmap,
    cumulativeByOrdinal,
    events,
    expectedCounts: countsFromScore(score),
    frames,
    metadata: {
      beatmap: `${score.beatmapset?.title ?? beatmap.title} [${score.beatmap?.version ?? beatmap.version}]`,
      idLabel: String(scoreId),
      keyCount: beatmap.keyCount,
      mods,
      player: score.user?.username ?? "Unknown",
    },
    mods,
    noteStates: simulated.noteStates,
    notes,
    replayCounts: countsFromDecodedInfo(decoded.info),
    replayScore: asNumber(decoded.info?.totalScore),
    replayScoreId: asNumber(decoded.info?.id),
    score,
    simulatedCounts: cumulativeByOrdinal[cumulativeByOrdinal.length - 1] ?? emptyReplayHitCounts(),
    segments,
    windows,
  };
}

async function simulateLocal(options: CliOptions) {
  if (!options.beatmapPath || !options.replayPath) throw new Error("Local comparison requires --beatmap and --replay.");

  const [beatmapContent, replayBuffer] = await Promise.all([
    readFile(path.resolve(process.cwd(), options.beatmapPath), "utf8"),
    readFile(path.resolve(process.cwd(), options.replayPath)),
  ]);

  const beatmap = parseManiaBeatmap(beatmapContent);
  const decoded = await new ScoreDecoder().decodeFromBuffer(replayBuffer);
  const frames = decodeFrames(decoded);
  const mods = options.mods ?? parseModList(String(decoded.info?.mods ?? ""));
  const ruleset = getManiaReplayRuleset(options.isLazer, mods, false);
  const notes = applyManiaReplayModsToNotes(beatmap.notes, beatmap.keyCount, mods);
  const windows = getManiaReplayHitWindows(beatmap.od, ruleset);
  const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
  const noteDuration = notes.length > 0 ? Math.max(...notes.map((note) => note.endTime)) : 0;
  const segments = buildReplaySegments(frames, beatmap.keyCount, Math.max(frameDuration, noteDuration + windows.miss * 1.5));
  const simulated = simulateManiaReplayJudgements(
    notes,
    segments,
    beatmap.keyCount,
    windows,
    ruleset.accuracyMode,
    buildStableSimulationOptions(options, ruleset.speedMultiplier),
  );
  const allEvents = [...simulated.events]
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const events = allEvents
    .filter((event) => event.judgment != null)
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const cumulativeByOrdinal: ReplayHitCounts[] = [];
  const cumulative = emptyReplayHitCounts();

  for (const event of events) {
    addJudgment(cumulative, event.judgment);
    cumulativeByOrdinal.push(cloneCounts(cumulative));
  }

  return {
    accuracyMode: ruleset.accuracyMode,
    allEvents,
    beatmap,
    cumulativeByOrdinal,
    events,
    expectedCounts: countsFromDecodedInfo(decoded.info),
    frames,
    metadata: {
      beatmap: `${beatmap.title} [${beatmap.version}]`,
      idLabel: options.label ?? path.basename(options.replayPath),
      keyCount: beatmap.keyCount,
      mods,
      player: String(decoded.info?.username ?? "Local replay"),
    },
    mods,
    noteStates: simulated.noteStates,
    notes,
    replayCounts: countsFromDecodedInfo(decoded.info),
    replayScore: asNumber(decoded.info?.totalScore),
    replayScoreId: asNumber(decoded.info?.id),
    score: null,
    simulatedCounts: cumulativeByOrdinal[cumulativeByOrdinal.length - 1] ?? emptyReplayHitCounts(),
    segments,
    windows,
  };
}

function countsAtTime(events: Array<{ judgment: Judgment | null; time: number }>, time: number): ReplayHitCounts {
  const counts = emptyReplayHitCounts();
  for (const event of events) {
    if (event.time > time) break;
    addJudgment(counts, event.judgment);
  }
  return counts;
}

function pickResultScreenTarget(capture: CaptureData, simulation: SimulationResult): ResultScreenSnapshot {
  const resultScreen = capture.resultScreens.find((snapshot) => countsEqual(snapshot.counts, simulation.replayCounts))
    ?? capture.resultScreens.find((snapshot) => countsEqual(snapshot.counts, simulation.expectedCounts))
    ?? capture.resultScreens.find((snapshot) => countsEqual(snapshot.counts, capture.selectedSegment.samples[capture.selectedSegment.samples.length - 1].counts))
    ?? capture.resultScreens[capture.resultScreens.length - 1];

  if (!resultScreen) {
    throw new Error("Capture does not contain a result-screen record for --target result-screen.");
  }

  return resultScreen;
}

function selectComparisonTarget(
  options: CliOptions,
  capture: CaptureData,
  simulation: SimulationResult,
  stableOsg: StableOsgData | null,
): ComparisonTarget {
  switch (options.compareTarget) {
    case "header":
      return {
        counts: simulation.expectedCounts,
        label: "score/API header",
        target: options.compareTarget,
      };
    case "replay":
      return {
        counts: simulation.replayCounts,
        label: "decoded .osr header",
        target: options.compareTarget,
      };
    case "result-screen": {
      const resultScreen = pickResultScreenTarget(capture, simulation);
      return {
        counts: resultScreen.counts,
        label: `result-screen${resultScreen.scoreId != null ? ` scoreId ${resultScreen.scoreId}` : ""}`,
        target: options.compareTarget,
      };
    }
    case "stable-osg": {
      if (!stableOsg) throw new Error("--target stable-osg requires --stable-osg FILE.osg");
      return {
        counts: stableOsg.segment.samples[stableOsg.segment.samples.length - 1].counts,
        label: `stable .osg ${path.basename(stableOsg.path)}`,
        target: options.compareTarget,
      };
    }
    case "play":
      return {
        counts: capture.selectedSegment.samples[capture.selectedSegment.samples.length - 1].counts,
        label: "selected play segment",
        target: options.compareTarget,
      };
  }
}

function formatCounts(counts: ReplayHitCounts): string {
  return `${counts.countGeki}/${counts.count300}/${counts.countKatu}/${counts.count100}/${counts.count50}/${counts.countMiss}`;
}

function formatDiff(diff: ReplayHitCounts): string {
  const value = (count: number) => count > 0 ? `+${count}` : String(count);
  return `${value(diff.countGeki)}/${value(diff.count300)}/${value(diff.countKatu)}/${value(diff.count100)}/${value(diff.count50)}/${value(diff.countMiss)}`;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function formatVisibleCounts(counts: ReplayHitCounts): string {
  return `${counts.count300}/${counts.count100}/${counts.count50}/${counts.countMiss}`;
}

function formatVisibleDiff(diff: ReplayHitCounts): string {
  const value = (count: number) => count > 0 ? `+${count}` : String(count);
  return `${value(diff.count300)}/${value(diff.count100)}/${value(diff.count50)}/${value(diff.countMiss)}`;
}

function formatHiddenStableDiff(diff: ReplayHitCounts): string {
  const value = (count: number) => count > 0 ? `+${count}` : String(count);
  return `${value(diff.countGeki)}/${value(diff.countKatu)}`;
}

function visibleCountsEqual(a: ReplayHitCounts, b: ReplayHitCounts): boolean {
  return a.count300 === b.count300
    && a.count100 === b.count100
    && a.count50 === b.count50
    && a.countMiss === b.countMiss;
}

function accuracyFor(counts: ReplayHitCounts, mode: "stable" | "lazer"): number {
  return calculateReplayAccuracy(replayHitCountsToArray(counts), mode);
}

type SimulationResult = Awaited<ReturnType<typeof simulateScore>> | Awaited<ReturnType<typeof simulateLocal>>;
type SimJudgementEvent = SimulationResult["events"][number];
type SimReplayEvent = SimulationResult["allEvents"][number];

interface SimHitErrorEvent {
  noteIndex: number;
  offset: number;
  part: "break" | "head" | "tail" | "note";
  result: Judgment | null;
  time: number;
}

interface IndexedSimHitErrorEvent extends SimHitErrorEvent {
  componentIndex: number;
}

interface CaptureHitErrorObservation {
  capturedError: number;
  capturedIndex: number;
  previousSample: PlaySnapshot;
  sample: PlaySnapshot;
}

interface CaptureHitErrorMatch {
  cost: number;
  indexDistance: number;
  observation: CaptureHitErrorObservation;
  timeDistance: number;
}

interface ComponentMatch {
  capturedError: number;
  capturedIndex: number;
  component: SimHitErrorEvent | null;
  componentIndex: number | null;
  scoreOrdinal: number | null;
}

interface ComponentObservationMatch extends ComponentMatch {
  observation: CaptureHitErrorObservation;
}

interface IndexedSimEvent {
  event: SimJudgementEvent;
  ordinal: number;
}

interface StableManiaScoreTraceEntry {
  bonus: number;
  combo: number;
  event: SimReplayEvent;
  maxCombo: number;
  scoreFloor: number;
  scoreOrdinal: number;
  scoreRaw: number;
  scoreRounded: number;
  time: number;
}

interface StableManiaScoreTrace {
  byOrdinal: StableManiaScoreTraceEntry[];
  label: string;
  timeline: StableManiaScoreTraceEntry[];
}

type StableManiaScoreOrder = "event-time" | "note-end" | "note-index";

interface StableManiaScoreJudgmentValues {
  hitBonus: number;
  hitBonusValue: number;
  hitPunishment: number;
  hitValue: number;
}

interface StableThresholdProfile {
  goodCombined: number;
  goodHead: number;
  label: string;
  maxCombined: number;
  maxHead: number;
  okCombined: number;
  okHead: number;
  threeHundredCombined: number;
  threeHundredHead: number;
  useFloorWindows: boolean;
}

interface ScoreOverrideCandidate {
  event: SimJudgementEvent;
  from: Judgment;
  ordinal: number;
  to: Judgment;
}

interface ScoreOverrideEvaluation {
  candidates: ScoreOverrideCandidate[];
  countDiff: ReplayHitCounts;
  counts: ReplayHitCounts;
  score: number;
  scoreDelta: number;
  scoreDiff: number;
}

interface ScoreOverrideGroup {
  candidates: ScoreOverrideCandidate[];
  from: Judgment;
  needed: number;
  to: Judgment;
}

function stableManiaScoreJudgmentValues(judgment: Judgment): StableManiaScoreJudgmentValues {
  switch (judgment) {
    case 0:
      return { hitBonus: 0, hitBonusValue: 0, hitPunishment: Number.POSITIVE_INFINITY, hitValue: 0 };
    case 1:
      return { hitBonus: 2, hitBonusValue: 32, hitPunishment: 0, hitValue: 320 };
    case 2:
      return { hitBonus: 1, hitBonusValue: 32, hitPunishment: 0, hitValue: 300 };
    case 3:
      return { hitBonus: 0, hitBonusValue: 16, hitPunishment: 8, hitValue: 200 };
    case 4:
      return { hitBonus: 0, hitBonusValue: 8, hitPunishment: 24, hitValue: 100 };
    case 5:
      return { hitBonus: 0, hitBonusValue: 4, hitPunishment: 44, hitValue: 50 };
    case 6:
      return { hitBonus: 0, hitBonusValue: 0, hitPunishment: Number.POSITIVE_INFINITY, hitValue: 0 };
  }
}

function clampStableManiaBonus(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function getStableManiaScoreModMultiplier(mods: string[], keyCount: number): number {
  let multiplier = 1;

  for (const mod of mods) {
    if (mod === "EZ" || mod === "NF" || mod === "HT" || mod === "DC") {
      multiplier *= 0.5;
    }

    const keyMatch = /^([1-9])K$/.exec(mod);
    if (keyMatch) {
      const actualColumns = Number(keyMatch[1]);
      if (actualColumns > keyCount) multiplier *= 0.9;
      else if (actualColumns < keyCount) multiplier *= 0.9 - 0.04 * (keyCount - actualColumns);
    }
  }

  return multiplier;
}

function getStableManiaScoreModDivider(mods: string[]): number {
  let divider = 1;

  for (const mod of mods) {
    if (mod === "HR") divider *= 1.08;
    else if (mod === "DT" || mod === "NC") divider *= 1.1;
    else if (mod === "FI" || mod === "HD" || mod === "FL") divider *= 1.06;
  }

  return divider;
}

function buildStableManiaScoreTrace(
  simulation: SimulationResult,
  useUpdatedBonusForScore: boolean,
  resetComboOnHoldBreak: boolean,
  scoreOrder: StableManiaScoreOrder,
  judgmentOverrides: Map<SimReplayEvent, Judgment> = new Map(),
): StableManiaScoreTrace {
  const totalNotes = Math.max(1, simulation.events.length);
  const modMultiplier = getStableManiaScoreModMultiplier(simulation.metadata.mods, simulation.metadata.keyCount);
  const modDivider = getStableManiaScoreModDivider(simulation.metadata.mods);
  const noteScale = 1_000_000 * modMultiplier * 0.5 / totalNotes / 320;
  const byOrdinal: StableManiaScoreTraceEntry[] = [];
  const timeline: StableManiaScoreTraceEntry[] = [];
  const orderedEvents = [...simulation.allEvents]
    .sort((a, b) => {
      if (scoreOrder === "note-index") {
        return a.noteIndex - b.noteIndex || a.time - b.time || a.column - b.column;
      }

      if (scoreOrder === "note-end") {
        const noteA = simulation.notes[a.noteIndex];
        const noteB = simulation.notes[b.noteIndex];
        const endA = noteA?.endTime ?? a.time;
        const endB = noteB?.endTime ?? b.time;
        return endA - endB || a.noteIndex - b.noteIndex || a.time - b.time || a.column - b.column;
      }

      return a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column;
    });
  let bonus = 100;
  let combo = 0;
  let maxCombo = 0;
  let scoreOrdinal = 0;
  let scoreRaw = 0;

  for (const event of orderedEvents) {
    const judgment = event.judgment == null ? null : judgmentOverrides.get(event) ?? event.judgment;
    if (judgment == null) {
      if (resetComboOnHoldBreak && event.part === "hold-break") combo = 0;
      timeline.push({
        bonus,
        combo,
        event,
        maxCombo,
        scoreFloor: Math.floor(scoreRaw),
        scoreOrdinal,
        scoreRaw,
        scoreRounded: Math.round(scoreRaw),
        time: event.time,
      });
      continue;
    }

    const values = stableManiaScoreJudgmentValues(judgment);
    const nextBonus = Number.isFinite(values.hitPunishment)
      ? clampStableManiaBonus(bonus + values.hitBonus - values.hitPunishment / modDivider)
      : 0;
    const scoreBonus = useUpdatedBonusForScore ? nextBonus : bonus;

    scoreRaw += noteScale * (
      values.hitValue
      + values.hitBonusValue * Math.sqrt(scoreBonus)
    );
    bonus = nextBonus;

    if (judgment === 6) {
      combo = 0;
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
    }

    scoreOrdinal++;

    const entry: StableManiaScoreTraceEntry = {
      bonus,
      combo,
      event,
      maxCombo,
      scoreFloor: Math.floor(scoreRaw),
      scoreOrdinal,
      scoreRaw,
      scoreRounded: Math.round(scoreRaw),
      time: event.time,
    };
    byOrdinal.push(entry);
    timeline.push(entry);
  }

  return {
    byOrdinal,
    label: `${useUpdatedBonusForScore ? "bonus-after-hit" : "bonus-before-hit"}`
      + `, order ${scoreOrder}`
      + `${resetComboOnHoldBreak ? ", body-break resets combo" : ", miss-only combo"}`,
    timeline,
  };
}

function stableScoreEntryAtTime(
  trace: StableManiaScoreTrace,
  time: number,
): StableManiaScoreTraceEntry | null {
  let result: StableManiaScoreTraceEntry | null = null;

  for (const entry of trace.timeline) {
    if (entry.time > time) break;
    result = entry;
  }

  return result;
}

function scoreDiffText(simulated: number, captured: number | null): string {
  if (captured == null) return "diff ?";
  const diff = simulated - captured;
  return `diff ${diff > 0 ? `+${diff}` : diff}`;
}

function formatScoreTraceEntry(entry: StableManiaScoreTraceEntry): string {
  return (
    `floor ${entry.scoreFloor} round ${entry.scoreRounded} raw ${entry.scoreRaw.toFixed(3)} `
    + `combo ${entry.combo} maxCombo ${entry.maxCombo} bonus ${entry.bonus.toFixed(3)}`
  );
}

function firstStableScoreDriftByOrdinal(
  capture: CaptureSegment,
  trace: StableManiaScoreTrace,
): { entry: StableManiaScoreTraceEntry; sample: PlaySnapshot } | null {
  for (const sample of capture.samples) {
    if (sample.total <= 0 || sample.score == null) continue;
    const entry = trace.byOrdinal[sample.total - 1];
    if (!entry) continue;

    if (
      entry.scoreFloor !== sample.score
      || (sample.combo != null && entry.combo !== sample.combo)
      || (sample.maxCombo != null && entry.maxCombo !== sample.maxCombo)
    ) {
      return { entry, sample };
    }
  }

  return null;
}

function firstStableScoreDriftByTime(
  capture: CaptureSegment,
  trace: StableManiaScoreTrace,
): { entry: StableManiaScoreTraceEntry; sample: PlaySnapshot } | null {
  for (const sample of capture.samples) {
    if (sample.score == null) continue;
    const entry = stableScoreEntryAtTime(trace, sample.time);
    if (!entry) continue;

    if (
      entry.scoreFloor !== sample.score
      || (sample.combo != null && entry.combo !== sample.combo)
      || (sample.maxCombo != null && entry.maxCombo !== sample.maxCombo)
    ) {
      return { entry, sample };
    }
  }

  return null;
}

function printStableScoreDriftIntervals(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  trace: StableManiaScoreTrace,
): void {
  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const minimumScoreDiffChange = 25;
  let previous: { diff: number; entry: StableManiaScoreTraceEntry; sample: PlaySnapshot } | null = null;
  let printed = 0;

  console.log(
    `  score-drift intervals for ${trace.label}`
    + `${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`,
  );

  for (const sample of capture.samples) {
    if (sample.total <= 0 || sample.score == null) continue;

    const entry = trace.byOrdinal[sample.total - 1];
    if (!entry) continue;

    const current = {
      diff: entry.scoreFloor - sample.score,
      entry,
      sample,
    };

    if (!previous) {
      previous = current;
      continue;
    }

    const intervalStart = previous.sample.total + 1;
    const intervalEnd = sample.total;

    if (intervalEnd < minTotal || intervalStart > maxTotal) {
      previous = current;
      continue;
    }

    const diffChange = current.diff - previous.diff;
    const comboChanged = sample.maxCombo != null
      && entry.maxCombo !== sample.maxCombo
      && previous.entry.maxCombo === previous.sample.maxCombo;

    if (Math.abs(diffChange) < minimumScoreDiffChange && !comboChanged) {
      previous = current;
      continue;
    }

    const capturedScoreDelta = sample.score - (previous.sample.score ?? 0);
    const simulatedScoreDelta = entry.scoreFloor - previous.entry.scoreFloor;
    console.log(
      `    totals ${intervalStart}-${intervalEnd} `
      + `time ${Math.round(previous.sample.time)}->${Math.round(sample.time)}ms `
      + `scoreDiff ${previous.diff > 0 ? `+${previous.diff}` : previous.diff}`
      + `->${current.diff > 0 ? `+${current.diff}` : current.diff} `
      + `delta cap ${capturedScoreDelta} sim ${simulatedScoreDelta}`,
    );
    console.log(
      `      combo cap ${formatNullableNumber(sample.combo)} max ${formatNullableNumber(sample.maxCombo)}; `
      + `sim combo ${entry.combo} max ${entry.maxCombo} bonus ${entry.bonus.toFixed(3)}`,
    );

    const eventCount = intervalEnd - intervalStart + 1;
    if (eventCount <= options.context * 2) {
      for (let ordinal = intervalStart; ordinal <= intervalEnd; ordinal++) {
        console.log(formatSimEvent(simulation, ordinal));
      }
    } else {
      console.log(`      ${eventCount} score events omitted; rerun with --around-total ${intervalStart} or a tighter --min-total/--max-total.`);
    }

    printed++;
    previous = current;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("    No score-drift intervals found in the selected range.");
  }
}

function buildComparison(capture: CaptureSegment, simulation: SimulationResult, target: ComparisonTarget, limit: number) {
  const finalCapture = capture.samples[capture.samples.length - 1];
  const finalSim = simulation.simulatedCounts;
  const finalDiff = diffReplayHitCounts(finalSim, finalCapture.counts);
  const headerDiff = diffReplayHitCounts(finalSim, simulation.expectedCounts);
  const replayDiff = diffReplayHitCounts(finalSim, simulation.replayCounts);
  const targetDiff = diffReplayHitCounts(finalSim, target.counts);
  const ordinalDivergences = [];
  const timeDivergences = [];

  for (const sample of capture.samples) {
    if (sample.total <= 0) continue;
    const ordinalCounts = simulation.cumulativeByOrdinal[sample.total - 1];
    if (ordinalCounts && !countsEqual(ordinalCounts, sample.counts)) {
      ordinalDivergences.push({
        diff: diffReplayHitCounts(ordinalCounts, sample.counts),
        sample,
        simulated: ordinalCounts,
      });
      if (ordinalDivergences.length >= limit) break;
    }
  }

  for (const sample of capture.samples) {
    const simulated = countsAtTime(simulation.events, sample.time);
    if (!countsEqual(simulated, sample.counts)) {
      timeDivergences.push({
        diff: diffReplayHitCounts(simulated, sample.counts),
        sample,
        simulated,
      });
      if (timeDivergences.length >= limit) break;
    }
  }

  const checkpoints = checkpointTotals
    .filter((target) => target <= finalCapture.total)
    .map((target) => {
      const sample = capture.samples.find((entry) => entry.total >= target);
      if (!sample) return null;
      const simulated = simulation.cumulativeByOrdinal[sample.total - 1] ?? emptyReplayHitCounts();
      return {
        diff: diffReplayHitCounts(simulated, sample.counts),
        sample,
        simulated,
        target,
      };
    })
    .filter((entry) => entry != null);

  return {
    accuracy: {
      capture: accuracyFor(finalCapture.counts, simulation.accuracyMode),
      expectedHeader: accuracyFor(simulation.expectedCounts, simulation.accuracyMode),
      replay: accuracyFor(simulation.replayCounts, simulation.accuracyMode),
      simulated: accuracyFor(finalSim, simulation.accuracyMode),
      target: accuracyFor(target.counts, simulation.accuracyMode),
    },
    capture: {
      endTime: capture.endTime,
      final: finalCapture,
      maxTotal: capture.maxTotal,
      sampleCount: capture.samples.length,
      startSequence: capture.startSequence,
      startTime: capture.startTime,
    },
    checkpoints,
    finalDiff,
    finalSim,
    headerDiff,
    headerCounts: simulation.expectedCounts,
    replayDiff,
    replayCounts: simulation.replayCounts,
    metadata: {
      accuracyMode: simulation.accuracyMode,
      beatmap: simulation.metadata.beatmap,
      idLabel: simulation.metadata.idLabel,
      keyCount: simulation.metadata.keyCount,
      mods: simulation.metadata.mods,
      player: simulation.metadata.player,
    },
    ordinalDivergences,
    target: {
      counts: target.counts,
      diff: targetDiff,
      label: target.label,
      target: target.target,
    },
    timeDivergences,
  };
}

type StableEventOrderVariant =
  | "current"
  | "column-asc"
  | "column-desc"
  | "note-desc"
  | "column-desc-note-desc";

function compareEventOrder(
  a: SimJudgementEvent,
  b: SimJudgementEvent,
  variant: StableEventOrderVariant,
): number {
  const byTime = a.time - b.time;
  if (byTime !== 0) return byTime;

  switch (variant) {
    case "column-asc":
      return a.column - b.column || a.noteIndex - b.noteIndex;
    case "column-desc":
      return b.column - a.column || a.noteIndex - b.noteIndex;
    case "note-desc":
      return b.noteIndex - a.noteIndex || b.column - a.column;
    case "column-desc-note-desc":
      return b.column - a.column || b.noteIndex - a.noteIndex;
    case "current":
      return a.noteIndex - b.noteIndex || a.column - b.column;
  }
}

function simulationWithEventOrder(
  simulation: SimulationResult,
  variant: StableEventOrderVariant,
): SimulationResult {
  const events = [...simulation.events].sort((a, b) => compareEventOrder(a, b, variant));
  const cumulativeByOrdinal: ReplayHitCounts[] = [];
  const cumulative = emptyReplayHitCounts();

  for (const event of events) {
    addJudgment(cumulative, event.judgment);
    cumulativeByOrdinal.push(cloneCounts(cumulative));
  }

  return {
    ...simulation,
    cumulativeByOrdinal,
    events,
    simulatedCounts: cumulativeByOrdinal[cumulativeByOrdinal.length - 1] ?? emptyReplayHitCounts(),
  };
}

function countOrdinalMismatches(capture: CaptureSegment, simulation: SimulationResult): number {
  let mismatches = 0;
  for (const sample of capture.samples) {
    if (sample.total <= 0) continue;
    const counts = simulation.cumulativeByOrdinal[sample.total - 1];
    if (counts && !countsEqual(counts, sample.counts)) mismatches++;
  }
  return mismatches;
}

function countTimeMismatches(capture: CaptureSegment, simulation: SimulationResult): number {
  let mismatches = 0;
  for (const sample of capture.samples) {
    const counts = countsAtTime(simulation.events, sample.time);
    if (!countsEqual(counts, sample.counts)) mismatches++;
  }
  return mismatches;
}

function firstOrdinalMismatchTotal(capture: CaptureSegment, simulation: SimulationResult): number | null {
  for (const sample of capture.samples) {
    if (sample.total <= 0) continue;
    const counts = simulation.cumulativeByOrdinal[sample.total - 1];
    if (counts && !countsEqual(counts, sample.counts)) return sample.total;
  }
  return null;
}

function stableOsgAlignmentFitForOrder(
  osg: StableOsgData,
  simulation: SimulationResult,
  minTotal: number,
  maxTotal: number,
): { matched: number; target: number; unmatchedSim: number; unmatchedTarget: number } {
  const tokens = buildStableOsgJudgmentTokens(osg, simulation, minTotal, maxTotal);
  const simOrdinals = simulation.events
    .map((_, index) => index + 1)
    .filter((ordinal) => ordinal >= minTotal && ordinal <= maxTotal);
  const ops = buildStableOsgJudgmentAlignment(simulation, tokens, simOrdinals);
  const matched = ops.filter((op) => op.type === "match").length;
  const unmatchedSim = ops.filter((op) => op.type === "sim").length;
  const unmatchedTarget = ops.filter((op) => op.type === "target").length;
  return { matched, target: tokens.length, unmatchedSim, unmatchedTarget };
}

function printStableEventOrderSweep(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
  stableOsg: StableOsgData | null,
): void {
  if (!options.eventOrderSweep) return;

  console.log("\nStable same-time event order sweep:");
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: event-order sweep only models stable osu!mania replay playback.");
    return;
  }

  const variants: StableEventOrderVariant[] = [
    "current",
    "column-asc",
    "column-desc",
    "note-desc",
    "column-desc-note-desc",
  ];
  const targetScore = stableOsg?.segment.samples[stableOsg.segment.samples.length - 1].score ?? null;
  const aroundTotal = options.aroundTotal;
  const minTotal = options.intervalMinTotal
    ?? (aroundTotal == null ? 1 : Math.max(1, aroundTotal - options.context));
  const maxTotal = options.intervalMaxTotal
    ?? (aroundTotal == null ? Number.POSITIVE_INFINITY : aroundTotal + options.context);

  for (const variant of variants) {
    const ordered = simulationWithEventOrder(simulation, variant);
    const counts = ordered.simulatedCounts;
    const diff = diffReplayHitCounts(counts, target.counts);
    const trace = buildStableManiaScoreTrace(ordered, true, false, "event-time");
    const score = trace.byOrdinal.at(-1)?.scoreFloor ?? null;
    const fit = stableOsg && Number.isFinite(maxTotal)
      ? stableOsgAlignmentFitForOrder(stableOsg, ordered, minTotal, maxTotal)
      : null;
    const fitText = fit
      ? ` align ${fit.matched}/${fit.target} un ${fit.unmatchedSim}/${fit.unmatchedTarget}`
      : "";
    const scoreText = score != null && targetScore != null
      ? ` scoreDiffApprox ${formatSignedNumber(score - targetScore)}`
      : "";
    console.log(
      `  ${variant.padEnd(21)} diff ${formatDiff(diff)} visible ${formatVisibleDiff(diff)} `
      + `distance ${countDiffDistance(diff)}/${visibleDiffDistance(diff)} `
      + `ordinalMis ${countOrdinalMismatches(capture, ordered)} timeMis ${countTimeMismatches(capture, ordered)} `
      + `firstOrd ${firstOrdinalMismatchTotal(capture, ordered) ?? "-"}`
      + fitText
      + scoreText,
    );
  }
}

function printComparison(comparison: ReturnType<typeof buildComparison>): void {
  const mods = comparison.metadata.mods.length > 0 ? ` +${comparison.metadata.mods.join("")}` : "";
  console.log(`\n${comparison.metadata.idLabel} ${comparison.metadata.accuracyMode} ${comparison.metadata.keyCount}K${mods}`);
  console.log(`${comparison.metadata.player} - ${comparison.metadata.beatmap}`);
  console.log(`Capture samples ${comparison.capture.sampleCount}, time ${comparison.capture.startTime} -> ${comparison.capture.endTime}, total ${comparison.capture.final.total}`);
  console.log(`Counts capture ${formatCounts(comparison.capture.final.counts)}`);
  console.log(`Counts sim     ${formatCounts(comparison.finalSim)}  diff ${formatDiff(comparison.finalDiff)}`);
  console.log(
    `Visible stable ${formatVisibleCounts(comparison.finalSim)}  `
    + `diff ${formatVisibleDiff(comparison.finalDiff)} (300/100/50/miss)`,
  );
  if (comparison.target.target !== "play") {
    console.log(`Counts target  ${formatCounts(comparison.target.counts)}  diff ${formatDiff(comparison.target.diff)} (${comparison.target.label})`);
  }
  console.log(`Counts header  ${formatCounts(comparison.headerCounts)}  diff ${formatDiff(comparison.headerDiff)}`);
  if (!countsEqual(comparison.replayCounts, comparison.headerCounts)) {
    console.log(`Counts replay  ${formatCounts(comparison.replayCounts)}  diff ${formatDiff(comparison.replayDiff)}`);
  }
  console.log(
    `Accuracy capture ${comparison.accuracy.capture.toFixed(6)} `
    + `sim ${comparison.accuracy.simulated.toFixed(6)} `
    + (comparison.target.target !== "play" ? `target ${comparison.accuracy.target.toFixed(6)} ` : "")
    + `header ${comparison.accuracy.expectedHeader.toFixed(6)}`
    + (!countsEqual(comparison.replayCounts, comparison.headerCounts)
      ? ` replay ${comparison.accuracy.replay.toFixed(6)}`
      : ""),
  );

  const firstOrdinal = comparison.ordinalDivergences[0];
  if (firstOrdinal) {
    console.log(`\nFirst ordinal divergence at total ${firstOrdinal.sample.total}, time ${firstOrdinal.sample.time}:`);
    console.log(`  capture ${formatCounts(firstOrdinal.sample.counts)}`);
    console.log(`  sim     ${formatCounts(firstOrdinal.simulated)}  diff ${formatDiff(firstOrdinal.diff)}`);
  } else {
    console.log("\nNo ordinal divergence found.");
  }

  const firstTime = comparison.timeDivergences[0];
  if (firstTime) {
    console.log(`\nFirst time divergence at ${firstTime.sample.time}ms, capture total ${firstTime.sample.total}:`);
    console.log(`  capture ${formatCounts(firstTime.sample.counts)}`);
    console.log(`  sim     ${formatCounts(firstTime.simulated)}  diff ${formatDiff(firstTime.diff)}`);
  } else {
    console.log("\nNo time divergence found.");
  }

  console.log("\nCheckpoints:");
  for (const checkpoint of comparison.checkpoints) {
    console.log(
      `  >=${String(checkpoint.target).padStart(4)} @ ${String(checkpoint.sample.time).padStart(6)}ms `
      + `cap ${formatCounts(checkpoint.sample.counts)} sim ${formatCounts(checkpoint.simulated)} diff ${formatDiff(checkpoint.diff)}`,
    );
  }
}

function printStableOsgComparison(
  options: CliOptions,
  osg: StableOsgData | null,
  simulation: SimulationResult,
): void {
  if (!osg) return;

  const final = osg.segment.samples[osg.segment.samples.length - 1];
  const target: ComparisonTarget = {
    counts: final.counts,
    label: "stable .osg final",
    target: "replay",
  };
  const comparison = buildComparison(osg.segment, simulation, target, options.limit);
  const replayVsOsg = diffReplayHitCounts(final.counts, simulation.replayCounts);
  const headerVsOsg = diffReplayHitCounts(final.counts, simulation.expectedCounts);

  console.log(`\nStable .osg timeline (${path.basename(osg.path)})`);
  console.log(
    `  version ${osg.version}, records ${osg.count}, `
    + `time ${osg.segment.startTime}->${osg.segment.endTime}ms, total ${final.total}`,
  );
  console.log(
    `  final .osg score ${formatNullableNumber(final.score)} `
    + `combo ${formatNullableNumber(final.combo)} maxCombo ${formatNullableNumber(final.maxCombo)} `
    + `counts ${formatCounts(final.counts)}`,
  );
  console.log(`  sim counts ${formatCounts(comparison.finalSim)} diff ${formatDiff(comparison.finalDiff)}`);
  console.log(`  decoded .osr counts ${formatCounts(simulation.replayCounts)} diff .osg-vs-replay ${formatDiff(replayVsOsg)}`);
  if (!countsEqual(simulation.expectedCounts, simulation.replayCounts)) {
    console.log(`  score/API counts ${formatCounts(simulation.expectedCounts)} diff .osg-vs-header ${formatDiff(headerVsOsg)}`);
  }

  const firstOrdinal = comparison.ordinalDivergences[0];
  if (firstOrdinal) {
    console.log(`  first ordinal divergence total ${firstOrdinal.sample.total} at ${firstOrdinal.sample.time}ms`);
    console.log(`    .osg ${formatCounts(firstOrdinal.sample.counts)}`);
    console.log(`    sim  ${formatCounts(firstOrdinal.simulated)} diff ${formatDiff(firstOrdinal.diff)}`);
  } else {
    console.log("  no ordinal divergence found");
  }

  const firstTime = comparison.timeDivergences[0];
  if (firstTime) {
    console.log(`  first time divergence at ${firstTime.sample.time}ms (.osg total ${firstTime.sample.total})`);
    console.log(`    .osg ${formatCounts(firstTime.sample.counts)}`);
    console.log(`    sim  ${formatCounts(firstTime.simulated)} diff ${formatDiff(firstTime.diff)}`);
  } else {
    console.log("  no time divergence found");
  }

  console.log("  checkpoints:");
  for (const checkpoint of comparison.checkpoints) {
    console.log(
      `    >=${String(checkpoint.target).padStart(4)} @ ${String(checkpoint.sample.time).padStart(6)}ms `
      + `.osg ${formatCounts(checkpoint.sample.counts)} `
      + `sim ${formatCounts(checkpoint.simulated)} diff ${formatDiff(checkpoint.diff)}`,
    );
  }
}

function stableScoreTracePoint(
  entry: StableManiaScoreTraceEntry | null | undefined,
): { combo: number; maxCombo: number; scoreFloor: number } {
  return {
    combo: entry?.combo ?? 0,
    maxCombo: entry?.maxCombo ?? 0,
    scoreFloor: entry?.scoreFloor ?? 0,
  };
}

function formatScoreDelta(value: number | null): string {
  return value == null ? "?" : formatSignedNumber(value);
}

function printStableOsgEventRows(
  options: CliOptions,
  osg: StableOsgData | null,
  simulation: SimulationResult,
): void {
  if (!options.osgEvents || !osg) return;

  const singleJudgmentFromDelta = (counts: ReplayHitCounts): Judgment | null => {
    if (getReplayHitCountTotal(counts) !== 1) return null;
    if (counts.countGeki === 1) return 1;
    if (counts.count300 === 1) return 2;
    if (counts.countKatu === 1) return 3;
    if (counts.count100 === 1) return 4;
    if (counts.count50 === 1) return 5;
    if (counts.countMiss === 1) return 6;
    return null;
  };
  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const trace = buildStableManiaScoreTrace(simulation, true, false, "event-time");
  const directLabels: Array<{ from: Judgment; ordinal: number; to: Judgment }> = [];
  let previous: PlaySnapshot | null = null;
  let mismatches = 0;
  let printed = 0;
  const nearbyRadius = Math.min(options.context, 6);

  const printNearbyOrdinalContext = (centerOrdinal: number) => {
    if (nearbyRadius <= 0) return;
    const start = Math.max(1, centerOrdinal - nearbyRadius);
    const end = Math.min(simulation.events.length, centerOrdinal + nearbyRadius);
    console.log(`      nearby sim ordinals ${start}-${end}:`);
    for (let ordinal = start; ordinal <= end; ordinal++) {
      console.log(`        ${formatCompactSimEvent(simulation, ordinal)}`);
    }
  };

  console.log(`\nStable .osg row/event mismatches${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of osg.segment.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    if (sample.total <= previousSample.total) continue;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const osgDelta = subtractCounts(sample.counts, previousSample.counts);
    const simOrdinalBefore = countsAtOrdinal(simulation, previousSample.total);
    const simOrdinalAfter = countsAtOrdinal(simulation, sample.total);
    const simOrdinalDelta = subtractCounts(simOrdinalAfter, simOrdinalBefore);
    const simTimeBefore = countsAtTime(simulation.events, previousSample.time);
    const simTimeAfter = countsAtTime(simulation.events, sample.time);
    const simTimeDelta = subtractCounts(simTimeAfter, simTimeBefore);

    const ordinalBeforeScore = stableScoreTracePoint(trace.byOrdinal[previousSample.total - 1]);
    const ordinalAfterScore = stableScoreTracePoint(trace.byOrdinal[sample.total - 1]);
    const timeBeforeScore = stableScoreTracePoint(stableScoreEntryAtTime(trace, previousSample.time));
    const timeAfterScore = stableScoreTracePoint(stableScoreEntryAtTime(trace, sample.time));
    const osgScoreDelta = sample.score != null && previousSample.score != null
      ? sample.score - previousSample.score
      : null;
    const ordinalScoreDelta = ordinalAfterScore.scoreFloor - ordinalBeforeScore.scoreFloor;
    const timeScoreDelta = timeAfterScore.scoreFloor - timeBeforeScore.scoreFloor;
    const countMismatch = !countsEqual(osgDelta, simOrdinalDelta);
    const scoreMismatch = options.scoreDiagnostics
      && osgScoreDelta != null
      && Math.abs(ordinalScoreDelta - osgScoreDelta) >= 100;

    if (!countMismatch && !scoreMismatch) continue;
    mismatches++;

    const timeOrdinals: number[] = [];
    for (let index = 0; index < simulation.events.length; index++) {
      const event = simulation.events[index];
      if (event.time <= previousSample.time) continue;
      if (event.time > sample.time) break;
      timeOrdinals.push(index + 1);
    }
    const osgSingleJudgment = singleJudgmentFromDelta(osgDelta);
    const directOrdinal = intervalStart === intervalEnd && timeOrdinals.length === 1 && timeOrdinals[0] === intervalStart
      ? intervalStart
      : null;
    const directEvent = directOrdinal != null ? simulation.events[directOrdinal - 1] : null;
    if (
      osgSingleJudgment != null
      && directOrdinal != null
      && directEvent?.judgment != null
      && directEvent.judgment !== osgSingleJudgment
    ) {
      directLabels.push({
        from: directEvent.judgment,
        ordinal: directOrdinal,
        to: osgSingleJudgment,
      });
    }

    if (printed >= options.limit) continue;

    console.log(
      `\n  row ${previousSample.sequence}->${sample.sequence} totals ${intervalStart}-${intervalEnd} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(
      `    .osg delta ${formatDiff(osgDelta)} score ${formatNullableNumber(previousSample.score)}->${formatNullableNumber(sample.score)} `
      + `(${formatScoreDelta(osgScoreDelta)}) combo ${formatNullableNumber(sample.combo)} max ${formatNullableNumber(sample.maxCombo)}`,
    );
    console.log(
      `    sim ordinal ${formatDiff(simOrdinalDelta)} score ${ordinalBeforeScore.scoreFloor}->${ordinalAfterScore.scoreFloor} `
      + `(${formatSignedNumber(ordinalScoreDelta)}) combo ${ordinalAfterScore.combo} max ${ordinalAfterScore.maxCombo}`,
    );
    console.log(
      `    sim time    ${formatDiff(simTimeDelta)} score ${timeBeforeScore.scoreFloor}->${timeAfterScore.scoreFloor} `
      + `(${formatSignedNumber(timeScoreDelta)}) combo ${timeAfterScore.combo} max ${timeAfterScore.maxCombo}`,
    );

    if (intervalEnd - intervalStart + 1 <= options.context * 2) {
      console.log("    ordinal events:");
      for (let ordinal = intervalStart; ordinal <= intervalEnd; ordinal++) {
        console.log(formatSimEvent(simulation, ordinal));
      }
    } else {
      console.log(`    ${intervalEnd - intervalStart + 1} ordinal events omitted; narrow --min-total/--max-total to inspect them.`);
    }

    const distinctTimeOrdinals = timeOrdinals.filter((ordinal) => ordinal < intervalStart || ordinal > intervalEnd);
    if (distinctTimeOrdinals.length > 0) {
      console.log("    extra time-window events:");
      for (const ordinal of distinctTimeOrdinals.slice(0, options.context * 2)) {
        console.log(formatSimEvent(simulation, ordinal));
      }
      if (distinctTimeOrdinals.length > options.context * 2) {
        console.log(`      ... ${distinctTimeOrdinals.length - options.context * 2} more time-window event(s) omitted`);
      }
    }

    printed++;
  }

  if (mismatches === 0) {
    console.log("  No stable .osg row/event mismatches found in the selected range.");
  } else if (mismatches > printed) {
    console.log(`\n  ... ${mismatches - printed} more mismatched row(s) omitted by --limit`);
  }

  if (directLabels.length > 0) {
    const grouped = new Map<string, Array<{ from: Judgment; ordinal: number; to: Judgment }>>();
    for (const label of directLabels) {
      const key = `${label.from}->${label.to}`;
      const group = grouped.get(key) ?? [];
      group.push(label);
      grouped.set(key, group);
    }

    console.log("\n  single-event .osg judgement disagreements:");
    for (const [key, labels] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${key} x${labels.length}`);
      for (const label of labels.slice(0, Math.min(options.limit, 6))) {
        console.log(formatSimEvent(simulation, label.ordinal));
        printNearbyOrdinalContext(label.ordinal);
      }
      if (labels.length > Math.min(options.limit, 6)) {
        console.log(`      ... ${labels.length - Math.min(options.limit, 6)} more`);
      }
    }

    const targetCounts = osg.segment.samples[osg.segment.samples.length - 1].counts;
    const printOverrideProbe = (label: string, labels: Array<{ ordinal: number; to: Judgment }>) => {
      const overrides = new Map<SimReplayEvent, Judgment>();
      for (const row of labels) {
        const event = simulation.events[row.ordinal - 1];
        if (event?.judgment != null) overrides.set(event, row.to);
      }
      const counts = countsWithJudgmentOverrides(simulation, overrides);
      const diff = diffReplayHitCounts(counts, targetCounts);
      const baseTrace = buildStableManiaScoreTrace(simulation, true, false, "event-time");
      const nextTrace = buildStableManiaScoreTrace(simulation, true, false, "event-time", overrides);
      const baseScore = baseTrace.byOrdinal.at(-1)?.scoreFloor ?? null;
      const nextScore = nextTrace.byOrdinal.at(-1)?.scoreFloor ?? null;
      const targetScore = osg.segment.samples[osg.segment.samples.length - 1].score;
      const scoreText = baseScore == null || nextScore == null || targetScore == null
        ? ""
        : ` scoreDiffApprox ${formatSignedNumber(baseScore - targetScore)}->${formatSignedNumber(nextScore - targetScore)}`;
      console.log(
        `    ${label}: changes ${overrides.size} counts ${formatCounts(counts)} `
        + `diff ${formatDiff(diff)} visible ${formatVisibleDiff(diff)} distance ${countDiffDistance(diff)}/${visibleDiffDistance(diff)}`
        + scoreText,
      );
    };

    console.log("\n  direct .osg disagreement override probes:");
    for (const [key, labels] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
      printOverrideProbe(key, labels);
    }
    printOverrideProbe("all direct disagreements", directLabels);
  }
}

function playSampleAtOrBefore(samples: PlaySnapshot[], time: number): PlaySnapshot | null {
  let best: PlaySnapshot | null = null;
  for (const sample of samples) {
    if (sample.time > time) continue;
    if (!best || sample.time > best.time || (sample.time === best.time && sample.sequence > best.sequence)) {
      best = sample;
    }
  }
  return best;
}

function playSampleAtOrAfter(samples: PlaySnapshot[], time: number): PlaySnapshot | null {
  let best: PlaySnapshot | null = null;
  for (const sample of samples) {
    if (sample.time < time) continue;
    if (!best || sample.time < best.time || (sample.time === best.time && sample.sequence < best.sequence)) {
      best = sample;
    }
  }
  return best;
}

function formatSimHitErrorComponent(simulation: SimulationResult, component: SimHitErrorEvent): string {
  const note = simulation.notes[component.noteIndex];
  return `${formatMs(component.time)}:${component.part}:${formatJudgment(component.result)}:${component.offset}:c${note.column}:n${component.noteIndex}`;
}

function printStableOsgRawExposure(
  options: CliOptions,
  capture: CaptureData,
  osg: StableOsgData | null,
  simulation: SimulationResult,
): void {
  if (!options.osgRawExposure || !osg) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const simComponents = buildSimHitErrorEvents(simulation);
  let previous: PlaySnapshot | null = null;
  let printed = 0;
  let mismatches = 0;

  console.log(`\nStable .osg raw exposure${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of osg.segment.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    if (sample.total <= previousSample.total) continue;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const osgDelta = subtractCounts(sample.counts, previousSample.counts);
    const simOrdinalDelta = subtractCounts(
      countsAtOrdinal(simulation, sample.total),
      countsAtOrdinal(simulation, previousSample.total),
    );
    const simTimeDelta = subtractCounts(
      countsAtTime(simulation.events, sample.time),
      countsAtTime(simulation.events, previousSample.time),
    );
    if (countsEqual(osgDelta, simOrdinalDelta) && countsEqual(osgDelta, simTimeDelta)) continue;
    mismatches++;
    if (printed >= options.limit) continue;

    const rawBefore = playSampleAtOrBefore(capture.playSamples, previousSample.time);
    const rawAfter = playSampleAtOrAfter(capture.playSamples, sample.time)
      ?? playSampleAtOrBefore(capture.playSamples, sample.time);
    const rawTolerance = Math.max(1000, options.context * 120);
    const rawBracketValid = rawBefore != null
      && rawAfter != null
      && Math.abs(previousSample.time - rawBefore.time) <= rawTolerance
      && Math.abs(rawAfter.time - sample.time) <= rawTolerance;
    const rawDelta = rawBracketValid && rawBefore && rawAfter
      ? subtractCounts(rawAfter.counts, rawBefore.counts)
      : null;
    const newErrors = rawBracketValid && rawBefore && rawAfter && rawAfter.hitErrors.length >= rawBefore.hitErrors.length
      ? rawAfter.hitErrors.slice(rawBefore.hitErrors.length)
      : [];
    const componentStart = rawBracketValid && rawBefore ? rawBefore.time : previousSample.time;
    const componentEnd = rawBracketValid && rawAfter ? rawAfter.time : sample.time;
    const intervalComponents = simComponents.filter((component) => (
      component.time > componentStart && component.time <= componentEnd
    ));

    console.log(
      `\n  row ${previousSample.sequence}->${sample.sequence} totals ${intervalStart}-${intervalEnd} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(`    .osg delta ${formatDiff(osgDelta)} score ${formatNullableNumber(previousSample.score)}->${formatNullableNumber(sample.score)}`);
    console.log(`    sim ordinal ${formatDiff(simOrdinalDelta)}; sim time ${formatDiff(simTimeDelta)}`);
    if (!rawBefore || !rawAfter || !rawDelta) {
      console.log("    raw capture: no play samples bracket this .osg interval");
    } else {
      console.log(
        `    raw seq ${rawBefore.sequence}->${rawAfter.sequence} time ${Math.round(rawBefore.time)}->${Math.round(rawAfter.time)}ms `
        + `total ${rawBefore.total}->${rawAfter.total} delta ${formatDiff(rawDelta)} `
        + `score ${formatNullableNumber(rawBefore.score)}->${formatNullableNumber(rawAfter.score)}`,
      );
      console.log(
        `    raw new hitErrors ${newErrors.length}: ${formatTail(newErrors, Math.min(24, Math.max(8, options.context * 2)))}`,
      );
    }
    if (intervalComponents.length > 0) {
      console.log(
        `    sim hit-error components ${intervalComponents.length}: `
        + intervalComponents
          .slice(0, Math.max(1, options.context * 2))
          .map((component) => formatSimHitErrorComponent(simulation, component))
          .join(" "),
      );
      if (intervalComponents.length > options.context * 2) {
        console.log(`      ... ${intervalComponents.length - options.context * 2} more component(s) omitted`);
      }
    } else {
      console.log("    sim hit-error components: none in raw bracket");
    }

    printed++;
  }

  if (mismatches === 0) {
    console.log("  No mismatched .osg rows found in the selected range.");
  } else if (mismatches > printed) {
    console.log(`\n  ... ${mismatches - printed} more raw-exposure row(s) omitted by --limit`);
  }
}

function formatResidueDiff(previous: ReplayHitCounts, next: ReplayHitCounts): string {
  const delta = subtractCounts(next, previous);
  return countsEqual(delta, emptyReplayHitCounts()) ? "same" : formatDiff(delta);
}

function printEventRangeDetails(
  simulation: SimulationResult,
  startOrdinal: number,
  endOrdinal: number,
  limit: number,
): void {
  if (endOrdinal < startOrdinal) return;

  const count = endOrdinal - startOrdinal + 1;
  for (let ordinal = startOrdinal; ordinal <= Math.min(endOrdinal, startOrdinal + limit - 1); ordinal++) {
    console.log(formatSimEvent(simulation, ordinal));
  }
  if (count > limit) {
    console.log(`    ... ${count - limit} more sim ordinal(s) omitted`);
  }
}

function printStableOsgResidueTrace(
  options: CliOptions,
  osg: StableOsgData | null,
  simulation: SimulationResult,
): void {
  if (!options.osgResidueTrace || !osg) return;

  const aroundTotal = options.aroundTotal;
  const minTotal = options.intervalMinTotal
    ?? (aroundTotal == null ? 1 : Math.max(1, aroundTotal - options.context));
  const maxTotal = options.intervalMaxTotal
    ?? (aroundTotal == null ? Number.POSITIVE_INFINITY : aroundTotal + options.context);
  let previousSample: PlaySnapshot | null = null;
  let previousOrdinalResidue = emptyReplayHitCounts();
  let previousTimeResidue = emptyReplayHitCounts();
  let printed = 0;
  let changedRows = 0;
  let lastPrintedTotal = 0;
  let lastInRangeTotal = 0;
  let lastInRangeOrdinalResidue: ReplayHitCounts | null = null;
  let lastInRangeTimeResidue: ReplayHitCounts | null = null;

  console.log(`\nStable .osg accumulated residue trace${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of osg.segment.samples) {
    if (sample.total <= 0) {
      previousSample = sample;
      continue;
    }

    const ordinalCounts = countsAtOrdinal(simulation, sample.total);
    const timeCounts = countsAtTime(simulation.events, sample.time);
    const ordinalResidue = diffReplayHitCounts(ordinalCounts, sample.counts);
    const timeResidue = diffReplayHitCounts(timeCounts, sample.counts);
    const ordinalChanged = !countsEqual(ordinalResidue, previousOrdinalResidue);
    const timeChanged = !countsEqual(timeResidue, previousTimeResidue);
    const inRange = sample.total >= minTotal && sample.total <= maxTotal;

    if (inRange) {
      lastInRangeTotal = sample.total;
      lastInRangeOrdinalResidue = ordinalResidue;
      lastInRangeTimeResidue = timeResidue;
    }

    if ((ordinalChanged || timeChanged) && inRange) {
      changedRows++;
      if (printed < options.limit) {
        const intervalStart = previousSample ? previousSample.total + 1 : sample.total;
        const intervalEnd = sample.total;
        const osgDelta = previousSample ? subtractCounts(sample.counts, previousSample.counts) : sample.counts;
        const simOrdinalDelta = previousSample
          ? subtractCounts(countsAtOrdinal(simulation, sample.total), countsAtOrdinal(simulation, previousSample.total))
          : ordinalCounts;
        const simTimeDelta = previousSample
          ? subtractCounts(countsAtTime(simulation.events, sample.time), countsAtTime(simulation.events, previousSample.time))
          : timeCounts;

        console.log(
          `\n  row ${previousSample?.sequence ?? 0}->${sample.sequence} totals ${intervalStart}-${intervalEnd} `
          + `time ${Math.round(previousSample?.time ?? sample.time)}->${Math.round(sample.time)}ms`,
        );
        console.log(
          `    residue ordinal ${formatDiff(ordinalResidue)} (${formatResidueDiff(previousOrdinalResidue, ordinalResidue)}) `
          + `time ${formatDiff(timeResidue)} (${formatResidueDiff(previousTimeResidue, timeResidue)})`,
        );
        console.log(
          `    row delta .osg ${formatDiff(osgDelta)} simOrdinal ${formatDiff(simOrdinalDelta)} simTime ${formatDiff(simTimeDelta)}`,
        );
        if (lastPrintedTotal > 0 && intervalStart > lastPrintedTotal + 1) {
          console.log(`    residue was unchanged for totals ${lastPrintedTotal + 1}-${intervalStart - 1}`);
        }
        printEventRangeDetails(
          simulation,
          Math.max(1, intervalStart - options.context),
          Math.min(simulation.events.length, intervalEnd + options.context),
          Math.max(1, options.context * 2),
        );
        lastPrintedTotal = intervalEnd;
        printed++;
      }
    }

    previousSample = sample;
    previousOrdinalResidue = ordinalResidue;
    previousTimeResidue = timeResidue;
  }

  if (changedRows === 0) {
    console.log("  No residue changes found in the selected range.");
  } else if (changedRows > printed) {
    console.log(`\n  ... ${changedRows - printed} more residue change row(s) omitted by --limit`);
  }
  if (lastInRangeOrdinalResidue && lastInRangeTimeResidue) {
    console.log(
      `  Last residue at total ${lastInRangeTotal}: `
      + `ordinal ${formatDiff(lastInRangeOrdinalResidue)} time ${formatDiff(lastInRangeTimeResidue)}; `
      + `changes in range ${changedRows}, printed ${printed}`,
    );
  }
}

function printStableOsgResidueRuns(
  options: CliOptions,
  osg: StableOsgData | null,
  simulation: SimulationResult,
): void {
  if (!options.osgResidueRuns || !osg) return;

  interface ResidueRun {
    endResidue: ReplayHitCounts;
    endSample: PlaySnapshot;
    maxDistance: number;
    previousSample: PlaySnapshot | null;
    rows: number;
    startResidue: ReplayHitCounts;
    startSample: PlaySnapshot;
  }

  const isZeroResidue = (counts: ReplayHitCounts) => countsEqual(counts, emptyReplayHitCounts());
  const aroundTotal = options.aroundTotal;
  const minTotal = options.intervalMinTotal
    ?? (aroundTotal == null ? 1 : Math.max(1, aroundTotal - options.context));
  const maxTotal = options.intervalMaxTotal
    ?? (aroundTotal == null ? Number.POSITIVE_INFINITY : aroundTotal + options.context);
  const ordinalRuns: ResidueRun[] = [];
  const timeRuns: ResidueRun[] = [];
  let previousSample: PlaySnapshot | null = null;
  let activeOrdinalRun: ResidueRun | null = null;
  let activeTimeRun: ResidueRun | null = null;

  const updateRuns = (
    runs: ResidueRun[],
    activeRun: ResidueRun | null,
    sample: PlaySnapshot,
    residue: ReplayHitCounts,
  ): ResidueRun | null => {
    if (!isZeroResidue(residue)) {
      if (!activeRun) {
        return {
          endResidue: residue,
          endSample: sample,
          maxDistance: countDiffDistance(residue),
          previousSample,
          rows: 1,
          startResidue: residue,
          startSample: sample,
        };
      }

      activeRun.endResidue = residue;
      activeRun.endSample = sample;
      activeRun.maxDistance = Math.max(activeRun.maxDistance, countDiffDistance(residue));
      activeRun.rows++;
      return activeRun;
    }

    if (activeRun) runs.push(activeRun);
    return null;
  };

  for (const sample of osg.segment.samples) {
    if (sample.total <= 0) {
      previousSample = sample;
      continue;
    }

    const ordinalResidue = diffReplayHitCounts(countsAtOrdinal(simulation, sample.total), sample.counts);
    const timeResidue = diffReplayHitCounts(countsAtTime(simulation.events, sample.time), sample.counts);
    activeOrdinalRun = updateRuns(ordinalRuns, activeOrdinalRun, sample, ordinalResidue);
    activeTimeRun = updateRuns(timeRuns, activeTimeRun, sample, timeResidue);

    previousSample = sample;
  }

  if (activeOrdinalRun) ordinalRuns.push(activeOrdinalRun);
  if (activeTimeRun) timeRuns.push(activeTimeRun);

  const printRuns = (label: string, runs: ResidueRun[]): void => {
    const inRangeRuns = runs.filter((run) => run.endSample.total >= minTotal && run.startSample.total <= maxTotal);
    let printed = 0;

    console.log(`\nStable .osg ${label} residue runs${Number.isFinite(maxTotal) ? ` overlapping totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

    for (const run of inRangeRuns) {
      if (printed >= options.limit) break;
      const previous = run.previousSample;
      const start = run.startSample;
      const end = run.endSample;
      const startRow = previous
        ? `row ${previous.sequence}->${start.sequence} totals ${previous.total + 1}-${start.total}`
        : `row ${start.sequence} total ${start.total}`;
      const endText = end.total === start.total ? `total ${start.total}` : `totals ${start.total}-${end.total}`;

      console.log(
        `\n  run ${printed + 1}: ${endText} rows ${run.rows} `
        + `time ${Math.round(start.time)}->${Math.round(end.time)}ms seq ${start.sequence}->${end.sequence}`,
      );
      console.log(`    starts after ${startRow}`);
      console.log(`    residue ${formatDiff(run.startResidue)} -> ${formatDiff(run.endResidue)} maxD=${run.maxDistance}`);
      printEventRangeDetails(
        simulation,
        Math.max(1, start.total - options.context),
        Math.min(simulation.events.length, start.total + options.context),
        Math.max(1, options.context * 2 + 1),
      );
      printed++;
    }

    if (inRangeRuns.length === 0) {
      console.log("  No nonzero residue runs found in the selected range.");
    } else if (inRangeRuns.length > printed) {
      console.log(`\n  ... ${inRangeRuns.length - printed} more residue run(s) omitted by --limit`);
    }
  };

  printRuns("ordinal", ordinalRuns);
  printRuns("time", timeRuns);
}

interface StableOsgJudgmentToken {
  judgment: Judgment;
  ordinal: number;
  row: number;
  rowDelta: ReplayHitCounts;
  score: number | null;
  scoreDelta: number | null;
  time: number;
}

interface StableOsgAlignmentMatch {
  ordinal: number;
  token: StableOsgJudgmentToken;
}

interface StableOsgAlignmentOp {
  match?: StableOsgAlignmentMatch;
  ordinal?: number;
  token?: StableOsgJudgmentToken;
  type: "match" | "sim" | "target";
}

interface StableOsgAlignmentChunk {
  after?: StableOsgAlignmentMatch;
  before?: StableOsgAlignmentMatch;
  ops: StableOsgAlignmentOp[];
  simOrdinals: number[];
  targetTokens: StableOsgJudgmentToken[];
}

function buildStableOsgJudgmentTokens(
  osg: StableOsgData,
  simulation: SimulationResult,
  minTotal: number,
  maxTotal: number,
): StableOsgJudgmentToken[] {
  const tokens: StableOsgJudgmentToken[] = [];
  const judgments: Judgment[] = [1, 2, 3, 4, 5, 6];
  let previous: PlaySnapshot | null = null;

  for (const sample of osg.segment.samples) {
    const previousCounts = previous?.counts ?? emptyReplayHitCounts();
    const previousTotal = previous?.total ?? 0;
    const delta = subtractCounts(sample.counts, previousCounts);
    const remaining = cloneCounts(delta);
    const orderedJudgments: Judgment[] = [];

    for (let ordinal = previousTotal + 1; ordinal <= sample.total; ordinal++) {
      const judgment = simulation.events[ordinal - 1]?.judgment ?? null;
      if (judgment == null || judgmentCount(remaining, judgment) <= 0) continue;
      orderedJudgments.push(judgment);
      addJudgmentValue(remaining, judgment, -1);
    }

    for (const judgment of judgments) {
      const count = judgmentCount(remaining, judgment);
      for (let index = 0; index < count; index++) orderedJudgments.push(judgment);
    }

    for (let index = 0; index < orderedJudgments.length; index++) {
      const ordinal = previousTotal + index + 1;
      if (ordinal >= minTotal && ordinal <= maxTotal) {
        tokens.push({
          judgment: orderedJudgments[index],
          ordinal,
          row: sample.sequence,
          rowDelta: delta,
          score: sample.score,
          scoreDelta: sample.score != null && previous?.score != null
            ? sample.score - previous.score
            : null,
          time: sample.time,
        });
      }
    }

    previous = sample;
  }

  return tokens;
}

function countStableOsgTokens(tokens: StableOsgJudgmentToken[]): ReplayHitCounts {
  const counts = emptyReplayHitCounts();
  for (const token of tokens) addJudgment(counts, token.judgment);
  return counts;
}

function countSimOrdinals(simulation: SimulationResult, ordinals: number[]): ReplayHitCounts {
  const counts = emptyReplayHitCounts();
  for (const ordinal of ordinals) addJudgment(counts, simulation.events[ordinal - 1]?.judgment ?? null);
  return counts;
}

function formatStableOsgToken(token: StableOsgJudgmentToken): string {
  return `#${String(token.ordinal).padStart(5)} row=${token.row} t=${Math.round(token.time)} `
    + `j=${token.judgment} score=${formatNullableNumber(token.score)} `
    + `scoreDelta=${formatScoreDelta(token.scoreDelta)} rowDelta=${formatCounts(token.rowDelta)}`;
}

function buildStableOsgJudgmentAlignment(
  simulation: SimulationResult,
  tokens: StableOsgJudgmentToken[],
  simOrdinals: number[],
): StableOsgAlignmentOp[] {
  const rowSize = simOrdinals.length + 1;
  const scores = new Uint16Array((tokens.length + 1) * rowSize);
  const directions = new Uint8Array((tokens.length + 1) * rowSize);
  const ordinalRadius = 96;

  for (let i = 1; i <= tokens.length; i++) {
    const token = tokens[i - 1];
    for (let j = 1; j <= simOrdinals.length; j++) {
      const ordinal = simOrdinals[j - 1];
      const simJudgment = simulation.events[ordinal - 1]?.judgment ?? null;
      const canMatch = simJudgment === token.judgment && Math.abs(ordinal - token.ordinal) <= ordinalRadius;
      const index = i * rowSize + j;
      const up = scores[index - rowSize];
      const left = scores[index - 1];
      const diag = scores[index - rowSize - 1] + (canMatch ? 1 : 0);

      if (canMatch && diag >= up && diag >= left) {
        scores[index] = diag;
        directions[index] = 1;
      } else if (up >= left) {
        scores[index] = up;
        directions[index] = 2;
      } else {
        scores[index] = left;
        directions[index] = 3;
      }
    }
  }

  const ops: StableOsgAlignmentOp[] = [];
  let i = tokens.length;
  let j = simOrdinals.length;

  while (i > 0 || j > 0) {
    const direction = i > 0 && j > 0 ? directions[i * rowSize + j] : 0;
    if (i > 0 && j > 0 && direction === 1) {
      ops.push({
        match: { ordinal: simOrdinals[j - 1], token: tokens[i - 1] },
        type: "match",
      });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || direction === 2 || direction === 0)) {
      ops.push({
        token: tokens[i - 1],
        type: "target",
      });
      i--;
    } else {
      ops.push({
        ordinal: simOrdinals[j - 1],
        type: "sim",
      });
      j--;
    }
  }

  return ops.reverse();
}

function buildStableOsgAlignmentChunks(ops: StableOsgAlignmentOp[]): StableOsgAlignmentChunk[] {
  const chunks: StableOsgAlignmentChunk[] = [];
  let current: StableOsgAlignmentChunk | null = null;
  let lastMatch: StableOsgAlignmentMatch | undefined;

  const flush = (after?: StableOsgAlignmentMatch) => {
    if (!current) return;
    current.after = after;
    chunks.push(current);
    current = null;
  };

  for (const op of ops) {
    if (op.type === "match" && op.match) {
      flush(op.match);
      lastMatch = op.match;
      continue;
    }

    if (!current) {
      current = {
        before: lastMatch,
        ops: [],
        simOrdinals: [],
        targetTokens: [],
      };
    }

    current.ops.push(op);
    if (op.type === "sim" && op.ordinal != null) current.simOrdinals.push(op.ordinal);
    if (op.type === "target" && op.token) current.targetTokens.push(op.token);
  }

  flush(undefined);
  return chunks;
}

function formatStableOsgChunkPairSummary(
  simulation: SimulationResult,
  chunk: StableOsgAlignmentChunk,
): string {
  const pairs = new Map<string, number>();
  const pairCount = Math.min(chunk.simOrdinals.length, chunk.targetTokens.length);

  for (let index = 0; index < pairCount; index++) {
    const from = simulation.events[chunk.simOrdinals[index] - 1]?.judgment ?? null;
    const to = chunk.targetTokens[index].judgment;
    if (from == null || from === to) continue;
    const key = `${from}->${to}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  if (pairs.size === 0) return "pairs none";
  return `pairs ${[...pairs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key} x${count}`).join(", ")}`;
}

function summarizeStableOsgAlignmentChunks(
  simulation: SimulationResult,
  chunks: StableOsgAlignmentChunk[],
): { orphanSim: ReplayHitCounts; orphanTarget: ReplayHitCounts; pairs: string } {
  const pairs = new Map<string, number>();
  const orphanSim = emptyReplayHitCounts();
  const orphanTarget = emptyReplayHitCounts();

  for (const chunk of chunks) {
    const pairCount = Math.min(chunk.simOrdinals.length, chunk.targetTokens.length);
    for (let index = 0; index < pairCount; index++) {
      const from = simulation.events[chunk.simOrdinals[index] - 1]?.judgment ?? null;
      const to = chunk.targetTokens[index].judgment;
      if (from == null || from === to) continue;
      const key = `${from}->${to}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }

    for (const ordinal of chunk.simOrdinals.slice(pairCount)) {
      addJudgment(orphanSim, simulation.events[ordinal - 1]?.judgment ?? null);
    }
    for (const token of chunk.targetTokens.slice(pairCount)) {
      addJudgment(orphanTarget, token.judgment);
    }
  }

  return {
    orphanSim,
    orphanTarget,
    pairs: pairs.size === 0
      ? "none"
      : [...pairs.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key, count]) => `${key} x${count}`)
        .join(", "),
  };
}

function printStableOsgJudgmentAlignment(
  options: CliOptions,
  osg: StableOsgData | null,
  simulation: SimulationResult,
): void {
  if (!options.osgAlign || !osg) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = Math.min(options.intervalMaxTotal ?? simulation.events.length, simulation.events.length);
  const tokens = buildStableOsgJudgmentTokens(osg, simulation, minTotal, maxTotal);
  const simOrdinals: number[] = [];
  for (let ordinal = minTotal; ordinal <= maxTotal; ordinal++) simOrdinals.push(ordinal);

  const ops = buildStableOsgJudgmentAlignment(simulation, tokens, simOrdinals);
  const chunks = buildStableOsgAlignmentChunks(ops);
  const matched = ops.filter((op) => op.type === "match").length;
  const unmatchedSim = ops
    .filter((op): op is StableOsgAlignmentOp & { ordinal: number } => op.type === "sim" && op.ordinal != null)
    .map((op) => op.ordinal);
  const unmatchedTarget = ops
    .filter((op): op is StableOsgAlignmentOp & { token: StableOsgJudgmentToken } => op.type === "target" && op.token != null)
    .map((op) => op.token);
  const unmatchedSimCounts = countSimOrdinals(simulation, unmatchedSim);
  const unmatchedTargetCounts = countStableOsgTokens(unmatchedTarget);
  const netDiff = subtractCounts(unmatchedSimCounts, unmatchedTargetCounts);
  const interestingChunks = chunks
    .filter((chunk) => countDiffDistance(subtractCounts(
      countSimOrdinals(simulation, chunk.simOrdinals),
      countStableOsgTokens(chunk.targetTokens),
    )) > 0);
  const chunkSummary = summarizeStableOsgAlignmentChunks(simulation, interestingChunks);

  console.log(`\nStable .osg judgement-sequence alignment totals ${minTotal}-${maxTotal}:`);
  console.log(
    `  matched ${matched}/${tokens.length} target tokens; unmatched sim ${unmatchedSim.length} ${formatCounts(unmatchedSimCounts)} `
    + `.osg ${unmatchedTarget.length} ${formatCounts(unmatchedTargetCounts)} net ${formatDiff(netDiff)}`,
  );
  console.log(`  chunks ${chunks.length}, nonzero-diff chunks ${interestingChunks.length}`);
  console.log(
    `  paired transitions ${chunkSummary.pairs}; orphan sim ${formatCounts(chunkSummary.orphanSim)} `
    + `.osg ${formatCounts(chunkSummary.orphanTarget)}`,
  );

  for (const chunk of interestingChunks.slice(0, options.limit)) {
    const simCounts = countSimOrdinals(simulation, chunk.simOrdinals);
    const targetCounts = countStableOsgTokens(chunk.targetTokens);
    const diff = subtractCounts(simCounts, targetCounts);
    const simRange = chunk.simOrdinals.length > 0
      ? `${chunk.simOrdinals[0]}-${chunk.simOrdinals[chunk.simOrdinals.length - 1]}`
      : "-";
    const targetRange = chunk.targetTokens.length > 0
      ? `${chunk.targetTokens[0].ordinal}-${chunk.targetTokens[chunk.targetTokens.length - 1].ordinal}`
      : "-";
    const rowRange = chunk.targetTokens.length > 0
      ? `${chunk.targetTokens[0].row}-${chunk.targetTokens[chunk.targetTokens.length - 1].row}`
      : "-";
    const timeRange = chunk.targetTokens.length > 0
      ? `${Math.round(chunk.targetTokens[0].time)}-${Math.round(chunk.targetTokens[chunk.targetTokens.length - 1].time)}ms`
      : "-";

    console.log(
      `\n  sim#${simRange} vs .osg#${targetRange} rows ${rowRange} time ${timeRange} `
      + `diff ${formatDiff(diff)} ${formatStableOsgChunkPairSummary(simulation, chunk)}`,
    );
    if (chunk.before) {
      console.log(`    before sim#${chunk.before.ordinal} <-> .osg ${formatStableOsgToken(chunk.before.token)}`);
    }
    if (chunk.simOrdinals.length > 0) {
      console.log("    unmatched sim:");
      for (const ordinal of chunk.simOrdinals.slice(0, Math.min(options.context, 8))) {
        console.log(`      ${formatCompactSimEvent(simulation, ordinal)}`);
      }
      if (chunk.simOrdinals.length > Math.min(options.context, 8)) {
        console.log(`      ... ${chunk.simOrdinals.length - Math.min(options.context, 8)} more sim event(s)`);
      }
    }
    if (chunk.targetTokens.length > 0) {
      console.log("    unmatched .osg:");
      for (const token of chunk.targetTokens.slice(0, Math.min(options.context, 8))) {
        console.log(`      ${formatStableOsgToken(token)}`);
      }
      if (chunk.targetTokens.length > Math.min(options.context, 8)) {
        console.log(`      ... ${chunk.targetTokens.length - Math.min(options.context, 8)} more .osg token(s)`);
      }
    }
    if (chunk.after) {
      console.log(`    after  sim#${chunk.after.ordinal} <-> .osg ${formatStableOsgToken(chunk.after.token)}`);
    }
  }

  if (interestingChunks.length > options.limit) {
    console.log(`\n  ... ${interestingChunks.length - options.limit} more nonzero-diff alignment chunk(s) omitted`);
  }
}

function tokensBetweenOrdinals(
  tokens: StableOsgJudgmentToken[],
  startOrdinal: number,
  endOrdinal: number,
): StableOsgJudgmentToken[] {
  return tokens.filter((token) => token.ordinal >= startOrdinal && token.ordinal <= endOrdinal);
}

function indexedEventsBetweenOrdinals(
  simulation: SimulationResult,
  startOrdinal: number,
  endOrdinal: number,
): IndexedSimEvent[] {
  const indexed: IndexedSimEvent[] = [];
  for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal++) {
    const event = simulation.events[ordinal - 1];
    if (event) indexed.push({ event, ordinal });
  }
  return indexed;
}

function formatClusterResolution(report: LocalIntervalResolutionReport): string {
  const base = formatLocalIntervalResolution(report);
  if (!report.resolved || report.changes.length === 0) return base;
  const changes = report.changes
    .slice(0, 8)
    .map((change) => `#${change.ordinal} ${formatJudgment(change.from)}->${formatJudgment(change.to)}`)
    .join(", ");
  const omitted = report.changes.length > 8 ? `, ... ${report.changes.length - 8} more` : "";
  return `${base}; changes ${changes}${omitted}`;
}

function countIndexedEventsWithOverride(
  indexedEvents: IndexedSimEvent[],
  ordinal: number,
  judgment: Judgment,
): ReplayHitCounts {
  const counts = emptyReplayHitCounts();
  for (const entry of indexedEvents) {
    addJudgment(counts, entry.ordinal === ordinal ? judgment : entry.event.judgment);
  }
  return counts;
}

function printClusterSingleOverrideProbes(
  simulation: SimulationResult,
  indexedEvents: IndexedSimEvent[],
  targetTokens: StableOsgJudgmentToken[],
  targetCounts: ReplayHitCounts,
  currentCounts: ReplayHitCounts,
  targetFinalScore: number | null,
): void {
  const currentDistance = countDiffDistance(diffReplayHitCounts(currentCounts, targetCounts));
  const current = replayHitCountsToArray(currentCounts);
  const target = replayHitCountsToArray(targetCounts);
  const baseTrace = targetFinalScore == null
    ? null
    : buildStableManiaScoreTrace(simulation, true, false, "event-time");
  const baseScore = baseTrace?.byOrdinal.at(-1)?.scoreFloor ?? null;
  const scoreStepAt = (trace: StableManiaScoreTrace | null, ordinal: number): number | null => {
    const entry = trace?.byOrdinal[ordinal - 1];
    if (!entry) return null;
    const previous = ordinal > 1 ? trace.byOrdinal[ordinal - 2]?.scoreFloor ?? 0 : 0;
    return entry.scoreFloor - previous;
  };
  const nearestTargetToken = (ordinal: number, judgment: Judgment): StableOsgJudgmentToken | null => {
    let best: StableOsgJudgmentToken | null = null;
    for (const token of targetTokens) {
      if (token.judgment !== judgment) continue;
      if (!best || Math.abs(token.ordinal - ordinal) < Math.abs(best.ordinal - ordinal)) best = token;
    }
    return best;
  };
  const rows: Array<{
    diff: ReplayHitCounts;
    distance: number;
    event: SimJudgementEvent;
    explicit: boolean;
    from: Judgment;
    ordinal: number;
    scoreDelta: number | null;
    scoreDiff: number | null;
    scoreStepAfter: number | null;
    scoreStepBefore: number | null;
    targetToken: StableOsgJudgmentToken | null;
    to: Judgment;
  }> = [];

  for (const entry of indexedEvents) {
    const from = entry.event.judgment;
    if (from == null || current[from] <= target[from]) continue;

    for (const to of [1, 2, 3, 4, 5, 6] as Judgment[]) {
      if (to === from || current[to] >= target[to]) continue;
      const counts = countIndexedEventsWithOverride(indexedEvents, entry.ordinal, to);
      const diff = diffReplayHitCounts(counts, targetCounts);
      const distance = countDiffDistance(diff);
      if (distance >= currentDistance) continue;
      const overrideTrace = baseScore == null
        ? null
        : buildStableManiaScoreTrace(
            simulation,
            true,
            false,
            "event-time",
            new Map([[entry.event, to]]),
          );
      const overrideScore = overrideTrace?.byOrdinal.at(-1)?.scoreFloor ?? null;
      rows.push({
        diff,
        distance,
        event: entry.event,
        explicit: entry.event.possibleJudgments?.includes(to) ?? false,
        from,
        ordinal: entry.ordinal,
        scoreDelta: overrideScore == null || baseScore == null ? null : overrideScore - baseScore,
        scoreDiff: overrideScore == null || targetFinalScore == null ? null : overrideScore - targetFinalScore,
        scoreStepAfter: scoreStepAt(overrideTrace, entry.ordinal),
        scoreStepBefore: scoreStepAt(baseTrace, entry.ordinal),
        targetToken: nearestTargetToken(entry.ordinal, to),
        to,
      });
    }
  }

  if (rows.length === 0) {
    console.log("    expanded single-change probes: none improve distance");
    return;
  }

  rows.sort((a, b) => a.distance - b.distance
    || (a.targetToken?.scoreDelta == null || a.scoreStepAfter == null ? 1 : 0)
      - (b.targetToken?.scoreDelta == null || b.scoreStepAfter == null ? 1 : 0)
    || (
      a.targetToken?.scoreDelta == null || b.targetToken?.scoreDelta == null
        || a.scoreStepAfter == null || b.scoreStepAfter == null
        ? 0
        : Math.abs(a.scoreStepAfter - a.targetToken.scoreDelta) - Math.abs(b.scoreStepAfter - b.targetToken.scoreDelta)
    )
    || (a.scoreDiff == null ? 1 : 0) - (b.scoreDiff == null ? 1 : 0)
    || (a.scoreDiff == null || b.scoreDiff == null ? 0 : Math.abs(a.scoreDiff) - Math.abs(b.scoreDiff))
    || Number(b.explicit) - Number(a.explicit)
    || a.ordinal - b.ordinal
    || a.to - b.to);
  console.log("    expanded single-change probes:");
  for (const row of rows.slice(0, 6)) {
    const explicit = row.explicit ? "explicit" : "outside";
    const scoreText = row.scoreDelta == null || row.scoreDiff == null
      ? ""
      : ` scoreDelta ${formatSignedNumber(row.scoreDelta)} scoreDiff ${formatSignedNumber(row.scoreDiff)}`;
    const stepText = row.scoreStepBefore == null || row.scoreStepAfter == null
      ? ""
      : ` step ${formatSignedNumber(row.scoreStepBefore)}->${formatSignedNumber(row.scoreStepAfter)}`;
    const targetStepText = row.targetToken?.scoreDelta == null
      ? ""
      : ` target#${row.targetToken.ordinal} step ${formatScoreDelta(row.targetToken.scoreDelta)}`;
    console.log(
      `      #${row.ordinal} ${formatJudgment(row.from)}->${formatJudgment(row.to)} ${explicit} `
      + `distance ${row.distance} diff ${formatDiff(row.diff)}${scoreText}${stepText}${targetStepText} `
      + formatCompactSimEvent(simulation, row.ordinal),
    );
  }
  if (rows.length > 6) {
    console.log(`      ... ${rows.length - 6} more improving single-change probe(s)`);
  }
}

function printStableOsgClusterDiagnostics(
  options: CliOptions,
  osg: StableOsgData | null,
  simulation: SimulationResult,
): void {
  if (!options.osgClusters || !osg) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = Math.min(options.intervalMaxTotal ?? simulation.events.length, simulation.events.length);
  const tokenMinTotal = Math.max(1, minTotal - options.context);
  const tokenMaxTotal = Math.min(simulation.events.length, maxTotal + options.context);
  const tokens = buildStableOsgJudgmentTokens(osg, simulation, minTotal, maxTotal);
  const contextTokens = buildStableOsgJudgmentTokens(osg, simulation, tokenMinTotal, tokenMaxTotal);
  const simOrdinals: number[] = [];
  for (let ordinal = minTotal; ordinal <= maxTotal; ordinal++) simOrdinals.push(ordinal);

  const ops = buildStableOsgJudgmentAlignment(simulation, tokens, simOrdinals);
  const chunks = buildStableOsgAlignmentChunks(ops);
  let printed = 0;

  console.log(`\nStable .osg mismatch cluster diagnostics totals ${minTotal}-${maxTotal}:`);

  for (const chunk of chunks) {
    const simCounts = countSimOrdinals(simulation, chunk.simOrdinals);
    const targetCounts = countStableOsgTokens(chunk.targetTokens);
    const diff = diffReplayHitCounts(simCounts, targetCounts);
    if (countDiffDistance(diff) === 0 && chunk.simOrdinals.length === chunk.targetTokens.length) continue;

    const beforeOrdinal = chunk.before?.ordinal ?? minTotal - 1;
    const afterOrdinal = chunk.after?.ordinal ?? maxTotal + 1;
    const spanStart = Math.max(1, beforeOrdinal + 1);
    const spanEnd = Math.min(simulation.events.length, afterOrdinal - 1);
    const expandedStart = Math.max(1, spanStart - options.context);
    const expandedEnd = Math.min(simulation.events.length, spanEnd + options.context);
    const chunkResolution = resolveLocalInterval(
      chunk.simOrdinals
        .map((ordinal) => ({ event: simulation.events[ordinal - 1], ordinal }))
        .filter((entry): entry is IndexedSimEvent => entry.event != null),
      targetCounts,
    );
    const spanResolution = resolveLocalInterval(
      indexedEventsBetweenOrdinals(simulation, spanStart, spanEnd),
      countStableOsgTokens(tokensBetweenOrdinals(contextTokens, spanStart, spanEnd)),
    );
    const expandedEvents = indexedEventsBetweenOrdinals(simulation, expandedStart, expandedEnd);
    const expandedTargetCounts = countStableOsgTokens(tokensBetweenOrdinals(contextTokens, expandedStart, expandedEnd));
    const expandedResolution = resolveLocalInterval(expandedEvents, expandedTargetCounts);

    console.log(
      `\n  chunk sim#${chunk.simOrdinals[0] ?? "-"}-${chunk.simOrdinals.at(-1) ?? "-"} `
      + `target#${chunk.targetTokens[0]?.ordinal ?? "-"}-${chunk.targetTokens.at(-1)?.ordinal ?? "-"} `
      + `diff ${formatDiff(diff)} ${formatStableOsgChunkPairSummary(simulation, chunk)}`,
    );
    console.log(`    unmatched only  sim ${formatCounts(simCounts)} target ${formatCounts(targetCounts)} -> ${formatClusterResolution(chunkResolution)}`);
    console.log(`    between anchors ${spanStart}-${spanEnd} -> ${formatClusterResolution(spanResolution)}`);
    console.log(`    expanded +/-${options.context} ${expandedStart}-${expandedEnd} -> ${formatClusterResolution(expandedResolution)}`);
    if (!expandedResolution.resolved && expandedResolution.currentTotal === expandedResolution.targetTotal) {
      printClusterSingleOverrideProbes(
        simulation,
        expandedEvents,
        tokensBetweenOrdinals(contextTokens, expandedStart, expandedEnd),
        expandedTargetCounts,
        expandedResolution.currentCounts,
        osg.segment.samples.at(-1)?.score ?? null,
      );
    }

    for (const ordinal of chunk.simOrdinals.slice(0, Math.max(1, options.context * 2))) {
      console.log(`    sim ${formatCompactSimEvent(simulation, ordinal)}`);
    }
    for (const token of chunk.targetTokens.slice(0, Math.max(1, options.context * 2))) {
      console.log(`    tgt ${formatStableOsgToken(token)}`);
    }

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No non-exact mismatch clusters found in the selected range.");
  }
}

function printStableScoreDiagnostics(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
): void {
  if (!options.scoreDiagnostics) return;

  console.log("\nStable ScoreV1 diagnostics:");
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: score diagnostic only models stable osu!mania ScoreV1.");
    return;
  }

  const finalCapture = capture.samples[capture.samples.length - 1];
  const traces = [
    buildStableManiaScoreTrace(simulation, true, false, "event-time"),
    buildStableManiaScoreTrace(simulation, true, false, "note-end"),
    buildStableManiaScoreTrace(simulation, true, false, "note-index"),
    buildStableManiaScoreTrace(simulation, true, true, "event-time"),
    buildStableManiaScoreTrace(simulation, false, false, "event-time"),
  ];

  console.log(
    `  capture final score ${formatNullableNumber(finalCapture.score)} `
    + `combo ${formatNullableNumber(finalCapture.combo)} `
    + `maxCombo ${formatNullableNumber(finalCapture.maxCombo)}`,
  );

  for (const trace of traces) {
    const final = trace.byOrdinal[trace.byOrdinal.length - 1];
    if (!final) {
      console.log(`  ${trace.label}: no score events`);
      continue;
    }

    console.log(
      `  ${trace.label}: ${formatScoreTraceEntry(final)} `
      + `${scoreDiffText(final.scoreFloor, finalCapture.score)} floor, `
      + `${scoreDiffText(final.scoreRounded, finalCapture.score)} round`,
    );
  }

  const primaryTrace = traces[0];
  const ordinalDrift = firstStableScoreDriftByOrdinal(capture, primaryTrace);
  if (ordinalDrift) {
    const { entry, sample } = ordinalDrift;
    console.log(
      `  first ordinal score/combo drift at total ${sample.total}, `
      + `time ${Math.round(sample.time)}ms: `
      + `capture score ${formatNullableNumber(sample.score)} combo ${formatNullableNumber(sample.combo)} `
      + `maxCombo ${formatNullableNumber(sample.maxCombo)}; `
      + `sim ${formatScoreTraceEntry(entry)}`,
    );
  } else {
    console.log("  no ordinal score/combo drift found for bonus-after-hit floor scoring.");
  }

  const timeDrift = firstStableScoreDriftByTime(capture, primaryTrace);
  if (timeDrift) {
    const { entry, sample } = timeDrift;
    console.log(
      `  first time score/combo drift at sample time ${Math.round(sample.time)}ms `
      + `(capture total ${sample.total}): `
      + `capture score ${formatNullableNumber(sample.score)} combo ${formatNullableNumber(sample.combo)} `
      + `maxCombo ${formatNullableNumber(sample.maxCombo)}; `
      + `sim#${entry.scoreOrdinal} ${formatScoreTraceEntry(entry)}`,
    );
  } else {
    console.log("  no time score/combo drift found for bonus-after-hit floor scoring.");
  }

  printStableScoreDriftIntervals(options, capture, simulation, primaryTrace);
}

function countsWithJudgmentOverrides(
  simulation: SimulationResult,
  judgmentOverrides: Map<SimReplayEvent, Judgment>,
): ReplayHitCounts {
  const counts = emptyReplayHitCounts();

  for (const event of simulation.events) {
    addJudgment(counts, judgmentOverrides.get(event) ?? event.judgment);
  }

  return counts;
}

function countDiffDistance(diff: ReplayHitCounts): number {
  return Math.abs(diff.countGeki)
    + Math.abs(diff.count300)
    + Math.abs(diff.countKatu)
    + Math.abs(diff.count100)
    + Math.abs(diff.count50)
    + Math.abs(diff.countMiss);
}

function visibleDiffDistance(diff: ReplayHitCounts): number {
  return Math.abs(diff.count300)
    + Math.abs(diff.count100)
    + Math.abs(diff.count50)
    + Math.abs(diff.countMiss);
}

function formatScoreOverrideCandidate(candidate: ScoreOverrideCandidate): string {
  return `#${String(candidate.ordinal).padStart(5)} ${formatJudgment(candidate.from)}->${formatJudgment(candidate.to)}`;
}

function evaluateScoreOverrides(
  simulation: SimulationResult,
  target: ComparisonTarget,
  captureScore: number,
  baseScore: number,
  candidates: ScoreOverrideCandidate[],
): ScoreOverrideEvaluation {
  const judgmentOverrides = new Map<SimReplayEvent, Judgment>();
  for (const candidate of candidates) {
    judgmentOverrides.set(candidate.event, candidate.to);
  }

  const trace = buildStableManiaScoreTrace(
    simulation,
    true,
    false,
    "event-time",
    judgmentOverrides,
  );
  const score = trace.byOrdinal.at(-1)?.scoreFloor ?? baseScore;
  const counts = countsWithJudgmentOverrides(simulation, judgmentOverrides);
  const countDiff = diffReplayHitCounts(counts, target.counts);

  return {
    candidates,
    countDiff,
    counts,
    score,
    scoreDelta: score - baseScore,
    scoreDiff: score - captureScore,
  };
}

function scoreOverrideSort(a: ScoreOverrideEvaluation, b: ScoreOverrideEvaluation): number {
  return Math.abs(a.scoreDiff) - Math.abs(b.scoreDiff)
    || visibleDiffDistance(a.countDiff) - visibleDiffDistance(b.countDiff)
    || countDiffDistance(a.countDiff) - countDiffDistance(b.countDiff)
    || Math.abs(a.scoreDelta) - Math.abs(b.scoreDelta)
    || a.candidates[0].ordinal - b.candidates[0].ordinal;
}

function formatScoreOverrideEvaluation(
  evaluation: ScoreOverrideEvaluation,
  baseScoreDiff: number,
): string {
  return (
    `${evaluation.candidates.map(formatScoreOverrideCandidate).join(", ")} `
    + `scoreDelta ${formatSignedNumber(evaluation.scoreDelta)} `
    + `scoreDiff ${formatSignedNumber(baseScoreDiff)}->${formatSignedNumber(evaluation.scoreDiff)} `
    + `counts ${formatCounts(evaluation.counts)} diff ${formatDiff(evaluation.countDiff)} `
    + `visible ${formatVisibleDiff(evaluation.countDiff)}`
  );
}

function buildExplicitScoreOverrideCandidates(
  simulation: SimulationResult,
  startOrdinal: number,
): ScoreOverrideCandidate[] {
  const candidates: ScoreOverrideCandidate[] = [];

  for (let index = startOrdinal - 1; index < simulation.events.length; index++) {
    const event = simulation.events[index];
    if (event.judgment == null || !event.possibleJudgments || event.possibleJudgments.length === 0) continue;

    const alternatives = [...new Set(event.possibleJudgments)]
      .filter((judgment): judgment is Judgment => judgment >= 1 && judgment <= 6 && judgment !== event.judgment)
      .sort((a, b) => a - b);

    for (const judgment of alternatives) {
      candidates.push({
        event,
        from: event.judgment,
        ordinal: index + 1,
        to: judgment,
      });
    }
  }

  return candidates;
}

function scoreOverrideCandidateCost(candidate: ScoreOverrideCandidate, explicit: boolean): number {
  return (explicit ? 0 : 1000)
    + Math.abs(candidate.to - candidate.from) * 100
    + (candidate.to > candidate.from ? -Math.abs(candidate.event.offsetMs) : Math.abs(candidate.event.offsetMs));
}

function buildDirectScoreOverrideCandidates(
  simulation: SimulationResult,
  startOrdinal: number,
  from: Judgment,
  to: Judgment,
  limit: number,
): ScoreOverrideCandidate[] {
  return simulation.events
    .map((event, index) => ({ event, ordinal: index + 1 }))
    .filter(({ event, ordinal }) => ordinal >= startOrdinal && event.judgment === from)
    .map(({ event, ordinal }) => {
      const possible = event.possibleJudgments ?? [];
      const explicit = possible.includes(to);
      const candidate = { event, from, ordinal, to };
      return {
        candidate,
        cost: scoreOverrideCandidateCost(candidate, explicit),
        explicit,
      };
    })
    .sort((a, b) => a.cost - b.cost || a.candidate.ordinal - b.candidate.ordinal)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

function buildDirectCountExactOverrideGroups(
  simulation: SimulationResult,
  target: ComparisonTarget,
  startOrdinal: number,
  perGroupLimit: number,
): ScoreOverrideGroup[] {
  const currentCounts = countReplayJudgements(simulation.events);
  const currentArray = replayHitCountsToArray(currentCounts);
  const targetArray = replayHitCountsToArray(target.counts);
  const surplus = currentArray.map((count, judgment) => count - targetArray[judgment]);
  const deficits = targetArray.map((count, judgment) => count - currentArray[judgment]);
  const groups: ScoreOverrideGroup[] = [];

  for (let from = 1; from <= 6; from++) {
    let remainingSurplus = surplus[from];
    if (remainingSurplus <= 0) continue;

    for (let to = 1; to <= 6; to++) {
      if (from === to || deficits[to] <= 0 || remainingSurplus <= 0) continue;

      const needed = Math.min(remainingSurplus, deficits[to]);
      groups.push({
        candidates: buildDirectScoreOverrideCandidates(
          simulation,
          startOrdinal,
          from as Judgment,
          to as Judgment,
          Math.max(perGroupLimit, needed),
        ),
        from: from as Judgment,
        needed,
        to: to as Judgment,
      });
      remainingSurplus -= needed;
      deficits[to] -= needed;
    }
  }

  return groups;
}

function chooseScoreOverrideCandidates(
  candidates: ScoreOverrideCandidate[],
  needed: number,
): ScoreOverrideCandidate[][] {
  const result: ScoreOverrideCandidate[][] = [];
  const current: ScoreOverrideCandidate[] = [];

  function visit(startIndex: number): void {
    if (current.length === needed) {
      result.push([...current]);
      return;
    }

    const remainingNeeded = needed - current.length;
    for (let index = startIndex; index <= candidates.length - remainingNeeded; index++) {
      current.push(candidates[index]);
      visit(index + 1);
      current.pop();
    }
  }

  visit(0);
  return result;
}

function buildDirectCountExactOverrideSets(groups: ScoreOverrideGroup[]): ScoreOverrideCandidate[][] {
  let sets: ScoreOverrideCandidate[][] = [[]];

  for (const group of groups) {
    if (group.candidates.length < group.needed) return [];

    const choices = chooseScoreOverrideCandidates(group.candidates, group.needed);
    const nextSets: ScoreOverrideCandidate[][] = [];

    for (const existing of sets) {
      const existingOrdinals = new Set(existing.map((candidate) => candidate.ordinal));
      for (const choice of choices) {
        if (choice.some((candidate) => existingOrdinals.has(candidate.ordinal))) {
          continue;
        }
        nextSets.push([...existing, ...choice]);
      }
    }

    sets = nextSets;
  }

  return sets;
}

function formatComponentSupport(
  event: SimJudgementEvent,
  observations: CaptureHitErrorObservation[],
  components: IndexedSimHitErrorEvent[],
): string {
  const eventComponents = getHitErrorComponentsForEvent(components, event);
  const matched = eventComponents.filter((component) => findBestCaptureHitErrorMatch(observations, component) != null).length;
  return `${matched}/${eventComponents.length}`;
}

function printScoreResolveDiagnostics(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.scoreResolve) return;

  console.log("\nStable score-constrained ambiguity search:");
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: score resolver only models stable osu!mania ScoreV1.");
    return;
  }

  const finalCapture = capture.samples[capture.samples.length - 1];
  if (finalCapture.score == null) {
    console.log("  skipped: selected play segment does not expose a final score.");
    return;
  }

  if (target.target !== "play") {
    console.log(
      `  note: score target is selected play score ${finalCapture.score}, `
      + `while count target is ${target.label}.`,
    );
  }

  const baseTrace = buildStableManiaScoreTrace(simulation, true, false, "event-time");
  const baseScore = baseTrace.byOrdinal.at(-1)?.scoreFloor;
  if (baseScore == null) {
    console.log("  skipped: simulation has no score events.");
    return;
  }

  const baseCounts = countsWithJudgmentOverrides(simulation, new Map());
  const baseCountDiff = diffReplayHitCounts(baseCounts, target.counts);
  const baseScoreDiff = baseScore - finalCapture.score;
  const startOrdinal = Math.max(1, options.intervalMinTotal ?? 1);
  const candidates = buildExplicitScoreOverrideCandidates(simulation, startOrdinal);

  console.log(
    `  base score ${baseScore} target ${finalCapture.score} `
    + `scoreDiff ${formatSignedNumber(baseScoreDiff)} `
    + `counts ${formatCounts(baseCounts)} diff ${formatDiff(baseCountDiff)} `
    + `visible ${formatVisibleDiff(baseCountDiff)}`,
  );
  console.log(
    `  explicit ambiguity overrides from ordinal ${startOrdinal}: ${candidates.length}`,
  );

  if (candidates.length === 0) {
    console.log("  No explicit possibleJudgments alternatives found in the selected range.");
    return;
  }

  const observations = buildCaptureHitErrorObservations(capture);
  const components = buildIndexedSimHitErrorEvents(simulation);
  const singleEvaluations = candidates
    .map((candidate) => evaluateScoreOverrides(
      simulation,
      target,
      finalCapture.score ?? 0,
      baseScore,
      [candidate],
    ))
    .sort(scoreOverrideSort);

  const improvingSingles = singleEvaluations.filter(
    (evaluation) => Math.abs(evaluation.scoreDiff) < Math.abs(baseScoreDiff),
  ).length;

  console.log(
    `  closest single explicit overrides (${improvingSingles}/${singleEvaluations.length} improve final score diff):`,
  );
  for (const evaluation of singleEvaluations.slice(0, options.limit)) {
    const candidate = evaluation.candidates[0];
    console.log(`    ${formatScoreOverrideEvaluation(evaluation, baseScoreDiff)} components ${formatComponentSupport(candidate.event, observations, components)}`);
    console.log(formatSimEvent(simulation, candidate.ordinal));
  }

  const pairSourceSize = Math.min(singleEvaluations.length, Math.max(16, Math.min(80, options.limit * 8)));
  const pairSource = singleEvaluations.slice(0, pairSourceSize).map((evaluation) => evaluation.candidates[0]);
  const pairEvaluations: ScoreOverrideEvaluation[] = [];

  for (let firstIndex = 0; firstIndex < pairSource.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < pairSource.length; secondIndex++) {
      const first = pairSource[firstIndex];
      const second = pairSource[secondIndex];
      if (first.event === second.event) continue;
      pairEvaluations.push(evaluateScoreOverrides(
        simulation,
        target,
        finalCapture.score,
        baseScore,
        [first, second],
      ));
    }
  }

  pairEvaluations.sort(scoreOverrideSort);
  if (pairEvaluations.length === 0) {
    console.log("  No distinct override pairs available in the closest single-candidate pool.");
    return;
  }

  console.log(`  closest pairs among top ${pairSource.length} singles:`);
  for (const evaluation of pairEvaluations.slice(0, options.limit)) {
    console.log(`    ${formatScoreOverrideEvaluation(evaluation, baseScoreDiff)}`);
  }

  const perGroupLimit = Math.max(6, Math.min(12, options.limit * 2));
  const exactGroups = buildDirectCountExactOverrideGroups(
    simulation,
    target,
    startOrdinal,
    perGroupLimit,
  );

  if (exactGroups.length === 0) {
    console.log("  Direct count-exact search: skipped because current counts already match target.");
    return;
  }

  console.log(
    `  direct count-exact search using top ${perGroupLimit} candidates per surplus/deficit group:`,
  );
  for (const group of exactGroups) {
    const explicitCount = group.candidates.filter((candidate) => candidate.event.possibleJudgments?.includes(group.to)).length;
    console.log(
      `    ${formatJudgment(group.from)} -> ${formatJudgment(group.to)} `
      + `need ${group.needed}, candidates ${group.candidates.length} (${explicitCount} explicit)`,
    );
  }

  if (exactGroups.some((group) => group.candidates.length < group.needed)) {
    console.log("    unresolved: at least one group does not have enough candidates in the selected range.");
    return;
  }

  const exactSets = buildDirectCountExactOverrideSets(exactGroups);
  if (exactSets.length === 0) {
    console.log("    unresolved: no direct count-exact candidate sets generated.");
    return;
  }

  const exactEvaluations = exactSets
    .map((set) => evaluateScoreOverrides(
      simulation,
      target,
      finalCapture.score ?? 0,
      baseScore,
      set,
    ))
    .sort(scoreOverrideSort);

  console.log(`    evaluated ${exactEvaluations.length} direct count-exact set(s); closest by final score:`);
  for (const evaluation of exactEvaluations.slice(0, options.limit)) {
    console.log(`    ${formatScoreOverrideEvaluation(evaluation, baseScoreDiff)}`);
  }
}

function stableThresholdWindow(value: number, useFloorWindows: boolean): number {
  return useFloorWindows ? Math.floor(value) : value;
}

function classifyStableLongNoteWithThresholdProfile(
  event: SimJudgementEvent,
  simulation: SimulationResult,
  profile: StableThresholdProfile,
): Judgment {
  const note = simulation.notes[event.noteIndex];
  const state = simulation.noteStates[event.noteIndex];
  if (!state || !note.isHold || note.endTime <= note.time || event.judgment == null) {
    return event.judgment ?? 6;
  }

  if (event.judgment === 6) return 6;

  const headErr = Math.abs(Math.round(state.scoringHeadOffsetMs ?? state.headOffsetMs));
  const tailOffset = Math.round(state.scoringTailOffsetMs ?? state.tailOffsetMs);
  const tailErr = Math.abs(tailOffset);
  const combinedErr = headErr + tailErr;
  const perfect = stableThresholdWindow(simulation.windows.perfect, profile.useFloorWindows);
  const great = stableThresholdWindow(simulation.windows.great, profile.useFloorWindows);
  const good = stableThresholdWindow(simulation.windows.good, profile.useFloorWindows);
  const ok = stableThresholdWindow(simulation.windows.ok, profile.useFloorWindows);
  const meh = Math.floor(simulation.windows.meh);

  if (tailOffset < -meh) return 6;

  let result: Judgment;
  if (headErr <= perfect * profile.maxHead && combinedErr <= perfect * profile.maxCombined) {
    result = 1;
  } else if (headErr <= great * profile.threeHundredHead && combinedErr <= great * profile.threeHundredCombined) {
    result = 2;
  } else if (headErr <= good * profile.goodHead && combinedErr <= good * profile.goodCombined) {
    result = 3;
  } else if (headErr <= ok * profile.okHead && combinedErr <= ok * profile.okCombined) {
    result = 4;
  } else {
    result = 5;
  }

  const hasBodyBreakCap = (state.bodyBreakTimes?.length ?? 0) > 0 && result < 3;
  return hasBodyBreakCap ? 3 : result;
}

function thresholdProfileCounts(
  simulation: SimulationResult,
  profile: StableThresholdProfile,
): ReplayHitCounts {
  const counts = emptyReplayHitCounts();

  for (const event of simulation.events) {
    const judgment = event.part === "hold-combined"
      ? classifyStableLongNoteWithThresholdProfile(event, simulation, profile)
      : event.judgment;
    addJudgment(counts, judgment);
  }

  return counts;
}

function printStableThresholdSweep(
  options: CliOptions,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.stableThresholdSweep) return;

  console.log("\nStable LN threshold sweep:");
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: threshold sweep only models stable osu!mania ScoreV1.");
    return;
  }
  console.log("  profile-only approximation; playback timeout/body-break special cases may differ from current sim");

  const profiles: StableThresholdProfile[] = [
    {
      goodCombined: 2,
      goodHead: 1,
      label: "current-floor 1.2/2.4 1.1/2.2",
      maxCombined: 2.4,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2.2,
      threeHundredHead: 1.1,
      useFloorWindows: true,
    },
    {
      goodCombined: 2,
      goodHead: 1,
      label: "current-raw 1.2/2.4 1.1/2.2",
      maxCombined: 2.4,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2.2,
      threeHundredHead: 1.1,
      useFloorWindows: false,
    },
    {
      goodCombined: 2,
      goodHead: 1,
      label: "raw great2.0 only",
      maxCombined: 2.4,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2,
      threeHundredHead: 1.1,
      useFloorWindows: false,
    },
    {
      goodCombined: 2,
      goodHead: 1,
      label: "floor great2.0 only",
      maxCombined: 2.4,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2,
      threeHundredHead: 1.1,
      useFloorWindows: true,
    },
    {
      goodCombined: 2,
      goodHead: 1,
      label: "raw max2.2 great2.0",
      maxCombined: 2.2,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2,
      threeHundredHead: 1.1,
      useFloorWindows: false,
    },
    {
      goodCombined: 2,
      goodHead: 1,
      label: "floor max2.2 great2.0",
      maxCombined: 2.2,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2,
      threeHundredHead: 1.1,
      useFloorWindows: true,
    },
    {
      goodCombined: 2,
      goodHead: 1,
      label: "raw max2.0 great2.0",
      maxCombined: 2,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2,
      threeHundredHead: 1.1,
      useFloorWindows: false,
    },
    {
      goodCombined: 2,
      goodHead: 1,
      label: "floor max2.0 great2.0",
      maxCombined: 2,
      maxHead: 1.2,
      okCombined: 2,
      okHead: 1,
      threeHundredCombined: 2,
      threeHundredHead: 1.1,
      useFloorWindows: true,
    },
  ];

  for (const profile of profiles) {
    const counts = thresholdProfileCounts(simulation, profile);
    const diff = diffReplayHitCounts(counts, target.counts);
    console.log(
      `  ${profile.label.padEnd(34)} ${formatCounts(counts)} `
      + `diff ${formatDiff(diff)} visible ${formatVisibleDiff(diff)}`,
    );
  }
}

interface StableThresholdGridEvaluation {
  counts: ReplayHitCounts;
  diff: ReplayHitCounts;
  distance: number;
  label: string;
  visibleDiff: ReplayHitCounts;
  visibleDistance: number;
}

function formatThresholdValue(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function buildStableThresholdGridProfiles(): StableThresholdProfile[] {
  const profiles = new Map<string, StableThresholdProfile>();
  const addProfile = (profile: StableThresholdProfile) => {
    if (!profiles.has(profile.label)) profiles.set(profile.label, profile);
  };

  for (const useFloorWindows of [true, false]) {
    for (const maxHead of [1, 1.1, 1.2, 1.3]) {
      for (const maxCombined of [2, 2.2, 2.4, 2.6]) {
        for (const threeHundredHead of [1, 1.05, 1.1, 1.15, 1.2]) {
          for (const threeHundredCombined of [2, 2.1, 2.2, 2.3, 2.4]) {
            addProfile({
              goodCombined: 2,
              goodHead: 1,
              label: `${useFloorWindows ? "floor" : "raw"} `
                + `max${formatThresholdValue(maxHead)}/${formatThresholdValue(maxCombined)} `
                + `300${formatThresholdValue(threeHundredHead)}/${formatThresholdValue(threeHundredCombined)}`,
              maxCombined,
              maxHead,
              okCombined: 2,
              okHead: 1,
              threeHundredCombined,
              threeHundredHead,
              useFloorWindows,
            });
          }
        }
      }
    }
  }

  return [...profiles.values()];
}

function printStableThresholdGrid(
  options: CliOptions,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.stableThresholdGrid) return;

  console.log("\nStable LN threshold grid:");
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: threshold grid only models stable osu!mania ScoreV1.");
    return;
  }
  console.log("  profile-only approximation over MAX and 300 head/combined multipliers");

  const evaluations: StableThresholdGridEvaluation[] = buildStableThresholdGridProfiles()
    .map((profile) => {
      const counts = thresholdProfileCounts(simulation, profile);
      const diff = diffReplayHitCounts(counts, target.counts);
      return {
        counts,
        diff,
        distance: countDiffDistance(diff),
        label: profile.label,
        visibleDiff: diff,
        visibleDistance: visibleDiffDistance(diff),
      };
    })
    .sort((a, b) => a.distance - b.distance
      || a.visibleDistance - b.visibleDistance
      || a.label.localeCompare(b.label));

  for (const evaluation of evaluations.slice(0, options.limit)) {
    console.log(
      `  ${evaluation.label.padEnd(31)} ${formatCounts(evaluation.counts)} `
      + `diff ${formatDiff(evaluation.diff)} visible ${formatVisibleDiff(evaluation.visibleDiff)} `
      + `distance ${evaluation.distance}/${evaluation.visibleDistance}`,
    );
  }
}

interface StableTimingVariant {
  label: string;
  options: ManiaReplaySimulationOptions;
}

interface StableTimingVariantEvaluation {
  counts: ReplayHitCounts;
  diff: ReplayHitCounts;
  distance: number;
  label: string;
  visibleDistance: number;
  visibleDiff: ReplayHitCounts;
}

function uniqueStableTimingVariants(simulation: SimulationResult): StableTimingVariant[] {
  const variants = new Map<string, StableTimingVariant>();
  const addVariant = (variant: StableTimingVariant) => {
    if (!variants.has(variant.label)) variants.set(variant.label, variant);
  };

  addVariant({ label: "current defaults", options: {} });
  addVariant({
    label: "reuse tail segment for next head",
    options: { stableReuseTailSegmentForNextHead: true },
  });
  for (const grace of [4, 8, 12, 16]) {
    addVariant({
      label: `reuse tail segment with ${grace}ms grace`,
      options: {
        stableReuseTailSegmentForNextHead: true,
        stableTailSegmentReuseGrace: grace,
      },
    });
  }
  addVariant({
    label: "body-break cap to 300",
    options: { stableBodyBreakCapJudgment: 2 },
  });
  addVariant({
    label: "body-break cap to MEH",
    options: { stableBodyBreakCapJudgment: 5 },
  });
  addVariant({
    label: "body-break uncapped",
    options: { stableBodyBreakCapJudgment: null },
  });
  addVariant({
    label: "suppress hidden body-break cap",
    options: { stableSuppressHiddenBodyBreakCap: true },
  });
  addVariant({
    label: "preserve LN scoring press after break",
    options: { stablePreserveLongNoteScoringPressAfterBreak: true },
  });
  addVariant({
    label: "preserve LN scoring press after tail break",
    options: { stablePreserveLongNoteScoringPressAfterTailBreak: true },
  });
  addVariant({
    label: "preserve LN scoring press time",
    options: { stablePreserveLongNoteScoringPressTime: true },
  });
  addVariant({
    label: "disable pre-head release miss",
    options: { stablePreHeadReleaseMissesAtHead: false },
  });
  addVariant({
    label: "pre-head release miss consumes recovery",
    options: { stablePreHeadReleaseMissConsumesRecovery: true },
  });
  for (const tailOffset of [-220, -200, -180, -170, -160, -150]) {
    addVariant({
      label: `pre-head recovery tail<=${tailOffset}ms`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: tailOffset,
      },
    });
  }
  for (const [gap, duration] of [[66, 44], [66, 66], [88, 44]]) {
    addVariant({
      label: `pre-head recovery tail<=-200ms exclude close short next gap<=${gap} dur<=${duration}`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryExcludeNextShortMaxDuration: duration,
        stablePreHeadReleaseMissRecoveryExcludeNextShortMaxGap: gap,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -200,
      },
    });
  }
  for (const gap of [45, 50, 66, 88]) {
    addVariant({
      label: `pre-head recovery tail<=-200ms next gap<=${gap}`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryMaxNextNoteGap: gap,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -200,
      },
    });
  }
  for (const headOffset of [100, 120, 140]) {
    addVariant({
      label: `pre-head recovery tail<=-200ms next gap<=66 head<=${headOffset}`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryMaxHeadOffset: headOffset,
        stablePreHeadReleaseMissRecoveryMaxNextNoteGap: 66,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -200,
      },
    });
  }
  for (const nextNextGap of [44, 50, 55, 60, 62, 63, 66, 80, 88, 100]) {
    addVariant({
      label: `pre-head recovery tail<=-200ms next gap<=66 next2 gap>=${nextNextGap}`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryMaxNextNoteGap: 66,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -200,
        stablePreHeadReleaseMissRecoveryMinNextNextNoteGap: nextNextGap,
      },
    });
  }
  addVariant({
    label: "dense-only pre-head release miss consumes recovery median<=6",
    options: { stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6 },
  });
  for (const tailOffset of [-180, -170, -160, -150]) {
    addVariant({
      label: `dense-only pre-head recovery median<=6 tail<=${tailOffset}ms`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: tailOffset,
      },
    });
  }
  for (const headOffset of [80, 100, 110, 120]) {
    addVariant({
      label: `dense-only pre-head recovery median<=6 head<=${headOffset}ms`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryMaxHeadOffset: headOffset,
      },
    });
  }
  addVariant({
    label: "dense-only pre-head recovery median<=6 exclude before tap",
    options: {
      stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
      stablePreHeadReleaseMissRecoveryExcludeBeforeTap: true,
    },
  });
  for (const tailOffset of [-170, -160, -150]) {
    addVariant({
      label: `dense-only pre-head recovery median<=6 tail<=${tailOffset}ms exclude before tap`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryExcludeBeforeTap: true,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: tailOffset,
      },
    });
  }
  for (const [gap, duration] of [[66, 44], [66, 66], [88, 44]]) {
    addVariant({
      label: `dense-only pre-head recovery median<=6 tail<=-150ms exclude close short next gap<=${gap} dur<=${duration}`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryExcludeNextShortMaxDuration: duration,
        stablePreHeadReleaseMissRecoveryExcludeNextShortMaxGap: gap,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -150,
      },
    });
  }
  for (const gap of [45, 50, 66, 88]) {
    addVariant({
      label: `dense-only pre-head recovery median<=6 tail<=-150ms next gap<=${gap}`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryMaxNextNoteGap: gap,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -150,
      },
    });
  }
  addVariant({
    label: "pre-head activation requires recovery",
    options: { stableRequirePreHeadRecoveryForActivation: true },
  });
  addVariant({
    label: "tail early-miss lenience 1.5x",
    options: { stableTailEarlyMissLenience: 1.5 },
  });
  addVariant({
    label: "binary column input ownership",
    options: { stableColumnInputOwnership: true },
  });
  addVariant({
    label: "do not consume held segment at LN timeout",
    options: { stableConsumeHeldSegmentAtLongNoteTimeout: false },
  });
  addVariant({
    label: "held timeout keep OK",
    options: { stableHeldOkTimeoutAsMiss: false },
  });
  addVariant({
    label: "held OK timeout as miss",
    options: { stableHeldOkTimeoutJudgment: 6 },
  });
  addVariant({
    label: "held OK timeout as MEH/50",
    options: { stableHeldOkTimeoutJudgment: 5 },
  });
  addVariant({
    label: "held timeout first sample",
    options: { stableHeldTailTimeoutMode: "first-sample" },
  });
  addVariant({
    label: "held timeout first sample keep OK",
    options: {
      stableHeldOkTimeoutAsMiss: false,
      stableHeldTailTimeoutMode: "first-sample",
    },
  });
  addVariant({
    label: "held timeout segment end",
    options: { stableHeldTailTimeoutMode: "segment-end" },
  });
  addVariant({
    label: "held timeout segment end keep OK",
    options: {
      stableHeldOkTimeoutAsMiss: false,
      stableHeldTailTimeoutMode: "segment-end",
    },
  });

  for (const delay of [-4, -2, -1, 1, 2, 4, 8]) {
    addVariant({
      label: `coarse edge delay ${formatSignedNumber(delay)}ms`,
      options: { stableCoarseEdgePlaybackDelay: delay },
    });
  }
  for (const delay of [-4, -2, 0, 2, 4, 8]) {
    addVariant({
      label: `dense-only coarse median<=6 delay ${delay}ms`,
      options: {
        stableDenseCoarseEdgePlaybackDelay: delay,
        stableDenseForceCoarsePlaybackMaxMedian: 6,
      },
    });
    if (delay === 0) {
      addVariant({
        label: "coarse press estimate only",
        options: { stableCoarsePressPlayback: true },
      });
      addVariant({
        label: "precise release estimate",
        options: { stableCoarseReleasePlayback: false },
      });
      addVariant({
        label: "coarse press+release estimates only",
        options: {
          stableCoarsePressPlayback: true,
          stableCoarseReleasePlayback: true,
        },
      });
      addVariant({
        label: "enable LN head refinement",
        options: { stableEnableLongNoteHeadRefinement: true },
      });
      addVariant({
        label: "dense-only coarse median<=6 delay 0ms keep LN head refinement",
        options: {
          stableAllowCoarseLongNoteHeadRefinement: true,
          stableDenseCoarseEdgePlaybackDelay: 0,
          stableDenseForceCoarsePlaybackMaxMedian: 6,
        },
      });
      addVariant({
        label: "dense-only coarse median<=6 delay 0ms precise press",
        options: {
          stableCoarsePressPlayback: false,
          stableDenseCoarseEdgePlaybackDelay: 0,
          stableDenseForceCoarsePlaybackMaxMedian: 6,
        },
      });
      addVariant({
        label: "dense-only coarse median<=6 delay 0ms precise release",
        options: {
          stableCoarseReleasePlayback: false,
          stableDenseCoarseEdgePlaybackDelay: 0,
          stableDenseForceCoarsePlaybackMaxMedian: 6,
        },
      });
    }
  }

  for (const grace of [0, 4, 6, 10, 12, 16]) {
    addVariant({
      label: `tail edge grace ${grace}ms`,
      options: { stableTailEdgeGrace: grace },
    });
  }

  for (const grace of [0, 4, 6, 8, 12, 14, 16, 20]) {
    addVariant({
      label: `next-note edge grace ${grace}ms`,
      options: { stableNextNoteEdgeGrace: grace },
    });
  }

  if (simulation.metadata.keyCount > 4) {
    for (const cap of [0, 2, 4, 6, 8, 10, 12]) {
      addVariant({
        label: `high-key release delay cap ${cap}ms`,
        options: { stableHighKeyReleaseDelayCap: cap },
      });
      if (cap > 0) {
        addVariant({
          label: `high-key release delay cap ${cap}ms miss-only`,
          options: {
            stableHighKeyReleaseDelayCap: cap,
            stableHighKeyReleaseDelayMissOnly: true,
          },
        });
        addVariant({
          label: `high-key release delay cap ${cap}ms miss-only raw>=4 head<=good`,
          options: {
            stableHighKeyReleaseDelayCap: cap,
            stableHighKeyReleaseDelayMaxHeadOffset: 82,
            stableHighKeyReleaseDelayMissOnly: true,
            stableHighKeyReleaseDelayRawThreshold: 4,
          },
        });
      }
    }
  }

  return [...variants.values()];
}

function simulateStableTimingVariantCounts(
  simulation: SimulationResult,
  variant: StableTimingVariant,
): ReplayHitCounts {
  return countReplayJudgements(simulateStableTimingVariant(simulation, variant).events);
}

function simulateStableTimingVariant(
  simulation: SimulationResult,
  variant: StableTimingVariant,
): Pick<SimulationResult, "allEvents" | "cumulativeByOrdinal" | "events" | "noteStates" | "simulatedCounts"> {
  const ruleset = getManiaReplayRuleset(
    simulation.accuracyMode === "lazer",
    simulation.mods,
    false,
  );
  const simulated = simulateManiaReplayJudgements(
    simulation.notes,
    simulation.segments,
    simulation.metadata.keyCount,
    simulation.windows,
    simulation.accuracyMode,
    {
      legacyReplayFrameRounding: true,
      speedMultiplier: ruleset.speedMultiplier,
      ...variant.options,
    },
  );
  const allEvents = [...simulated.events]
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const events = allEvents
    .filter((event) => event.judgment != null)
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const cumulativeByOrdinal: ReplayHitCounts[] = [];
  const cumulative = emptyReplayHitCounts();

  for (const event of events) {
    addJudgment(cumulative, event.judgment);
    cumulativeByOrdinal.push(cloneCounts(cumulative));
  }

  return {
    allEvents,
    cumulativeByOrdinal,
    events,
    noteStates: simulated.noteStates,
    simulatedCounts: cumulativeByOrdinal[cumulativeByOrdinal.length - 1] ?? emptyReplayHitCounts(),
  };
}

function printStableTimingSweep(
  options: CliOptions,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.stableTimingSweep) return;

  console.log("\nStable replay timing sweep:");
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: timing sweep only models stable osu!mania replay playback.");
    return;
  }

  const evaluations: StableTimingVariantEvaluation[] = uniqueStableTimingVariants(simulation)
    .map((variant) => {
      const counts = simulateStableTimingVariantCounts(simulation, variant);
      const diff = diffReplayHitCounts(counts, target.counts);
      return {
        counts,
        diff,
        distance: countDiffDistance(diff),
        label: variant.label,
        visibleDiff: diff,
        visibleDistance: visibleDiffDistance(diff),
      };
    })
    .sort((a, b) => a.distance - b.distance
      || a.visibleDistance - b.visibleDistance
      || a.label.localeCompare(b.label));

  for (const evaluation of evaluations.slice(0, options.limit)) {
    console.log(
      `  ${evaluation.label.padEnd(34)} ${formatCounts(evaluation.counts)} `
      + `diff ${formatDiff(evaluation.diff)} visible ${formatVisibleDiff(evaluation.visibleDiff)} `
      + `distance ${evaluation.distance}/${evaluation.visibleDistance}`,
    );
  }
}

function eventIdentity(event: SimJudgementEvent): string {
  return `${event.noteIndex}:${event.part}`;
}

function eventsDiffer(a: SimJudgementEvent | undefined, b: SimJudgementEvent | undefined): boolean {
  if (!a || !b) return a !== b;
  return a.judgment !== b.judgment
    || Math.abs(a.time - b.time) > 0.001
    || Math.abs(a.offsetMs - b.offsetMs) > 0.001;
}

function formatSimEventObject(simulation: SimulationResult, event: SimJudgementEvent | undefined): string {
  if (!event) return "    <missing>";

  const note = simulation.notes[event.noteIndex];
  const state = simulation.noteStates[event.noteIndex];
  const segments = simulation.segments[event.column]
    ?.filter((segment) => segment.end > note.time - 260 && segment.start < note.endTime + 260)
    .map((segment) => `${Math.round(segment.startPrevious ?? segment.start)}>${Math.round(segment.start)}-${Math.round(segment.endPrevious ?? segment.end)}>${Math.round(segment.end)}`)
    .join(" ");
  const bodyBreaks = state?.bodyBreakTimes?.map((time) => Math.round(time)).join("|") ?? "";
  const scoringOffsets = state?.scoringHeadOffsetMs == null
    ? ""
    : ` scoreHead=${formatMs(state.scoringHeadOffsetMs)} scoreTail=${formatMs(state.scoringTailOffsetMs ?? 0)}`;

  return (
    `    t=${formatMs(event.time).padStart(9)} `
    + `j=${formatJudgment(event.judgment)} ${event.part.padEnd(13)} c${event.column} n${event.noteIndex} `
    + `${formatMs(note.time)}-${formatMs(note.endTime)} off=${formatMs(event.offsetMs)} `
    + `head=${formatMs(state?.headOffsetMs ?? 0)} tail=${formatMs(state?.tailOffsetMs ?? 0)}${scoringOffsets} `
    + `bb=${bodyBreaks} poss=${event.possibleJudgments?.join("") ?? ""}`
    + `${formatStableStateFlags(state)}${formatStableEventDetails(simulation, event)} segs=${segments ?? ""}`
  );
}

function printStableTimingDeltaVariant(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.stableTimingDeltaVariant) return;

  console.log(`\nStable timing variant delta: ${options.stableTimingDeltaVariant}`);
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: timing variant deltas only model stable osu!mania replay playback.");
    return;
  }

  const variant = uniqueStableTimingVariants(simulation)
    .find((candidate) => candidate.label === options.stableTimingDeltaVariant);
  if (!variant) {
    console.log("  unknown variant. Available variants:");
    for (const candidate of uniqueStableTimingVariants(simulation)) {
      console.log(`    ${candidate.label}`);
    }
    return;
  }

  const variantResult = simulateStableTimingVariant(simulation, variant);
  const variantSimulation: SimulationResult = {
    ...simulation,
    ...variantResult,
  };
  const currentDiff = diffReplayHitCounts(simulation.simulatedCounts, target.counts);
  const variantDiff = diffReplayHitCounts(variantResult.simulatedCounts, target.counts);
  console.log(
    `  current ${formatCounts(simulation.simulatedCounts)} diff ${formatDiff(currentDiff)} `
    + `distance ${countDiffDistance(currentDiff)}/${visibleDiffDistance(currentDiff)}`,
  );
  console.log(
    `  variant ${formatCounts(variantResult.simulatedCounts)} diff ${formatDiff(variantDiff)} `
    + `distance ${countDiffDistance(variantDiff)}/${visibleDiffDistance(variantDiff)}`,
  );

  const variantComparison = buildComparison(capture, variantSimulation, target, options.limit);
  const firstOrdinal = variantComparison.ordinalDivergences[0];
  if (firstOrdinal) {
    console.log(
      `  variant first ordinal divergence total ${firstOrdinal.sample.total} `
      + `at ${Math.round(firstOrdinal.sample.time)}ms diff ${formatDiff(firstOrdinal.diff)}`,
    );
  } else {
    console.log("  variant no ordinal divergence found");
  }
  const firstTime = variantComparison.timeDivergences[0];
  if (firstTime) {
    console.log(
      `  variant first time divergence at ${Math.round(firstTime.sample.time)}ms `
      + `(total ${firstTime.sample.total}) diff ${formatDiff(firstTime.diff)}`,
    );
  } else {
    console.log("  variant no time divergence found");
  }
  console.log("  variant checkpoints:");
  for (const checkpoint of variantComparison.checkpoints) {
    console.log(
      `    >=${String(checkpoint.target).padStart(4)} @ ${String(Math.round(checkpoint.sample.time)).padStart(6)}ms `
      + `diff ${formatDiff(checkpoint.diff)}`,
    );
  }

  const currentByKey = new Map(simulation.events.map((event) => [eventIdentity(event), event]));
  const variantByKey = new Map(variantResult.events.map((event) => [eventIdentity(event), event]));
  const keys = new Set([...currentByKey.keys(), ...variantByKey.keys()]);
  const changed = [...keys]
    .filter((key) => eventsDiffer(currentByKey.get(key), variantByKey.get(key)))
    .map((key) => ({
      current: currentByKey.get(key),
      key,
      variant: variantByKey.get(key),
    }))
    .sort((a, b) => (a.current?.time ?? a.variant?.time ?? 0) - (b.current?.time ?? b.variant?.time ?? 0));
  const judgmentChanged = changed.filter((row) => row.current?.judgment !== row.variant?.judgment);
  const timeOnlyChanged = changed.length - judgmentChanged.length;

  console.log(`  changed judged events ${changed.length} (${judgmentChanged.length} judgment, ${timeOnlyChanged} time/offset only)`);
  const consumedRecoveryNotes = variantResult.noteStates
    .map((state, noteIndex) => ({ noteIndex, state }))
    .filter((row) => row.state?.stablePreHeadReleaseMissConsumedRecovery);
  if (consumedRecoveryNotes.length > 0) {
    console.log(`  variant consumed pre-head recovery notes ${consumedRecoveryNotes.length}:`);
    for (const row of consumedRecoveryNotes.slice(0, options.limit)) {
      const note = simulation.notes[row.noteIndex];
      const nextSameColumnIndex = simulation.notes.findIndex((candidate, index) => (
        index > row.noteIndex && candidate.column === note.column
      ));
      const nextSameColumn = nextSameColumnIndex >= 0 ? simulation.notes[nextSameColumnIndex] : null;
      const nextNextSameColumnIndex = nextSameColumnIndex >= 0
        ? simulation.notes.findIndex((candidate, index) => (
            index > nextSameColumnIndex && candidate.column === note.column
          ))
        : -1;
      const nextNextSameColumn = nextNextSameColumnIndex >= 0 ? simulation.notes[nextNextSameColumnIndex] : null;
      const state = row.state;
      const nextLabel = nextSameColumn
        ? `n${nextSameColumnIndex}:${formatMs(nextSameColumn.time - note.endTime)}ms:${formatMs(nextSameColumn.endTime - nextSameColumn.time)}ms:${nextSameColumn.isHold ? "hold" : "tap"}`
        : "none";
      const nextNextLabel = nextSameColumn && nextNextSameColumn
        ? `n${nextNextSameColumnIndex}:${formatMs(nextNextSameColumn.time - nextSameColumn.endTime)}ms:${formatMs(nextNextSameColumn.endTime - nextNextSameColumn.time)}ms:${nextNextSameColumn.isHold ? "hold" : "tap"}`
        : "none";
      console.log(
        `    n${row.noteIndex} c${note.column} ${formatMs(note.time)}-${formatMs(note.endTime)} `
        + `j=${formatJudgment(state.tailJudgment)} head=${formatMs(state.scoringHeadOffsetMs ?? state.headOffsetMs)} `
        + `tail=${formatMs(state.scoringTailOffsetMs ?? state.tailOffsetMs)} `
        + `next=${nextLabel} next2=${nextNextLabel} `
        + `cursor=${state.stableSegmentCursorBefore ?? "?"}->${state.stableSegmentCursorAfter ?? "?"} `
        + `matched=${state.stableMatchedSegmentIndex ?? "?"} scanned=${state.stableLastScannedSegmentIndex ?? "?"}`,
      );
    }
    if (consumedRecoveryNotes.length > options.limit) {
      console.log(`    ... ${consumedRecoveryNotes.length - options.limit} more consumed recovery note(s) omitted`);
    }
  }
  if (consumedRecoveryNotes.length > 0 && judgmentChanged.length > 0) {
    console.log("  variant ownership cascades:");
    for (const row of consumedRecoveryNotes.slice(0, options.limit)) {
      const note = simulation.notes[row.noteIndex];
      const state = row.state;
      const nextTrigger = consumedRecoveryNotes.find((candidate) => {
        if (candidate.noteIndex <= row.noteIndex) return false;
        return simulation.notes[candidate.noteIndex]?.column === note.column;
      });
      const downstream = judgmentChanged.filter((change) => {
        const event = change.variant ?? change.current;
        if (!event) return false;
        const changedNote = simulation.notes[event.noteIndex];
        if (changedNote.column !== note.column) return false;
        if (event.noteIndex <= row.noteIndex) return false;
        if (nextTrigger && event.noteIndex >= nextTrigger.noteIndex) return false;
        return changedNote.time - note.time <= 2500;
      });
      if (downstream.length === 0) {
        console.log(
          `    n${row.noteIndex} c${note.column} downstream=0 `
          + `cursor=${state?.stableSegmentCursorBefore ?? "?"}->${state?.stableSegmentCursorAfter ?? "?"}`,
        );
        continue;
      }

      const currentCounts = emptyReplayHitCounts();
      const variantCounts = emptyReplayHitCounts();
      for (const change of downstream) {
        addJudgment(currentCounts, change.current?.judgment ?? null);
        addJudgment(variantCounts, change.variant?.judgment ?? null);
      }
      const delta = subtractCounts(variantCounts, currentCounts);
      console.log(
        `    n${row.noteIndex} c${note.column} downstream=${downstream.length} `
        + `delta ${formatDiff(delta)} `
        + `cursor=${state?.stableSegmentCursorBefore ?? "?"}->${state?.stableSegmentCursorAfter ?? "?"}`,
      );

      for (const change of downstream.slice(0, Math.min(options.context, 8))) {
        const event = change.variant ?? change.current;
        if (!event) continue;
        const changedNote = simulation.notes[event.noteIndex];
        const currentState = change.current ? simulation.noteStates[change.current.noteIndex] : undefined;
        const variantState = change.variant ? variantSimulation.noteStates[change.variant.noteIndex] : undefined;
        console.log(
          `      n${event.noteIndex} ${formatMs(changedNote.time)}-${formatMs(changedNote.endTime)} `
          + `${change.current?.part ?? change.variant?.part ?? ""} `
          + `${formatJudgment(change.current?.judgment ?? null)}->${formatJudgment(change.variant?.judgment ?? null)} `
          + `cur=${currentState?.stableSegmentCursorBefore ?? "?"}->${currentState?.stableSegmentCursorAfter ?? "?"} `
          + `var=${variantState?.stableSegmentCursorBefore ?? "?"}->${variantState?.stableSegmentCursorAfter ?? "?"}`,
        );
      }
      if (downstream.length > Math.min(options.context, 8)) {
        console.log(`      ... ${downstream.length - Math.min(options.context, 8)} more cascade change(s) omitted`);
      }
    }
    if (consumedRecoveryNotes.length > options.limit) {
      console.log(`    ... ${consumedRecoveryNotes.length - options.limit} more cascade root(s) omitted`);
    }
  }
  const shownRows = judgmentChanged.length > 0 ? judgmentChanged : changed;
  for (const row of shownRows.slice(0, options.limit)) {
    const noteIndex = row.current?.noteIndex ?? row.variant?.noteIndex;
    const part = row.current?.part ?? row.variant?.part;
    console.log(`  ${row.key} n${noteIndex ?? "?"} ${part ?? ""}`);
    console.log(`    current ${formatSimEventObject(simulation, row.current)}`);
    console.log(`    variant ${formatSimEventObject(variantSimulation, row.variant)}`);
  }

  if (shownRows.length > options.limit) {
    console.log(`  ... ${shownRows.length - options.limit} more changed event(s) omitted`);
  }
}

interface StableFrameVariant {
  frames: ReplayFrame[];
  label: string;
}

interface StableFrameVariantEvaluation {
  counts: ReplayHitCounts;
  diff: ReplayHitCounts;
  distance: number;
  label: string;
  visibleDistance: number;
  visibleDiff: ReplayHitCounts;
}

function getSameTimeFrameGroups(frames: ReplayFrame[]): ReplayFrame[][] {
  const groups: ReplayFrame[][] = [];
  let current: ReplayFrame[] = [];

  for (const frame of frames) {
    const previous = current[current.length - 1];
    if (previous && frame.time !== previous.time) {
      groups.push(current);
      current = [];
    }
    current.push(frame);
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function formatSameTimeFrameStats(frames: ReplayFrame[]): string {
  const groups = getSameTimeFrameGroups(frames).filter((group) => group.length > 1);
  const frameCount = groups.reduce((sum, group) => sum + group.length, 0);
  const maxSize = groups.reduce((max, group) => Math.max(max, group.length), 0);
  return `${groups.length} group(s), ${frameCount} frame(s), max ${maxSize}`;
}

function buildStableFrameVariants(frames: ReplayFrame[]): StableFrameVariant[] {
  const groups = getSameTimeFrameGroups(frames);
  const variants = new Map<string, StableFrameVariant>();
  const addVariant = (variant: StableFrameVariant) => {
    const signature = variant.frames.map((frame) => `${frame.time}:${frame.keyState}`).join(",");
    if (!variants.has(signature)) variants.set(signature, variant);
  };
  const addQuantizedVariants = (tickMs: number, phases: number[]) => {
    for (const phase of phases) {
      addVariant({
        label: `ceil ${tickMs}ms phase ${phase}`,
        frames: frames.map((frame) => ({
          keyState: frame.keyState,
          time: phase + Math.ceil((frame.time - phase) / tickMs) * tickMs,
        })),
      });
    }
  };

  addVariant({ frames, label: "current decoded order" });
  addVariant({
    label: "same-time first state",
    frames: groups.map((group) => group[0]),
  });
  addVariant({
    label: "same-time last state",
    frames: groups.map((group) => group[group.length - 1]),
  });
  addVariant({
    label: "same-time bitwise OR",
    frames: groups.map((group) => ({
      keyState: group.reduce((state, frame) => state | frame.keyState, 0),
      time: group[0].time,
    })),
  });
  addVariant({
    label: "same-time epsilon chain",
    frames: groups.flatMap((group) => group.map((frame, index) => ({
      keyState: frame.keyState,
      time: frame.time + index * 0.001,
    }))),
  });
  addVariant({
    label: "same-time reverse epsilon",
    frames: groups.flatMap((group) => group.map((frame, index) => ({
      keyState: frame.keyState,
      time: frame.time + (group.length - index - 1) * 0.001,
    }))),
  });
  addQuantizedVariants(4, [0, 1, 2, 3]);
  addQuantizedVariants(8, [0, 2, 4, 6]);
  addQuantizedVariants(16, [0, 4, 8, 12]);

  return [...variants.values()];
}

function simulateStableFrameVariantCounts(
  simulation: SimulationResult,
  frames: ReplayFrame[],
): ReplayHitCounts {
  const ruleset = getManiaReplayRuleset(
    simulation.accuracyMode === "lazer",
    simulation.mods,
    false,
  );
  const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
  const noteDuration = simulation.notes.length > 0
    ? Math.max(...simulation.notes.map((note) => note.endTime))
    : 0;
  const segments = buildReplaySegments(
    frames,
    simulation.metadata.keyCount,
    Math.max(frameDuration, noteDuration + simulation.windows.miss * 1.5),
  );
  const simulated = simulateManiaReplayJudgements(
    simulation.notes,
    segments,
    simulation.metadata.keyCount,
    simulation.windows,
    simulation.accuracyMode,
    {
      legacyReplayFrameRounding: true,
      speedMultiplier: ruleset.speedMultiplier,
    },
  );
  return countReplayJudgements(simulated.events);
}

function printStableFrameSweep(
  options: CliOptions,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.frameSweep) return;

  console.log("\nStable replay frame sweep:");
  if (simulation.accuracyMode !== "stable") {
    console.log("  skipped: frame sweep only models stable osu!mania replay playback.");
    return;
  }

  console.log(`  adjacent same-time decoded frames: ${formatSameTimeFrameStats(simulation.frames)}`);

  const evaluations: StableFrameVariantEvaluation[] = buildStableFrameVariants(simulation.frames)
    .map((variant) => {
      const counts = simulateStableFrameVariantCounts(simulation, variant.frames);
      const diff = diffReplayHitCounts(counts, target.counts);
      return {
        counts,
        diff,
        distance: countDiffDistance(diff),
        label: variant.label,
        visibleDiff: diff,
        visibleDistance: visibleDiffDistance(diff),
      };
    })
    .sort((a, b) => a.distance - b.distance
      || a.visibleDistance - b.visibleDistance
      || a.label.localeCompare(b.label));

  for (const evaluation of evaluations) {
    console.log(
      `  ${evaluation.label.padEnd(28)} ${formatCounts(evaluation.counts)} `
      + `diff ${formatDiff(evaluation.diff)} visible ${formatVisibleDiff(evaluation.visibleDiff)} `
      + `distance ${evaluation.distance}/${evaluation.visibleDistance}`,
    );
  }
}

function formatNullableNumber(value: number | null): string {
  return value == null ? "?" : String(value);
}

function getSimulationBreakSummary(simulation: SimulationResult): {
  bodyBreakNotes: number;
  bodyBreakTimes: number;
  visibleHoldBreaks: number;
} {
  return {
    bodyBreakNotes: simulation.noteStates.filter((state) => (state?.bodyBreakTimes?.length ?? 0) > 0).length,
    bodyBreakTimes: simulation.noteStates.reduce((sum, state) => sum + (state?.bodyBreakTimes?.length ?? 0), 0),
    visibleHoldBreaks: simulation.allEvents.filter((event) => event.part === "hold-break").length,
  };
}

interface CaptureSliderBreakIncrement {
  delta: number;
  previousSample: PlaySnapshot;
  sample: PlaySnapshot;
}

interface SimBodyBreakMarker {
  column: number;
  count: number;
  judgment: Judgment | null;
  noteIndex: number;
  time: number;
}

interface BreakIncrementMatch {
  distanceMs: number;
  increment: CaptureSliderBreakIncrement;
  sampleDeltaMs: number;
}

function buildCaptureSliderBreakIncrements(capture: CaptureSegment): CaptureSliderBreakIncrement[] {
  const increments: CaptureSliderBreakIncrement[] = [];
  let previousSample: PlaySnapshot | null = null;
  let previousValue = 0;

  for (const sample of capture.samples) {
    if (sample.sliderBreaks == null) {
      previousSample = sample;
      continue;
    }

    if (sample.sliderBreaks > previousValue) {
      increments.push({
        delta: sample.sliderBreaks - previousValue,
        previousSample: previousSample ?? sample,
        sample,
      });
    }

    previousValue = sample.sliderBreaks;
    previousSample = sample;
  }

  return increments;
}

function buildSimBodyBreakMarkers(simulation: SimulationResult): SimBodyBreakMarker[] {
  const grouped = new Map<string, SimBodyBreakMarker>();

  simulation.noteStates.forEach((state, noteIndex) => {
    const note = simulation.notes[noteIndex];
    if (!note || !state?.bodyBreakTimes?.length) return;

    const event = simulation.events.find((candidate) => candidate.noteIndex === noteIndex);
    for (const time of state.bodyBreakTimes) {
      const roundedTime = Math.round(time);
      const key = `${noteIndex}:${roundedTime}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
        continue;
      }

      grouped.set(key, {
        column: note.column,
        count: 1,
        judgment: event?.judgment ?? null,
        noteIndex,
        time,
      });
    }
  });

  return [...grouped.values()]
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
}

function findNearestBreakIncrement(
  time: number,
  increments: CaptureSliderBreakIncrement[],
): BreakIncrementMatch | null {
  let best: BreakIncrementMatch | null = null;

  for (const increment of increments) {
    const distanceMs = distanceToInterval(time, increment.previousSample.time, increment.sample.time);
    const sampleDeltaMs = increment.sample.time - time;
    if (
      best == null
      || distanceMs < best.distanceMs
      || (distanceMs === best.distanceMs && Math.abs(sampleDeltaMs) < Math.abs(best.sampleDeltaMs))
    ) {
      best = { distanceMs, increment, sampleDeltaMs };
    }
  }

  return best;
}

function formatBreakIncrement(increment: CaptureSliderBreakIncrement): string {
  return `${Math.round(increment.sample.time)}#${increment.sample.total}+${increment.delta}`;
}

function formatVisibleHoldBreak(simulation: SimulationResult, event: SimulationResult["allEvents"][number]): string {
  const note = simulation.notes[event.noteIndex];
  return `${Math.round(event.time)}n${event.noteIndex}c${note?.column ?? "?"}`;
}

function formatBodyBreakMarker(
  marker: SimBodyBreakMarker,
  increments: CaptureSliderBreakIncrement[],
  matchThresholdMs: number,
): string {
  const nearest = findNearestBreakIncrement(marker.time, increments);
  const duplicate = marker.count > 1 ? `x${marker.count}` : "";
  const base = `${Math.round(marker.time)}n${marker.noteIndex}c${marker.column}j${formatJudgment(marker.judgment)}${duplicate}`;
  if (!nearest) return `${base} -> ?`;

  const matched = nearest.distanceMs <= matchThresholdMs;
  const distance = Math.round(nearest.distanceMs);
  const sampleDelta = Math.round(nearest.sampleDeltaMs);
  return `${base} -> ${matched ? "" : "?"}${formatBreakIncrement(nearest.increment)} d=${distance} sampleDt=${sampleDelta}`;
}

function printFirstLastRows<T>(
  label: string,
  rows: T[],
  limit: number,
  formatter: (row: T) => string,
): void {
  if (rows.length === 0) {
    console.log(`  ${label}: none`);
    return;
  }

  const first = rows.slice(0, limit).map(formatter).join(" ");
  console.log(`  first ${label}: ${first}`);

  if (rows.length > limit) {
    const last = rows.slice(-limit).map(formatter).join(" ");
    console.log(`  last ${label}: ${last}`);
  }
}

function printBreakTimeline(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.breakTimeline) return;

  const increments = buildCaptureSliderBreakIncrements(capture);
  const visibleHoldBreaks = simulation.allEvents
    .filter((event) => event.part === "hold-break")
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const bodyMarkers = buildSimBodyBreakMarkers(simulation);
  const matchThresholdMs = 90;
  const matchedBodyMarkers = bodyMarkers.filter((marker) => {
    const nearest = findNearestBreakIncrement(marker.time, increments);
    return nearest != null && nearest.distanceMs <= matchThresholdMs;
  });
  const deltaSum = increments.reduce((sum, increment) => sum + increment.delta, 0);
  const duplicateBodyBreaks = bodyMarkers.reduce((sum, marker) => sum + marker.count - 1, 0);

  console.log("\nBreak timeline:");
  console.log(
    `  capture sliderBreak increments ${increments.length}, `
    + `deltaSum ${deltaSum}, final ${formatNullableNumber(capture.samples.at(-1)?.sliderBreaks ?? null)}`,
  );
  printFirstLastRows("capture increments", increments, options.limit, formatBreakIncrement);
  console.log(
    `  sim visible hold-breaks ${visibleHoldBreaks.length}, `
    + `body break markers ${bodyMarkers.length}, duplicate marker count ${duplicateBodyBreaks}`,
  );
  printFirstLastRows(
    "visible hold-breaks",
    visibleHoldBreaks,
    options.limit,
    (event) => formatVisibleHoldBreak(simulation, event),
  );
  console.log(
    `  body/capture matches within ${matchThresholdMs}ms: `
    + `${matchedBodyMarkers.length}/${bodyMarkers.length}`,
  );
  printFirstLastRows(
    "body break markers",
    bodyMarkers,
    options.limit,
    (marker) => formatBodyBreakMarker(marker, increments, matchThresholdMs),
  );
}

function formatCounterTailLeaderboard(leaderboard: LeaderboardSnapshot | undefined): string {
  if (!leaderboard) return "";

  const entries = leaderboard.entries.slice(0, 2)
    .map((entry) => {
      const id = entry.id == null ? "" : ` id${entry.id}`;
      return `#${formatNullableNumber(entry.position)}:${formatNullableNumber(entry.score)}`
        + `:${entry.count300}/${entry.count100}/${entry.count50}/${entry.countMiss}${id}`;
    })
    .join(" ");

  return entries ? ` lb=${entries}` : "";
}

function printCounterTail(options: CliOptions, captureData: CaptureData): void {
  if (!options.counterTail) return;

  const selected = captureData.selectedSegment;
  const selectedSamples = captureData.playSamples.filter((sample) => {
    return sample.sequence >= selected.startSequence
      && sample.time >= selected.startTime
      && sample.time <= selected.endTime;
  });
  const leaderboardBySequence = new Map(captureData.leaderboardSnapshots.map((leaderboard) => [leaderboard.sequence, leaderboard]));
  const tailStart = Math.max(0, selectedSamples.length - options.limit);
  const tail = selectedSamples.slice(tailStart);

  console.log("\nCounter tail:");
  console.log(`  selected raw play samples ${selectedSamples.length}, showing last ${tail.length}`);

  let previous: PlaySnapshot | null = tailStart > 0 ? selectedSamples[tailStart - 1] : null;
  for (const sample of tail) {
    const diff = previous ? diffReplayHitCounts(sample.counts, previous.counts) : sample.counts;
    const leaderboard = leaderboardBySequence.get(sample.sequence);
    console.log(
      `  seq ${sample.sequence} t=${Math.round(sample.time)} `
      + `score ${formatNullableNumber(sample.score)} `
      + `combo ${formatNullableNumber(sample.combo)}/${formatNullableNumber(sample.maxCombo)} `
      + `total ${sample.total} hits ${formatCounts(sample.counts)} `
      + `delta ${formatDiff(diff)} sb ${formatNullableNumber(sample.sliderBreaks)}`
      + formatCounterTailLeaderboard(leaderboard),
    );
    previous = sample;
  }
}

function resultScreenTags(resultScreen: ResultScreenSnapshot, selected: CaptureSegment, simulation: SimulationResult): string {
  const selectedFinal = selected.samples[selected.samples.length - 1];
  const tags: string[] = [];

  if (countsEqual(resultScreen.counts, selectedFinal.counts)) tags.push("matches selected play");
  if (countsEqual(resultScreen.counts, simulation.expectedCounts)) tags.push("matches header");
  if (!countsEqual(simulation.replayCounts, simulation.expectedCounts) && countsEqual(resultScreen.counts, simulation.replayCounts)) {
    tags.push("matches replay");
  }
  if (countsEqual(resultScreen.counts, simulation.simulatedCounts)) tags.push("matches sim");

  return tags.length > 0 ? ` (${tags.join(", ")})` : "";
}

function leaderboardEntryMatchesCounts(entry: LeaderboardEntry, counts: ReplayHitCounts): boolean {
  // Stable's leaderboard view omits the mania Geki/Katu buckets, but the
  // remaining buckets are enough to identify nearby rows in these captures.
  return entry.count300 === counts.count300
    && entry.count100 === counts.count100
    && entry.count50 === counts.count50
    && entry.countMiss === counts.countMiss;
}

function leaderboardEntryRef(entry: LeaderboardEntry): string {
  const id = entry.id == null ? "" : ` id ${entry.id}`;
  return `#${formatNullableNumber(entry.position)} score ${formatNullableNumber(entry.score)}${id}`;
}

function leaderboardEntryTags(entry: LeaderboardEntry, selected: CaptureSegment, simulation: SimulationResult): string {
  const selectedFinal = selected.samples[selected.samples.length - 1];
  const tags: string[] = [];

  if (leaderboardEntryMatchesCounts(entry, selectedFinal.counts)) tags.push("matches selected play");
  if (leaderboardEntryMatchesCounts(entry, simulation.expectedCounts)) tags.push("matches header");
  if (
    !countsEqual(simulation.replayCounts, simulation.expectedCounts)
    && leaderboardEntryMatchesCounts(entry, simulation.replayCounts)
  ) {
    tags.push("matches replay");
  }
  if (leaderboardEntryMatchesCounts(entry, simulation.simulatedCounts)) tags.push("matches sim");

  return tags.length > 0 ? ` (${tags.join(", ")})` : "";
}

function getApiScoreForSourceFit(simulation: SimulationResult): number | null {
  const score = simulation.score as Record<string, unknown> | null;
  if (!score) return null;

  return asNumber(score.legacy_total_score)
    ?? asNumber(score.classic_total_score)
    ?? asNumber(score.total_score);
}

function getStableFinalScoreFloor(simulation: SimulationResult): number | null {
  if (simulation.accuracyMode !== "stable") return null;

  return buildStableManiaScoreTrace(
    simulation,
    true,
    false,
    "event-time",
  ).byOrdinal.at(-1)?.scoreFloor ?? null;
}

function formatSourceScoreDiff(simScore: number | null, sourceScore: number | null): string {
  if (simScore == null || sourceScore == null) return "scoreDiffApprox ?";
  return `scoreDiffApprox ${formatSignedNumber(simScore - sourceScore)}`;
}

function formatAccuracyDiff(simulation: SimulationResult, counts: ReplayHitCounts): string {
  const simAccuracy = accuracyFor(simulation.simulatedCounts, simulation.accuracyMode);
  const sourceAccuracy = accuracyFor(counts, simulation.accuracyMode);
  const diff = simAccuracy - sourceAccuracy;
  const formatted = diff > 0 ? `+${diff.toFixed(6)}` : diff.toFixed(6);
  return `accDiff ${formatted}`;
}

function sourceFitLabel(label: string): string {
  return label.length >= 31 ? `${label.slice(0, 28)}...` : label.padEnd(31);
}

function printFullCountSourceFit(
  simulation: SimulationResult,
  simScore: number | null,
  label: string,
  counts: ReplayHitCounts,
  sourceScore: number | null,
): void {
  const diff = diffReplayHitCounts(simulation.simulatedCounts, counts);
  console.log(
    `  ${sourceFitLabel(label)} counts ${formatCounts(counts)} `
    + `diff ${formatDiff(diff)} visible ${formatVisibleDiff(diff)} `
    + `distance ${countDiffDistance(diff)}/${visibleDiffDistance(diff)} `
    + `${formatAccuracyDiff(simulation, counts)} `
    + `${formatSourceScoreDiff(simScore, sourceScore)}`,
  );
}

function printLeaderboardSourceFit(
  simulation: SimulationResult,
  simScore: number | null,
  entry: LeaderboardEntry,
  selected: CaptureSegment,
): void {
  const visibleDiff = {
    countGeki: 0,
    count300: simulation.simulatedCounts.count300 - entry.count300,
    countKatu: 0,
    count100: simulation.simulatedCounts.count100 - entry.count100,
    count50: simulation.simulatedCounts.count50 - entry.count50,
    countMiss: simulation.simulatedCounts.countMiss - entry.countMiss,
  };

  console.log(
    `  ${sourceFitLabel(leaderboardEntryRef(entry))} `
    + `hits ${entry.count300}/${entry.count100}/${entry.count50}/${entry.countMiss} `
    + `visible ${formatVisibleDiff(visibleDiff)} `
    + `distance ${visibleDiffDistance(visibleDiff)} `
    + `${formatSourceScoreDiff(simScore, entry.score)}`
    + leaderboardEntryTags(entry, selected, simulation),
  );
}

function printSourceFit(options: CliOptions, capture: CaptureData, simulation: SimulationResult): void {
  if (!options.sourceFit) return;

  const selectedIndex = capture.segments.indexOf(capture.selectedSegment);
  const selectedFinal = capture.selectedSegment.samples[capture.selectedSegment.samples.length - 1];
  const simScore = getStableFinalScoreFloor(simulation);
  const apiScore = getApiScoreForSourceFit(simulation);

  console.log("\nSource fit against simulated final:");
  console.log(`  sim counts ${formatCounts(simulation.simulatedCounts)} scoreApprox ${formatNullableNumber(simScore)}`);
  printFullCountSourceFit(simulation, simScore, `selected play #${selectedIndex + 1}`, selectedFinal.counts, selectedFinal.score);
  printFullCountSourceFit(simulation, simScore, "score/API header", simulation.expectedCounts, apiScore);
  if (!countsEqual(simulation.replayCounts, simulation.expectedCounts)) {
    printFullCountSourceFit(simulation, simScore, "decoded .osr header", simulation.replayCounts, null);
  }

  for (const resultScreen of capture.resultScreens.slice(0, options.limit)) {
    printFullCountSourceFit(
      simulation,
      simScore,
      `result seq ${resultScreen.sequence}`,
      resultScreen.counts,
      resultScreen.score,
    );
  }
  if (capture.resultScreens.length > options.limit) {
    console.log(`  ... ${capture.resultScreens.length - options.limit} more result-screen record(s) omitted`);
  }

  if (capture.finalLeaderboard) {
    console.log("  leaderboard visible rows:");
    for (const entry of capture.finalLeaderboard.entries.slice(0, options.limit)) {
      printLeaderboardSourceFit(simulation, simScore, entry, capture.selectedSegment);
    }
    if (capture.finalLeaderboard.entries.length > options.limit) {
      console.log(`  ... ${capture.finalLeaderboard.entries.length - options.limit} more leaderboard row(s) omitted`);
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatNullableMs(value: number | null): string {
  return value == null ? "?" : `${Math.round(value)}ms`;
}

function formatHitErrorComponent(
  simulation: SimulationResult,
  index: number,
  component: IndexedSimHitErrorEvent | undefined,
): string {
  if (!component) return `sim#${index} <missing>`;
  const note = simulation.notes[component.noteIndex];
  return (
    `sim#${index} t=${Math.round(component.time)} ${component.part} `
    + `j=${formatJudgment(component.result)} off=${component.offset} `
    + `c${note.column} n${component.noteIndex} ${Math.round(note.time)}-${Math.round(note.endTime)}`
  );
}

function formatUnmatchedComponentParts(components: IndexedSimHitErrorEvent[]): string {
  if (components.length === 0) return "none";

  const counts = new Map<SimHitErrorEvent["part"], number>();
  for (const component of components) {
    counts.set(component.part, (counts.get(component.part) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([part, count]) => `${part}:${count}`)
    .join(" ");
}

function printUnmatchedSimHitErrorSummary(
  options: CliOptions,
  simulation: SimulationResult,
  components: IndexedSimHitErrorEvent[],
  matchedComponentIndexes: Set<number>,
): void {
  const unmatchedComponents = components.filter((component) => !matchedComponentIndexes.has(component.componentIndex));
  console.log(
    `  unmatched simulated components ${unmatchedComponents.length}/${components.length} `
    + `parts ${formatUnmatchedComponentParts(unmatchedComponents)}`,
  );

  if (unmatchedComponents.length === 0) return;

  const minOrdinal = options.intervalMinTotal ?? 1;
  const maxOrdinal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const hasOrdinalFilter = options.intervalMinTotal != null || options.intervalMaxTotal != null;
  const scopedUnmatchedComponents = hasOrdinalFilter
    ? unmatchedComponents.filter((component) => {
        const ordinal = findScoreOrdinalForComponent(simulation, component);
        return ordinal != null && ordinal >= minOrdinal && ordinal <= maxOrdinal;
      })
    : unmatchedComponents;

  if (hasOrdinalFilter) {
    console.log(
      `  unmatched simulated components in score range ${minOrdinal}-${Number.isFinite(maxOrdinal) ? maxOrdinal : "end"}: `
      + `${scopedUnmatchedComponents.length} parts ${formatUnmatchedComponentParts(scopedUnmatchedComponents)}`,
    );
  }

  if (scopedUnmatchedComponents.length === 0) return;

  console.log("  first fuzzy-unmatched simulated components:");
  for (const component of scopedUnmatchedComponents.slice(0, options.limit)) {
    const ordinal = findScoreOrdinalForComponent(simulation, component);
    const ordinalText = ordinal == null ? "score#-" : `score#${ordinal}`;
    console.log(
      `    e#${component.componentIndex} ${ordinalText} `
      + formatHitErrorComponent(simulation, component.componentIndex, component),
    );
  }

  const grouped = new Map<number | null, IndexedSimHitErrorEvent[]>();
  for (const component of scopedUnmatchedComponents) {
    const ordinal = findScoreOrdinalForComponent(simulation, component);
    grouped.set(ordinal, [...(grouped.get(ordinal) ?? []), component]);
  }

  const rows = [...grouped.entries()]
    .map(([ordinal, group]) => {
      const event = ordinal == null ? null : simulation.events[ordinal - 1];
      const total = event == null ? group.length : getHitErrorComponentsForEvent(components, event).length;
      return { event, group, ordinal, total };
    })
    .sort((a, b) => {
      if (a.ordinal == null && b.ordinal == null) {
        return a.group[0].componentIndex - b.group[0].componentIndex;
      }
      if (a.ordinal == null) return 1;
      if (b.ordinal == null) return -1;
      return a.ordinal - b.ordinal;
    });

  console.log("  score ordinals with unmatched simulated components:");
  for (const row of rows.slice(0, options.limit)) {
    const parts = row.group
      .map((component) => `${component.part}@e#${component.componentIndex}/off=${component.offset}/t=${Math.round(component.time)}`)
      .join(", ");
    if (row.ordinal == null || row.event == null) {
      console.log(`    score#- ${row.group.length}/${row.total} components ${parts}`);
      continue;
    }
    console.log(
      `    score#${row.ordinal} ${row.group.length}/${row.total} unmatched `
      + `j=${formatJudgment(row.event.judgment)} poss=${row.event.possibleJudgments?.join("") ?? ""} `
      + `${parts}`,
    );
  }
}

function printHitErrorFit(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.hitErrorFit) return;

  const finalSample = capture.samples[capture.samples.length - 1];
  const capturedErrors = finalSample?.hitErrors ?? [];
  const components = buildIndexedSimHitErrorEvents(simulation);
  const directCount = Math.min(capturedErrors.length, components.length);
  let directSignedWithinOne = 0;
  let directAbsWithinOne = 0;
  let firstSignedMismatch: number | null = null;
  let firstAbsMismatch: number | null = null;

  for (let index = 0; index < directCount; index++) {
    const captured = Math.round(capturedErrors[index]);
    const simulated = components[index].offset;
    if (Math.abs(captured - simulated) <= 1) {
      directSignedWithinOne++;
    } else if (firstSignedMismatch == null) {
      firstSignedMismatch = index;
    }
    if (sameHitErrorValue(captured, simulated)) {
      directAbsWithinOne++;
    } else if (firstAbsMismatch == null) {
      firstAbsMismatch = index;
    }
  }

  const observations = buildCaptureHitErrorObservations(capture);
  const fuzzyMatches = matchCaptureHitErrorObservations(capture, simulation);
  const matched = fuzzyMatches.filter((match) => match.component != null);
  const unmatched = fuzzyMatches.filter((match) => match.component == null);
  const matchedComponentIndexes = new Set<number>();
  for (const match of matched) {
    if (match.componentIndex != null) matchedComponentIndexes.add(match.componentIndex);
  }
  const indexDeltas = matched
    .map((match) => match.componentIndex == null ? null : match.componentIndex - match.capturedIndex)
    .filter((value): value is number => value != null);
  const timeDistances = matched
    .map((match) => match.component == null
      ? null
      : distanceToInterval(
          match.component.time,
          match.observation.previousSample.time,
          match.observation.sample.time,
        ))
    .filter((value): value is number => value != null);

  console.log("\nHit-error fit:");
  console.log(
    `  captured final errors ${capturedErrors.length}, sim components ${components.length}, `
    + `length diff ${formatSignedNumber(components.length - capturedErrors.length)}`,
  );
  console.log(
    `  direct index signed<=1 ${directSignedWithinOne}/${directCount}, `
    + `abs<=1 ${directAbsWithinOne}/${directCount}`,
  );
  console.log(
    `  fuzzy value/time matches ${matched.length}/${observations.length}, `
    + `unmatched ${unmatched.length}`,
  );
  console.log(
    `  component-index delta min/median/max `
    + `${indexDeltas.length ? `${Math.min(...indexDeltas)}/${median(indexDeltas)}/${Math.max(...indexDeltas)}` : "?/?/?"}, `
    + `time-distance median/max ${formatNullableMs(median(timeDistances))}/`
    + `${timeDistances.length ? `${Math.round(Math.max(...timeDistances))}ms` : "?"}`,
  );

  const mismatchIndexes = new Set<number>();
  if (firstSignedMismatch != null) mismatchIndexes.add(firstSignedMismatch);
  if (firstAbsMismatch != null) mismatchIndexes.add(firstAbsMismatch);
  for (let index = 0; index < directCount && mismatchIndexes.size < options.limit; index++) {
    const captured = Math.round(capturedErrors[index]);
    const simulated = components[index].offset;
    if (Math.abs(captured - simulated) > 1 || !sameHitErrorValue(captured, simulated)) {
      mismatchIndexes.add(index);
    }
  }

  if (mismatchIndexes.size > 0) {
    console.log("  first direct mismatches:");
    for (const index of [...mismatchIndexes].sort((a, b) => a - b).slice(0, options.limit)) {
      console.log(
        `    err#${index} cap=${Math.round(capturedErrors[index])} `
        + `${formatHitErrorComponent(simulation, index, components[index])}`,
      );
    }
  } else if (directCount > 0) {
    console.log("  no direct mismatches within compared range.");
  }

  if (unmatched.length > 0) {
    console.log("  first fuzzy-unmatched captured errors:");
    for (const match of unmatched.slice(0, options.limit)) {
      console.log(
        `    err#${match.capturedIndex} cap=${Math.round(match.capturedError)} `
        + `seq ${match.observation.previousSample.sequence}->${match.observation.sample.sequence} `
        + `time ${Math.round(match.observation.previousSample.time)}->${Math.round(match.observation.sample.time)}ms`,
      );
    }
  }

  printUnmatchedSimHitErrorSummary(options, simulation, components, matchedComponentIndexes);
}

function printCaptureSourceDiagnostics(capture: CaptureData, simulation: SimulationResult): void {
  const selectedIndex = capture.segments.indexOf(capture.selectedSegment);
  const selectedFinal = capture.selectedSegment.samples[capture.selectedSegment.samples.length - 1];
  const breakSummary = getSimulationBreakSummary(simulation);

  console.log("\nCapture source summary:");
  console.log(
    `  selected play segment #${selectedIndex + 1}/${capture.segments.length} `
    + `seq ${capture.selectedSegment.startSequence}, `
    + `time ${Math.round(capture.selectedSegment.startTime)}->${Math.round(capture.selectedSegment.endTime)}ms, `
    + `samples ${capture.selectedSegment.samples.length}, `
    + `score ${formatNullableNumber(selectedFinal.score)}, `
    + `sliderBreaks ${formatNullableNumber(selectedFinal.sliderBreaks)}, `
    + `counts ${formatCounts(selectedFinal.counts)}`,
  );
  console.log(
    `  decoded .osr header scoreId ${formatNullableNumber(simulation.replayScoreId)} `
    + `score ${formatNullableNumber(simulation.replayScore)}, `
    + `counts ${formatCounts(simulation.replayCounts)}`,
  );
  console.log(
    "  sim body-break signal "
    + `visibleHoldBreaks ${breakSummary.visibleHoldBreaks}, `
    + `bodyBreakNotes ${breakSummary.bodyBreakNotes}, `
    + `bodyBreakTimes ${breakSummary.bodyBreakTimes}`,
  );

  if (capture.segments.length > 1) {
    console.log("  play segments:");
    capture.segments.slice(0, 8).forEach((segment, index) => {
      const final = segment.samples[segment.samples.length - 1];
      const selectedMarker = segment === capture.selectedSegment ? "*" : " ";
      console.log(
        `    ${selectedMarker}#${index + 1} seq ${segment.startSequence} `
        + `time ${Math.round(segment.startTime)}->${Math.round(segment.endTime)}ms `
        + `total ${final.total} score ${formatNullableNumber(final.score)} `
        + `sliderBreaks ${formatNullableNumber(final.sliderBreaks)} `
        + `counts ${formatCounts(final.counts)}`,
      );
    });
    if (capture.segments.length > 8) {
      console.log(`    ... ${capture.segments.length - 8} more segment(s) omitted`);
    }
  }

  if (capture.resultScreens.length > 0) {
    console.log("  result screens:");
    capture.resultScreens.slice(0, 8).forEach((resultScreen) => {
      console.log(
        `    seq ${resultScreen.sequence} `
        + `scoreId ${formatNullableNumber(resultScreen.scoreId)} `
        + `score ${formatNullableNumber(resultScreen.score)} `
        + `counts ${formatCounts(resultScreen.counts)}`
        + `${resultScreen.createdAt ? ` created ${resultScreen.createdAt}` : ""}`
        + resultScreenTags(resultScreen, capture.selectedSegment, simulation),
      );
    });
    if (capture.resultScreens.length > 8) {
      console.log(`    ... ${capture.resultScreens.length - 8} more result-screen record(s) omitted`);
    }
  } else {
    console.log("  result screens: none captured");
  }

  if (capture.finalLeaderboard) {
    const leaderboard = capture.finalLeaderboard;
    console.log(
      `  final leaderboard seq ${leaderboard.sequence} `
      + `time ${leaderboard.time == null ? "?" : Math.round(leaderboard.time)}ms `
      + "(stable leaderboard omits Geki/Katu detail):",
    );
    for (const entry of leaderboard.entries.slice(0, 6)) {
      console.log(
        `    #${formatNullableNumber(entry.position)} ${entry.name ?? "?"} `
        + `score ${formatNullableNumber(entry.score)} `
        + `hits 300=${entry.count300} 100=${entry.count100} 50=${entry.count50} miss=${entry.countMiss} `
        + `maxCombo=${formatNullableNumber(entry.comboMax)}`
        + leaderboardEntryTags(entry, capture.selectedSegment, simulation),
      );
    }
  }
}

function formatJudgment(judgment: Judgment | null): string {
  return judgment == null ? "-" : String(judgment);
}

function formatMs(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function formatTail(values: number[], limit: number): string {
  if (values.length === 0) return "[]";
  const tail = values.slice(-limit);
  const prefix = values.length > tail.length ? "... " : "";
  return `[${prefix}${tail.map((value) => Number.isInteger(value) ? String(value) : value.toFixed(3)).join(", ")}]`;
}

function formatStableStateFlags(state: ReplayNoteState | undefined): string {
  if (!state) return "";
  const flags = [
    state.stableHeldOkTimeout ? "heldOkTimeout" : "",
    state.stableTailWasHeldAtJudgement ? "heldTail" : "",
    state.stableBarelyCrossedTailOnTimeout ? "barelyCrossedTail" : "",
    state.stableLateStartReleasePastOk ? "lateStartPastOk" : "",
    state.stableMatchedPreviousTailSegment ? "matchedPreviousTailSegment" : "",
    state.stableMissedInsideConsumedSegment ? "missedInsideConsumedSegment" : "",
    state.stablePreHeadReleaseMissConsumedRecovery ? "preHeadReleaseMissConsumedRecovery" : "",
    state.stableConsumedHeldSegmentAtTimeout ? "consumedTimeoutSegment" : "",
  ].filter(Boolean);
  return flags.length > 0 ? ` flags=${flags.join(",")}` : "";
}

function formatStableEventDetails(simulation: SimulationResult, event: SimJudgementEvent): string {
  const note = simulation.notes[event.noteIndex];
  const state = simulation.noteStates[event.noteIndex];
  if (!state || event.part !== "hold-combined") return "";

  const scoringHead = Math.round(state.scoringHeadOffsetMs ?? state.headOffsetMs);
  const scoringTail = Math.round(state.scoringTailOffsetMs ?? state.tailOffsetMs);
  const details = [
    `dur=${Math.round(note.endTime - note.time)}`,
    `headTier=${stableFeatureOffsetTier(scoringHead, simulation)}`,
    `tailTier=${stableFeatureOffsetTier(scoringTail, simulation)}`,
    `tailBand=${stableFeatureSignedBand(scoringTail, 5)}`,
  ];

  if (state.stableTailSegmentReleaseDelay != null) {
    details.push(`releaseDelay=${formatMs(state.stableTailSegmentReleaseDelay)}`);
  }
  if (state.stableTailJudgementSourceTime != null) {
    details.push(`tailSource=${formatMs(state.stableTailJudgementSourceTime - note.endTime)}`);
  }

  return ` ${details.join(" ")}`;
}

function formatSimEvent(simulation: SimulationResult, ordinal: number): string {
  const event = simulation.events[ordinal - 1];
  if (!event) return `  #${String(ordinal).padStart(5)} <missing>`;

  return `  #${String(ordinal).padStart(5)}${formatSimEventObject(simulation, event).slice(4)}`;
}

function buildSimHitErrorEvents(simulation: SimulationResult): SimHitErrorEvent[] {
  const components: SimHitErrorEvent[] = [];

  for (const event of simulation.allEvents) {
    const note = simulation.notes[event.noteIndex];
    const state = simulation.noteStates[event.noteIndex];
    const isStableLongNote = simulation.accuracyMode === "stable" && note.isHold && note.endTime > note.time;

    if (event.part === "hold-break") {
      components.push({
        noteIndex: event.noteIndex,
        offset: Math.round(event.offsetMs),
        part: "break",
        result: null,
        time: event.time,
      });
      continue;
    }

    if (event.judgment == null) continue;

    if (!isStableLongNote) {
      components.push({
        noteIndex: event.noteIndex,
        offset: Math.round(event.offsetMs),
        part: "note",
        result: event.judgment,
        time: event.time,
      });
      continue;
    }

    // Stable's hit-error meter records LN head input when it happens, while
    // the score bucket is only awarded once the tail/body state is resolved.
    components.push({
      noteIndex: event.noteIndex,
      offset: Math.round(state.headOffsetMs),
      part: "head",
      result: state.headJudgment,
      time: state.headTime,
    });

    if (state.tailTime != null) {
      components.push({
        noteIndex: event.noteIndex,
        offset: Math.round(state.tailOffsetMs),
        part: "tail",
        result: event.judgment,
        time: state.tailTime,
      });
    }
  }

  components.sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.part.localeCompare(b.part));
  return components;
}

function buildIndexedSimHitErrorEvents(simulation: SimulationResult): IndexedSimHitErrorEvent[] {
  return buildSimHitErrorEvents(simulation)
    .map((component, componentIndex) => ({ ...component, componentIndex }));
}

function buildCaptureHitErrorObservations(capture: CaptureSegment): CaptureHitErrorObservation[] {
  const observations: CaptureHitErrorObservation[] = [];
  let previous: PlaySnapshot | null = null;

  for (const sample of capture.samples) {
    if (!previous) {
      if (sample.hitErrors.length > 0) {
        const syntheticPrevious: PlaySnapshot = {
          ...sample,
          counts: emptyReplayHitCounts(),
          hitErrors: [],
          sequence: sample.sequence - 1,
          time: Math.min(0, sample.time),
          total: 0,
        };
        for (let offset = 0; offset < sample.hitErrors.length; offset++) {
          observations.push({
            capturedError: sample.hitErrors[offset],
            capturedIndex: offset,
            previousSample: syntheticPrevious,
            sample,
          });
        }
      }
      previous = sample;
      continue;
    }

    if (sample.hitErrors.length >= previous.hitErrors.length) {
      const newErrors = sample.hitErrors.slice(previous.hitErrors.length);
      for (let offset = 0; offset < newErrors.length; offset++) {
        observations.push({
          capturedError: newErrors[offset],
          capturedIndex: previous.hitErrors.length + offset,
          previousSample: previous,
          sample,
        });
      }
    }

    previous = sample;
  }

  return observations;
}

function sameHitErrorValue(capturedError: number, simulatedOffset: number): boolean {
  return Math.abs(Math.abs(Math.round(capturedError)) - Math.abs(Math.round(simulatedOffset))) <= 1;
}

function distanceToInterval(value: number, start: number, end: number): number {
  if (value < start) return start - value;
  if (value > end) return value - end;
  return 0;
}

function findScoreOrdinalForComponent(simulation: SimulationResult, component: SimHitErrorEvent): number | null {
  if (component.part === "break") return null;

  const ordinal = simulation.events.findIndex((event) => {
    if (event.noteIndex !== component.noteIndex || event.judgment == null) return false;

    if (component.part === "note") return event.part === "note";
    return event.part === "hold-combined" || event.part === "hold-tail";
  });

  return ordinal === -1 ? null : ordinal + 1;
}

function findBestCaptureHitErrorMatch(
  observations: CaptureHitErrorObservation[],
  component: IndexedSimHitErrorEvent,
): CaptureHitErrorMatch | null {
  let best: CaptureHitErrorMatch | null = null;
  const timePaddingMs = 500;

  for (const observation of observations) {
    if (!sameHitErrorValue(observation.capturedError, component.offset)) continue;

    const timeDistance = distanceToInterval(
      component.time,
      observation.previousSample.time,
      observation.sample.time,
    );
    if (timeDistance > timePaddingMs) continue;

    const indexDistance = Math.abs(observation.capturedIndex - component.componentIndex);
    const cost = timeDistance * 10 + indexDistance;
    if (!best || cost < best.cost) {
      best = {
        cost,
        indexDistance,
        observation,
        timeDistance,
      };
    }
  }

  return best;
}

function getHitErrorComponentsForEvent(
  components: IndexedSimHitErrorEvent[],
  event: SimJudgementEvent,
): IndexedSimHitErrorEvent[] {
  const noteComponents = components.filter((component) => component.noteIndex === event.noteIndex);
  if (event.part === "note") {
    return noteComponents.filter((component) => component.part === "note");
  }
  if (event.part === "hold-head") {
    return noteComponents.filter((component) => component.part === "head");
  }
  if (event.part === "hold-tail") {
    return noteComponents.filter((component) => component.part === "tail");
  }
  return noteComponents;
}

function matchComponentInterval(
  simulation: SimulationResult,
  simHitErrors: SimHitErrorEvent[],
  previousErrorCount: number,
  newErrors: number[],
  startTime: number,
  endTime: number,
): ComponentMatch[] {
  const matches: ComponentMatch[] = [];
  const timePaddingMs = 500;
  const usedComponentIndexes = new Set<number>();
  let searchStart = Math.max(0, previousErrorCount - 128);

  for (let offset = 0; offset < newErrors.length; offset++) {
    const capturedIndex = previousErrorCount + offset;
    const capturedError = newErrors[offset];
    const windowStart = Math.max(0, Math.min(searchStart, capturedIndex - 128));
    const windowEnd = Math.min(simHitErrors.length, capturedIndex + 129);
    let bestIndex: number | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let index = windowStart; index < windowEnd; index++) {
      if (usedComponentIndexes.has(index)) continue;
      const component = simHitErrors[index];
      if (!sameHitErrorValue(capturedError, component.offset)) continue;
      const timeDistance = distanceToInterval(component.time, startTime, endTime);
      if (timeDistance > timePaddingMs) continue;

      const cost = timeDistance * 10 + Math.abs(index - capturedIndex);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }

    if (bestIndex == null) {
      matches.push({
        capturedError,
        capturedIndex,
        component: null,
        componentIndex: null,
        scoreOrdinal: null,
      });
      continue;
    }

    const component = simHitErrors[bestIndex];
    usedComponentIndexes.add(bestIndex);
    matches.push({
      capturedError,
      capturedIndex,
      component,
      componentIndex: bestIndex,
      scoreOrdinal: findScoreOrdinalForComponent(simulation, component),
    });
    searchStart = Math.max(searchStart, bestIndex + 1);
  }

  return matches;
}

function matchCaptureHitErrorObservations(
  capture: CaptureSegment,
  simulation: SimulationResult,
): ComponentObservationMatch[] {
  const observations = buildCaptureHitErrorObservations(capture);
  const simHitErrors = buildIndexedSimHitErrorEvents(simulation);
  const matches: ComponentObservationMatch[] = [];
  const timePaddingMs = 500;
  const usedComponentIndexes = new Set<number>();
  let searchStart = 0;

  for (const observation of observations) {
    const windowStart = Math.max(0, Math.min(searchStart, observation.capturedIndex - 160));
    const windowEnd = Math.min(simHitErrors.length, observation.capturedIndex + 161);
    let bestIndex: number | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let index = windowStart; index < windowEnd; index++) {
      if (usedComponentIndexes.has(index)) continue;
      const component = simHitErrors[index];
      if (!sameHitErrorValue(observation.capturedError, component.offset)) continue;
      const timeDistance = distanceToInterval(
        component.time,
        observation.previousSample.time,
        observation.sample.time,
      );
      if (timeDistance > timePaddingMs) continue;

      const cost = timeDistance * 10 + Math.abs(index - observation.capturedIndex);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }

    if (bestIndex == null) {
      matches.push({
        capturedError: observation.capturedError,
        capturedIndex: observation.capturedIndex,
        component: null,
        componentIndex: null,
        observation,
        scoreOrdinal: null,
      });
      continue;
    }

    const component = simHitErrors[bestIndex];
    usedComponentIndexes.add(bestIndex);
    matches.push({
      capturedError: observation.capturedError,
      capturedIndex: observation.capturedIndex,
      component,
      componentIndex: bestIndex,
      observation,
      scoreOrdinal: findScoreOrdinalForComponent(simulation, component),
    });
    searchStart = Math.max(searchStart, bestIndex + 1);
  }

  return matches;
}

function buildScoreOrdinalComponentIndexMap(
  simulation: SimulationResult,
  components: IndexedSimHitErrorEvent[],
): Map<number, Set<number>> {
  const indexesByOrdinal = new Map<number, Set<number>>();

  for (const component of components) {
    const ordinal = findScoreOrdinalForComponent(simulation, component);
    if (ordinal == null) continue;

    const indexes = indexesByOrdinal.get(ordinal) ?? new Set<number>();
    indexes.add(component.componentIndex);
    indexesByOrdinal.set(ordinal, indexes);
  }

  return indexesByOrdinal;
}

function countsForScoreOrdinals(simulation: SimulationResult, ordinals: Iterable<number>): ReplayHitCounts {
  const counts = emptyReplayHitCounts();

  for (const ordinal of ordinals) {
    addJudgment(counts, simulation.events[ordinal - 1]?.judgment ?? null);
  }

  return counts;
}

function judgmentCount(counts: ReplayHitCounts, judgment: Judgment): number {
  switch (judgment) {
    case 1:
      return counts.countGeki;
    case 2:
      return counts.count300;
    case 3:
      return counts.countKatu;
    case 4:
      return counts.count100;
    case 5:
      return counts.count50;
    case 6:
      return counts.countMiss;
  }

  return 0;
}

function consumePendingOrdinalsByCounts(
  simulation: SimulationResult,
  pendingOrdinals: number[],
  targetDelta: ReplayHitCounts,
): { consumed: number[]; exact: boolean; missing: ReplayHitCounts } {
  const consumed: number[] = [];
  const missing = emptyReplayHitCounts();
  const pendingByJudgment = new Map<Judgment, number[]>();

  for (const ordinal of pendingOrdinals) {
    const judgment = simulation.events[ordinal - 1]?.judgment ?? null;
    if (judgment == null) continue;

    const ordinals = pendingByJudgment.get(judgment) ?? [];
    ordinals.push(ordinal);
    pendingByJudgment.set(judgment, ordinals);
  }

  for (let value = 1; value <= 6; value++) {
    const judgment = value as Judgment;
    const needed = judgmentCount(targetDelta, judgment);
    if (needed <= 0) {
      if (needed < 0) addJudgmentValue(missing, judgment, Math.abs(needed));
      continue;
    }

    const available = pendingByJudgment.get(judgment) ?? [];
    if (available.length < needed) {
      addJudgmentValue(missing, judgment, needed - available.length);
    }
    consumed.push(...available.slice(0, needed));
  }

  return {
    consumed: countDiffDistance(missing) === 0 ? consumed.sort((a, b) => a - b) : [],
    exact: countDiffDistance(missing) === 0,
    missing,
  };
}

function countsAtOrdinal(simulation: SimulationResult, total: number): ReplayHitCounts {
  if (total <= 0) return emptyReplayHitCounts();
  return simulation.cumulativeByOrdinal[total - 1] ?? emptyReplayHitCounts();
}

function findCaptureIntervalByOrdinal(
  capture: CaptureSegment,
  ordinal: number,
): { previous: PlaySnapshot; sample: PlaySnapshot } | null {
  let previous: PlaySnapshot | null = null;

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    if (previous.total < ordinal && sample.total >= ordinal) {
      return { previous, sample };
    }

    previous = sample;
  }

  return null;
}

function findCaptureIntervalByTime(
  capture: CaptureSegment,
  time: number,
): { previous: PlaySnapshot; sample: PlaySnapshot } | null {
  let previous: PlaySnapshot | null = null;

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    if (previous.time < time && sample.time >= time) {
      return { previous, sample };
    }

    previous = sample;
  }

  return null;
}

function printDiffIntervals(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.diffIntervals) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  let printed = 0;
  let previous: PlaySnapshot | null = null;

  console.log(`\nDiff-changing capture intervals${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    if (sample.total <= previousSample.total) {
      continue;
    }

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;

    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const beforeSim = countsAtOrdinal(simulation, previousSample.total);
    const afterSim = countsAtOrdinal(simulation, sample.total);
    const beforeDiff = diffReplayHitCounts(beforeSim, previousSample.counts);
    const afterDiff = diffReplayHitCounts(afterSim, sample.counts);

    if (countsEqual(beforeDiff, afterDiff)) continue;

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const simDelta = subtractCounts(afterSim, beforeSim);
    const newErrors = sample.hitErrors.length >= previousSample.hitErrors.length
      ? sample.hitErrors.slice(previousSample.hitErrors.length)
      : [];

    console.log(
      `\n  totals ${intervalStart}-${intervalEnd} seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(`    diff ${formatDiff(beforeDiff)} -> ${formatDiff(afterDiff)}`);
    console.log(`    capDelta ${formatDiff(capDelta)} simDelta ${formatDiff(simDelta)} newErrors=${formatTail(newErrors, 24)}`);

    for (let ordinal = intervalStart; ordinal <= intervalEnd; ordinal++) {
      console.log(formatSimEvent(simulation, ordinal));
    }

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No diff-changing intervals found in the selected range.");
  }
}

function printVisibleIntervals(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.visibleIntervals) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  let printed = 0;
  let previous: PlaySnapshot | null = null;

  console.log(`\nVisible stable-bucket intervals${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    if (sample.total <= previousSample.total) {
      continue;
    }

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;

    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const beforeSim = countsAtOrdinal(simulation, previousSample.total);
    const afterSim = countsAtOrdinal(simulation, sample.total);
    const beforeDiff = diffReplayHitCounts(beforeSim, previousSample.counts);
    const afterDiff = diffReplayHitCounts(afterSim, sample.counts);

    if (visibleCountsEqual(beforeDiff, afterDiff)) continue;

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const simDelta = subtractCounts(afterSim, beforeSim);
    const newErrors = sample.hitErrors.length >= previousSample.hitErrors.length
      ? sample.hitErrors.slice(previousSample.hitErrors.length)
      : [];

    console.log(
      `\n  totals ${intervalStart}-${intervalEnd} seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(
      `    visible diff ${formatVisibleDiff(beforeDiff)} -> ${formatVisibleDiff(afterDiff)} `
      + "(300/100/50/miss)",
    );
    console.log(
      `    full diff ${formatDiff(beforeDiff)} -> ${formatDiff(afterDiff)}`,
    );
    console.log(
      `    capVisible ${formatVisibleDiff(capDelta)} simVisible ${formatVisibleDiff(simDelta)} `
      + `capFull ${formatDiff(capDelta)} simFull ${formatDiff(simDelta)} newErrors=${formatTail(newErrors, 24)}`,
    );

    for (let ordinal = intervalStart; ordinal <= intervalEnd; ordinal++) {
      console.log(formatSimEvent(simulation, ordinal));
    }

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No visible-bucket intervals found in the selected range.");
  }
}

function stableScoreDiffAt(
  trace: StableManiaScoreTrace | null,
  sample: PlaySnapshot,
): number | null {
  if (!trace || sample.score == null || sample.total <= 0) return null;
  const entry = trace.byOrdinal[sample.total - 1];
  return entry ? entry.scoreFloor - sample.score : null;
}

function formatNullableSigned(value: number | null): string {
  return value == null ? "?" : formatSignedNumber(value);
}

function addCountsInPlace(target: ReplayHitCounts, delta: ReplayHitCounts): void {
  target.countGeki += delta.countGeki;
  target.count300 += delta.count300;
  target.countKatu += delta.countKatu;
  target.count100 += delta.count100;
  target.count50 += delta.count50;
  target.countMiss += delta.countMiss;
}

function formatCompactSimEvent(simulation: SimulationResult, ordinal: number): string {
  const event = simulation.events[ordinal - 1];
  if (!event) return `#${ordinal}:<missing>`;

  const note = simulation.notes[event.noteIndex];
  const state = simulation.noteStates[event.noteIndex];
  const possible = event.possibleJudgments?.length ? ` poss=${event.possibleJudgments.join("")}` : "";
  const bodyBreaks = state?.bodyBreakTimes?.length
    ? ` bb=${state.bodyBreakTimes.map((time) => Math.round(time)).join("|")}`
    : "";
  const scoringOffsets = state?.scoringHeadOffsetMs == null
    ? ""
    : ` score=${Math.round(state.scoringHeadOffsetMs)}/${Math.round(state.scoringTailOffsetMs ?? 0)}`;

  return (
    `#${ordinal} j=${formatJudgment(event.judgment)} ${event.part} `
    + `c${event.column} n${event.noteIndex} ${Math.round(note.time)}-${Math.round(note.endTime)} `
    + `off=${Math.round(event.offsetMs)} h=${Math.round(state?.headOffsetMs ?? 0)} `
    + `t=${Math.round(state?.tailOffsetMs ?? 0)}${scoringOffsets}${bodyBreaks}${possible}`
  );
}

function selectDriftSummaryOrdinals(
  simulation: SimulationResult,
  startOrdinal: number,
  endOrdinal: number,
  limit: number,
): number[] {
  const ordinals: number[] = [];
  for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal++) {
    if (simulation.events[ordinal - 1]) ordinals.push(ordinal);
  }

  if (ordinals.length <= limit) return ordinals;

  const selected = new Set<number>();
  for (const ordinal of ordinals) {
    const event = simulation.events[ordinal - 1];
    const state = simulation.noteStates[event.noteIndex];
    if (
      (event.possibleJudgments?.length ?? 0) > 1
      || (event.judgment ?? 0) >= 3
      || (state?.bodyBreakTimes?.length ?? 0) > 0
    ) {
      selected.add(ordinal);
      if (selected.size >= limit) break;
    }
  }

  for (const ordinal of ordinals) {
    if (selected.size >= Math.ceil(limit / 2)) break;
    selected.add(ordinal);
  }

  for (const ordinal of ordinals.slice().reverse()) {
    if (selected.size >= limit) break;
    selected.add(ordinal);
  }

  return [...selected].sort((a, b) => a - b);
}

function printDriftSummary(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.driftSummary) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const trace = simulation.accuracyMode === "stable"
    ? buildStableManiaScoreTrace(simulation, true, false, "event-time")
    : null;
  const minimumScoreDiffChange = 25;
  let printed = 0;
  let previous: PlaySnapshot | null = null;

  console.log(`\nDrift summary${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    if (sample.total <= previousSample.total) continue;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const beforeSim = countsAtOrdinal(simulation, previousSample.total);
    const afterSim = countsAtOrdinal(simulation, sample.total);
    const beforeDiff = diffReplayHitCounts(beforeSim, previousSample.counts);
    const afterDiff = diffReplayHitCounts(afterSim, sample.counts);
    const beforeScoreDiff = stableScoreDiffAt(trace, previousSample);
    const afterScoreDiff = stableScoreDiffAt(trace, sample);
    const scoreChanged = options.scoreDiagnostics
      && beforeScoreDiff != null
      && afterScoreDiff != null
      && Math.abs(afterScoreDiff - beforeScoreDiff) >= minimumScoreDiffChange;
    const fullChanged = !countsEqual(beforeDiff, afterDiff);
    const visibleChanged = !visibleCountsEqual(beforeDiff, afterDiff);

    if (!fullChanged && !visibleChanged && !scoreChanged) continue;

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const simDelta = subtractCounts(afterSim, beforeSim);
    const newErrors = sample.hitErrors.length >= previousSample.hitErrors.length
      ? sample.hitErrors.slice(previousSample.hitErrors.length)
      : [];
    const markers = [
      fullChanged ? "full" : null,
      visibleChanged ? "visible" : null,
      scoreChanged ? "score" : null,
    ].filter((marker): marker is string => marker != null).join("+");
    const selectedOrdinals = selectDriftSummaryOrdinals(
      simulation,
      intervalStart,
      intervalEnd,
      Math.max(1, Math.min(options.context, 8)),
    );
    const omitted = intervalEnd - intervalStart + 1 > selectedOrdinals.length
      ? ` (+${intervalEnd - intervalStart + 1 - selectedOrdinals.length} omitted)`
      : "";

    console.log(
      `\n  [${markers}] totals ${intervalStart}-${intervalEnd} `
      + `seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(
      `    full ${formatDiff(beforeDiff)} -> ${formatDiff(afterDiff)}; `
      + `visible ${formatVisibleDiff(beforeDiff)} -> ${formatVisibleDiff(afterDiff)}; `
      + `hidden MAX/Katu ${formatHiddenStableDiff(beforeDiff)} -> ${formatHiddenStableDiff(afterDiff)}`,
    );
    console.log(
      `    cap ${formatDiff(capDelta)} sim ${formatDiff(simDelta)} `
      + `scoreDiff ${formatNullableSigned(beforeScoreDiff)}->${formatNullableSigned(afterScoreDiff)} `
      + `newErrors=${newErrors.length} tail=${formatTail(newErrors, 10)}`,
    );
    console.log(`    events ${selectedOrdinals.map((ordinal) => formatCompactSimEvent(simulation, ordinal)).join("; ")}${omitted}`);

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No drift-summary intervals found in the selected range.");
  }
}

interface LocalIntervalResolutionReport {
  changes: Array<{
    from: Judgment | null;
    ordinal: number;
    to: Judgment | null;
  }>;
  currentCounts: ReplayHitCounts;
  currentTotal: number;
  exact: boolean;
  resolved: boolean;
  resolvedMode: "none" | "ambiguity" | "score-header" | null;
  targetCounts: ReplayHitCounts;
  targetTotal: number;
}

function resolveLocalInterval(
  indexedEvents: IndexedSimEvent[],
  targetCounts: ReplayHitCounts,
): LocalIntervalResolutionReport {
  const events = indexedEvents.map(({ event }) => event);
  const currentCounts = countReplayJudgements(events);
  const currentTotal = getReplayHitCountTotal(currentCounts);
  const targetTotal = getReplayHitCountTotal(targetCounts);

  if (countsEqual(currentCounts, targetCounts)) {
    return {
      changes: [],
      currentCounts,
      currentTotal,
      exact: true,
      resolved: true,
      resolvedMode: "none",
      targetCounts,
      targetTotal,
    };
  }

  if (currentTotal !== targetTotal) {
    return {
      changes: [],
      currentCounts,
      currentTotal,
      exact: false,
      resolved: false,
      resolvedMode: null,
      targetCounts,
      targetTotal,
    };
  }

  const resolved = resolveReplayJudgementEvents(events, targetCounts, {
    allowLegacyScoreReconciliation: false,
  });

  const changes = resolved.resolved
    ? resolved.events
        .map((event, index) => ({
          from: events[index].judgment,
          ordinal: indexedEvents[index].ordinal,
          to: event.judgment,
        }))
        .filter((change) => change.from !== change.to)
    : [];

  return {
    changes,
    currentCounts,
    currentTotal,
    exact: false,
    resolved: resolved.resolved,
    resolvedMode: resolved.resolved ? resolved.mode : null,
    targetCounts,
    targetTotal,
  };
}

function formatLocalIntervalResolution(report: LocalIntervalResolutionReport): string {
  if (report.exact) return `exact ${formatCounts(report.currentCounts)}`;

  if (report.currentTotal !== report.targetTotal) {
    return (
      `${report.currentTotal} events cannot resolve ${report.targetTotal} captured `
      + `current ${formatCounts(report.currentCounts)} target ${formatCounts(report.targetCounts)}`
    );
  }

  return (
    `current ${formatCounts(report.currentCounts)} target ${formatCounts(report.targetCounts)} `
    + `diff ${formatDiff(diffReplayHitCounts(report.currentCounts, report.targetCounts))} `
    + `result ${report.resolved ? report.resolvedMode : "unresolved"}`
  );
}

function driftAttributionLabel(
  ordinal: LocalIntervalResolutionReport,
  time: LocalIntervalResolutionReport,
): { artifact: boolean; label: string } {
  if (time.exact) return { artifact: true, label: "time-exact" };
  if (time.resolved) return { artifact: false, label: "time-ambiguous" };
  if (ordinal.resolved) return { artifact: false, label: "ordinal-ambiguous" };
  if (time.currentTotal !== time.targetTotal) return { artifact: false, label: "time-count-mismatch" };
  if (ordinal.currentTotal !== ordinal.targetTotal) return { artifact: false, label: "ordinal-count-mismatch" };
  return { artifact: false, label: "unresolved" };
}

function printLocalResolutionChanges(
  simulation: SimulationResult,
  label: string,
  report: LocalIntervalResolutionReport,
  limit: number,
): void {
  if (report.changes.length === 0) return;

  console.log(`    ${label} changes:`);
  for (const change of report.changes.slice(0, limit)) {
    console.log(
      `      #${String(change.ordinal).padStart(5)} `
      + `${formatJudgment(change.from)} -> ${formatJudgment(change.to)}`,
    );
    console.log(formatSimEvent(simulation, change.ordinal));
  }

  if (report.changes.length > limit) {
    console.log(`      ... ${report.changes.length - limit} more changes omitted`);
  }
}

function printDriftAttribution(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.driftAttribution) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const unexplained = emptyReplayHitCounts();
  let printed = 0;
  let previous: PlaySnapshot | null = null;
  let eventCursor = 0;

  console.log(`\nDrift attribution${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    while (eventCursor < simulation.events.length && simulation.events[eventCursor].time <= previousSample.time) {
      eventCursor++;
    }

    if (sample.total <= previousSample.total) continue;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const beforeSim = countsAtOrdinal(simulation, previousSample.total);
    const afterSim = countsAtOrdinal(simulation, sample.total);
    const beforeDiff = diffReplayHitCounts(beforeSim, previousSample.counts);
    const afterDiff = diffReplayHitCounts(afterSim, sample.counts);
    if (countsEqual(beforeDiff, afterDiff)) continue;

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const ordinalEntries: IndexedSimEvent[] = [];
    for (let ordinal = intervalStart; ordinal <= intervalEnd; ordinal++) {
      const event = simulation.events[ordinal - 1];
      if (event) ordinalEntries.push({ event, ordinal });
    }

    const timeEntries: IndexedSimEvent[] = [];
    for (let index = eventCursor; index < simulation.events.length; index++) {
      const event = simulation.events[index];
      if (event.time > sample.time) break;
      timeEntries.push({ event, ordinal: index + 1 });
    }

    const ordinalResolution = resolveLocalInterval(ordinalEntries, capDelta);
    const timeResolution = resolveLocalInterval(timeEntries, capDelta);
    const attribution = driftAttributionLabel(ordinalResolution, timeResolution);
    const diffDelta = subtractCounts(afterDiff, beforeDiff);

    if (!attribution.artifact) {
      addCountsInPlace(unexplained, diffDelta);
    }

    const newErrors = sample.hitErrors.length >= previousSample.hitErrors.length
      ? sample.hitErrors.slice(previousSample.hitErrors.length)
      : [];

    console.log(
      `\n  [${attribution.label}] totals ${intervalStart}-${intervalEnd} `
      + `seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(
      `    diff ${formatDiff(beforeDiff)} -> ${formatDiff(afterDiff)} `
      + `delta ${formatDiff(diffDelta)} unexplained ${formatDiff(unexplained)}`,
    );
    console.log(
      `    cap ${formatDiff(capDelta)} `
      + `ordinal ${formatLocalIntervalResolution(ordinalResolution)}; `
      + `time ${formatLocalIntervalResolution(timeResolution)} `
      + `newErrors=${newErrors.length} tail=${formatTail(newErrors, 10)}`,
    );

    printLocalResolutionChanges(
      simulation,
      "time",
      timeResolution,
      Math.max(1, Math.min(options.context, 5)),
    );
    if (!timeResolution.resolved || timeResolution.exact) {
      printLocalResolutionChanges(
        simulation,
        "ordinal",
        ordinalResolution,
        Math.max(1, Math.min(options.context, 5)),
      );
    }

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No drift-attribution intervals found in the selected range.");
  } else {
    console.log(`\n  unexplained cumulative delta in printed range: ${formatDiff(unexplained)}`);
  }
}

function printTimeIntervals(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.timeIntervals) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  let printed = 0;
  let previous: PlaySnapshot | null = null;
  let eventCursor = 0;

  console.log(`\nTime-window capture intervals${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    while (eventCursor < simulation.events.length && simulation.events[eventCursor].time <= previousSample.time) {
      eventCursor++;
    }

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const simDelta = emptyReplayHitCounts();
    const eventOrdinals: number[] = [];
    for (let index = eventCursor; index < simulation.events.length; index++) {
      const event = simulation.events[index];
      if (event.time > sample.time) break;
      addJudgment(simDelta, event.judgment);
      eventOrdinals.push(index + 1);
    }

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    if (getReplayHitCountTotal(capDelta) === 0 && getReplayHitCountTotal(simDelta) === 0) continue;
    if (countsEqual(capDelta, simDelta)) continue;

    const newErrors = sample.hitErrors.length >= previousSample.hitErrors.length
      ? sample.hitErrors.slice(previousSample.hitErrors.length)
      : [];

    console.log(
      `\n  totals ${previousSample.total}-${sample.total} seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(`    capDelta ${formatDiff(capDelta)} simTimeDelta ${formatDiff(simDelta)} newErrors=${formatTail(newErrors, 24)}`);

    for (const ordinal of eventOrdinals) {
      console.log(formatSimEvent(simulation, ordinal));
    }

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No mismatching time-window intervals found in the selected range.");
  }
}

function countSimEvents(events: SimJudgementEvent[]): ReplayHitCounts {
  const counts = emptyReplayHitCounts();
  for (const event of events) addJudgment(counts, event.judgment);
  return counts;
}

function timeEventCursorBeforeOrAt(simulation: SimulationResult, time: number): number {
  let cursor = 0;
  while (cursor < simulation.events.length && simulation.events[cursor].time <= time) cursor++;
  return cursor;
}

function scoreStepForOrdinal(trace: StableManiaScoreTrace, ordinal: number): number | null {
  const current = trace.byOrdinal[ordinal - 1];
  if (!current) return null;
  const previous = trace.byOrdinal[ordinal - 2];
  return current.scoreFloor - (previous?.scoreFloor ?? 0);
}

function formatEventTags(tags: string[]): string {
  return tags.length ? tags.join("+") : "-";
}

function formatEventUpdateLine(
  simulation: SimulationResult,
  trace: StableManiaScoreTrace,
  ordinal: number,
  tags: string[],
): string {
  const event = simulation.events[ordinal - 1];
  if (!event) return `      ${formatEventTags(tags).padEnd(8)} #${ordinal}:<missing>`;
  const note = simulation.notes[event.noteIndex];
  const state = simulation.noteStates[event.noteIndex];
  const segments = simulation.segments[event.column]
    ?.filter((segment) => segment.end > note.time - 260 && segment.start < note.endTime + 260)
    .map((segment) => `${Math.round(segment.startPrevious ?? segment.start)}>${Math.round(segment.start)}-${Math.round(segment.endPrevious ?? segment.end)}>${Math.round(segment.end)}`)
    .join(" ");
  const heldSegments = state?.heldSegments
    ?.map((segment) => `${Math.round(segment.startPrevious ?? segment.start)}>${Math.round(segment.start)}-${Math.round(segment.endPrevious ?? segment.end)}>${Math.round(segment.end)}`)
    .join(",");
  const scoreStep = scoreStepForOrdinal(trace, ordinal);
  const possible = event.possibleJudgments?.length ? ` poss=${event.possibleJudgments.join("")}` : "";
  const bodyBreaks = state?.bodyBreakTimes?.length
    ? ` bb=${state.bodyBreakTimes.map((time) => Math.round(time)).join("|")}`
    : "";
  const scoringOffsets = state?.scoringHeadOffsetMs == null
    ? ""
    : ` score=${formatMs(state.scoringHeadOffsetMs)}/${formatMs(state.scoringTailOffsetMs ?? 0)}`;
  const cursorInfo = state?.stableSegmentCursorBefore == null
    ? ""
    : ` cursor=${state.stableSegmentCursorBefore}->${state.stableSegmentCursorAfter ?? "?"}`
      + ` next=${state.stableNextSegmentCursor ?? "?"}`
      + ` match=${state.stableMatchedSegmentIndex ?? "-"}`
      + ` scan=${state.stableLastScannedSegmentIndex ?? "-"}`
      + ` consume=${state.stableLastConsumedSegmentIndex ?? "-"}`
      + ` tailSeg=${state.stableTailSegmentIndex ?? "-"}`;

  return (
    `      ${formatEventTags(tags).padEnd(8)} #${String(ordinal).padStart(5)} `
    + `t=${formatMs(event.time).padStart(9)} j=${formatJudgment(event.judgment)} `
    + `${event.part.padEnd(13)} c${event.column} n${event.noteIndex} `
    + `${formatMs(note.time)}-${formatMs(note.endTime)} off=${formatMs(event.offsetMs)} `
    + `h=${formatMs(state?.headOffsetMs ?? 0)} t=${formatMs(state?.tailOffsetMs ?? 0)}`
    + scoringOffsets
    + ` step=${scoreStep == null ? "?" : formatSignedNumber(scoreStep)}`
    + cursorInfo
    + (heldSegments ? ` held=${heldSegments}` : "")
    + (state?.releaseTime != null ? ` rel=${formatMs(state.releaseTime)}` : "")
    + bodyBreaks
    + possible
    + ` segs=${segments ?? ""}`
  );
}

function printStableUpdateLoopTrace(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.updateLoopTrace) return;

  const aroundTotal = options.aroundTotal;
  const minTotal = options.intervalMinTotal
    ?? (aroundTotal == null ? 1 : Math.max(1, aroundTotal - options.context));
  const maxTotal = options.intervalMaxTotal
    ?? (aroundTotal == null ? Number.POSITIVE_INFINITY : aroundTotal + options.context);
  const trace = buildStableManiaScoreTrace(simulation, true, false, "event-time");
  const column = options.column;
  const columnText = column == null ? "" : ` column ${column}`;
  let printed = 0;
  let previous: PlaySnapshot | null = null;

  console.log(
    `\nStable update-loop trace${columnText}`
    + `${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`,
  );

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;
    if (sample.total <= previousSample.total) continue;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const ordinalOrdinals: number[] = [];
    for (let ordinal = intervalStart; ordinal <= intervalEnd; ordinal++) {
      const event = simulation.events[ordinal - 1];
      if (!event) continue;
      if (column != null && event.column !== column) continue;
      ordinalOrdinals.push(ordinal);
    }

    const timeStartCursor = timeEventCursorBeforeOrAt(simulation, previousSample.time);
    const timeEndCursor = timeEventCursorBeforeOrAt(simulation, sample.time);
    const timeOrdinals: number[] = [];
    for (let index = timeStartCursor; index < timeEndCursor; index++) {
      const event = simulation.events[index];
      if (column != null && event.column !== column) continue;
      timeOrdinals.push(index + 1);
    }

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const ordinalDelta = countSimEvents(ordinalOrdinals.map((ordinal) => simulation.events[ordinal - 1]).filter(Boolean));
    const timeDelta = countSimEvents(timeOrdinals.map((ordinal) => simulation.events[ordinal - 1]).filter(Boolean));
    const ordinalDiff = diffReplayHitCounts(ordinalDelta, capDelta);
    const timeDiff = diffReplayHitCounts(timeDelta, capDelta);
    const previousTimeTotal = timeStartCursor;
    const sampleTimeTotal = timeEndCursor;
    const exposureBefore = previousSample.total - previousTimeTotal;
    const exposureAfter = sample.total - sampleTimeTotal;
    const newErrors = sample.hitErrors.length >= previousSample.hitErrors.length
      ? sample.hitErrors.slice(previousSample.hitErrors.length)
      : [];
    const scoreByOrdinal = sample.total > 0 ? trace.byOrdinal[sample.total - 1] : null;
    const scoreByTime = stableScoreEntryAtTime(trace, sample.time);

    const shouldPrint = column != null
      || !countsEqual(ordinalDelta, capDelta)
      || !countsEqual(timeDelta, capDelta)
      || exposureBefore !== exposureAfter
      || intervalEnd >= minTotal;
    if (!shouldPrint) continue;

    console.log(
      `\n  totals ${intervalStart}-${intervalEnd} seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms `
      + `timeTotals ${previousTimeTotal}->${sampleTimeTotal} exposure ${formatSignedNumber(exposureBefore)}->${formatSignedNumber(exposureAfter)}`,
    );
    console.log(
      `    cap ${formatDiff(capDelta)} `
      + `ordinal ${formatDiff(ordinalDelta)} d=${countDiffDistance(ordinalDiff)} `
      + `time ${formatDiff(timeDelta)} d=${countDiffDistance(timeDiff)} `
      + `newErrors=${formatTail(newErrors, 18)}`,
    );
    console.log(
      `    score cap=${formatNullableNumber(sample.score)} `
      + `ord=${scoreByOrdinal?.scoreFloor ?? "?"}(${sample.score == null || !scoreByOrdinal ? "?" : formatSignedNumber(scoreByOrdinal.scoreFloor - sample.score)}) `
      + `time=${scoreByTime?.scoreFloor ?? "?"}(${sample.score == null || !scoreByTime ? "?" : formatSignedNumber(scoreByTime.scoreFloor - sample.score)})`,
    );

    const ordinals = new Set([...ordinalOrdinals, ...timeOrdinals]);
    const sorted = [...ordinals].sort((a, b) => a - b);
    for (const ordinal of sorted) {
      const tags = [
        ordinalOrdinals.includes(ordinal) ? "ord" : "",
        timeOrdinals.includes(ordinal) ? "time" : "",
      ].filter(Boolean);
      console.log(formatEventUpdateLine(simulation, trace, ordinal, tags));
    }

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No update-loop trace intervals found in the selected range.");
  }
}

function printComponentIntervals(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.componentIntervals) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const simHitErrors = buildSimHitErrorEvents(simulation);
  let printed = 0;
  let previous: PlaySnapshot | null = null;

  console.log(`\nHit-error component intervals${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const beforeSimOrdinal = countsAtOrdinal(simulation, previousSample.total);
    const afterSimOrdinal = countsAtOrdinal(simulation, sample.total);
    const simOrdinalDelta = subtractCounts(afterSimOrdinal, beforeSimOrdinal);
    const beforeSimTime = countsAtTime(simulation.events, previousSample.time);
    const afterSimTime = countsAtTime(simulation.events, sample.time);
    const simTimeDelta = subtractCounts(afterSimTime, beforeSimTime);
    const newErrors = sample.hitErrors.length >= previousSample.hitErrors.length
      ? sample.hitErrors.slice(previousSample.hitErrors.length)
      : [];

    if (
      newErrors.length === 0
      && countsEqual(capDelta, simOrdinalDelta)
      && countsEqual(capDelta, simTimeDelta)
    ) {
      continue;
    }

    if (countsEqual(capDelta, simOrdinalDelta) && countsEqual(capDelta, simTimeDelta)) {
      continue;
    }

    const matches = matchComponentInterval(
      simulation,
      simHitErrors,
      previousSample.hitErrors.length,
      newErrors,
      previousSample.time,
      sample.time,
    );

    console.log(
      `\n  totals ${intervalStart}-${intervalEnd} seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(
      `    capDelta ${formatDiff(capDelta)} `
      + `simOrdinalDelta ${formatDiff(simOrdinalDelta)} `
      + `simTimeDelta ${formatDiff(simTimeDelta)}`,
    );

    if (matches.length === 0) {
      console.log("    hit errors: []");
    } else {
      for (const match of matches) {
        const component = match.component;
        if (!component) {
          console.log(
            `    err#${String(match.capturedIndex).padStart(5)} cap=${String(Math.round(match.capturedError)).padStart(5)} -> <no nearby simulated component>`,
          );
          continue;
        }

        const note = simulation.notes[component.noteIndex];
        const scoreEvent = match.scoreOrdinal != null ? simulation.events[match.scoreOrdinal - 1] : null;
        const scoreRelation = match.scoreOrdinal == null
          ? ""
          : match.scoreOrdinal < intervalStart
            ? "before"
            : match.scoreOrdinal > intervalEnd
              ? "after"
              : "inside";

        console.log(
          `    err#${String(match.capturedIndex).padStart(5)} cap=${String(Math.round(match.capturedError)).padStart(5)} `
          + `-> e#${String(match.componentIndex ?? 0).padStart(5)} t=${String(Math.round(component.time)).padStart(7)} `
          + `${component.part.padEnd(5)} j=${formatJudgment(component.result)} off=${String(component.offset).padStart(5)} `
          + `c${note.column} n${component.noteIndex} ${Math.round(note.time)}-${Math.round(note.endTime)}`
          + (scoreEvent
            ? ` score#${String(match.scoreOrdinal).padStart(5)} ${scoreRelation} j=${formatJudgment(scoreEvent.judgment)} t=${Math.round(scoreEvent.time)}`
            : ""),
        );
      }
    }

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No component intervals found in the selected range.");
  }
}

function formatOrdinalSummary(simulation: SimulationResult, ordinals: number[], limit = 8): string {
  if (ordinals.length === 0) return "[]";

  const visible = ordinals.slice(0, limit).map((ordinal) => {
    const event = simulation.events[ordinal - 1];
    return `#${ordinal}:${formatJudgment(event?.judgment ?? null)}`;
  });
  const suffix = ordinals.length > visible.length ? ` ... +${ordinals.length - visible.length}` : "";
  return `[${visible.join(" ")}${suffix}]`;
}

function printOrdinalDetails(simulation: SimulationResult, ordinals: number[], limit: number): void {
  for (const ordinal of ordinals.slice(0, limit)) {
    console.log(formatSimEvent(simulation, ordinal));
  }
  if (ordinals.length > limit) {
    console.log(`  ... ${ordinals.length - limit} more ordinals omitted`);
  }
}

function printComponentExposure(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.componentExposure) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const indexedComponents = buildIndexedSimHitErrorEvents(simulation);
  const componentIndexesByOrdinal = buildScoreOrdinalComponentIndexMap(simulation, indexedComponents);
  const globalMatches = matchCaptureHitErrorObservations(capture, simulation);
  const matchByCapturedIndex = new Map(globalMatches.map((match) => [match.capturedIndex, match]));
  const matchedComponentIndexes = new Set(
    globalMatches
      .map((match) => match.componentIndex)
      .filter((index): index is number => index != null),
  );
  const matchedScoreOrdinals = new Set(
    globalMatches
      .map((match) => match.scoreOrdinal)
      .filter((ordinal): ordinal is number => ordinal != null),
  );
  const seenAnyOrdinals = new Set<number>();
  const completedOrdinals = new Set<number>();
  const observedComponentIndexes = new Set<number>();
  let completePendingOrdinals: number[] = [];
  let analyzed = 0;
  let changed = 0;
  let ordinalExact = 0;
  let timeExact = 0;
  let anyComponentExact = 0;
  let completeComponentExact = 0;
  let completePendingExact = 0;
  let anyComponentImproves = 0;
  let completeComponentImproves = 0;
  let printed = 0;
  let previous: PlaySnapshot | null = null;

  console.log(`\nComponent exposure model${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);
  console.log(
    `  matched hit errors ${matchedComponentIndexes.size}/${globalMatches.length}; `
    + `matched score ordinals ${matchedScoreOrdinals.size}/${simulation.events.length}; `
    + `sim components ${indexedComponents.length}`,
  );

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const beforeSimOrdinal = countsAtOrdinal(simulation, previousSample.total);
    const afterSimOrdinal = countsAtOrdinal(simulation, sample.total);
    const simOrdinalDelta = subtractCounts(afterSimOrdinal, beforeSimOrdinal);
    const beforeSimTime = countsAtTime(simulation.events, previousSample.time);
    const afterSimTime = countsAtTime(simulation.events, sample.time);
    const simTimeDelta = subtractCounts(afterSimTime, beforeSimTime);
    const touchedOrdinals = new Set<number>();
    const newAnyOrdinals: number[] = [];

    if (sample.hitErrors.length >= previousSample.hitErrors.length) {
      for (let index = previousSample.hitErrors.length; index < sample.hitErrors.length; index++) {
        const match = matchByCapturedIndex.get(index);
        if (match?.componentIndex != null) observedComponentIndexes.add(match.componentIndex);
        if (match?.scoreOrdinal == null) continue;

        touchedOrdinals.add(match.scoreOrdinal);
        if (!seenAnyOrdinals.has(match.scoreOrdinal)) {
          seenAnyOrdinals.add(match.scoreOrdinal);
          newAnyOrdinals.push(match.scoreOrdinal);
        }
      }
    }

    const newCompleteOrdinals: number[] = [];
    for (const ordinal of touchedOrdinals) {
      if (completedOrdinals.has(ordinal)) continue;
      const expectedComponents = componentIndexesByOrdinal.get(ordinal);
      if (!expectedComponents || expectedComponents.size === 0) continue;

      let complete = true;
      for (const componentIndex of expectedComponents) {
        if (!observedComponentIndexes.has(componentIndex)) {
          complete = false;
          break;
        }
      }

      if (!complete) continue;
      completedOrdinals.add(ordinal);
      newCompleteOrdinals.push(ordinal);
    }

    newAnyOrdinals.sort((a, b) => a - b);
    newCompleteOrdinals.sort((a, b) => a - b);

    const anyComponentDelta = countsForScoreOrdinals(simulation, newAnyOrdinals);
    const completeComponentDelta = countsForScoreOrdinals(simulation, newCompleteOrdinals);
    completePendingOrdinals.push(...newCompleteOrdinals);
    completePendingOrdinals.sort((a, b) => a - b);
    const pendingResult = consumePendingOrdinalsByCounts(simulation, completePendingOrdinals, capDelta);
    if (pendingResult.exact) {
      const consumed = new Set(pendingResult.consumed);
      completePendingOrdinals = completePendingOrdinals.filter((ordinal) => !consumed.has(ordinal));
    }

    const hasChange = getReplayHitCountTotal(capDelta) > 0
      || getReplayHitCountTotal(simOrdinalDelta) > 0
      || getReplayHitCountTotal(simTimeDelta) > 0
      || newAnyOrdinals.length > 0
      || newCompleteOrdinals.length > 0;
    if (!hasChange) continue;

    analyzed++;
    if (getReplayHitCountTotal(capDelta) > 0) changed++;

    const ordinalResidual = subtractCounts(simOrdinalDelta, capDelta);
    const timeResidual = subtractCounts(simTimeDelta, capDelta);
    const anyResidual = subtractCounts(anyComponentDelta, capDelta);
    const completeResidual = subtractCounts(completeComponentDelta, capDelta);
    const ordinalDistance = countDiffDistance(ordinalResidual);
    const timeDistance = countDiffDistance(timeResidual);
    const anyDistance = countDiffDistance(anyResidual);
    const completeDistance = countDiffDistance(completeResidual);
    const baselineDistance = Math.min(ordinalDistance, timeDistance);

    if (ordinalDistance === 0) ordinalExact++;
    if (timeDistance === 0) timeExact++;
    if (anyDistance === 0) anyComponentExact++;
    if (completeDistance === 0) completeComponentExact++;
    if (pendingResult.exact) completePendingExact++;
    if (anyDistance < baselineDistance) anyComponentImproves++;
    if (completeDistance < baselineDistance) completeComponentImproves++;

    const shouldPrint = printed < options.limit && (
      ordinalDistance > 0
      || anyDistance < baselineDistance
      || completeDistance < baselineDistance
      || (baselineDistance > 0 && !pendingResult.exact)
    );
    if (!shouldPrint) continue;

    console.log(
      `\n  totals ${intervalStart}-${intervalEnd} seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(
      `    cap ${formatDiff(capDelta)} `
      + `ordinal ${formatDiff(simOrdinalDelta)} d=${ordinalDistance} `
      + `time ${formatDiff(simTimeDelta)} d=${timeDistance}`,
    );
    console.log(
      `    any-component ${formatDiff(anyComponentDelta)} d=${anyDistance} `
      + `complete-component ${formatDiff(completeComponentDelta)} d=${completeDistance} `
      + `complete-pending ${pendingResult.exact ? "exact" : `missing ${formatDiff(pendingResult.missing)}`}`,
    );
    console.log(
      `    newAny ${formatOrdinalSummary(simulation, newAnyOrdinals)} `
      + `newComplete ${formatOrdinalSummary(simulation, newCompleteOrdinals)} `
      + `pending=${completePendingOrdinals.length}`,
    );

    printed++;
  }

  console.log(
    `  intervals analyzed ${analyzed}, count-changing ${changed}; `
    + `exact ordinal/time/any/complete/pending ${ordinalExact}/${timeExact}/${anyComponentExact}/${completeComponentExact}/${completePendingExact}; `
    + `component improvements any/complete ${anyComponentImproves}/${completeComponentImproves}`,
  );

  const finalSample = capture.samples[capture.samples.length - 1];
  const finalTargetCounts = finalSample?.counts ?? emptyReplayHitCounts();
  const matchedOrdinalCounts = countsForScoreOrdinals(simulation, matchedScoreOrdinals);
  const unmatchedOrdinals = simulation.events
    .map((_, index) => index + 1)
    .filter((ordinal) => !matchedScoreOrdinals.has(ordinal));
  const unmatchedOrdinalCounts = countsForScoreOrdinals(simulation, unmatchedOrdinals);
  const pendingCounts = countsForScoreOrdinals(simulation, completePendingOrdinals);
  const finalDiff = diffReplayHitCounts(simulation.simulatedCounts, finalTargetCounts);
  const matchedDiff = diffReplayHitCounts(matchedOrdinalCounts, finalTargetCounts);

  console.log("\n  Final component exposure state:");
  console.log(`    final diff sim-target ${formatDiff(finalDiff)}`);
  console.log(
    `    matched-score counts ${formatCounts(matchedOrdinalCounts)} diff-to-target ${formatDiff(matchedDiff)}`,
  );
  console.log(
    `    unmatched-score ordinals ${unmatchedOrdinals.length} counts ${formatCounts(unmatchedOrdinalCounts)} `
    + formatOrdinalSummary(simulation, unmatchedOrdinals, options.limit),
  );
  console.log(
    `    complete-pending ordinals ${completePendingOrdinals.length} counts ${formatCounts(pendingCounts)} `
    + formatOrdinalSummary(simulation, completePendingOrdinals, options.limit),
  );

  if (unmatchedOrdinals.length > 0) {
    console.log("    first unmatched score ordinals:");
    printOrdinalDetails(simulation, unmatchedOrdinals, options.limit);
  }
  if (completePendingOrdinals.length > 0) {
    console.log("    pending complete score ordinals:");
    printOrdinalDetails(simulation, completePendingOrdinals, options.limit);
  }

  if (printed === 0) {
    console.log("  No component exposure rows found in the selected range.");
  }
}

function formatIntervalTimeRelation(
  indexedEvents: IndexedSimEvent[],
  previousTime: number,
  sampleTime: number,
): string {
  let before = 0;
  let inside = 0;
  let after = 0;

  for (const { event } of indexedEvents) {
    if (event.time <= previousTime) before++;
    else if (event.time > sampleTime) after++;
    else inside++;
  }

  return `before=${before} inside=${inside} after=${after}`;
}

function printLocalIntervalResolution(
  simulation: SimulationResult,
  label: string,
  indexedEvents: IndexedSimEvent[],
  targetCounts: ReplayHitCounts,
  limit: number,
): void {
  const events = indexedEvents.map(({ event }) => event);
  const currentCounts = countReplayJudgements(events);
  const currentTotal = getReplayHitCountTotal(currentCounts);
  const targetTotal = getReplayHitCountTotal(targetCounts);

  if (currentTotal !== targetTotal) {
    console.log(
      `    ${label}: ${currentTotal} score events cannot resolve ${targetTotal} captured results `
      + `current ${formatCounts(currentCounts)} target ${formatCounts(targetCounts)}`,
    );
    return;
  }

  if (countsEqual(currentCounts, targetCounts)) {
    console.log(`    ${label}: exact ${formatCounts(currentCounts)}`);
    return;
  }

  const resolved = resolveReplayJudgementEvents(events, targetCounts, {
    allowLegacyScoreReconciliation: false,
  });
  console.log(
    `    ${label}: current ${formatCounts(currentCounts)} target ${formatCounts(targetCounts)} `
    + `diff ${formatDiff(diffReplayHitCounts(currentCounts, targetCounts))} `
    + `result ${resolved.resolved ? resolved.mode : "unresolved"}`,
  );

  if (!resolved.resolved) return;

  let printed = 0;
  for (let index = 0; index < events.length; index++) {
    if (events[index].judgment === resolved.events[index].judgment) continue;

    const ordinal = indexedEvents[index].ordinal;
    console.log(
      `      #${String(ordinal).padStart(5)} `
      + `${formatJudgment(events[index].judgment)} -> ${formatJudgment(resolved.events[index].judgment)}`,
    );
    console.log(formatSimEvent(simulation, ordinal));

    printed++;
    if (printed >= limit) break;
  }

  if (printed === 0) {
    console.log("      No judgment changes were needed.");
  }
}

function printResolvedIntervals(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.resolveIntervals) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  let printed = 0;
  let previous: PlaySnapshot | null = null;
  let eventCursor = 0;

  console.log(`\nInterval-local ambiguity resolver${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  for (const sample of capture.samples) {
    if (!previous) {
      previous = sample;
      continue;
    }

    const previousSample = previous;
    previous = sample;

    while (eventCursor < simulation.events.length && simulation.events[eventCursor].time <= previousSample.time) {
      eventCursor++;
    }

    if (sample.total <= previousSample.total) continue;

    const intervalStart = previousSample.total + 1;
    const intervalEnd = sample.total;
    if (intervalEnd < minTotal || intervalStart > maxTotal) continue;

    const beforeSim = countsAtOrdinal(simulation, previousSample.total);
    const afterSim = countsAtOrdinal(simulation, sample.total);
    const beforeDiff = diffReplayHitCounts(beforeSim, previousSample.counts);
    const afterDiff = diffReplayHitCounts(afterSim, sample.counts);
    const capDelta = subtractCounts(sample.counts, previousSample.counts);
    const ordinalEntries: IndexedSimEvent[] = [];
    for (let ordinal = intervalStart; ordinal <= intervalEnd; ordinal++) {
      const event = simulation.events[ordinal - 1];
      if (event) ordinalEntries.push({ event, ordinal });
    }

    const timeEntries: IndexedSimEvent[] = [];
    for (let index = eventCursor; index < simulation.events.length; index++) {
      const event = simulation.events[index];
      if (event.time > sample.time) break;
      timeEntries.push({ event, ordinal: index + 1 });
    }

    const simOrdinalDelta = countReplayJudgements(ordinalEntries.map(({ event }) => event));
    const simTimeDelta = countReplayJudgements(timeEntries.map(({ event }) => event));
    const diffChanged = !countsEqual(beforeDiff, afterDiff);
    const includeLagOnly = options.timeIntervals || options.componentIntervals;

    if (!diffChanged && !includeLagOnly) continue;
    if (
      !diffChanged
      && countsEqual(capDelta, simOrdinalDelta)
      && countsEqual(capDelta, simTimeDelta)
    ) {
      continue;
    }

    console.log(
      `\n  totals ${intervalStart}-${intervalEnd} seq ${previousSample.sequence}->${sample.sequence} `
      + `time ${Math.round(previousSample.time)}->${Math.round(sample.time)}ms`,
    );
    console.log(
      `    diff ${formatDiff(beforeDiff)} -> ${formatDiff(afterDiff)} `
      + `capDelta ${formatDiff(capDelta)}`,
    );
    console.log(
      `    ordinal events ${formatCounts(simOrdinalDelta)} `
      + `(${formatIntervalTimeRelation(ordinalEntries, previousSample.time, sample.time)})`,
    );
    printLocalIntervalResolution(simulation, "ordinal", ordinalEntries, capDelta, Math.min(6, options.context));
    console.log(`    time events ${formatCounts(simTimeDelta)}`);
    printLocalIntervalResolution(simulation, "time", timeEntries, capDelta, Math.min(6, options.context));

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No interval-local resolver cases found in the selected range.");
  }
}

function formatCandidateInterval(
  simulation: SimulationResult,
  label: string,
  interval: { previous: PlaySnapshot; sample: PlaySnapshot } | null,
): string {
  if (!interval) return `      ${label}: <no capture interval>`;

  const { previous, sample } = interval;
  const capDelta = subtractCounts(sample.counts, previous.counts);
  const simOrdinalDelta = subtractCounts(
    countsAtOrdinal(simulation, sample.total),
    countsAtOrdinal(simulation, previous.total),
  );
  const simTimeDelta = subtractCounts(
    countsAtTime(simulation.events, sample.time),
    countsAtTime(simulation.events, previous.time),
  );
  const newErrors = sample.hitErrors.length >= previous.hitErrors.length
    ? sample.hitErrors.slice(previous.hitErrors.length)
    : [];

  return (
    `      ${label}: totals ${previous.total + 1}-${sample.total} `
    + `time ${Math.round(previous.time)}->${Math.round(sample.time)}ms `
    + `cap ${formatDiff(capDelta)} simOrdinal ${formatDiff(simOrdinalDelta)} `
    + `simTime ${formatDiff(simTimeDelta)} newErrors=${formatTail(newErrors, 10)}`
  );
}

function printCandidateEvidence(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.candidateEvidence) return;

  const startOrdinal = Math.max(1, options.intervalMinTotal ?? 1);
  const currentCounts = countReplayJudgements(simulation.events);
  const currentDiff = diffReplayHitCounts(currentCounts, target.counts);
  const currentArray = replayHitCountsToArray(currentCounts);
  const targetArray = replayHitCountsToArray(target.counts);
  const observations = buildCaptureHitErrorObservations(capture);
  const components = buildIndexedSimHitErrorEvents(simulation);
  const finalCapture = capture.samples[capture.samples.length - 1];
  const baseScoreTrace = simulation.accuracyMode === "stable"
    ? buildStableManiaScoreTrace(simulation, true, false, "event-time")
    : null;
  const baseScore = baseScoreTrace?.byOrdinal.at(-1)?.scoreFloor ?? null;
  let printedPair = false;

  console.log(`\nFinal candidate evidence against ${target.label}${startOrdinal > 1 ? ` from ordinal ${startOrdinal}` : ""}:`);
  console.log(`  current diff ${formatDiff(currentDiff)} visible ${formatVisibleDiff(currentDiff)} (300/100/50/miss)`);

  if (countsEqual(currentCounts, target.counts)) {
    console.log("  Simulated counts already match the target.");
    return;
  }

  for (let currentJudgment = 1; currentJudgment <= 6; currentJudgment++) {
    const surplus = currentArray[currentJudgment] - targetArray[currentJudgment];
    if (surplus <= 0) continue;

    for (let targetJudgment = 1; targetJudgment <= 6; targetJudgment++) {
      const deficit = targetArray[targetJudgment] - currentArray[targetJudgment];
      if (deficit <= 0 || targetJudgment === currentJudgment) continue;

      const pairLimit = Math.min(options.limit, Math.max(surplus, deficit));
      const candidates = simulation.events
        .map((event, index) => ({ event, ordinal: index + 1 }))
        .filter(({ event, ordinal }) => ordinal >= startOrdinal && event.judgment === currentJudgment)
        .map(({ event, ordinal }) => {
          const possible = event.possibleJudgments ?? [];
          const explicit = possible.includes(targetJudgment as Judgment);
          return {
            cost: (explicit ? 0 : 1000)
              + Math.abs(targetJudgment - currentJudgment) * 100
              + (targetJudgment > currentJudgment ? -Math.abs(event.offsetMs) : Math.abs(event.offsetMs)),
            event,
            explicit,
            ordinal,
          };
        })
        .sort((a, b) => a.cost - b.cost || a.ordinal - b.ordinal)
        .slice(0, pairLimit);

      printedPair = true;
      console.log(
        `  ${currentJudgment} -> ${targetJudgment} need up to ${Math.min(surplus, deficit)} `
        + `showing ${candidates.length}`,
      );

      for (const candidate of candidates) {
        const eventComponents = getHitErrorComponentsForEvent(components, candidate.event);
        const evidence = eventComponents.map((component) => ({
          component,
          match: findBestCaptureHitErrorMatch(observations, component),
        }));
        const matched = evidence.filter(({ match }) => match != null).length;
        const ordinalInterval = findCaptureIntervalByOrdinal(capture, candidate.ordinal);
        const timeInterval = findCaptureIntervalByTime(capture, candidate.event.time);
        const scoreDeltaText = baseScore != null && finalCapture.score != null
          ? (() => {
              const overrideTrace = buildStableManiaScoreTrace(
                simulation,
                true,
                false,
                "event-time",
                new Map([[candidate.event, targetJudgment as Judgment]]),
              );
              const score = overrideTrace.byOrdinal.at(-1)?.scoreFloor ?? baseScore;
              const baseDiff = baseScore - finalCapture.score;
              const nextDiff = score - finalCapture.score;
              const scoreDelta = score - baseScore;
              const signed = (value: number) => value > 0 ? `+${value}` : String(value);
              return ` scoreDelta ${signed(scoreDelta)} scoreDiff ${signed(baseDiff)}->${signed(nextDiff)}`;
            })()
          : "";
        const sameInterval = ordinalInterval != null
          && timeInterval != null
          && ordinalInterval.previous.sequence === timeInterval.previous.sequence
          && ordinalInterval.sample.sequence === timeInterval.sample.sequence;

        console.log(
          `    candidate #${String(candidate.ordinal).padStart(5)} `
          + `${candidate.explicit ? "explicit" : "outside"} `
          + `components ${matched}/${eventComponents.length}`
          + scoreDeltaText,
        );
        console.log(formatSimEvent(simulation, candidate.ordinal));
        console.log(formatCandidateInterval(simulation, "ordinal", ordinalInterval));
        if (!sameInterval) {
          console.log(formatCandidateInterval(simulation, "time", timeInterval));
        }

        for (const { component, match } of evidence) {
          const note = simulation.notes[component.noteIndex];
          if (!match) {
            console.log(
              `      ${component.part.padEnd(5)} e#${String(component.componentIndex).padStart(5)} `
              + `t=${Math.round(component.time)} off=${String(component.offset).padStart(5)} `
              + `c${note.column} n${component.noteIndex}: no raw hit-error match`,
            );
            continue;
          }

          const observation = match.observation;
          console.log(
            `      ${component.part.padEnd(5)} e#${String(component.componentIndex).padStart(5)} `
            + `t=${Math.round(component.time)} off=${String(component.offset).padStart(5)} `
            + `c${note.column} n${component.noteIndex} -> `
            + `err#${String(observation.capturedIndex).padStart(5)} cap=${String(Math.round(observation.capturedError)).padStart(5)} `
            + `seq ${observation.previousSample.sequence}->${observation.sample.sequence} `
            + `time ${Math.round(observation.previousSample.time)}->${Math.round(observation.sample.time)}ms `
            + `dt=${Math.round(match.timeDistance)} di=${match.indexDistance}`,
          );
        }
      }
    }
  }

  if (!printedPair) {
    console.log("  No direct surplus/deficit pairs found.");
  }
}

function addJudgmentValue(counts: ReplayHitCounts, judgment: Judgment, value: number): void {
  switch (judgment) {
    case 1:
      counts.countGeki += value;
      break;
    case 2:
      counts.count300 += value;
      break;
    case 3:
      counts.countKatu += value;
      break;
    case 4:
      counts.count100 += value;
      break;
    case 5:
      counts.count50 += value;
      break;
    case 6:
      counts.countMiss += value;
      break;
  }
}

function judgmentChangeDelta(from: Judgment, to: Judgment): ReplayHitCounts {
  const delta = emptyReplayHitCounts();
  addJudgmentValue(delta, from, -1);
  addJudgmentValue(delta, to, 1);
  return delta;
}

function addCounts(counts: ReplayHitCounts, delta: ReplayHitCounts): ReplayHitCounts {
  return {
    countGeki: counts.countGeki + delta.countGeki,
    count300: counts.count300 + delta.count300,
    countKatu: counts.countKatu + delta.countKatu,
    count100: counts.count100 + delta.count100,
    count50: counts.count50 + delta.count50,
    countMiss: counts.countMiss + delta.countMiss,
  };
}

interface AlignmentSampleDiff {
  diff: ReplayHitCounts;
  sample: PlaySnapshot;
}

function buildTimeSampleDiffs(capture: CaptureSegment, simulation: SimulationResult, startOrdinal: number): AlignmentSampleDiff[] {
  const rows: AlignmentSampleDiff[] = [];
  const counts = emptyReplayHitCounts();
  let eventCursor = 0;

  for (const sample of capture.samples) {
    while (eventCursor < simulation.events.length && simulation.events[eventCursor].time <= sample.time) {
      addJudgment(counts, simulation.events[eventCursor].judgment);
      eventCursor++;
    }

    if (sample.total >= startOrdinal) {
      rows.push({
        diff: diffReplayHitCounts(cloneCounts(counts), sample.counts),
        sample,
      });
    }
  }

  return rows;
}

function buildOrdinalSampleDiffs(capture: CaptureSegment, simulation: SimulationResult, startOrdinal: number): AlignmentSampleDiff[] {
  const rows: AlignmentSampleDiff[] = [];

  for (const sample of capture.samples) {
    if (sample.total < startOrdinal) continue;
    rows.push({
      diff: diffReplayHitCounts(countsAtOrdinal(simulation, sample.total), sample.counts),
      sample,
    });
  }

  return rows;
}

function getAlignmentImprovement(
  rows: AlignmentSampleDiff[],
  delta: ReplayHitCounts,
  applies: (sample: PlaySnapshot) => boolean,
): number {
  let improvement = 0;

  for (const row of rows) {
    if (!applies(row.sample)) continue;
    improvement += countDiffDistance(row.diff) - countDiffDistance(addCounts(row.diff, delta));
  }

  return improvement;
}

interface GlobalAlignmentCandidate {
  diff: ReplayHitCounts;
  eventTime: number | null;
  fullDistance: number;
  hiddenDistance: number;
  localCost: number;
  ordinal: number;
  ordinalShift: number;
  sample: PlaySnapshot;
  timeDiff: number | null;
  visibleDistance: number;
}

interface GlobalAlignmentState {
  candidate: GlobalAlignmentCandidate;
  previous: GlobalAlignmentState | null;
  totalCost: number;
}

interface GlobalAlignmentPath {
  beamWidth: number;
  candidates: GlobalAlignmentCandidate[];
  radius: number;
  sampleCount: number;
}

function hiddenStableDiffDistance(diff: ReplayHitCounts): number {
  return Math.abs(diff.countGeki) + Math.abs(diff.countKatu);
}

function ordinalAtOrBeforeTime(events: SimJudgementEvent[], time: number): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid].time <= time) low = mid + 1;
    else high = mid;
  }

  return low;
}

function eventTimeForPrefix(simulation: SimulationResult, ordinal: number): number | null {
  if (ordinal <= 0) return null;
  return simulation.events[ordinal - 1]?.time ?? null;
}

function globalAlignmentLocalCost(candidate: Omit<GlobalAlignmentCandidate, "localCost">): number {
  const timePenalty = candidate.timeDiff == null
    ? 0
    : Math.min(Math.abs(candidate.timeDiff), 1500) / 20;

  return candidate.fullDistance * 10000
    + candidate.visibleDistance * 2000
    + candidate.hiddenDistance * 1000
    + Math.abs(candidate.ordinalShift) * 40
    + timePenalty;
}

function selectGlobalAlignmentSamples(options: CliOptions, capture: CaptureSegment): PlaySnapshot[] {
  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const samples: PlaySnapshot[] = [];
  let previousIncluded: PlaySnapshot | null = null;

  for (const sample of capture.samples) {
    if (sample.total < minTotal || sample.total > maxTotal) continue;
    if (
      previousIncluded
      && sample.total === previousIncluded.total
      && countsEqual(sample.counts, previousIncluded.counts)
    ) {
      continue;
    }

    samples.push(sample);
    previousIncluded = sample;
  }

  return samples;
}

function buildGlobalAlignmentCandidateRow(
  simulation: SimulationResult,
  sample: PlaySnapshot,
  radius: number,
  candidateLimit: number,
): GlobalAlignmentCandidate[] {
  const maxOrdinal = simulation.events.length;
  const clampedSampleOrdinal = Math.max(0, Math.min(maxOrdinal, sample.total));
  const timeOrdinal = ordinalAtOrBeforeTime(simulation.events, sample.time);
  const ordinals = new Set<number>();
  const anchorOrdinals = new Set<number>([
    clampedSampleOrdinal,
    Math.max(0, Math.min(maxOrdinal, timeOrdinal)),
  ]);

  const addRange = (center: number) => {
    const start = Math.max(0, center - radius);
    const end = Math.min(maxOrdinal, center + radius);
    for (let ordinal = start; ordinal <= end; ordinal++) ordinals.add(ordinal);
  };

  addRange(clampedSampleOrdinal);
  addRange(timeOrdinal);
  for (const ordinal of anchorOrdinals) ordinals.add(ordinal);

  const candidates = [...ordinals].map((ordinal) => {
    const counts = countsAtOrdinal(simulation, ordinal);
    const diff = diffReplayHitCounts(counts, sample.counts);
    const eventTime = eventTimeForPrefix(simulation, ordinal);
    const timeDiff = eventTime == null ? null : eventTime - sample.time;
    const candidateWithoutCost = {
      diff,
      eventTime,
      fullDistance: countDiffDistance(diff),
      hiddenDistance: hiddenStableDiffDistance(diff),
      ordinal,
      ordinalShift: ordinal - sample.total,
      sample,
      timeDiff,
      visibleDistance: visibleDiffDistance(diff),
    };

    return {
      ...candidateWithoutCost,
      localCost: globalAlignmentLocalCost(candidateWithoutCost),
    };
  }).sort((a, b) => {
    if (a.localCost !== b.localCost) return a.localCost - b.localCost;
    if (a.fullDistance !== b.fullDistance) return a.fullDistance - b.fullDistance;
    if (a.visibleDistance !== b.visibleDistance) return a.visibleDistance - b.visibleDistance;
    return Math.abs(a.ordinalShift) - Math.abs(b.ordinalShift) || a.ordinal - b.ordinal;
  });

  const selected = new Map<number, GlobalAlignmentCandidate>();
  for (const candidate of candidates) {
    if (selected.size < candidateLimit || anchorOrdinals.has(candidate.ordinal)) {
      selected.set(candidate.ordinal, candidate);
    }
  }

  return [...selected.values()].sort((a, b) => a.ordinal - b.ordinal);
}

function globalAlignmentTransitionCost(
  previous: GlobalAlignmentCandidate,
  candidate: GlobalAlignmentCandidate,
): number {
  const expectedDelta = candidate.sample.total - previous.sample.total;
  const actualDelta = candidate.ordinal - previous.ordinal;

  return Math.abs(actualDelta - expectedDelta) * 25
    + Math.abs(candidate.ordinalShift - previous.ordinalShift) * 4;
}

function traceGlobalAlignmentState(state: GlobalAlignmentState): GlobalAlignmentCandidate[] {
  const candidates: GlobalAlignmentCandidate[] = [];
  let current: GlobalAlignmentState | null = state;

  while (current) {
    candidates.push(current.candidate);
    current = current.previous;
  }

  return candidates.reverse();
}

function buildGlobalAlignmentPath(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
): GlobalAlignmentPath | null {
  const samples = selectGlobalAlignmentSamples(options, capture);
  if (samples.length === 0) return null;

  const radius = Math.max(16, options.context * 2);
  const beamWidth = Math.max(48, options.context * 6);
  const candidateLimit = Math.max(beamWidth, 64);
  let states: GlobalAlignmentState[] = [];

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const row = buildGlobalAlignmentCandidateRow(
      simulation,
      samples[sampleIndex],
      radius,
      candidateLimit,
    );

    if (row.length === 0) return null;

    if (sampleIndex === 0) {
      states = row
        .map((candidate) => ({
          candidate,
          previous: null,
          totalCost: candidate.localCost,
        }))
        .sort((a, b) => a.totalCost - b.totalCost)
        .slice(0, beamWidth);
      continue;
    }

    const nextStates: GlobalAlignmentState[] = [];

    for (const candidate of row) {
      let bestPrevious: GlobalAlignmentState | null = null;
      let bestCost = Number.POSITIVE_INFINITY;

      for (const previous of states) {
        if (previous.candidate.ordinal > candidate.ordinal) continue;

        const totalCost = previous.totalCost
          + candidate.localCost
          + globalAlignmentTransitionCost(previous.candidate, candidate);

        if (totalCost < bestCost) {
          bestCost = totalCost;
          bestPrevious = previous;
        }
      }

      if (bestPrevious) {
        nextStates.push({
          candidate,
          previous: bestPrevious,
          totalCost: bestCost,
        });
      }
    }

    if (nextStates.length === 0) return null;
    states = nextStates
      .sort((a, b) => a.totalCost - b.totalCost)
      .slice(0, beamWidth);
  }

  const best = states.sort((a, b) => a.totalCost - b.totalCost)[0];
  if (!best) return null;

  return {
    beamWidth,
    candidates: traceGlobalAlignmentState(best),
    radius,
    sampleCount: samples.length,
  };
}

function formatGlobalAlignmentCandidate(candidate: GlobalAlignmentCandidate): string {
  const timeText = candidate.timeDiff == null
    ? "dt ?"
    : `dt ${formatSignedNumber(Math.round(candidate.timeDiff))}ms`;

  return (
    `seq ${candidate.sample.sequence} t=${Math.round(candidate.sample.time)} `
    + `cap#${candidate.sample.total} -> sim#${candidate.ordinal} `
    + `shift ${formatSignedNumber(candidate.ordinalShift)} ${timeText} `
    + `diff ${formatDiff(candidate.diff)} visible ${formatVisibleDiff(candidate.diff)} `
    + `hidden ${formatHiddenStableDiff(candidate.diff)} `
    + `dist ${candidate.fullDistance}/${candidate.visibleDistance}/${candidate.hiddenDistance}`
  );
}

function formatFirstGlobalAlignmentIssue(
  label: string,
  candidate: GlobalAlignmentCandidate | undefined,
): string {
  if (!candidate) return `${label} none`;
  return `${label} seq ${candidate.sample.sequence} cap#${candidate.sample.total} sim#${candidate.ordinal} `
    + `diff ${formatDiff(candidate.diff)} shift ${formatSignedNumber(candidate.ordinalShift)}`;
}

function printGlobalAlignment(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): void {
  if (!options.globalAlignment) return;

  const minTotal = options.intervalMinTotal ?? 1;
  const maxTotal = options.intervalMaxTotal ?? Number.POSITIVE_INFINITY;
  const path = buildGlobalAlignmentPath(options, capture, simulation);

  console.log(`\nGlobal capture alignment${Number.isFinite(maxTotal) ? ` totals ${minTotal}-${maxTotal}` : ` from total ${minTotal}`}:`);

  if (!path) {
    console.log("  No capture samples available in the selected range.");
    return;
  }

  const candidates = path.candidates;
  const exactFull = candidates.filter((candidate) => candidate.fullDistance === 0).length;
  const exactVisible = candidates.filter((candidate) => candidate.visibleDistance === 0).length;
  const maxFullDistance = Math.max(...candidates.map((candidate) => candidate.fullDistance));
  const maxVisibleDistance = Math.max(...candidates.map((candidate) => candidate.visibleDistance));
  const maxHiddenDistance = Math.max(...candidates.map((candidate) => candidate.hiddenDistance));
  const maxAbsShift = Math.max(...candidates.map((candidate) => Math.abs(candidate.ordinalShift)));
  const finalCandidate = candidates[candidates.length - 1];
  const firstFullResidual = candidates.find((candidate) => candidate.fullDistance > 0);
  const firstVisibleResidual = candidates.find((candidate) => candidate.visibleDistance > 0);
  const firstShift = candidates.find((candidate) => candidate.ordinalShift !== 0);

  console.log(
    `  samples ${path.sampleCount}, radius +/-${path.radius}, beam ${path.beamWidth}; `
    + `exact full ${exactFull}/${path.sampleCount}, exact visible ${exactVisible}/${path.sampleCount}`,
  );
  console.log(
    `  max distance full/visible/hidden ${maxFullDistance}/${maxVisibleDistance}/${maxHiddenDistance}; `
    + `max abs shift ${maxAbsShift}`,
  );
  console.log(
    `  first issues: ${formatFirstGlobalAlignmentIssue("full", firstFullResidual)}; `
    + `${formatFirstGlobalAlignmentIssue("visible", firstVisibleResidual)}; `
    + `${formatFirstGlobalAlignmentIssue("shift", firstShift)}`,
  );
  console.log(`  final path row: ${formatGlobalAlignmentCandidate(finalCandidate)}`);

  let printed = 0;
  let previous: GlobalAlignmentCandidate | null = null;
  console.log("  path residual/shift changes:");

  for (const candidate of candidates) {
    const diffChanged = !previous || !countsEqual(candidate.diff, previous.diff);
    const shiftChanged = !previous || candidate.ordinalShift !== previous.ordinalShift;
    const fullStarted = candidate.fullDistance > 0 && (!previous || previous.fullDistance === 0);
    const visibleStarted = candidate.visibleDistance > 0 && (!previous || previous.visibleDistance === 0);
    const distanceChanged = previous
      ? candidate.fullDistance !== previous.fullDistance || candidate.visibleDistance !== previous.visibleDistance
      : true;
    const shouldPrint = !previous
      || diffChanged
      || shiftChanged
      || fullStarted
      || visibleStarted
      || distanceChanged;

    if (shouldPrint) {
      console.log(`    ${formatGlobalAlignmentCandidate(candidate)}`);
      if (candidate.fullDistance > 0 || candidate.visibleDistance > 0) {
        console.log(`      ${formatCompactSimEvent(simulation, Math.max(1, candidate.ordinal))}`);
      }

      printed++;
      if (printed >= options.limit) break;
    }

    previous = candidate;
  }

  if (printed === 0) {
    console.log("    No residual or shift changes on the chosen path.");
  } else if (printed >= options.limit) {
    console.log(`    ... stopped after ${options.limit} rows`);
  }
}

interface StableFeatureProbeContext {
  event: SimJudgementEvent;
  note: SimulationResult["notes"][number];
  ordinal: number;
  state: SimulationResult["noteStates"][number] | undefined;
  to: Judgment;
}

interface StableFeaturePredicate {
  label: string;
  matches: (context: StableFeatureProbeContext) => boolean;
}

interface StableFeatureProbeResult {
  changes: ScoreOverrideCandidate[];
  counts: ReplayHitCounts;
  diff: ReplayHitCounts;
  distance: number;
  improvement: number;
  label: string;
  needed: number | null;
  transition: StableFeatureTransition;
  visibleDistance: number;
  visibleImprovement: number;
}

interface StableFeatureGroupCombo {
  changes: ScoreOverrideCandidate[];
  diff: ReplayHitCounts;
  distance: number;
  ordinalFitDistance: number;
  ordinalFitImprovement: number;
  rows: StableFeatureProbeResult[];
  scoreDiff: number | null;
  scoreText: string;
  timeFitDistance: number;
  timeFitImprovement: number;
  visibleDistance: number;
}

interface StableFeatureTransition {
  from: Judgment;
  label: string;
  to: Judgment;
}

function getStableFeatureOffset(
  state: StableFeatureProbeContext["state"],
  key: "head" | "tail",
  scoring: boolean,
): number {
  if (key === "head") return scoring ? state?.scoringHeadOffsetMs ?? state?.headOffsetMs ?? 0 : state?.headOffsetMs ?? 0;
  return scoring ? state?.scoringTailOffsetMs ?? state?.tailOffsetMs ?? 0 : state?.tailOffsetMs ?? 0;
}

function roundedStableFeatureOffset(
  state: StableFeatureProbeContext["state"],
  key: "head" | "tail",
  scoring: boolean,
): number {
  return Math.round(getStableFeatureOffset(state, key, scoring));
}

function stableFeatureCombinedError(state: StableFeatureProbeContext["state"], scoring: boolean): number {
  return Math.abs(roundedStableFeatureOffset(state, "head", scoring))
    + Math.abs(roundedStableFeatureOffset(state, "tail", scoring));
}

function stableFeatureHasBodyBreak(state: StableFeatureProbeContext["state"]): boolean {
  return (state?.bodyBreakTimes?.length ?? 0) > 0;
}

function stableFeaturePossibleIncludesTarget(context: StableFeatureProbeContext): boolean {
  return context.event.possibleJudgments?.includes(context.to) ?? false;
}

function stableFeatureInRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function stableFeatureSingleHeldSegment(context: StableFeatureProbeContext) {
  const segment = context.state?.heldSegments?.[0];
  return context.state?.heldSegments?.length === 1 && segment ? segment : null;
}

function buildStableFeaturePredicates(simulation: SimulationResult): StableFeaturePredicate[] {
  const perfect = Math.floor(simulation.windows.perfect);
  const great = Math.floor(simulation.windows.great);
  const good = Math.floor(simulation.windows.good);
  const ok = Math.floor(simulation.windows.ok);
  const meh = Math.floor(simulation.windows.meh);
  const holdCombined = (context: StableFeatureProbeContext) => context.event.part === "hold-combined";
  const bodyBreak = (context: StableFeatureProbeContext) => stableFeatureHasBodyBreak(context.state);
  const noBodyBreak = (context: StableFeatureProbeContext) => !stableFeatureHasBodyBreak(context.state);
  const scoringHeadAbs = (context: StableFeatureProbeContext) => Math.abs(roundedStableFeatureOffset(context.state, "head", true));
  const scoringTail = (context: StableFeatureProbeContext) => roundedStableFeatureOffset(context.state, "tail", true);
  const scoringTailAbs = (context: StableFeatureProbeContext) => Math.abs(scoringTail(context));
  const rawTail = (context: StableFeatureProbeContext) => roundedStableFeatureOffset(context.state, "tail", false);
  const combined = (context: StableFeatureProbeContext) => stableFeatureCombinedError(context.state, true);
  const longNoteDuration = (context: StableFeatureProbeContext) => context.note.endTime - context.note.time;
  const explicitHold = (context: StableFeatureProbeContext) => holdCombined(context) && stableFeaturePossibleIncludesTarget(context);
  const singleHeld = (context: StableFeatureProbeContext) => holdCombined(context) && stableFeatureSingleHeldSegment(context) != null;
  const releasedBeforeTail = (context: StableFeatureProbeContext) => (
    holdCombined(context)
    && context.state?.releaseTime != null
    && context.state.releaseTime < context.note.endTime
  );
  const singleHeldReleasedBeforeTail = (context: StableFeatureProbeContext) => singleHeld(context) && releasedBeforeTail(context);
  const maxButReleasedBeforeTail = (context: StableFeatureProbeContext) => (
    singleHeldReleasedBeforeTail(context)
    && context.event.judgment === 1
    && scoringHeadAbs(context) <= perfect
    && scoringTailAbs(context) <= perfect
  );

  return [
    { label: "any", matches: () => true },
    { label: "explicit poss", matches: stableFeaturePossibleIncludesTarget },
    { label: "hold combined", matches: holdCombined },
    { label: "hold explicit poss", matches: explicitHold },
    { label: "hold no body-break", matches: (context) => holdCombined(context) && noBodyBreak(context) },
    { label: "hold no body-break explicit", matches: (context) => explicitHold(context) && noBodyBreak(context) },
    { label: "hold body-break", matches: (context) => holdCombined(context) && bodyBreak(context) },
    { label: "hold body-break explicit", matches: (context) => explicitHold(context) && bodyBreak(context) },
    { label: "short LN <= meh", matches: (context) => holdCombined(context) && longNoteDuration(context) <= meh },
    { label: "long LN > meh", matches: (context) => holdCombined(context) && longNoteDuration(context) > meh },
    { label: "single held segment", matches: singleHeld },
    { label: "missed inside consumed segment", matches: (context) => Boolean(context.state?.stableMissedInsideConsumedSegment) },
    { label: "matched previous tail segment", matches: (context) => Boolean(context.state?.stableMatchedPreviousTailSegment) },
    { label: "released before tail", matches: releasedBeforeTail },
    { label: "single held released before tail", matches: singleHeldReleasedBeforeTail },
    { label: "single held MAX released before tail", matches: maxButReleasedBeforeTail },
    { label: "short single held released before tail", matches: (context) => singleHeldReleasedBeforeTail(context) && longNoteDuration(context) <= meh },
    { label: "long single held released before tail", matches: (context) => singleHeldReleasedBeforeTail(context) && longNoteDuration(context) > meh },
    { label: "head perfect, combined past MAX", matches: (context) => holdCombined(context) && scoringHeadAbs(context) <= perfect && combined(context) > perfect * 2.4 },
    { label: "head great, combined past 300", matches: (context) => holdCombined(context) && scoringHeadAbs(context) <= great && combined(context) > great * 2.2 },
    { label: "tail outside perfect", matches: (context) => holdCombined(context) && scoringTailAbs(context) > perfect },
    { label: "tail outside great", matches: (context) => holdCombined(context) && scoringTailAbs(context) > great },
    { label: "tail outside good", matches: (context) => holdCombined(context) && scoringTailAbs(context) > good },
    { label: "tail late OK..meh", matches: (context) => holdCombined(context) && stableFeatureInRange(scoringTail(context), ok + 1, meh) },
    { label: "tail late 120..132", matches: (context) => holdCombined(context) && stableFeatureInRange(scoringTail(context), 120, 132) },
    { label: "tail late 133..146", matches: (context) => holdCombined(context) && stableFeatureInRange(scoringTail(context), 133, 146) },
    { label: "tail early past good", matches: (context) => holdCombined(context) && scoringTail(context) < -good },
    { label: "raw/scored tail differs", matches: (context) => holdCombined(context) && Math.abs(rawTail(context) - scoringTail(context)) > 1 },
  ];
}

function buildStableFeatureTransitions(): StableFeatureTransition[] {
  const judgments: Judgment[] = [1, 2, 3, 4, 5, 6];
  const transitions: StableFeatureTransition[] = [];

  for (const from of judgments) {
    for (const to of judgments) {
      if (from === to) continue;
      transitions.push({
        from,
        label: `${formatJudgment(from)}->${formatJudgment(to)}`,
        to,
      });
    }
  }

  return transitions;
}

function stableFeatureNeededCount(
  currentCounts: ReplayHitCounts,
  targetCounts: ReplayHitCounts,
  transition: StableFeatureTransition,
): number | null {
  const currentArray = replayHitCountsToArray(currentCounts);
  const targetArray = replayHitCountsToArray(targetCounts);
  const surplus = currentArray[transition.from] - targetArray[transition.from];
  const deficit = targetArray[transition.to] - currentArray[transition.to];

  if (surplus <= 0 || deficit <= 0) return null;
  return Math.min(surplus, deficit);
}

function buildStableFeatureProbeResult(
  simulation: SimulationResult,
  target: ComparisonTarget,
  currentDiff: ReplayHitCounts,
  currentCounts: ReplayHitCounts,
  transition: StableFeatureTransition,
  label: string,
  changes: ScoreOverrideCandidate[],
): StableFeatureProbeResult {
  const overrides = new Map<SimReplayEvent, Judgment>();
  for (const change of changes) overrides.set(change.event, change.to);

  const counts = countsWithJudgmentOverrides(simulation, overrides);
  const diff = diffReplayHitCounts(counts, target.counts);
  const currentDistance = countDiffDistance(currentDiff);
  const currentVisibleDistance = visibleDiffDistance(currentDiff);

  return {
    changes,
    counts,
    diff,
    distance: countDiffDistance(diff),
    improvement: currentDistance - countDiffDistance(diff),
    label,
    needed: stableFeatureNeededCount(currentCounts, target.counts, transition),
    transition,
    visibleDistance: visibleDiffDistance(diff),
    visibleImprovement: currentVisibleDistance - visibleDiffDistance(diff),
  };
}

function buildStableFeatureProbe(
  simulation: SimulationResult,
  target: ComparisonTarget,
  currentDiff: ReplayHitCounts,
  currentCounts: ReplayHitCounts,
  transition: StableFeatureTransition,
  predicate: StableFeaturePredicate,
): StableFeatureProbeResult | null {
  const changes: ScoreOverrideCandidate[] = [];

  for (let index = 0; index < simulation.events.length; index++) {
    const event = simulation.events[index];
    if (event.judgment !== transition.from) continue;

    const context: StableFeatureProbeContext = {
      event,
      note: simulation.notes[event.noteIndex],
      ordinal: index + 1,
      state: simulation.noteStates[event.noteIndex],
      to: transition.to,
    };
    if (!predicate.matches(context)) continue;

    changes.push({
      event,
      from: transition.from,
      ordinal: index + 1,
      to: transition.to,
    });
  }

  if (changes.length === 0) return null;

  return buildStableFeatureProbeResult(
    simulation,
    target,
    currentDiff,
    currentCounts,
    transition,
    `${transition.label} / ${predicate.label}`,
    changes,
  );
}

function stableFeatureProbeSort(a: StableFeatureProbeResult, b: StableFeatureProbeResult): number {
  const aNeededMiss = a.needed == null ? Number.POSITIVE_INFINITY : Math.abs(a.changes.length - a.needed);
  const bNeededMiss = b.needed == null ? Number.POSITIVE_INFINITY : Math.abs(b.changes.length - b.needed);

  return b.improvement - a.improvement
    || a.distance - b.distance
    || b.visibleImprovement - a.visibleImprovement
    || a.visibleDistance - b.visibleDistance
    || aNeededMiss - bNeededMiss
    || a.changes.length - b.changes.length
    || a.label.localeCompare(b.label);
}

function stableFeatureGroupSort(a: StableFeatureProbeResult, b: StableFeatureProbeResult): number {
  const aNeededMiss = a.needed == null ? Number.POSITIVE_INFINITY : Math.abs(a.changes.length - a.needed);
  const bNeededMiss = b.needed == null ? Number.POSITIVE_INFINITY : Math.abs(b.changes.length - b.needed);

  return aNeededMiss - bNeededMiss
    || a.distance - b.distance
    || a.visibleDistance - b.visibleDistance
    || b.improvement - a.improvement
    || a.changes.length - b.changes.length
    || a.label.localeCompare(b.label);
}

function stableFeatureOffsetTier(value: number, simulation: SimulationResult): string {
  const absolute = Math.abs(Math.round(value));
  if (absolute <= Math.floor(simulation.windows.perfect)) return "perfect";
  if (absolute <= Math.floor(simulation.windows.great)) return "great";
  if (absolute <= Math.floor(simulation.windows.good)) return "good";
  if (absolute <= Math.floor(simulation.windows.ok)) return "ok";
  if (absolute <= Math.floor(simulation.windows.meh)) return "meh";
  if (absolute <= Math.floor(simulation.windows.miss)) return "miss";
  return "outside";
}

function stableFeatureSignedBand(value: number, width = 10): string {
  const rounded = Math.round(value);
  const start = Math.floor(rounded / width) * width;
  const end = start + width - 1;
  return `${start}..${end}`;
}

function stableFeatureDurationBucket(duration: number, simulation: SimulationResult): string {
  const meh = Math.floor(simulation.windows.meh);
  if (duration <= 0) return "tap";
  if (duration <= meh / 2) return "short";
  if (duration <= meh) return "meh";
  if (duration <= meh * 2) return "2meh";
  if (duration <= meh * 4) return "4meh";
  return "long";
}

function buildStableFeatureGroupKeys(
  simulation: SimulationResult,
  event: SimJudgementEvent,
): string[] {
  const note = simulation.notes[event.noteIndex];
  const state = simulation.noteStates[event.noteIndex];
  const bodyBreak = stableFeatureHasBodyBreak(state) ? "bb" : "no-bb";
  const poss = event.possibleJudgments?.join("") || "-";
  const duration = stableFeatureDurationBucket(note.endTime - note.time, simulation);
  const head = roundedStableFeatureOffset(state, "head", true);
  const tail = roundedStableFeatureOffset(state, "tail", true);
  const rawTail = roundedStableFeatureOffset(state, "tail", false);
  const headTier = stableFeatureOffsetTier(head, simulation);
  const tailTier = stableFeatureOffsetTier(tail, simulation);
  const headBand = stableFeatureSignedBand(head);
  const tailBand = stableFeatureSignedBand(tail);
  const rawTailBand = stableFeatureSignedBand(rawTail);
  const stableFlags = [
    state?.stableHeldOkTimeout ? "held-ok-timeout" : "",
    state?.stableTailWasHeldAtJudgement ? "held-tail" : "",
    state?.stableBarelyCrossedTailOnTimeout ? "barely-crossed-tail" : "",
    state?.stableLateStartReleasePastOk ? "late-start-past-ok" : "",
    state?.stableMatchedPreviousTailSegment ? "matched-previous-tail-segment" : "",
    state?.stableMissedInsideConsumedSegment ? "missed-inside-consumed-segment" : "",
    state?.stableConsumedHeldSegmentAtTimeout ? "consumed-timeout-segment" : "",
  ].filter(Boolean);
  const flagKeys = stableFlags.length > 0
    ? ["flag=any", ...stableFlags.map((flag) => `flag=${flag}`), `flags=${stableFlags.join("+")}`]
    : ["flag=none"];
  const part = `part=${event.part}`;
  const base = `${part};${bodyBreak}`;

  const keys = [
    `${part};poss=${poss}`,
    `${base};poss=${poss}`,
    `${base};duration=${duration}`,
    `${base};tier=${headTier}/${tailTier}`,
    `${base};tail=${tailBand}`,
    `${base};rawTail=${rawTailBand}`,
    `${base};poss=${poss};tail=${tailBand}`,
    `${base};poss=${poss};tier=${headTier}/${tailTier}`,
    `${base};duration=${duration};tier=${headTier}/${tailTier}`,
    `${base};column=${event.column};poss=${poss}`,
    `${base};column=${event.column};tail=${tailBand}`,
    `${base};poss=${poss};head=${headBand};tail=${tailBand}`,
  ];

  for (const flag of flagKeys) {
    keys.push(
      `${base};${flag}`,
      `${base};poss=${poss};${flag}`,
      `${base};duration=${duration};${flag}`,
      `${base};poss=${poss};${flag};tier=${headTier}/${tailTier}`,
      `${base};poss=${poss};${flag};tail=${tailBand}`,
    );
  }

  return keys;
}

function buildStableFeatureGroupRows(
  simulation: SimulationResult,
  target: ComparisonTarget,
  currentDiff: ReplayHitCounts,
  currentCounts: ReplayHitCounts,
  startOrdinal: number,
): StableFeatureProbeResult[] {
  const transitions = buildStableFeatureTransitions()
    .filter((transition) => stableFeatureNeededCount(currentCounts, target.counts, transition) != null);
  const rows: StableFeatureProbeResult[] = [];

  for (const transition of transitions) {
    const groups = new Map<string, ScoreOverrideCandidate[]>();

    for (let index = Math.max(0, startOrdinal - 1); index < simulation.events.length; index++) {
      const event = simulation.events[index];
      if (event.judgment !== transition.from) continue;

      const candidate: ScoreOverrideCandidate = {
        event,
        from: transition.from,
        ordinal: index + 1,
        to: transition.to,
      };

      for (const key of buildStableFeatureGroupKeys(simulation, event)) {
        const label = `${transition.label} / ${key}`;
        const group = groups.get(label);
        if (group) group.push(candidate);
        else groups.set(label, [candidate]);
      }
    }

    for (const [label, changes] of groups) {
      rows.push(buildStableFeatureProbeResult(
        simulation,
        target,
        currentDiff,
        currentCounts,
        transition,
        label,
        changes,
      ));
    }
  }

  return rows;
}

function formatStableFeatureScoreDiff(
  capture: CaptureSegment,
  simulation: SimulationResult,
  baseScore: number | null,
  changes: ScoreOverrideCandidate[],
): string {
  const finalCapture = capture.samples[capture.samples.length - 1];
  if (simulation.accuracyMode !== "stable" || baseScore == null || finalCapture.score == null) return "";

  const overrides = new Map<SimReplayEvent, Judgment>();
  for (const change of changes) overrides.set(change.event, change.to);

  const trace = buildStableManiaScoreTrace(simulation, true, false, "event-time", overrides);
  const score = trace.byOrdinal.at(-1)?.scoreFloor;
  if (score == null) return "";

  const baseDiff = baseScore - finalCapture.score;
  const nextDiff = score - finalCapture.score;
  return ` scoreDiffApprox ${formatSignedNumber(baseDiff)}->${formatSignedNumber(nextDiff)}`;
}

function printStableFeatureProbeRows(
  title: string,
  rows: StableFeatureProbeResult[],
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  baseScore: number | null,
): void {
  console.log(`  ${title}:`);
  if (rows.length === 0) {
    console.log("    none");
    return;
  }

  for (const row of rows.slice(0, options.limit)) {
    const needText = row.needed == null
      ? ""
      : ` need ${row.needed}${row.changes.length === row.needed ? " exact-count" : ""}`;
    const scoreText = formatStableFeatureScoreDiff(capture, simulation, baseScore, row.changes);
    console.log(
      `    ${row.label}: changes ${row.changes.length}${needText} `
      + `diff ${formatDiff(row.diff)} visible ${formatVisibleDiff(row.diff)} `
      + `distance ${row.distance}/${row.visibleDistance} `
      + `improve ${formatSignedNumber(row.improvement)}/${formatSignedNumber(row.visibleImprovement)}`
      + scoreText,
    );

    for (const change of row.changes.slice(0, Math.min(4, options.limit))) {
      console.log(
        `      #${String(change.ordinal).padStart(5)} `
        + `${formatJudgment(change.from)}->${formatJudgment(change.to)} `
        + formatCompactSimEvent(simulation, change.ordinal),
      );
    }
    if (row.changes.length > Math.min(4, options.limit)) {
      console.log(`      ... ${row.changes.length - Math.min(4, options.limit)} more changes omitted`);
    }
  }

  if (rows.length > options.limit) {
    console.log(`    ... ${rows.length - options.limit} more probes omitted`);
  }
}

function stableFeatureTransitionKey(transition: StableFeatureTransition): string {
  return `${transition.from}->${transition.to}`;
}

function buildStableFeatureResidualTransitions(
  currentCounts: ReplayHitCounts,
  targetCounts: ReplayHitCounts,
): StableFeatureTransition[] {
  return buildStableFeatureTransitions()
    .filter((transition) => stableFeatureNeededCount(currentCounts, targetCounts, transition) != null)
    .sort((a, b) => stableFeatureTransitionKey(a).localeCompare(stableFeatureTransitionKey(b)));
}

function buildStableFeatureGroupCombo(
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
  baseScore: number | null,
  baseOrdinalFitDistance: number,
  baseTimeFitDistance: number,
  startOrdinal: number,
  rows: StableFeatureProbeResult[],
): StableFeatureGroupCombo {
  const changes = rows.flatMap((row) => row.changes);
  const overrides = new Map<SimReplayEvent, Judgment>();
  for (const change of changes) overrides.set(change.event, change.to);

  const counts = countsWithJudgmentOverrides(simulation, overrides);
  const diff = diffReplayHitCounts(counts, target.counts);
  const finalCapture = capture.samples[capture.samples.length - 1];
  let scoreDiff: number | null = null;
  let scoreText = "";

  if (simulation.accuracyMode === "stable" && baseScore != null && finalCapture.score != null) {
    const trace = buildStableManiaScoreTrace(simulation, true, false, "event-time", overrides);
    const score = trace.byOrdinal.at(-1)?.scoreFloor;
    if (score != null) {
      scoreDiff = score - finalCapture.score;
      scoreText = ` scoreDiffApprox ${formatSignedNumber(baseScore - finalCapture.score)}->${formatSignedNumber(scoreDiff)}`;
    }
  }

  return {
    changes,
    diff,
    distance: countDiffDistance(diff),
    ordinalFitDistance: stableFeatureOverrideFitDistance(capture, simulation, changes, startOrdinal, "ordinal"),
    ordinalFitImprovement: baseOrdinalFitDistance - stableFeatureOverrideFitDistance(capture, simulation, changes, startOrdinal, "ordinal"),
    rows,
    scoreDiff,
    scoreText,
    timeFitDistance: stableFeatureOverrideFitDistance(capture, simulation, changes, startOrdinal, "time"),
    timeFitImprovement: baseTimeFitDistance - stableFeatureOverrideFitDistance(capture, simulation, changes, startOrdinal, "time"),
    visibleDistance: visibleDiffDistance(diff),
  };
}

function stableFeatureOverrideFitDistance(
  capture: CaptureSegment,
  simulation: SimulationResult,
  changes: ScoreOverrideCandidate[],
  startOrdinal: number,
  mode: "ordinal" | "time",
): number {
  const deltas = changes.map((change) => ({
    delta: judgmentChangeDelta(change.from, change.to),
    ordinal: change.ordinal,
    time: change.event.time,
  }));
  let total = 0;

  for (const sample of capture.samples) {
    if (sample.total < startOrdinal) continue;

    const baseDiff = mode === "ordinal"
      ? diffReplayHitCounts(countsAtOrdinal(simulation, sample.total), sample.counts)
      : diffReplayHitCounts(countsAtTime(simulation.events, sample.time), sample.counts);
    let adjusted = baseDiff;

    for (const change of deltas) {
      const applies = mode === "ordinal"
        ? change.ordinal <= sample.total
        : change.time <= sample.time;
      if (applies) adjusted = addCounts(adjusted, change.delta);
    }

    total += countDiffDistance(adjusted) + visibleDiffDistance(adjusted);
  }

  return total;
}

function buildStableFeatureGroupCombos(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
  currentCounts: ReplayHitCounts,
  baseScore: number | null,
  signatureRows: StableFeatureProbeResult[],
): StableFeatureGroupCombo[] {
  const transitions = buildStableFeatureResidualTransitions(currentCounts, target.counts);
  if (transitions.length === 0 || transitions.length > 4) return [];

  const startOrdinal = Math.max(1, options.intervalMinTotal ?? 1);
  const baseOrdinalFitDistance = stableFeatureOverrideFitDistance(capture, simulation, [], startOrdinal, "ordinal");
  const baseTimeFitDistance = stableFeatureOverrideFitDistance(capture, simulation, [], startOrdinal, "time");
  const perTransitionLimit = Math.max(4, Math.min(8, options.limit));
  const groupedRows = transitions.map((transition) => {
    const key = stableFeatureTransitionKey(transition);
    return signatureRows
      .filter((row) => stableFeatureTransitionKey(row.transition) === key && row.needed != null && row.changes.length === row.needed)
      .sort(stableFeatureGroupSort)
      .slice(0, perTransitionLimit);
  });

  if (groupedRows.some((rows) => rows.length === 0)) return [];

  const rowSets: StableFeatureProbeResult[][] = [];
  const current: StableFeatureProbeResult[] = [];
  const currentOrdinals = new Set<number>();
  const maxCombos = Math.max(128, Math.min(1024, options.limit * 64));

  function visit(groupIndex: number): void {
    if (rowSets.length >= maxCombos) return;
    if (groupIndex === groupedRows.length) {
      rowSets.push([...current]);
      return;
    }

    for (const row of groupedRows[groupIndex]) {
      const rowOrdinals = row.changes.map((change) => change.ordinal);
      if (new Set(rowOrdinals).size !== rowOrdinals.length) continue;
      if (rowOrdinals.some((ordinal) => currentOrdinals.has(ordinal))) continue;
      for (const ordinal of rowOrdinals) currentOrdinals.add(ordinal);
      current.push(row);
      visit(groupIndex + 1);
      current.pop();
      for (const ordinal of rowOrdinals) currentOrdinals.delete(ordinal);
    }
  }

  visit(0);

  return rowSets
    .map((rows) => buildStableFeatureGroupCombo(
      capture,
      simulation,
      target,
      baseScore,
      baseOrdinalFitDistance,
      baseTimeFitDistance,
      startOrdinal,
      rows,
    ))
    .sort((a, b) => a.distance - b.distance
      || a.visibleDistance - b.visibleDistance
      || b.ordinalFitImprovement - a.ordinalFitImprovement
      || b.timeFitImprovement - a.timeFitImprovement
      || (a.scoreDiff == null ? Number.POSITIVE_INFINITY : Math.abs(a.scoreDiff))
        - (b.scoreDiff == null ? Number.POSITIVE_INFINITY : Math.abs(b.scoreDiff))
      || a.changes.length - b.changes.length
      || a.rows.map((row) => row.label).join("|").localeCompare(b.rows.map((row) => row.label).join("|")));
}

function printStableFeatureGroupCombos(
  options: CliOptions,
  combos: StableFeatureGroupCombo[],
  simulation: SimulationResult,
): void {
  console.log("  residual exact group combinations:");
  if (combos.length === 0) {
    console.log("    none");
    return;
  }

  for (const combo of combos.slice(0, options.limit)) {
    console.log(
      `    changes ${combo.changes.length} diff ${formatDiff(combo.diff)} `
      + `visible ${formatVisibleDiff(combo.diff)} distance ${combo.distance}/${combo.visibleDistance}`
      + ` fitImprove ordinal/time ${formatSignedNumber(combo.ordinalFitImprovement)}/${formatSignedNumber(combo.timeFitImprovement)}`
      + combo.scoreText,
    );

    for (const row of combo.rows) {
      console.log(`      ${row.label}: changes ${row.changes.length}`);
      for (const change of row.changes.slice(0, 3)) {
        console.log(
          `        #${String(change.ordinal).padStart(5)} `
          + `${formatJudgment(change.from)}->${formatJudgment(change.to)} `
          + formatCompactSimEvent(simulation, change.ordinal),
        );
      }
      if (row.changes.length > 3) {
        console.log(`        ... ${row.changes.length - 3} more changes omitted`);
      }
    }
  }

  if (combos.length > options.limit) {
    console.log(`    ... ${combos.length - options.limit} more combinations omitted`);
  }
}

function printStableFeatureProbes(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.featureProbes) return;

  const currentCounts = countReplayJudgements(simulation.events);
  const currentDiff = diffReplayHitCounts(currentCounts, target.counts);
  const baseTrace = simulation.accuracyMode === "stable"
    ? buildStableManiaScoreTrace(simulation, true, false, "event-time")
    : null;
  const baseScore = baseTrace?.byOrdinal.at(-1)?.scoreFloor ?? null;
  const predicates = buildStableFeaturePredicates(simulation);
  const transitions = buildStableFeatureTransitions();
  const results: StableFeatureProbeResult[] = [];

  for (const transition of transitions) {
    for (const predicate of predicates) {
      const result = buildStableFeatureProbe(
        simulation,
        target,
        currentDiff,
        currentCounts,
        transition,
        predicate,
      );
      if (result) results.push(result);
    }
  }

  const residualRows = results
    .filter((row) => row.needed != null)
    .sort(stableFeatureProbeSort);
  const signatureRows = buildStableFeatureGroupRows(
    simulation,
    target,
    currentDiff,
    currentCounts,
    Math.max(1, options.intervalMinTotal ?? 1),
  ).sort(stableFeatureGroupSort);
  const signatureCombos = buildStableFeatureGroupCombos(
    options,
    capture,
    simulation,
    target,
    currentCounts,
    baseScore,
    signatureRows,
  );
  const closestRows = [...results]
    .sort((a, b) => a.distance - b.distance
      || a.visibleDistance - b.visibleDistance
      || b.improvement - a.improvement
      || a.changes.length - b.changes.length
      || a.label.localeCompare(b.label));

  console.log(`\nStable feature probes against ${target.label}:`);
  console.log(
    `  current counts ${formatCounts(currentCounts)} diff ${formatDiff(currentDiff)} `
    + `visible ${formatVisibleDiff(currentDiff)} distance ${countDiffDistance(currentDiff)}/${visibleDiffDistance(currentDiff)}`,
  );

  printStableFeatureProbeRows(
    "residual-directed probes",
    residualRows,
    options,
    capture,
    simulation,
    baseScore,
  );
  printStableFeatureProbeRows(
    "residual signature groups",
    signatureRows,
    options,
    capture,
    simulation,
    baseScore,
  );
  printStableFeatureGroupCombos(options, signatureCombos, simulation);
  printStableFeatureProbeRows(
    "closest changed probes",
    closestRows,
    options,
    capture,
    simulation,
    baseScore,
  );
}

interface StableRuleProbe {
  changes: ScoreOverrideCandidate[];
  counts: ReplayHitCounts;
  diff: ReplayHitCounts;
  label: string;
}

function roundedAbs(value: number | undefined): number {
  return Math.abs(Math.round(value ?? 0));
}

function buildStableRuleProbe(
  simulation: SimulationResult,
  target: ComparisonTarget,
  label: string,
  getOverride: (event: SimJudgementEvent) => Judgment | null,
): StableRuleProbe {
  const overrides = new Map<SimReplayEvent, Judgment>();
  const changes: ScoreOverrideCandidate[] = [];

  for (let index = 0; index < simulation.events.length; index++) {
    const event = simulation.events[index];
    if (event.judgment == null) continue;

    const nextJudgment = getOverride(event);
    if (nextJudgment == null || nextJudgment === event.judgment) continue;

    overrides.set(event, nextJudgment);
    changes.push({
      event,
      from: event.judgment,
      ordinal: index + 1,
      to: nextJudgment,
    });
  }

  const counts = countsWithJudgmentOverrides(simulation, overrides);

  return {
    changes,
    counts,
    diff: diffReplayHitCounts(counts, target.counts),
    label,
  };
}

function formatRuleProbeChangeBuckets(changes: ScoreOverrideCandidate[]): string {
  const buckets = new Map<string, number>();

  for (const change of changes) {
    const key = `${change.from}->${change.to}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  if (buckets.size === 0) return "none";
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key} x${count}`)
    .join(", ");
}

function printStableRuleProbes(
  options: CliOptions,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.ruleProbes) return;

  const currentCounts = countReplayJudgements(simulation.events);
  const currentDiff = diffReplayHitCounts(currentCounts, target.counts);
  const good = Math.floor(simulation.windows.good);
  const great = Math.floor(simulation.windows.great);
  const perfect = Math.floor(simulation.windows.perfect);
  const ok = Math.floor(simulation.windows.ok);
  const meh = Math.floor(simulation.windows.meh);
  const holdCombined = (event: SimJudgementEvent) => event.part === "hold-combined";
  const stateFor = (event: SimJudgementEvent) => simulation.noteStates[event.noteIndex];
  const scoringHead = (event: SimJudgementEvent) => stateFor(event)?.scoringHeadOffsetMs ?? stateFor(event)?.headOffsetMs;
  const scoringTail = (event: SimJudgementEvent) => stateFor(event)?.scoringTailOffsetMs ?? stateFor(event)?.tailOffsetMs;
  const noBodyBreak = (event: SimJudgementEvent) => (stateFor(event)?.bodyBreakTimes?.length ?? 0) === 0;

  const probes = [
    buildStableRuleProbe(
      simulation,
      target,
      "held OK timeout as 100",
      (event) => holdCombined(event)
        && event.judgment === 3
        && stateFor(event)?.stableHeldOkTimeout
        ? 4
        : null,
    ),
    buildStableRuleProbe(
      simulation,
      target,
      "late held OK timeout remains 100",
      (event) => holdCombined(event)
        && event.judgment === 6
        && event.possibleJudgments?.includes(4)
        && noBodyBreak(event)
        && roundedAbs(scoringHead(event)) <= ok
        && roundedAbs(scoringTail(event)) <= meh
        ? 4
        : null,
    ),
    buildStableRuleProbe(
      simulation,
      target,
      "early Katu tail outside Good becomes 100",
      (event) => holdCombined(event)
        && event.judgment === 3
        && noBodyBreak(event)
        && Math.round(scoringTail(event) ?? 0) < -good
        ? 4
        : null,
    ),
    buildStableRuleProbe(
      simulation,
      target,
      "Katu tail outside Good becomes 100",
      (event) => holdCombined(event)
        && event.judgment === 3
        && noBodyBreak(event)
        && roundedAbs(scoringTail(event)) > good
        ? 4
        : null,
    ),
    buildStableRuleProbe(
      simulation,
      target,
      "300 tail outside Great becomes Katu",
      (event) => holdCombined(event)
        && event.judgment === 2
        && noBodyBreak(event)
        && roundedAbs(scoringTail(event)) > great
        ? 3
        : null,
    ),
    buildStableRuleProbe(
      simulation,
      target,
      "MAX tail outside Perfect becomes 300",
      (event) => holdCombined(event)
        && event.judgment === 1
        && noBodyBreak(event)
        && roundedAbs(scoringTail(event)) > perfect
        ? 2
        : null,
    ),
  ];

  console.log(`\nStable rule probes against ${target.label}:`);
  console.log(
    `  current counts ${formatCounts(currentCounts)} diff ${formatDiff(currentDiff)} `
    + `visible ${formatVisibleDiff(currentDiff)}`,
  );

  for (const probe of probes) {
    console.log(
      `  ${probe.label}: changes ${probe.changes.length} (${formatRuleProbeChangeBuckets(probe.changes)}) `
      + `counts ${formatCounts(probe.counts)} diff ${formatDiff(probe.diff)} `
      + `visible ${formatVisibleDiff(probe.diff)} distance ${countDiffDistance(probe.diff)}`,
    );

    for (const change of probe.changes.slice(0, options.limit)) {
      console.log(
        `    #${String(change.ordinal).padStart(5)} ${formatJudgment(change.from)}->${formatJudgment(change.to)} `
        + formatCompactSimEvent(simulation, change.ordinal),
      );
    }

    if (probe.changes.length > options.limit) {
      console.log(`    ... ${probe.changes.length - options.limit} more changes omitted`);
    }
  }
}

function printAlignmentCandidates(
  options: CliOptions,
  capture: CaptureSegment,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.alignmentCandidates) return;

  const startOrdinal = Math.max(1, options.intervalMinTotal ?? 1);
  const currentCounts = countReplayJudgements(simulation.events);
  const currentDiff = diffReplayHitCounts(currentCounts, target.counts);
  const currentArray = replayHitCountsToArray(currentCounts);
  const targetArray = replayHitCountsToArray(target.counts);
  const timeRows = buildTimeSampleDiffs(capture, simulation, startOrdinal);
  const ordinalRows = buildOrdinalSampleDiffs(capture, simulation, startOrdinal);
  const baseFinalDistance = countDiffDistance(currentDiff);
  let printedAny = false;

  console.log(`\nAlignment-ranked candidates against ${target.label}${startOrdinal > 1 ? ` from ordinal ${startOrdinal}` : ""}:`);
  console.log(`  current diff ${formatDiff(currentDiff)} distance ${baseFinalDistance}`);

  for (let currentJudgment = 1; currentJudgment <= 6; currentJudgment++) {
    const surplus = currentArray[currentJudgment] - targetArray[currentJudgment];
    if (surplus <= 0) continue;

    for (let targetJudgment = 1; targetJudgment <= 6; targetJudgment++) {
      const deficit = targetArray[targetJudgment] - currentArray[targetJudgment];
      if (deficit <= 0 || targetJudgment === currentJudgment) continue;

      const delta = judgmentChangeDelta(currentJudgment as Judgment, targetJudgment as Judgment);
      const finalImprovement = baseFinalDistance - countDiffDistance(addCounts(currentDiff, delta));
      const candidates = simulation.events
        .map((event, index) => ({ event, ordinal: index + 1 }))
        .filter(({ event, ordinal }) => ordinal >= startOrdinal && event.judgment === currentJudgment)
        .map(({ event, ordinal }) => {
          const possible = event.possibleJudgments ?? [];
          const explicit = possible.includes(targetJudgment as Judgment);
          const timeImprovement = getAlignmentImprovement(
            timeRows,
            delta,
            (sample) => sample.time >= event.time,
          );
          const ordinalImprovement = getAlignmentImprovement(
            ordinalRows,
            delta,
            (sample) => sample.total >= ordinal,
          );
          return {
            event,
            explicit,
            finalImprovement,
            ordinal,
            ordinalImprovement,
            timeImprovement,
          };
        })
        .sort((a, b) => {
          const aCombined = a.timeImprovement + a.ordinalImprovement;
          const bCombined = b.timeImprovement + b.ordinalImprovement;
          if (aCombined !== bCombined) return bCombined - aCombined;
          if (a.finalImprovement !== b.finalImprovement) return b.finalImprovement - a.finalImprovement;
          if (a.explicit !== b.explicit) return a.explicit ? -1 : 1;
          return a.ordinal - b.ordinal;
        })
        .slice(0, options.limit);

      printedAny = true;
      console.log(
        `  ${currentJudgment} -> ${targetJudgment} need up to ${Math.min(surplus, deficit)} `
        + `finalImprove ${formatSignedNumber(finalImprovement)} showing ${candidates.length}`,
      );

      for (const candidate of candidates) {
        console.log(
          `    #${String(candidate.ordinal).padStart(5)} `
          + `${candidate.explicit ? "explicit" : "outside"} `
          + `timeImprove ${formatSignedNumber(candidate.timeImprovement)} `
          + `ordinalImprove ${formatSignedNumber(candidate.ordinalImprovement)}`,
        );
        console.log(formatSimEvent(simulation, candidate.ordinal));
      }
    }
  }

  if (!printedAny) {
    console.log("  No direct surplus/deficit pairs found.");
  }
}

function printResolvedFinal(
  options: CliOptions,
  simulation: SimulationResult,
  target: ComparisonTarget,
): void {
  if (!options.resolveFinal) return;

  const startOrdinal = Math.max(1, options.intervalMinTotal ?? 1);
  const prefixEvents = simulation.events.slice(0, startOrdinal - 1);
  const currentCounts = countReplayJudgements(simulation.events);
  const currentDiff = diffReplayHitCounts(currentCounts, target.counts);
  const currentArray = replayHitCountsToArray(currentCounts);
  const targetArray = replayHitCountsToArray(target.counts);

  console.log(`\nDirect surplus candidates against ${target.label}${startOrdinal > 1 ? ` from ordinal ${startOrdinal}` : ""}:`);
  for (let currentJudgment = 1; currentJudgment <= 6; currentJudgment++) {
    const surplus = currentArray[currentJudgment] - targetArray[currentJudgment];
    if (surplus <= 0) continue;

    for (let targetJudgment = 1; targetJudgment <= 6; targetJudgment++) {
      const deficit = targetArray[targetJudgment] - currentArray[targetJudgment];
      if (deficit <= 0 || targetJudgment === currentJudgment) continue;

      const candidates = simulation.events
        .map((event, index) => ({ event, ordinal: index + 1 }))
        .filter(({ event, ordinal }) => ordinal >= startOrdinal && event.judgment === currentJudgment)
        .map(({ event, ordinal }) => {
          const possible = event.possibleJudgments ?? [];
          const explicit = possible.includes(targetJudgment as Judgment);
          return {
            cost: (explicit ? 0 : 1000)
              + Math.abs(targetJudgment - currentJudgment) * 100
              + (targetJudgment > currentJudgment ? -Math.abs(event.offsetMs) : Math.abs(event.offsetMs)),
            explicit,
            ordinal,
          };
        })
        .sort((a, b) => a.cost - b.cost || a.ordinal - b.ordinal)
        .slice(0, Math.min(options.limit, Math.max(surplus, deficit)));

      console.log(
        `  ${currentJudgment} -> ${targetJudgment} need up to ${Math.min(surplus, deficit)} `
        + `(current diff ${formatDiff(currentDiff)})`,
      );
      for (const candidate of candidates) {
        console.log(`    candidate #${String(candidate.ordinal).padStart(5)}${candidate.explicit ? " explicit" : " outside"}`);
        console.log(formatSimEvent(simulation, candidate.ordinal));
      }
    }
  }

  const targetCounts = startOrdinal > 1
    ? subtractCounts(target.counts, countReplayJudgements(prefixEvents))
    : target.counts;
  const hasNegativeTarget = Object.values(targetCounts).some((count) => count < 0);

  console.log(`\nFinal-count ambiguity resolver against ${target.label}${startOrdinal > 1 ? ` from ordinal ${startOrdinal}` : ""}: ${hasNegativeTarget ? "unresolved" : ""}`);
  if (hasNegativeTarget) {
    console.log(`  Frozen prefix already exceeds target: prefix ${formatCounts(countReplayJudgements(prefixEvents))} target ${formatCounts(target.counts)}`);
    return;
  }

  const suffixEvents = simulation.events.slice(startOrdinal - 1);
  const resolved = resolveReplayJudgementEvents(suffixEvents, targetCounts, {
    allowLegacyScoreReconciliation: true,
  });

  if (!hasNegativeTarget) {
    console.log(`  result ${resolved.resolved ? resolved.mode : "unresolved"}`);
  }
  if (!resolved.resolved) return;

  const resolvedCounts = countReplayJudgements([
    ...prefixEvents,
    ...resolved.events,
  ]);
  console.log(`  resolved counts ${formatCounts(resolvedCounts)} diff ${formatDiff(diffReplayHitCounts(resolvedCounts, target.counts))}`);

  let printed = 0;
  for (let index = 0; index < suffixEvents.length; index++) {
    const current = suffixEvents[index];
    const next = resolved.events[index];
    if (current.judgment === next.judgment) continue;

    const ordinal = startOrdinal + index;
    console.log(`  #${String(ordinal).padStart(5)} ${formatJudgment(current.judgment)} -> ${formatJudgment(next.judgment)}`);
    console.log(formatSimEvent(simulation, ordinal));

    printed++;
    if (printed >= options.limit) break;
  }

  if (printed === 0) {
    console.log("  No judgment changes were needed.");
  }
}

async function readRawCaptureSamplesAround(capturePath: string, centerTime: number, radiusMs: number): Promise<PlaySnapshot[]> {
  const text = await readFile(path.resolve(process.cwd(), capturePath), "utf8");
  const samples: PlaySnapshot[] = [];
  let lastSignature = "";

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sample = parseCaptureSnapshot(JSON.parse(line));
    if (!sample) continue;
    if (Math.abs(sample.time - centerTime) > radiusMs) continue;

    const signature = `${countsSignature(sample.counts)}:${sample.hitErrors.length}:${sample.time}`;
    if (signature === lastSignature) continue;
    samples.push(sample);
    lastSignature = signature;
  }

  return samples;
}

async function printDebugWindow(options: CliOptions, capture: CaptureSegment, simulation: SimulationResult): Promise<void> {
  if (options.aroundTotal == null && options.aroundTime == null) return;

  const context = options.context;
  const centerTotal = options.aroundTotal
    ?? capture.samples.find((sample) => sample.time >= (options.aroundTime ?? 0))?.total
    ?? 1;
  const centerTime = options.aroundTime
    ?? capture.samples.find((sample) => sample.total >= centerTotal)?.time
    ?? simulation.events[Math.max(0, centerTotal - 1)]?.time
    ?? 0;
  const startOrdinal = Math.max(1, centerTotal - context);
  const endOrdinal = Math.min(simulation.events.length, centerTotal + context);
  const centerSample = capture.samples.find((sample) => sample.total >= centerTotal)
    ?? capture.samples.find((sample) => sample.time >= centerTime)
    ?? capture.samples[capture.samples.length - 1];

  console.log(`\nDebug around total ${centerTotal}, time ${Math.round(centerTime)}ms:`);
  console.log("Sim events:");
  for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal++) {
    const event = simulation.events[ordinal - 1];
    if (!event) continue;
    const note = simulation.notes[event.noteIndex];
    const state = simulation.noteStates[event.noteIndex];
    const segments = simulation.segments[event.column]
      ?.filter((segment) => segment.end > note.time - 260 && segment.start < note.endTime + 260)
      .map((segment) => `${Math.round(segment.startPrevious ?? segment.start)}>${Math.round(segment.start)}-${Math.round(segment.endPrevious ?? segment.end)}>${Math.round(segment.end)}`)
      .join(" ");

    console.log(
      `  #${String(ordinal).padStart(5)} t=${Math.round(event.time).toString().padStart(7)} `
      + `j=${formatJudgment(event.judgment)} ${event.part.padEnd(13)} c${event.column} n${event.noteIndex} `
      + `${Math.round(note.time)}-${Math.round(note.endTime)} off=${Math.round(event.offsetMs)} `
      + `head=${Math.round(state.headOffsetMs)} tail=${Math.round(state.tailOffsetMs)} `
      + (state.scoringHeadOffsetMs == null
        ? ""
        : `scoreHead=${Math.round(state.scoringHeadOffsetMs)} scoreTail=${Math.round(state.scoringTailOffsetMs ?? 0)} `)
      + `bb=${state.bodyBreakTimes?.map((time) => Math.round(time)).join("|") ?? ""} `
      + `poss=${event.possibleJudgments?.join("") ?? ""}${formatStableStateFlags(state)} segs=${segments ?? ""}`,
    );
  }

  const countSamples = capture.samples.filter(
    (sample) => sample.total >= startOrdinal - context && sample.total <= endOrdinal + context,
  );
  console.log("\nCapture count samples:");
  for (const sample of countSamples) {
    console.log(
      `  seq=${sample.sequence} t=${Math.round(sample.time).toString().padStart(7)} total=${String(sample.total).padStart(5)} `
      + `counts=${formatCounts(sample.counts)} acc=${sample.accuracy?.toFixed(4) ?? "?"} `
      + `errLen=${sample.hitErrors.length} tail=${formatTail(sample.hitErrors, 18)}`,
    );
  }

  const simHitErrors = buildSimHitErrorEvents(simulation);
  const errorIndex = Math.max(0, (centerSample?.hitErrors.length ?? 1) - 1);
  const errorStart = Math.max(0, errorIndex - context * 2);
  const errorEnd = Math.min(simHitErrors.length, errorIndex + context * 2 + 1);
  console.log(`\nSim hit-error components around captured hitErrorArray index ${errorIndex}:`);
  for (let index = errorStart; index < errorEnd; index++) {
    const component = simHitErrors[index];
    const note = simulation.notes[component.noteIndex];
    console.log(
      `  e#${String(index).padStart(5)} t=${Math.round(component.time).toString().padStart(7)} `
      + `${component.part.padEnd(5)} j=${formatJudgment(component.result)} off=${String(component.offset).padStart(5)} `
      + `c${note.column} n${component.noteIndex} ${Math.round(note.time)}-${Math.round(note.endTime)}`,
    );
  }

  if (centerSample) {
    const capturedErrors = centerSample.hitErrors.slice(Math.max(0, errorIndex - context * 2), errorIndex + context * 2 + 1);
    console.log(`Captured hit errors around same index: ${formatTail(capturedErrors, capturedErrors.length)}`);
  }

  const timeRadius = context * 120;
  const timeComponents = simHitErrors.filter((component) => Math.abs(component.time - centerTime) <= timeRadius);
  console.log(`\nSim hit-error components around time +/- ${timeRadius}ms:`);
  for (const component of timeComponents) {
    const note = simulation.notes[component.noteIndex];
    console.log(
      `  t=${Math.round(component.time).toString().padStart(7)} `
      + `${component.part.padEnd(5)} j=${formatJudgment(component.result)} off=${String(component.offset).padStart(5)} `
      + `c${note.column} n${component.noteIndex} ${Math.round(note.time)}-${Math.round(note.endTime)}`,
    );
  }

  const rawSamples = await readRawCaptureSamplesAround(options.capturePath, centerTime, context * 120);
  console.log("\nRaw capture samples around time:");
  let previousSample: PlaySnapshot | null = null;
  for (const sample of rawSamples) {
    const previous = previousSample;
    const newErrors = previous && sample.hitErrors.length >= previous.hitErrors.length
      ? sample.hitErrors.slice(previous.hitErrors.length)
      : sample.hitErrors.slice(-Math.max(0, sample.hitErrors.length - (previous?.hitErrors.length ?? sample.hitErrors.length)));
    const intervalComponents = previous
      ? simHitErrors.filter((component) => component.time > previous.time && component.time <= sample.time)
      : [];

    console.log(
      `  seq=${sample.sequence} t=${Math.round(sample.time).toString().padStart(7)} total=${String(sample.total).padStart(5)} `
      + `counts=${formatCounts(sample.counts)} errLen=${sample.hitErrors.length} tail=${formatTail(sample.hitErrors, 18)}`
      + (previous ? ` new=${formatTail(newErrors, 24)}` : ""),
    );
    if (intervalComponents.length > 0) {
      console.log(`    sim interval: ${intervalComponents.map((component) => {
        const note = simulation.notes[component.noteIndex];
        return `${Math.round(component.time)}:${component.part}:${formatJudgment(component.result)}:${component.offset}:c${note.column}:n${component.noteIndex}`;
      }).join(" ")}`);
    }
    previousSample = sample;
  }
}

const options = parseArgs(process.argv.slice(2));

try {
  const simulationPromise = options.scoreId != null
    ? simulateScore(options)
    : simulateLocal(options);
  const [captureData, simulation, stableOsg] = await Promise.all([
    readCapture(options.capturePath),
    simulationPromise,
    options.stableOsgPath ? readStableOsg(options.stableOsgPath) : Promise.resolve(null),
  ]);
  const capture = captureData.selectedSegment;
  const diagnosticCapture = stableOsg?.segment ?? capture;
  const target = selectComparisonTarget(options, captureData, simulation, stableOsg);
  const comparisonCapture = options.compareTarget === "stable-osg" && stableOsg ? stableOsg.segment : capture;
  const comparison = buildComparison(comparisonCapture, simulation, target, options.limit);
  if (options.json) console.log(JSON.stringify(comparison, null, 2));
  else {
    printComparison(comparison);
    printCaptureSourceDiagnostics(captureData, simulation);
    printBreakTimeline(options, diagnosticCapture, simulation);
    printCounterTail(options, captureData);
    printStableOsgComparison(options, stableOsg, simulation);
    printStableOsgEventRows(options, stableOsg, simulation);
    printStableOsgRawExposure(options, captureData, stableOsg, simulation);
    printStableOsgResidueTrace(options, stableOsg, simulation);
    printStableOsgResidueRuns(options, stableOsg, simulation);
    printStableOsgJudgmentAlignment(options, stableOsg, simulation);
    printStableOsgClusterDiagnostics(options, stableOsg, simulation);
    printSourceFit(options, captureData, simulation);
    printHitErrorFit(options, capture, simulation);
    printStableScoreDiagnostics(options, diagnosticCapture, simulation);
    printScoreResolveDiagnostics(options, diagnosticCapture, simulation, target);
    printStableThresholdSweep(options, simulation, target);
    printStableThresholdGrid(options, simulation, target);
    printStableTimingSweep(options, simulation, target);
    printStableTimingDeltaVariant(options, diagnosticCapture, simulation, target);
    printStableEventOrderSweep(options, diagnosticCapture, simulation, target, stableOsg);
    printStableFrameSweep(options, simulation, target);
    printDriftSummary(options, diagnosticCapture, simulation);
    printDriftAttribution(options, diagnosticCapture, simulation);
    printDiffIntervals(options, diagnosticCapture, simulation);
    printVisibleIntervals(options, diagnosticCapture, simulation);
    printTimeIntervals(options, diagnosticCapture, simulation);
    printStableUpdateLoopTrace(options, diagnosticCapture, simulation);
    printComponentIntervals(options, diagnosticCapture, simulation);
    printComponentExposure(options, diagnosticCapture, simulation);
    printResolvedIntervals(options, diagnosticCapture, simulation);
    printCandidateEvidence(options, diagnosticCapture, simulation, target);
    printStableRuleProbes(options, simulation, target);
    printStableFeatureProbes(options, diagnosticCapture, simulation, target);
    printGlobalAlignment(options, diagnosticCapture, simulation);
    printAlignmentCandidates(options, diagnosticCapture, simulation, target);
    printResolvedFinal(options, simulation, target);
    await printDebugWindow(options, stableOsg ? capture : diagnosticCapture, simulation);
  }
  if (!countsEqual(comparison.target.counts, comparison.finalSim)) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json) console.log(JSON.stringify({ error: message }, null, 2));
  else console.error(message);
  process.exitCode = 1;
}
