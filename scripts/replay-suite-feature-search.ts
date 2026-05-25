#!/usr/bin/env node
// Diagnostic-only suite search for stable osu!mania replay scoring residues.
//
// This intentionally does not mutate production simulation output. It searches
// for small global feature rules that would reconcile the selected stable replay
// playback captures while using already-exact captures as vetoes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ScoreDecoder } from "osu-parsers";
import { parseManiaBeatmap, type ManiaNote } from "../src/lib/beatmap-parser.ts";
import {
  applyManiaReplayModsToNotes,
  buildReplaySegments,
  getManiaReplayHitWindows,
  getManiaReplayRuleset,
  simulateManiaReplayJudgements,
  type Judgment,
  type ManiaReplayHitWindows,
  type ManiaReplaySimulationOptions,
  type ReplayJudgementEvent,
  type ReplayNoteState,
} from "../src/lib/mania-replay-judgement.ts";
import {
  countReplayJudgements,
  diffReplayHitCounts,
  emptyReplayHitCounts,
  getReplayHitCountTotal,
  replayHitCountsToArray,
  type ReplayHitCounts,
} from "../src/lib/replay-validation.ts";
import { decodeStableManiaReplayFrames } from "../src/lib/replay-frames.ts";
import { getModAcronyms, isLazerScore } from "../src/lib/score.ts";
import type { OsuScore, ReplayFrame } from "../src/lib/types.ts";

interface SuiteOptions {
  alignmentSuite: boolean;
  batchSuite: boolean;
  baseOnly: boolean;
  carrySuite: boolean;
  eventPatchSearch: boolean;
  excludedLabels: Set<string>;
  exposureSuite: boolean;
  explicitOnly: boolean;
  exactOsgSuite: boolean;
  includedLabels: Set<string>;
  limit: number;
  localSupportFeatureSuite: boolean;
  localSupported: boolean;
  maxDepth: number;
  maxNodes: number;
  mode: "strict" | "relaxed";
  openExposureFeatureSuite: boolean;
  openCarrySearch: boolean;
  ordinalOnly: boolean;
  perNeedLimit: number;
  simulationOptions?: ManiaReplaySimulationOptions;
  stableNextNoteEdgeGrace?: number;
  timingChangeFeatureSuite?: string;
  timingSuite: boolean;
  traceAllFeatures: boolean;
  traceFeature?: TraceFeatureOptions;
  traceLocalImproves: boolean;
  traceTimeImproves: boolean;
}

interface TraceFeatureOptions {
  featureIncludes: string;
  from: Judgment;
  to: Judgment;
}

interface CaseSpec {
  beatmapPath?: string;
  capturePath?: string;
  exactVeto: boolean;
  label: string;
  replayPath?: string;
  scoreId?: number;
  stableOsgPath?: string;
}

interface PlaySnapshot {
  counts: ReplayHitCounts;
  sequence: number;
  score?: number | null;
  time: number;
  total: number;
}

interface CaptureSegment {
  samples: PlaySnapshot[];
  maxTotal: number;
}

interface SimulationResult {
  cumulativeByOrdinal: ReplayHitCounts[];
  eventTimes: number[];
  events: ReplayJudgementEvent[];
  expectedCounts: ReplayHitCounts;
  frames: ReplayFrame[];
  metadata: {
    idLabel: string;
    keyCount: number;
    mods: string[];
  };
  noteStates: ReplayNoteState[];
  notes: ManiaNote[];
  replayCounts: ReplayHitCounts;
  simulatedCounts: ReplayHitCounts;
  windows: ManiaReplayHitWindows;
}

interface SuiteCase {
  baseOrdinalFit: number;
  baseTimeFit: number;
  capture: CaptureSegment;
  currentCounts: ReplayHitCounts;
  diff: ReplayHitCounts;
  index: number;
  simulation: SimulationResult;
  spec: CaseSpec;
  targetCounts: ReplayHitCounts;
}

interface RuleChange {
  caseIndex: number;
  event: ReplayJudgementEvent;
  ordinal: number;
}

interface CandidateRule {
  changes: RuleChange[];
  deltas: ReplayHitCounts[];
  explicitCount: number;
  featureKey: string;
  from: Judgment;
  id: string;
  label: string;
  localSupport: LocalSupportSummary;
  ordinalFitImprovement: number;
  timeFitImprovement: number;
  to: Judgment;
}

interface LocalWindowEvidence {
  capDelta: ReplayHitCounts;
  ordinalSimDelta: ReplayHitCounts;
  timeSimDelta: ReplayHitCounts;
}

interface LocalChangeSupport {
  ordinalImproves: boolean;
  ordinalWorsens: boolean;
  timeImproves: boolean;
  timeWorsens: boolean;
}

interface LocalSupportSummary {
  changes: number;
  contradicted: number;
  eitherSupported: number;
  ordinalSupported: number;
  timeSupported: number;
}

interface SearchState {
  selected: CandidateRule[];
  usedEvents: Set<string>;
  vectors: number[];
}

interface SuiteJudgmentToken {
  judgment: Judgment;
  ordinal: number;
  row: number;
  rowDelta: ReplayHitCounts;
  score?: number | null;
  scoreDelta?: number | null;
  time: number;
}

interface SuiteAlignmentMatch {
  ordinal: number;
  token: SuiteJudgmentToken;
}

interface SuiteAlignmentOp {
  match?: SuiteAlignmentMatch;
  ordinal?: number;
  token?: SuiteJudgmentToken;
  type: "match" | "sim" | "target";
}

interface SuiteAlignmentChunk {
  after?: SuiteAlignmentMatch;
  before?: SuiteAlignmentMatch;
  ops: SuiteAlignmentOp[];
  simOrdinals: number[];
  targetTokens: SuiteJudgmentToken[];
}

interface ExposureRun {
  caseLabel: string;
  closed: boolean;
  endTime: number;
  endTotal: number;
  judgment: Judgment;
  maxAbs: number;
  rows: number;
  sign: number;
  startTime: number;
  startTotal: number;
}

const DEFAULT_CASES: CaseSpec[] = [
  {
    capturePath: "capture-replays/6698595595-2026-05-17T06-28-47-807Z.ndjson",
    exactVeto: true,
    label: "6698595595",
    scoreId: 6698595595,
  },
  {
    capturePath: "capture-replays/2212454313-2026-05-17T06-45-02-496Z.ndjson",
    exactVeto: true,
    label: "2212454313",
    scoreId: 2212454313,
  },
  {
    capturePath: "capture-replays/2244697701-2026-05-17T06-40-27-152Z.ndjson",
    exactVeto: true,
    label: "2244697701",
    scoreId: 2244697701,
  },
  {
    capturePath: "capture-replays/2810153546-2026-05-17T06-50-35-230Z.ndjson",
    exactVeto: false,
    label: "2810153546",
    scoreId: 2810153546,
  },
  {
    beatmapPath: "capture-replays/quilt heron - Kyrie Eleison (HayaseYuuka) [Domine, Miserere Infantibus Illis.].osu",
    capturePath: "capture-replays/fast-lnoodle-hard-4k-2026-05-17T06-53-17-681Z.ndjson",
    exactVeto: false,
    label: "fast-lnoodle-hard-4k",
    replayPath: "capture-replays/Aleju03 - quilt heron - Kyrie Eleison [Domine, Miserere Infantibus Illis.] (2026-02-05) OsuMania.osr",
  },
];

const PENGUIN_BEATMAP_PATH = "/mnt/c/Users/aleji/AppData/Local/osu!/Songs/351345 Randy Mortimer - Penguin (Pinnacle Remix)/Randy Mortimer - Penguin (Pinnacle Remix) (Cuppp) [7K].osu";
const PENGUIN_CAPTURE_PATH = "capture-replays/penguin-7k-rerun-2026-05-20T20-52-45-514Z.ndjson";
const PENGUIN_HASH = "c8c4f9cffe9d7de5c47be97f9ceb8dc0";
const FAST_BEATMAP_PATH = "/mnt/c/Users/aleji/AppData/Local/osu!/Songs/2032936 quilt heron - Kyrie Eleison/quilt heron - Kyrie Eleison (HayaseYuuka) [Domine, Miserere Infantibus Illis.].osu";
const FAST_CAPTURE_PATH = "capture-replays/fast-lnoodle-hard-4k-2026-05-17T06-53-17-681Z.ndjson";
const FAST_HASH = "4c2a480e48c44c5e5d2677a7b12c886f";
const CROSSING_BLUE_BEATMAP_PATH = "/mnt/c/Users/aleji/AppData/Local/osu!/Songs/923032 penoreri - crossing blue/penoreri - crossing blue (_Kobii) [Jakads' 7K HEAVENLY].osu";
const CROSSING_BLUE_HASH = "2a7a4a3754b03a990a63da4245a098a0";
const STABLE_DATA_R_PATH = "/mnt/c/Users/aleji/AppData/Local/osu!/Data/r";

const EXACT_OSG_CASES: CaseSpec[] = [
  ...DEFAULT_CASES.filter((spec) => spec.exactVeto),
  {
    beatmapPath: FAST_BEATMAP_PATH,
    capturePath: FAST_CAPTURE_PATH,
    exactVeto: false,
    label: "fast-osg-830452",
    replayPath: `${STABLE_DATA_R_PATH}/${FAST_HASH}-134148013993975999.osr`,
    stableOsgPath: `${STABLE_DATA_R_PATH}/${FAST_HASH}-134148013993975999.osg`,
  },
  {
    beatmapPath: CROSSING_BLUE_BEATMAP_PATH,
    exactVeto: false,
    label: "crossing-blue-osg-739220",
    replayPath: `${STABLE_DATA_R_PATH}/${CROSSING_BLUE_HASH}-133938933647546121.osr`,
    stableOsgPath: `${STABLE_DATA_R_PATH}/${CROSSING_BLUE_HASH}-133938933647546121.osg`,
  },
  ...[
    ["penguin-osg-696720", "133598531944113730"],
    ["penguin-osg-685632", "133588114738602043"],
    ["penguin-osg-668508", "133580360271046102"],
    ["penguin-osg-666746", "133581989240842268"],
    ["penguin-osg-660135", "133938191076955033"],
    ["penguin-osg-635489", "133626025648605671"],
  ].map(([label, suffix]) => ({
    beatmapPath: PENGUIN_BEATMAP_PATH,
    capturePath: PENGUIN_CAPTURE_PATH,
    exactVeto: false,
    label,
    replayPath: `${STABLE_DATA_R_PATH}/${PENGUIN_HASH}-${suffix}.osr`,
    stableOsgPath: `${STABLE_DATA_R_PATH}/${PENGUIN_HASH}-${suffix}.osg`,
  })),
];

function usage(exitCode = 2): never {
  const output = [
    "Usage:",
    "  node --env-file-if-exists=.env scripts/replay-suite-feature-search.ts [--limit N] [--max-depth N] [--per-need N] [--max-nodes N] [--stable-next-note-edge-grace MS] [--base-only] [--timing-suite] [--timing-change-feature-suite LABEL] [--alignment-suite] [--batch-suite] [--ordinal-only] [--exposure-suite] [--open-exposure-feature-suite] [--carry-suite] [--open-carry-search] [--event-patch-search] [--local-support-feature-suite] [--trace-feature FROM->TO:TEXT] [--trace-all-features] [--trace-local-improves] [--trace-time-improves] [--explicit-only] [--local-supported] [--relaxed] [--exact-osg-suite] [--include-case LABEL] [--exclude-case LABEL]",
    "",
    "The built-in suite is the five captures listed in STABLE_REPLAY_MEMORY.md. Use --exact-osg-suite for local paired .osg rows plus exact capture vetoes.",
  ].join("\n");
  if (exitCode === 0) console.log(output);
  else console.error(output);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): SuiteOptions {
  const options: SuiteOptions = {
    alignmentSuite: false,
    batchSuite: false,
    baseOnly: false,
    carrySuite: false,
    eventPatchSearch: false,
    excludedLabels: new Set(),
    exposureSuite: false,
    explicitOnly: false,
    exactOsgSuite: false,
    includedLabels: new Set(),
    limit: 12,
    localSupportFeatureSuite: false,
    localSupported: false,
    maxDepth: 6,
    maxNodes: 50_000,
    mode: "strict",
    openExposureFeatureSuite: false,
    openCarrySearch: false,
    ordinalOnly: false,
    perNeedLimit: 40,
    timingSuite: false,
    traceAllFeatures: false,
    traceLocalImproves: false,
    traceTimeImproves: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--limit") {
      const limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit <= 0) usage();
      options.limit = limit;
    } else if (arg === "--max-depth") {
      const maxDepth = Number(argv[++i]);
      if (!Number.isInteger(maxDepth) || maxDepth <= 0) usage();
      options.maxDepth = maxDepth;
    } else if (arg === "--per-need") {
      const perNeedLimit = Number(argv[++i]);
      if (!Number.isInteger(perNeedLimit) || perNeedLimit <= 0) usage();
      options.perNeedLimit = perNeedLimit;
    } else if (arg === "--max-nodes") {
      const maxNodes = Number(argv[++i]);
      if (!Number.isInteger(maxNodes) || maxNodes <= 0) usage();
      options.maxNodes = maxNodes;
    } else if (arg === "--stable-next-note-edge-grace") {
      const grace = Number(argv[++i]);
      if (!Number.isFinite(grace) || grace < 0) usage();
      options.stableNextNoteEdgeGrace = grace;
    } else if (arg === "--timing-suite") {
      options.timingSuite = true;
    } else if (arg === "--base-only") {
      options.baseOnly = true;
    } else if (arg === "--timing-change-feature-suite") {
      const label = argv[++i] ?? "";
      if (!label) usage();
      options.timingChangeFeatureSuite = label;
    } else if (arg === "--alignment-suite") {
      options.alignmentSuite = true;
    } else if (arg === "--batch-suite") {
      options.batchSuite = true;
    } else if (arg === "--ordinal-only") {
      options.ordinalOnly = true;
    } else if (arg === "--exposure-suite") {
      options.exposureSuite = true;
    } else if (arg === "--open-exposure-feature-suite") {
      options.openExposureFeatureSuite = true;
    } else if (arg === "--carry-suite") {
      options.carrySuite = true;
    } else if (arg === "--open-carry-search") {
      options.openCarrySearch = true;
    } else if (arg === "--event-patch-search") {
      options.eventPatchSearch = true;
    } else if (arg === "--local-support-feature-suite") {
      options.localSupportFeatureSuite = true;
    } else if (arg === "--trace-feature") {
      options.traceFeature = parseTraceFeature(argv[++i] ?? "");
    } else if (arg === "--trace-all-features") {
      options.traceAllFeatures = true;
    } else if (arg === "--trace-local-improves") {
      options.traceLocalImproves = true;
    } else if (arg === "--trace-time-improves") {
      options.traceTimeImproves = true;
    } else if (arg === "--relaxed") {
      options.mode = "relaxed";
    } else if (arg === "--explicit-only") {
      options.explicitOnly = true;
    } else if (arg === "--local-supported") {
      options.localSupported = true;
    } else if (arg === "--exact-osg-suite") {
      options.exactOsgSuite = true;
    } else if (arg === "--include-case") {
      const label = argv[++i] ?? "";
      if (!label) usage();
      options.includedLabels.add(label);
    } else if (arg === "--exclude-case") {
      const label = argv[++i] ?? "";
      if (!label) usage();
      options.excludedLabels.add(label);
    } else usage();
  }

  return options;
}

function parseTraceFeature(value: string): TraceFeatureOptions {
  const match = /^([1-6])->([1-6]):(.+)$/.exec(value);
  if (!match) usage();
  return {
    featureIncludes: match[3],
    from: Number(match[1]) as Judgment,
    to: Number(match[2]) as Judgment,
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
  return replayHitCountsToArray(counts).slice(1).join("/");
}

function countsEqual(a: ReplayHitCounts, b: ReplayHitCounts): boolean {
  return countsSignature(a) === countsSignature(b);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCaptureSnapshot(row: any): PlaySnapshot | null {
  if (row?.type !== "sample") return null;
  const raw = row.raw;
  if (raw?.state?.name !== "play") return null;

  const time = asNumber(raw?.beatmap?.time?.live) ?? asNumber(row.normalized?.currentTime);
  if (time == null) return null;

  const counts = countsFromHitObject(raw?.play?.hits);
  return {
    counts,
    sequence: Number(row.sequence ?? 0),
    score: asNumber(raw?.play?.score) ?? asNumber(row.normalized?.score),
    time,
    total: getReplayHitCountTotal(counts),
  };
}

function splitCaptureSegments(samples: PlaySnapshot[]): CaptureSegment[] {
  const segments: CaptureSegment[] = [];
  let current: PlaySnapshot[] = [];
  let previous: PlaySnapshot | null = null;

  function flush() {
    if (current.length === 0) return;
    segments.push({
      maxTotal: Math.max(...current.map((sample) => sample.total)),
      samples: current,
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

async function readCapture(capturePath: string): Promise<CaptureSegment> {
  const text = await readFile(path.resolve(process.cwd(), capturePath), "utf8");
  const samples: PlaySnapshot[] = [];
  let lastSignature = "";

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sample = parseCaptureSnapshot(JSON.parse(line));
    if (!sample) continue;
    const signature = countsSignature(sample.counts);
    if (signature === lastSignature) continue;
    samples.push(sample);
    lastSignature = signature;
  }

  const segment = splitCaptureSegments(samples)
    .filter((candidate) => candidate.maxTotal > 0)
    .sort((a, b) => b.maxTotal - a.maxTotal)[0];
  if (!segment) throw new Error(`No playable segment found in ${capturePath}`);
  return segment;
}

async function readStableOsg(osgPath: string): Promise<CaptureSegment> {
  const resolvedPath = path.resolve(process.cwd(), osgPath);
  const buffer = await readFile(resolvedPath);
  if (buffer.length < 8) throw new Error(`Stable .osg file is too short: ${osgPath}`);

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
      counts,
      sequence: index + 1,
      score: buffer.readInt32LE(offset + 17),
      time: buffer.readInt32LE(offset),
      total: getReplayHitCountTotal(counts),
    });
  }

  if (samples.length === 0) throw new Error(`Stable .osg has no score records: ${osgPath}`);
  return {
    maxTotal: Math.max(...samples.map((sample) => sample.total)),
    samples,
  };
}

function decodeFrames(decodedScore: any): ReplayFrame[] {
  return decodeStableManiaReplayFrames((decodedScore.replay?.frames ?? []) as any[]);
}

function buildSimulationResult(
  beatmapContent: string,
  decoded: any,
  mods: string[],
  idLabel: string,
  expectedCounts: ReplayHitCounts,
  replayCounts: ReplayHitCounts,
  isLazer: boolean,
  isConvert: boolean,
  options: SuiteOptions,
): SimulationResult {
  const beatmap = parseManiaBeatmap(beatmapContent);
  const frames = decodeFrames(decoded);
  const ruleset = getManiaReplayRuleset(isLazer, mods, isConvert);
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
    {
      legacyReplayFrameRounding: true,
      speedMultiplier: ruleset.speedMultiplier,
      ...(options.simulationOptions ?? {}),
      ...(options.stableNextNoteEdgeGrace != null
        ? { stableNextNoteEdgeGrace: options.stableNextNoteEdgeGrace }
        : {}),
    },
  );
  const events = [...simulated.events]
    .filter((event) => event.judgment != null)
    .sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);
  const cumulativeByOrdinal: ReplayHitCounts[] = [];
  const cumulative = emptyReplayHitCounts();

  for (const event of events) {
    addJudgmentValue(cumulative, event.judgment as Judgment, 1);
    cumulativeByOrdinal.push({ ...cumulative });
  }

  return {
    cumulativeByOrdinal,
    eventTimes: events.map((event) => event.time),
    events,
    expectedCounts,
    frames,
    metadata: {
      idLabel,
      keyCount: beatmap.keyCount,
      mods,
    },
    notes,
    noteStates: simulated.noteStates,
    replayCounts,
    simulatedCounts: countReplayJudgements(events),
    windows,
  };
}

async function simulateScore(scoreId: number, options: SuiteOptions): Promise<SimulationResult> {
  const dir = path.resolve(process.cwd(), "cache/replay-fixtures", String(scoreId));
  const [scoreText, beatmapContent, replayBuffer] = await Promise.all([
    readFile(path.join(dir, "score.json"), "utf8"),
    readFile(path.join(dir, "beatmap.osu"), "utf8"),
    readFile(path.join(dir, "replay.osr")),
  ]);
  const score = JSON.parse(scoreText) as OsuScore;
  const decoded = await new ScoreDecoder().decodeFromBuffer(replayBuffer);
  const mods = getModAcronyms(score.mods, false);

  return buildSimulationResult(
    beatmapContent,
    decoded,
    mods,
    String(scoreId),
    countsFromScore(score),
    countsFromDecodedInfo(decoded.info),
    isLazerScore(score),
    score.beatmap?.convert ?? false,
    options,
  );
}

async function simulateLocal(spec: CaseSpec, options: SuiteOptions): Promise<SimulationResult> {
  if (!spec.beatmapPath || !spec.replayPath) {
    throw new Error(`Local case ${spec.label} needs beatmapPath and replayPath.`);
  }

  const [beatmapContent, replayBuffer] = await Promise.all([
    readFile(path.resolve(process.cwd(), spec.beatmapPath), "utf8"),
    readFile(path.resolve(process.cwd(), spec.replayPath)),
  ]);
  const decoded = await new ScoreDecoder().decodeFromBuffer(replayBuffer);
  const mods = parseModList(String(decoded.info?.mods ?? ""));

  return buildSimulationResult(
    beatmapContent,
    decoded,
    mods,
    spec.label,
    countsFromDecodedInfo(decoded.info),
    countsFromDecodedInfo(decoded.info),
    false,
    false,
    options,
  );
}

async function loadCase(spec: CaseSpec, index: number, options: SuiteOptions): Promise<SuiteCase> {
  if (!spec.stableOsgPath && !spec.capturePath) {
    throw new Error(`Case ${spec.label} needs capturePath when stableOsgPath is not set.`);
  }

  const [capture, simulation] = await Promise.all([
    spec.stableOsgPath ? readStableOsg(spec.stableOsgPath) : readCapture(spec.capturePath!),
    spec.scoreId != null ? simulateScore(spec.scoreId, options) : simulateLocal(spec, options),
  ]);
  const targetCounts = capture.samples[capture.samples.length - 1].counts;
  const currentCounts = simulation.simulatedCounts;
  const suiteCase: SuiteCase = {
    baseOrdinalFit: 0,
    baseTimeFit: 0,
    capture,
    currentCounts,
    diff: diffReplayHitCounts(currentCounts, targetCounts),
    index,
    simulation,
    spec,
    targetCounts,
  };
  suiteCase.baseOrdinalFit = caseFitDistance(suiteCase, "ordinal");
  suiteCase.baseTimeFit = caseFitDistance(suiteCase, "time");

  return suiteCase;
}

function formatCounts(counts: ReplayHitCounts): string {
  return `${counts.countGeki}/${counts.count300}/${counts.countKatu}/${counts.count100}/${counts.count50}/${counts.countMiss}`;
}

function formatDiff(diff: ReplayHitCounts): string {
  const value = (count: number) => count > 0 ? `+${count}` : String(count);
  return `${value(diff.countGeki)}/${value(diff.count300)}/${value(diff.countKatu)}/${value(diff.count100)}/${value(diff.count50)}/${value(diff.countMiss)}`;
}

function formatVisibleDiff(diff: ReplayHitCounts): string {
  const value = (count: number) => count > 0 ? `+${count}` : String(count);
  return `${value(diff.count300)}/${value(diff.count100)}/${value(diff.count50)}/${value(diff.countMiss)}`;
}

function judgmentLabel(judgment: Judgment): string {
  switch (judgment) {
    case 1:
      return "MAX";
    case 2:
      return "300";
    case 3:
      return "200";
    case 4:
      return "100";
    case 5:
      return "50";
    case 6:
      return "miss";
  }
  return String(judgment);
}

function countDistance(counts: ReplayHitCounts): number {
  return replayHitCountsToArray(counts)
    .slice(1)
    .reduce((sum, count) => sum + Math.abs(count), 0);
}

function visibleDistance(counts: ReplayHitCounts): number {
  return Math.abs(counts.count300)
    + Math.abs(counts.count100)
    + Math.abs(counts.count50)
    + Math.abs(counts.countMiss);
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

function judgmentDelta(from: Judgment, to: Judgment): ReplayHitCounts {
  const delta = emptyReplayHitCounts();
  addJudgmentValue(delta, from, -1);
  addJudgmentValue(delta, to, 1);
  return delta;
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

function cloneCounts(counts: ReplayHitCounts): ReplayHitCounts {
  return { ...counts };
}

function addCounts(a: ReplayHitCounts, b: ReplayHitCounts): ReplayHitCounts {
  return {
    countGeki: a.countGeki + b.countGeki,
    count300: a.count300 + b.count300,
    countKatu: a.countKatu + b.countKatu,
    count100: a.count100 + b.count100,
    count50: a.count50 + b.count50,
    countMiss: a.countMiss + b.countMiss,
  };
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

function countTokens(tokens: SuiteJudgmentToken[]): ReplayHitCounts {
  const counts = emptyReplayHitCounts();
  for (const token of tokens) addJudgmentValue(counts, token.judgment, 1);
  return counts;
}

function countOrdinals(simulation: SimulationResult, ordinals: number[]): ReplayHitCounts {
  const counts = emptyReplayHitCounts();
  for (const ordinal of ordinals) {
    const judgment = simulation.events[ordinal - 1]?.judgment;
    if (judgment != null) addJudgmentValue(counts, judgment as Judgment, 1);
  }
  return counts;
}

function countEventsInTimeWindow(
  simulation: SimulationResult,
  startExclusive: number,
  endInclusive: number,
): ReplayHitCounts {
  const counts = emptyReplayHitCounts();

  for (const event of simulation.events) {
    if (event.time <= startExclusive) continue;
    if (event.time > endInclusive) break;
    if (event.judgment != null) addJudgmentValue(counts, event.judgment as Judgment, 1);
  }

  return counts;
}

function eventOrdinalsInTimeWindow(
  simulation: SimulationResult,
  startExclusive: number,
  endInclusive: number,
): number[] {
  const ordinals: number[] = [];

  for (let index = 0; index < simulation.events.length; index++) {
    const event = simulation.events[index];
    if (event.time <= startExclusive) continue;
    if (event.time > endInclusive) break;
    if (event.judgment != null) ordinals.push(index + 1);
  }

  return ordinals;
}

function countsAtOrdinal(suiteCase: SuiteCase, ordinal: number): ReplayHitCounts {
  if (ordinal <= 0) return emptyReplayHitCounts();
  return suiteCase.simulation.cumulativeByOrdinal[Math.min(ordinal, suiteCase.simulation.cumulativeByOrdinal.length) - 1]
    ?? emptyReplayHitCounts();
}

function countsAtTime(suiteCase: SuiteCase, time: number): ReplayHitCounts {
  const times = suiteCase.simulation.eventTimes;
  let low = 0;
  let high = times.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (times[mid] <= time) low = mid + 1;
    else high = mid;
  }

  return low <= 0
    ? emptyReplayHitCounts()
    : suiteCase.simulation.cumulativeByOrdinal[low - 1] ?? emptyReplayHitCounts();
}

const ordinalWindowCache = new WeakMap<SuiteCase, Map<number, LocalWindowEvidence | null>>();
const timeWindowCache = new WeakMap<SuiteCase, Map<number, LocalWindowEvidence | null>>();

function findFirstSampleIndexByTotal(samples: PlaySnapshot[], total: number): number {
  let low = 0;
  let high = samples.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].total >= total) high = mid;
    else low = mid + 1;
  }

  return low < samples.length ? low : -1;
}

function findFirstSampleIndexByTime(samples: PlaySnapshot[], time: number): number {
  let low = 0;
  let high = samples.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].time >= time) high = mid;
    else low = mid + 1;
  }

  return low < samples.length ? low : -1;
}

function buildLocalWindowEvidence(suiteCase: SuiteCase, sampleIndex: number): LocalWindowEvidence | null {
  const sample = suiteCase.capture.samples[sampleIndex];
  if (!sample) return null;

  const previous = sampleIndex > 0 ? suiteCase.capture.samples[sampleIndex - 1] : null;
  const previousCounts = previous?.counts ?? emptyReplayHitCounts();
  const previousTotal = previous?.total ?? 0;
  const previousTime = previous?.time ?? Number.NEGATIVE_INFINITY;

  return {
    capDelta: subtractCounts(sample.counts, previousCounts),
    ordinalSimDelta: subtractCounts(
      countsAtOrdinal(suiteCase, sample.total),
      countsAtOrdinal(suiteCase, previousTotal),
    ),
    timeSimDelta: subtractCounts(
      countsAtTime(suiteCase, sample.time),
      countsAtTime(suiteCase, previousTime),
    ),
  };
}

function localOrdinalWindow(suiteCase: SuiteCase, ordinal: number): LocalWindowEvidence | null {
  let cache = ordinalWindowCache.get(suiteCase);
  if (!cache) {
    cache = new Map();
    ordinalWindowCache.set(suiteCase, cache);
  }
  if (cache.has(ordinal)) return cache.get(ordinal) ?? null;

  const sampleIndex = findFirstSampleIndexByTotal(suiteCase.capture.samples, ordinal);
  const window = sampleIndex < 0 ? null : buildLocalWindowEvidence(suiteCase, sampleIndex);
  cache.set(ordinal, window);
  return window;
}

function localTimeWindow(suiteCase: SuiteCase, time: number, ordinal: number): LocalWindowEvidence | null {
  let cache = timeWindowCache.get(suiteCase);
  if (!cache) {
    cache = new Map();
    timeWindowCache.set(suiteCase, cache);
  }
  if (cache.has(ordinal)) return cache.get(ordinal) ?? null;

  const sampleIndex = findFirstSampleIndexByTime(suiteCase.capture.samples, time);
  const window = sampleIndex < 0 ? null : buildLocalWindowEvidence(suiteCase, sampleIndex);
  cache.set(ordinal, window);
  return window;
}

function localDeltaImprovement(
  simDelta: ReplayHitCounts,
  capDelta: ReplayHitCounts,
  delta: ReplayHitCounts,
): { improves: boolean; worsens: boolean } {
  const before = countDistance(diffReplayHitCounts(simDelta, capDelta));
  const after = countDistance(diffReplayHitCounts(addCounts(simDelta, delta), capDelta));
  return {
    improves: after < before,
    worsens: after > before,
  };
}

function localChangeSupport(
  cases: SuiteCase[],
  change: RuleChange,
  from: Judgment,
  to: Judgment,
): LocalChangeSupport {
  const suiteCase = cases[change.caseIndex];
  const delta = judgmentDelta(from, to);
  const event = change.event;
  const ordinalWindow = localOrdinalWindow(suiteCase, change.ordinal);
  const timeWindow = localTimeWindow(suiteCase, event.time, change.ordinal);
  const ordinal = ordinalWindow
    ? localDeltaImprovement(ordinalWindow.ordinalSimDelta, ordinalWindow.capDelta, delta)
    : { improves: false, worsens: false };
  const time = timeWindow
    ? localDeltaImprovement(timeWindow.timeSimDelta, timeWindow.capDelta, delta)
    : { improves: false, worsens: false };

  return {
    ordinalImproves: ordinal.improves,
    ordinalWorsens: ordinal.worsens,
    timeImproves: time.improves,
    timeWorsens: time.worsens,
  };
}

function summarizeLocalSupport(
  cases: SuiteCase[],
  changes: RuleChange[],
  from: Judgment,
  to: Judgment,
): LocalSupportSummary {
  const summary: LocalSupportSummary = {
    changes: changes.length,
    contradicted: 0,
    eitherSupported: 0,
    ordinalSupported: 0,
    timeSupported: 0,
  };

  for (const change of changes) {
    const support = localChangeSupport(cases, change, from, to);
    const eitherSupported = support.ordinalImproves || support.timeImproves;
    if (support.ordinalImproves) summary.ordinalSupported++;
    if (support.timeImproves) summary.timeSupported++;
    if (eitherSupported) summary.eitherSupported++;
    else if (support.ordinalWorsens || support.timeWorsens) summary.contradicted++;
  }

  return summary;
}

function caseFitDistance(
  suiteCase: SuiteCase,
  mode: "ordinal" | "time",
): number {
  let total = 0;

  for (const sample of suiteCase.capture.samples) {
    if (sample.total <= 0) continue;

    const baseCounts = mode === "ordinal"
      ? countsAtOrdinal(suiteCase, sample.total)
      : countsAtTime(suiteCase, sample.time);
    total += countDistance(diffReplayHitCounts(baseCounts, sample.counts));
  }

  return total;
}

function ruleFitDistance(
  suiteCase: SuiteCase,
  rule: CandidateRule,
  mode: "ordinal" | "time",
): number {
  const relevantChanges = rule.changes.filter((change) => change.caseIndex === suiteCase.index);
  const delta = judgmentDelta(rule.from, rule.to);
  let total = 0;

  for (const sample of suiteCase.capture.samples) {
    if (sample.total <= 0) continue;

    const baseCounts = mode === "ordinal"
      ? countsAtOrdinal(suiteCase, sample.total)
      : countsAtTime(suiteCase, sample.time);
    let diff = diffReplayHitCounts(baseCounts, sample.counts);

    for (const change of relevantChanges) {
      const applies = mode === "ordinal"
        ? change.ordinal <= sample.total
        : change.event.time <= sample.time;
      if (applies) diff = addCounts(diff, delta);
    }

    total += countDistance(diff);
  }

  return total;
}

function ruleFitImprovement(
  cases: SuiteCase[],
  rule: CandidateRule,
  mode: "ordinal" | "time",
): number {
  return cases.reduce((sum, suiteCase) => {
    const base = mode === "ordinal" ? suiteCase.baseOrdinalFit : suiteCase.baseTimeFit;
    return sum + base - ruleFitDistance(suiteCase, rule, mode);
  }, 0);
}

function getOffset(
  state: ReplayNoteState | undefined,
  key: "head" | "tail",
  scoring: boolean,
): number {
  if (key === "head") return scoring ? state?.scoringHeadOffsetMs ?? state?.headOffsetMs ?? 0 : state?.headOffsetMs ?? 0;
  return scoring ? state?.scoringTailOffsetMs ?? state?.tailOffsetMs ?? 0 : state?.tailOffsetMs ?? 0;
}

function roundedOffset(
  state: ReplayNoteState | undefined,
  key: "head" | "tail",
  scoring: boolean,
): number {
  return Math.round(getOffset(state, key, scoring));
}

function offsetTier(value: number, windows: ManiaReplayHitWindows): string {
  const absolute = Math.abs(Math.round(value));
  if (absolute <= Math.floor(windows.perfect)) return "perfect";
  if (absolute <= Math.floor(windows.great)) return "great";
  if (absolute <= Math.floor(windows.good)) return "good";
  if (absolute <= Math.floor(windows.ok)) return "ok";
  if (absolute <= Math.floor(windows.meh)) return "meh";
  if (absolute <= Math.floor(windows.miss)) return "miss";
  return "outside";
}

function signedBand(value: number, width: number): string {
  const rounded = Math.round(value);
  const start = Math.floor(rounded / width) * width;
  return `${start}..${start + width - 1}`;
}

function absBand(value: number, width: number): string {
  const rounded = Math.abs(Math.round(value));
  const start = Math.floor(rounded / width) * width;
  return `${start}..${start + width - 1}`;
}

function sign(value: number): string {
  const rounded = Math.round(value);
  if (rounded < 0) return "early";
  if (rounded > 0) return "late";
  return "zero";
}

function durationBucket(duration: number, windows: ManiaReplayHitWindows): string {
  const meh = Math.floor(windows.meh);
  if (duration <= 0) return "tap";
  if (duration <= meh / 2) return "short";
  if (duration <= meh) return "meh";
  if (duration <= meh * 2) return "2meh";
  if (duration <= meh * 4) return "4meh";
  return "long";
}

function combinedBucket(head: number, tail: number, width: number): string {
  const combined = Math.abs(Math.round(head)) + Math.abs(Math.round(tail));
  const start = Math.floor(combined / width) * width;
  return `${start}..${start + width - 1}`;
}

function stableTailSourceOffset(
  state: ReplayNoteState | undefined,
  note: ManiaNote,
): number | null {
  if (state?.stableTailJudgementSourceTime == null) return null;
  return state.stableTailJudgementSourceTime - note.endTime;
}

function stableTailSourceBand(
  state: ReplayNoteState | undefined,
  note: ManiaNote,
  width: number,
): string {
  const sourceOffset = stableTailSourceOffset(state, note);
  return sourceOffset == null ? "none" : signedBand(sourceOffset, width);
}

function stableTailScoredSourceBand(
  state: ReplayNoteState | undefined,
  note: ManiaNote,
  width: number,
): string {
  const sourceOffset = stableTailSourceOffset(state, note);
  if (sourceOffset == null) return "none";
  return signedBand(sourceOffset + (state?.stableTailSegmentReleaseDelay ?? 0), width);
}

function stableTailReleaseDelayBucket(state: ReplayNoteState | undefined): string {
  const delay = Math.round(state?.stableTailSegmentReleaseDelay ?? 0);
  if (delay <= 0) return "0";
  if (delay <= 2) return "1..2";
  if (delay <= 4) return "3..4";
  if (delay <= 8) return "5..8";
  return ">8";
}

function stableSegmentRelationBucket(
  state: ReplayNoteState | undefined,
  field:
    | "stableLastConsumedSegmentIndex"
    | "stableLastScannedSegmentIndex"
    | "stableMatchedSegmentIndex"
    | "stableTailSegmentIndex",
): string {
  const cursor = state?.stableSegmentCursorBefore;
  const value = state?.[field];
  if (cursor == null || value == null) return "none";
  const delta = value - cursor;
  if (delta <= -2) return "<=-2";
  if (delta >= 4) return ">=4";
  return `${delta}`;
}

function stableSegmentCursorAdvanceBucket(state: ReplayNoteState | undefined): string {
  const before = state?.stableSegmentCursorBefore;
  const after = state?.stableSegmentCursorAfter;
  if (before == null || after == null) return "none";
  const delta = after - before;
  if (delta <= 0) return "<=0";
  if (delta >= 4) return ">=4";
  return `${delta}`;
}

function stableReleaseTailBand(state: ReplayNoteState | undefined, note: ManiaNote, width: number): string {
  if (state?.releaseTime == null) return "none";
  return signedBand(state.releaseTime - note.endTime, width);
}

function bodyBreakBucket(state: ReplayNoteState | undefined): string {
  const count = state?.bodyBreakTimes?.length ?? 0;
  if (count === 0) return "no-bb";
  if (count === 1) return "bb1";
  return "bb2+";
}

function heldSegmentBucket(state: ReplayNoteState | undefined): string {
  const count = state?.heldSegments?.length ?? 0;
  if (count <= 1) return `held${count}`;
  if (count <= 3) return "held2-3";
  return "held4+";
}

function stableStateFlagKeys(state: ReplayNoteState | undefined): string[] {
  if (!state) return ["flag=none"];
  const flags = [
    state.stableHeldOkTimeout ? "held-ok-timeout" : "",
    state.stableHiddenBodyBreakPossible ? "hidden-body-break-possible" : "",
    state.stableTailWasHeldAtJudgement ? "held-tail" : "",
    state.stableBarelyCrossedTailOnTimeout ? "barely-crossed-tail" : "",
    state.stableLateStartReleasePastOk ? "late-start-past-ok" : "",
    state.stableMatchedPreviousTailSegment ? "matched-previous-tail-segment" : "",
    state.stableMissedInsideConsumedSegment ? "missed-inside-consumed-segment" : "",
    state.stablePreHeadPressActivatedLongNote ? "pre-head-activated-ln" : "",
    state.stablePreHeadReleaseMiss ? "pre-head-release-miss" : "",
    state.stablePreHeadReleaseMissConsumedRecovery ? "pre-head-release-miss-consumed-recovery" : "",
    state.stableConsumedHeldSegmentAtTimeout ? "consumed-timeout-segment" : "",
  ].filter(Boolean);

  return flags.length > 0
    ? ["flag=any", ...flags.map((flag) => `flag=${flag}`), `flags=${flags.join("+")}`]
    : ["flag=none"];
}

function compactStateFlags(state: ReplayNoteState | undefined): string {
  return stableStateFlagKeys(state)
    .filter((key) => key.startsWith("flag=") && key !== "flag=any" && key !== "flag=none")
    .map((key) => key.slice("flag=".length))
    .join("+");
}

function featureKeys(suiteCase: SuiteCase, event: ReplayJudgementEvent): string[] {
  const simulation = suiteCase.simulation;
  const note = simulation.notes[event.noteIndex];
  const state = simulation.noteStates[event.noteIndex];
  const ordinal = simulation.events.indexOf(event) + 1;
  const part = `part=${event.part}`;
  const bb = `bb=${bodyBreakBucket(state)}`;
  const held = `held=${heldSegmentBucket(state)}`;
  const poss = `poss=${event.possibleJudgments?.join("") || "-"}`;
  const duration = `dur=${durationBucket(note.endTime - note.time, simulation.windows)}`;
  const density25 = `density25=${densityBucket(eventDensity(simulation.events, event.time, 25))}`;
  const density50 = `density50=${densityBucket(eventDensity(simulation.events, event.time, 50))}`;
  const sameTime = `sameTime=${densityBucket(sameTimeEventCount(simulation.events, event.time))}`;
  const adjacentTime = `adjacent=${adjacentEventTimeBucket(simulation.events, ordinal)}`;
  const columnContext = sameColumnNoteContext(simulation.notes, note, event.noteIndex);
  const head = roundedOffset(state, "head", true);
  const tail = roundedOffset(state, "tail", true);
  const rawHead = roundedOffset(state, "head", false);
  const rawTail = roundedOffset(state, "tail", false);
  const headTier = `headTier=${offsetTier(head, simulation.windows)}`;
  const tailTier = `tailTier=${offsetTier(tail, simulation.windows)}`;
  const rawTailTier = `rawTailTier=${offsetTier(rawTail, simulation.windows)}`;
  const headSign = `headSign=${sign(head)}`;
  const tailSign = `tailSign=${sign(tail)}`;
  const rawTailSign = `rawTailSign=${sign(rawTail)}`;
  const tailDiff = `tailReflect=${Math.abs(rawTail - tail) > 1 ? "yes" : "no"}`;
  const tailSource5 = `tailSource5=${stableTailSourceBand(state, note, 5)}`;
  const tailSource10 = `tailSource10=${stableTailSourceBand(state, note, 10)}`;
  const tailScoredSource5 = `tailScoredSource5=${stableTailScoredSourceBand(state, note, 5)}`;
  const tailScoredSource10 = `tailScoredSource10=${stableTailScoredSourceBand(state, note, 10)}`;
  const tailReleaseDelay = `releaseDelay=${stableTailReleaseDelayBucket(state)}`;
  const tailHeldAtJudge = `heldTail=${state?.stableTailWasHeldAtJudgement ? "yes" : "no"}`;
  const cursorAdvance = `cursorAdv=${stableSegmentCursorAdvanceBucket(state)}`;
  const matchRel = `matchRel=${stableSegmentRelationBucket(state, "stableMatchedSegmentIndex")}`;
  const scanRel = `scanRel=${stableSegmentRelationBucket(state, "stableLastScannedSegmentIndex")}`;
  const consumeRel = `consumeRel=${stableSegmentRelationBucket(state, "stableLastConsumedSegmentIndex")}`;
  const tailSegRel = `tailSegRel=${stableSegmentRelationBucket(state, "stableTailSegmentIndex")}`;
  const releaseTail25 = `releaseTail25=${stableReleaseTailBand(state, note, 25)}`;
  const base = `${part};${bb}`;
  const flagKeys = stableStateFlagKeys(state);

  const keys = [
    part,
    `${part};${poss}`,
    `${base}`,
    `${base};${poss}`,
    `${base};${held}`,
    `${base};${duration}`,
    `${base};${duration};${held}`,
    `${base};${headTier};${tailTier}`,
    `${base};${poss};${headTier};${tailTier}`,
    `${base};${poss};${duration};${headTier};${tailTier}`,
    `${base};${duration};${headTier};${tailTier}`,
    `${base};${poss};${tailTier}`,
    `${base};${poss};${rawTailTier}`,
    `${base};${tailSign};${tailTier}`,
    `${base};${poss};${tailSign};${tailTier}`,
    `${base};${poss};${rawTailSign};${rawTailTier}`,
    `${base};${poss};${tailDiff}`,
    `${base};${poss};${headSign};${tailSign}`,
    `${base};${poss};head10=${signedBand(head, 10)};tail10=${signedBand(tail, 10)}`,
    `${base};${poss};head5=${signedBand(head, 5)};tail5=${signedBand(tail, 5)}`,
    `${base};${poss};absHead5=${absBand(head, 5)};absTail5=${absBand(tail, 5)}`,
    `${base};${poss};tail10=${signedBand(tail, 10)}`,
    `${base};${poss};tail5=${signedBand(tail, 5)}`,
    `${base};${poss};rawTail10=${signedBand(rawTail, 10)}`,
    `${base};${poss};rawTail5=${signedBand(rawTail, 5)}`,
    `${base};${duration};${poss};tail10=${signedBand(tail, 10)}`,
    `${base};${duration};${poss};tail5=${signedBand(tail, 5)}`,
    `${base};${duration};${poss};head5=${signedBand(head, 5)};tail5=${signedBand(tail, 5)}`,
    `${base};${duration};${poss};absHead5=${absBand(head, 5)};absTail5=${absBand(tail, 5)}`,
    `${base};${duration};${poss};combined10=${combinedBucket(head, tail, 10)}`,
    `${base};${duration};${poss};combined5=${combinedBucket(head, tail, 5)}`,
    `${base};${held};${poss};head5=${signedBand(head, 5)};tail5=${signedBand(tail, 5)}`,
    `${base};${held};${duration};${poss};combined5=${combinedBucket(head, tail, 5)}`,
    `${base};${poss};rawHead5=${signedBand(rawHead, 5)};rawTail5=${signedBand(rawTail, 5)}`,
    `${base};${poss};${tailSource10}`,
    `${base};${poss};${tailSource5}`,
    `${base};${poss};${tailScoredSource10}`,
    `${base};${poss};${tailScoredSource5}`,
    `${base};${poss};${tailReleaseDelay}`,
    `${base};${poss};${tailHeldAtJudge}`,
    `${base};${poss};${cursorAdvance}`,
    `${base};${poss};${matchRel};${scanRel};${consumeRel};${tailSegRel}`,
    `${base};${poss};${releaseTail25}`,
    `${base};${poss};${cursorAdvance};${releaseTail25}`,
    `${base};${poss};${tailSource5};${tailReleaseDelay}`,
    `${base};${poss};${tailScoredSource5};${tailReleaseDelay}`,
    `${base};${duration};${poss};${tailSource5};${tailReleaseDelay}`,
    `${base};${held};${poss};${tailSource5};${tailReleaseDelay}`,
    `${base};${poss};${density25}`,
    `${base};${poss};${density50}`,
    `${base};${poss};${sameTime}`,
    `${base};${poss};${adjacentTime}`,
    `${base};${poss};prevEndGap=${columnContext.prevEndGap}`,
    `${base};${poss};nextStartGap=${columnContext.nextStartGap}`,
    `${base};${poss};prevOverlap=${columnContext.prevOverlap};nextOverlap=${columnContext.nextOverlap}`,
    `${base};${duration};${poss};prevEndGap=${columnContext.prevEndGap};nextStartGap=${columnContext.nextStartGap}`,
    `${base};${duration};${poss};${density25};${sameTime}`,
  ];

  for (const flag of flagKeys) {
    keys.push(
      `${base};${flag}`,
      `${base};${poss};${flag}`,
      `${base};${duration};${flag}`,
      `${base};${poss};${flag};headTier=${headTier};tailTier=${tailTier}`,
      `${base};${poss};${flag};tail5=${signedBand(tail, 5)}`,
      `${base};${poss};${flag};${tailSource5}`,
      `${base};${poss};${flag};${tailSource5};${tailReleaseDelay}`,
      `${base};${poss};${flag};${cursorAdvance}`,
      `${base};${poss};${flag};${matchRel};${scanRel};${consumeRel};${tailSegRel}`,
      `${base};${poss};${flag};${releaseTail25}`,
      `${base};${poss};${flag};${density25}`,
      `${base};${poss};${flag};${adjacentTime}`,
    );
  }

  return keys;
}

function sameColumnNoteContext(
  notes: ManiaNote[],
  note: ManiaNote,
  noteIndex: number,
): {
  nextOverlap: string;
  nextStartGap: string;
  prevEndGap: string;
  prevOverlap: string;
} {
  let previous: ManiaNote | null = null;
  let next: ManiaNote | null = null;

  for (let index = noteIndex - 1; index >= 0; index--) {
    const candidate = notes[index];
    if (candidate.column === note.column) {
      previous = candidate;
      break;
    }
  }

  for (let index = noteIndex + 1; index < notes.length; index++) {
    const candidate = notes[index];
    if (candidate.column === note.column) {
      next = candidate;
      break;
    }
  }

  const previousEndGap = previous ? note.time - previous.endTime : Number.POSITIVE_INFINITY;
  const nextStartGap = next ? next.time - note.endTime : Number.POSITIVE_INFINITY;

  return {
    nextOverlap: next && next.time < note.endTime ? "yes" : "no",
    nextStartGap: timeGapBucket(nextStartGap),
    prevEndGap: timeGapBucket(previousEndGap),
    prevOverlap: previous && previous.endTime > note.time ? "yes" : "no",
  };
}

function timeGapBucket(gap: number): string {
  if (!Number.isFinite(gap)) return "none";
  const rounded = Math.round(gap);
  if (rounded < -128) return "<-128";
  if (rounded < -64) return "-128..-65";
  if (rounded < -32) return "-64..-33";
  if (rounded < -16) return "-32..-17";
  if (rounded < 0) return "-16..-1";
  if (rounded === 0) return "0";
  if (rounded <= 8) return "1..8";
  if (rounded <= 16) return "9..16";
  if (rounded <= 32) return "17..32";
  if (rounded <= 64) return "33..64";
  if (rounded <= 128) return "65..128";
  return ">128";
}

function eventDensity(events: ReplayJudgementEvent[], time: number, radius: number): number {
  return events.filter((event) => Math.abs(event.time - time) <= radius).length;
}

function sameTimeEventCount(events: ReplayJudgementEvent[], time: number): number {
  return events.filter((event) => Math.round(event.time) === Math.round(time)).length;
}

function densityBucket(count: number): string {
  if (count <= 1) return "1";
  if (count <= 2) return "2";
  if (count <= 4) return "3-4";
  if (count <= 8) return "5-8";
  return "9+";
}

function adjacentEventTimeBucket(events: ReplayJudgementEvent[], ordinal: number): string {
  const event = events[ordinal - 1];
  if (!event) return "none";
  const previous = events[ordinal - 2];
  const next = events[ordinal];
  const previousGap = previous ? Math.abs(event.time - previous.time) : Number.POSITIVE_INFINITY;
  const nextGap = next ? Math.abs(next.time - event.time) : Number.POSITIVE_INFINITY;
  const gap = Math.min(previousGap, nextGap);
  if (!Number.isFinite(gap)) return "edge";
  if (gap <= 1) return "same";
  if (gap <= 8) return "<=8";
  if (gap <= 16) return "<=16";
  if (gap <= 32) return "<=32";
  return ">32";
}

function buildSuiteJudgmentTokens(
  capture: CaptureSegment,
  simulation: SimulationResult,
  minTotal: number,
  maxTotal: number,
): SuiteJudgmentToken[] {
  const tokens: SuiteJudgmentToken[] = [];
  const judgments: Judgment[] = [1, 2, 3, 4, 5, 6];
  let previous: PlaySnapshot | null = null;

  for (const sample of capture.samples) {
    const previousCounts = previous?.counts ?? emptyReplayHitCounts();
    const previousTotal = previous?.total ?? 0;
    const delta = diffReplayHitCounts(sample.counts, previousCounts);
    const remaining = cloneCounts(delta);
    const orderedJudgments: Judgment[] = [];

    for (let ordinal = previousTotal + 1; ordinal <= sample.total; ordinal++) {
      const judgment = simulation.events[ordinal - 1]?.judgment as Judgment | null | undefined;
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
      if (ordinal < minTotal || ordinal > maxTotal) continue;
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

    previous = sample;
  }

  return tokens;
}

function buildSuiteJudgmentAlignment(
  simulation: SimulationResult,
  tokens: SuiteJudgmentToken[],
  simOrdinals: number[],
): SuiteAlignmentOp[] {
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

  const ops: SuiteAlignmentOp[] = [];
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

function buildSuiteAlignmentChunks(ops: SuiteAlignmentOp[]): SuiteAlignmentChunk[] {
  const chunks: SuiteAlignmentChunk[] = [];
  let current: SuiteAlignmentChunk | null = null;
  let lastMatch: SuiteAlignmentMatch | undefined;

  const flush = (after?: SuiteAlignmentMatch) => {
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

function chunkPairSummary(suiteCase: SuiteCase, chunk: SuiteAlignmentChunk): string {
  const pairs = new Map<string, number>();
  const pairCount = Math.min(chunk.simOrdinals.length, chunk.targetTokens.length);

  for (let index = 0; index < pairCount; index++) {
    const from = suiteCase.simulation.events[chunk.simOrdinals[index] - 1]?.judgment ?? null;
    const to = chunk.targetTokens[index].judgment;
    if (from == null || from === to) continue;
    const key = `${from}->${to}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  return pairs.size === 0
    ? "none"
    : [...pairs.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => `${key}x${count}`)
      .join(",");
}

function compactEvent(suiteCase: SuiteCase, ordinal: number): string {
  const event = suiteCase.simulation.events[ordinal - 1];
  if (!event) return `#${ordinal} <missing>`;
  const note = suiteCase.simulation.notes[event.noteIndex];
  const state = suiteCase.simulation.noteStates[event.noteIndex];
  const flags = compactStateFlags(state);
  return `#${ordinal} j=${event.judgment} ${event.part} c${note.column} n${event.noteIndex} `
    + `${Math.round(note.time)}-${Math.round(note.endTime)} h=${roundedOffset(state, "head", true)} `
    + `t=${roundedOffset(state, "tail", true)} poss=${event.possibleJudgments?.join("") ?? "-"}`
    + (flags ? ` flags=${flags}` : "");
}

function compactToken(token: SuiteJudgmentToken): string {
  const scoreDelta = token.scoreDelta == null
    ? ""
    : ` scoreDelta=${token.scoreDelta > 0 ? "+" : ""}${token.scoreDelta}`;
  return `#${token.ordinal} row=${token.row} t=${Math.round(token.time)} j=${token.judgment} `
    + `rowDelta=${formatCounts(token.rowDelta)}${scoreDelta}`;
}

function chunkSignature(suiteCase: SuiteCase, chunk: SuiteAlignmentChunk): string {
  const simCounts = countOrdinals(suiteCase.simulation, chunk.simOrdinals);
  const targetCounts = countTokens(chunk.targetTokens);
  const simFeatures = chunk.simOrdinals
    .slice(0, 3)
    .map((ordinal) => {
      const event = suiteCase.simulation.events[ordinal - 1];
      if (!event) return "missing";
      const note = suiteCase.simulation.notes[event.noteIndex];
      const state = suiteCase.simulation.noteStates[event.noteIndex];
      const flags = compactStateFlags(state) || "none";
      return `${event.judgment}:${event.part}:bb=${bodyBreakBucket(state)}:poss=${event.possibleJudgments?.join("") ?? "-"}:dur=${durationBucket(note.endTime - note.time, suiteCase.simulation.windows)}:flags=${flags}`;
    })
    .join("|") || "none";
  const targetRows = chunk.targetTokens
    .slice(0, 3)
    .map((token) => `${token.judgment}:row=${formatCounts(token.rowDelta)}:score=${token.scoreDelta ?? "?"}`)
    .join("|") || "none";
  return `pairs=${chunkPairSummary(suiteCase, chunk)};sim=${formatCounts(simCounts)};target=${formatCounts(targetCounts)};events=${simFeatures};rows=${targetRows}`;
}

function chunkTimeCounts(suiteCase: SuiteCase, chunk: SuiteAlignmentChunk): ReplayHitCounts | null {
  if (chunk.targetTokens.length === 0) return null;
  const startTime = chunk.before?.token.time ?? Number.NEGATIVE_INFINITY;
  const endTime = chunk.targetTokens[chunk.targetTokens.length - 1].time;
  return countEventsInTimeWindow(suiteCase.simulation, startTime, endTime);
}

function chunkTimeOrdinals(suiteCase: SuiteCase, chunk: SuiteAlignmentChunk): number[] {
  if (chunk.targetTokens.length === 0) return [];
  const startTime = chunk.before?.token.time ?? Number.NEGATIVE_INFINITY;
  const endTime = chunk.targetTokens[chunk.targetTokens.length - 1].time;
  return eventOrdinalsInTimeWindow(suiteCase.simulation, startTime, endTime);
}

function printAlignmentSuite(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite alignment chunks");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  const aggregate = new Map<string, {
    cases: Set<string>;
    chunks: number;
    distance: number;
    examples: string[];
  }>();
  const timeAggregate = new Map<string, {
    cases: Set<string>;
    chunks: number;
    distance: number;
    examples: string[];
  }>();

  for (const suiteCase of cases) {
    const maxTotal = Math.min(suiteCase.capture.maxTotal, suiteCase.simulation.events.length);
    const tokens = buildSuiteJudgmentTokens(suiteCase.capture, suiteCase.simulation, 1, maxTotal);
    const simOrdinals = Array.from({ length: maxTotal }, (_, index) => index + 1);
    const ops = buildSuiteJudgmentAlignment(suiteCase.simulation, tokens, simOrdinals);
    const chunks = buildSuiteAlignmentChunks(ops);
    const interesting = chunks
      .map((chunk) => {
        const simCounts = countOrdinals(suiteCase.simulation, chunk.simOrdinals);
        const targetCounts = countTokens(chunk.targetTokens);
        const diff = diffReplayHitCounts(simCounts, targetCounts);
        const timeCounts = chunkTimeCounts(suiteCase, chunk);
        const timeDiff = timeCounts == null ? null : diffReplayHitCounts(timeCounts, targetCounts);
        return {
          chunk,
          diff,
          distance: countDistance(diff),
          timeDiff,
          timeDistance: timeDiff == null ? null : countDistance(timeDiff),
        };
      })
      .filter((entry) => entry.distance > 0)
      .sort((a, b) => b.distance - a.distance
        || (a.chunk.simOrdinals[0] ?? Number.POSITIVE_INFINITY) - (b.chunk.simOrdinals[0] ?? Number.POSITIVE_INFINITY)
        || (a.chunk.targetTokens[0]?.ordinal ?? Number.POSITIVE_INFINITY) - (b.chunk.targetTokens[0]?.ordinal ?? Number.POSITIVE_INFINITY));
    const matched = ops.filter((op) => op.type === "match").length;
    const unmatchedSim = ops.filter((op) => op.type === "sim").length;
    const unmatchedTarget = ops.filter((op) => op.type === "target").length;
    const timeExactChunks = interesting.filter((entry) => entry.timeDistance === 0).length;
    const timeCheckedChunks = interesting.filter((entry) => entry.timeDistance != null).length;

    console.log(
      `\n${suiteCase.spec.label}: target ${formatCounts(suiteCase.targetCounts)} sim ${formatCounts(suiteCase.currentCounts)} `
      + `diff ${formatDiff(suiteCase.diff)}${suiteCase.spec.exactVeto ? " veto" : ""}${countsEqual(suiteCase.targetCounts, suiteCase.currentCounts) ? " exact" : ""}`,
    );
    console.log(
      `  matched ${matched}/${tokens.length}, unmatched sim ${unmatchedSim}, target ${unmatchedTarget}, `
      + `nonzero chunks ${interesting.length}, time-exact row windows ${timeExactChunks}/${timeCheckedChunks}`,
    );

    for (const entry of interesting) {
      const chunk = entry.chunk;
      const simRange = chunk.simOrdinals.length > 0
        ? `${chunk.simOrdinals[0]}-${chunk.simOrdinals[chunk.simOrdinals.length - 1]}`
        : "-";
      const targetRange = chunk.targetTokens.length > 0
        ? `${chunk.targetTokens[0].ordinal}-${chunk.targetTokens[chunk.targetTokens.length - 1].ordinal}`
        : "-";
      const rowRange = chunk.targetTokens.length > 0
        ? `${chunk.targetTokens[0].row}-${chunk.targetTokens[chunk.targetTokens.length - 1].row}`
        : "-";

      if (interesting.indexOf(entry) < options.limit) {
        console.log(
          `  chunk sim#${simRange} target#${targetRange} rows ${rowRange} `
          + `diff ${formatDiff(entry.diff)}`
          + (entry.timeDiff == null ? "" : ` timeDiff ${formatDiff(entry.timeDiff)}`)
          + ` pairs ${chunkPairSummary(suiteCase, chunk)}`,
        );
        for (const ordinal of chunk.simOrdinals.slice(0, Math.min(3, options.limit))) {
          console.log(`    sim ${compactEvent(suiteCase, ordinal)}`);
        }
        for (const token of chunk.targetTokens.slice(0, Math.min(3, options.limit))) {
          console.log(`    tgt ${compactToken(token)}`);
        }
      }

      const signature = chunkSignature(suiteCase, chunk);
      const current = aggregate.get(signature) ?? {
        cases: new Set<string>(),
        chunks: 0,
        distance: 0,
        examples: [],
      };
      current.cases.add(suiteCase.spec.label);
      current.chunks++;
      current.distance += entry.distance;
      if (current.examples.length < 3) {
        current.examples.push(`${suiteCase.spec.label} sim#${simRange} target#${targetRange} diff ${formatDiff(entry.diff)}`);
      }
      aggregate.set(signature, current);

      if (entry.timeDiff != null && countDistance(entry.timeDiff) > 0) {
        const timeOrdinals = chunkTimeOrdinals(suiteCase, chunk);
        const timeChunk: SuiteAlignmentChunk = {
          before: chunk.before,
          ops: [],
          simOrdinals: timeOrdinals,
          targetTokens: chunk.targetTokens,
        };
        const timeSignature = chunkSignature(suiteCase, timeChunk);
        const timeCurrent = timeAggregate.get(timeSignature) ?? {
          cases: new Set<string>(),
          chunks: 0,
          distance: 0,
          examples: [],
        };
        timeCurrent.cases.add(suiteCase.spec.label);
        timeCurrent.chunks++;
        timeCurrent.distance += countDistance(entry.timeDiff);
        if (timeCurrent.examples.length < 3) {
          const timeRange = timeOrdinals.length > 0
            ? `${timeOrdinals[0]}-${timeOrdinals[timeOrdinals.length - 1]}`
            : "-";
          timeCurrent.examples.push(
            `${suiteCase.spec.label} timeSim#${timeRange} target#${targetRange} timeDiff ${formatDiff(entry.timeDiff)}`,
          );
        }
        timeAggregate.set(timeSignature, timeCurrent);
      }
    }
  }

  const grouped = [...aggregate.entries()]
    .sort((a, b) => b[1].cases.size - a[1].cases.size
      || b[1].distance - a[1].distance
      || b[1].chunks - a[1].chunks
      || a[0].localeCompare(b[0]));

  console.log("\nRepeated chunk signatures:");
  for (const [signature, summary] of grouped.slice(0, options.limit)) {
    console.log(
      `  cases ${summary.cases.size} chunks ${summary.chunks} distance ${summary.distance} `
      + `${[...summary.cases].join(", ")} :: ${signature}`,
    );
    for (const example of summary.examples) console.log(`    ${example}`);
  }

  const timeGrouped = [...timeAggregate.entries()]
    .sort((a, b) => b[1].cases.size - a[1].cases.size
      || b[1].distance - a[1].distance
      || b[1].chunks - a[1].chunks
      || a[0].localeCompare(b[0]));

  console.log("\nRepeated time-window residual signatures:");
  for (const [signature, summary] of timeGrouped.slice(0, options.limit)) {
    console.log(
      `  cases ${summary.cases.size} chunks ${summary.chunks} distance ${summary.distance} `
      + `${[...summary.cases].join(", ")} :: ${signature}`,
    );
    for (const example of summary.examples) console.log(`    ${example}`);
  }
}

function printExposureSuite(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite exposure carry");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  const aggregate = new Map<string, {
    count: number;
    examples: ExposureRun[];
    maxAbs: number;
    maxRows: number;
    rows: number;
  }>();

  for (const suiteCase of cases) {
    const runs: ExposureRun[] = [];
    const open = new Map<Judgment, ExposureRun>();
    let carry = emptyReplayHitCounts();
    let previousSample: PlaySnapshot | null = null;
    let nonzeroRows = 0;
    let rowDistance = 0;
    const simOnly = emptyReplayHitCounts();
    const targetOnly = emptyReplayHitCounts();

    for (const sample of suiteCase.capture.samples) {
      const previousTime = previousSample?.time ?? Number.NEGATIVE_INFINITY;
      const previousCounts = previousSample?.counts ?? emptyReplayHitCounts();
      const capDelta = subtractCounts(sample.counts, previousCounts);
      const timeDelta = subtractCounts(
        countsAtTime(suiteCase, sample.time),
        countsAtTime(suiteCase, previousTime),
      );
      const rowDiff = diffReplayHitCounts(timeDelta, capDelta);
      const distance = countDistance(rowDiff);

      if (distance > 0) {
        nonzeroRows++;
        rowDistance += distance;
        for (const judgment of [1, 2, 3, 4, 5, 6] as Judgment[]) {
          const value = judgmentCount(rowDiff, judgment);
          if (value > 0) addJudgmentValue(simOnly, judgment, value);
          else if (value < 0) addJudgmentValue(targetOnly, judgment, -value);
        }
      }

      const nextCarry = addCounts(carry, rowDiff);
      for (const judgment of [1, 2, 3, 4, 5, 6] as Judgment[]) {
        const before = judgmentCount(carry, judgment);
        const after = judgmentCount(nextCarry, judgment);
        const current = open.get(judgment);

        if (before === 0 && after !== 0) {
          open.set(judgment, {
            caseLabel: suiteCase.spec.label,
            closed: false,
            endTime: sample.time,
            endTotal: sample.total,
            judgment,
            maxAbs: Math.abs(after),
            rows: 1,
            sign: Math.sign(after),
            startTime: sample.time,
            startTotal: sample.total,
          });
        } else if (before !== 0 && after === 0) {
          if (current) {
            current.closed = true;
            current.endTime = sample.time;
            current.endTotal = sample.total;
            current.rows++;
            runs.push(current);
            open.delete(judgment);
          }
        } else if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) {
          if (current) {
            current.closed = true;
            current.endTime = sample.time;
            current.endTotal = sample.total;
            current.rows++;
            runs.push(current);
          }
          open.set(judgment, {
            caseLabel: suiteCase.spec.label,
            closed: false,
            endTime: sample.time,
            endTotal: sample.total,
            judgment,
            maxAbs: Math.abs(after),
            rows: 1,
            sign: Math.sign(after),
            startTime: sample.time,
            startTotal: sample.total,
          });
        } else if (current && after !== 0) {
          current.endTime = sample.time;
          current.endTotal = sample.total;
          current.maxAbs = Math.max(current.maxAbs, Math.abs(after));
          current.rows++;
        }
      }

      carry = nextCarry;
      previousSample = sample;
    }

    for (const run of open.values()) runs.push(run);
    const closedRuns = runs.filter((run) => run.closed);
    const openRuns = runs.filter((run) => !run.closed);
    const longestOpen = [...openRuns]
      .sort((a, b) => b.rows - a.rows || b.maxAbs - a.maxAbs || a.startTime - b.startTime)
      .slice(0, options.limit);
    const longestClosed = [...closedRuns]
      .sort((a, b) => b.rows - a.rows || b.maxAbs - a.maxAbs || a.startTime - b.startTime)
      .slice(0, options.limit);

    console.log(
      `\n${suiteCase.spec.label}: target ${formatCounts(suiteCase.targetCounts)} sim ${formatCounts(suiteCase.currentCounts)} `
      + `final ${formatDiff(suiteCase.diff)} rowDiffRows ${nonzeroRows}/${suiteCase.capture.samples.length} `
      + `rowDistance ${rowDistance} carryFinal ${formatDiff(carry)}`,
    );
    console.log(`  sim-only row entries ${formatCounts(simOnly)}; target-only row entries ${formatCounts(targetOnly)}`);
    console.log(`  exposure runs closed ${closedRuns.length}, open ${openRuns.length}`);

    for (const run of longestOpen) {
      console.log(`  open ${formatExposureRun(run)}`);
      for (const detail of formatExposureRunStartContext(suiteCase, run)) {
        console.log(`    ${detail}`);
      }
    }
    for (const run of longestClosed) {
      console.log(`  closed ${formatExposureRun(run)}`);
    }

    for (const run of runs) {
      const key = `${run.sign > 0 ? "sim-early" : "target-early"}:${judgmentLabel(run.judgment)}:${run.closed ? "closed" : "open"}`;
      const current = aggregate.get(key) ?? {
        count: 0,
        examples: [],
        maxAbs: 0,
        maxRows: 0,
        rows: 0,
      };
      current.count++;
      current.rows += run.rows;
      current.maxRows = Math.max(current.maxRows, run.rows);
      current.maxAbs = Math.max(current.maxAbs, run.maxAbs);
      if (current.examples.length < 3) current.examples.push(run);
      aggregate.set(key, current);
    }
  }

  const grouped = [...aggregate.entries()]
    .sort((a, b) => b[1].count - a[1].count
      || b[1].maxRows - a[1].maxRows
      || b[1].maxAbs - a[1].maxAbs
      || a[0].localeCompare(b[0]));

  console.log("\nExposure run aggregate:");
  for (const [key, summary] of grouped.slice(0, options.limit)) {
    console.log(
      `  ${key} count ${summary.count} rows ${summary.rows} maxRows ${summary.maxRows} maxAbs ${summary.maxAbs}`,
    );
    for (const example of summary.examples) console.log(`    ${formatExposureRun(example)}`);
  }
}

interface BatchMismatch {
  capDelta: ReplayHitCounts;
  caseLabel: string;
  ordinalDelta: ReplayHitCounts;
  ordinalDiff: ReplayHitCounts;
  ordinalEvents: string;
  previousSequence: number;
  previousTime: number;
  previousTotal: number;
  sequence: number;
  time: number;
  timeDelta: ReplayHitCounts;
  timeDiff: ReplayHitCounts;
  timeEvents: string;
  total: number;
}

interface CarryUnit {
  caseLabel: string;
  judgment: Judgment;
  ordinalEvents: string;
  rowDiff: ReplayHitCounts;
  sequence: number;
  sign: 1 | -1;
  time: number;
  timeEvents: string;
  total: number;
}

interface ClosedCarryUnit extends CarryUnit {
  closeSequence: number;
  closeTime: number;
  closeTotal: number;
  rows: number;
}

function printCarrySuite(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite row carry pairing");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  const openFeatureAggregate = new Map<string, {
    cases: Set<string>;
    count: number;
    examples: string[];
  }>();

  for (const suiteCase of cases) {
    const { changedRows, closed, openUnits, rowDistance } = collectCarryUnits(suiteCase);
    const closedLong = closed
      .sort((a, b) => b.rows - a.rows || b.closeTotal - a.closeTotal || a.total - b.total)
      .slice(0, options.limit);
    const openSorted = openUnits
      .sort((a, b) => a.total - b.total || a.judgment - b.judgment || a.sign - b.sign)
      .slice(0, options.limit);

    console.log(
      `\n${suiteCase.spec.label}: changedRows ${changedRows} rowDistance ${rowDistance} `
      + `closedUnits ${closed.length} openUnits ${openUnits.length} final ${formatDiff(suiteCase.diff)}`,
    );
    console.log(`  open summary ${formatCarryUnitSummary(openUnits)}`);

    for (const unit of openSorted) {
      console.log(`  open ${formatCarryUnit(unit)}`);
      console.log(`    time events ${unit.timeEvents}`);
      console.log(`    ordinal events ${unit.ordinalEvents}`);
    }
    for (const unit of openUnits) {
      for (const key of carryUnitFeatureKeys(suiteCase, unit)) {
        const current = openFeatureAggregate.get(key) ?? { cases: new Set<string>(), count: 0, examples: [] };
        current.cases.add(suiteCase.spec.label);
        current.count++;
        if (current.examples.length < 3) current.examples.push(`${suiteCase.spec.label} ${formatCarryUnit(unit)}`);
        openFeatureAggregate.set(key, current);
      }
    }
    for (const unit of closedLong) {
      console.log(`  closed ${formatClosedCarryUnit(unit)}`);
    }
  }

  const grouped = [...openFeatureAggregate.entries()]
    .sort((a, b) => b[1].cases.size - a[1].cases.size
      || b[1].count - a[1].count
      || a[0].localeCompare(b[0]));
  console.log("\nOpen carry feature aggregate:");
  for (const [key, summary] of grouped.slice(0, options.limit)) {
    console.log(`  cases ${summary.cases.size} count ${summary.count} ${[...summary.cases].join(", ")} :: ${key}`);
    for (const example of summary.examples) console.log(`    ${example}`);
  }
}

function collectCarryUnits(suiteCase: SuiteCase): {
  changedRows: number;
  closed: ClosedCarryUnit[];
  openUnits: CarryUnit[];
  rowDistance: number;
} {
  const open = new Map<string, CarryUnit[]>();
  const closed: ClosedCarryUnit[] = [];
  let previous = suiteCase.capture.samples[0];
  let changedRows = 0;
  let rowDistance = 0;

  for (const sample of suiteCase.capture.samples.slice(1)) {
    if (countsEqual(sample.counts, previous.counts)) continue;
    changedRows++;

    const capDelta = subtractCounts(sample.counts, previous.counts);
    const timeDelta = subtractCounts(
      countsAtTime(suiteCase, sample.time),
      countsAtTime(suiteCase, previous.time),
    );
    const rowDiff = diffReplayHitCounts(timeDelta, capDelta);
    rowDistance += countDistance(rowDiff);
    const timeOrdinals = eventOrdinalsInTimeWindow(suiteCase.simulation, previous.time, sample.time);
    const ordinalEvents: string[] = [];
    const ordinalStart = Math.max(1, previous.total + 1);
    const ordinalEnd = Math.min(suiteCase.simulation.events.length, sample.total);
    for (let ordinal = ordinalStart; ordinal <= ordinalEnd && ordinalEvents.length < 8; ordinal++) {
      ordinalEvents.push(compactEvent(suiteCase, ordinal));
    }

    for (const judgment of [1, 2, 3, 4, 5, 6] as Judgment[]) {
      let value = judgmentCount(rowDiff, judgment);
      while (value !== 0) {
        const sign = value > 0 ? 1 : -1;
        const oppositeKey = carryKey(judgment, sign > 0 ? -1 : 1);
        const opposite = open.get(oppositeKey);
        const matched = opposite?.shift();
        if (matched) {
          closed.push({
            ...matched,
            closeSequence: sample.sequence,
            closeTime: sample.time,
            closeTotal: sample.total,
            rows: sample.sequence - matched.sequence,
          });
          if (opposite && opposite.length === 0) open.delete(oppositeKey);
        } else {
          const key = carryKey(judgment, sign);
          const list = open.get(key) ?? [];
          list.push({
            caseLabel: suiteCase.spec.label,
            judgment,
            ordinalEvents: ordinalEvents.join(" | ") || "<none>",
            rowDiff,
            sequence: sample.sequence,
            sign,
            time: sample.time,
            timeEvents: timeOrdinals.slice(-8).map((ordinal) => compactEvent(suiteCase, ordinal)).join(" | ") || "<none>",
            total: sample.total,
          });
          open.set(key, list);
        }
        value -= sign;
      }
    }

    previous = sample;
  }

  return {
    changedRows,
    closed,
    openUnits: [...open.values()].flat(),
    rowDistance,
  };
}

function printOpenCarrySearch(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite open-carry seeded feature search");
  console.log(
    `Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}, `
    + `mode: ${options.mode}, maxDepth: ${options.maxDepth}, perNeed: ${options.perNeedLimit}, maxNodes: ${options.maxNodes}`,
  );
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  const seededLabels = openCarrySeedLabels(cases);
  const allCandidates = buildCandidateRules(cases, options);
  const candidates = allCandidates.filter((rule) => seededLabels.has(rule.label));

  console.log("\nBase cases:");
  for (const suiteCase of cases) {
    const { openUnits } = collectCarryUnits(suiteCase);
    console.log(
      `  ${suiteCase.spec.label.padEnd(22)} `
      + `target ${formatCounts(suiteCase.targetCounts)} sim ${formatCounts(suiteCase.currentCounts)} `
      + `diff ${formatDiff(suiteCase.diff)} openCarry ${formatCarryUnitSummary(openUnits)} `
      + `${suiteCase.spec.exactVeto ? "veto " : ""}`
      + `${countsEqual(suiteCase.targetCounts, suiteCase.currentCounts) ? "exact" : ""}`,
    );
  }

  console.log(`\nSeeded feature rules: ${seededLabels.size}`);
  console.log(`Candidate rules after ${options.mode} pruning: ${candidates.length} (from ${allCandidates.length} global candidates)`);
  for (const rule of candidates.slice(0, Math.min(options.limit, 16))) {
    const next = addVectors(suiteDiffVector(cases), ruleDeltaVector(rule));
    console.log(
      `  ${rule.label} changes ${totalChanges(rule)} `
      + `residual ${distanceVector(suiteDiffVector(cases))}->${distanceVector(next)} `
      + `visible ${suiteVisibleDistance(cases, suiteDiffVector(cases))}->${suiteVisibleDistance(cases, next)} `
      + `fit +${rule.ordinalFitImprovement}/${rule.timeFitImprovement} `
      + `${formatLocalSupport(rule)} `
      + `${formatChangeList(cases, rule)}`,
    );
  }

  const exactSearch = searchExactSolutions(candidates, cases, options);
  if (exactSearch.solutions.length > 0) {
    console.log(`\nExact ${options.mode} open-carry seeded solutions: ${exactSearch.solutions.length} (visited ${exactSearch.visitedNodes}${exactSearch.hitNodeCap ? ", hit node cap" : ""})`);
    exactSearch.solutions.forEach((solution, index) => printSolution(cases, solution, index));
    return;
  }

  console.log(`\nExact ${options.mode} open-carry seeded solutions: none (visited ${exactSearch.visitedNodes}${exactSearch.hitNodeCap ? ", hit node cap" : ""})`);
  console.log("\nClosest open-carry seeded partial combinations:");
  const partials = beamPartialSolutions(candidates, cases, options);
  if (partials.length === 0) {
    console.log("  none");
    return;
  }
  partials.forEach((solution, index) => printSolution(cases, solution, index));
}

interface EventPatchCandidate {
  change: RuleChange;
  explicit: boolean;
  feature: string;
  from: Judgment;
  local: LocalChangeSupport;
  openContextHits: number;
  to: Judgment;
}

function printEventPatchSearch(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite event-level open-carry patch search");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }
  console.log("This is diagnostic-only: it searches individual local events, not production feature rules.");

  const selectedFeatureAggregate = new Map<string, {
    cases: Set<string>;
    count: number;
    examples: string[];
  }>();
  const selectedAllFeatureAggregate = new Map<string, {
    cases: Set<string>;
    count: number;
    examples: string[];
  }>();

  for (const suiteCase of cases) {
    if (suiteCase.spec.exactVeto || countDistance(suiteCase.diff) === 0) {
      console.log(
        `\n${suiteCase.spec.label}: skipped `
        + `${suiteCase.spec.exactVeto ? "veto " : ""}${countsEqual(suiteCase.targetCounts, suiteCase.currentCounts) ? "exact" : ""}`.trim(),
      );
      continue;
    }

    const baseResidual = cloneCounts(suiteCase.diff);
    const used = new Set<number>();
    const selected: EventPatchCandidate[] = [];
    const transitions = neededTransitions([suiteCase]);
    const openUnits = collectCarryUnits(suiteCase).openUnits;

    console.log(
      `\n${suiteCase.spec.label}: target ${formatCounts(suiteCase.targetCounts)} sim ${formatCounts(suiteCase.currentCounts)} `
      + `diff ${formatDiff(suiteCase.diff)} openCarry ${formatCarryUnitSummary(openUnits)}`,
    );

    for (const transition of transitions) {
      const needed = Math.min(
        Math.max(0, judgmentCount(baseResidual, transition.from)),
        Math.max(0, -judgmentCount(baseResidual, transition.to)),
      );
      if (needed <= 0) continue;

      const candidates = eventPatchCandidatesForTransition(cases, suiteCase, openUnits, transition.from, transition.to, used, options);
      const chosen = candidates.slice(0, needed);
      for (const candidate of chosen) {
        selected.push(candidate);
        used.add(candidate.change.ordinal);
        addJudgmentValue(baseResidual, transition.from, -1);
        addJudgmentValue(baseResidual, transition.to, 1);
        const key = `${judgmentLabel(candidate.from)}->${judgmentLabel(candidate.to)} `
          + `${candidate.explicit ? "explicit" : "implicit"} ${candidate.feature}`;
        const current = selectedFeatureAggregate.get(key) ?? { cases: new Set<string>(), count: 0, examples: [] };
        current.cases.add(suiteCase.spec.label);
        current.count++;
        if (current.examples.length < 3) current.examples.push(`${suiteCase.spec.label} ${compactEvent(suiteCase, candidate.change.ordinal)}`);
        selectedFeatureAggregate.set(key, current);

        for (const feature of featureKeys(suiteCase, candidate.change.event)) {
          const featureKey = `${judgmentLabel(candidate.from)}->${judgmentLabel(candidate.to)} `
            + `${candidate.explicit ? "explicit" : "implicit"} ${feature}`;
          const featureCurrent = selectedAllFeatureAggregate.get(featureKey)
            ?? { cases: new Set<string>(), count: 0, examples: [] };
          featureCurrent.cases.add(suiteCase.spec.label);
          featureCurrent.count++;
          if (featureCurrent.examples.length < 3) {
            featureCurrent.examples.push(`${suiteCase.spec.label} ${compactEvent(suiteCase, candidate.change.ordinal)}`);
          }
          selectedAllFeatureAggregate.set(featureKey, featureCurrent);
        }
      }

      console.log(
        `  need ${needed} ${judgmentLabel(transition.from)}->${judgmentLabel(transition.to)} `
        + `candidates ${candidates.length} selected ${chosen.length}`,
      );
      for (const candidate of chosen.slice(0, options.limit)) {
        console.log(`    ${formatEventPatchCandidate(cases, candidate)}`);
      }
      if (chosen.length < needed) {
        for (const candidate of candidates.slice(chosen.length, Math.min(candidates.length, chosen.length + options.limit))) {
          console.log(`    unused ${formatEventPatchCandidate(cases, candidate)}`);
        }
      }
    }

    console.log(`  selected ${selected.length} event patches, residual ${formatDiff(baseResidual)}`);
  }

  const grouped = [...selectedFeatureAggregate.entries()]
    .sort((a, b) => b[1].cases.size - a[1].cases.size || b[1].count - a[1].count || a[0].localeCompare(b[0]));

  console.log("\nSelected event-patch feature aggregate:");
  for (const [key, summary] of grouped.slice(0, options.limit)) {
    console.log(`  cases ${summary.cases.size} count ${summary.count} ${[...summary.cases].join(", ")} :: ${key}`);
    for (const example of summary.examples) console.log(`    ${example}`);
  }

  const allGrouped = [...selectedAllFeatureAggregate.entries()]
    .sort((a, b) => b[1].cases.size - a[1].cases.size || b[1].count - a[1].count || a[0].localeCompare(b[0]));

  console.log("\nSelected event-patch all-feature aggregate:");
  for (const [key, summary] of allGrouped.slice(0, options.limit)) {
    console.log(`  cases ${summary.cases.size} count ${summary.count} ${[...summary.cases].join(", ")} :: ${key}`);
    for (const example of summary.examples) console.log(`    ${example}`);
  }
}

function eventPatchCandidatesForTransition(
  cases: SuiteCase[],
  suiteCase: SuiteCase,
  openUnits: CarryUnit[],
  from: Judgment,
  to: Judgment,
  used: Set<number>,
  options: SuiteOptions,
): EventPatchCandidate[] {
  const contextHits = new Map<number, number>();
  for (const unit of openUnits) {
    if (unit.sign > 0 && unit.judgment !== from) continue;
    if (unit.sign < 0 && unit.judgment !== to) continue;
    for (const ordinal of carryContextOrdinals(suiteCase, unit)) {
      contextHits.set(ordinal, (contextHits.get(ordinal) ?? 0) + 1);
    }
  }

  const candidates: EventPatchCandidate[] = [];
  for (const [ordinal, openContextHits] of contextHits.entries()) {
    if (used.has(ordinal)) continue;
    const event = suiteCase.simulation.events[ordinal - 1];
    if (!event || event.judgment !== from) continue;
    const change: RuleChange = { caseIndex: suiteCase.index, event, ordinal };
    const local = localChangeSupport(cases, change, from, to);
    const explicit = event.possibleJudgments?.includes(to) ?? false;
    if (options.explicitOnly && !explicit) continue;
    candidates.push({
      change,
      explicit,
      feature: shortestInterestingFeature(suiteCase, event),
      from,
      local,
      openContextHits,
      to,
    });
  }

  return candidates.sort((a, b) => eventPatchSortScore(b) - eventPatchSortScore(a)
    || a.change.ordinal - b.change.ordinal);
}

interface LocalSupportFeatureAggregate {
  cases: Set<string>;
  count: number;
  exactCases: Set<string>;
  examples: string[];
  finalGain: number;
  ordinalImproves: number;
  ordinalWorsens: number;
  timeImproves: number;
  timeWorsens: number;
}

function printLocalSupportFeatureSuite(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite local-support feature aggregate");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }
  console.log("This is diagnostic-only: it aggregates event changes with local ordinal/time support.");

  const transitions = neededTransitions(cases.filter((suiteCase) => !suiteCase.spec.exactVeto && countDistance(suiteCase.diff) > 0));
  console.log(`Transitions: ${transitions.map((transition) => `${transition.from}->${transition.to}`).join(", ") || "none"}`);

  const aggregates = new Map<string, LocalSupportFeatureAggregate>();
  const allFeatureAggregates = new Map<string, LocalSupportFeatureAggregate>();

  function addAggregate(
    map: Map<string, LocalSupportFeatureAggregate>,
    key: string,
    suiteCase: SuiteCase,
    ordinal: number,
    support: LocalChangeSupport,
    finalGain: number,
  ) {
    const current = map.get(key) ?? {
      cases: new Set<string>(),
      count: 0,
      exactCases: new Set<string>(),
      examples: [],
      finalGain: 0,
      ordinalImproves: 0,
      ordinalWorsens: 0,
      timeImproves: 0,
      timeWorsens: 0,
    };
    current.cases.add(suiteCase.spec.label);
    if (countsEqual(suiteCase.targetCounts, suiteCase.currentCounts)) current.exactCases.add(suiteCase.spec.label);
    current.count++;
    current.finalGain += finalGain;
    if (support.ordinalImproves) current.ordinalImproves++;
    if (support.ordinalWorsens) current.ordinalWorsens++;
    if (support.timeImproves) current.timeImproves++;
    if (support.timeWorsens) current.timeWorsens++;
    if (current.examples.length < 4) {
      current.examples.push(`${suiteCase.spec.label} ${compactEvent(suiteCase, ordinal)}`);
    }
    map.set(key, current);
  }

  for (const suiteCase of cases) {
    const caseMatches: string[] = [];
    for (const transition of transitions) {
      suiteCase.simulation.events.forEach((event, index) => {
        if (event.judgment !== transition.from) return;
        const change: RuleChange = {
          caseIndex: suiteCase.index,
          event,
          ordinal: index + 1,
        };
        const support = localChangeSupport(cases, change, transition.from, transition.to);
        if (!support.ordinalImproves && !support.timeImproves) return;

        const finalGain = countDistance(suiteCase.diff)
          - countDistance(addCounts(suiteCase.diff, judgmentDelta(transition.from, transition.to)));
        const explicit = event.possibleJudgments?.includes(transition.to) ?? false;
        const transitionLabel = `${judgmentLabel(transition.from)}->${judgmentLabel(transition.to)} ${explicit ? "explicit" : "implicit"}`;
        addAggregate(
          aggregates,
          `${transitionLabel} ${shortestInterestingFeature(suiteCase, event)}`,
          suiteCase,
          index + 1,
          support,
          finalGain,
        );
        for (const feature of featureKeys(suiteCase, event)) {
          addAggregate(
            allFeatureAggregates,
            `${transitionLabel} ${feature}`,
            suiteCase,
            index + 1,
            support,
            finalGain,
          );
        }
        if (caseMatches.length < 6) {
          caseMatches.push(
            `${judgmentLabel(transition.from)}->${judgmentLabel(transition.to)} `
            + `${support.timeImproves ? "time+" : "time0"} ${support.ordinalImproves ? "ord+" : "ord0"} `
            + compactEvent(suiteCase, index + 1),
          );
        }
      });
    }

    console.log(
      `\n${suiteCase.spec.label}: target ${formatCounts(suiteCase.targetCounts)} sim ${formatCounts(suiteCase.currentCounts)} `
      + `diff ${formatDiff(suiteCase.diff)}`
      + `${suiteCase.spec.exactVeto ? " veto" : ""}`
      + `${countsEqual(suiteCase.targetCounts, suiteCase.currentCounts) ? " exact" : ""}`,
    );
    for (const match of caseMatches) console.log(`  ${match}`);
  }

  function printAggregate(title: string, map: Map<string, LocalSupportFeatureAggregate>) {
    console.log(`\n${title}:`);
    const rows = [...map.entries()]
      .filter(([, summary]) => summary.timeImproves > 0)
      .sort((a, b) => (
        b[1].cases.size - a[1].cases.size
        || b[1].timeImproves - a[1].timeImproves
        || b[1].finalGain - a[1].finalGain
        || b[1].count - a[1].count
        || a[0].localeCompare(b[0])
      ));
    if (rows.length === 0) {
      console.log("  <none>");
      return;
    }
    for (const [key, summary] of rows.slice(0, options.limit)) {
      console.log(
        `  cases ${summary.cases.size} exact ${summary.exactCases.size} count ${summary.count} `
        + `gain ${summary.finalGain > 0 ? "+" : ""}${summary.finalGain} `
        + `time ${summary.timeImproves}/${summary.timeWorsens} ord ${summary.ordinalImproves}/${summary.ordinalWorsens} :: ${key}`,
      );
      for (const example of summary.examples) console.log(`    ${example}`);
    }
  }

  printAggregate("Shortest-feature aggregate with time support", aggregates);
  printAggregate("All-feature aggregate with time support", allFeatureAggregates);
}

function eventPatchSortScore(candidate: EventPatchCandidate): number {
  return (candidate.explicit ? 100 : 0)
    + (candidate.local.ordinalImproves ? 30 : 0)
    + (candidate.local.timeImproves ? 30 : 0)
    - (candidate.local.ordinalWorsens ? 20 : 0)
    - (candidate.local.timeWorsens ? 20 : 0)
    + candidate.openContextHits * 5;
}

function shortestInterestingFeature(suiteCase: SuiteCase, event: ReplayJudgementEvent): string {
  return featureKeys(suiteCase, event)
    .filter((feature) => feature.includes("poss=") || feature.includes("flag="))
    .sort((a, b) => a.split(";").length - b.split(";").length || a.length - b.length || a.localeCompare(b))[0]
    ?? featureKeys(suiteCase, event)[0]
    ?? "feature=<none>";
}

function formatEventPatchCandidate(cases: SuiteCase[], candidate: EventPatchCandidate): string {
  const support = [
    candidate.local.ordinalImproves ? "ord+" : candidate.local.ordinalWorsens ? "ord-" : "ord0",
    candidate.local.timeImproves ? "time+" : candidate.local.timeWorsens ? "time-" : "time0",
    candidate.explicit ? "explicit" : "implicit",
    `ctx${candidate.openContextHits}`,
  ].join(",");
  return `${judgmentLabel(candidate.from)}->${judgmentLabel(candidate.to)} `
    + `${compactEvent(cases[candidate.change.caseIndex], candidate.change.ordinal)} `
    + `${support} ${candidate.feature}`;
}

function openCarrySeedLabels(cases: SuiteCase[]): Set<string> {
  const labels = new Set<string>();

  for (const suiteCase of cases) {
    if (suiteCase.spec.exactVeto || countDistance(suiteCase.diff) === 0) continue;
    const openUnits = collectCarryUnits(suiteCase).openUnits;
    const caseTransitions = neededTransitions([suiteCase]);

    for (const transition of caseTransitions) {
      for (const unit of openUnits) {
        if (unit.sign > 0 && unit.judgment !== transition.from) continue;
        if (unit.sign < 0 && unit.judgment !== transition.to) continue;
        for (const ordinal of carryContextOrdinals(suiteCase, unit)) {
          const event = suiteCase.simulation.events[ordinal - 1];
          if (!event || event.judgment !== transition.from) continue;
          for (const feature of featureKeys(suiteCase, event)) {
            labels.add(`${transition.from}->${transition.to} / ${feature}`);
          }
        }
      }
    }
  }

  return labels;
}

function carryContextOrdinals(suiteCase: SuiteCase, unit: CarryUnit): number[] {
  const ordinals = new Set<number>();
  for (const ordinal of compactEventOrdinals(unit.timeEvents)) ordinals.add(ordinal);
  for (const ordinal of compactEventOrdinals(unit.ordinalEvents)) ordinals.add(ordinal);
  for (let ordinal = unit.total - 2; ordinal <= unit.total + 2; ordinal++) {
    if (ordinal >= 1 && ordinal <= suiteCase.simulation.events.length) ordinals.add(ordinal);
  }
  return [...ordinals].sort((a, b) => a - b);
}

function compactEventOrdinals(value: string): number[] {
  return [...value.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function carryKey(judgment: Judgment, sign: 1 | -1): string {
  return `${judgment}:${sign}`;
}

function formatCarryUnitSummary(units: CarryUnit[]): string {
  const counts = emptyReplayHitCounts();
  for (const unit of units) addJudgmentValue(counts, unit.judgment, unit.sign);
  return formatDiff(counts);
}

function formatCarryUnit(unit: CarryUnit): string {
  const direction = unit.sign > 0 ? "sim-early" : "target-early";
  return `${direction} ${judgmentLabel(unit.judgment)} total ${unit.total} seq ${unit.sequence} `
    + `time ${Math.round(unit.time)} rowDiff ${formatDiff(unit.rowDiff)}`;
}

function formatClosedCarryUnit(unit: ClosedCarryUnit): string {
  return `${formatCarryUnit(unit)} closed total ${unit.closeTotal} seq ${unit.closeSequence} `
    + `rows ${unit.rows} closeTime ${Math.round(unit.closeTime)}`;
}

function carryUnitFeatureKeys(suiteCase: SuiteCase, unit: CarryUnit): string[] {
  const keys = [
    `${unit.sign > 0 ? "sim-early" : "target-early"} ${judgmentLabel(unit.judgment)}`,
  ];
  const event = firstCompactEventOrdinal(unit.ordinalEvents);
  if (event == null) return keys;
  const judgementEvent = suiteCase.simulation.events[event - 1];
  if (!judgementEvent) return keys;
  for (const feature of featureKeys(suiteCase, judgementEvent)) {
    keys.push(`${unit.sign > 0 ? "sim-early" : "target-early"} ${judgmentLabel(unit.judgment)} / event ${judgmentLabel(judgementEvent.judgment as Judgment)} / ${feature}`);
  }
  return keys;
}

function firstCompactEventOrdinal(value: string): number | null {
  const match = /#(\d+)/.exec(value);
  if (!match) return null;
  return Number(match[1]);
}

function printBatchSuite(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite score-row batches");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  const aggregate = new Map<string, {
    cases: Set<string>;
    count: number;
    distance: number;
    examples: BatchMismatch[];
    exactCases: Set<string>;
    mismatchCases: Set<string>;
    netExactOrdinalDiff: ReplayHitCounts;
    netExactTimeDiff: ReplayHitCounts;
    netMismatchOrdinalDiff: ReplayHitCounts;
    netMismatchTimeDiff: ReplayHitCounts;
    netOrdinalDiff: ReplayHitCounts;
    netTimeDiff: ReplayHitCounts;
    suspectFeatureCounts: Map<string, number>;
  }>();

  for (const suiteCase of cases) {
    const mismatches: BatchMismatch[] = [];
    let previous = suiteCase.capture.samples[0];
    let changedRows = 0;
    let timeMismatchRows = 0;
    let ordinalMismatchRows = 0;
    let timeDistance = 0;
    let ordinalDistance = 0;

    for (const sample of suiteCase.capture.samples.slice(1)) {
      if (countsEqual(sample.counts, previous.counts)) continue;
      changedRows++;

      const capDelta = subtractCounts(sample.counts, previous.counts);
      const timeDelta = subtractCounts(
        countsAtTime(suiteCase, sample.time),
        countsAtTime(suiteCase, previous.time),
      );
      const ordinalDelta = subtractCounts(
        countsAtOrdinal(suiteCase, sample.total),
        countsAtOrdinal(suiteCase, previous.total),
      );
      const timeDiff = diffReplayHitCounts(timeDelta, capDelta);
      const ordinalDiff = diffReplayHitCounts(ordinalDelta, capDelta);
      const timeDiffDistance = countDistance(timeDiff);
      const ordinalDiffDistance = countDistance(ordinalDiff);

      if (timeDiffDistance > 0) {
        timeMismatchRows++;
        timeDistance += timeDiffDistance;
      }
      if (ordinalDiffDistance > 0) {
        ordinalMismatchRows++;
        ordinalDistance += ordinalDiffDistance;
      }

      if (timeDiffDistance > 0 || ordinalDiffDistance > 0) {
        if (options.ordinalOnly && ordinalDiffDistance === 0) {
          previous = sample;
          continue;
        }
        const timeOrdinals = eventOrdinalsInTimeWindow(suiteCase.simulation, previous.time, sample.time);
        const ordinalStart = Math.max(1, previous.total + 1);
        const ordinalEnd = Math.min(suiteCase.simulation.events.length, sample.total);
        const ordinalEvents: string[] = [];
        for (let ordinal = ordinalStart; ordinal <= ordinalEnd && ordinalEvents.length < 8; ordinal++) {
          ordinalEvents.push(compactEvent(suiteCase, ordinal));
        }
        const mismatch: BatchMismatch = {
          capDelta,
          caseLabel: suiteCase.spec.label,
          ordinalDelta,
          ordinalDiff,
          ordinalEvents: ordinalEvents.join(" | ") || "<none>",
          previousSequence: previous.sequence,
          previousTime: previous.time,
          previousTotal: previous.total,
          sequence: sample.sequence,
          time: sample.time,
          timeDelta,
          timeDiff,
          timeEvents: timeOrdinals.slice(-8).map((ordinal) => compactEvent(suiteCase, ordinal)).join(" | ") || "<none>",
          total: sample.total,
        };
        mismatches.push(mismatch);

        const signature = `cap ${formatCounts(capDelta)} timeDiff ${formatDiff(timeDiff)} ordDiff ${formatDiff(ordinalDiff)}`;
        const current = aggregate.get(signature) ?? {
          cases: new Set<string>(),
          count: 0,
          distance: 0,
          examples: [],
          exactCases: new Set<string>(),
          mismatchCases: new Set<string>(),
          netExactOrdinalDiff: emptyReplayHitCounts(),
          netExactTimeDiff: emptyReplayHitCounts(),
          netMismatchOrdinalDiff: emptyReplayHitCounts(),
          netMismatchTimeDiff: emptyReplayHitCounts(),
          netOrdinalDiff: emptyReplayHitCounts(),
          netTimeDiff: emptyReplayHitCounts(),
          suspectFeatureCounts: new Map<string, number>(),
        };
        const finalExact = countsEqual(suiteCase.targetCounts, suiteCase.currentCounts);
        current.cases.add(suiteCase.spec.label);
        current.count++;
        current.distance += timeDiffDistance + ordinalDiffDistance;
        current.netOrdinalDiff = addCounts(current.netOrdinalDiff, ordinalDiff);
        current.netTimeDiff = addCounts(current.netTimeDiff, timeDiff);
        if (finalExact) {
          current.exactCases.add(suiteCase.spec.label);
          current.netExactOrdinalDiff = addCounts(current.netExactOrdinalDiff, ordinalDiff);
          current.netExactTimeDiff = addCounts(current.netExactTimeDiff, timeDiff);
        } else {
          current.mismatchCases.add(suiteCase.spec.label);
          current.netMismatchOrdinalDiff = addCounts(current.netMismatchOrdinalDiff, ordinalDiff);
          current.netMismatchTimeDiff = addCounts(current.netMismatchTimeDiff, timeDiff);
        }
        if (current.examples.length < 3) current.examples.push(mismatch);
        addOrdinalDiffFeatureSuspects(current.suspectFeatureCounts, suiteCase, previous.total, sample.total, ordinalDiff);
        aggregate.set(signature, current);
      }

      previous = sample;
    }

    console.log(
      `\n${suiteCase.spec.label}: changedRows ${changedRows}, timeMismatch ${timeMismatchRows} `
      + `dist ${timeDistance}, ordinalMismatch ${ordinalMismatchRows} dist ${ordinalDistance}, `
      + `final ${formatDiff(suiteCase.diff)}`,
    );
    for (const mismatch of mismatches.slice(0, options.limit)) {
      console.log(formatBatchMismatch(mismatch));
    }
  }

  const grouped = [...aggregate.entries()]
    .sort((a, b) => b[1].cases.size - a[1].cases.size
      || b[1].distance - a[1].distance
      || b[1].count - a[1].count
      || a[0].localeCompare(b[0]));

  console.log("\nRepeated batch signatures:");
  for (const [signature, summary] of grouped.slice(0, options.limit)) {
    console.log(
      `  cases ${summary.cases.size} rows ${summary.count} distance ${summary.distance} `
      + `netTime ${formatDiff(summary.netTimeDiff)} netOrd ${formatDiff(summary.netOrdinalDiff)} `
      + `${[...summary.cases].join(", ")} :: ${signature}`,
    );
    for (const example of summary.examples) {
      console.log(`    ${formatBatchMismatchSummary(example)}`);
    }
  }

  const residueGrouped = [...aggregate.entries()]
    .map(([signature, summary]) => ({
      signature,
      summary,
      exactDistance: countDistance(summary.netExactOrdinalDiff),
      mismatchDistance: countDistance(summary.netMismatchOrdinalDiff),
    }))
    .filter((entry) => entry.mismatchDistance > 0)
    .sort((a, b) => b.mismatchDistance - a.mismatchDistance
      || a.exactDistance - b.exactDistance
      || b.summary.mismatchCases.size - a.summary.mismatchCases.size
      || b.summary.count - a.summary.count
      || a.signature.localeCompare(b.signature));

  console.log("\nResidue-contrast batch signatures:");
  for (const { signature, summary, exactDistance, mismatchDistance } of residueGrouped.slice(0, options.limit)) {
    console.log(
      `  mismatchDist ${mismatchDistance} exactDist ${exactDistance} `
      + `mismatchCases ${summary.mismatchCases.size} exactCases ${summary.exactCases.size} `
      + `netMismatchOrd ${formatDiff(summary.netMismatchOrdinalDiff)} `
      + `netExactOrd ${formatDiff(summary.netExactOrdinalDiff)} :: ${signature}`,
    );
    for (const example of summary.examples) {
      console.log(`    ${formatBatchMismatchSummary(example)}`);
    }
    for (const suspect of topFeatureSuspects(summary.suspectFeatureCounts, 5)) {
      console.log(`    suspect ${suspect}`);
    }
  }
}

function printFeatureTrace(cases: SuiteCase[], options: SuiteOptions): void {
  const trace = options.traceFeature;
  if (!trace) return;

  console.log("Stable replay suite feature trace");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  console.log(
    `Trace: ${judgmentLabel(trace.from)}->${judgmentLabel(trace.to)} `
    + `feature includes "${trace.featureIncludes}"`,
  );
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  const delta = judgmentDelta(trace.from, trace.to);
  for (const suiteCase of cases) {
    const matches: { allFeatures: string[]; event: ReplayJudgementEvent; features: string[]; ordinal: number }[] = [];
    suiteCase.simulation.events.forEach((event, index) => {
      if (event.judgment !== trace.from) return;
      const allFeatures = featureKeys(suiteCase, event);
      const features = allFeatures.filter((feature) => featureMatchesTrace(feature, trace.featureIncludes));
      if (features.length === 0) return;
      matches.push({ allFeatures, event, features, ordinal: index + 1 });
    });

    const appliedDelta = emptyReplayHitCounts();
    for (let index = 0; index < matches.length; index++) {
      addJudgmentValue(appliedDelta, trace.from, -1);
      addJudgmentValue(appliedDelta, trace.to, 1);
    }
    const nextDiff = addCounts(suiteCase.diff, appliedDelta);
    const displayedMatches = options.traceLocalImproves || options.traceTimeImproves
      ? matches.filter((match) => {
          const ordinalWindow = localOrdinalWindow(suiteCase, match.ordinal);
          const timeWindow = localTimeWindow(suiteCase, match.event.time, match.ordinal);
          const ordinalImprovement = ordinalWindow
            ? localDeltaImprovement(ordinalWindow.ordinalSimDelta, ordinalWindow.capDelta, delta)
            : null;
          const timeImprovement = timeWindow
            ? localDeltaImprovement(timeWindow.timeSimDelta, timeWindow.capDelta, delta)
            : null;
          return options.traceTimeImproves
            ? Boolean(timeImprovement?.improves)
            : Boolean(ordinalImprovement?.improves || timeImprovement?.improves);
        })
      : matches;

    console.log(
      `\n${suiteCase.spec.label}: matches ${matches.length}`
      + `${options.traceLocalImproves || options.traceTimeImproves ? ` shown ${displayedMatches.length}` : ""} `
      + `target ${formatCounts(suiteCase.targetCounts)} `
      + `sim ${formatCounts(suiteCase.currentCounts)} diff ${formatDiff(suiteCase.diff)} `
      + `after ${formatDiff(nextDiff)}${countsEqual(suiteCase.targetCounts, suiteCase.currentCounts) ? " exact" : ""}`,
    );

    for (const match of displayedMatches.slice(0, options.limit)) {
      const ordinalWindow = localOrdinalWindow(suiteCase, match.ordinal);
      const timeWindow = localTimeWindow(suiteCase, match.event.time, match.ordinal);
      const ordinalImprovement = ordinalWindow
        ? localDeltaImprovement(ordinalWindow.ordinalSimDelta, ordinalWindow.capDelta, delta)
        : null;
      const timeImprovement = timeWindow
        ? localDeltaImprovement(timeWindow.timeSimDelta, timeWindow.capDelta, delta)
        : null;
      console.log(`  ${compactEvent(suiteCase, match.ordinal)}`);
      const featurePreview = options.traceAllFeatures ? match.allFeatures : match.features.slice(0, 4);
      console.log(`    features ${featurePreview.join(" | ")}`);
      if (ordinalWindow) {
        console.log(
          `    ordinal cap ${formatCounts(ordinalWindow.capDelta)} sim ${formatCounts(ordinalWindow.ordinalSimDelta)} `
          + `diff ${formatDiff(diffReplayHitCounts(ordinalWindow.ordinalSimDelta, ordinalWindow.capDelta))} `
          + `after ${formatDiff(diffReplayHitCounts(addCounts(ordinalWindow.ordinalSimDelta, delta), ordinalWindow.capDelta))} `
          + `${ordinalImprovement?.improves ? "improves" : ordinalImprovement?.worsens ? "worsens" : "neutral"}`,
        );
      }
      if (timeWindow) {
        console.log(
          `    time    cap ${formatCounts(timeWindow.capDelta)} sim ${formatCounts(timeWindow.timeSimDelta)} `
          + `diff ${formatDiff(diffReplayHitCounts(timeWindow.timeSimDelta, timeWindow.capDelta))} `
          + `after ${formatDiff(diffReplayHitCounts(addCounts(timeWindow.timeSimDelta, delta), timeWindow.capDelta))} `
          + `${timeImprovement?.improves ? "improves" : timeImprovement?.worsens ? "worsens" : "neutral"}`,
        );
      }
    }
  }
}

function featureMatchesTrace(feature: string, trace: string): boolean {
  const traceTokens = trace.split(";").filter(Boolean);
  if (traceTokens.length <= 1) return feature.includes(trace);
  const featureTokens = new Set(feature.split(";"));
  return traceTokens.every((token) => featureTokens.has(token));
}

function addOrdinalDiffFeatureSuspects(
  counts: Map<string, number>,
  suiteCase: SuiteCase,
  previousTotal: number,
  total: number,
  ordinalDiff: ReplayHitCounts,
): void {
  const surplus = judgmentsBySignedCount(ordinalDiff, 1);
  const wanted = judgmentsBySignedCount(ordinalDiff, -1);
  if (surplus.length === 0 || wanted.length === 0) return;

  const ordinalStart = Math.max(1, previousTotal + 1);
  const ordinalEnd = Math.min(suiteCase.simulation.events.length, total);
  for (let ordinal = ordinalStart; ordinal <= ordinalEnd; ordinal++) {
    const event = suiteCase.simulation.events[ordinal - 1];
    if (!event?.judgment || !surplus.includes(event.judgment as Judgment)) continue;
    for (const target of wanted) {
      for (const key of featureKeys(suiteCase, event)) {
        const label = `${judgmentLabel(event.judgment as Judgment)}->${judgmentLabel(target)} ${key}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
}

function judgmentsBySignedCount(counts: ReplayHitCounts, signum: 1 | -1): Judgment[] {
  const judgments: Judgment[] = [1, 2, 3, 4, 5, 6];
  return judgments.filter((judgment) => {
    const count = judgmentCount(counts, judgment);
    return signum > 0 ? count > 0 : count < 0;
  });
}

function topFeatureSuspects(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key} x${count}`);
}

function formatBatchMismatch(mismatch: BatchMismatch): string {
  return `  row ${mismatch.previousTotal}->${mismatch.total} seq ${mismatch.previousSequence}->${mismatch.sequence} `
    + `time ${Math.round(mismatch.previousTime)}->${Math.round(mismatch.time)} `
    + `cap ${formatCounts(mismatch.capDelta)} time ${formatCounts(mismatch.timeDelta)} diff ${formatDiff(mismatch.timeDiff)} `
    + `ord ${formatCounts(mismatch.ordinalDelta)} diff ${formatDiff(mismatch.ordinalDiff)}\n`
    + `    time events ${mismatch.timeEvents}\n`
    + `    ordinal events ${mismatch.ordinalEvents}`;
}

function formatBatchMismatchSummary(mismatch: BatchMismatch): string {
  return `${mismatch.caseLabel} totals ${mismatch.previousTotal}->${mismatch.total} `
    + `time ${Math.round(mismatch.previousTime)}->${Math.round(mismatch.time)} `
    + `timeDiff ${formatDiff(mismatch.timeDiff)} ordDiff ${formatDiff(mismatch.ordinalDiff)}`;
}

function formatExposureRun(run: ExposureRun): string {
  const direction = run.sign > 0 ? "sim-early" : "target-early";
  return `${direction} ${judgmentLabel(run.judgment)} rows ${run.rows} max ${run.maxAbs} `
    + `totals ${run.startTotal}->${run.endTotal} time ${Math.round(run.startTime)}->${Math.round(run.endTime)}ms `
    + `${run.caseLabel}`;
}

function formatExposureRunStartContext(suiteCase: SuiteCase, run: ExposureRun): string[] {
  const sampleIndex = findFirstSampleIndexByTotal(suiteCase.capture.samples, run.startTotal);
  const sample = sampleIndex >= 0 ? suiteCase.capture.samples[sampleIndex] : null;
  if (!sample) return ["start row <missing>"];

  const previous = sampleIndex > 0 ? suiteCase.capture.samples[sampleIndex - 1] : null;
  const previousTime = previous?.time ?? Number.NEGATIVE_INFINITY;
  const previousTotal = previous?.total ?? 0;
  const previousCounts = previous?.counts ?? emptyReplayHitCounts();
  const capDelta = subtractCounts(sample.counts, previousCounts);
  const timeDelta = subtractCounts(
    countsAtTime(suiteCase, sample.time),
    countsAtTime(suiteCase, previousTime),
  );
  const rowDiff = diffReplayHitCounts(timeDelta, capDelta);
  const timeOrdinals = eventOrdinalsInTimeWindow(suiteCase.simulation, previousTime, sample.time);
  const ordinalStart = Math.max(1, sample.total - 2);
  const ordinalEnd = Math.min(suiteCase.simulation.events.length, sample.total + 2);
  const ordinalEvents: string[] = [];

  for (let ordinal = ordinalStart; ordinal <= ordinalEnd; ordinal++) {
    ordinalEvents.push(compactEvent(suiteCase, ordinal));
  }

  const timeEventText = timeOrdinals.length > 0
    ? timeOrdinals.slice(-8).map((ordinal) => compactEvent(suiteCase, ordinal)).join(" | ")
    : "<none>";
  const ordinalEventText = ordinalEvents.length > 0 ? ordinalEvents.join(" | ") : "<none>";

  return [
    `start row seq=${sample.sequence} total ${previousTotal}->${sample.total} time ${Math.round(previousTime)}->${Math.round(sample.time)} `
      + `capDelta ${formatCounts(capDelta)} simTimeDelta ${formatCounts(timeDelta)} rowDiff ${formatDiff(rowDiff)}`,
    `time events ${timeEventText}`,
    `ordinal events ${ordinalEventText}`,
  ];
}

interface OpenExposureFeatureSummary {
  cases: Set<string>;
  count: number;
  examples: string[];
  maxAbs: number;
  maxRows: number;
  rows: number;
}

function openExposureStartEventOrdinals(suiteCase: SuiteCase, run: ExposureRun): number[] {
  const sampleIndex = findFirstSampleIndexByTotal(suiteCase.capture.samples, run.startTotal);
  const sample = sampleIndex >= 0 ? suiteCase.capture.samples[sampleIndex] : null;
  if (!sample) return [];

  const previous = sampleIndex > 0 ? suiteCase.capture.samples[sampleIndex - 1] : null;
  const previousTime = previous?.time ?? Number.NEGATIVE_INFINITY;
  const previousTotal = previous?.total ?? 0;
  const timeOrdinals = eventOrdinalsInTimeWindow(suiteCase.simulation, previousTime, sample.time);
  const ordinalStart = Math.max(1, previousTotal + 1);
  const ordinalEnd = Math.min(suiteCase.simulation.events.length, sample.total);
  const ordinals = new Set<number>();

  if (run.sign > 0) {
    for (const ordinal of timeOrdinals) {
      const event = suiteCase.simulation.events[ordinal - 1];
      if (event?.judgment === run.judgment) ordinals.add(ordinal);
    }
  } else {
    for (let ordinal = ordinalStart; ordinal <= ordinalEnd; ordinal++) ordinals.add(ordinal);
  }

  if (ordinals.size === 0) {
    for (const ordinal of timeOrdinals) ordinals.add(ordinal);
    for (let ordinal = ordinalStart; ordinal <= ordinalEnd; ordinal++) ordinals.add(ordinal);
  }

  return [...ordinals].sort((a, b) => a - b);
}

function addOpenExposureFeature(
  aggregate: Map<string, OpenExposureFeatureSummary>,
  key: string,
  suiteCase: SuiteCase,
  run: ExposureRun,
  ordinal: number,
): void {
  const summary = aggregate.get(key) ?? {
    cases: new Set<string>(),
    count: 0,
    examples: [],
    maxAbs: 0,
    maxRows: 0,
    rows: 0,
  };
  summary.cases.add(suiteCase.spec.label);
  summary.count++;
  summary.rows += run.rows;
  summary.maxRows = Math.max(summary.maxRows, run.rows);
  summary.maxAbs = Math.max(summary.maxAbs, run.maxAbs);
  if (summary.examples.length < 4) {
    summary.examples.push(`${formatExposureRun(run)} :: ${compactEvent(suiteCase, ordinal)}`);
  }
  aggregate.set(key, summary);
}

function printOpenExposureFeatureSuite(cases: SuiteCase[], options: SuiteOptions): void {
  console.log("Stable replay suite open exposure feature search");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  const aggregate = new Map<string, OpenExposureFeatureSummary>();

  for (const suiteCase of cases) {
    const open = new Map<Judgment, ExposureRun>();
    let carry = emptyReplayHitCounts();
    let previousSample: PlaySnapshot | null = null;

    for (const sample of suiteCase.capture.samples) {
      const previousTime = previousSample?.time ?? Number.NEGATIVE_INFINITY;
      const previousCounts = previousSample?.counts ?? emptyReplayHitCounts();
      const capDelta = subtractCounts(sample.counts, previousCounts);
      const timeDelta = subtractCounts(
        countsAtTime(suiteCase, sample.time),
        countsAtTime(suiteCase, previousTime),
      );
      const rowDiff = diffReplayHitCounts(timeDelta, capDelta);
      const nextCarry = addCounts(carry, rowDiff);

      for (const judgment of [1, 2, 3, 4, 5, 6] as Judgment[]) {
        const before = judgmentCount(carry, judgment);
        const after = judgmentCount(nextCarry, judgment);
        const current = open.get(judgment);

        if (before === 0 && after !== 0) {
          open.set(judgment, {
            caseLabel: suiteCase.spec.label,
            closed: false,
            endTime: sample.time,
            endTotal: sample.total,
            judgment,
            maxAbs: Math.abs(after),
            rows: 1,
            sign: Math.sign(after),
            startTime: sample.time,
            startTotal: sample.total,
          });
        } else if (before !== 0 && after === 0) {
          open.delete(judgment);
        } else if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) {
          open.set(judgment, {
            caseLabel: suiteCase.spec.label,
            closed: false,
            endTime: sample.time,
            endTotal: sample.total,
            judgment,
            maxAbs: Math.abs(after),
            rows: 1,
            sign: Math.sign(after),
            startTime: sample.time,
            startTotal: sample.total,
          });
        } else if (current && after !== 0) {
          current.endTime = sample.time;
          current.endTotal = sample.total;
          current.maxAbs = Math.max(current.maxAbs, Math.abs(after));
          current.rows++;
        }
      }

      carry = nextCarry;
      previousSample = sample;
    }

    const openRuns = [...open.values()];
    console.log(`\n${suiteCase.spec.label}: final ${formatDiff(suiteCase.diff)} open ${openRuns.length}`);
    for (const run of openRuns) {
      const direction = run.sign > 0 ? "sim-early" : "target-early";
      const ordinals = openExposureStartEventOrdinals(suiteCase, run);
      console.log(`  ${formatExposureRun(run)}`);
      for (const detail of formatExposureRunStartContext(suiteCase, run)) console.log(`    ${detail}`);

      for (const ordinal of ordinals) {
        const event = suiteCase.simulation.events[ordinal - 1];
        if (!event?.judgment) continue;
        for (const feature of featureKeys(suiteCase, event)) {
          addOpenExposureFeature(
            aggregate,
            `${direction} ${judgmentLabel(run.judgment)} / event ${judgmentLabel(event.judgment as Judgment)} / ${feature}`,
            suiteCase,
            run,
            ordinal,
          );
        }
      }
    }
  }

  const grouped = [...aggregate.entries()]
    .sort((a, b) => b[1].cases.size - a[1].cases.size
      || b[1].maxRows - a[1].maxRows
      || b[1].rows - a[1].rows
      || b[1].count - a[1].count
      || a[0].localeCompare(b[0]));

  console.log("\nOpen exposure feature aggregate:");
  for (const [key, summary] of grouped.slice(0, options.limit)) {
    console.log(
      `  cases ${summary.cases.size} count ${summary.count} rows ${summary.rows} `
      + `maxRows ${summary.maxRows} maxAbs ${summary.maxAbs} ${[...summary.cases].join(", ")} :: ${key}`,
    );
    for (const example of summary.examples) console.log(`    ${example}`);
  }
}

function neededTransitions(cases: SuiteCase[]): Array<{ from: Judgment; to: Judgment }> {
  const keys = new Set<string>();
  const transitions: Array<{ from: Judgment; to: Judgment }> = [];

  for (const suiteCase of cases) {
    if (suiteCase.spec.exactVeto || countDistance(suiteCase.diff) === 0) continue;

    const diff = replayHitCountsToArray(suiteCase.diff);
    for (let from = 1; from <= 6; from++) {
      if (diff[from] <= 0) continue;
      for (let to = 1; to <= 6; to++) {
        if (from === to || diff[to] >= 0) continue;
        const key = `${from}->${to}`;
        if (keys.has(key)) continue;
        keys.add(key);
        transitions.push({ from: from as Judgment, to: to as Judgment });
      }
    }
  }

  return transitions.sort((a, b) => a.from - b.from || a.to - b.to);
}

function buildCandidateRules(cases: SuiteCase[], options: SuiteOptions): CandidateRule[] {
  const transitions = neededTransitions(cases);
  const byId = new Map<string, CandidateRule>();

  for (const transition of transitions) {
    const groupedChanges = new Map<string, RuleChange[]>();

    for (const suiteCase of cases) {
      suiteCase.simulation.events.forEach((event, index) => {
        if (event.judgment !== transition.from) return;

        for (const featureKey of featureKeys(suiteCase, event)) {
          const key = `${transition.from}->${transition.to} / ${featureKey}`;
          const group = groupedChanges.get(key);
          const change = { caseIndex: suiteCase.index, event, ordinal: index + 1 };
          if (group) group.push(change);
          else groupedChanges.set(key, [change]);
        }
      });
    }

    for (const [label, changes] of groupedChanges) {
      const deltas = cases.map(() => emptyReplayHitCounts());
      let explicitCount = 0;
      for (const change of changes) {
        deltas[change.caseIndex] = addCounts(deltas[change.caseIndex], judgmentDelta(transition.from, transition.to));
        if (change.event.possibleJudgments?.includes(transition.to)) explicitCount++;
      }

      const rule: CandidateRule = {
        changes,
        deltas,
        explicitCount,
        featureKey: label.slice(label.indexOf(" / ") + 3),
        from: transition.from,
        id: `${transition.from}->${transition.to}:${label}`,
        label,
        localSupport: summarizeLocalSupport(cases, changes, transition.from, transition.to),
        ordinalFitImprovement: 0,
        timeFitImprovement: 0,
        to: transition.to,
      };
      if (!ruleCanContribute(cases, rule, options.mode)) continue;
      if (options.explicitOnly && rule.explicitCount !== rule.changes.length) continue;
      if (options.localSupported && rule.localSupport.eitherSupported !== rule.localSupport.changes) continue;

      rule.ordinalFitImprovement = ruleFitImprovement(cases, rule, "ordinal");
      rule.timeFitImprovement = ruleFitImprovement(cases, rule, "time");
      if (rule.ordinalFitImprovement < 0 && rule.timeFitImprovement < 0) continue;
      byId.set(rule.id, rule);
    }
  }

  return [...byId.values()].sort((a, b) => ruleSortScore(cases, a) - ruleSortScore(cases, b)
    || b.explicitCount - a.explicitCount
    || totalChanges(a) - totalChanges(b)
    || a.label.localeCompare(b.label));
}

function totalChanges(rule: CandidateRule): number {
  return rule.changes.length;
}

function countsToVector(counts: ReplayHitCounts): number[] {
  return replayHitCountsToArray(counts).slice(1);
}

function vectorToCounts(vector: number[], offset = 0): ReplayHitCounts {
  return {
    countGeki: vector[offset] ?? 0,
    count300: vector[offset + 1] ?? 0,
    countKatu: vector[offset + 2] ?? 0,
    count100: vector[offset + 3] ?? 0,
    count50: vector[offset + 4] ?? 0,
    countMiss: vector[offset + 5] ?? 0,
  };
}

function suiteDiffVector(cases: SuiteCase[]): number[] {
  return cases.flatMap((suiteCase) => countsToVector(suiteCase.diff));
}

function ruleDeltaVector(rule: CandidateRule): number[] {
  return rule.deltas.flatMap(countsToVector);
}

function distanceVector(vector: number[]): number {
  return vector.reduce((sum, value) => sum + Math.abs(value), 0);
}

function ruleCanContribute(cases: SuiteCase[], rule: CandidateRule, mode: SuiteOptions["mode"]): boolean {
  const baseDistance = distanceVector(suiteDiffVector(cases));
  const nextVector = addVectors(suiteDiffVector(cases), ruleDeltaVector(rule));
  if (distanceVector(nextVector) >= baseDistance) return false;

  for (const suiteCase of cases) {
    const delta = rule.deltas[suiteCase.index];
    if (mode === "strict" && suiteCase.spec.exactVeto && countDistance(delta) !== 0) {
      return false;
    }

    if (!signCompatible(countsToVector(suiteCase.diff), countsToVector(delta), mode === "strict")) {
      return false;
    }
  }

  return true;
}

function signCompatible(diff: number[], delta: number[], strictZero: boolean): boolean {
  for (let i = 0; i < diff.length; i++) {
    if (diff[i] === 0) {
      if (strictZero && delta[i] !== 0) return false;
      continue;
    }

    if (diff[i] > 0 && (delta[i] > 0 || diff[i] + delta[i] < 0)) return false;
    if (diff[i] < 0 && (delta[i] < 0 || diff[i] + delta[i] > 0)) return false;
  }

  return true;
}

function addVectors(a: number[], b: number[]): number[] {
  return a.map((value, index) => value + b[index]);
}

function ruleSortScore(cases: SuiteCase[], rule: CandidateRule): number {
  const base = suiteDiffVector(cases);
  const next = addVectors(base, ruleDeltaVector(rule));
  const improvement = distanceVector(base) - distanceVector(next);
  const exactPenalty = cases
    .filter((suiteCase) => suiteCase.spec.exactVeto)
    .reduce((sum, suiteCase) => sum + countDistance(rule.deltas[suiteCase.index]), 0);
  const complexity = rule.featureKey.split(";").length;
  const narrownessPenalty = /head5|tail5|combined5|rawTail5|absHead5/.test(rule.featureKey) ? 3 : 0;
  const fitImprovement = rule.ordinalFitImprovement + rule.timeFitImprovement;
  const fitPenalty = fitImprovement < 0 ? Math.abs(fitImprovement) * 2 : -fitImprovement;
  const localPenalty = (totalChanges(rule) - rule.localSupport.eitherSupported) * 12
    + rule.localSupport.contradicted * 4;

  return exactPenalty * 10000
    - improvement * 100
    + fitPenalty
    + localPenalty
    + complexity * 5
    + narrownessPenalty
    + totalChanges(rule);
}

function eventKey(change: RuleChange): string {
  return `${change.caseIndex}:${change.ordinal}`;
}

function overlapsUsed(rule: CandidateRule, usedEvents: Set<string>): boolean {
  return rule.changes.some((change) => usedEvents.has(eventKey(change)));
}

function addRuleEvents(rule: CandidateRule, usedEvents: Set<string>): Set<string> {
  const next = new Set(usedEvents);
  for (const change of rule.changes) next.add(eventKey(change));
  return next;
}

function firstResidualIndex(vector: number[]): number {
  let bestIndex = -1;
  let bestValue = 0;

  for (let i = 0; i < vector.length; i++) {
    const value = Math.abs(vector[i]);
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function ruleHelpsIndex(rule: CandidateRule, vector: number[], index: number): boolean {
  const delta = ruleDeltaVector(rule)[index] ?? 0;
  if (vector[index] > 0) return delta < 0;
  if (vector[index] < 0) return delta > 0;
  return false;
}

function candidateBucketForNeed(
  candidates: CandidateRule[],
  vector: number[],
  index: number,
  perNeedLimit: number,
): CandidateRule[] {
  return candidates
    .filter((rule) => ruleHelpsIndex(rule, vector, index))
    .sort((a, b) => {
      const nextA = addVectors(vector, ruleDeltaVector(a));
      const nextB = addVectors(vector, ruleDeltaVector(b));
      return distanceVector(nextA) - distanceVector(nextB)
        || ruleSortScoreFromVector(vector, a) - ruleSortScoreFromVector(vector, b)
        || a.label.localeCompare(b.label);
    })
    .slice(0, perNeedLimit);
}

function ruleSortScoreFromVector(vector: number[], rule: CandidateRule): number {
  const next = addVectors(vector, ruleDeltaVector(rule));
  return (distanceVector(next) - distanceVector(vector)) * 100
    - (rule.ordinalFitImprovement + rule.timeFitImprovement)
    + (totalChanges(rule) - rule.localSupport.eitherSupported) * 12
    + rule.localSupport.contradicted * 4
    + rule.featureKey.split(";").length * 5
    + totalChanges(rule);
}

function searchExactSolutions(
  candidates: CandidateRule[],
  cases: SuiteCase[],
  options: SuiteOptions,
): { hitNodeCap: boolean; solutions: SearchState[]; visitedNodes: number } {
  const initialVector = suiteDiffVector(cases);
  const solutions: SearchState[] = [];
  let hitNodeCap = false;
  let visitedNodes = 0;

  function visit(state: SearchState, startIndex: number): void {
    if (solutions.length >= options.limit) return;
    visitedNodes++;
    if (visitedNodes > options.maxNodes) {
      hitNodeCap = true;
      return;
    }
    if (distanceVector(state.vectors) === 0) {
      solutions.push(state);
      return;
    }
    if (state.selected.length >= options.maxDepth) return;

    const residualIndex = firstResidualIndex(state.vectors);
    if (residualIndex < 0) return;

    const bucket = candidateBucketForNeed(
      candidates.slice(startIndex),
      state.vectors,
      residualIndex,
      options.perNeedLimit,
    );

    for (const rule of bucket) {
      const candidateIndex = candidates.indexOf(rule);
      if (candidateIndex < startIndex) continue;
      if (overlapsUsed(rule, state.usedEvents)) continue;

      const nextVector = addVectors(state.vectors, ruleDeltaVector(rule));
      if (distanceVector(nextVector) >= distanceVector(state.vectors)) continue;
      if (!stateVectorCompatible(nextVector, initialVector, options.mode === "strict")) continue;

      visit({
        selected: [...state.selected, rule],
        usedEvents: addRuleEvents(rule, state.usedEvents),
        vectors: nextVector,
      }, candidateIndex + 1);
    }
  }

  visit({
    selected: [],
    usedEvents: new Set(),
    vectors: initialVector,
  }, 0);

  return { hitNodeCap, solutions, visitedNodes };
}

function stateVectorCompatible(vector: number[], initialVector: number[], strictZero: boolean): boolean {
  for (let i = 0; i < vector.length; i++) {
    if (initialVector[i] === 0) {
      if (strictZero && vector[i] !== 0) return false;
      continue;
    }

    if (initialVector[i] > 0 && (vector[i] < 0 || vector[i] > initialVector[i])) return false;
    if (initialVector[i] < 0 && (vector[i] > 0 || vector[i] < initialVector[i])) return false;
  }

  return true;
}

function beamPartialSolutions(
  candidates: CandidateRule[],
  cases: SuiteCase[],
  options: SuiteOptions,
): SearchState[] {
  let states: SearchState[] = [{
    selected: [],
    usedEvents: new Set(),
    vectors: suiteDiffVector(cases),
  }];

  for (let depth = 0; depth < options.maxDepth; depth++) {
    const nextStates: SearchState[] = [];

    for (const state of states) {
      const residualIndex = firstResidualIndex(state.vectors);
      if (residualIndex < 0) {
        nextStates.push(state);
        continue;
      }

      for (const rule of candidateBucketForNeed(candidates, state.vectors, residualIndex, options.perNeedLimit)) {
        if (overlapsUsed(rule, state.usedEvents)) continue;
        const nextVector = addVectors(state.vectors, ruleDeltaVector(rule));
        if (distanceVector(nextVector) >= distanceVector(state.vectors)) continue;
        if (!stateVectorCompatible(nextVector, suiteDiffVector(cases), options.mode === "strict")) continue;

        nextStates.push({
          selected: [...state.selected, rule],
          usedEvents: addRuleEvents(rule, state.usedEvents),
          vectors: nextVector,
        });
      }
    }

    states = [...states, ...nextStates]
      .sort((a, b) => distanceVector(a.vectors) - distanceVector(b.vectors)
        || a.selected.length - b.selected.length
        || stateComplexity(a) - stateComplexity(b))
      .slice(0, Math.max(64, options.limit * 12));
  }

  return states
    .filter((state) => state.selected.length > 0)
    .sort((a, b) => distanceVector(a.vectors) - distanceVector(b.vectors)
      || a.selected.length - b.selected.length
      || stateComplexity(a) - stateComplexity(b))
    .slice(0, options.limit);
}

function stateComplexity(state: SearchState): number {
  return state.selected.reduce((sum, rule) => sum + rule.featureKey.split(";").length, 0);
}

function formatChangeList(cases: SuiteCase[], rule: CandidateRule): string {
  const byCase = new Map<number, RuleChange[]>();
  for (const change of rule.changes) {
    const list = byCase.get(change.caseIndex);
    if (list) list.push(change);
    else byCase.set(change.caseIndex, [change]);
  }

  return [...byCase.entries()]
    .sort(([a], [b]) => a - b)
    .map(([caseIndex, changes]) => {
      const ordinals = changes
        .slice(0, 8)
        .map((change) => {
          const event = change.event;
          return `#${change.ordinal}:${event.part}:c${event.column}:n${event.noteIndex}`;
        })
        .join(",");
      const suffix = changes.length > 8 ? `,+${changes.length - 8}` : "";
      return `${cases[caseIndex].spec.label}[${ordinals}${suffix}]`;
    })
    .join(" ");
}

function formatLocalSupport(rule: CandidateRule): string {
  const local = rule.localSupport;
  return `local ${local.eitherSupported}/${local.changes} `
    + `(ord ${local.ordinalSupported}, time ${local.timeSupported}, contrad ${local.contradicted})`;
}

function printSolution(cases: SuiteCase[], solution: SearchState, index: number): void {
  console.log(`\nSolution ${index + 1}: depth ${solution.selected.length}, residual ${formatSuiteVector(cases, solution.vectors)}`);
  for (const rule of solution.selected) {
    const explicit = rule.explicitCount === totalChanges(rule)
      ? "all-explicit"
      : rule.explicitCount > 0
        ? `explicit ${rule.explicitCount}/${totalChanges(rule)}`
        : "implicit";
    console.log(`  ${rule.label} changes ${totalChanges(rule)} ${explicit} ${formatLocalSupport(rule)}`);
    console.log(`    ${formatChangeList(cases, rule)}`);
  }
}

function formatSuiteVector(cases: SuiteCase[], vector: number[]): string {
  return cases
    .map((suiteCase) => {
      const counts = vectorToCounts(vector, suiteCase.index * 6);
      return `${suiteCase.spec.label} ${formatDiff(counts)} visible ${formatVisibleDiff(counts)}`;
    })
    .join(" | ");
}

function suiteVisibleDistance(cases: SuiteCase[], vector: number[]): number {
  return cases.reduce((sum, suiteCase) => {
    return sum + visibleDistance(vectorToCounts(vector, suiteCase.index * 6));
  }, 0);
}

function filterSpecs(specs: CaseSpec[], options: SuiteOptions): CaseSpec[] {
  const filtered = specs.filter((spec) => {
    if (options.includedLabels.size > 0 && !options.includedLabels.has(spec.label)) return false;
    return !options.excludedLabels.has(spec.label);
  });

  if (filtered.length === 0) {
    throw new Error("Suite filters removed every case.");
  }

  return filtered;
}

interface TimingSuiteVariant {
  label: string;
  options: ManiaReplaySimulationOptions;
}

interface TimingSuiteEvaluation {
  compactDiff: string;
  exactVetoDistance: number;
  exactVetoVisibleDistance: number;
  label: string;
  nonVetoDistance: number;
  nonVetoVisibleDistance: number;
  totalDistance: number;
  totalVisibleDistance: number;
}

interface TimingChangedEvent {
  baseEvent: ReplayJudgementEvent;
  baseOrdinal: number;
  finalGain: number;
  from: Judgment;
  local: LocalChangeSupport;
  to: Judgment;
  variantEvent: ReplayJudgementEvent;
  variantOrdinal: number;
}

interface TimingChangeAggregate {
  cases: Set<string>;
  count: number;
  examples: string[];
  finalGain: number;
  harmful: number;
  key: string;
  neutral: number;
  ordinalImproves: number;
  ordinalWorsens: number;
  positive: number;
  timeImproves: number;
  timeWorsens: number;
}

function uniqueTimingSuiteVariants(): TimingSuiteVariant[] {
  const variants = new Map<string, TimingSuiteVariant>();
  const add = (variant: TimingSuiteVariant) => {
    if (!variants.has(variant.label)) variants.set(variant.label, variant);
  };

  add({ label: "current defaults", options: {} });
  add({ label: "reuse tail segment for next head", options: { stableReuseTailSegmentForNextHead: true } });
  for (const grace of [4, 8, 12, 16]) {
    add({
      label: `reuse tail segment with ${grace}ms grace`,
      options: {
        stableReuseTailSegmentForNextHead: true,
        stableTailSegmentReuseGrace: grace,
      },
    });
  }
  for (const grace of [0, 4, 8, 10, 12, 14, 15, 16, 18, 20]) {
    add({ label: `next-note edge grace ${grace}ms`, options: { stableNextNoteEdgeGrace: grace } });
  }
  for (const grace of [0, 4, 6, 10, 12, 16]) {
    add({ label: `tail edge grace ${grace}ms`, options: { stableTailEdgeGrace: grace } });
  }
  for (const cap of [2, 4, 5, 6] as Judgment[]) {
    add({ label: `body-break cap ${cap}`, options: { stableBodyBreakCapJudgment: cap } });
  }
  add({ label: "body-break uncapped", options: { stableBodyBreakCapJudgment: null } });
  add({ label: "suppress hidden body-break cap", options: { stableSuppressHiddenBodyBreakCap: true } });
  add({
    label: "preserve LN scoring press after break",
    options: { stablePreserveLongNoteScoringPressAfterBreak: true },
  });
  add({
    label: "preserve LN scoring press after tail break",
    options: { stablePreserveLongNoteScoringPressAfterTailBreak: true },
  });
  add({
    label: "preserve LN scoring press time",
    options: { stablePreserveLongNoteScoringPressTime: true },
  });
  add({ label: "disable pre-head release miss", options: { stablePreHeadReleaseMissesAtHead: false } });
  add({
    label: "pre-head release miss consumes recovery",
    options: { stablePreHeadReleaseMissConsumesRecovery: true },
  });
  for (const tailOffset of [-220, -200, -180, -170, -160, -150]) {
    add({
      label: `pre-head recovery tail<=${tailOffset}ms`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: tailOffset,
      },
    });
  }
  for (const [gap, duration] of [[66, 44], [66, 66], [88, 44]]) {
    add({
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
    add({
      label: `pre-head recovery tail<=-200ms next gap<=${gap}`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryMaxNextNoteGap: gap,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -200,
      },
    });
  }
  for (const headOffset of [100, 120, 140]) {
    add({
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
    add({
      label: `pre-head recovery tail<=-200ms next gap<=66 next2 gap>=${nextNextGap}`,
      options: {
        stablePreHeadReleaseMissConsumesRecovery: true,
        stablePreHeadReleaseMissRecoveryMaxNextNoteGap: 66,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -200,
        stablePreHeadReleaseMissRecoveryMinNextNextNoteGap: nextNextGap,
      },
    });
  }
  add({
    label: "dense-only pre-head release miss consumes recovery median<=6",
    options: { stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6 },
  });
  for (const tailOffset of [-180, -170, -160, -150]) {
    add({
      label: `dense-only pre-head recovery median<=6 tail<=${tailOffset}ms`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: tailOffset,
      },
    });
  }
  for (const headOffset of [80, 100, 110, 120]) {
    add({
      label: `dense-only pre-head recovery median<=6 head<=${headOffset}ms`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryMaxHeadOffset: headOffset,
      },
    });
  }
  add({
    label: "dense-only pre-head recovery median<=6 exclude before tap",
    options: {
      stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
      stablePreHeadReleaseMissRecoveryExcludeBeforeTap: true,
    },
  });
  for (const tailOffset of [-170, -160, -150]) {
    add({
      label: `dense-only pre-head recovery median<=6 tail<=${tailOffset}ms exclude before tap`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryExcludeBeforeTap: true,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: tailOffset,
      },
    });
  }
  for (const [gap, duration] of [[66, 44], [66, 66], [88, 44]]) {
    add({
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
    add({
      label: `dense-only pre-head recovery median<=6 tail<=-150ms next gap<=${gap}`,
      options: {
        stableDensePreHeadReleaseMissConsumesRecoveryMaxMedian: 6,
        stablePreHeadReleaseMissRecoveryMaxNextNoteGap: gap,
        stablePreHeadReleaseMissRecoveryMaxTailOffset: -150,
      },
    });
  }
  add({
    label: "pre-head activation requires recovery",
    options: { stableRequirePreHeadRecoveryForActivation: true },
  });
  add({ label: "tail early-miss lenience 1.5x", options: { stableTailEarlyMissLenience: 1.5 } });
  for (const position of [0, 0.25, 0.5, 0.75]) {
    add({
      label: `precise edge position ${position}`,
      options: { stablePreciseEdgePosition: position },
    });
  }
  for (const delay of [-4, -2, 0, 2, 4, 8]) {
    add({ label: `coarse edge delay ${delay}ms`, options: { stableCoarseEdgePlaybackDelay: delay } });
    if (delay === 0) {
      add({ label: "coarse press estimate only", options: { stableCoarsePressPlayback: true } });
      add({ label: "precise release estimate", options: { stableCoarseReleasePlayback: false } });
      add({
        label: "coarse press+release estimates only",
        options: {
          stableCoarsePressPlayback: true,
          stableCoarseReleasePlayback: true,
        },
      });
      add({
        label: "enable LN head refinement",
        options: { stableEnableLongNoteHeadRefinement: true },
      });
    }
    add({
      label: `dense-only coarse median<=6 delay ${delay}ms`,
      options: {
        stableDenseCoarseEdgePlaybackDelay: delay,
        stableDenseForceCoarsePlaybackMaxMedian: 6,
      },
    });
    if (delay === 0) {
      add({
        label: "dense-only coarse median<=6 delay 0ms keep LN head refinement",
        options: {
          stableAllowCoarseLongNoteHeadRefinement: true,
          stableDenseCoarseEdgePlaybackDelay: 0,
          stableDenseForceCoarsePlaybackMaxMedian: 6,
        },
      });
      add({
        label: "dense-only coarse median<=6 delay 0ms precise press",
        options: {
          stableCoarsePressPlayback: false,
          stableDenseCoarseEdgePlaybackDelay: 0,
          stableDenseForceCoarsePlaybackMaxMedian: 6,
        },
      });
      add({
        label: "dense-only coarse median<=6 delay 0ms precise release",
        options: {
          stableCoarseReleasePlayback: false,
          stableDenseCoarseEdgePlaybackDelay: 0,
          stableDenseForceCoarsePlaybackMaxMedian: 6,
        },
      });
    }
    add({
      label: `force coarse edge delay ${delay}ms`,
      options: {
        stableCoarseEdgePlaybackDelay: delay,
        stableForceCoarsePlayback: true,
      },
    });
  }
  for (const cap of [0, 2, 4, 6, 8, 10, 12]) {
    add({ label: `high-key release delay cap ${cap}ms`, options: { stableHighKeyReleaseDelayCap: cap } });
    if (cap > 0) {
      add({
        label: `high-key release delay cap ${cap}ms miss-only`,
        options: {
          stableHighKeyReleaseDelayCap: cap,
          stableHighKeyReleaseDelayMissOnly: true,
        },
      });
      add({
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
  add({ label: "binary column input ownership", options: { stableColumnInputOwnership: true } });
  add({ label: "do not consume held segment at LN timeout", options: { stableConsumeHeldSegmentAtLongNoteTimeout: false } });
  for (const judgment of [2, 3, 4, 5] as Judgment[]) {
    add({
      label: `missed-inside-consumed as ${judgmentLabel(judgment)}`,
      options: { stableMissedInsideConsumedSegmentJudgment: judgment },
    });
    add({
      label: `missed-inside-consumed no-advance as ${judgmentLabel(judgment)}`,
      options: { stableMissedInsideConsumedNoAdvanceJudgment: judgment },
    });
  }
  add({ label: "held timeout keep OK", options: { stableHeldOkTimeoutAsMiss: false } });
  add({ label: "held OK timeout as miss", options: { stableHeldOkTimeoutJudgment: 6 } });
  add({ label: "held OK timeout as MEH/50", options: { stableHeldOkTimeoutJudgment: 5 } });
  add({ label: "held timeout first sample", options: { stableHeldTailTimeoutMode: "first-sample" } });
  add({ label: "held timeout segment end", options: { stableHeldTailTimeoutMode: "segment-end" } });
  for (const releaseCap of [0, 2, 4, 5, 6, 8, 10, 12]) {
    add({
      label: `held timeout first sample + release cap ${releaseCap}ms`,
      options: {
        stableHeldTailTimeoutMode: "first-sample",
        stableHighKeyReleaseDelayCap: releaseCap,
      },
    });
    if (releaseCap > 0) {
      add({
        label: `held timeout first sample + release cap ${releaseCap}ms miss-only`,
        options: {
          stableHeldTailTimeoutMode: "first-sample",
          stableHighKeyReleaseDelayCap: releaseCap,
          stableHighKeyReleaseDelayMissOnly: true,
        },
      });
      add({
        label: `held timeout first sample + release cap ${releaseCap}ms miss-only raw>=4 head<=good`,
        options: {
          stableHeldTailTimeoutMode: "first-sample",
          stableHighKeyReleaseDelayCap: releaseCap,
          stableHighKeyReleaseDelayMaxHeadOffset: 82,
          stableHighKeyReleaseDelayMissOnly: true,
          stableHighKeyReleaseDelayRawThreshold: 4,
        },
      });
    }
  }
  add({
    label: "next-note edge 12ms + reuse tail",
    options: {
      stableNextNoteEdgeGrace: 12,
      stableReuseTailSegmentForNextHead: true,
    },
  });
  add({
    label: "next-note edge 12ms + tail grace 12ms",
    options: {
      stableNextNoteEdgeGrace: 12,
      stableTailEdgeGrace: 12,
    },
  });
  for (const tailGrace of [0, 4, 8, 10, 12, 16]) {
    add({
      label: `next-note edge 14ms + tail grace ${tailGrace}ms`,
      options: {
        stableNextNoteEdgeGrace: 14,
        stableTailEdgeGrace: tailGrace,
      },
    });
  }
  for (const releaseCap of [0, 2, 4, 6, 8, 10, 12]) {
    add({
      label: `next-note edge 14ms + release cap ${releaseCap}ms`,
      options: {
        stableHighKeyReleaseDelayCap: releaseCap,
        stableNextNoteEdgeGrace: 14,
      },
    });
    if (releaseCap > 0) {
      add({
        label: `next-note edge 14ms + release cap ${releaseCap}ms miss-only`,
        options: {
          stableHighKeyReleaseDelayCap: releaseCap,
          stableHighKeyReleaseDelayMissOnly: true,
          stableNextNoteEdgeGrace: 14,
        },
      });
      add({
        label: `next-note edge 14ms + release cap ${releaseCap}ms miss-only raw>=4 head<=good`,
        options: {
          stableHighKeyReleaseDelayCap: releaseCap,
          stableHighKeyReleaseDelayMaxHeadOffset: 82,
          stableHighKeyReleaseDelayMissOnly: true,
          stableHighKeyReleaseDelayRawThreshold: 4,
          stableNextNoteEdgeGrace: 14,
        },
      });
    }
  }
  add({
    label: "tail grace 12ms + reuse tail",
    options: {
      stableReuseTailSegmentForNextHead: true,
      stableTailEdgeGrace: 12,
    },
  });

  return [...variants.values()];
}

function timingSuiteDistance(
  cases: SuiteCase[],
  exactVeto: boolean,
  visible: boolean,
): number {
  return cases
    .filter((suiteCase) => suiteCase.spec.exactVeto === exactVeto)
    .reduce((sum, suiteCase) => sum + (visible ? visibleDistance(suiteCase.diff) : countDistance(suiteCase.diff)), 0);
}

function formatCompactSuiteDiff(cases: SuiteCase[]): string {
  return cases
    .filter((suiteCase) => !suiteCase.spec.exactVeto || !countsEqual(suiteCase.targetCounts, suiteCase.currentCounts))
    .map((suiteCase) => `${suiteCase.spec.label}:${formatDiff(suiteCase.diff)}`)
    .join(" ");
}

async function evaluateTimingSuiteVariant(
  specs: CaseSpec[],
  baseOptions: SuiteOptions,
  variant: TimingSuiteVariant,
): Promise<TimingSuiteEvaluation> {
  const variantOptions: SuiteOptions = {
    ...baseOptions,
    simulationOptions: variant.options,
    stableNextNoteEdgeGrace: undefined,
  };
  const cases = await Promise.all(specs.map((spec, index) => loadCase(spec, index, variantOptions)));
  const exactVetoDistance = timingSuiteDistance(cases, true, false);
  const exactVetoVisibleDistance = timingSuiteDistance(cases, true, true);
  const nonVetoDistance = timingSuiteDistance(cases, false, false);
  const nonVetoVisibleDistance = timingSuiteDistance(cases, false, true);

  return {
    compactDiff: formatCompactSuiteDiff(cases),
    exactVetoDistance,
    exactVetoVisibleDistance,
    label: variant.label,
    nonVetoDistance,
    nonVetoVisibleDistance,
    totalDistance: exactVetoDistance + nonVetoDistance,
    totalVisibleDistance: exactVetoVisibleDistance + nonVetoVisibleDistance,
  };
}

function timingEventIdentity(event: ReplayJudgementEvent): string {
  return `${event.noteIndex}:${event.part}`;
}

function changedTimingEvents(
  baseCases: SuiteCase[],
  suiteCase: SuiteCase,
  variantCase: SuiteCase,
): TimingChangedEvent[] {
  const variantEvents = new Map<string, { event: ReplayJudgementEvent; ordinal: number }>();
  variantCase.simulation.events.forEach((event, index) => {
    if (event.judgment != null) {
      variantEvents.set(timingEventIdentity(event), { event, ordinal: index + 1 });
    }
  });

  const changes: TimingChangedEvent[] = [];
  suiteCase.simulation.events.forEach((baseEvent, index) => {
    if (baseEvent.judgment == null) return;
    const variant = variantEvents.get(timingEventIdentity(baseEvent));
    if (!variant || variant.event.judgment == null || variant.event.judgment === baseEvent.judgment) return;

    const from = baseEvent.judgment as Judgment;
    const to = variant.event.judgment as Judgment;
    const nextDiff = addCounts(suiteCase.diff, judgmentDelta(from, to));
    const finalGain = countDistance(suiteCase.diff) - countDistance(nextDiff);
    const change: RuleChange = {
      caseIndex: suiteCase.index,
      event: baseEvent,
      ordinal: index + 1,
    };
    changes.push({
      baseEvent,
      baseOrdinal: index + 1,
      finalGain,
      from,
      local: localChangeSupport(baseCases, change, from, to),
      to,
      variantEvent: variant.event,
      variantOrdinal: variant.ordinal,
    });
  });

  return changes;
}

function addTimingChangeAggregate(
  aggregates: Map<string, TimingChangeAggregate>,
  key: string,
  suiteCase: SuiteCase,
  variantCase: SuiteCase,
  change: TimingChangedEvent,
): void {
  const current = aggregates.get(key) ?? {
    cases: new Set<string>(),
    count: 0,
    examples: [],
    finalGain: 0,
    harmful: 0,
    key,
    neutral: 0,
    ordinalImproves: 0,
    ordinalWorsens: 0,
    positive: 0,
    timeImproves: 0,
    timeWorsens: 0,
  };

  current.cases.add(suiteCase.spec.label);
  current.count++;
  current.finalGain += change.finalGain;
  if (change.finalGain > 0) current.positive++;
  else if (change.finalGain < 0) current.harmful++;
  else current.neutral++;
  if (change.local.ordinalImproves) current.ordinalImproves++;
  if (change.local.ordinalWorsens) current.ordinalWorsens++;
  if (change.local.timeImproves) current.timeImproves++;
  if (change.local.timeWorsens) current.timeWorsens++;
  if (current.examples.length < 3) {
    current.examples.push(
      `${suiteCase.spec.label} ${compactEvent(suiteCase, change.baseOrdinal)}`
      + ` => ${compactEvent(variantCase, change.variantOrdinal)}`,
    );
  }
  aggregates.set(key, current);
}

function timingVariantResultFeatureKeys(
  suiteCase: SuiteCase,
  variantCase: SuiteCase,
  change: TimingChangedEvent,
): string[] {
  const baseState = suiteCase.simulation.noteStates[change.baseEvent.noteIndex];
  const variantState = variantCase.simulation.noteStates[change.variantEvent.noteIndex];
  const variantNote = variantCase.simulation.notes[change.variantEvent.noteIndex];
  const variantHead = roundedOffset(variantState, "head", true);
  const variantTail = roundedOffset(variantState, "tail", true);
  const variantRawTail = roundedOffset(variantState, "tail", false);
  const variantHeadTier = `variantHeadTier=${offsetTier(variantHead, variantCase.simulation.windows)}`;
  const variantTailTier = `variantTailTier=${offsetTier(variantTail, variantCase.simulation.windows)}`;
  const variantRawTailTier = `variantRawTailTier=${offsetTier(variantRawTail, variantCase.simulation.windows)}`;
  const variantCombined5 = `variantCombined5=${combinedBucket(variantHead, variantTail, 5)}`;
  const variantCombined10 = `variantCombined10=${combinedBucket(variantHead, variantTail, 10)}`;
  const variantReleaseTail25 = `variantReleaseTail25=${stableReleaseTailBand(variantState, variantNote, 25)}`;
  const variantTailSource5 = `variantTailSource5=${stableTailSourceBand(variantState, variantNote, 5)}`;
  const ordinalDelta = change.variantOrdinal - change.baseOrdinal;
  const ordinalShift = ordinalDelta === 0
    ? "ordinalShift=0"
    : ordinalDelta < 0
      ? "ordinalShift=earlier"
      : ordinalDelta === 1
        ? "ordinalShift=+1"
        : "ordinalShift=+2+";
  const timeDelta = Math.round(change.variantEvent.time - change.baseEvent.time);
  const timeShift = Math.abs(timeDelta) <= 2
    ? "timeShift=0..2"
    : timeDelta < 0
      ? "timeShift=earlier"
      : timeDelta <= 80
        ? "timeShift=3..80"
        : "timeShift=>80";
  const baseFlags = stableStateFlagKeys(baseState).filter((flag) => flag !== "flag=any");
  const basePoss = `basePoss=${change.baseEvent.possibleJudgments?.join("") || "-"}`;
  const variantPoss = `variantPoss=${change.variantEvent.possibleJudgments?.join("") || "-"}`;

  const keys = [
    `${variantHeadTier};${variantTailTier}`,
    `${variantHeadTier};${variantTailTier};${variantCombined10}`,
    `${variantHeadTier};${variantTailTier};${variantCombined5}`,
    `${variantHeadTier};${variantRawTailTier};${variantTailSource5}`,
    `${variantCombined10};${variantTailSource5}`,
    `${variantCombined10};${variantReleaseTail25}`,
    `${basePoss};${variantPoss};${variantHeadTier};${variantTailTier}`,
    `${ordinalShift};${timeShift}`,
    `${variantHeadTier};${variantTailTier};${ordinalShift};${timeShift}`,
  ];

  for (const flag of baseFlags) {
    keys.push(`${flag};${variantHeadTier};${variantTailTier}`);
    keys.push(`${flag};${variantCombined10};${variantTailSource5}`);
  }

  return keys;
}

function printTimingChangeAggregate(title: string, aggregates: Map<string, TimingChangeAggregate>, limit: number): void {
  console.log(`\n${title}:`);
  const rows = [...aggregates.values()].sort((a, b) => (
    b.cases.size - a.cases.size
    || b.finalGain - a.finalGain
    || b.positive - a.positive
    || b.count - a.count
    || a.key.localeCompare(b.key)
  ));

  if (rows.length === 0) {
    console.log("  <none>");
    return;
  }

  for (const row of rows.slice(0, limit)) {
    console.log(
      `  gain ${row.finalGain > 0 ? "+" : ""}${row.finalGain} count ${row.count} `
      + `cases ${row.cases.size} +/${row.positive} -/${row.harmful} 0/${row.neutral} `
      + `ord ${row.ordinalImproves}/${row.ordinalWorsens} time ${row.timeImproves}/${row.timeWorsens} `
      + row.key,
    );
    for (const example of row.examples) console.log(`    ${example}`);
  }
}

async function printTimingChangeFeatureSuite(
  specs: CaseSpec[],
  options: SuiteOptions,
): Promise<void> {
  const label = options.timingChangeFeatureSuite;
  if (!label) return;
  const variant = uniqueTimingSuiteVariants().find((candidate) => candidate.label === label);
  if (!variant) {
    throw new Error(`Unknown timing variant "${label}". Run --timing-suite to list labels.`);
  }

  const variantOptions: SuiteOptions = {
    ...options,
    simulationOptions: variant.options,
    stableNextNoteEdgeGrace: undefined,
  };
  const [baseCases, variantCases] = await Promise.all([
    Promise.all(specs.map((spec, index) => loadCase(spec, index, options))),
    Promise.all(specs.map((spec, index) => loadCase(spec, index, variantOptions))),
  ]);
  const transitionAggregates = new Map<string, TimingChangeAggregate>();
  const variantResultAggregates = new Map<string, TimingChangeAggregate>();
  const shortestFeatureAggregates = new Map<string, TimingChangeAggregate>();
  const allFeatureAggregates = new Map<string, TimingChangeAggregate>();

  console.log("Stable replay suite timing change feature aggregate");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}, variant: ${label}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  for (let index = 0; index < baseCases.length; index++) {
    const suiteCase = baseCases[index];
    const variantCase = variantCases[index];
    const changes = changedTimingEvents(baseCases, suiteCase, variantCase);
    const variantDiff = variantCase.diff;
    console.log(
      `  ${suiteCase.spec.label.padEnd(22)} `
      + `base ${formatDiff(suiteCase.diff)} d=${countDistance(suiteCase.diff)} `
      + `variant ${formatDiff(variantDiff)} d=${countDistance(variantDiff)} `
      + `changed ${changes.length}`
      + `${suiteCase.spec.exactVeto ? " veto" : ""}`
      + `${countsEqual(variantCase.targetCounts, variantCase.currentCounts) ? " exact" : ""}`,
    );

    for (const change of changes) {
      const transition = `${change.from}->${change.to}`;
      addTimingChangeAggregate(transitionAggregates, transition, suiteCase, variantCase, change);
      addTimingChangeAggregate(
        shortestFeatureAggregates,
        `${transition} / ${shortestInterestingFeature(suiteCase, change.baseEvent)}`,
        suiteCase,
        variantCase,
        change,
      );
      for (const feature of timingVariantResultFeatureKeys(suiteCase, variantCase, change)) {
        addTimingChangeAggregate(
          variantResultAggregates,
          `${transition} / ${feature}`,
          suiteCase,
          variantCase,
          change,
        );
      }
      for (const feature of featureKeys(suiteCase, change.baseEvent)) {
        addTimingChangeAggregate(
          allFeatureAggregates,
          `${transition} / ${feature}`,
          suiteCase,
          variantCase,
          change,
        );
      }
    }
  }

  printTimingChangeAggregate("Transition aggregate", transitionAggregates, options.limit);
  printTimingChangeAggregate("Variant-result aggregate", variantResultAggregates, options.limit);
  printTimingChangeAggregate("Shortest-feature aggregate", shortestFeatureAggregates, options.limit);
  printTimingChangeAggregate("All-feature aggregate", allFeatureAggregates, options.limit);
}

async function printTimingSuite(
  specs: CaseSpec[],
  options: SuiteOptions,
): Promise<void> {
  const variants = uniqueTimingSuiteVariants();
  const evaluations: TimingSuiteEvaluation[] = [];

  for (const variant of variants) {
    evaluations.push(await evaluateTimingSuiteVariant(specs, options, variant));
  }

  evaluations.sort((a, b) => (
    a.exactVetoDistance - b.exactVetoDistance
    || a.nonVetoDistance - b.nonVetoDistance
    || a.nonVetoVisibleDistance - b.nonVetoVisibleDistance
    || a.totalDistance - b.totalDistance
    || a.label.localeCompare(b.label)
  ));

  console.log("Stable replay suite timing/options sweep");
  console.log(`Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}, variants ${evaluations.length}`);
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }

  for (const evaluation of evaluations.slice(0, options.limit)) {
    console.log(
      `  ${evaluation.label.padEnd(42)} `
      + `veto ${evaluation.exactVetoDistance}/${evaluation.exactVetoVisibleDistance} `
      + `open ${evaluation.nonVetoDistance}/${evaluation.nonVetoVisibleDistance} `
      + `total ${evaluation.totalDistance}/${evaluation.totalVisibleDistance} `
      + evaluation.compactDiff,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const specs = filterSpecs(options.exactOsgSuite ? EXACT_OSG_CASES : DEFAULT_CASES, options);
  if (options.timingSuite) {
    await printTimingSuite(specs, options);
    return;
  }
  if (options.timingChangeFeatureSuite) {
    await printTimingChangeFeatureSuite(specs, options);
    return;
  }
  const cases = await Promise.all(specs.map((spec, index) => loadCase(spec, index, options)));
  if (options.alignmentSuite) {
    printAlignmentSuite(cases, options);
    return;
  }
  if (options.batchSuite) {
    printBatchSuite(cases, options);
    return;
  }
  if (options.carrySuite) {
    printCarrySuite(cases, options);
    return;
  }
  if (options.openCarrySearch) {
    printOpenCarrySearch(cases, options);
    return;
  }
  if (options.eventPatchSearch) {
    printEventPatchSearch(cases, options);
    return;
  }
  if (options.localSupportFeatureSuite) {
    printLocalSupportFeatureSuite(cases, options);
    return;
  }
  if (options.traceFeature) {
    printFeatureTrace(cases, options);
    return;
  }
  if (options.exposureSuite) {
    printExposureSuite(cases, options);
    return;
  }
  if (options.openExposureFeatureSuite) {
    printOpenExposureFeatureSuite(cases, options);
    return;
  }

  console.log("Stable replay suite feature search");
  console.log(
    `Suite: ${options.exactOsgSuite ? "exact-osg" : "captures"}, `
    + `mode: ${options.mode}, maxDepth: ${options.maxDepth}, perNeed: ${options.perNeedLimit}, maxNodes: ${options.maxNodes}`
    + `${options.explicitOnly ? ", explicitOnly" : ""}`
    + `${options.localSupported ? ", localSupported" : ""}`,
  );
  if (options.stableNextNoteEdgeGrace != null) {
    console.log(`Stable next-note edge grace override: ${options.stableNextNoteEdgeGrace}ms`);
  }
  if (options.includedLabels.size > 0 || options.excludedLabels.size > 0) {
    console.log(
      `Filters: include ${[...options.includedLabels].join(", ") || "<none>"}, `
      + `exclude ${[...options.excludedLabels].join(", ") || "<none>"}`,
    );
  }
  console.log("\nBase cases:");
  for (const suiteCase of cases) {
    console.log(
      `  ${suiteCase.spec.label.padEnd(22)} `
      + `target ${formatCounts(suiteCase.targetCounts)} sim ${formatCounts(suiteCase.currentCounts)} `
      + `diff ${formatDiff(suiteCase.diff)} visible ${formatVisibleDiff(suiteCase.diff)}`
      + `${suiteCase.spec.exactVeto ? " veto" : ""}`
      + `${countsEqual(suiteCase.targetCounts, suiteCase.currentCounts) ? " exact" : ""}`,
    );
  }
  if (options.baseOnly) return;

  const transitions = neededTransitions(cases);
  console.log(`\nNeeded transitions: ${transitions.map((transition) => `${transition.from}->${transition.to}`).join(", ") || "none"}`);

  const candidates = buildCandidateRules(cases, options);
  console.log(`Candidate rules after ${options.mode} pruning: ${candidates.length}`);
  for (const rule of candidates.slice(0, Math.min(options.limit, 10))) {
    const next = addVectors(suiteDiffVector(cases), ruleDeltaVector(rule));
    console.log(
      `  ${rule.label} changes ${totalChanges(rule)} `
      + `residual ${distanceVector(suiteDiffVector(cases))}->${distanceVector(next)} `
      + `visible ${suiteVisibleDistance(cases, suiteDiffVector(cases))}->${suiteVisibleDistance(cases, next)} `
      + `fit +${rule.ordinalFitImprovement}/${rule.timeFitImprovement} `
      + `${formatLocalSupport(rule)} `
      + `${formatChangeList(cases, rule)}`,
    );
  }

  const exactSearch = searchExactSolutions(candidates, cases, options);
  const solutions = exactSearch.solutions;
  if (solutions.length > 0) {
    console.log(`\nExact ${options.mode} suite solutions: ${solutions.length} (visited ${exactSearch.visitedNodes}${exactSearch.hitNodeCap ? ", hit node cap" : ""})`);
    solutions.forEach((solution, index) => printSolution(cases, solution, index));
    return;
  }

  console.log(`\nExact ${options.mode} suite solutions: none (visited ${exactSearch.visitedNodes}${exactSearch.hitNodeCap ? ", hit node cap" : ""})`);
  console.log("\nClosest partial combinations:");
  const partials = beamPartialSolutions(candidates, cases, options);
  if (partials.length === 0) {
    console.log("  none");
    return;
  }

  partials.forEach((solution, index) => printSolution(cases, solution, index));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
