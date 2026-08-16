import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { LN_TAIL_BLEND_BY_KEYMODE, LN_TAIL_MIN_RATIO, blendLnTailValues, computeMsd, isMsdSupportedKeyCount } from "../dan/msd.js";
import type { JobQueue } from "../jobs/queue.js";
import { readConfig } from "../config.js";
import { errorContext, logWarn } from "../logger.js";
import { CHART_ANALYSIS_VERSION, enqueueMissingChartAnalyses } from "./chart-analysis.js";
import { getCachedBeatmapFile, readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import type { OsuApiClient } from "../osu/client.js";
import { fetchAndStoreProfileSnapshotShared, getCachedPlayerProfileSnapshot, persistSessionProfileSnapshot } from "./player-profiles.js";
import { calculateStableAccuracy, getDisplayedAccuracy, getScoreIdentity, getStoredScoreAccuracy, isLazerScore, nowIso } from "../shared/score.js";
import { selectRowsByIntegerSet } from "../shared/score-storage.js";
import { buildPlayerAccModel } from "./player-acc-model.js";
import { danTableLabelFor } from "../dan/chart-classifier.js";
import { parseDan } from "../dan/dan-estimator/labels.js";
import { parseLnDan } from "../dan/dan-estimator/ln.js";
import type { OscScore, OsuMod, OsuScoreStatistics } from "../shared/types.js";

// Etterna-style player skill ratings from the player's plays: each play gets
// MinaCalc SSRs (the MSD skillsets computed at the play's music rate with the
// play's accuracy as the score goal), aggregated per keymode with Etterna's
// erfc rating aggregation. Replaces the old activity-vector "playstyle
// fingerprint" as the my-stats skill surface.
//
// Input is the top plays PLUS the player's tracked plays still inside the
// score_events retention window, deduped to the best play per (chart, rate).
// Rated plays are retained across recomputes even after their score payload
// ages out of retention (the per-play SSR cache is the durable record), so a
// tracked player's rating history accumulates beyond the top-200 from the
// moment tracking starts. Vibro-flagged charts are excluded everywhere: the
// calc reads mash walls as density and rates them absurdly.
//
// MinaCalc's skillset taxonomy is 4K-born, so each keymode additionally gets
// per-pattern ratings in our own vocabulary: the play's Overall SSRs
// aggregated over the chart-analysis pattern tags of the charts they were set
// on ("your rating on chordstream charts"). The 4K card shows the native MSD
// skillsets; 6K/7K show these pattern ratings instead.
//
// Rates come from the rate mods: DT/NC 1.5x and HT/DC 0.75x by default, or
// the exact speed_change a lazer mod carries (MinaCalc takes the rate as a
// plain float, so 1.15x is as computable as 1.5x). Custom rates earn no pp,
// so they only ever arrive through tracked history, never the top-200. Wind
// up/down and adaptive speed have no single rate and stay skipped.
//
// The score goal is an estimated Wife3 percent from the play's judgement
// counts, not raw osu! accuracy: osu! accuracy weighs MAX and 300 identically,
// so nearly every top play sits at 97%+ and would saturate MinaCalc's 0.965
// goal cap. The Wife estimate spreads that band back out (MAX:300 ratio is
// the signal), values each judgement against the chart's own OD hit windows
// (a 300 earned inside OD0's +-64ms is far weaker evidence than one inside
// OD8's +-40ms), and goals that still land above the cap get their SSRs
// log-linearly extrapolated from the calc's own 0.93 -> 0.965 slope.

// v14: mod-less archived day-best rows no longer rate at an assumed 1.0x
// (that inflated HT/DC originals); stored plays built from them purge.
// v15: LN-tail blend - SSRs on hold-bearing charts blend toward a second
// calc pass that sees LN releases as rows, closing the systematic deficit
// for LN players (keymode-calibrated; rice charts unchanged).
// v16: wife goals value judgements against the chart's real OD hit windows
// (plus stable EZ/HR window scaling) instead of assumed OD8, so low-OD
// charts stop reading easy 300s as near-MAX precision; stored plays rated
// under the OD8 assumption purge.
export const PLAYER_SKILLS_VERSION = 16;
export const PLAYER_SKILLS_JOB = "compute_player_skills";

export const SKILL_RATING_SKILLSETS = [
  "Overall",
  "Stream",
  "Jumpstream",
  "Handstream",
  "Stamina",
  "JackSpeed",
  "Chordjack",
  "Technical",
] as const;

const READY_RECOMPUTE_TTL_MS = 12 * 60 * 60_000;
const PENDING_RETRY_TTL_MS = 30 * 60_000;
const RUNNING_REQUEUE_MS = 10 * 60_000;
const FAILED_RETRY_MS = 10 * 60_000;
// A pattern rating from one or two plays is an anecdote, not a rating.
const PATTERN_RATING_MIN_PLAYS = 3;
// Chart analysis stores every detected pattern down to trace hits, so common
// tags (ln, tech) land on nearly every chart and would aggregate to a copy of
// Overall. A chart only counts toward a pattern it is meaningfully made of.
const PATTERN_TAG_MIN_SCORE = 0.5;
// A chart the analyzer reads as near-certain chordjack never counts as a tech
// chart, even when its tech score clears the bar: dense chordjack saturates
// the tech detector's ingredients (chord-size churn, direction changes, row
// variety), so pure CJ charts carried a 0.5-0.76 tech score and, ranked by
// Overall SSR, topped every "top Tech plays" list. Checked 2026-08 against
// mapper-tagged sets: only ~2-3% of tech-labelled diffs reach chordjack 0.8,
// so the veto costs genuine tech charts almost nothing, while unambiguous CJ
// diffs (chordjack >= 0.8) carried a false tech tag 75-88% of the time.
const TECH_TAG_CHORDJACK_VETO = 0.8;
const SSR_GOAL_MIN = 0.8;
// The calc clamps goals above 0.965 internally (Etterna's SSR cap); goals
// above it are served by extrapolating from the calc's slope between the MSD
// baseline goal and the cap. Exported for the approximate-SSR baseline, which
// anchors its accuracy derate on the same window.
export const SSR_CALC_GOAL_CAP = 0.965;
export const SSR_EXTRAPOLATION_BASE_GOAL = 0.93;
// Ceiling for Wife-estimated goals: an all-MAX play estimates ~0.998, and the
// log-linear extrapolation should not be trusted much further past the cap
// than the width of the slope window it was measured on.
const SSR_GOAL_CAP = 0.9975;
// Safety bound on the per-chart 0.93->0.965 slope used for extrapolation
// (measured ~1.07-1.11 on real charts).
const SSR_EXTRAPOLATION_MAX_SLOPE = 1.2;
// Expected normalized Wife3 points per osu!mania judgement: Etterna's wife3
// curve (J4: full points inside 5ms, erf falloff with dev 22.7 crossing zero
// at 65ms, linear to the -2.75 miss weight at 180ms, all normalized to
// marvelous = 1) averaged uniformly over each judgement's band of the chart's
// stable hit windows (MAX +-16.5ms fixed; 300/200/100/50 at 64/97/127/151
// minus 3ms per OD point; at OD8 that is the familiar +-40/73/103/127). The
// MAX vs 300 split is the load-bearing part: osu! accuracy scores both as
// 100%, Wife3 does not, which is what lets two 99%+ plays with different
// MAX:300 ratios rate differently. Valuing the bands at the chart's real OD
// is what keeps low-OD charts honest: the MAX window does not scale with OD,
// so true precision keeps its full value, while a 300 earned inside OD0's
// +-64ms band averages ~0.75 instead of OD8's ~0.97. Unknown OD falls back
// to the OD8 assumption these constants historically hardcoded. Lazer plays
// share the stable window model (same assumption the fixed table made), and
// their LN-side leniency is handled by the lnRatio goal fade below.
const WIFE3_FULL_POINTS_MS = 5;
const WIFE3_ZERO_MS = 65;
const WIFE3_ERF_DEV_MS = 22.7;
const WIFE3_MISS_MS = 180;
const WIFE3_MISS_POINTS = -2.75;
const STABLE_MAX_WINDOW_MS = 16.5;
const STABLE_WINDOW_BASES_MS = { great: 64, good: 97, ok: 127, meh: 151 } as const;
const OD_WINDOW_STEP_MS = 3;
// Stored score payloads and old beatmap rows may carry no OD; assume the OD8
// the old constants hardcoded so behavior degrades to the historical one.
const ASSUMED_OD = 8;

type WifeJudgement = "perfect" | keyof typeof STABLE_WINDOW_BASES_MS | "miss";

function wife3PointsAt(ms: number): number {
  if (ms <= WIFE3_FULL_POINTS_MS) return 1;
  if (ms <= WIFE3_ZERO_MS) return erf((WIFE3_ZERO_MS - ms) / WIFE3_ERF_DEV_MS);
  if (ms >= WIFE3_MISS_MS) return WIFE3_MISS_POINTS;
  return (WIFE3_MISS_POINTS * (ms - WIFE3_ZERO_MS)) / (WIFE3_MISS_MS - WIFE3_ZERO_MS);
}

function wife3BandAverage(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return wife3PointsAt(toMs);
  const steps = 512;
  const step = (toMs - fromMs) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i += 1) sum += wife3PointsAt(fromMs + (i + 0.5) * step);
  return sum / steps;
}

const expectedWife3PointsCache = new Map<string, Record<WifeJudgement, number>>();

function expectedWife3Points(od: number, windowScale: number): Record<WifeJudgement, number> {
  const key = `${od}|${windowScale}`;
  const cached = expectedWife3PointsCache.get(key);
  if (cached) return cached;
  const edges = [
    STABLE_MAX_WINDOW_MS * windowScale,
    ...Object.values(STABLE_WINDOW_BASES_MS).map((base) => (base - OD_WINDOW_STEP_MS * od) * windowScale),
  ];
  const points = {
    perfect: wife3BandAverage(0, edges[0]),
    great: wife3BandAverage(edges[0], edges[1]),
    good: wife3BandAverage(edges[1], edges[2]),
    ok: wife3BandAverage(edges[2], edges[3]),
    meh: wife3BandAverage(edges[3], edges[4]),
    miss: WIFE3_MISS_POINTS,
  };
  expectedWife3PointsCache.set(key, points);
  return points;
}

// Etterna's rating_scaler from ScoreManager::CalcPlayerRating.
const AGGREGATE_RATING_SCALER = 1.04;

// Player dan clear rules, all in one block by design (they are the tunable
// community-convention part). A clear is accuracy >= 96% (the usual dan bar)
// with a small miss allowance - but a single ranked chart is far shorter than
// a four-chart dan course, so a bare scrape is thin evidence: a clear only
// credits the chart's full rawDan at DAN_CREDIT_FULL_ACCURACY and the credit
// fades linearly to -DAN_CREDIT_MAX_DISCOUNT at the 96% floor (you own the
// dan you play comfortably, and sit well below the one you scrape). The
// player's dan is the DAN_CLEAR_QUORUM-th best credited clear, exactly what
// the plays demonstrate (no widen on top), so estimator-tail outliers can
// never set it.
//
// The credit curve models how much of a chart's rated difficulty a clear at
// a given accuracy actually demonstrates. It absorbs three causes that are
// not fixable at this layer: lazer's lenient LN judgement inflates 4K LN
// accuracy (the scoring system's doing), one short ranked chart is thinner
// evidence than a 4-chart course (structural), and the chart estimator's
// scale runs hot in places (7K rice ~a level high at scrape acc). The
// curves are per side AND per keymode because those causes invert between
// 4K and 7K: 4K LN demands near-perfect acc for full credit while 4K rice
// reaches it at 98%; 7K rice takes the harsh curve while 7K LN acc is
// genuinely hard-earned - a 96% pass credits the full chart dan. Anchored
// 2026-07 against reference players with independently known dan levels on
// both keymodes and both sides; re-anchor the same way before changing them.
const DAN_CLEAR_MIN_ACCURACY = 0.96;
const DAN_CLEAR_MAX_MISS_SHARE = 0.015;
const DAN_CLEAR_QUORUM = 4;
function danCreditFor(side: "rc" | "ln", keyCount: number): { fullAccuracy: number; maxDiscount: number } {
  if (keyCount === 7) {
    return side === "ln" ? { fullAccuracy: 0.98, maxDiscount: 0 } : { fullAccuracy: 0.995, maxDiscount: 1.5 };
  }
  return side === "ln" ? { fullAccuracy: 0.995, maxDiscount: 1.5 } : { fullAccuracy: 0.98, maxDiscount: 0.4 };
}

export interface PlayerSkillPatternRating {
  id: string;
  rating: number;
  plays: number;
}

// The community-legible axis: "4K RC ~ 8th dan". rawDan is continuous on the
// chart-dan scale (labels via parseDan); clears counts the qualifying plays
// that back it.
export interface PlayerSkillDanSide {
  rawDan: number;
  label: string;
  clears: number;
}

export interface PlayerSkillModeDan {
  rc: PlayerSkillDanSide | null;
  ln: PlayerSkillDanSide | null;
}

export interface PlayerSkillModeBreakdown {
  keyCount: number;
  analyzedPlays: number;
  ratings: Record<string, number>;
  patterns: PlayerSkillPatternRating[];
  dan?: PlayerSkillModeDan;
}

export interface PlayerSkillQueueStatus {
  state: "queued" | "running";
  // 1-based position among jobs waiting in the MinaCalc worker lane (shared
  // with dan estimates and other players' skill computes); null while running.
  position: number | null;
  waiting: number;
}

export interface PlayerSkillBreakdown {
  status: "pending" | "ready" | "failed";
  version: number;
  computedAt: string | null;
  totalPlays: number;
  analyzedPlays: number;
  pendingPlays: number;
  unsupportedPlays: number;
  modes: PlayerSkillModeBreakdown[];
  queue?: PlayerSkillQueueStatus | null;
  // Ready rows only: the served snapshot is known-superseded (past the
  // recompute TTL, pending plays due a retry, or newer top plays landed) and
  // a recompute is on its way. Clients should present the numbers as
  // refreshing rather than final, and may poll until a fresh computedAt
  // arrives - without this the stale value paints as final and silently
  // swaps on the next visit.
  stale?: boolean;
}

export const PLAYER_SKILL_PATTERN_AXES = [
  "chordstream",
  "bracket",
  "delay",
  "stream",
  "jack",
  "chordjack",
  "tech",
  "ln",
] as const;

export interface PlayerSkillPlay {
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  creator: string | null;
  version: string;
  coverUrl: string | null;
  keyCount: number;
  rating: number;
  overallRating: number;
  pp: number | null;
  accuracy: number | null;
  rate: number;
  playedAt: string | null;
  source: "top" | "tracked";
  scoreId: number | null;
}

export interface PlayerSkillPlaysPage {
  items: PlayerSkillPlay[];
  total: number;
  limit: number;
  offset: number;
}

const PLAYER_SKILL_AXES = new Set<string>([
  ...SKILL_RATING_SKILLSETS.filter((axis) => axis !== "Overall"),
  ...PLAYER_SKILL_PATTERN_AXES.map((axis) => `pattern:${axis}`),
]);

export function isPlayerSkillAxis(axis: string): boolean {
  return PLAYER_SKILL_AXES.has(axis);
}

interface StoredPlaySsr {
  identity: string;
  beatmapId: number;
  keyCount: number;
  rate: number;
  goal: number;
  pp: number;
  values: Record<string, number>;
  // Chart-analysis pattern tags for the play's chart. Refreshed from the DB on
  // every compute (analysis rows land after plays do), never part of the SSR
  // reuse key.
  patterns: string[];
  // Which input the winning play came from; percentile decoration compares
  // only top-sourced plays against the top-plays-based population baseline.
  source?: "top" | "tracked";
  // Clear evidence for player dan, stored so retained plays keep qualifying
  // after their score payload ages out of score_events retention.
  accuracy?: number;
  // 320-weighted custom accuracy (calculateManiaCustomAccuracy), the quantity
  // mania pp is linear in via (5 * acc - 4) and the accuracy model's target.
  // Backfills on the next recompute for still-visible plays; retained plays
  // cached before the field existed stay undefined and the model estimates
  // them from stableAccuracy + goal (player-acc-model.ts).
  customAccuracy?: number | null;
  // Stable-formula accuracy from the judgement counts (MAX counted as 300):
  // the one currency both clients share for rice, so lazer rice clears are
  // not judged ~0.5pp harsher than stable ones. Null when counts are gone
  // (acc-only archived rows).
  stableAccuracy?: number | null;
  missShare?: number | null;
  endedAt?: string | null;
}

interface StoredModesSummary {
  totalPlays: number;
  analyzedPlays: number;
  pendingPlays: number;
  unsupportedPlays: number;
  modes: PlayerSkillModeBreakdown[];
}

/**
 * The constant music rate a play was set at: the rate mod's default 1.5x or
 * 0.75x, or the custom speed_change it carries. Null when no single rate
 * exists (wind up/down, adaptive speed) or the speed value is corrupt, in
 * which case the play is skipped rather than mis-rated.
 */
export function getPlayRate(mods: OsuMod[] | string[] | undefined): number | null {
  let rate = 1;
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "DT" || acronym === "NC") {
      const speed = modSpeed(mod, 1.5);
      if (speed == null) return null;
      rate *= speed;
    } else if (acronym === "HT" || acronym === "DC") {
      const speed = modSpeed(mod, 0.75);
      if (speed == null) return null;
      rate *= speed;
    } else if (acronym === "WU" || acronym === "WD" || acronym === "AS") {
      return null;
    }
  }
  return Math.round(rate * 100) / 100;
}

function modSpeed(mod: OsuMod | string, defaultSpeed: number): number | null {
  if (typeof mod === "string") return defaultSpeed;
  if (mod.settings?.speed_change == null) return defaultSpeed;
  const speed = Number(mod.settings.speed_change);
  // Lazer's own slider bounds; a value outside them is a corrupt payload,
  // not a rate anyone played at.
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : null;
}

export function ssrGoalForAccuracy(accuracy: number): number {
  const acc = Number.isFinite(accuracy) ? accuracy : 0.93;
  return Math.round(Math.max(SSR_GOAL_MIN, Math.min(SSR_CALC_GOAL_CAP, acc)) * 10_000) / 10_000;
}

/**
 * Estimated Wife3 percent from a play's judgement counts (lazer or stable
 * naming), or null when the score carries no counts. `od` is the chart's
 * overall difficulty (null assumes the historical OD8) and `windowScale`
 * widens/tightens every window (stable EZ/HR).
 */
export function estimateWifeAccuracy(
  statistics: OsuScoreStatistics | undefined,
  options?: { od?: number | null; windowScale?: number },
): number | null {
  if (!statistics) return null;
  // od == null must fall back to the assumption, not read as a real OD 0.
  const rawOd = options?.od == null ? Number.NaN : Number(options.od);
  const od = Number.isFinite(rawOd) ? Math.max(0, Math.min(10, rawOd)) : ASSUMED_OD;
  const rawScale = Number(options?.windowScale);
  const windowScale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const expected = expectedWife3Points(od, windowScale);
  const counts: Record<WifeJudgement, number> = {
    perfect: readCount(statistics.perfect ?? statistics.count_geki),
    great: readCount(statistics.great ?? statistics.count_300),
    good: readCount(statistics.good ?? statistics.count_katu),
    ok: readCount(statistics.ok ?? statistics.count_100),
    meh: readCount(statistics.meh ?? statistics.count_50),
    miss: readCount(statistics.miss ?? statistics.count_miss),
  };
  let total = 0;
  let points = 0;
  for (const [name, count] of Object.entries(counts) as Array<[WifeJudgement, number]>) {
    total += count;
    points += count * expected[name];
  }
  return total > 0 ? points / total : null;
}

function readCount(value: number | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

type SsrGoalScore = Pick<OscScore, "accuracy" | "statistics" | "type" | "legacy_score_id" | "legacy_total_score"> & {
  mods?: OscScore["mods"] | string[];
};

// Stable multiplies every mania hit window by 1.4 under EZ and divides it by
// 1.4 under HR; lazer's mania EZ/HR leave timing windows alone, so only
// legacy-judged plays scale.
const STABLE_EZ_WINDOW_SCALE = 1.4;

function stableWindowScale(score: SsrGoalScore): number {
  if (isLazerScore(score as OscScore)) return 1;
  let scale = 1;
  for (const mod of score.mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "EZ") scale *= STABLE_EZ_WINDOW_SCALE;
    else if (acronym === "HR") scale /= STABLE_EZ_WINDOW_SCALE;
  }
  return scale;
}

/**
 * The SSR goal for a play: the Wife3 estimate when judgement counts exist,
 * raw accuracy otherwise. Only the judgement path may exceed the calc's
 * 0.965 cap; without a MAX:300 breakdown there is no evidence to
 * differentiate high-accuracy plays on. `od` is the chart's overall
 * difficulty; unknown (null) assumes OD8.
 *
 * Lazer judges LN head and tail separately, which sags the MAX:300 ratio on
 * LN-heavy charts (stable rolls the hold into one judgement), so for
 * lazer-judged plays the Wife estimate fades toward the plain-accuracy goal
 * by the chart's LN share. `lnRatio` comes from chart analysis; when it is
 * unknown (null) a lazer play falls back to the plain-accuracy goal entirely,
 * since there is no way to tell how much of its ratio sag is LN artifact.
 */
export function ssrGoalForScore(score: SsrGoalScore, lnRatio?: number | null, od?: number | null): number {
  const wife = estimateWifeAccuracy(score.statistics, { od, windowScale: stableWindowScale(score) });
  if (wife == null) return ssrGoalForAccuracy(score.accuracy);
  const wifeGoal = Math.max(SSR_GOAL_MIN, Math.min(SSR_GOAL_CAP, wife));
  if (isLazerScore(score as OscScore)) {
    const accGoal = ssrGoalForAccuracy(score.accuracy);
    const fade = lnRatio == null ? 1 : Math.max(0, Math.min(1, lnRatio));
    return Math.round((wifeGoal * (1 - fade) + accGoal * fade) * 10_000) / 10_000;
  }
  return Math.round(wifeGoal * 10_000) / 10_000;
}

// Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7, plenty for the aggregation)
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/**
 * Etterna's ScoreManager::AggregateSSRs: binary-search the rating whose
 * erfc-weighted sum of SSR overages matches the exponential target, so one
 * outlier score cannot set the rating but a deep stack of similar SSRs pushes
 * it toward them.
 */
export function aggregateSsrs(values: number[]): number {
  const ssrs = values.filter((value) => Number.isFinite(value) && value > 0);
  if (ssrs.length === 0) return 0;
  let rating = 0;
  let res = 10.24;
  for (let iter = 1; iter <= 11; iter += 1) {
    let sum: number;
    do {
      rating += res;
      sum = 0;
      for (const ssr of ssrs) sum += Math.max(0, 2 / (1 - erf(0.1 * (ssr - rating))) - 2);
    } while (Math.pow(2, rating * 0.1) < sum);
    if (iter === 11) break;
    rating -= res;
    res /= 2;
  }
  return Math.round(rating * AGGREGATE_RATING_SCALER * 100) / 100;
}

/**
 * SSRs for a play at `goal`, running the calc once for goals it can serve
 * directly and extending past its 0.965 cap by extrapolating each skillset
 * along the chart's own 0.93 -> 0.965 log-slope. Returns the values plus how
 * many calc runs it took (for event-loop breathing).
 */
async function runMsdAtGoal(
  osuText: string,
  options: { rate: number; keyCount: number; goal: number; lnTailTaps?: boolean },
): Promise<{ values: Record<string, number>; calcRuns: number } | null> {
  const { rate, keyCount, goal, lnTailTaps = false } = options;
  const capped = await computeMsd(osuText, { rate, keyCount, scoreGoal: Math.min(goal, SSR_CALC_GOAL_CAP), lnTailTaps }).catch(() => null);
  if (!capped) return null;
  if (goal <= SSR_CALC_GOAL_CAP) return { values: capped.values, calcRuns: 1 };
  const base = await computeMsd(osuText, { rate, keyCount, scoreGoal: SSR_EXTRAPOLATION_BASE_GOAL, lnTailTaps }).catch(() => null);
  if (!base) return { values: capped.values, calcRuns: 1 };
  const exponent = (goal - SSR_CALC_GOAL_CAP) / (SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL);
  const values: Record<string, number> = {};
  for (const [name, atCap] of Object.entries(capped.values)) {
    const atBase = Number(base.values[name] ?? 0);
    if (!(atCap > 0) || !(atBase > 0) || atCap <= atBase) {
      values[name] = atCap;
      continue;
    }
    const slope = Math.min(atCap / atBase, SSR_EXTRAPOLATION_MAX_SLOPE);
    values[name] = atCap * Math.pow(slope, exponent);
  }
  return { values, calcRuns: 2 };
}

// SSRs on hold-bearing charts blend toward a tail-aware second calc pass;
// weights and rationale live with the calc facade (dan/msd.ts).
async function computePlaySsrValues(
  osuText: string,
  options: { rate: number; keyCount: number; goal: number; lnRatio?: number | null },
): Promise<{ values: Record<string, number>; calcRuns: number } | null> {
  const { rate, keyCount, goal, lnRatio } = options;
  const base = await runMsdAtGoal(osuText, { rate, keyCount, goal });
  if (!base) return null;
  const blend = LN_TAIL_BLEND_BY_KEYMODE[keyCount] ?? 0;
  if (!(blend > 0) || !(Number(lnRatio) > LN_TAIL_MIN_RATIO)) return base;
  const tails = await runMsdAtGoal(osuText, { rate, keyCount, goal, lnTailTaps: true });
  if (!tails) return base;
  return { values: blendLnTailValues(base.values, tails.values, keyCount), calcRuns: base.calcRuns + tails.calcRuns };
}

function aggregateModeRatings(plays: StoredPlaySsr[]): Record<string, number> {
  const ratings: Record<string, number> = {};
  for (const name of SKILL_RATING_SKILLSETS) {
    ratings[name] = aggregateSsrs(plays.map((play) => Number(play.values[name] ?? 0)));
  }
  return ratings;
}

// "Your rating on chordstream charts": the Overall SSRs of the plays whose
// charts carry a pattern tag, aggregated per tag. This is the keymode-honest
// axis set for 6K/7K, where MinaCalc's 4K-born skillset names mislead.
function aggregateModePatternRatings(plays: StoredPlaySsr[]): PlayerSkillPatternRating[] {
  const playsByPattern = new Map<string, StoredPlaySsr[]>();
  for (const play of plays) {
    for (const pattern of play.patterns) {
      const list = playsByPattern.get(pattern);
      if (list) list.push(play);
      else playsByPattern.set(pattern, [play]);
    }
  }
  return [...playsByPattern.entries()]
    .filter(([, list]) => list.length >= PATTERN_RATING_MIN_PLAYS)
    .map(([id, list]) => ({
      id,
      rating: aggregateSsrs(list.map((play) => Number(play.values.Overall ?? 0))),
      plays: list.length,
    }))
    .filter((entry) => entry.rating > 0)
    .sort((a, b) => b.rating - a.rating);
}

// Per-chart analysis facts the skill pipeline consumes: pattern tags for the
// pattern axes, lnRatio for the lazer goal fade, and the dan verdict halves
// (1.0x from the lean classification, DT from the primary-only DT sweep) for
// player-dan positioning. One row set on the same indexed query the tag
// lookup always ran.
export interface ChartSkillInfo {
  patterns: string[];
  lnRatio: number | null;
  vibro: boolean;
  rcRawDan: number | null;
  lnRawDan: number | null;
  dtRawDan: number | null;
  dtFamily: "rc" | "ln" | null;
}

interface LeanHalfJson {
  rawDan?: unknown;
}

interface LeanClassificationJson {
  lnRatio?: unknown;
  vibro?: unknown;
  rc?: LeanHalfJson | null;
  ln?: LeanHalfJson | null;
  patterns?: Array<{ id?: unknown; score?: unknown }>;
}

function readRawDan(half: LeanHalfJson | null | undefined): number | null {
  const rawDan = Number(half?.rawDan);
  return Number.isFinite(rawDan) && rawDan > 0 ? rawDan : null;
}

export async function loadChartSkillInfo(db: Db, beatmapIds: number[]): Promise<Map<number, ChartSkillInfo>> {
  const ids = [...new Set(beatmapIds)].filter((id) => Number.isInteger(id) && id > 0);
  const info = new Map<number, ChartSkillInfo>();
  if (ids.length === 0) return info;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select beatmap_id, classification_json, dan_dt_json from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready' and beatmap_id in (${placeholders})`,
    [CHART_ANALYSIS_VERSION, ...ids],
  )).rows;
  for (const row of rows) {
    const parsed = parseJson<LeanClassificationJson | null>(String(row.classification_json ?? ""), null);
    const patternScores = new Map<string, number>();
    for (const hit of Array.isArray(parsed?.patterns) ? parsed.patterns : []) {
      const id = String(hit?.id ?? "");
      if (id) patternScores.set(id, Math.max(patternScores.get(id) ?? 0, Number(hit?.score ?? 0)));
    }
    const chordjackScore = patternScores.get("chordjack") ?? 0;
    const patternIds = [...patternScores.entries()]
      .filter(([id, score]) =>
        score >= PATTERN_TAG_MIN_SCORE
        && !(id === "tech" && chordjackScore >= TECH_TAG_CHORDJACK_VETO))
      .map(([id]) => id);
    const lnRatio = Number(parsed?.lnRatio);
    const danDt = parseJson<{ rawDan?: unknown; primaryFamily?: unknown } | null>(String(row.dan_dt_json ?? ""), null);
    const dtRawDan = readRawDan(danDt ?? undefined);
    info.set(Number(row.beatmap_id), {
      patterns: patternIds,
      lnRatio: Number.isFinite(lnRatio) ? Math.max(0, Math.min(1, lnRatio)) : null,
      vibro: parsed?.vibro === true,
      rcRawDan: readRawDan(parsed?.rc),
      lnRawDan: readRawDan(parsed?.ln),
      dtRawDan,
      dtFamily: dtRawDan == null ? null : danDt?.primaryFamily === "ln" ? "ln" : "rc",
    });
  }
  return info;
}

/**
 * Overall difficulty per beatmap, from the raw osu! API payload kept in
 * beatmaps.metadata_json ($.accuracy is the OD). Stored score payloads are
 * compacted without their beatmap object (compactScoreForStorage), so this
 * row is the only durable OD source. Charts not yet enriched are simply
 * absent and fall back to the OD8 assumption.
 */
export async function loadBeatmapOds(db: Db, beatmapIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const rows = await selectRowsByIntegerSet(
    db,
    "select beatmap_id, json_extract(metadata_json, '$.accuracy') as od from beatmaps where json_valid(metadata_json) and beatmap_id in",
    beatmapIds,
  );
  for (const row of rows) {
    // json_extract yields NULL for charts without a stored OD; Number(null)
    // would read as a real OD 0.
    const od = row.od == null ? Number.NaN : Number(row.od);
    if (Number.isFinite(od) && od >= 0 && od <= 10) map.set(Number(row.beatmap_id), od);
  }
  return map;
}

function getMissShare(statistics: OsuScoreStatistics | undefined): number | null {
  if (!statistics) return null;
  const counts = [
    readCount(statistics.perfect ?? statistics.count_geki),
    readCount(statistics.great ?? statistics.count_300),
    readCount(statistics.good ?? statistics.count_katu),
    readCount(statistics.ok ?? statistics.count_100),
    readCount(statistics.meh ?? statistics.count_50),
  ];
  const miss = readCount(statistics.miss ?? statistics.count_miss);
  const total = counts.reduce((sum, count) => sum + count, miss);
  return total > 0 ? miss / total : null;
}

// "You are ~8th dan on 4K rice": per keymode and per verdict side (RC vs LN,
// matching the classifier's halves), the highest continuous dan level backed
// by a quorum of qualifying clears. A clear testifies only for the chart's
// PRIMARY family (LN iff lnRatio >= 0.5, the same rule as /maps): accuracy
// on an LN chart is earned on the holds, so it proves nothing about the rice
// half's rating, and vice versa. DT plays likewise count only where the DT
// sweep stored a verdict (its primary side); HT and other rates contribute
// nothing.
function computeModeDan(
  keyCount: number,
  plays: StoredPlaySsr[],
  scoresByIdentity: Map<string, OscScore>,
  infoByBeatmap: Map<number, ChartSkillInfo>,
): PlayerSkillModeDan {
  const clears: Record<"rc" | "ln", number[]> = { rc: [], ln: [] };
  for (const play of plays) {
    const info = infoByBeatmap.get(play.beatmapId);
    if (!info) continue;
    // Clear evidence rides on the stored play (retained plays outlive their
    // score payload); the live score object is the fallback for cache entries
    // written before the fields existed.
    const score = scoresByIdentity.get(play.identity);
    const displayed = play.accuracy ?? (score ? getDisplayedAccuracy(score) : null);
    if (typeof displayed !== "number") continue;
    const missShare = play.missShare !== undefined ? play.missShare : score ? getMissShare(score.statistics) : null;
    if (missShare == null || missShare > DAN_CLEAR_MAX_MISS_SHARE) continue;
    // Rice evidence speaks stable currency (the formula both clients share);
    // LN keeps each client's displayed accuracy - lazer LN judgement counts
    // are not stable-convertible, and the LN curves are anchored on that.
    const stable = play.stableAccuracy ?? (score ? calculateStableAccuracy(score.statistics ?? {}) || null : null);
    const sideAccuracy = (side: "rc" | "ln") => (side === "rc" ? stable ?? displayed : displayed);
    const push = (rawDan: number | null, side: "rc" | "ln") => {
      if (rawDan == null) return;
      const accuracy = sideAccuracy(side);
      if (!(accuracy >= DAN_CLEAR_MIN_ACCURACY)) return;
      const { fullAccuracy, maxDiscount } = danCreditFor(side, keyCount);
      clears[side].push(
        rawDan - maxDiscount * Math.max(0, Math.min(1, (fullAccuracy - accuracy) / (fullAccuracy - DAN_CLEAR_MIN_ACCURACY))),
      );
    };
    if (play.rate === 1 && info.lnRatio != null) {
      const side = info.lnRatio >= 0.5 ? "ln" : "rc";
      push(side === "ln" ? info.lnRawDan : info.rcRawDan, side);
    } else if (play.rate === 1.5 && info.dtFamily != null) {
      push(info.dtRawDan, info.dtFamily);
    }
  }
  return { rc: danFromClears(clears.rc, "rc", keyCount), ln: danFromClears(clears.ln, "ln", keyCount) };
}

function danFromClears(rawDans: number[], side: "rc" | "ln", keyCount: number): PlayerSkillDanSide | null {
  if (rawDans.length < DAN_CLEAR_QUORUM) return null;
  const sorted = [...rawDans].sort((a, b) => b - a);
  // The quorum-th best credited clear IS the dan: outlier clears above it
  // cannot set it, and nothing gets added on top of the evidence.
  const rawDan = Math.round(sorted[DAN_CLEAR_QUORUM - 1] * 100) / 100;
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: sorted.filter((value) => value >= sorted[DAN_CLEAR_QUORUM - 1]).length,
  };
}

// Each ladder speaks its own community's language. 4K rice runs 1-10 then the
// Reform greek levels (parseDan), 4K LN is numeric 1-15 and never goes greek
// (parseLnDan). 6K/7K rawDans arrive on their leoblack table scale, whose
// level names are the real Sunny/Jinjin ladders (7K past 10th = Gamma,
// Azimuth, Zenith, Stellium; 6K LN = Terra..Finish) - the 4K greek ladder
// ("alpha") does not exist there, so those keymodes label from their table.
function danLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  if (keyCount !== 4) {
    const tableLabel = danTableLabelFor(rawDan, side, keyCount);
    if (tableLabel != null) return tableLabel;
  }
  const parsed = side === "ln" && keyCount === 4 ? parseLnDan(rawDan) : parseDan(rawDan);
  return `${parsed.label}${parsed.variant ?? ""}`;
}

function parseOsuKeyCount(osuText: string): number | null {
  const match = osuText.match(/^CircleSize\s*:\s*(\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const keyCount = Math.round(Number(match[1]));
  return Number.isInteger(keyCount) && keyCount > 0 ? keyCount : null;
}

// Bound on MinaCalc work per compute invocation: a grinder's first pass over
// their tracked history can hold hundreds of unrated plays, and the job must
// finish well under the lane watchdog. Overflow lands in pendingPlays, whose
// 30-minute retry chains follow-up computes until the backlog drains.
const MAX_CALC_RUNS_PER_COMPUTE = 150;

interface PlayCandidate {
  score: OscScore;
  beatmapId: number;
  rate: number;
  goal: number;
  identity: string;
  source: "top" | "tracked";
}

/**
 * Analyze one player's plays into per-keymode skillset ratings. Input is the
 * ranked top plays plus (optionally) tracked plays from the retention window,
 * deduped to the best play per (chart, rate). `previousPlays` is the last
 * run's per-play SSR cache: unchanged plays reuse their SSRs, and cached
 * plays whose source play is no longer visible are retained (superseded only
 * by a better play on the same chart and rate), so ratings accumulate beyond
 * what any single snapshot holds.
 */
export async function computePlayerSkillRatings(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  scores: OscScore[],
  previousPlays: StoredPlaySsr[],
  options: { trackedScores?: OscScore[]; untrustedIdentities?: Set<string> } = {},
): Promise<{ summary: StoredModesSummary; plays: StoredPlaySsr[]; untaggedBeatmapIds: number[] }> {
  const topPlays = scores.filter((score) => typeof score.pp === "number" && score.pp > 0);
  const trackedScores = options.trackedScores ?? [];
  const untrustedIdentities = options.untrustedIdentities ?? new Set<string>();
  const previousByIdentity = new Map(previousPlays.map((play) => [play.identity, play]));
  const scoresByIdentity = new Map<string, OscScore>();
  let pendingPlays = 0;
  let unsupportedPlays = 0;

  // Chart analysis facts load before the SSR loop because the lazer LN goal
  // fade needs each chart's lnRatio, and the goal is part of the SSR reuse
  // key: when an analysis row lands later, the goal shifts and the play
  // recomputes on the next pass. Previous plays' charts load too so retained
  // plays keep their tags fresh and newly vibro-flagged tracked charts drop.
  const beatmapIdOf = (score: OscScore) => Number(score.beatmap_id ?? score.beatmap?.id ?? 0);
  const infoByBeatmap = await loadChartSkillInfo(db, [
    ...topPlays.map(beatmapIdOf),
    ...trackedScores.map(beatmapIdOf),
    ...previousPlays.map((play) => play.beatmapId),
  ]);
  // OD comes from the beatmaps row rather than chart analysis so it is known
  // for every enriched chart, analyzed or not; the goal is part of the SSR
  // reuse key, so an OD landing later shifts the goal and the play recomputes.
  const odByBeatmap = await loadBeatmapOds(db, [...topPlays.map(beatmapIdOf), ...trackedScores.map(beatmapIdOf)]);

  // A top play means pp was awarded, so the chart is ranked - and true vibro
  // does not pass mania ranking criteria. A vibro flag on such a chart is the
  // detector misfiring on dense legit jacks, so pp-backed charts are trusted
  // and the vibro exclusion only applies to tracked-history charts.
  const ppBackedChartIds = new Set(
    topPlays.map(beatmapIdOf).filter((id) => Number.isInteger(id) && id > 0),
  );

  // Best candidate per (chart, rate): tracked retries collapse onto the
  // strongest attempt, and a tracked play can outrank a weaker top play on
  // the same slot. Tracked plays that fail validation are best-effort extras
  // and skip silently; only top plays count toward unsupportedPlays.
  const candidates = new Map<string, PlayCandidate>();
  const consider = (score: OscScore, source: "top" | "tracked") => {
    const beatmapId = beatmapIdOf(score);
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      if (source === "top") unsupportedPlays += 1;
      return;
    }
    const info = infoByBeatmap.get(beatmapId);
    if (info?.vibro && !ppBackedChartIds.has(beatmapId)) return;
    const rate = getPlayRate(score.mods);
    if (rate == null) {
      if (source === "top") unsupportedPlays += 1;
      return;
    }
    const goal = ssrGoalForScore(score, info?.lnRatio ?? null, odByBeatmap.get(beatmapId) ?? null);
    const key = `${beatmapId}:${rate}`;
    const existing = candidates.get(key);
    if (!existing || goal > existing.goal || (goal === existing.goal && source === "top" && existing.source === "tracked")) {
      candidates.set(key, { score, beatmapId, rate, goal, identity: getScoreIdentity(score), source });
    }
  };
  for (const score of topPlays) consider(score, "top");
  for (const score of trackedScores) consider(score, "tracked");

  // One score id has exactly one true rate; the retention pass uses this to
  // drop stored plays that contradict a live candidate's rate.
  const candidateRateByIdentity = new Map<string, number>();
  for (const candidate of candidates.values()) candidateRateByIdentity.set(candidate.identity, candidate.rate);

  const analyzedByKey = new Map<string, StoredPlaySsr>();
  let calcRuns = 0;
  let calcRunsTotal = 0;
  for (const [key, candidate] of candidates) {
    const { score, beatmapId, rate, goal, identity, source } = candidate;
    scoresByIdentity.set(identity, score);
    const clearEvidence = {
      source,
      accuracy: getDisplayedAccuracy(score),
      stableAccuracy: calculateStableAccuracy(score.statistics ?? {}) || null,
      customAccuracy: getStoredScoreAccuracy(score),
      missShare: getMissShare(score.statistics),
      endedAt: score.ended_at ?? score.created_at ?? null,
    };
    const previous = previousByIdentity.get(identity);
    if (previous && previous.beatmapId === beatmapId && previous.rate === rate && previous.goal === goal) {
      analyzedByKey.set(key, { ...previous, pp: score.pp ?? previous.pp, ...clearEvidence });
      continue;
    }
    if (calcRunsTotal >= MAX_CALC_RUNS_PER_COMPUTE) {
      pendingPlays += 1;
      continue;
    }

    const osuText = await loadOsuText(db, osu, beatmapId);
    if (osuText == null) {
      pendingPlays += 1;
      continue;
    }
    // Converts serve the std .osu under the mania beatmap id; the calc would
    // misread x positions as columns, so anything that is not Mode 3 is out.
    if (!/^Mode\s*:\s*3\s*$/m.test(osuText)) {
      if (source === "top") unsupportedPlays += 1;
      continue;
    }
    const keyCount = parseOsuKeyCount(osuText);
    if (keyCount == null || !isMsdSupportedKeyCount(keyCount)) {
      if (source === "top") unsupportedPlays += 1;
      continue;
    }
    const ssr = await computePlaySsrValues(osuText, { rate, keyCount, goal, lnRatio: infoByBeatmap.get(beatmapId)?.lnRatio ?? null });
    if (!ssr) {
      if (source === "top") unsupportedPlays += 1;
      continue;
    }
    analyzedByKey.set(key, { identity, beatmapId, keyCount, rate, goal, pp: score.pp ?? 0, values: ssr.values, patterns: [], ...clearEvidence });
    // Each calc run is a short synchronous wasm burst; breathe between bursts
    // so a long first run does not starve the event loop.
    calcRuns += ssr.calcRuns;
    calcRunsTotal += ssr.calcRuns;
    if (calcRuns >= 5) {
      calcRuns = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Retention: cached plays whose source score is gone (aged out of the
  // tracked window, dropped from the top-200) stay rated - the stored SSRs
  // are the durable record. A retained play only yields its slot to a
  // still-visible play with an equal-or-better goal, and drops when its chart
  // is now vibro-flagged - unless the chart earned pp-backed trust, either
  // now or when the play was rated (top-sourced plays keep that trust after
  // dropping off the top-200).
  for (const previous of previousPlays) {
    if (!previous || !(previous.beatmapId > 0) || !(previous.rate > 0) || !previous.values) continue;
    if (
      infoByBeatmap.get(previous.beatmapId)?.vibro &&
      previous.source !== "top" &&
      !ppBackedChartIds.has(previous.beatmapId)
    ) continue;
    // A tracked-sourced play whose only surviving evidence is a mod-less
    // archived row was rated at an assumed rate that cannot be verified
    // (an HT/DC original would be inflated), so it drops instead of
    // retaining. Top-sourced plays keep their trust: their rate came from
    // the real mods at rating time. And when a live candidate carries the
    // same score id at a different rate, the stored play is a stale
    // assumed-rate phantom of that same score - the candidate wins.
    if (previous.source !== "top" && untrustedIdentities.has(previous.identity)) continue;
    const candidateRate = candidateRateByIdentity.get(previous.identity);
    if (candidateRate != null && candidateRate !== previous.rate) continue;
    const key = `${previous.beatmapId}:${previous.rate}`;
    const current = analyzedByKey.get(key);
    if (!current) {
      analyzedByKey.set(key, previous);
    } else if (previous.goal > current.goal && previous.identity !== current.identity) {
      analyzedByKey.set(key, previous);
    }
  }
  const analyzed = [...analyzedByKey.values()];

  // Pattern tags apply fresh every compute (never from the SSR cache):
  // analysis rows keep landing after the plays that referenced them. The info
  // map itself was loaded up-front for the goal fade.
  const untaggedBeatmapIds: number[] = [];
  for (const play of analyzed) {
    const info = infoByBeatmap.get(play.beatmapId);
    if (info) play.patterns = info.patterns;
    else untaggedBeatmapIds.push(play.beatmapId);
  }

  const byKeyCount = new Map<number, StoredPlaySsr[]>();
  for (const play of analyzed) {
    const list = byKeyCount.get(play.keyCount);
    if (list) list.push(play);
    else byKeyCount.set(play.keyCount, [play]);
  }
  const modes: PlayerSkillModeBreakdown[] = [...byKeyCount.entries()]
    .map(([keyCount, list]) => ({
      keyCount,
      analyzedPlays: list.length,
      ratings: aggregateModeRatings(list),
      patterns: aggregateModePatternRatings(list),
      dan: computeModeDan(keyCount, list, scoresByIdentity, infoByBeatmap),
    }))
    .sort((a, b) => b.analyzedPlays - a.analyzedPlays);

  return {
    summary: {
      totalPlays: analyzed.length + pendingPlays + unsupportedPlays,
      analyzedPlays: analyzed.length,
      pendingPlays,
      unsupportedPlays,
      modes,
    },
    plays: analyzed,
    untaggedBeatmapIds: [...new Set(untaggedBeatmapIds)],
  };
}

async function loadOsuText(db: Db, osu: Pick<OsuApiClient, "getBeatmapFile">, beatmapId: number): Promise<string | null> {
  try {
    // Cache-first with a network fallback that honors the API-jobs switch,
    // same policy as chart analysis (dev boxes analyze cached charts only).
    return readConfig().enableOsuApiJobs
      ? await getCachedBeatmapFile(db, osu, beatmapId, `job:${PLAYER_SKILLS_JOB}`)
      : await readCachedBeatmapFile(db, beatmapId);
  } catch {
    return null;
  }
}

type ProfileOsuClient = Pick<OsuApiClient, "getBeatmapFile" | "getUserByKey" | "getUserBestScoresWindow">;

export async function computePlayerSkillsJob(db: Db, osu: ProfileOsuClient, queue: JobQueue, payload: { userId: number }): Promise<void> {
  const userId = Math.floor(Number(payload?.userId));
  if (!Number.isInteger(userId) || userId <= 0) return;

  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, updated_at)
     values (?, ?, 'running', ?)
     on conflict(user_id, analysis_version) do update set
       status = 'running',
       error = null,
       updated_at = excluded.updated_at`,
    [userId, PLAYER_SKILLS_VERSION, nowIso()],
  );

  try {
    const snapshot = await loadTopPlaysSnapshot(db, osu, userId);
    if (!snapshot) throw new Error("No stored top plays and osu API jobs are disabled");

    // Session-end freshness: materialize the maniacard snapshot from the same
    // ingested projection we just loaded, at zero osu! cost. Best-effort - a
    // profile-write hiccup must never fail or delay the skill-rating write.
    await persistSessionProfileSnapshot(db, userId).catch((error) => {
      logWarn("session_profile_snapshot_persist_failed", { userId, ...errorContext(error) });
    });

    const previousRow = (await exec(
      db,
      "select plays_json from player_skill_ratings where user_id = ? and analysis_version = ?",
      [userId, PLAYER_SKILLS_VERSION],
    )).rows[0];
    const previousPlays = parseJson<{ plays?: StoredPlaySsr[] }>(String(previousRow?.plays_json ?? ""), {}).plays ?? [];

    const trackedScores = await loadTrackedScores(db, userId);
    const archived = await loadArchivedTrackedEvidence(db, userId);
    const result = await computePlayerSkillRatings(db, osu, snapshot.bestScores, previousPlays, {
      trackedScores: [...trackedScores, ...archived.scores],
      untrustedIdentities: archived.unknownModsIdentities,
    });
    // Personal accuracy curve model (A7), fitted from the same rated plays in
    // this job (never on a request path) and persisted beside the ratings.
    // Best-effort: a model failure must never fail or delay the ratings write.
    const accModel = await buildPlayerAccModel(db, result.plays, result.summary.modes).catch((error) => {
      logWarn("player_acc_model_fit_failed", { userId, ...errorContext(error) });
      return null;
    });
    const computedAt = nowIso();
    await exec(
      db,
      `update player_skill_ratings
       set status = 'ready', modes_json = ?, plays_json = ?, acc_model_json = ?, source_fetched_at = ?, error = null, computed_at = ?, updated_at = ?
       where user_id = ? and analysis_version = ?`,
      [
        json(result.summary),
        json({ version: PLAYER_SKILLS_VERSION, plays: result.plays }),
        accModel ? json(accModel) : null,
        snapshot.fetchedAt,
        computedAt,
        computedAt,
        userId,
        PLAYER_SKILLS_VERSION,
      ],
    );
    // Superseded-version rows are dead weight once the new one is ready.
    await exec(db, "delete from player_skill_ratings where user_id = ? and analysis_version != ?", [userId, PLAYER_SKILLS_VERSION]);
    // Charts with no analysis row yet contribute no pattern tags; queue them so
    // the next recompute (12h TTL) picks their tags up.
    await enqueueMissingChartAnalyses(db, queue, result.untaggedBeatmapIds).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await exec(
      db,
      `update player_skill_ratings
       set status = 'failed', error = ?, updated_at = ?
       where user_id = ? and analysis_version = ?`,
      [message.slice(0, 500), nowIso(), userId, PLAYER_SKILLS_VERSION],
    );
    throw error;
  }
}

// Newest passed tracked plays still inside score_events retention. Bounded:
// dedup collapses retries, and MAX_CALC_RUNS_PER_COMPUTE bounds the calc work
// regardless of how many rows a grinder produced.
const TRACKED_SCORES_SCAN_LIMIT = 2000;

async function loadTrackedScores(db: Db, userId: number): Promise<OscScore[]> {
  const rows = (await exec(
    db,
    `select score_json from score_events
     where user_id = ? and passed = 1 and ruleset_id = 3
     order by ended_at desc
     limit ?`,
    [userId, TRACKED_SCORES_SCAN_LIMIT],
  )).rows;
  const scores: OscScore[] = [];
  for (const row of rows) {
    const score = parseJson<OscScore | null>(String(row.score_json ?? ""), null);
    if (score) scores.push(score);
  }
  return scores;
}

// Tracked plays whose raw payloads aged out of score_events still left a
// durable day-best trace in player_activity_maps (2y retention). Rows
// written since best_mods_json/best_statistics_json shipped carry the full
// skill evidence (real rate from mods, wife goal and miss share from the
// judgement counts - dan-clear eligible). Older rows with no stored mods
// cannot be rated honestly at any rate - assuming 1.0x would credit an
// HT/DC original's accuracy against the full-speed chart, inflating the
// rating - so they contribute nothing; their derived identities come back
// as untrusted so previously stored plays built from them purge instead of
// retaining. Days still covered by live payloads just produce weaker
// duplicate candidates that lose the per-(chart, rate) dedup to the real
// score.
const ARCHIVED_EVIDENCE_SCAN_LIMIT = 4000;

export interface ArchivedTrackedEvidence {
  scores: OscScore[];
  // Score identities of mod-less archived rows: rateable at no rate, and
  // grounds for dropping a stored play with the same identity.
  unknownModsIdentities: Set<string>;
}

export async function loadArchivedTrackedEvidence(db: Db, userId: number): Promise<ArchivedTrackedEvidence> {
  const rows = (await exec(
    db,
    `select m.day, m.beatmap_id, m.best_score_id, m.best_accuracy, m.best_mods_json, m.best_statistics_json
     from player_activity_maps m
     join beatmaps b on b.beatmap_id = m.beatmap_id and b.mode = 'mania'
     where m.user_id = ?
       and m.best_accuracy > 0
       and exists (
         select 1 from player_activity_score_refs r
         where r.country = m.country and r.user_id = m.user_id
           and r.day = m.day and r.beatmap_id = m.beatmap_id and r.passed = 1
       )
     order by m.day desc
     limit ?`,
    [userId, ARCHIVED_EVIDENCE_SCAN_LIMIT],
  )).rows;
  const scores: OscScore[] = [];
  const unknownModsIdentities = new Set<string>();
  for (const row of rows) {
    const accuracy = Number(row.best_accuracy);
    const beatmapId = Number(row.beatmap_id);
    if (!(accuracy > 0 && accuracy <= 1) || !(beatmapId > 0)) continue;
    const scoreId = Number(row.best_score_id);
    const mods = parseJson<OscScore["mods"] | null>(String(row.best_mods_json ?? ""), null);
    const statistics = parseJson<OscScore["statistics"] | null>(String(row.best_statistics_json ?? ""), null);
    const score = {
      id: Number.isFinite(scoreId) && scoreId > 0 ? scoreId : 0,
      user_id: userId,
      beatmap_id: beatmapId,
      accuracy,
      mods: Array.isArray(mods) ? mods : [],
      passed: true,
      rank: "A",
      score: 0,
      max_combo: 0,
      pp: null,
      statistics: statistics ?? {},
      // Day-anchored timestamp: rows are immutable once the day closes, so
      // the derived score identity stays stable across recomputes.
      ended_at: `${String(row.day)}T00:00:00Z`,
    } as OscScore;
    if (!Array.isArray(mods)) {
      unknownModsIdentities.add(getScoreIdentity(score));
      continue;
    }
    scores.push(score);
  }
  return { scores, unknownModsIdentities };
}

async function loadTopPlaysSnapshot(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  userId: number,
): Promise<{ bestScores: OscScore[]; fetchedAt: string } | null> {
  const key = String(userId);
  let snapshot = await getCachedPlayerProfileSnapshot(db, key);
  if ((!snapshot || snapshot.bestScores.length === 0) && readConfig().enableOsuApiJobs) {
    // Background job work: mint on the job lane so it drips under the osu!
    // ceiling instead of competing with real user requests on the interactive lane.
    await fetchAndStoreProfileSnapshotShared(db, osu, key, "userId", "job:refresh_profile_snapshot");
    snapshot = await getCachedPlayerProfileSnapshot(db, key);
  }
  if (!snapshot) return null;
  return { bestScores: snapshot.bestScores, fetchedAt: snapshot.fetchedAt };
}

// The worker lane that drains skill computes also drains dan estimates (see
// DEFAULT_WORKER_LANES in workers.ts); both types share one waiting line, so a
// player's queue position counts jobs of both kinds ahead of theirs, matching
// the lane's claim order (priority desc, run_after asc).
const SKILL_LANE_JOB_TYPES = ["compute_dan_estimate", PLAYER_SKILLS_JOB];

async function getSkillQueueStatus(db: Db, userId: number): Promise<PlayerSkillQueueStatus | null> {
  const job = (await exec(
    db,
    "select id, status, priority, run_after from jobs where dedupe_key = ?",
    [`player-skills:${PLAYER_SKILLS_VERSION}:${userId}`],
  )).rows[0];
  if (!job) return null;
  const jobStatus = String(job.status);
  // Due jobs only: session-debounced recomputes with a future run_after are
  // not claimable yet and would inflate the queue position shown to viewers.
  const nowIsoStamp = new Date().toISOString();
  const waitingSql = "status in ('queued', 'failed') and type in (?, ?) and run_after <= ?";
  const waiting = Number((await exec(
    db,
    `select count(*) as cnt from jobs where ${waitingSql}`,
    [...SKILL_LANE_JOB_TYPES, nowIsoStamp],
  )).rows[0]?.cnt ?? 0);
  if (jobStatus === "running") return { state: "running", position: null, waiting };
  if (jobStatus !== "queued" && jobStatus !== "failed") return null;
  const ahead = Number((await exec(
    db,
    `select count(*) as cnt from jobs
     where ${waitingSql}
       and (priority > ? or (priority = ? and (run_after < ? or (run_after = ? and id < ?))))`,
    [...SKILL_LANE_JOB_TYPES, nowIsoStamp, Number(job.priority), Number(job.priority), String(job.run_after), String(job.run_after), Number(job.id)],
  )).rows[0]?.cnt ?? 0);
  return { state: "queued", position: ahead + 1, waiting };
}

export async function enqueuePlayerSkills(
  queue: JobQueue,
  userId: number,
  options: { priority?: number } = {},
): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILLS_JOB,
    `player-skills:${PLAYER_SKILLS_VERSION}:${userId}`,
    { userId },
    // Dedupe takes max(priority), so a background-drip enqueue gets bumped to
    // the front the moment someone actually views the player.
    { priority: options.priority ?? 50, replaceDone: true },
  );
}

// A session's last play, not its every play, is what should trigger the
// background recompute: each ingested pass pushes the job out again, so it
// becomes claimable only once the player has gone quiet. Tracked plays feed
// the rating alongside the top-200, so sessions without a single new top play
// still refresh. A view-triggered enqueue (plain min-merge, run-now) yanks
// the same job forward immediately, so an audience never waits on the timer.
const SKILLS_SESSION_DEBOUNCE_MS = 30 * 60_000;
const SKILLS_SESSION_PRIORITY = 15;

export async function enqueuePlayerSkillsAfterSession(queue: JobQueue, userId: number): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILLS_JOB,
    `player-skills:${PLAYER_SKILLS_VERSION}:${userId}`,
    { userId },
    {
      priority: SKILLS_SESSION_PRIORITY,
      replaceDone: true,
      runAfter: new Date(Date.now() + SKILLS_SESSION_DEBOUNCE_MS),
      debounce: true,
    },
  );
}

/**
 * Read a player's stored skill breakdown, enqueueing a (re)compute when the
 * row is missing, stale, or superseded by newer top-play events. Ready rows
 * keep serving their data while a refresh runs.
 */
/**
 * How the recompute enqueue relates to the caller's response.
 *
 * `await` (the default, and what every skills-surface caller wants) blocks on
 * the queue write, so a page that renders queue position reports the truth.
 * `detached` fires it without waiting: Farm Helper only needs the STORED
 * breakdown for the response it is building, so a contended queue write must
 * not sit in front of a page load - a dropped enqueue simply gets retried by
 * the next request, which re-evaluates the same staleness conditions.
 * `none` never enqueues (the read-only backtest and Discord paths).
 */
export type SkillEnqueueMode = "await" | "detached" | "none";

export async function getPlayerSkillBreakdown(
  db: Db,
  queue: JobQueue,
  userId: number,
  options: { allowEnqueue?: boolean; enqueueMode?: SkillEnqueueMode } = {},
): Promise<PlayerSkillBreakdown> {
  const row = (await exec(
    db,
    `select status, modes_json, computed_at, updated_at from player_skill_ratings
     where user_id = ? and analysis_version = ?`,
    [userId, PLAYER_SKILLS_VERSION],
  )).rows[0];

  const now = Date.now();
  const status = row ? String(row.status) : null;
  const updatedAtMs = Date.parse(String(row?.updated_at ?? ""));
  const computedAtMs = Date.parse(String(row?.computed_at ?? ""));
  const summary = parseJson<Partial<StoredModesSummary> | null>(String(row?.modes_json ?? ""), null);

  let shouldEnqueue = false;
  if (!row) {
    shouldEnqueue = true;
  } else if (status === "running") {
    shouldEnqueue = !Number.isFinite(updatedAtMs) || now - updatedAtMs > RUNNING_REQUEUE_MS;
  } else if (status === "failed") {
    shouldEnqueue = !Number.isFinite(updatedAtMs) || now - updatedAtMs > FAILED_RETRY_MS;
  } else if (status === "ready") {
    if (!Number.isFinite(computedAtMs) || now - computedAtMs > READY_RECOMPUTE_TTL_MS) {
      shouldEnqueue = true;
    } else if ((summary?.pendingPlays ?? 0) > 0 && now - computedAtMs > PENDING_RETRY_TTL_MS) {
      shouldEnqueue = true;
    } else if (typeof row.computed_at === "string") {
      const newTopPlays = Number((await exec(
        db,
        "select count(*) as cnt from top_play_events where user_id = ? and detected_at > ?",
        [userId, row.computed_at],
      )).rows[0]?.cnt ?? 0);
      shouldEnqueue = newTopPlays > 0;
    }
  }
  const enqueueMode: SkillEnqueueMode = options.allowEnqueue === false ? "none" : options.enqueueMode ?? "await";
  if (shouldEnqueue && enqueueMode !== "none") {
    if (enqueueMode === "await") {
      await enqueuePlayerSkills(queue, userId);
    } else {
      // Detached: the failure is logged and the breakdown is returned anyway.
      // `stale: true` below still tells the caller a recompute is wanted, so a
      // lost enqueue costs this viewer nothing beyond one more stale read.
      void enqueuePlayerSkills(queue, userId).catch((error) => {
        logWarn("player_skills_enqueue_failed", { user_id: userId, ...errorContext(error) });
      });
    }
  }

  if (status === "ready" && summary) {
    return {
      status: "ready",
      version: PLAYER_SKILLS_VERSION,
      computedAt: typeof row?.computed_at === "string" ? row.computed_at : null,
      totalPlays: Math.max(0, Number(summary.totalPlays ?? 0)),
      analyzedPlays: Math.max(0, Number(summary.analyzedPlays ?? 0)),
      pendingPlays: Math.max(0, Number(summary.pendingPlays ?? 0)),
      unsupportedPlays: Math.max(0, Number(summary.unsupportedPlays ?? 0)),
      modes: Array.isArray(summary.modes) ? summary.modes.filter(isValidMode).map(normalizeMode) : [],
      ...(shouldEnqueue ? { stale: true } : {}),
    };
  }
  return {
    status: status === "failed" ? "failed" : "pending",
    version: PLAYER_SKILLS_VERSION,
    computedAt: null,
    totalPlays: 0,
    analyzedPlays: 0,
    pendingPlays: 0,
    unsupportedPlays: 0,
    modes: [],
    // Looked up after the enqueue above so a first read already sees its job.
    queue: await getSkillQueueStatus(db, userId),
  };
}

/**
 * The rated plays behind one visible skill axis, ordered by that axis's SSR.
 *
 * This deliberately reads the durable per-play skill cache rather than the
 * current profile best window. Ratings also learn from tracked history, and a
 * play should not disappear from this explanation merely because it fell out
 * of the player's current best 200 or its raw score payload aged out.
 */
export async function getPlayerSkillPlays(
  db: Db,
  userId: number,
  keyCount: number,
  axis: string,
  options: { limit?: number; offset?: number } = {},
): Promise<PlayerSkillPlaysPage> {
  const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 50)));
  const offset = Math.max(0, Math.min(5_000, Math.floor(Number(options.offset) || 0)));
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(keyCount) || keyCount <= 0 || !isPlayerSkillAxis(axis)) {
    return { items: [], total: 0, limit, offset };
  }

  const row = (await exec(
    db,
    `select status, plays_json from player_skill_ratings
     where user_id = ? and analysis_version = ?`,
    [userId, PLAYER_SKILLS_VERSION],
  )).rows[0];
  if (String(row?.status ?? "") !== "ready") return { items: [], total: 0, limit, offset };

  const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row?.plays_json ?? ""), null);
  const patternId = axis.startsWith("pattern:") ? axis.slice("pattern:".length) : null;
  const matches = (Array.isArray(stored?.plays) ? stored.plays : [])
    .flatMap((play) => {
      if (!play || play.keyCount !== keyCount || !Number.isInteger(play.beatmapId) || play.beatmapId <= 0) return [];
      if (patternId && !Array.isArray(play.patterns)) return [];
      if (patternId && !play.patterns.includes(patternId)) return [];
      const rating = Number(play.values?.[patternId ? "Overall" : axis] ?? 0);
      if (!Number.isFinite(rating) || rating <= 0) return [];
      return [{ play, rating }];
    })
    .sort((left, right) =>
      right.rating - left.rating
      || Number(right.play.pp ?? 0) - Number(left.play.pp ?? 0)
      || String(right.play.endedAt ?? "").localeCompare(String(left.play.endedAt ?? ""))
      || left.play.beatmapId - right.play.beatmapId);

  const page = matches.slice(offset, offset + limit);
  const metadata = await readPlayerSkillPlayMetadata(db, page.map(({ play }) => play.beatmapId));
  const items = page.map(({ play, rating }): PlayerSkillPlay => {
    const map = metadata.get(play.beatmapId);
    const officialId = /^official:(\d+)$/.exec(play.identity ?? "");
    const scoreId = officialId ? Number(officialId[1]) : null;
    const accuracy = Number(play.accuracy);
    const pp = Number(play.pp);
    return {
      beatmapId: play.beatmapId,
      beatmapsetId: map?.beatmapsetId ?? null,
      title: map?.title ?? "Unknown map",
      artist: map?.artist ?? "Unknown artist",
      creator: map?.creator ?? null,
      version: map?.version ?? `${keyCount}K`,
      coverUrl: map?.coverUrl ?? null,
      keyCount,
      rating: Math.round(rating * 100) / 100,
      overallRating: Math.round(Number(play.values?.Overall ?? 0) * 100) / 100,
      pp: Number.isFinite(pp) && pp > 0 ? pp : null,
      accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null,
      rate: Number.isFinite(play.rate) && play.rate > 0 ? play.rate : 1,
      playedAt: typeof play.endedAt === "string" && Number.isFinite(Date.parse(play.endedAt)) ? play.endedAt : null,
      source: play.source === "top" ? "top" : "tracked",
      scoreId: scoreId != null && Number.isSafeInteger(scoreId) && scoreId > 0 ? scoreId : null,
    };
  });
  return { items, total: matches.length, limit, offset };
}

interface PlayerSkillPlayMetadata {
  beatmapsetId: number | null;
  title: string;
  artist: string;
  creator: string | null;
  version: string;
  coverUrl: string | null;
}

async function readPlayerSkillPlayMetadata(db: Db, beatmapIds: number[]): Promise<Map<number, PlayerSkillPlayMetadata>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select b.beatmap_id, b.beatmapset_id, b.version, s.title, s.artist, s.creator, s.covers_json
     from beatmaps b left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
     where b.beatmap_id in`,
    beatmapIds,
  );
  const metadata = new Map<number, PlayerSkillPlayMetadata>();
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    const rawBeatmapsetId = Number(row.beatmapset_id);
    const beatmapsetId = Number.isSafeInteger(rawBeatmapsetId) && rawBeatmapsetId > 0 ? rawBeatmapsetId : null;
    const covers = parseJson<Record<string, unknown> | null>(String(row.covers_json ?? ""), null);
    const coverUrl = covers
      ? [covers["list@2x"], covers.list, covers["cover@2x"], covers.cover, covers["card@2x"], covers.card]
          .find((value): value is string => typeof value === "string" && value.length > 0) ?? null
      : null;
    metadata.set(beatmapId, {
      beatmapsetId,
      title: typeof row.title === "string" && row.title ? row.title : "Unknown map",
      artist: typeof row.artist === "string" && row.artist ? row.artist : "Unknown artist",
      creator: typeof row.creator === "string" && row.creator ? row.creator : null,
      version: typeof row.version === "string" && row.version ? row.version : "Unknown difficulty",
      coverUrl: coverUrl ?? (beatmapsetId ? `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list.jpg` : null),
    });
  }
  return metadata;
}

function isValidMode(mode: unknown): mode is PlayerSkillModeBreakdown {
  if (mode == null || typeof mode !== "object") return false;
  const candidate = mode as PlayerSkillModeBreakdown;
  return Number.isInteger(candidate.keyCount)
    && Number.isFinite(candidate.analyzedPlays)
    && candidate.ratings != null
    && typeof candidate.ratings === "object";
}

function normalizeMode(mode: PlayerSkillModeBreakdown): PlayerSkillModeBreakdown {
  return {
    ...mode,
    patterns: Array.isArray(mode.patterns) ? mode.patterns : [],
    // Labels re-derive from rawDan on every read, so labeling fixes reach
    // stored rows without a version bump (the rawDan itself is the datum).
    dan: mode.dan
      ? { rc: relabelDanSide(mode.dan.rc, "rc", mode.keyCount), ln: relabelDanSide(mode.dan.ln, "ln", mode.keyCount) }
      : undefined,
  };
}

function relabelDanSide(side: PlayerSkillDanSide | null | undefined, family: "rc" | "ln", keyCount: number): PlayerSkillDanSide | null {
  if (!side || !Number.isFinite(side.rawDan)) return null;
  return { ...side, label: danLabelFor(side.rawDan, family, keyCount) };
}
