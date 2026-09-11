import type { Db } from "../db.js";
import { exec, execBatch, json, parseJson, type DbStatement } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo, logWarn } from "../logger.js";
import { nowIso } from "../shared/score.js";
import { selectRowsByIntegerSet } from "../shared/score-storage.js";
import type { OsuScoreStatistics } from "../shared/types.js";
import { isMsdSupportedKeyCount } from "../dan/msd.js";
import { invertManiaOsuText } from "../dan/invert-mod.js";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import { calculateManiaStarRating } from "../dan/mania-star-rating.js";
import { calculateManiaPp, getManiaPpModMultiplier, type ManiaPpCounts } from "../dan/mania-pp.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { CHART_ANALYSIS_VERSION } from "./chart-analysis.js";
import { CHART_FAMILY_VERSION } from "./chart-families.js";
import { loadPlayerSkillScoreDetails } from "./player-skill-score-details.js";
import {
  buildPlayerSkillPlay,
  computePlaySsrValues,
  danClearTargetFor,
  loadChartSkillInfo,
  loadLatestStoredPlayerSkillPayload,
  loadRateVerdictCredits,
  playSlotKey,
  readPlayerSkillPlayMetadata,
  type PlayerSkillPlay,
  type StoredPlaySsr,
  type StoredPlayerSkillPlays,
} from "./player-skills.js";

// Unrated plays: the board for the plays the skill ratings leave out.
//
// player-skills.ts turns two kinds of play away. A play on a vibro chart, or
// at a rate that makes the chart vibro, leaves the rated pool entirely and
// keeps only its explanation (`plays_json.vibroExcluded`). A play on a chart
// whose note structure makes its dan verdict unsafe (stacked same-column
// heads, `classification_json.danEligibility`) stays rated for MSD but can
// never credit a dan. Both are the right call for a rating that claims to
// measure skill, and neither changes here. This module is the other reading:
// what those plays are worth on their own terms, with every note counted.
//
// Three numbers per play. pp is computed locally from the chart's star rating
// at the played rate and the play's own judgement counts (dan/mania-pp.ts),
// which is how an unranked 126-star chart gets a pp number at all. MSD is the
// play's Overall SSR with `adjustVibro: false`, served from `chart_raw_ssr`, a
// chart-scoped cache keyed on (chart, rate, Invert variant, score goal), which
// is everything the calc's output depends on, so one row serves every player
// who set the same play. Dan is the chart's own verdict at the played rate,
// the same target the dan rules name when they reject the play.
//
// One row per (player, chart, rate, Invert variant) in `unrated_plays`,
// rewritten from `plays_json` after every skill compute (workers.ts) and
// filled once by a boot-seeded sweep. The board is a read-time view: one row
// per player and chart, their best play by whichever number the reader sorts
// on. Nothing in the ordinary pipeline reads either table.

/** Bump to recompute the raw SSR cache: a detector or calc change moves these values. */
export const CHART_RAW_SSR_VERSION = 1;
/** Bump to rewrite every stored row: a column or a pricing rule changed. */
export const UNRATED_PLAYS_VERSION = 1;

export const UNRATED_PLAYS_SWEEP_JOB = "unrated_plays_sweep";
// Bump history: `git log -S UNRATED_PLAYS_SWEEP_META_KEY`.
export const UNRATED_PLAYS_SWEEP_META_KEY = "unrated_plays_sweep_done:v1";
const SWEEP_USER_CHUNK = 200;
// A chunk yields the lane well before MinaCalc becomes the reason ingest is
// waiting. The sweep is one-shot and resumes from its cursor, so a small
// budget only costs wall clock.
const MAX_CALC_RUNS_PER_CHUNK = 40;
// The per-compute refresh runs on the same lane as the compute it follows,
// which already spent its own calc budget; a few runs cover a session's new
// vibro plays and the rest fill on the next compute.
const MAX_CALC_RUNS_PER_REFRESH = 12;

export const UNRATED_PLAYS_SORTS = ["pp", "msd", "dan"] as const;
export type UnratedPlaysSort = (typeof UNRATED_PLAYS_SORTS)[number];
export const UNRATED_PLAYS_RANGES = ["all", "week"] as const;
export type UnratedPlaysRange = (typeof UNRATED_PLAYS_RANGES)[number];
export const UNRATED_PLAYS_MAX_PAGE_SIZE = 50;
export const PLAYER_UNRATED_PLAYS_MAX = 200;
const BOARD_CACHE_TTL_MS = 5 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function isUnratedPlaysSort(value: unknown): value is UnratedPlaysSort {
  return typeof value === "string" && (UNRATED_PLAYS_SORTS as readonly string[]).includes(value);
}

export function isUnratedPlaysRange(value: unknown): value is UnratedPlaysRange {
  return typeof value === "string" && (UNRATED_PLAYS_RANGES as readonly string[]).includes(value);
}

// ── Raw SSR cache ───────────────────────────────────────────────────────────

/** One (chart, rate, variant, goal) the board needs an every-note rating for. */
export interface RawSsrTarget {
  slot: string;
  goalBp: number;
  beatmapId: number;
  rate: number;
  inverse: boolean;
  keyCount: number;
}

/** Goals are already quantized to 4dp upstream; key on the integer to keep the
 * primary key off floating-point equality. */
export function goalToBp(goal: number): number {
  return Math.round(goal * 10_000);
}

export function bpToGoal(goalBp: number): number {
  return goalBp / 10_000;
}

function rawSsrKey(target: Pick<RawSsrTarget, "slot" | "goalBp">): string {
  return `${target.slot}@${target.goalBp}`;
}

function toTarget(play: StoredPlaySsr | null | undefined): RawSsrTarget | null {
  if (!play) return null;
  const beatmapId = Math.floor(Number(play.beatmapId));
  const rate = Number(play.rate);
  const goal = Number(play.goal);
  const keyCount = Math.floor(Number(play.keyCount));
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  // A goal the calc cannot serve is not a rating problem the board can fix:
  // the play's own accuracy is at or under the floor whatever the notes were.
  if (!Number.isFinite(goal) || goal <= 0 || goal > 1) return null;
  if (!isMsdSupportedKeyCount(keyCount)) return null;
  const inverse = play.inverse === true;
  return { slot: playSlotKey(beatmapId, rate, inverse), goalBp: goalToBp(goal), beatmapId, rate, inverse, keyCount };
}

export async function readRawSsrValues(db: Db, slot: string, goalBp: number): Promise<Record<string, number> | null> {
  const row = (await exec(
    db,
    "select values_json from chart_raw_ssr where slot = ? and goal_bp = ? and version = ?",
    [slot, goalBp, CHART_RAW_SSR_VERSION],
  )).rows[0];
  return row ? parseJson<Record<string, number> | null>(String(row.values_json), null) : null;
}

/** The cached vectors for these targets, keyed `slot@goalBp`. */
async function readRawSsrVectors(db: Db, targets: RawSsrTarget[]): Promise<Map<string, Record<string, number>>> {
  const vectors = new Map<string, Record<string, number>>();
  const slots = [...new Set(targets.map((target) => target.slot))];
  for (let index = 0; index < slots.length; index += 400) {
    const page = slots.slice(index, index + 400);
    const rows = (await exec(
      db,
      `select slot, goal_bp, values_json from chart_raw_ssr
       where version = ? and slot in (${page.map(() => "?").join(",")})`,
      [CHART_RAW_SSR_VERSION, ...page],
    )).rows;
    for (const row of rows) {
      const values = parseJson<Record<string, number> | null>(String(row.values_json), null);
      if (values) vectors.set(`${String(row.slot)}@${Number(row.goal_bp)}`, values);
    }
  }
  return vectors;
}

/** LN share per chart, the one chart fact the SSR blend needs. */
async function readLnRatios(db: Db, beatmapIds: number[]): Promise<Map<number, number | null>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select beatmap_id, json_extract(classification_json, '$.lnRatio') as ln_ratio
     from beatmap_chart_analysis
     where analysis_version = ${CHART_ANALYSIS_VERSION} and beatmap_id in`,
    beatmapIds,
  );
  const ratios = new Map<number, number | null>();
  for (const row of rows) {
    const value = Number(row.ln_ratio);
    ratios.set(Number(row.beatmap_id), Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null);
  }
  return ratios;
}

export interface RawSsrFillResult {
  computed: number;
  cached: number;
  /** Targets left for a later pass because the calc budget ran out. */
  deferred: number;
  /** Targets with no cached .osu to rate; nothing here spends osu! API budget. */
  unavailable: number;
  /** MinaCalc passes this fill actually ran (a hold-bearing chart costs two). */
  calcRuns: number;
}

/**
 * Rate the targets the cache is missing and store them. Cached-file only, like
 * every other corpus sweep: a chart nobody has a file for is left for a later
 * run rather than pulling one through the osu! API budget. A budget of zero
 * defers every missing target without touching the calc.
 */
export async function fillRawSsrTargets(
  db: Db,
  targets: RawSsrTarget[],
  options: { maxCalcRuns?: number } = {},
): Promise<RawSsrFillResult> {
  const budget = Math.max(0, Math.floor(options.maxCalcRuns ?? MAX_CALC_RUNS_PER_CHUNK));
  const unique = new Map<string, RawSsrTarget>();
  for (const target of targets) unique.set(rawSsrKey(target), target);
  const cachedVectors = await readRawSsrVectors(db, [...unique.values()]);
  const missing = [...unique.values()].filter((target) => !cachedVectors.has(rawSsrKey(target)));
  const result: RawSsrFillResult = { computed: 0, cached: unique.size - missing.length, deferred: 0, unavailable: 0, calcRuns: 0 };
  if (missing.length === 0) return result;

  const lnRatios = await readLnRatios(db, missing.map((target) => target.beatmapId));
  // One file read and one Invert rewrite per chart, not per goal.
  const textCache = new Map<string, string | null>();
  for (const target of missing) {
    if (result.calcRuns >= budget) {
      result.deferred += 1;
      continue;
    }
    let ratedText = textCache.get(target.slot);
    if (ratedText === undefined) {
      const osuText = await readCachedBeatmapFile(db, target.beatmapId).catch(() => null);
      ratedText = osuText && target.inverse ? invertManiaOsuText(osuText) : osuText;
      textCache.set(target.slot, ratedText ?? null);
    }
    if (!ratedText) {
      result.unavailable += 1;
      continue;
    }
    const ssr = await computePlaySsrValues(ratedText, {
      rate: target.rate,
      keyCount: target.keyCount,
      goal: bpToGoal(target.goalBp),
      lnRatio: lnRatios.get(target.beatmapId) ?? null,
      adjustVibro: false,
    });
    if (!ssr) {
      result.unavailable += 1;
      continue;
    }
    result.calcRuns += ssr.calcRuns;
    await exec(
      db,
      `insert or replace into chart_raw_ssr (slot, goal_bp, version, beatmap_id, key_count, values_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [target.slot, target.goalBp, CHART_RAW_SSR_VERSION, target.beatmapId, target.keyCount, json(ssr.values), nowIso()],
    );
    result.computed += 1;
    // MinaCalc runs on its own thread; yield for the surrounding bookkeeping.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return result;
}

// ── Candidates ──────────────────────────────────────────────────────────────

export type UnratedPlayReason = "chart_vibro" | "rate_vibro" | "chart_ineligible";

export interface UnratedCandidate {
  play: StoredPlaySsr;
  reason: UnratedPlayReason;
  slot: string;
  /** The every-note SSR has to come from chart_raw_ssr: the play's own vector
   * is either empty (rejected outright) or rated on a trimmed chart. */
  rawSsr: boolean;
  target: RawSsrTarget | null;
}

function validPlay(play: StoredPlaySsr | null | undefined): play is StoredPlaySsr {
  return play != null
    && Number.isSafeInteger(play.beatmapId) && play.beatmapId > 0
    && Number.isFinite(play.rate) && play.rate > 0
    && Number.isInteger(play.keyCount) && play.keyCount > 0;
}

/**
 * Every play of one player the board lists, from the stored pool: the plays
 * the vibro rules rejected outright, plus the rated plays whose chart cannot
 * carry a dan. One per (keymode, chart, rate, Invert variant); a duplicate
 * slot keeps the more accurate play.
 */
export function collectUnratedCandidates(
  stored: Pick<StoredPlayerSkillPlays, "plays" | "danOnly" | "vibroExcluded">,
  chartIneligible: (beatmapId: number) => boolean,
): UnratedCandidate[] {
  const bySlot = new Map<string, UnratedCandidate>();
  const add = (play: StoredPlaySsr | null | undefined, reason: UnratedPlayReason) => {
    if (!validPlay(play)) return;
    const slot = playSlotKey(play.beatmapId, play.rate, play.inverse);
    const rawSsr = reason !== "chart_ineligible" || play.vibroAdjustment != null;
    const candidate: UnratedCandidate = { play, reason, slot, rawSsr, target: rawSsr ? toTarget(play) : null };
    const key = `${play.keyCount}:${slot}`;
    const existing = bySlot.get(key);
    if (existing && Number(existing.play.accuracy ?? 0) >= Number(play.accuracy ?? 0)) return;
    bySlot.set(key, candidate);
  };
  for (const entry of stored.vibroExcluded ?? []) {
    if (entry?.reason === "chart_vibro" || entry?.reason === "rate_vibro") add(entry.play, entry.reason);
  }
  for (const play of [...(stored.plays ?? []), ...(stored.danOnly ?? [])]) {
    // A sub-floor play has no honest number on any axis; the list is for the
    // plays that were good and still count for nothing.
    if (!validPlay(play) || play.ratingExcluded || !chartIneligible(play.beatmapId)) continue;
    add(play, "chart_ineligible");
  }
  return [...bySlot.values()];
}

// ── pp ──────────────────────────────────────────────────────────────────────

function ppCounts(statistics: OsuScoreStatistics | null | undefined): ManiaPpCounts | null {
  if (!statistics) return null;
  const read = (lazerKey: keyof OsuScoreStatistics, legacyKey: keyof OsuScoreStatistics): number =>
    Math.max(0, Number(statistics[lazerKey] ?? statistics[legacyKey] ?? 0)) || 0;
  const counts: ManiaPpCounts = {
    perfect: read("perfect", "count_geki"),
    great: read("great", "count_300"),
    good: read("good", "count_katu"),
    ok: read("ok", "count_100"),
    meh: read("meh", "count_50"),
    miss: read("miss", "count_miss"),
  };
  const total = counts.perfect + counts.great + counts.good + counts.ok + counts.meh + counts.miss;
  return total > 0 ? counts : null;
}

/**
 * What osu! would have paid for this play had the chart been ranked: the
 * star rating of the chart (or its Invert rewrite) at the played rate, the
 * play's own judgement counts, and the NF/EZ multipliers. Null when the
 * counts are gone or the file rates a different keymode than the play (a key
 * mod on a convert), where a number would be a guess.
 */
export function computeUnratedPlayPp(
  osuText: string,
  play: Pick<StoredPlaySsr, "keyCount" | "rate" | "mods">,
  statistics: OsuScoreStatistics | null | undefined,
): number | null {
  const counts = ppCounts(statistics);
  if (!counts) return null;
  const parsed = parseManiaBeatmap(osuText);
  if (parsed.keyCount !== play.keyCount || parsed.notes.length < 2) return null;
  const starRating = calculateManiaStarRating(parsed.notes, parsed.keyCount, play.rate);
  if (!(starRating > 0)) return null;
  const pp = calculateManiaPp({ starRating, counts, modMultiplier: getManiaPpModMultiplier(play.mods ?? []) });
  return Number.isFinite(pp) && pp > 0 ? Math.round(pp * 100) / 100 : null;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface UnratedPlayDan {
  rawDan: number;
  side: "rc" | "ln";
  label: string | null;
}

export interface UnratedPlayRow {
  userId: number;
  slot: string;
  beatmapId: number;
  keyCount: number;
  rate: number;
  inverse: boolean;
  reason: UnratedPlayReason;
  identity: string;
  scoreId: number | null;
  playedAt: string | null;
  accuracy: number | null;
  mods: string[] | null;
  pp: number | null;
  msd: number | null;
  msdValues: Record<string, number> | null;
  dan: UnratedPlayDan | null;
  play: StoredPlaySsr;
}

function positiveVector(values: Record<string, number> | null | undefined): Record<string, number> | null {
  return values && Number(values.Overall) > 0 ? values : null;
}

function scoreIdOf(identity: string): number | null {
  const match = /^official:(\d+)$/.exec(identity);
  const id = match ? Number(match[1]) : null;
  return id != null && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface UnratedPlaysRefreshResult extends RawSsrFillResult {
  rows: number;
}

const EMPTY_REFRESH: UnratedPlaysRefreshResult = { rows: 0, computed: 0, cached: 0, deferred: 0, unavailable: 0, calcRuns: 0 };

/**
 * Rewrite one player's rows from their stored pool. Called after every skill
 * compute and by the boot sweep, so the board follows the ratings without a
 * second pipeline. A play whose raw SSR the budget could not reach is stored
 * with no MSD rather than left out, and the next refresh fills it.
 */
export async function refreshUnratedPlaysForUser(
  db: Db,
  userId: number,
  options: { maxCalcRuns?: number; stored?: StoredPlayerSkillPlays | null } = {},
): Promise<UnratedPlaysRefreshResult> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return EMPTY_REFRESH;
  const stored = options.stored === undefined ? await loadLatestStoredPlayerSkillPayload(db, userId) : options.stored;
  if (!stored) {
    await exec(db, "delete from unrated_plays where user_id = ?", [userId]);
    return EMPTY_REFRESH;
  }
  const pool = [...(stored.plays ?? []), ...(stored.danOnly ?? [])].filter(validPlay);
  const rejected = (stored.vibroExcluded ?? []).map((entry) => entry?.play).filter(validPlay);
  const infoByBeatmap = await loadChartSkillInfo(db, [...pool, ...rejected].map((play) => play.beatmapId));
  const candidates = collectUnratedCandidates(stored, (beatmapId) => infoByBeatmap.get(beatmapId)?.danEligible === false);
  if (candidates.length === 0) {
    await exec(db, "delete from unrated_plays where user_id = ?", [userId]);
    return EMPTY_REFRESH;
  }

  const targets = candidates.flatMap((candidate) => (candidate.rawSsr && candidate.target ? [candidate.target] : []));
  const filled = await fillRawSsrTargets(db, targets, { maxCalcRuns: options.maxCalcRuns ?? MAX_CALC_RUNS_PER_REFRESH });
  const rawVectors = await readRawSsrVectors(db, targets);
  const plays = candidates.map((candidate) => candidate.play);
  const rateVerdicts = await loadRateVerdictCredits(db, plays);
  const scoreDetails = await loadPlayerSkillScoreDetails(db, userId, plays);

  // One file read and one Invert rewrite per chart, shared by every rate.
  const textCache = new Map<string, Promise<string | null>>();
  const loadText = (beatmapId: number, inverse: boolean): Promise<string | null> => {
    const key = `${beatmapId}:${inverse ? "inv" : "base"}`;
    let pending = textCache.get(key);
    if (!pending) {
      pending = readCachedBeatmapFile(db, beatmapId)
        .then((text) => (text && inverse ? invertManiaOsuText(text) : text))
        .catch(() => null);
      textCache.set(key, pending);
    }
    return pending;
  };

  const rows: UnratedPlayRow[] = [];
  for (const candidate of candidates) {
    const { play } = candidate;
    const info = infoByBeatmap.get(play.beatmapId);
    const target = info ? danClearTargetFor(play, info, play.keyCount, rateVerdicts) : null;
    const msdValues = candidate.rawSsr
      ? (candidate.target ? positiveVector(rawVectors.get(rawSsrKey(candidate.target))) : null)
      : positiveVector(play.values);
    const text = await loadText(play.beatmapId, play.inverse === true);
    const statistics = scoreDetails.get(play.identity)?.statistics ?? play.score?.statistics ?? null;
    const computedPp = text ? computeUnratedPlayPp(text, play, statistics) : null;
    // osu!'s own number when the file cannot price the play; zero on an
    // unranked chart, which is the whole reason for computing one.
    const storedPp = Number(play.pp);
    const accuracy = Number(play.accuracy);
    rows.push({
      userId,
      slot: candidate.slot,
      beatmapId: play.beatmapId,
      keyCount: play.keyCount,
      rate: play.rate,
      inverse: play.inverse === true,
      reason: candidate.reason,
      identity: String(play.identity ?? ""),
      scoreId: scoreIdOf(String(play.identity ?? "")),
      playedAt: typeof play.endedAt === "string" && Number.isFinite(Date.parse(play.endedAt)) ? play.endedAt : null,
      accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null,
      mods: Array.isArray(play.mods) ? play.mods.map((mod) => String(mod)) : null,
      pp: computedPp ?? (Number.isFinite(storedPp) && storedPp > 0 ? storedPp : null),
      msd: msdValues ? Math.round(Number(msdValues.Overall) * 100) / 100 : null,
      msdValues,
      dan: target ? { rawDan: Math.round(target.rawDan * 100) / 100, side: target.side, label: target.label } : null,
      play,
    });
  }
  await writeRows(db, userId, rows);
  return { ...filled, rows: rows.length };
}

async function writeRows(db: Db, userId: number, rows: UnratedPlayRow[]): Promise<void> {
  const computedAt = nowIso();
  const statements: DbStatement[] = [
    { sql: "delete from unrated_plays where user_id = ?", args: [userId] },
    ...rows.map((row): DbStatement => ({
      sql: `insert or replace into unrated_plays
        (user_id, slot, version, beatmap_id, key_count, rate, inverse, reason, identity, score_id, played_at, accuracy,
         mods_json, pp, msd, msd_json, dan, dan_side, dan_label, play_json, computed_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.userId, row.slot, UNRATED_PLAYS_VERSION, row.beatmapId, row.keyCount, row.rate, row.inverse ? 1 : 0, row.reason,
        row.identity, row.scoreId, row.playedAt, row.accuracy,
        row.mods ? json(row.mods) : null, row.pp, row.msd, row.msdValues ? json(row.msdValues) : null,
        row.dan?.rawDan ?? null, row.dan?.side ?? null, row.dan?.label ?? null,
        // The stored play minus its vector (the every-note one is beside it),
        // so the profile list can be built without re-reading plays_json.
        json({ ...row.play, values: {} }),
        computedAt,
      ],
    })),
  ];
  await execBatch(db, statements);
}

/** One player's stored rows, newest compute first is not a thing: they share one clock. */
async function readUserRows(db: Db, userId: number): Promise<UnratedPlayRow[]> {
  const rows = (await exec(
    db,
    `select slot, beatmap_id, key_count, rate, inverse, reason, identity, score_id, played_at, accuracy, mods_json,
            pp, msd, msd_json, dan, dan_side, dan_label, play_json
     from unrated_plays where user_id = ?`,
    [userId],
  )).rows;
  const result: UnratedPlayRow[] = [];
  for (const row of rows) {
    const play = parseJson<StoredPlaySsr | null>(String(row.play_json ?? ""), null);
    if (!play) continue;
    const reason = String(row.reason);
    if (reason !== "chart_vibro" && reason !== "rate_vibro" && reason !== "chart_ineligible") continue;
    const dan = row.dan == null ? null : Number(row.dan);
    result.push({
      userId,
      slot: String(row.slot),
      beatmapId: Number(row.beatmap_id),
      keyCount: Number(row.key_count),
      rate: Number(row.rate),
      inverse: Number(row.inverse) === 1,
      reason,
      identity: String(row.identity ?? ""),
      scoreId: row.score_id == null ? null : Number(row.score_id),
      playedAt: row.played_at == null ? null : String(row.played_at),
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
      mods: parseJson<string[] | null>(String(row.mods_json ?? ""), null),
      pp: row.pp == null ? null : Number(row.pp),
      msd: row.msd == null ? null : Number(row.msd),
      msdValues: parseJson<Record<string, number> | null>(String(row.msd_json ?? ""), null),
      dan: dan != null && Number.isFinite(dan)
        ? { rawDan: dan, side: row.dan_side === "ln" ? "ln" : "rc", label: row.dan_label == null ? null : String(row.dan_label) }
        : null,
      play,
    });
  }
  return result;
}

// ── Sweep ───────────────────────────────────────────────────────────────────

let ineligibleChartIdsMemory: { ids: number[]; readAt: number } | null = null;
const INELIGIBLE_IDS_TTL_MS = 10 * 60 * 1000;

/** Every chart the analyzer marked unsafe for dan credit; a few dozen rows. */
async function loadIneligibleChartIds(db: Db): Promise<number[]> {
  if (ineligibleChartIdsMemory && Date.now() - ineligibleChartIdsMemory.readAt < INELIGIBLE_IDS_TTL_MS) return ineligibleChartIdsMemory.ids;
  const rows = (await exec(
    db,
    `select beatmap_id from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready'
       and json_extract(classification_json, '$.danEligibility.eligible') = 0`,
    [CHART_ANALYSIS_VERSION],
  )).rows;
  const ids = rows.map((row) => Number(row.beatmap_id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  ineligibleChartIdsMemory = { ids, readAt: Date.now() };
  return ids;
}

export interface UnratedPlaysSweepChunkResult extends RawSsrFillResult {
  nextCursor: number;
  scanned: number;
  /** Players whose rows this chunk rewrote. */
  players: number;
  rows: number;
  done: boolean;
}

/**
 * One page of player ids, in user_id order. The page is bounded before the
 * JSON filter runs, so a long tail of players with nothing to list costs a
 * cheap id scan rather than a chunk that never returns. A player is only
 * visited when a stored row of theirs has a vibro rejection or a play on a
 * chart the analyzer marked ineligible.
 */
export async function runUnratedPlaysSweepChunk(
  db: Db,
  cursor: number,
  limit = SWEEP_USER_CHUNK,
  options: { maxCalcRuns?: number } = {},
): Promise<UnratedPlaysSweepChunkResult> {
  const page = (await exec(
    db,
    `select distinct user_id from player_skill_ratings
     where user_id > ?
     order by user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;
  const nextCursor = page.length ? Number(page[page.length - 1].user_id) : cursor;
  const done = page.length < Math.max(1, Math.floor(limit));
  const empty = { nextCursor, scanned: 0, players: 0, rows: 0, computed: 0, cached: 0, deferred: 0, unavailable: 0, calcRuns: 0, done };
  if (page.length === 0) return empty;

  const ineligible = await loadIneligibleChartIds(db);
  const ineligibleList = ineligible.map((id) => String(id)).join(",");
  const poolArm = ineligibleList
    ? `or exists (
           select 1 from json_each(json_extract(plays_json, '$.plays')) as play
           where json_extract(play.value, '$.beatmapId') in (${ineligibleList}))
         or exists (
           select 1 from json_each(coalesce(json_extract(plays_json, '$.danOnly'), '[]')) as play
           where json_extract(play.value, '$.beatmapId') in (${ineligibleList}))`
    : "";
  const matches = await selectRowsByIntegerSet(
    db,
    `select distinct user_id from player_skill_ratings
     where status = 'ready' and plays_json is not null
       and (json_array_length(coalesce(json_extract(plays_json, '$.vibroExcluded'), '[]')) > 0 ${poolArm})
       and user_id in`,
    page.map((row) => Number(row.user_id)),
  );
  const userIds = [...new Set(matches.map((row) => Number(row.user_id)))].filter((id) => Number.isSafeInteger(id) && id > 0);

  let budget = Math.max(0, Math.floor(options.maxCalcRuns ?? MAX_CALC_RUNS_PER_CHUNK));
  const totals = { ...empty, scanned: userIds.length };
  for (const userId of userIds) {
    const result = await refreshUnratedPlaysForUser(db, userId, { maxCalcRuns: budget });
    budget = Math.max(0, budget - result.calcRuns);
    totals.players += 1;
    totals.rows += result.rows;
    totals.computed += result.computed;
    totals.cached += result.cached;
    totals.deferred += result.deferred;
    totals.unavailable += result.unavailable;
    totals.calcRuns += result.calcRuns;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return totals;
}

export async function ensureUnratedPlaysSweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [UNRATED_PLAYS_SWEEP_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [UNRATED_PLAYS_SWEEP_JOB],
  )).rows[0];
  if (pending) return;
  await enqueueUnratedPlaysSweep(queue, 0);
}

export async function runUnratedPlaysSweepJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number; revision?: string } | undefined,
): Promise<void> {
  // A continuation queued before a version bump must not skip the prefix the
  // old version already answered and then mark the new one complete.
  const cursor = payload?.revision === UNRATED_PLAYS_SWEEP_META_KEY
    ? Math.max(0, Math.floor(Number(payload.cursor ?? 0))) : 0;
  const result = await runUnratedPlaysSweepChunk(db, cursor);
  if (result.players > 0) {
    logInfo("unrated_plays_sweep_chunk", {
      cursor, players: result.players, rows: result.rows,
      computed: result.computed, cached: result.cached,
      deferred: result.deferred, unavailable: result.unavailable,
    });
  }
  // Deferred targets belong to players this cursor is about to pass, so hold
  // the cursor until the page is actually rated rather than losing them. The
  // rows they wrote are complete except for those MSDs; the retry rewrites.
  if (result.deferred > 0) {
    await enqueueUnratedPlaysSweep(queue, cursor);
    return;
  }
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [UNRATED_PLAYS_SWEEP_META_KEY, json({ finishedAt: now }), now],
    );
    logInfo("unrated_plays_sweep_done", { finishedAt: now });
    return;
  }
  if (result.nextCursor <= cursor) {
    logWarn("unrated_plays_sweep_stalled", { cursor });
    return;
  }
  await enqueueUnratedPlaysSweep(queue, result.nextCursor);
}

async function enqueueUnratedPlaysSweep(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    UNRATED_PLAYS_SWEEP_JOB,
    `${UNRATED_PLAYS_SWEEP_JOB}:${cursor}`,
    { cursor, revision: UNRATED_PLAYS_SWEEP_META_KEY },
    { priority: -12, replaceDone: true },
  );
}

// ── The board ───────────────────────────────────────────────────────────────
// A read-time view over unrated_plays joined to users, sorted in JS. The skill
// board next door earns its typed arrays and its worker thread on a roster of
// tens of thousands; this table is a few thousand rows, so the same machinery
// here would be cost without a reason. If it ever grows into that shape,
// skill-leaderboards.ts is the pattern to copy.

export interface UnratedPlaysUser {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
  global_rank: number | null;
}

export interface UnratedPlayEntry {
  rank: number;
  user: UnratedPlaysUser;
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  creator: string | null;
  version: string;
  coverUrl: string | null;
  beatmapStatus: string | null;
  keyCount: number;
  rate: number;
  /** "DT" | "NC" | "HT" | "DC" when the play's mods are known; the rate
   * alone otherwise. */
  rateMod: string | null;
  mods: string[] | null;
  accuracy: number | null;
  playedAt: string | null;
  scoreId: number | null;
  reason: UnratedPlayReason;
  pp: number | null;
  msd: number | null;
  dan: UnratedPlayDan | null;
}

export interface UnratedPlaysSnapshot {
  /** Null when the board mixes every keymode. */
  keyCount: number | null;
  sort: UnratedPlaysSort;
  range: UnratedPlaysRange;
  ranking: UnratedPlayEntry[];
  /** Keymodes with a row in this scope and range, so a scope with only 4K
   * plays does not offer eight empty boards. */
  keyCounts: number[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: number;
}

interface BoardRow {
  user: UnratedPlaysUser;
  beatmapId: number;
  /** The chart this play is evidence for: its verified family, else the beatmap itself. */
  chartKey: string;
  keyCount: number;
  rate: number;
  rateMod: string | null;
  mods: string[] | null;
  accuracy: number | null;
  playedAt: string | null;
  playedAtMs: number | null;
  scoreId: number | null;
  reason: UnratedPlayReason;
  pp: number | null;
  msd: number | null;
  dan: UnratedPlayDan | null;
}

interface BoardMemory {
  rows: BoardRow[];
  builtAt: number;
}

const RATE_MOD_ACRONYMS = new Set(["DT", "NC", "HT", "DC"]);

function rateModOf(mods: string[] | null, rate: number): string | null {
  const known = mods?.find((mod) => RATE_MOD_ACRONYMS.has(mod));
  if (known) return known;
  if (Math.abs(rate - 1) < 0.01) return null;
  return rate > 1 ? "DT" : "HT";
}

/**
 * Same grouping as the skill ratings' evidence rule: a chart's note-verified
 * family stands in for its beatmap id, so a reupload (a rate edit, or the
 * chart with a few notes slipped into the intro) is the same chart on the
 * board. Invert plays stay apart from the original structure.
 */
export function chartKeyOf(keyCount: number, beatmapId: number, family: string | null, inverse: boolean): string {
  return `${keyCount}:${family ?? `beatmap:${beatmapId}`}:${inverse}`;
}

const boardByDb = new WeakMap<Db, BoardMemory>();
const boardBuildByDb = new WeakMap<Db, Promise<BoardMemory>>();

async function buildBoard(db: Db): Promise<BoardMemory> {
  const rows = (await exec(
    db,
    `select p.user_id as user_id, p.beatmap_id as beatmap_id, p.key_count as key_count, p.rate as rate,
            p.inverse as inverse, p.mods_json as mods_json, p.accuracy as accuracy, p.played_at as played_at,
            p.score_id as score_id, p.reason as reason, p.pp as pp, p.msd as msd, p.dan as dan,
            p.dan_side as dan_side, p.dan_label as dan_label, f.family_key as family_key,
            u.username as username, u.avatar_url as avatar_url,
            u.country_code as country_code, u.global_rank as global_rank
     from unrated_plays p
     join users u on u.user_id = p.user_id
     left join beatmap_chart_families f on f.beatmap_id = p.beatmap_id and f.version = ${CHART_FAMILY_VERSION}`,
  )).rows;
  const board: BoardRow[] = [];
  const users = new Map<number, UnratedPlaysUser>();
  for (const row of rows) {
    const userId = Number(row.user_id);
    let user = users.get(userId);
    if (!user) {
      user = {
        id: userId,
        username: String(row.username ?? ""),
        avatar_url: String(row.avatar_url ?? ""),
        country_code: String(row.country_code ?? "").toUpperCase(),
        global_rank: row.global_rank == null ? null : Number(row.global_rank),
      };
      users.set(userId, user);
    }
    const reason = String(row.reason);
    if (reason !== "chart_vibro" && reason !== "rate_vibro" && reason !== "chart_ineligible") continue;
    const rate = Number(row.rate);
    const mods = parseJson<string[] | null>(String(row.mods_json ?? ""), null);
    const playedAt = row.played_at == null ? null : String(row.played_at);
    const playedAtMs = playedAt ? Date.parse(playedAt) : Number.NaN;
    const dan = row.dan == null ? null : Number(row.dan);
    const beatmapId = Number(row.beatmap_id);
    const keyCount = Number(row.key_count);
    board.push({
      user,
      beatmapId,
      chartKey: chartKeyOf(keyCount, beatmapId, typeof row.family_key === "string" ? row.family_key : null, Boolean(Number(row.inverse))),
      keyCount,
      rate,
      rateMod: rateModOf(mods, rate),
      mods,
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
      playedAt,
      playedAtMs: Number.isFinite(playedAtMs) ? playedAtMs : null,
      scoreId: row.score_id == null ? null : Number(row.score_id),
      reason,
      pp: row.pp == null ? null : Number(row.pp),
      msd: row.msd == null ? null : Number(row.msd),
      dan: dan != null && Number.isFinite(dan)
        ? { rawDan: dan, side: row.dan_side === "ln" ? "ln" : "rc", label: row.dan_label == null ? null : String(row.dan_label) }
        : null,
    });
  }
  return { rows: board, builtAt: Date.now() };
}

async function readBoard(db: Db): Promise<BoardMemory> {
  const cached = boardByDb.get(db);
  if (cached && Date.now() - cached.builtAt < BOARD_CACHE_TTL_MS) return cached;
  const inFlight = boardBuildByDb.get(db);
  if (inFlight) return inFlight;
  const build = buildBoard(db).then((board) => {
    boardByDb.set(db, board);
    boardBuildByDb.delete(db);
    return board;
  }).catch((error) => {
    boardBuildByDb.delete(db);
    // A failed rebuild keeps serving the last good board rather than turning a
    // database blip into an empty leaderboard.
    if (cached) return cached;
    throw error;
  });
  boardBuildByDb.set(db, build);
  return build;
}

/** Drop the cached board, so a test or an admin action sees a fresh one. */
export function resetUnratedPlaysBoardCache(db: Db): void {
  boardByDb.delete(db);
}

function sortValue(row: Pick<BoardRow, "pp" | "msd" | "dan">, sort: UnratedPlaysSort): number | null {
  if (sort === "pp") return row.pp;
  if (sort === "msd") return row.msd;
  return row.dan?.rawDan ?? null;
}

/** Higher value first, then the more accurate play, then the newer one. */
function compareByValue<T extends { accuracy: number | null; playedAtMs?: number | null; playedAt?: string | null }>(
  valueOf: (row: T) => number | null,
): (left: T, right: T) => number {
  return (left, right) =>
    (valueOf(right) ?? -1) - (valueOf(left) ?? -1)
    || (right.accuracy ?? -1) - (left.accuracy ?? -1)
    || (right.playedAtMs ?? Date.parse(right.playedAt ?? "") ?? 0) - (left.playedAtMs ?? Date.parse(left.playedAt ?? "") ?? 0);
}

/**
 * The board's one-row-per-player-per-chart rule, decided by the number being
 * sorted on: the best pp play on a chart and its best MSD play are often two
 * different scores (a DT play usually wins MSD and loses pp), so each sort
 * picks its own. A chart is its `chartKey`, so reuploads of one chart share a
 * row. Rows with no value on that axis are not ranked by it.
 */
export function selectBoardRows<T extends { user: { id: number }; beatmapId: number; chartKey: string; accuracy: number | null; playedAtMs: number | null }>(
  rows: T[],
  valueOf: (row: T) => number | null,
): T[] {
  const best = new Map<string, T>();
  const compare = compareByValue(valueOf);
  for (const row of rows) {
    if (valueOf(row) == null) continue;
    const key = `${row.user.id}:${row.chartKey}`;
    const current = best.get(key);
    if (!current || compare(row, current) < 0) best.set(key, row);
  }
  return [...best.values()].sort((left, right) => compare(left, right) || left.user.id - right.user.id || left.beatmapId - right.beatmapId);
}

export async function getUnratedPlaysBoard(
  db: Db,
  options: { country?: string | null; keyCount: number | null; sort?: UnratedPlaysSort; range?: UnratedPlaysRange; page?: number; pageSize?: number },
): Promise<UnratedPlaysSnapshot> {
  const board = await readBoard(db);
  const country = (options.country ?? "").trim().toUpperCase();
  const sort: UnratedPlaysSort = isUnratedPlaysSort(options.sort) ? options.sort : "pp";
  const range: UnratedPlaysRange = isUnratedPlaysRange(options.range) ? options.range : "all";
  const since = range === "week" ? Date.now() - WEEK_MS : null;
  const scoped = board.rows.filter((row) =>
    (!country || country === "GLOBAL" || row.user.country_code === country)
    && (since == null || (row.playedAtMs != null && row.playedAtMs >= since)));
  const keyCounts = [...new Set(scoped.map((row) => row.keyCount))].sort((a, b) => a - b);
  // No keymode means every keymode side by side: a plays list, not a rating,
  // so the numbers need not be comparable across ladders to be listed.
  const inKeymode = options.keyCount == null ? scoped : scoped.filter((row) => row.keyCount === options.keyCount);
  const ranked = selectBoardRows(inKeymode, (row) => sortValue(row, sort));
  const pageSize = Math.max(1, Math.min(UNRATED_PLAYS_MAX_PAGE_SIZE, Math.floor(options.pageSize ?? UNRATED_PLAYS_MAX_PAGE_SIZE)));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const start = (page - 1) * pageSize;
  const pageRows = ranked.slice(start, start + pageSize);
  const metadata = await readPlayerSkillPlayMetadata(db, pageRows.map((row) => row.beatmapId));
  return {
    keyCount: options.keyCount,
    sort,
    range,
    ranking: pageRows.map((row, index) => {
      const map = metadata.get(row.beatmapId);
      return {
        rank: start + index + 1,
        user: row.user,
        beatmapId: row.beatmapId,
        beatmapsetId: map?.beatmapsetId ?? null,
        title: map?.title ?? "Unknown map",
        artist: map?.artist ?? "Unknown artist",
        creator: map?.creator ?? null,
        version: map?.version ?? `${row.keyCount}K`,
        coverUrl: map?.coverUrl ?? null,
        beatmapStatus: map?.status ?? null,
        keyCount: row.keyCount,
        rate: row.rate,
        rateMod: row.rateMod,
        mods: row.mods,
        accuracy: row.accuracy,
        playedAt: row.playedAt,
        scoreId: row.scoreId,
        reason: row.reason,
        pp: row.pp,
        msd: row.msd,
        dan: row.dan,
      };
    }),
    keyCounts,
    total: ranked.length,
    page,
    pageSize,
    fetchedAt: board.builtAt,
  };
}

// ── One player's list ───────────────────────────────────────────────────────

export type PlayerUnratedPlaysSort = UnratedPlaysSort | "recent";

export interface PlayerUnratedPlay {
  play: PlayerSkillPlay;
  reason: UnratedPlayReason;
  pp: number | null;
  msd: number | null;
  dan: UnratedPlayDan | null;
}

export interface PlayerUnratedPlaysPage {
  keyCount: number;
  sort: PlayerUnratedPlaysSort;
  items: PlayerUnratedPlay[];
  total: number;
  /** Every keymode this player has a row in, for the explorer's keymode strip. */
  keyCounts: number[];
}

/**
 * The profile's Unrated plays view: every stored row of one keymode, so the
 * reader sees each rate of a chart rather than the board's one-per-chart pick.
 * Rows with no value on the sorted axis go last rather than out: on a
 * player's own list, a play with no pp is still their play.
 */
export async function getPlayerUnratedPlays(
  db: Db,
  userId: number,
  keyCount: number,
  options: { sort?: PlayerUnratedPlaysSort; limit?: number } = {},
): Promise<PlayerUnratedPlaysPage> {
  const sort: PlayerUnratedPlaysSort = options.sort === "recent" || isUnratedPlaysSort(options.sort) ? options.sort : "msd";
  const rows = await readUserRows(db, userId);
  const keyCounts = [...new Set(rows.map((row) => row.keyCount))].sort((a, b) => a - b);
  const inKeymode = rows.filter((row) => row.keyCount === keyCount);
  const ordered = sort === "recent"
    ? [...inKeymode].sort((left, right) => {
      const leftAt = left.playedAt ?? "";
      const rightAt = right.playedAt ?? "";
      if (leftAt !== rightAt) {
        if (leftAt === "") return 1;
        if (rightAt === "") return -1;
        return rightAt.localeCompare(leftAt);
      }
      return (right.msd ?? -1) - (left.msd ?? -1) || left.beatmapId - right.beatmapId;
    })
    : [...inKeymode].sort((left, right) =>
      compareByValue<UnratedPlayRow>((row) => sortValue(row, sort))(left, right) || left.beatmapId - right.beatmapId);
  const limit = Math.max(1, Math.min(PLAYER_UNRATED_PLAYS_MAX, Math.floor(options.limit ?? PLAYER_UNRATED_PLAYS_MAX)));
  const page = ordered.slice(0, limit);
  const metadata = await readPlayerSkillPlayMetadata(db, page.map((row) => row.beatmapId));
  const scoreDetails = await loadPlayerSkillScoreDetails(db, userId, page.map((row) => row.play));
  return {
    keyCount,
    sort,
    items: page.map((row) => {
      const stored: StoredPlaySsr = { ...row.play, values: row.msdValues ?? {} };
      const play = buildPlayerSkillPlay(stored, row.msd ?? 0, keyCount, metadata, scoreDetails);
      // The row's own numbers, not the pool's: the list is about what these
      // plays are worth on their own terms, so the rating column is the
      // every-note MSD and pp is the computed one.
      play.pp = row.pp;
      delete play.ratingExcluded;
      delete play.ratingExclusionReason;
      return { play, reason: row.reason, pp: row.pp, msd: row.msd, dan: row.dan };
    }),
    total: inKeymode.length,
    keyCounts,
  };
}
