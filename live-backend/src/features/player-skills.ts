import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { LN_PRIMARY_MIN_RATIO } from "../dan/dan-estimator/ln.js";
import { LN_TAIL_BLEND_BY_KEYMODE, LN_TAIL_MIN_RATIO, blendLnTailValues, computeMsd, isMsdSupportedKeyCount } from "../dan/msd.js";
import type { JobQueue } from "../jobs/queue.js";
import { readConfig } from "../config.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import { CHART_ANALYSIS_VERSION, HT_RATE_ANALYSIS_META_KEY, JACK_TAG_META_KEY, SUNNY_REPIN_DT_META_KEY, VIBRO_RECOMPUTE_META_KEY, enqueueMissingChartAnalyses } from "./chart-analysis.js";
import { MAX_RATE_PERCENT, MIN_RATE_PERCENT, computeAndStoreRateDanVerdictFromText, enqueueRateDanEstimate, loadStoredRateDanVerdicts, rateDanVerdictKey } from "./dan-estimates.js";
import { getCachedBeatmapFile, readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import type { OsuApiClient } from "../osu/client.js";
import { fetchAndStoreProfileSnapshotShared, getCachedPlayerProfileSnapshot, persistSessionProfileSnapshot } from "./player-profiles.js";
import { calculateScoreV2Accuracy, calculateStableAccuracy, getDisplayedAccuracy, getModAcronyms, getScoreIdentity, getStoredScoreAccuracy, isLazerScore, nowIso } from "../shared/score.js";
import { selectRowsByIntegerSet } from "../shared/score-storage.js";
import { buildPlayerAccModel } from "./player-acc-model.js";
import { danTableCeilingFor, danTableLabelFor, danTableVerdictLabelFor } from "../dan/chart-classifier.js";
import { creditedDanFor, danCreditBelowBarWindowFor } from "../dan/dan-credit.js";
import { loadDanCourseClears } from "./dan-courses.js";
import type { DanCourseClear, DanCourseCreditOptions } from "./dan-courses.js";
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
export const PLAYER_SKILLS_VERSION = 17;
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
// Chordjack needs a higher bar than the rest. The detector reads dense 7K
// chordstream as chordjack often enough to matter: measured against 131 charts
// from 23 mapper-named 7K jack packs and 100 from 15 named stream/chordstream
// packs, the 0.5 bar tagged 95% of the real jack but also 13 of the 100 stream
// charts. At 0.8 that becomes 87% of real jack (an understatement - the tail it
// drops is the packs' warmup diffs) against only 3 stream charts. Real jack
// scores sit at a median of 1.000 with p25 0.963, so the honest jack charts are
// nowhere near this line; the false positives are.
const CHORDJACK_TAG_MIN_SCORE = 0.8;
// Delay needs a lower bar than the rest, for the opposite reason to chordjack:
// it under-fires on the charts it is meant to name. Delay is the only signal
// behind the 6K/7K speed tile (Jinjin's 3rd dan skill, "fast streams / burst
// like patterns"), and at 0.5 it tagged 78% of a 50-chart corpus from named
// speed and delay packs while the corpus itself sits at p10 0.33 - so the bar
// was cutting into real speed charts rather than trimming a tail. 7K Regular
// Dan Speed Practice is the measured case: its 5th, Speed of Link, scores
// 0.334 and missed the tile entirely while the maps page (which tags any
// non-zero detection) showed it as delay.
//
// At 0.25 the same corpus reaches 96%, and what it costs is small: the stream
// corpus (107) moves 50% -> 54% and jack (145) stays at 1%. Nothing in any
// corpus scores delay between 0 and 0.25, so this is the conservative way of
// writing "a real detection" rather than a fitted line; lowering it further
// buys nothing measurable.
const DELAY_TAG_MIN_SCORE = 0.25;

/** Whether chart analysis places a chart in a bucket's tag/cluster arm. */
function chartBelongsToTagBucket(bucket: DanSkillsetBucket, chart: ChartSkillInfo | undefined): boolean {
  // Tech is a label rather than a share: LeoBlack names the whole chart (see
  // techCategory), where jack and stream weigh one family against the rest.
  if (bucket.clusterFamily === "tech") {
    if (chart?.techCategory != null) return chart.techCategory;
  } else if (bucket.clusterFamily != null) {
    const share = bucket.clusterFamily === "jack" ? chart?.jackShare : chart?.streamShare;
    if (share != null) return share >= CLUSTER_SHARE_MIN;
  }
  return (chart?.patterns ?? []).some((tag) => bucket.tags.includes(tag));
}

/**
 * Test seam: which 6K/7K tiles a chart lands in, given its stored analysis.
 * Same walk getPlayerSkillDanEvidence does for the tag/cluster buckets.
 */
export function danTagBucketsForTest(keyCount: number, chart: ChartSkillInfo): string[] {
  return danSkillsetBuckets(keyCount, "rc")
    .filter((bucket) => chartBelongsToTagBucket(bucket, chart))
    .map((bucket) => bucket.id);
}

/** Test seam over patternTagMinScore, which is otherwise module-private. */
export function patternTagMinScoreForTest(patternId: string): number {
  return patternTagMinScore(patternId);
}

/** Test seams over chartIsJack / jackVetoesTech, which are module-private. */
export function chartIsJackForTest(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  return chartIsJack(keyCount, chordjackScore, jackScore, jackShare);
}
export function jackVetoesTechForTest(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  return jackVetoesTech(keyCount, chordjackScore, jackScore, jackShare);
}

/** The score a pattern must reach to tag a chart, per tag. */
function patternTagMinScore(patternId: string): number {
  if (patternId === "chordjack") return CHORDJACK_TAG_MIN_SCORE;
  if (patternId === "delay") return DELAY_TAG_MIN_SCORE;
  return PATTERN_TAG_MIN_SCORE;
}
// The jack tile takes chord jack and single-note jack alike. On 6K/7K a
// chart is jack when either LeoBlack's jack clusters carry
// CLUSTER_SHARE_MIN of the chart's difficulty (the same line the dan jack
// bucket draws), or the analyzer's single-note jack score clears the ordinary
// tag bar (minijacks and trills, the shape the clusters can understate:
// Ningen Shikkaku [Zenx's 7K Miscreation] is 40% two-row trills at chordjack
// 0.35 and jack share 0.26). The in-house chordjack score is the fallback only
// when no clusters exist: it counts repeated chords without knowing whether
// those jacks are the hard part of a mixed chart. Star of the COME ON!!
// [STARRY REVOLUTION!!] is the measured counterexample: chordjack 0.93, but
// its clusters are 22.4% jack against 77.6% stream and its single-note jack
// score is only 0.38. Calling that whole chart Jack made the player's Jack
// skill list read a hard stream/tech clear as a jack specialist clear.
//
// None of the two primary arms covers the tile alone: KKKC [7K Extreme]
// scores chordjack 0.77 and sat on the Tech tile until the cluster share
// (0.405) caught it. Measured 2026-08
// against mapper-named 7K pack corpora (279 jack / 78 tech / 136 stream /
// 150 delay charts): the union keeps ~90% of the jack corpus and admits
// 6-9% of tech and stream (mostly charts LeoBlack itself labels
// Chordjacks/Minijacks) and 3% of delay.
//
// 4K keeps the old rule (chordjack certainty alone): its analyzer already
// names the jack family natively, its tiles read MSD skillsets rather than
// these tags, and what its tags do feed (skill-baseline cohort vectors) was
// not re-measured, so the pipeline stays bit-identical there.
function chartIsJack(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  if (keyCount !== 6 && keyCount !== 7) return chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
  if (jackScore >= PATTERN_TAG_MIN_SCORE) return true;
  return jackShare != null
    ? jackShare >= CLUSTER_SHARE_MIN
    : chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
}

// A jack chart never counts as a tech chart, even when its tech score clears
// the bar: dense jack saturates the tech detector's ingredients (chord-size
// churn, direction changes, row variety), so pure CJ charts carried a
// 0.5-0.76 tech score and, ranked by Overall SSR, topped every "top Tech
// plays" list. Checked 2026-08 against mapper-tagged sets: unambiguous CJ
// diffs (chordjack >= 0.8) carried a false tech tag 75-88% of the time.
//
// The single-note score vetoes only at its own near-certainty bar, not the
// 0.5 tag line: at 0.5 it would strip tech from genuinely dual charts like
// EGOISM 440 [EGOMANIA] (jack 0.67, in a mapper-named tech dan pack). When
// clusters exist they also overrule a high chordjack score: a stream-led
// hybrid can contain a confident chordjack section without making the tech
// detector's reading false. Chordjack certainty stays the fallback for the
// ~1% of charts with no cluster evidence.
const JACK_TECH_VETO_MIN_SCORE = 0.8;
function jackVetoesTech(keyCount: number | null, chordjackScore: number, jackScore: number, jackShare: number | null): boolean {
  if (keyCount !== 6 && keyCount !== 7) return chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
  if (jackScore >= JACK_TECH_VETO_MIN_SCORE) return true;
  return jackShare != null
    ? jackShare >= CLUSTER_SHARE_MIN
    : chordjackScore >= CHORDJACK_TAG_MIN_SCORE;
}
// The ln tag's score is driven by holdRatio pressure, so a rice or jack chart
// with a token hold section clears PATTERN_TAG_MIN_SCORE while the analyzer
// itself would never call the chart LN: of the 4K charts tagged ln at 0.5 in
// the 2026-08 snapshot, 76% sit below the analyzer's own LN verdict. That
// verdict is classification lnRatio, the hold-note share of the chart, so
// every LN axis demands it: a gamma stamina chart with a ln score of 0.56 must
// neither headline an LN list nor feed an LN rating. Applied once, where the
// tags are read, so the LN rating and the plays behind it are computed over
// the same set of charts.
//
// The same line the chart-classifier routes the dan side on, deliberately: a
// chart LN enough to feed an LN rating is LN enough to wear an LN dan badge.
// farewell: to my memories [4K] is 47.6% holds at a maxed-out ln score, and no
// player would call it rice; 0.45 keeps charts like it while staying well clear
// of the token-hold rice the tag over-admits, which sits under 0.3. The ln
// pattern score cannot do this job instead: it averages 0.78-0.88 in every
// lnRatio band.
const LN_PATTERN_LN_RATIO_MIN = LN_PRIMARY_MIN_RATIO;
// The LN axes the gate covers: the whole-LN tag plus the analyzer's four LN
// subtypes (patterns.ts LN_SUBTYPE_IDS).
const LN_PATTERN_IDS = new Set(["ln", "lngeneral", "lnrelease", "lninverse", "lntech"]);
// The calc's goal floor. A play whose goal input (wife estimate / accuracy)
// sits at or below it cannot be rated honestly: clamping the goal up to 0.8
// rates the play as if it were an 80% play, which on a hard enough chart
// awards near-full MSD for a scraped pass (a 61% DT pass once headlined a
// profile at SSR 35). Such plays are excluded outright (ssrGoalForScore
// returns null) and stored floor-rated plays from before the rule drop in
// the retention pass.
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
// community-convention part). A clear is a pass at or above the accuracy the
// real dan course for that keymode and side asks for, at 1.0x or DT, and
// nothing else: dan courses clear on accuracy, so misses are not gated
// separately. Mania accuracy already prices a miss at zero, so the miss count
// is not independent evidence - measured over the rated pool, a 1.5% miss cap
// rejected only 1.3% of 96%+ passes and every one of them sat at 96-98%
// accuracy with 1.5-3% misses, i.e. ordinary passes rather than anything the
// accuracy bar had missed. Gating on it also discarded every play whose
// judgement counts were unknown.
//
// A bare pass at the bar credits the chart's full rawDan, exactly as clearing
// a course awards the whole dan in game: the bar IS the pass, and it is the
// zero point of the accuracy credit curve (dan-credit.ts). Away from the bar
// the credit moves with the accuracy in both directions: a pass up to the
// ladder's decay window under the bar (danCreditBelowBarWindowFor: four
// points on rice, one on LN) still credits the chart minus a
// decay (capped so it can never equal the chart's own dan, and reaching a
// full level down at the window's edge), and accuracy above the bar credits a
// bonus that reaches +1.5 levels at 100% in the ladder's own currency. This
// is not the danCreditFor fade an earlier revision had and 75373b2b removed:
// that one discounted the at-bar clear itself, which taxed thin evidence
// twice on top of the quorum and sat below what the community tables
// actually require. Here the at-bar clear is untouched; the curve only
// credits passes the old gate threw away and rewards accuracy the old rule
// ignored. What keeps one lucky chart from setting a level is still
// DAN_CLEAR_QUORUM, which stands in for the course length - four rated
// charts at a level, the same count a course asks you to survive back to
// back - and every credited clear counts toward it, sub-bar ones included,
// since the decay already prices the miss.
//
// The quorum rates a SKILLSET now, not the headline: the side's estimate is
// the mean of its skillset dans (averageSkillsetDans), each of which is the
// mean of its own bucket's best DAN_CLEAR_AVERAGE_WINDOW clears
// (danFromClears). It still gates the side as a whole - four qualifying
// clears or no estimate - and the same best-clears average over the whole
// side is the headline when there are too few rated skillsets to average.
//
// The bars come from the courses themselves rather than a single site-wide
// number, because each ladder sets its own:
//   4K RC (Reform)        96% stable
//   4K LN (_Underjoy)     97% ScoreV2, all 17 courses
//   6K/7K RC (Jinjin)     96% for the dan levels, 95% for the Normal Kyu band
//   6K/7K LN (Jinjin)     95% ("Insane LN - 95.00% (S) or above")
// Each is checked in the currency its table is written in and recomputed from
// the judgement counts, so the same performance qualifies identically on
// stable and lazer instead of needing an assumed per-client offset.
const DAN_CLEAR_QUORUM = 4;

// The leoblack 6K/7K tables open at level 0, which is the pre-1st-dan band
// those ladders publish as Normal Kyu, and Jinjin sets a lower bar there.
const DAN_KYU_BAND_MAX_RAW_DAN = 1;

interface DanClearBar {
  accuracy: number;
  // Which accuracy formula the bar is written in: "stable" is the 300-weighted
  // display accuracy, "v2" the 305-weighted ScoreV2/lazer one.
  currency: "stable" | "v2";
}

// What a ScoreV2 bar becomes when read on the stable formula instead. The 305
// denominator makes the same hands read about half a point higher on stable,
// so a stable play whose judgement counts are gone (acc-only archived rows,
// and every play stored before scoreV2Accuracy shipped) is held to 97.5%
// rather than being waved through at the 97% the ScoreV2 table asks for.
// Lazer plays need no conversion: their displayed accuracy IS this formula.
const STABLE_EQUIVALENT_V2_BAR_OFFSET = 0.005;

/**
 * The pass bar for one side of one keymode's ladder, as its course rules state
 * it. chartDan picks the Normal Kyu band's lower bar on the 6K/7K rice ladder;
 * omit it for the ladder-level answer the evidence surface describes.
 */
export function danClearBarFor(side: "rc" | "ln", keyCount: number, chartDan?: number): DanClearBar {
  if (keyCount === 4) {
    return side === "ln" ? { accuracy: 0.97, currency: "v2" } : { accuracy: 0.96, currency: "stable" };
  }
  if (side === "ln") return { accuracy: 0.95, currency: "stable" };
  const kyu = chartDan != null && chartDan < DAN_KYU_BAND_MAX_RAW_DAN;
  return { accuracy: kyu ? 0.95 : 0.96, currency: "stable" };
}

// The course registry judges a pass on the same bars an ordinary rated clear
// is judged on, so a course and a chart cannot disagree about what 96% means.
// Handed over rather than imported the other way round: the bars live here,
// with the rest of the clear rules, and dan-courses.ts stays a registry.
const DAN_COURSE_CREDIT_OPTIONS: DanCourseCreditOptions = {
  barFor: danClearBarFor,
  stableEquivalentV2BarOffset: STABLE_EQUIVALENT_V2_BAR_OFFSET,
};

/** Every registered dan course this player has a verified pass on. */
export function loadPlayerDanCourseClears(db: Db, userId: number): Promise<DanCourseClear[]> {
  return loadDanCourseClears(db, userId, DAN_COURSE_CREDIT_OPTIONS);
}

export interface PlayerSkillPatternRating {
  id: string;
  rating: number;
  plays: number;
}

// The community-legible axis: "4K RC ~ 8th dan". rawDan is continuous on the
// chart-dan scale (labels via parseDan); clears counts the qualifying plays
// at or above it - a real count everywhere now that every estimate is an
// average rather than the quorum-th clear itself.
export interface PlayerSkillDanVerdict {
  rawDan: number;
  label: string;
  clears: number;
  /**
   * The estimate sits at or above the top of this keymode's dan table, so the
   * label is the ladder's last level and the real level is at least that (6K
   * regular stops at 9th, so a stronger player pins there). Absent means the
   * label measures the estimate.
   */
  beyondTable?: boolean;
}

export interface PlayerSkillDanSide extends PlayerSkillDanVerdict {
  /**
   * The same best-clears average run over one skillset bucket's clears ("your
   * jack dan"), keyed by danSkillsetBuckets id. These are the terms the side's own
   * rawDan is the mean of, so they are the estimate rather than a breakdown of
   * it. Stored rather than derived on read because the dan leaderboards rank a
   * whole roster by it and re-deriving would mean reading every player's
   * plays_json; the evidence window computes the same numbers on demand from
   * the same clears, so the two agree by construction.
   *
   * A bucket under the quorum has no verdict and is simply absent, and so is
   * the whole map on rows written before this shipped (the dan sweep backfills
   * them).
   */
  skillsets?: Record<string, PlayerSkillDanVerdict>;
  /**
   * Set when a verified clear of a real dan course set this headline: the
   * player passed the exam the ladder is made of, so the estimate is floored
   * at what they passed rather than at the average of their skillsets. Names
   * the course so the evidence surface can say why the number moved. Absent
   * means the averaged estimate already stood at or above every course the
   * player has cleared, which is the ordinary case.
   */
  courseClear?: {
    beatmapId: number;
    courseName: string;
    level: string;
    accuracy: number;
    /**
     * Which accuracy formula that number is in. A lazer play displays on the
     * ScoreV2 formula, so the number the site judged is not the one the player
     * saw; `displayedAccuracy` carries theirs when the two differ, and a
     * surface that quotes one without the other invites "that is not my acc".
     */
    currency: "stable" | "v2";
    /** The threshold it was judged against, so a near-clear can say so. */
    bar: number;
    displayedAccuracy?: number | null;
  };
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

// No chordjack axis: the jack tile absorbed it (chartIsJack), so publishing
// both would rank the same charts twice under two names. The chordjack tag
// itself is still emitted for the consumers that mean chord jack specifically.
export const PLAYER_SKILL_PATTERN_AXES = [
  "chordstream",
  "bracket",
  "delay",
  "stream",
  "jack",
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
  // "DT" | "NC" | "HT" | "DC" when the play's own mods are still known; null on
  // plays cached before the field existed (and on unmodded plays), where the
  // rate alone has to stand in.
  rateMod: string | null;
  // The play's highest non-Overall MSD skillset. A skillset list ranks by one
  // component of every play, so a dense LN file can lead "top Chordjack plays"
  // purely by riding a big overall (MinaCalc reads stacked hold heads as
  // chords); this names what actually drove the play so the modal can say so.
  topSkillset: string | null;
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

export interface StoredPlaySsr {
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
  // 305-weighted ScoreV2 accuracy from the judgement counts: the currency the
  // 4K LN ladder writes its pass bar in. Null when the counts are gone.
  scoreV2Accuracy?: number | null;
  missShare?: number | null;
  endedAt?: string | null;
  // The rate mod's acronym, so NC/DC are distinguishable from DT/HT (the rate
  // is identical). Refreshed from the live score on every compute like the rest
  // of the clear evidence; retained plays cached before the field existed stay
  // undefined and their consumers fall back to the rate's sign.
  rateMod?: string | null;
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

/**
 * The rate mod a play carries, by acronym. NC and DC are the pitch-shifting
 * variants of DT and HT, which the numeric rate alone cannot tell apart, so
 * anything showing a play at its own speed (the mod badge, the chart preview's
 * audio) needs this rather than the sign of `rate - 1`.
 */
export function getRateModAcronym(mods: OsuMod[] | string[] | undefined): string | null {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "DT" || acronym === "NC" || acronym === "HT" || acronym === "DC") return acronym;
  }
  return null;
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
 *
 * Returns null when the goal lands on the calc's 0.8 floor: the play's real
 * accuracy sits at or below what the calc can rate, so any SSR would be the
 * floor's, not the play's, and the play must not count.
 */
export function ssrGoalForScore(score: SsrGoalScore, lnRatio?: number | null, od?: number | null): number | null {
  const goal = ssrGoalForScoreUnchecked(score, lnRatio, od);
  return goal > SSR_GOAL_MIN ? goal : null;
}

function ssrGoalForScoreUnchecked(score: SsrGoalScore, lnRatio?: number | null, od?: number | null): number {
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
  // Share of LeoBlack cluster importance (amount x difficulty) on jack and on
  // stream clusters. Null when the chart carries no clusters. See clusterShare.
  jackShare: number | null;
  streamShare: number | null;
  // Whether LeoBlack's headline label for the whole chart carries "Tech".
  // Null when it stored no label. See TECH_CLUSTER_CATEGORY.
  techCategory: boolean | null;
  lnRatio: number | null;
  vibro: boolean;
  /** False when the chart's raw object structure makes its dan verdict unsafe
   * as player evidence. The chart may still display that verdict on /maps. */
  danEligible: boolean;
  rcRawDan: number | null;
  lnRawDan: number | null;
  dtRawDan: number | null;
  dtFamily: "rc" | "ln" | null;
  htRawDan: number | null;
  htFamily: "rc" | "ln" | null;
  /** Drain length at 1.0x, for the stamina gate in bucketingSkillset. */
  lengthSeconds: number | null;
}

interface LeanHalfJson {
  rawDan?: unknown;
}

interface LeanClassificationJson {
  lnRatio?: unknown;
  vibro?: unknown;
  danEligibility?: { eligible?: unknown } | null;
  rc?: LeanHalfJson | null;
  ln?: LeanHalfJson | null;
  patterns?: Array<{ id?: unknown; score?: unknown }>;
  clusters?: Array<{ pattern?: unknown; importance?: unknown }>;
  clusterCategory?: unknown;
}

// How much of a chart's difficulty is jack, from LeoBlack's pattern clusters.
// Importance is amount x difficulty, so this asks "is the jack the real content"
// rather than "is there jack", which is the distinction the in-house chordjack
// score cannot make: Rude Buster [7K] runs 265bpm chordstream over 133bpm jacks
// and scores chordjack 0.92, because counting how MUCH jack a chart has cannot
// separate hard jack from half-time filler between the real content.
function clusterShare(parsed: LeanClassificationJson | null, pattern: RegExp): number | null {
  const clusters = Array.isArray(parsed?.clusters) ? parsed.clusters : [];
  let total = 0;
  let matched = 0;
  for (const cluster of clusters) {
    const importance = Number(cluster?.importance);
    if (!Number.isFinite(importance) || importance <= 0) continue;
    total += importance;
    if (pattern.test(String(cluster?.pattern ?? ""))) matched += importance;
  }
  return total > 0 ? matched / total : null;
}

// LeoBlack's cluster vocabulary is six names (Chordstream, Jacks, Stream,
// Wildcard, Density, Coordination); these pick the two the tiles read.
const JACK_CLUSTERS = /jack/i;
const STREAM_CLUSTERS = /stream/i;

// A chart belongs to a tile when that family carries this much of its
// difficulty. Set against 131 charts from 23 mapper-named 7K jack packs and 100
// from 15 named stream/chordstream packs.
//
// Jack: real jack sits at p10 41% / median 88%, real stream at median 5% /
// p90 19%. At 0.4 the rule keeps 118/131 of the real jack and admits 0 of the
// 100 stream charts, against 114 and 3 for the chordjack tag it replaces.
// Lower cutoffs buy recall at a real cost: 0.35 keeps 123 but lets in two
// chordstream-pack charts whose jacks run at exactly half the chordstream BPM,
// the same shape as the false positives this exists to reject.
//
// Stream: real stream sits at p10 81% / median 95%, real jack at median 10%.
// Every cutoff from 0.3 to 0.6 catches 100/100 of the stream corpus, so this
// shares the jack number rather than inventing a second one; the 6K/7K tiles
// overlap by design, so the 23 jack-pack charts it also catches are charts that
// genuinely carry both.
const CLUSTER_SHARE_MIN = 0.4;

// Tech cannot use a share, because LeoBlack has no tech cluster: it is a
// suffix on the headline label instead ("Light Chordstream Tech", "Stream
// Tech"), naming the whole chart rather than a family inside it.
//
// The in-house tech score it replaces did not measure tech at all. Against
// mapper-named 7K packs it fired on 90% of stream charts and 67% of jack ones
// while reaching 77% on tech, so at the 0.5 tag line it was closer to "is this
// chart hard" than to a skill, and stream charts outnumber tech ones badly
// enough that the tile filled with them. The label fires on 68% of tech, 5% of
// stream and 8% of jack: nine points of recall for an 18x cut in stream.
// Hybrids that OR the label with a higher score line were measured and lose
// (at 0.7 stream returns to 79%).
//
// Speed overlaps it at 44% and that is left alone: delay charts are irregular
// by construction, the 6K/7K tiles overlap by design, and the corpus gives no
// reason to prefer one reading. One corpus was dropped as mislabelled on
// inspection rather than kept for size: "7K Endurance and Technical Training
// Pack" is an endurance pack, 0 of its 12 charts read as tech.
const TECH_CLUSTER_CATEGORY = /tech/i;

function readRawDan(half: LeanHalfJson | null | undefined): number | null {
  const rawDan = Number(half?.rawDan);
  return Number.isFinite(rawDan) && rawDan > 0 ? rawDan : null;
}

// Local libSQL materializes query results synchronously on the calling thread.
// Keep a corpus sweep's chart lookup below one frame-sized burst, while a normal
// one-player compute still needs only one statement. Measured on the live 12k-id
// sweep batch after fixing the query plan below: 500-id chunks took ~220ms total
// and held the event loop for ~13ms at a time.
const CHART_SKILL_INFO_QUERY_CHUNK = 500;

export async function loadChartSkillInfo(db: Db, beatmapIds: number[]): Promise<Map<number, ChartSkillInfo>> {
  const ids = [...new Set(beatmapIds)].filter((id) => Number.isInteger(id) && id > 0);
  const info = new Map<number, ChartSkillInfo>();
  if (ids.length === 0) return info;
  for (let offset = 0; offset < ids.length; offset += CHART_SKILL_INFO_QUERY_CHUNK) {
    const chunk = ids.slice(offset, offset + CHART_SKILL_INFO_QUERY_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    /* Do not put `status = 'ready'` in this SQL. With that predicate SQLite
       chose idx_beatmap_chart_analysis_status_updated and scanned every ready
       chart even for one player's few hundred ids (~180ms on the live DB).
       The primary key is (beatmap_id, analysis_version), so drive from those
       two terms and discard the at-most-one returned non-ready row in JS. */
    const rows = (await exec(
      db,
      `select a.beatmap_id, a.status, a.key_count, a.classification_json, a.dan_dt_json, a.dan_ht_json,
              json_extract(b.metadata_json, '$.total_length') as total_length
         from beatmap_chart_analysis a
         left join beatmaps b on b.beatmap_id = a.beatmap_id
        where a.analysis_version = ? and a.beatmap_id in (${placeholders})`,
      [CHART_ANALYSIS_VERSION, ...chunk],
    )).rows;
    for (const row of rows) {
      if (String(row.status ?? "") !== "ready") continue;
      const parsed = parseJson<LeanClassificationJson | null>(String(row.classification_json ?? ""), null);
      const patternScores = new Map<string, number>();
      for (const hit of Array.isArray(parsed?.patterns) ? parsed.patterns : []) {
        const id = String(hit?.id ?? "");
        if (id) patternScores.set(id, Math.max(patternScores.get(id) ?? 0, Number(hit?.score ?? 0)));
      }
      const rawKeyCount = Number(row.key_count);
      const keyCount = Number.isFinite(rawKeyCount) && rawKeyCount > 0 ? rawKeyCount : null;
      const chordjackScore = patternScores.get("chordjack") ?? 0;
      const jackScore = patternScores.get("jack") ?? 0;
      const jackShare = clusterShare(parsed, JACK_CLUSTERS);
      const isJack = chartIsJack(keyCount, chordjackScore, jackScore, jackShare);
      const vetoesTech = jackVetoesTech(keyCount, chordjackScore, jackScore, jackShare);
      const rawLnRatio = Number(parsed?.lnRatio);
      const lnRatio = Number.isFinite(rawLnRatio) ? Math.max(0, Math.min(1, rawLnRatio)) : null;
      // A chart whose analysis carries no lnRatio cannot be verified as LN, so
      // it keeps no LN tag rather than being trusted.
      const chartIsLn = lnRatio != null && lnRatio >= LN_PATTERN_LN_RATIO_MIN;
      const patternIds = [...patternScores.entries()]
        .filter(([id, score]) =>
          score >= patternTagMinScore(id)
          && !(id === "tech" && vetoesTech)
          && !(LN_PATTERN_IDS.has(id) && !chartIsLn))
        .map(([id]) => id);
      // The derived whole-jack tag (see chartIsJack). The chordjack tag stays
      // beside it for the consumers that mean chord jack specifically; 4K
      // keeps its native analyzer tags untouched.
      if ((keyCount === 6 || keyCount === 7) && isJack && !patternIds.includes("jack")) patternIds.push("jack");
      const danDt = parseJson<{ rawDan?: unknown; primaryFamily?: unknown } | null>(String(row.dan_dt_json ?? ""), null);
      const dtRawDan = readRawDan(danDt ?? undefined);
      const danHt = parseJson<{ rawDan?: unknown; primaryFamily?: unknown } | null>(String(row.dan_ht_json ?? ""), null);
      const htRawDan = readRawDan(danHt ?? undefined);
      info.set(Number(row.beatmap_id), {
        patterns: patternIds,
        jackShare,
        streamShare: clusterShare(parsed, STREAM_CLUSTERS),
        techCategory: typeof parsed?.clusterCategory === "string"
          ? TECH_CLUSTER_CATEGORY.test(parsed.clusterCategory)
          : null,
        lnRatio,
        vibro: parsed?.vibro === true,
        // Legacy rows have no field and stay eligible until the targeted
        // cached-.osu sweep inspects them. Fresh analyses always store it.
        danEligible: parsed?.danEligibility?.eligible !== false,
        rcRawDan: readRawDan(parsed?.rc),
        lnRawDan: readRawDan(parsed?.ln),
        dtRawDan,
        dtFamily: dtRawDan == null ? null : danDt?.primaryFamily === "ln" ? "ln" : "rc",
        htRawDan,
        htFamily: htRawDan == null ? null : danHt?.primaryFamily === "ln" ? "ln" : "rc",
        lengthSeconds: readLengthSeconds(row.total_length),
      });
    }
    if (offset + chunk.length < ids.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
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
// PRIMARY family (LN iff the hold share clears LN_PRIMARY_MIN_RATIO, the same
// rule as /maps): accuracy
// on an LN chart is earned on the holds, so it proves nothing about the rice
// half's rating, and vice versa. Rate mods count on the same terms: any pass
// in the estimator's 0.5x-2.0x band credits the chart's stored verdict AT that
// rate, on that verdict's primary side, so it is worth what the chart is worth
// at the rate it was played rather than what it is worth at 1.0x. The 1.5x and
// 0.75x sweeps' chart-analysis columns stay the first read; every other rate
// (and a 1.5x/0.75x chart those sweeps never covered) reads the dan_estimates
// verdict at the play's own rate_percent, which the skill compute fills in on
// demand. A rate verdict nobody has computed yet still contributes nothing -
// until the next compute lands it.
function computeModeDan(
  keyCount: number,
  plays: StoredPlaySsr[],
  scoresByIdentity: Map<string, OscScore>,
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[] = [],
  rateVerdicts: RateVerdictMap = new Map(),
): PlayerSkillModeDan {
  const clears: Record<"rc" | "ln", DanClearEvidence[]> = { rc: [], ln: [] };
  for (const clear of collectDanClears(keyCount, plays, scoresByIdentity, infoByBeatmap, rateVerdicts)) {
    clears[clear.side].push(clear);
  }
  const forSide = (side: "rc" | "ln"): PlayerSkillDanSide | null =>
    danSideFromClears(keyCount, side, clears[side], infoByBeatmap, courseClears);
  return { rc: forSide("rc"), ln: forSide("ln") };
}

// One credited clear and the dan it demonstrates; the shared currency
// between the stored verdict (computeModeDan) and the on-demand evidence
// surface (getPlayerSkillDanEvidence), so the two can never disagree on what
// counts as a clear. Exported for the dan-credit-drift maintenance script,
// which replays the aggregation over modified copies of these.
export interface DanClearEvidence {
  play: StoredPlaySsr;
  side: "rc" | "ln";
  // The chart's own dan at the played rate, before the accuracy credit.
  chartDan: number;
  // chartDan plus the accuracy offset, clamped to the ladder (creditedDanFor):
  // the number every aggregation below reads. Equal to chartDan for a bare
  // pass at the bar.
  creditedDan: number;
  // The accuracy the clear was judged on, in this ladder's own currency
  // (danClearBarFor), so the evidence surface can show what it was measured
  // against rather than the client's displayed number.
  accuracy: number;
  // The bar it was judged against, after any stable->v2 conversion.
  bar: number;
}

/**
 * The dan credit for plays at rates the chart-analysis columns do not cover,
 * keyed by rateDanVerdictKey. A null value is a stored terminal row (nothing
 * to credit and nothing to recompute); an absent key is a verdict nobody has
 * computed yet, which the skill compute fills in and the evidence read
 * enqueues.
 */
type RateVerdictMap = Map<string, { rawDan: number; side: "rc" | "ln" } | null>;

/**
 * The rate a clear at this play would be credited at, or null when the play is
 * 1.0x (the chart's own verdict covers it) or outside the estimator's 50-200%
 * band. Wind up/down and adaptive speed never get here: getPlayRate already
 * returned null for them, so such plays were never rated at all.
 */
function clearRatePercent(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return null;
  const percent = Math.round(rate * 100);
  if (percent === 100 || percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
  return percent;
}

/** The stored rate verdicts these plays' clears read, in clear-rule terms. */
async function loadRateVerdictCredits(db: Db, plays: StoredPlaySsr[]): Promise<RateVerdictMap> {
  const pairs: Array<{ beatmapId: number; ratePercent: number }> = [];
  for (const play of plays) {
    const ratePercent = clearRatePercent(play.rate);
    if (ratePercent != null && Number.isInteger(play.beatmapId) && play.beatmapId > 0) {
      pairs.push({ beatmapId: play.beatmapId, ratePercent });
    }
  }
  const stored = await loadStoredRateDanVerdicts(db, pairs);
  const credits: RateVerdictMap = new Map();
  for (const [key, verdict] of stored) {
    credits.set(key, verdict ? { rawDan: verdict.rawDan, side: verdict.family === "ln" ? "ln" : "rc" } : null);
  }
  return credits;
}

/**
 * The (chart, rate) verdicts these plays would be credited against but nobody
 * has computed yet. Charts without a ready analysis row are not listed: they
 * are not clear-eligible at any rate, and the untagged-chart queue owns them.
 */
function missingRateVerdictPairs(
  plays: StoredPlaySsr[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  rateVerdicts: RateVerdictMap,
): Array<{ beatmapId: number; ratePercent: number }> {
  const missing = new Map<string, { beatmapId: number; ratePercent: number }>();
  for (const play of plays) {
    const ratePercent = clearRatePercent(play.rate);
    if (ratePercent == null) continue;
    const info = infoByBeatmap.get(play.beatmapId);
    if (!info) continue;
    if (ratePercent === 150 && info.dtFamily != null) continue;
    if (ratePercent === 75 && info.htFamily != null) continue;
    const key = rateDanVerdictKey(play.beatmapId, ratePercent);
    if (rateVerdicts.has(key)) continue;
    missing.set(key, { beatmapId: play.beatmapId, ratePercent });
  }
  return [...missing.values()];
}

function collectDanClears(
  keyCount: number,
  plays: StoredPlaySsr[],
  scoresByIdentity: Map<string, OscScore>,
  infoByBeatmap: Map<number, ChartSkillInfo>,
  rateVerdicts: RateVerdictMap = new Map(),
): DanClearEvidence[] {
  const clears: DanClearEvidence[] = [];
  for (const play of plays) {
    const info = infoByBeatmap.get(play.beatmapId);
    if (!info) continue;
    if (!info.danEligible) continue;
    // Clear evidence rides on the stored play (retained plays outlive their
    // score payload); the live score object is the fallback for cache entries
    // written before the fields existed.
    const score = scoresByIdentity.get(play.identity);
    const displayed = play.accuracy ?? (score ? getDisplayedAccuracy(score) : null);
    if (typeof displayed !== "number") continue;
    // Both currencies come off the judgement counts, so a bar written in one
    // of them means the same thing on stable and on lazer. The client's own
    // displayed accuracy is only the fallback for acc-only archived rows,
    // where the counts are gone and there is nothing to recompute from.
    const stable = play.stableAccuracy ?? (score ? calculateStableAccuracy(score.statistics ?? {}) || null : null);
    const scoreV2 = play.scoreV2Accuracy ?? (score ? calculateScoreV2Accuracy(score.statistics) || null : null);
    // A lazer submission displays the ScoreV2 formula already, so its own
    // accuracy is that currency even with no counts to recompute from.
    const isLazerPlay = stable != null && Math.abs(displayed - stable) > 1e-9;
    const push = (rawDan: number | null, side: "rc" | "ln") => {
      if (rawDan == null) return;
      const bar = danClearBarFor(side, keyCount, rawDan);
      let threshold = bar.accuracy;
      let accuracy: number;
      if (bar.currency !== "v2") {
        accuracy = stable ?? displayed;
      } else if (scoreV2 != null) {
        accuracy = scoreV2;
      } else if (isLazerPlay) {
        accuracy = displayed;
      } else {
        accuracy = stable ?? displayed;
        threshold += STABLE_EQUIVALENT_V2_BAR_OFFSET;
      }
      // For a stable-only row judged against a v2 bar, threshold is already
      // the converted 97.5%, so the credit window and the bonus headroom both
      // shift with it: the whole scale rides the converted bar, deliberately.
      const creditedDan = creditedDanFor(rawDan, accuracy, threshold, side, keyCount);
      if (creditedDan == null) return;
      clears.push({ play, side, chartDan: rawDan, creditedDan, accuracy, bar: threshold });
    };
    if (play.rate === 1 && info.lnRatio != null) {
      const side = info.lnRatio >= LN_PRIMARY_MIN_RATIO ? "ln" : "rc";
      push(side === "ln" ? info.lnRawDan : info.rcRawDan, side);
    } else if (play.rate === 1.5 && info.dtFamily != null) {
      push(info.dtRawDan, info.dtFamily);
    } else if (play.rate === 0.75 && info.htFamily != null) {
      // Credited what the chart is worth AT 0.75x, which is well under its 1.0x
      // dan: slowing a chart down does not clear the chart it used to be.
      push(info.htRawDan, info.htFamily);
    } else {
      // Every other rate in the 0.5x-2.0x band - a lazer speed_change, or a
      // 1.5x/0.75x chart the sweeps never stored columns for - credits the
      // dan_estimates verdict at the play's own rate, on the same terms.
      const ratePercent = clearRatePercent(play.rate);
      if (ratePercent == null) continue;
      const verdict = rateVerdicts.get(rateDanVerdictKey(play.beatmapId, ratePercent));
      if (verdict) push(verdict.rawDan, verdict.side);
    }
  }
  return clears;
}

/** Test seam over the clear rules: same call the verdict and the evidence make. */
export function collectDanClearsForTest(
  keyCount: number,
  plays: StoredPlaySsr[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  rateVerdicts: RateVerdictMap = new Map(),
): DanClearEvidence[] {
  return collectDanClears(keyCount, plays, new Map(), infoByBeatmap, rateVerdicts);
}

/** Test seam over one side's whole verdict, skillset dans and averaged headline. */
export function danSideFromClearsForTest(
  keyCount: number,
  side: "rc" | "ln",
  plays: StoredPlaySsr[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[] = [],
  rateVerdicts: RateVerdictMap = new Map(),
): PlayerSkillDanSide | null {
  const clears = collectDanClears(keyCount, plays, new Map(), infoByBeatmap, rateVerdicts).filter((clear) => clear.side === side);
  return danSideFromClears(keyCount, side, clears, infoByBeatmap, courseClears);
}

/** Test seam over the aggregation alone, given clears already collected. */
export function danSideFromClearEvidenceForTest(
  keyCount: number,
  side: "rc" | "ln",
  clears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[] = [],
): PlayerSkillDanSide | null {
  return danSideFromClears(keyCount, side, clears, infoByBeatmap, courseClears);
}

// How many best clears the dan averages over. One more than the quorum, so a
// quorum-sized pool simply averages everything it has.
const DAN_CLEAR_AVERAGE_WINDOW = 5;

// 4K LN averages twice the window. It is the one ladder with no skillset
// buckets, so its headline is this side-wide average alone, and with the
// best-5 a couple of near-miss credits on charts above the player's level
// could still carry it (the 2026-08-28 window narrowing helped but left
// known-13 players printing 14). Ten asks for a body of work instead.
export function danClearAverageWindowFor(side: "rc" | "ln", keyCount: number): number {
  return keyCount === 4 && side === "ln" ? DAN_CLEAR_AVERAGE_WINDOW * 2 : DAN_CLEAR_AVERAGE_WINDOW;
}

function danFromClears(rawDans: number[], side: "rc" | "ln", keyCount: number): PlayerSkillDanVerdict | null {
  if (rawDans.length < DAN_CLEAR_QUORUM) return null;
  const sorted = [...rawDans].sort((a, b) => b - a);
  // The dan is the mean of the best danClearAverageWindowFor credited clears
  // (all of them on a quorum-sized pool). One outlier clear cannot set the
  // level on its own, but it is no longer discarded the way the old
  // quorum-th-clear rule discarded everything above the 4th: it pulls the
  // average up in proportion to how far it sits above the rest.
  const window = sorted.slice(0, danClearAverageWindowFor(side, keyCount));
  const rawDan = Math.round((window.reduce((sum, value) => sum + value, 0) / window.length) * 100) / 100;
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: sorted.filter((value) => value >= rawDan - DAN_ROUNDING_EPSILON).length,
    ...(isBeyondDanTable(rawDan, side, keyCount) ? { beyondTable: true } : {}),
  };
}

// A dan is stored rounded to two decimals, so "clears at or above the
// estimate" has to compare against the rounded number with room for the
// rounding itself - otherwise the very clear that set an unrounded 10.126
// falls out of its own 10.13 estimate.
const DAN_ROUNDING_EPSILON = 0.005;

// How many skillsets have to carry a dan of their own before the average is
// the headline. Under this the side falls back to the side-wide best-clears
// average (danFromClears over every clear on the side).
//
// Two rather than all four because bucket coverage is play depth, not
// specialisation: measured over the 11,652 rated 4K rice players, everyone
// past 200 analysed plays has three or more buckets and everyone past 500 has
// all four, while the players missing three of them sit at a median of 23
// plays. Demanding four would grade newcomers on how little they have played,
// and on 6K/7K - where the buckets come from analyzer tags rather than an MSD
// argmax - it would grade them on how narrow that tag vocabulary is (only
// 2.2% of 7K LN players and 0.8% of 6K rice players have all four). Two keeps
// the fallback to the 6.8% of 4K players with too little to average.
const DAN_SKILLSET_AVERAGE_MIN_BUCKETS = 2;

/**
 * The headline dan for a side: the arithmetic mean of the skillset dans the
 * player has, NOT their best clears.
 *
 * The quorum-th best clear on the whole side answers "what is the hardest
 * thing you can do four of", which on a specialist is four charts of the one
 * pattern they play. Measured over the corpus, the old headline sat a median
 * of 0.00-0.18 levels above the player's single best skillset - it WAS the
 * best specialty, by construction. Averaging asks the question a real course
 * asks instead, since a course makes you clear a mix rather than four of your
 * favourite. It bites in proportion to how lopsided the player is: 4K players
 * whose jack dan leads their next skillset by two levels or more drop a median
 * of 2.74 levels, while balanced players barely move.
 *
 * Skillsets absent for want of a quorum are left out of the mean rather than
 * counted as zero. A missing bucket is overwhelmingly thin evidence rather
 * than a hole in the player's skill - among 4K players missing exactly one,
 * the missing one is jack 77.5% of the time, so zeroing it would penalise not
 * being a jack main, which is the opposite of the point.
 */
function averageSkillsetDans(
  skillsets: Record<string, PlayerSkillDanVerdict>,
  clearDans: number[],
  side: "rc" | "ln",
  keyCount: number,
): PlayerSkillDanVerdict | null {
  const values = Object.values(skillsets).map((verdict) => verdict.rawDan);
  if (values.length < DAN_SKILLSET_AVERAGE_MIN_BUCKETS) return null;
  const rawDan = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    // The clears that reach the estimate.
    clears: clearDans.filter((value) => value >= rawDan - DAN_ROUNDING_EPSILON).length,
    ...(isBeyondDanTable(rawDan, side, keyCount) ? { beyondTable: true } : {}),
  };
}

/**
 * One side's whole verdict: the skillset dans and the headline averaged from
 * them. Shared by the stored compute and the on-demand evidence window so the
 * badge, the leaderboard and the modal can never disagree.
 *
 * The side still needs a full quorum of clears to be rated at all - fewer than
 * four qualifying passes is no estimate rather than a shaky one - and a side
 * with fewer than DAN_SKILLSET_AVERAGE_MIN_BUCKETS rated skillsets keeps the
 * side-wide best-clears average as its headline. Keymodes that publish no
 * buckets at all (4K and 6K LN) therefore keep that side-wide rule everywhere.
 */
function danSideFromClears(
  keyCount: number,
  side: "rc" | "ln",
  list: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
  courseClears: DanCourseClear[] = [],
): PlayerSkillDanSide | null {
  const best = bestDanCourseClear(courseClears, keyCount, side);
  const clearDans = list.map((clear) => clear.creditedDan);
  const quorumDan = danFromClears(clearDans, side, keyCount);
  if (!quorumDan) return best ? danSideFromCourseClear(best, side, keyCount) : null;
  // Buckets are a subset of the side's clears, so a side under the quorum can
  // never have one: no verdict here means no skillset verdicts either.
  const skillsets: Record<string, PlayerSkillDanVerdict> = {};
  for (const [id, bucketClears] of groupDanClearsBySkillset(keyCount, side, list, infoByBeatmap)) {
    const bucketDan = danFromClears(bucketClears.map((clear) => clear.creditedDan), side, keyCount);
    if (bucketDan) skillsets[id] = bucketDan;
  }
  const headline = averageSkillsetDans(skillsets, clearDans, side, keyCount) ?? quorumDan;
  const withCourse = applyDanCourseFloor(headline, best, side, keyCount, clearDans);
  return Object.keys(skillsets).length > 0 ? { ...withCourse, skillsets } : withCourse;
}

/** The strongest credited course run on one side of one keymode's ladder. */
function bestDanCourseClear(clears: DanCourseClear[], keyCount: number, side: "rc" | "ln"): DanCourseClear | null {
  let best: DanCourseClear | null = null;
  for (const clear of clears) {
    if (clear.keyCount !== keyCount || clear.side !== side) continue;
    if (!best || clear.rawDan > best.rawDan) best = clear;
  }
  return best;
}

/**
 * A verified dan course clear is a floor under the headline, never a ceiling.
 *
 * The averaged estimate answers "what does the mix of charts you pass say you
 * are"; a course answers the same question by examination, and a player who
 * has passed the exam has already settled it for every level at or below it.
 * So the clear can only raise the number. It cannot lower one: clearing
 * epsilon proves epsilon is within reach, not that zeta is not - the estimate
 * is still the better evidence above the clear.
 *
 * Skillsets are deliberately left alone. The override is a headline rule, and
 * a course is a mix rather than one pattern, so it says nothing about which
 * bucket carried it; the per-skillset dan columns keep measuring what they
 * measure.
 */
function applyDanCourseFloor(
  headline: PlayerSkillDanVerdict,
  best: DanCourseClear | null,
  side: "rc" | "ln",
  keyCount: number,
  clearDans: number[],
): PlayerSkillDanSide {
  if (!best || !(best.rawDan > headline.rawDan + DAN_ROUNDING_EPSILON)) return headline;
  return {
    ...danVerdictAt(best.rawDan, side, keyCount, clearDans),
    courseClear: danCourseCredit(best),
  };
}

/** A side that exists only because of a course clear: no quorum, no skillsets. */
function danSideFromCourseClear(best: DanCourseClear, side: "rc" | "ln", keyCount: number): PlayerSkillDanSide {
  return {
    ...danVerdictAt(best.rawDan, side, keyCount, []),
    courseClear: danCourseCredit(best),
  };
}

// The stored half is the summary a badge tooltip needs. The play behind it
// (ids, mods, judgements) is not stored: it would ride in every player's
// modes_json to be read on the rare click, so the evidence endpoint re-reads it
// on demand instead, the same way it re-derives everything else it shows.
function danCourseCredit(best: DanCourseClear): NonNullable<PlayerSkillDanSide["courseClear"]> {
  return {
    beatmapId: best.beatmapId,
    courseName: best.courseName,
    level: best.level,
    accuracy: best.accuracy,
    currency: best.currency,
    bar: best.bar,
    ...(best.displayedAccuracy != null ? { displayedAccuracy: best.displayedAccuracy } : {}),
  };
}

function danVerdictAt(rawDan: number, side: "rc" | "ln", keyCount: number, clearDans: number[]): PlayerSkillDanVerdict {
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: clearDans.filter((value) => value >= rawDan - DAN_ROUNDING_EPSILON).length,
    ...(isBeyondDanTable(rawDan, side, keyCount) ? { beyondTable: true } : {}),
  };
}

// A quorum clear that landed on the table's "> last tier" sentinel carries
// the whole ladder's ceiling with it: the estimate is a floor, and the chip
// says so rather than showing the top level as if it were measured. Accuracy
// bonuses can reach the sentinel too (creditedDanFor clamps there), so a
// window of maxed clears on the last tiers reads the same way; that is real
// evidence the ladder stopped measuring the player, and the chip stays honest.
function isBeyondDanTable(rawDan: number, side: "rc" | "ln", keyCount: number): boolean {
  const ceiling = danTableCeilingFor(side, keyCount);
  return ceiling != null && rawDan >= ceiling;
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

// A chart verdict sits on one of the source table's five named tiers, whose
// raw offsets differ from the continuous suffix bands used for player credits
// and averages. Preserve that source tier in evidence so opening the same
// chart cannot change "Mystery low" from mystery-- to mystery-.
function chartDanLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  if (keyCount !== 4) {
    const tableLabel = danTableVerdictLabelFor(rawDan, side, keyCount);
    if (tableLabel != null) return tableLabel;
  }
  return danLabelFor(rawDan, side, keyCount);
}

/** Test seam over the ladder labeler, so the course registry can assert its
 *  levels relabel to the names it declares them under. */
export function danLabelForTest(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  return danLabelFor(rawDan, side, keyCount);
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

// Bound on missing (chart, rate) dan verdicts computed per invocation, on top
// of the shared calc-run budget: each is one MinaCalc-plus-estimator burst and
// the result is corpus-shared, so a backlog drains across computes quickly.
const MAX_RATE_VERDICT_COMPUTES = 24;

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
  options: { trackedScores?: OscScore[]; untrustedIdentities?: Set<string>; courseClears?: DanCourseClear[] } = {},
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
    if (goal == null) {
      if (source === "top") unsupportedPlays += 1;
      return;
    }
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
      scoreV2Accuracy: calculateScoreV2Accuracy(score.statistics) || null,
      customAccuracy: getStoredScoreAccuracy(score),
      missShare: getMissShare(score.statistics),
      endedAt: score.ended_at ?? score.created_at ?? null,
      rateMod: getRateModAcronym(score.mods),
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
    // A stored goal at the calc floor means the play's real accuracy sat at
    // or below it (the clamp erased how far below), so its SSR is the
    // floor's, not the play's. Rated before the sub-floor exclusion existed;
    // evict instead of retaining.
    if (!(previous.goal > SSR_GOAL_MIN)) continue;
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

  // Rate verdicts for the custom-rate clears: read what is stored, then
  // compute the missing ones right here, where MinaCalc already runs - so the
  // dan block written below credits them in the same pass instead of racing a
  // job in another lane. Bounded like the SSR loop; leftovers wait for the
  // next compute exactly as pending plays do.
  const rateVerdicts = await loadRateVerdictCredits(db, analyzed);
  let verdictComputes = 0;
  for (const pair of missingRateVerdictPairs(analyzed, infoByBeatmap, rateVerdicts)) {
    if (verdictComputes >= MAX_RATE_VERDICT_COMPUTES || calcRunsTotal >= MAX_CALC_RUNS_PER_COMPUTE) break;
    const osuText = await loadOsuText(db, osu, pair.beatmapId);
    if (osuText == null) continue;
    verdictComputes += 1;
    calcRunsTotal += 1;
    const lean = await computeAndStoreRateDanVerdictFromText(db, pair.beatmapId, pair.ratePercent, osuText);
    if (lean) {
      rateVerdicts.set(
        rateDanVerdictKey(pair.beatmapId, pair.ratePercent),
        { rawDan: lean.rawDan, side: lean.family === "ln" ? "ln" : "rc" },
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
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
      dan: computeModeDan(keyCount, list, scoresByIdentity, infoByBeatmap, options.courseClears, rateVerdicts),
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
      courseClears: await loadPlayerDanCourseClears(db, userId),
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
      // Tracked plays feed the rating too (loadTrackedScores), so a view
      // mid-session must not wait out the session debounce just because no
      // play entered the top-200. received_at rather than ended_at: it shares
      // computed_at's clock (ended_at is osu!'s) and covers backfill, and a
      // play the compute already read was received before the ratings write
      // stamped computed_at, so a fresh row stays quiet.
      const newTrackedPlays = newTopPlays > 0 ? 1 : Number((await exec(
        db,
        `select count(*) as cnt from score_events
         where user_id = ? and passed = 1 and ruleset_id = 3 and received_at > ?`,
        [userId, row.computed_at],
      )).rows[0]?.cnt ?? 0);
      shouldEnqueue = newTrackedPlays > 0;
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
  const candidates = (Array.isArray(stored?.plays) ? stored.plays : [])
    .flatMap((play) => {
      if (!play || play.keyCount !== keyCount || !Number.isInteger(play.beatmapId) || play.beatmapId <= 0) return [];
      if (patternId && !Array.isArray(play.patterns)) return [];
      if (patternId && !play.patterns.includes(patternId)) return [];
      const rating = Number(play.values?.[patternId ? "Overall" : axis] ?? 0);
      if (!Number.isFinite(rating) || rating <= 0) return [];
      return [{ play, rating }];
    });
  // No LN re-check here: the lnRatio gate rides on the stored ln tag itself
  // (loadChartSkillInfo), so this list and the LN rating above it are the same
  // set of plays. Plays stored before the gate keep their old tags until the
  // profile's next recompute.
  const matches = candidates
    .sort((left, right) =>
      right.rating - left.rating
      || Number(right.play.pp ?? 0) - Number(left.play.pp ?? 0)
      || String(right.play.endedAt ?? "").localeCompare(String(left.play.endedAt ?? ""))
      || left.play.beatmapId - right.play.beatmapId);

  const page = matches.slice(offset, offset + limit);
  const metadata = await readPlayerSkillPlayMetadata(db, page.map(({ play }) => play.beatmapId));
  const items = page.map(({ play, rating }) => buildPlayerSkillPlay(play, rating, keyCount, metadata));
  return { items, total: matches.length, limit, offset };
}

const RATE_MOD_ACRONYMS = new Set(["DT", "NC", "HT", "DC"]);

function buildPlayerSkillPlay(
  play: StoredPlaySsr,
  rating: number,
  keyCount: number,
  metadata: Map<number, PlayerSkillPlayMetadata>,
): PlayerSkillPlay {
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
    rateMod: RATE_MOD_ACRONYMS.has(String(play.rateMod ?? "")) ? String(play.rateMod) : null,
    topSkillset: dominantSkillset(play.values),
  };
}

// --- Dan evidence: the clears behind a player's dan estimate ---

// One credited clear as the dan-detail modal shows it: the play, the chart's
// own dan on the side it testifies for, the dan the clear actually credited
// after the accuracy curve (equal to the chart's for a bare pass at the bar),
// and the accuracy it was judged on in that ladder's currency (which is not
// always the client's displayed number). `countsTowardDan` marks the clears
// whose credit sits at or above the side's estimate (the ones the stored
// verdict's `clears` count refers to).
export interface PlayerSkillDanEvidencePlay {
  play: PlayerSkillPlay;
  chartDan: number;
  chartDanLabel: string;
  creditedDan: number;
  creditedDanLabel: string;
  clearAccuracy: number;
  countsTowardDan: boolean;
}

export interface PlayerSkillDanSkillsetEvidence {
  // Bucket id from danSkillsetBuckets: "jack"/"tech"/"speed" plus "stamina"
  // (4K) or "stream" (6K/7K) on the rice side, and "ln" or the four
  // "ln*" subtypes on the LN side. Not a raw analyzer pattern tag.
  id: string;
  clears: number;
  // This skillset's own best-clears average, one of the terms the headline
  // dan averages; null while the skillset has fewer than quorum clears.
  dan: { rawDan: number; label: string } | null;
  plays: PlayerSkillDanEvidencePlay[];
}

/**
 * The course run behind a floored headline, with enough of the play attached
 * for the window to prove it: a loved course has an osu! score page, a
 * graveyard one has none and opens the site's own details card instead.
 */
export interface PlayerSkillDanCourseEvidence {
  beatmapId: number;
  beatmapsetId: number | null;
  courseName: string;
  title: string;
  artist: string;
  version: string;
  level: string;
  rawDan: number;
  label: string;
  accuracy: number;
  currency: "stable" | "v2";
  bar: number;
  displayedAccuracy: number | null;
  beatmapStatus: string | null;
  scoreId: number | null;
  soloScoreId: number | null;
  legacyScoreId: number | null;
  mods: string[];
  statistics: OsuScoreStatistics | null;
  maxCombo: number | null;
  totalScore: number | null;
  rank: string | null;
  playedAt: string | null;
  hasReplay: boolean | null;
  isLazer: boolean | null;
}

export interface PlayerSkillDanEvidence {
  side: "rc" | "ln";
  keyCount: number;
  quorum: number;
  /** The lowest accuracy that credits anything: barAccuracy minus the credit window. */
  minAccuracy: number;
  /** The ladder's own pass bar, where a clear credits the chart's full dan. */
  barAccuracy: number;
  dan: PlayerSkillDanSide | null;
  totalClears: number;
  clears: PlayerSkillDanEvidencePlay[];
  skillsets: PlayerSkillDanSkillsetEvidence[];
  /** Present only when a course clear set this side's headline. */
  courseClear: PlayerSkillDanCourseEvidence | null;
}

const DAN_EVIDENCE_MAX_CLEARS = 20;
const DAN_EVIDENCE_SKILLSET_PLAYS = 10;

interface DanSkillsetBucket {
  id: string;
  /** Analyzer pattern tags that put a clear in this bucket. */
  tags: string[];
  /**
   * MSD skillsets that put a clear in this bucket, by the play's STRONGEST
   * skillset rather than by a tag. Set only where MinaCalc rates the keymode
   * meaningfully (4K); a bucket set built this way is mutually exclusive, so
   * the bucket clear counts partition the side's clears instead of overlapping.
   */
  skillsets?: string[];
  /**
   * Take the bucket from a LeoBlack cluster share (CLUSTER_SHARE_MIN) instead of
   * `tags`, falling back to `tags` when a chart has no clusters. The in-house
   * scores say how much of a pattern a chart contains, which cannot tell easy
   * half-time jacks between chordstream from a chart built on jack; importance
   * share weights by difficulty, so it asks whether the pattern IS the chart.
   * The two detectors failed in opposite directions on the same charts, with
   * chordjack over-firing where chordstream under-fired.
   */
  clusterFamily?: "jack" | "stream" | "tech";
}

/**
 * The skillsets a dan estimate is broken down by, per keymode and side.
 *
 * Not the analyzer's raw vocabulary: each keymode gets the four skills its
 * players name, and the underlying signal folds into them. Which signal that
 * is differs by keymode, because only one of the two is trustworthy on each.
 *
 * 4K goes through MinaCalc's MSD skillsets, taken from the play's own SSR
 * vector at the rate it was played, bucketed by the play's STRONGEST skillset
 * - the same "this is a stamina chart" reading the maps pages show. Because it
 * is an argmax, the four buckets are disjoint and their clear counts sum to the
 * side's total. Measured over the 2,062,117 rated 4K plays in the corpus:
 * Technical 37.8%, Stamina 30.2%, Jumpstream 21.2%, Chordjack 7.0%,
 * Handstream 2.2%, Stream 1.5%, JackSpeed 0.1%.
 *
 * Speed is Stream ALONE, and that is the whole point of the split. MinaCalc's
 * Jumpstream fires on dense jumptrill, which 4K players read as tech rather
 * than speed, so pairing the two put charts like Blastix Riotz [GRAVITY]
 * (Stream 21.6, Jumpstream 28.4) on a tile labelled speed. Checked against the
 * Gamma++ Speed Collection, a 25-chart pack built entirely of real 4K speed:
 * every one of the 25 is Stream-argmax, Stream beating Jumpstream by 2.6 to
 * 13.5, while the jumptrill charts run 3.5 to 8.5 the other way. The two
 * populations do not overlap on that difference, so Stream alone separates
 * them and Jumpstream rides with Technical, where the in-house tagger already
 * puts those charts (GRAVITY tags tech 0.73, HOLLOWood tags tech 0.85).
 *
 * Speed also wins near-ties outright (SPEED_NEAR_TIE_MSD), because a hard
 * argmax reads noise where these skillsets sit on top of each other. A second
 * speed pack, this one alpha-level, has charts where Stamina beats Stream by
 * 0.08 and Technical beats it by 0.02: at that density streaming IS stamina
 * and tech demanding, so all three rate alike and whichever edges ahead is
 * arbitrary. Requiring Stream merely to be near the top instead of at it takes
 * that pack from 23/30 in speed to 30/30, leaves the gamma pack at 25/25, and
 * still rejects the jumptrill charts by a mile (they miss by 6.8 and 8.5).
 * Corpus-wide it moves speed from 1.5% of rated plays to 9.2%, and pulls in
 * only 4.2% of Jumpstream-argmax plays. Re-measure against both packs and a
 * jumptrill set before touching the constant.
 *
 * Jack is the one 4K tile that also reads the analyzer, because MinaCalc
 * cannot see speedjack: it rates those charts Jumpstream-argmax with JackSpeed
 * dead last (Gamma speedjack pack 3's FINAL BOSS: Jumpstream 32.0, JackSpeed
 * 17.6), which filed half of every named speedjack pack under tech. A chart
 * wearing the analyzer's chordjack tag (>= 0.8, near-certainty) or speedjack
 * tag (>= 0.5, the ordinary bar; the detector is silent - p90 0.00 - on every
 * non-jack corpus, the delay shape) files under jack no matter the argmax.
 * Measured against mapper-named 4K packs (157 speedjack / 1,510 jack / 1,300
 * chordjack / 380 tech / 1,062 speed / 445 jumpstream / 610 stamina / 1,109
 * stream charts): the speedjack corpus goes 49% -> 83% on the jack tile and
 * the jack corpus 76% -> 88%, at under 1% moved from each of tech, speed,
 * jumpstream and stream and 2.5% of stamina (dense long-jack files that read
 * both ways); corpus-wide 3.5% of charts move. The override MOVES the clear
 * out of its argmax tile rather than adding it, so the four buckets stay
 * disjoint and their clear counts still sum to the side's total.
 *
 * 6K/7K cannot use it: that calc engine does not rate Technical at all
 * (it returns ~0, so Technical never wins an argmax there) and the distribution
 * collapses onto Handstream. Those keymodes fall back to the in-house chart
 * pattern tags, where they overlap - a chart tagged chordjack+tech backs both
 * dans. Their tag lists are narrow on purpose, because the analyzer emits two
 * nearly disjoint vocabularies: 6K/7K rice fires tech / chordstream / delay /
 * chordjack / bracket and never fires jack, jumpstream, quadstream, handjack,
 * speedjack, handstream or stream. Re-measure before moving a tag, and check
 * it fires on that keymode at all.
 *
 * LN is one skill everywhere except 7K, whose scene does name the four
 * subtypes and whose charts are the only ones the analyzer separates them on
 * in any volume. Those keymodes get no buckets at all: a single whole-LN row
 * would only restate the estimate the window already leads with.
 */
function danSkillsetBuckets(keyCount: number, side: "rc" | "ln"): DanSkillsetBucket[] {
  if (side === "ln") {
    if (keyCount === 7) {
      return [
        { id: "lngeneral", tags: ["lngeneral", "ln"] },
        { id: "lntech", tags: ["lntech"] },
        { id: "lninverse", tags: ["lninverse"] },
        { id: "lnrelease", tags: ["lnrelease"] },
      ];
    }
    return [];
  }
  if (keyCount === 4) {
    return [
      // The jack tile's tags are the analyzer override (see bucketsForClear):
      // a chart wearing either tag files here regardless of the MSD argmax.
      { id: "jack", tags: ["chordjack", "speedjack"], skillsets: ["JackSpeed", "Chordjack"] },
      { id: "tech", tags: [], skillsets: ["Technical", "Jumpstream"] },
      { id: "speed", tags: [], skillsets: ["Stream"] },
      { id: "stamina", tags: [], skillsets: ["Handstream", "Stamina"] },
    ];
  }
  return [
    // Jack and stream read LeoBlack's clusters rather than their tags; `tags`
    // stays as the fallback for the ~1% of charts with no clusters stored
    // (the derived jack tag covers those via its chordjack-score arm).
    { id: "jack", tags: ["jack"], clusterFamily: "jack" },
    { id: "tech", tags: ["tech"], clusterFamily: "tech" },
    { id: "speed", tags: ["delay"] },
    { id: "stream", tags: ["chordstream", "bracket"], clusterFamily: "stream" },
  ];
}

/** The bucket ids a keymode/side publishes, in declaration order. */
export function danSkillsetBucketIds(keyCount: number, side: "rc" | "ln"): string[] {
  return danSkillsetBuckets(keyCount, side).map((bucket) => bucket.id);
}

/**
 * The buckets one clear belongs to. MSD-bucketed keymodes (4K) file by the
 * play's argmax skillset, except that a chart wearing one of a bucket's own
 * analyzer tags files there outright (the jack tile's speedjack correction;
 * danSkillsetBuckets has the measurements). The override replaces the argmax
 * verdict rather than adding to it, so those buckets stay disjoint. Tag
 * keymodes (6K/7K) file by chartBelongsToTagBucket alone, overlapping by
 * design.
 */
function bucketsForClear(
  buckets: DanSkillsetBucket[],
  topSkillset: string | null,
  chart: ChartSkillInfo | undefined,
): DanSkillsetBucket[] {
  const override = buckets.find(
    (bucket) => bucket.skillsets != null && bucket.tags.length > 0 && chartBelongsToTagBucket(bucket, chart),
  );
  if (override != null) return [override];
  return buckets.filter((bucket) => bucket.skillsets
    ? topSkillset != null && bucket.skillsets.includes(topSkillset)
    : chartBelongsToTagBucket(bucket, chart));
}

/**
 * The side's clears filed into their skillset buckets, one entry per bucket the
 * keymode publishes (empty lists included). Shared by the stored verdict and the
 * on-demand evidence window so "your jack dan" is the same number on the
 * leaderboard and in the window that explains it.
 */
function groupDanClearsBySkillset(
  keyCount: number,
  side: "rc" | "ln",
  clears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
): Map<string, DanClearEvidence[]> {
  const buckets = danSkillsetBuckets(keyCount, side);
  const bySkillset = new Map<string, DanClearEvidence[]>();
  for (const bucket of buckets) bySkillset.set(bucket.id, []);
  for (const clear of clears) {
    const chart = infoByBeatmap.get(clear.play.beatmapId);
    const topSkillset = bucketingSkillset(clear.play.values, chart?.lengthSeconds ?? null, clear.play.rate);
    for (const bucket of bucketsForClear(buckets, topSkillset, chart)) {
      bySkillset.get(bucket.id)!.push(clear);
    }
  }
  return bySkillset;
}

/**
 * The qualifying clears behind one side of a player's dan estimate, plus the
 * skillset dans that estimate is the mean of ("your jack dan" = the dan the
 * jack charts you clear demonstrate, under the quorum rule).
 *
 * Recomputed on read from the same durable per-play cache and clear rules the
 * stored verdict used (collectDanClears), so it explains the number rather
 * than shipping a second one; chart-analysis rows refreshed since the last
 * compute can drift it slightly until the next recompute picks them up.
 */
// How many missing rate verdicts one evidence read may queue: enough to cover
// a session's worth of custom-rate clears, few enough that a modal open stays
// a handful of dedupe-keyed inserts.
const DAN_EVIDENCE_VERDICT_ENQUEUES = 16;

export async function getPlayerSkillDanEvidence(
  db: Db,
  userId: number,
  keyCount: number,
  side: "rc" | "ln",
  queue: JobQueue | null = null,
): Promise<PlayerSkillDanEvidence | null> {
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(keyCount) || keyCount <= 0) return null;
  const row = (await exec(
    db,
    `select status, plays_json from player_skill_ratings
     where user_id = ? and analysis_version = ?`,
    [userId, PLAYER_SKILLS_VERSION],
  )).rows[0];
  if (String(row?.status ?? "") !== "ready") return null;
  const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row?.plays_json ?? ""), null);
  const plays = (Array.isArray(stored?.plays) ? stored.plays : [])
    .filter((play) => play && play.keyCount === keyCount && Number.isInteger(play.beatmapId) && play.beatmapId > 0);
  const infoByBeatmap = await loadChartSkillInfo(db, plays.map((play) => play.beatmapId));
  const rateVerdicts = await loadRateVerdictCredits(db, plays);
  // Verdicts missing for stored plays heal on view: the compute job fills its
  // own, but a player nobody recomputes (or plays rated before the credit
  // existed) would otherwise wait forever. The job key dedupes repeat opens.
  if (queue) {
    for (const pair of missingRateVerdictPairs(plays, infoByBeatmap, rateVerdicts).slice(0, DAN_EVIDENCE_VERDICT_ENQUEUES)) {
      await enqueueRateDanEstimate(queue, pair.beatmapId, pair.ratePercent).catch(() => {});
    }
  }
  const clears = collectDanClears(keyCount, plays, new Map(), infoByBeatmap, rateVerdicts)
    .filter((clear) => clear.side === side)
    .sort((left, right) =>
      right.creditedDan - left.creditedDan
      || String(right.play.endedAt ?? "").localeCompare(String(left.play.endedAt ?? ""))
      || left.play.beatmapId - right.play.beatmapId);
  const courseClears = await loadPlayerDanCourseClears(db, userId);
  const dan = danSideFromClears(keyCount, side, clears, infoByBeatmap, courseClears);
  // Everything at or above the estimate "backs" it, matching the stored
  // verdict's clears count.
  const threshold = dan ? dan.rawDan - DAN_ROUNDING_EPSILON : null;

  // Skillset grouping, by bucket rather than by raw analyzer tag: the tag
  // vocabulary is 18 ids deep and a player reads their dan through the four
  // skills their scene actually names (DAN_SKILLSET_BUCKETS). The dans come
  // off `dan.skillsets` rather than being recomputed here, because they are
  // the terms the headline averaged - deriving them twice invites the window
  // to explain a number it did not produce.
  const buckets = danSkillsetBuckets(keyCount, side);
  const bySkillset = groupDanClearsBySkillset(keyCount, side, clears, infoByBeatmap);

  const topClears = clears.slice(0, DAN_EVIDENCE_MAX_CLEARS);
  const courseSource = dan?.courseClear ? bestDanCourseClear(courseClears, keyCount, side) : null;
  const evidenceBeatmapIds = [
    ...(courseSource ? [courseSource.beatmapId] : []),
    ...topClears.map((clear) => clear.play.beatmapId),
    ...[...bySkillset.values()].flatMap((list) => list.slice(0, DAN_EVIDENCE_SKILLSET_PLAYS).map((clear) => clear.play.beatmapId)),
  ];
  const metadata = await readPlayerSkillPlayMetadata(db, evidenceBeatmapIds);
  const toEvidencePlay = (clear: DanClearEvidence): PlayerSkillDanEvidencePlay => ({
    play: buildPlayerSkillPlay(clear.play, Number(clear.play.values?.Overall ?? 0), keyCount, metadata),
    chartDan: Math.round(clear.chartDan * 100) / 100,
    chartDanLabel: chartDanLabelFor(clear.chartDan, side, keyCount),
    creditedDan: Math.round(clear.creditedDan * 100) / 100,
    creditedDanLabel: danLabelFor(clear.creditedDan, side, keyCount),
    clearAccuracy: clear.accuracy,
    countsTowardDan: threshold != null && clear.creditedDan >= threshold,
  });

  // Emitted in bucket-declaration order; the client ranks them for display.
  const skillsets = buckets
    .map((bucket): PlayerSkillDanSkillsetEvidence => {
      const list = bySkillset.get(bucket.id)!;
      const skillsetDan = dan?.skillsets?.[bucket.id] ?? null;
      return {
        id: bucket.id,
        clears: list.length,
        dan: skillsetDan ? { rawDan: skillsetDan.rawDan, label: skillsetDan.label } : null,
        plays: list.slice(0, DAN_EVIDENCE_SKILLSET_PLAYS).map(toEvidencePlay),
      };
    })
    .filter((skillset) => skillset.clears > 0);

  const barAccuracy = danClearBarFor(side, keyCount).accuracy;
  return {
    side,
    keyCount,
    quorum: DAN_CLEAR_QUORUM,
    minAccuracy: Math.round((barAccuracy - danCreditBelowBarWindowFor(side, keyCount)) * 1000) / 1000,
    barAccuracy,
    dan,
    totalClears: clears.length,
    clears: topClears.map(toEvidencePlay),
    skillsets,
    courseClear: courseSource ? toCourseEvidence(courseSource, side, keyCount, metadata) : null,
  };
}

function toCourseEvidence(
  clear: DanCourseClear,
  side: "rc" | "ln",
  keyCount: number,
  metadata: Map<number, PlayerSkillPlayMetadata>,
): PlayerSkillDanCourseEvidence {
  const map = metadata.get(clear.beatmapId);
  return {
    beatmapId: clear.beatmapId,
    beatmapsetId: map?.beatmapsetId ?? null,
    courseName: clear.courseName,
    title: map?.title ?? clear.courseName,
    artist: map?.artist ?? "",
    version: map?.version ?? "",
    level: clear.level,
    rawDan: clear.rawDan,
    label: danLabelFor(clear.rawDan, side, keyCount),
    accuracy: clear.accuracy,
    currency: clear.currency,
    bar: clear.bar,
    displayedAccuracy: clear.displayedAccuracy,
    beatmapStatus: clear.beatmapStatus,
    scoreId: clear.play.scoreId,
    soloScoreId: clear.play.soloScoreId,
    legacyScoreId: clear.play.legacyScoreId,
    mods: getModAcronyms(clear.play.mods, false),
    statistics: clear.play.statistics ?? null,
    maxCombo: clear.play.maxCombo,
    totalScore: clear.play.totalScore,
    rank: clear.play.rank,
    playedAt: clear.play.playedAt,
    hasReplay: clear.play.hasReplay,
    isLazer: clear.play.isLazer,
  };
}

// How far under the winning skillset Stream may sit and still call the chart a
// stream chart. See danSkillsetBuckets for the two packs this is measured on.
//
// 1.25 rather than 1.0 because MinaCalc splits a dense stream chart's rating
// across Stream, Stamina, Technical and Jumpstream at once, so a hard argmax
// hands it to whichever edges ahead by hundredths. ETERNAL DRAIN [4K Eternal]
// is the measured case: Jumpstream 26.36 over Stream 25.24, a 1.12 gap that
// the old band missed by twelve hundredths on a chart players call speed.
//
// The cost is real and was measured across 4K practice packs: widening 1.0 ->
// 1.25 moves the speed corpus (975 charts) from 85% to 86% and the tech corpus
// (279) from 44% to 49% speed-tiled, so it buys one point of recall for five of
// tech precision. Taken because the charts in that band ARE the near-ties the
// rule exists for, and a chart at a 1.12 gap reading as speed is the labelled
// evidence. Jack (3020) and stamina (489) do not move.
//
// Do not widen further without new labels: at 2.0 the tech corpus reaches 62%
// and Blastix Riotz [Jinjin's INFINITE] (1.60 gap) flips, which contradicts the
// labels this bucketing was built from. At 1.25 every Blastix diff stays tech.
const SPEED_NEAR_TIE_MSD = 1.25;

// MinaCalc's Stamina is a rider rather than a detector: it tracks the strongest
// base skillset sustained and the calc clamps it a hair above that base. Over
// every 4K chart in the corpus with MSD, a Stamina argmax win never exceeds the
// best base skillset by more than 0.45%, so the win reports length, not
// identity - Infectious Crying (5066729), a self-described tech dump, files
// under Stamina 32.81 against Technical 32.66. A clear only demonstrates
// endurance when the file actually asks for it, so a Stamina win keeps the tile
// only at 4:00 or longer (the same bar and the same reasoning as
// STAMINA_PRIMARY_MIN_LENGTH_SECONDS on the /maps shelf, kept as its own
// constant rather than imported so the player layer does not depend on the map
// index). Everything shorter files under its best base skillset instead.
//
// Measured over 42,836 rated 4K plays: the stamina tile goes from 24.9% of
// plays to 18.7% (tech 60.8% -> 66.8%, speed and jack unmoved), and 70% of
// players keep four stamina clears and therefore a rated tile. Handstream-led
// clears are untouched - they name a pattern, so they hold the tile at any
// length.
const STAMINA_TILE_MIN_LENGTH_SECONDS = 240;

// The base skillsets, i.e. everything the stamina rider rides on top of.
const BASE_MSD_SKILLSETS = SKILL_RATING_SKILLSETS.filter(
  (skillset) => skillset !== "Overall" && skillset !== "Stamina",
);

/**
 * The skillset a play is filed under, which is its strongest EXCEPT that Stream
 * wins from within SPEED_NEAR_TIE_MSD of the top and that Stamina has to earn
 * it on length. Still single-valued, so the tiles stay disjoint and their clear
 * counts sum to the side's total.
 *
 * `lengthSeconds` is the chart's drain at 1.0x and `rate` the speed it was
 * played at, so a 1.5x run of a five-minute chart is judged on the 3:20 it
 * actually lasted. An unknown length leaves the old behaviour rather than
 * guessing a chart short.
 */
function bucketingSkillset(
  values: Record<string, number> | undefined,
  lengthSeconds: number | null = null,
  rate = 1,
): string | null {
  const top = dominantSkillset(values);
  if (top == null || top === "Stream") return top;
  const stream = Number(values?.Stream ?? 0);
  const best = Number(values?.[top] ?? 0);
  const nearTie = stream > 0 && stream >= best - SPEED_NEAR_TIE_MSD ? "Stream" : top;
  if (nearTie !== "Stamina" || lengthSeconds == null) return nearTie;
  const playedSeconds = lengthSeconds / (Number.isFinite(rate) && rate > 0 ? rate : 1);
  if (playedSeconds >= STAMINA_TILE_MIN_LENGTH_SECONDS) return nearTie;
  return bucketingSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS));
}

/** A copy of an SSR vector holding only the named skillsets. */
function pickSkillsets(values: Record<string, number> | undefined, keep: string[]): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const skillset of keep) {
    const value = Number(values?.[skillset] ?? 0);
    if (Number.isFinite(value) && value > 0) picked[skillset] = value;
  }
  return picked;
}

/**
 * Which dan-evidence skillset tiles a play's SSR vector belongs to. Test seam
 * over the same walk getPlayerSkillDanEvidence does, so the speed/tech split
 * and the jack override can be checked against real MSD vectors without
 * seeding a whole ratings row. `chart` carries the stored analysis; omitted,
 * only the MSD path runs.
 */
export function danSkillsetBucketsForValues(
  keyCount: number,
  side: "rc" | "ln",
  values: Record<string, number>,
  lengthSeconds: number | null = null,
  rate = 1,
  chart?: ChartSkillInfo,
): string[] {
  const top = bucketingSkillset(values, lengthSeconds, rate);
  return bucketsForClear(danSkillsetBuckets(keyCount, side), top, chart).map((bucket) => bucket.id);
}

/** Drain length in seconds from the beatmap metadata; null when unknown. */
function readLengthSeconds(value: unknown): number | null {
  const seconds = Math.round(Number(value));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The highest non-Overall MSD skillset of a play's SSR vector, if any. */
function dominantSkillset(values: Record<string, number> | undefined): string | null {
  let best: string | null = null;
  let bestValue = 0;
  for (const skillset of SKILL_RATING_SKILLSETS) {
    if (skillset === "Overall") continue;
    const value = Number(values?.[skillset] ?? 0);
    if (Number.isFinite(value) && value > bestValue) {
      best = skillset;
      bestValue = value;
    }
  }
  return best;
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
  const { beyondTable: _stored, ...rest } = side;
  return {
    ...rest,
    label: danLabelFor(side.rawDan, family, keyCount),
    ...(isBeyondDanTable(side.rawDan, family, keyCount) ? { beyondTable: true } : {}),
  };
}

// One-shot sweep for the leftovers of the 2026-08-14 MinaCalc poisoning (the
// incident window and the chart-side repair live in chart-analysis.ts, see
// MSD_POISON_WINDOW_START and MSD_POISON_RECOVERY_JOB).
//
// Why a second sweep is needed. The chart repair's seed also deleted player
// rows, but it selected them by time window (updated_at inside the incident),
// and the chart repair itself is chunked: it only finished 2026-08-15T23:17Z.
// Players who recomputed between the seed and that finish re-stored floor
// SSRs against charts that had not been healed yet, stamping an updated_at
// outside the deleted window. The per-play SSR reuse key (beatmapId + rate +
// goal, in the reuse branch of the compute above) carries no chart-health
// term, so every later recompute copies those values forward with a fresh
// computed_at. They never expire on their own.
//
// So this sweep targets the stored signature rather than a time window, which
// is precisely what the window missed.
//
// Poisoned plays are dropped from plays_json instead of the whole row being
// deleted: the per-play SSR cache is the durable record for plays whose score
// payload has aged out of the score_events retention window, so deleting a
// row would permanently lose the good plays alongside the bad. Dropping only
// the bad ones and backdating computed_at past READY_RECOMPUTE_TTL_MS makes
// the row read as stale, and the next profile view re-rates exactly the
// dropped plays against the healed charts.
export const PLAYER_SKILL_POISON_JOB = "recompute_player_skill_poison_sweep";
const PLAYER_SKILL_POISON_META_KEY = "player_skill_poison_recovery_done:v1";
const PLAYER_SKILL_POISON_CHUNK = 200;

// The same floor signature the chart sweep keys on (msdPoisonSignatureSql in
// chart-analysis.ts): a frozen wasm instance hands back one value for every
// skillset, so a positive Stream equal to both Technical and Chordjack is not
// a rating any real chart produces.
const PLAYER_SKILL_POISON_SIGNATURE_SQL = `exists (
  select 1 from json_each(json_extract(plays_json, '$.plays')) as play
  where json_extract(play.value, '$.values.Stream') > 0
    and json_extract(play.value, '$.values.Stream') = json_extract(play.value, '$.values.Technical')
    and json_extract(play.value, '$.values.Stream') = json_extract(play.value, '$.values.Chordjack')
)`;

export function isPoisonedPlayValues(values: Record<string, number> | undefined | null): boolean {
  const stream = Number(values?.Stream ?? 0);
  return stream > 0
    && stream === Number(values?.Technical ?? 0)
    && stream === Number(values?.Chordjack ?? 0);
}

export interface PlayerSkillPoisonChunkResult {
  nextCursor: number;
  scanned: number;
  cleaned: number[];
  droppedPlays: number;
  done: boolean;
}

export async function recomputePlayerSkillPoisonChunk(
  db: Db,
  cursor: number,
  limit = PLAYER_SKILL_POISON_CHUNK,
): Promise<PlayerSkillPoisonChunkResult> {
  const rows = (await exec(
    db,
    `select user_id, analysis_version, plays_json from player_skill_ratings
     where user_id > ? and ${PLAYER_SKILL_POISON_SIGNATURE_SQL}
     order by user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const cleaned: number[] = [];
  let droppedPlays = 0;
  // Far enough past the ready-row TTL that the next read enqueues a recompute,
  // but still a plausible timestamp: the value is surfaced as computedAt, and
  // an epoch date would render as a decade-old rating until the refresh lands.
  const staleComputedAt = new Date(Date.now() - READY_RECOMPUTE_TTL_MS - 60_000).toISOString();

  for (const row of rows) {
    const userId = Number(row.user_id);
    nextCursor = Math.max(nextCursor, userId);
    const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row.plays_json ?? ""), null);
    const plays = Array.isArray(stored?.plays) ? stored.plays : [];
    const kept = plays.filter((play) => !isPoisonedPlayValues(play?.values));
    const dropped = plays.length - kept.length;
    // The SQL signature already selected this row, so a zero here means the
    // JSON shape drifted from what the predicate matched; leave it alone
    // rather than rewriting a row we did not understand.
    if (dropped <= 0) continue;
    droppedPlays += dropped;
    cleaned.push(userId);
    await exec(
      db,
      `update player_skill_ratings
       set plays_json = json(?), computed_at = ?, updated_at = ?
       where user_id = ? and analysis_version = ?`,
      [json({ ...(stored ?? {}), plays: kept }), staleComputedAt, nowIso(), userId, Number(row.analysis_version)],
    );
  }

  return { nextCursor, scanned: rows.length, cleaned, droppedPlays, done: rows.length < limit };
}

export async function ensurePlayerSkillPoisonRecoverySeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [PLAYER_SKILL_POISON_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [PLAYER_SKILL_POISON_JOB],
  )).rows[0];
  if (pending) return;
  await enqueuePlayerSkillPoisonRecovery(queue, 0);
}

export async function runPlayerSkillPoisonRecoveryJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputePlayerSkillPoisonChunk(db, cursor);
  if (result.droppedPlays > 0) {
    logInfo("player_skill_poison_stripped", { users: result.cleaned.length, plays: result.droppedPlays });
  }
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [PLAYER_SKILL_POISON_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueuePlayerSkillPoisonRecovery(queue, result.nextCursor);
}

async function enqueuePlayerSkillPoisonRecovery(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILL_POISON_JOB,
    `${PLAYER_SKILL_POISON_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep behind the MinaCalc skill-cap lift (40 -> 100, the
// 2026-08-24 leoblack re-pin): the old engine clamped every per-skillset SSR
// at exactly 40, so a stored play holding any skillset at 40 is the clamp
// showing, not a rating. Below the clamp the patched engine is bit-identical,
// which is why this is a targeted purge rather than a PLAYER_SKILLS_VERSION
// bump: only pinned plays are stale. Same shape as the poison sweep above -
// drop exactly the pinned plays, backdate computed_at past the ready TTL, and
// the next profile view re-rates just those plays on the lifted engine (the
// per-play reuse key carries no engine term, so they would otherwise be
// copied forward on every recompute and never expire).
export const PLAYER_SKILL_MSD_CAP_JOB = "recompute_player_skill_msd_cap_sweep";
const PLAYER_SKILL_MSD_CAP_META_KEY = "player_skill_msd_cap_sweep_done:v1";
const PLAYER_SKILL_MSD_CAP_CHUNK = 200;

const SSR_CAP_PIN = 40;

// Any of the eight stored skillset values sitting at exactly the old clamp.
const PLAYER_SKILL_MSD_CAP_SIGNATURE_SQL = `exists (
  select 1
  from json_each(json_extract(plays_json, '$.plays')) as play,
       json_each(json_extract(play.value, '$.values')) as skill
  where skill.value = ${SSR_CAP_PIN}
)`;

export function isCapPinnedPlayValues(values: Record<string, number> | undefined | null): boolean {
  if (!values || typeof values !== "object") return false;
  return Object.values(values).some((value) => Number(value) === SSR_CAP_PIN);
}

export interface PlayerSkillMsdCapChunkResult {
  nextCursor: number;
  scanned: number;
  cleaned: number[];
  droppedPlays: number;
  done: boolean;
}

export async function recomputePlayerSkillMsdCapChunk(
  db: Db,
  cursor: number,
  limit = PLAYER_SKILL_MSD_CAP_CHUNK,
): Promise<PlayerSkillMsdCapChunkResult> {
  const rows = (await exec(
    db,
    `select user_id, analysis_version, plays_json from player_skill_ratings
     where user_id > ? and ${PLAYER_SKILL_MSD_CAP_SIGNATURE_SQL}
     order by user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const cleaned: number[] = [];
  let droppedPlays = 0;
  const staleComputedAt = new Date(Date.now() - READY_RECOMPUTE_TTL_MS - 60_000).toISOString();

  for (const row of rows) {
    const userId = Number(row.user_id);
    nextCursor = Math.max(nextCursor, userId);
    const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row.plays_json ?? ""), null);
    const plays = Array.isArray(stored?.plays) ? stored.plays : [];
    const kept = plays.filter((play) => !isCapPinnedPlayValues(play?.values));
    const dropped = plays.length - kept.length;
    // The SQL signature already selected this row, so a zero here means the
    // JSON shape drifted from what the predicate matched; leave it alone
    // rather than rewriting a row we did not understand.
    if (dropped <= 0) continue;
    droppedPlays += dropped;
    cleaned.push(userId);
    await exec(
      db,
      `update player_skill_ratings
       set plays_json = json(?), computed_at = ?, updated_at = ?
       where user_id = ? and analysis_version = ?`,
      [json({ ...(stored ?? {}), plays: kept }), staleComputedAt, nowIso(), userId, Number(row.analysis_version)],
    );
  }

  return { nextCursor, scanned: rows.length, cleaned, droppedPlays, done: rows.length < limit };
}

export async function ensurePlayerSkillMsdCapSweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [PLAYER_SKILL_MSD_CAP_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [PLAYER_SKILL_MSD_CAP_JOB],
  )).rows[0];
  if (pending) return;
  await enqueuePlayerSkillMsdCapSweep(queue, 0);
}

export async function runPlayerSkillMsdCapSweepJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputePlayerSkillMsdCapChunk(db, cursor);
  if (result.droppedPlays > 0) {
    logInfo("player_skill_msd_cap_stripped", { users: result.cleaned.length, plays: result.droppedPlays });
  }
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [PLAYER_SKILL_MSD_CAP_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueuePlayerSkillMsdCapSweep(queue, result.nextCursor);
}

async function enqueuePlayerSkillMsdCapSweep(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILL_MSD_CAP_JOB,
    `${PLAYER_SKILL_MSD_CAP_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep behind the course-rule dan bars: the clear rules and the
// credit changed, but nothing about how a play is RATED did, so every stored
// row already holds everything the new verdict needs. This rewrites just the
// dan block of modes_json from plays_json and leaves the SSRs, the ratings and
// computed_at untouched - a PLAYER_SKILLS_VERSION bump would have been correct
// too, and also thrown away the per-play SSR cache for the whole corpus and
// re-run MinaCalc over every rated play to land the same numbers.
//
// One caveat rides along: stored plays predate scoreV2Accuracy, so the 4K LN
// bar falls back to STABLE_EQUIVALENT_V2_BAR_OFFSET for stable submissions
// until each row next recomputes on its own. Lazer plays and every other
// ladder are exact from the stored fields.
//
// It carries the per-skillset verdicts too, on the same argument: they are the
// side's own clears re-counted per bucket, so a stored row already holds
// everything they need. Without this sweep they would only ever appear on rows
// that recompute for some other reason, which is nobody inactive.
export const PLAYER_SKILL_DAN_SWEEP_JOB = "recompute_player_skill_dan_sweep";
// v2: the side headline became the mean of the skillset dans rather than the
// quorum-th clear, so every stored verdict is stale and the sweep runs again.
// v3: a verified dan course clear now floors the headline, which no stored row
// has ever been asked about. It re-derives from plays_json plus the two course
// lookups without re-rating, so this costs no MinaCalc.
// v4: custom-rate clears now credit the dan_estimates verdict at the play's
// own rate, and stored rows hold plays at rates no stored verdict ever
// covered. The sweep reads whatever verdicts exist (months of map-page rate
// lookups) and computes none; the rest fill in on demand and land on each
// player's next recompute.
// v5: a dan became the mean of the best DAN_CLEAR_AVERAGE_WINDOW clears
// rather than the quorum-th clear alone, so every stored verdict is stale
// again. Same re-derive from plays_json, no MinaCalc.
// v6: the stamina tile now has to earn a Stamina argmax on length
// (STAMINA_TILE_MIN_LENGTH_SECONDS), which moves clears between skillset
// tiles and so moves the per-tile dans and the headline they average.
// v6: a clear's credit now moves with its accuracy (bonus above the ladder's
// bar, decay down to the credit window under it, dan-credit.ts), so every
// stored verdict is stale again. Same re-derive from plays_json plus the
// stored rate verdicts, no MinaCalc. Until the sweep rewrites a row, the
// badge and leaderboard show the old number while the evidence modal (which
// recomputes live) already shows the new one; that skew existed for v5 too,
// it is just wider here.
// v7: the 4K LN ladder cooled off - its bonus now scores against the decay
// window rather than its 2.5-3 point headroom, and its near-bar cap deepened
// to 0.75 (dan-credit.ts has the measurement). Every other ladder's numbers
// are unchanged, but the stored 4K LN verdicts are stale.
// v8: a confident analyzer speedjack/chordjack tag now overrides MinaCalc's
// 4K argmax into the jack tile. That moves clears between skillset verdicts
// and can move the headline average, so all stored verdicts are stale.
// v9: charts with exploit-sized same-column head stacks are structurally
// ineligible as dan evidence. The chart verdict remains visible, but every
// stored player dan must be rebuilt without those clears.
// v10: the LN decay window narrowed from four accuracy points to one
// (danCreditBelowBarWindowFor), dropping the routine sub-bar passes that
// still dominated the LN best-5 windows after the v7 bonus cool-off, and
// 4K LN now averages its best ten clears rather than five
// (danClearAverageWindowFor), asking its bucket-less headline for a body of
// work. parseLnDan also picked up parseDan's variant bands, so
// stored 4K LN labels move too (a 13.6 average now prints "14-", not "14").
// Only LN verdicts move, but the sweep rewrites the row's whole dan block as
// always.
const PLAYER_SKILL_DAN_SWEEP_META_KEY = "player_skill_dan_sweep_done:v10";
const PLAYER_SKILL_DAN_SWEEP_CHUNK = 200;
// A live-sized chunk carries tens of thousands of cached plays. Parsing all 200
// plays_json blobs in one turn cost ~50ms before the chart lookup even began;
// breathe between small groups just as the chart lookup does between id groups.
const PLAYER_SKILL_DAN_SWEEP_PARSE_YIELD = 25;

export interface PlayerSkillDanSweepChunkResult {
  nextCursor: number;
  scanned: number;
  rewritten: number;
  done: boolean;
}

export async function recomputePlayerSkillDanChunk(
  db: Db,
  cursor: number,
  limit = PLAYER_SKILL_DAN_SWEEP_CHUNK,
): Promise<PlayerSkillDanSweepChunkResult> {
  const rows = (await exec(
    db,
    `select user_id, modes_json, plays_json, updated_at from player_skill_ratings
     where user_id > ? and analysis_version = ? and status = 'ready'
     order by user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), PLAYER_SKILLS_VERSION, Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  let rewritten = 0;
  const parsed: Array<{ userId: number; summary: StoredModesSummary; plays: StoredPlaySsr[]; readAt: string }> = [];
  const beatmapIds: number[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex > 0 && rowIndex % PLAYER_SKILL_DAN_SWEEP_PARSE_YIELD === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const row = rows[rowIndex];
    const userId = Number(row.user_id);
    nextCursor = Math.max(nextCursor, userId);
    const summary = parseJson<StoredModesSummary | null>(String(row.modes_json ?? ""), null);
    const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row.plays_json ?? ""), null);
    const plays = (Array.isArray(stored?.plays) ? stored.plays : [])
      .filter((play) => play && Number.isInteger(play.beatmapId) && play.beatmapId > 0);
    if (!summary || !Array.isArray(summary.modes) || summary.modes.length === 0 || plays.length === 0) continue;
    parsed.push({ userId, summary, plays, readAt: String(row.updated_at ?? "") });
    for (const play of plays) beatmapIds.push(play.beatmapId);
  }
  // One chart lookup for the whole chunk: the corpus reuses charts heavily, so
  // per-user queries would re-read the same rows a few hundred times over.
  const infoByBeatmap = await loadChartSkillInfo(db, beatmapIds);
  const rateVerdicts = await loadRateVerdictCredits(db, parsed.flatMap((entry) => entry.plays));

  for (const { userId, summary, plays, readAt } of parsed) {
    // Course clears do not live in plays_json (that pool is deduped, capped
    // and mod-blind on old archived rows), so the sweep reads them the same
    // way the compute does. Two indexed point lookups per user, no MinaCalc.
    const courseClears = await loadPlayerDanCourseClears(db, userId);
    // computeModeDan takes one keymode's plays, not the whole pool: the clear
    // rules read the chart's verdict rather than the play's keyCount, so an
    // unfiltered pool would credit every keymode with every other one's clears.
    const playsByKeyCount = new Map<number, StoredPlaySsr[]>();
    for (const play of plays) {
      const list = playsByKeyCount.get(play.keyCount);
      if (list) list.push(play);
      else playsByKeyCount.set(play.keyCount, [play]);
    }
    const modes = summary.modes.map((mode) => ({
      ...mode,
      dan: computeModeDan(mode.keyCount, playsByKeyCount.get(mode.keyCount) ?? [], new Map(), infoByBeatmap, courseClears, rateVerdicts),
    }));
    // The chart lookup above sits between the read and this write, and a
    // normal skill computation runs in another lane - so the row can have been
    // rewritten in the meantime. Without the updated_at guard this would put
    // the summary we read back over a fresh one while its plays_json and
    // computed_at stayed new, hiding the mismatch for the full 12h TTL. Zero
    // rows changed means that recompute already wrote the skillset verdicts
    // itself, so there is nothing here to redo.
    const written = await exec(
      db,
      `update player_skill_ratings
       set modes_json = json(?), updated_at = ?
       where user_id = ? and analysis_version = ? and updated_at = ?`,
      [json({ ...summary, modes }), nowIso(), userId, PLAYER_SKILLS_VERSION, readAt],
    );
    if (Number(written.rowsAffected ?? 0) > 0) rewritten += 1;
  }

  return { nextCursor, scanned: rows.length, rewritten, done: rows.length < limit };
}

export async function ensurePlayerSkillDanSweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select value_json from live_meta where key = ? limit 1", [PLAYER_SKILL_DAN_SWEEP_META_KEY])).rows[0];
  // A finished sweep still has to run again if a rate-verdict repair landed
  // after it: those stored dans either had nothing to credit an HT clear
  // against or read the stale DT rawDan the Sunny v2 sweep replaced.
  if (done && !(await rateVerdictsLandedAfter(db, String(done.value_json ?? "")))) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [PLAYER_SKILL_DAN_SWEEP_JOB],
  )).rows[0];
  if (pending) return;
  await enqueuePlayerSkillDanSweep(queue, 0);
}

/** True when a rate-verdict producer stamped its done key after this dan pass began. */
async function rateVerdictsLandedAfter(db: Db, doneJson: string): Promise<boolean> {
  const sweptAt = parseJson<{ finishedAt?: unknown }>(doneJson, {}).finishedAt;
  for (const key of [HT_RATE_ANALYSIS_META_KEY, SUNNY_REPIN_DT_META_KEY]) {
    const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [key])).rows[0];
    if (!row) continue;
    const landedAt = parseJson<{ finishedAt?: unknown }>(String(row.value_json ?? ""), {}).finishedAt;
    if (typeof landedAt === "string" && (typeof sweptAt !== "string" || landedAt > sweptAt)) return true;
  }
  return false;
}

export async function runPlayerSkillDanSweepJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number; startedAt?: string } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  // Carried from the first chunk so the done key can be stamped with when the
  // sweep began reading, not when it stopped: see below.
  const startedAt = typeof payload?.startedAt === "string" ? payload.startedAt : nowIso();
  const result = await recomputePlayerSkillDanChunk(db, cursor);
  if (result.rewritten > 0) {
    logInfo("player_skill_dan_sweep_chunk", { users: result.rewritten, cursor: result.nextCursor });
  }
  if (result.done) {
    // The done key records the START of the pass, because
    // rateVerdictsLandedAfter compares against it to decide whether a finished
    // sweep is stale. These sweeps share one claimLimit:1 lane and self-chain
    // a chunk at a time, so they interleave: HT or the Sunny DT repair can
    // stamp its done key while this pass is midway through. Stamping the finish
    // time would call the already-written rows current and strand them.
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [PLAYER_SKILL_DAN_SWEEP_META_KEY, json({ finishedAt: startedAt }), nowIso()],
    );
    // A producer that finished while this pass was in flight may have called
    // the public seeder while one of our continuation jobs was still queued.
    // That correctly no-ops to avoid duplicate passes, so close the race here:
    // enqueue directly after the final chunk, using a fresh startedAt for the
    // follow-up pass. The restart gets its own stable dedupe key because a
    // small corpus can finish on the still-running cursor-0 job, which the
    // queue deliberately refuses to replace from inside itself.
    if (await rateVerdictsLandedAfter(db, json({ finishedAt: startedAt }))) {
      await enqueuePlayerSkillDanSweep(queue, 0, undefined, true);
    }
    return;
  }
  await enqueuePlayerSkillDanSweep(queue, result.nextCursor, startedAt);
}

async function enqueuePlayerSkillDanSweep(
  queue: JobQueue,
  cursor: number,
  startedAt?: string,
  rateVerdictRestart = false,
): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILL_DAN_SWEEP_JOB,
    rateVerdictRestart ? `${PLAYER_SKILL_DAN_SWEEP_JOB}:rate-verdict-restart` : `${PLAYER_SKILL_DAN_SWEEP_JOB}:${cursor}`,
    { cursor, startedAt: startedAt ?? nowIso() },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep behind the 6K/7K jack re-tag (the chart-side
// JACK_TAG_RECOMPUTE_JOB): a mode's pattern ratings are folded from stored
// plays against whatever chart tags existed at compute time, and a stored row
// otherwise refreshes only when a profile view or a new top play triggers a
// recompute - which is nobody inactive, so the population would take weeks to
// grow enough jack entries for the baseline to mint a pattern:jack percentile
// curve. This rewrites just the patterns block of modes_json from plays_json
// plus a fresh tag lookup - no MinaCalc, no osu! API, the dan sweep's shape.
// Seeded only once the chart sweep stamps done, so it folds final tags rather
// than a moving set; on its own finishing chunk the dispatcher forces a
// skill-baseline rebuild so the percentile curves learn the new axis in the
// same rollout instead of at the next weekly refresh.
export const PLAYER_SKILL_PATTERN_SWEEP_JOB = "recompute_player_skill_pattern_sweep";
// Exported for the skill-baseline due-check: curves computed before this
// stamp cannot carry the refolded axes and read as stale.
export const PLAYER_SKILL_PATTERN_SWEEP_META_KEY = "player_skill_pattern_sweep_done:v1";
const PLAYER_SKILL_PATTERN_SWEEP_CHUNK = 200;

export interface PlayerSkillPatternSweepChunkResult {
  nextCursor: number;
  scanned: number;
  rewritten: number;
  done: boolean;
}

export async function recomputePlayerSkillPatternChunk(
  db: Db,
  cursor: number,
  limit = PLAYER_SKILL_PATTERN_SWEEP_CHUNK,
): Promise<PlayerSkillPatternSweepChunkResult> {
  // Only rows with a keymode the re-tag touched: the 4K pipeline is
  // deliberately bit-identical, so pure-4K rows cannot change. The LIKE terms
  // bound the scan on the small modes_json column.
  const rows = (await exec(
    db,
    `select user_id, modes_json, plays_json, updated_at from player_skill_ratings
     where user_id > ? and analysis_version = ? and status = 'ready'
       and (modes_json like '%"keyCount":6%' or modes_json like '%"keyCount":7%')
     order by user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), PLAYER_SKILLS_VERSION, Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  let rewritten = 0;
  const parsed: Array<{ userId: number; summary: StoredModesSummary; plays: StoredPlaySsr[]; readAt: string }> = [];
  const beatmapIds: number[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex > 0 && rowIndex % PLAYER_SKILL_DAN_SWEEP_PARSE_YIELD === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const row = rows[rowIndex];
    const userId = Number(row.user_id);
    nextCursor = Math.max(nextCursor, userId);
    const summary = parseJson<StoredModesSummary | null>(String(row.modes_json ?? ""), null);
    const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row.plays_json ?? ""), null);
    const plays = (Array.isArray(stored?.plays) ? stored.plays : [])
      .filter((play) => play && Number.isInteger(play.beatmapId) && play.beatmapId > 0);
    if (!summary || !Array.isArray(summary.modes) || summary.modes.length === 0 || plays.length === 0) continue;
    parsed.push({ userId, summary, plays, readAt: String(row.updated_at ?? "") });
    for (const play of plays) beatmapIds.push(play.beatmapId);
  }
  const infoByBeatmap = await loadChartSkillInfo(db, beatmapIds);

  for (const { userId, summary, plays, readAt } of parsed) {
    // Same tag policy as the compute: fresh tags where an analysis row
    // exists, the stored ones where it does not (a straggler still waiting on
    // its post-sweep re-analysis heals on the row's next ordinary recompute).
    const playsByKeyCount = new Map<number, StoredPlaySsr[]>();
    for (const play of plays) {
      const info = infoByBeatmap.get(play.beatmapId);
      const refreshed = info ? { ...play, patterns: info.patterns } : play;
      const list = playsByKeyCount.get(play.keyCount);
      if (list) list.push(refreshed);
      else playsByKeyCount.set(play.keyCount, [refreshed]);
    }
    const modes = summary.modes.map((mode) => ({
      ...mode,
      patterns: aggregateModePatternRatings(playsByKeyCount.get(mode.keyCount) ?? []),
    }));
    // Most rows fold to the tags they already hold; skip the no-op writes so
    // the sweep costs reads, not a table-wide rewrite.
    const unchanged = modes.every((mode, index) =>
      json(mode.patterns) === json(summary.modes[index]?.patterns ?? []));
    if (unchanged) continue;
    // updated_at guard, same as the dan sweep: a normal recompute in another
    // lane can rewrite the row between our read and this write, and its fold
    // is fresher than ours.
    const written = await exec(
      db,
      `update player_skill_ratings
       set modes_json = json(?), updated_at = ?
       where user_id = ? and analysis_version = ? and updated_at = ?`,
      [json({ ...summary, modes }), nowIso(), userId, PLAYER_SKILLS_VERSION, readAt],
    );
    if (Number(written.rowsAffected ?? 0) > 0) rewritten += 1;
  }

  return { nextCursor, scanned: rows.length, rewritten, done: rows.length < limit };
}

export async function ensurePlayerSkillPatternSweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  // Folding mid-chart-sweep would bake half-swept tags into stored rows and
  // call the sweep done; wait for the chart side to stamp its marker.
  const chartSweepDone = (await exec(db, "select 1 from live_meta where key = ? limit 1", [JACK_TAG_META_KEY])).rows[0];
  if (!chartSweepDone) return;
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [PLAYER_SKILL_PATTERN_SWEEP_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [PLAYER_SKILL_PATTERN_SWEEP_JOB],
  )).rows[0];
  if (pending) return;
  await enqueuePlayerSkillPatternSweep(queue, 0);
}

/** Returns true on the chunk that finishes the sweep, so the dispatcher can
 * force the skill-baseline rebuild over the refreshed rows. */
export async function runPlayerSkillPatternSweepJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<boolean> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await recomputePlayerSkillPatternChunk(db, cursor);
  if (result.rewritten > 0) {
    logInfo("player_skill_pattern_sweep_chunk", { users: result.rewritten, cursor: result.nextCursor });
  }
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [PLAYER_SKILL_PATTERN_SWEEP_META_KEY, json({ finishedAt: now }), now],
    );
    return true;
  }
  await enqueuePlayerSkillPatternSweep(queue, result.nextCursor);
  return false;
}

async function enqueuePlayerSkillPatternSweep(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILL_PATTERN_SWEEP_JOB,
    `${PLAYER_SKILL_PATTERN_SWEEP_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep behind the sub-floor exclusion: stored plays rated at the
// calc's 0.8 goal floor only evict when their row recomputes, which normally
// waits on a profile view past the 12h TTL. This sweep finds every
// current-version row still holding a floor-rated play and queues the
// ordinary recompute for it, so inflated headline ratings heal right after
// the deploy instead of lingering until someone looks. Local DB work plus
// cache-reusing recomputes; the recompute enqueues sit below the
// session-debounced priority so viewers and fresh sessions still preempt.
export const PLAYER_SKILL_FLOOR_SWEEP_JOB = "recompute_player_skill_floor_sweep";
const PLAYER_SKILL_FLOOR_SWEEP_META_KEY = "player_skill_floor_sweep_done:v1";
const PLAYER_SKILL_FLOOR_SWEEP_CHUNK = 200;
const PLAYER_SKILL_FLOOR_SWEEP_RECOMPUTE_PRIORITY = 5;

const PLAYER_SKILL_FLOOR_SIGNATURE_SQL = `exists (
  select 1 from json_each(json_extract(plays_json, '$.plays')) as play
  where json_extract(play.value, '$.goal') <= ${SSR_GOAL_MIN}
)`;

export interface PlayerSkillFloorSweepChunkResult {
  nextCursor: number;
  scanned: number;
  enqueued: number[];
  done: boolean;
}

export async function runPlayerSkillFloorSweepChunk(
  db: Db,
  queue: JobQueue,
  cursor: number,
  limit = PLAYER_SKILL_FLOOR_SWEEP_CHUNK,
): Promise<PlayerSkillFloorSweepChunkResult> {
  const rows = (await exec(
    db,
    `select user_id from player_skill_ratings
     where user_id > ? and analysis_version = ? and ${PLAYER_SKILL_FLOOR_SIGNATURE_SQL}
     order by user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), PLAYER_SKILLS_VERSION, Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const enqueued: number[] = [];
  for (const row of rows) {
    const userId = Number(row.user_id);
    nextCursor = Math.max(nextCursor, userId);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    await enqueuePlayerSkills(queue, userId, { priority: PLAYER_SKILL_FLOOR_SWEEP_RECOMPUTE_PRIORITY });
    enqueued.push(userId);
  }
  return { nextCursor, scanned: rows.length, enqueued, done: rows.length < limit };
}

export async function ensurePlayerSkillFloorSweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [PLAYER_SKILL_FLOOR_SWEEP_META_KEY])).rows[0];
  if (done) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [PLAYER_SKILL_FLOOR_SWEEP_JOB],
  )).rows[0];
  if (pending) return;
  await enqueuePlayerSkillFloorSweep(queue, 0);
}

export async function runPlayerSkillFloorSweepJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await runPlayerSkillFloorSweepChunk(db, queue, cursor);
  if (result.enqueued.length > 0) {
    logInfo("player_skill_floor_sweep_enqueued", { users: result.enqueued.length, cursor });
  }
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [PLAYER_SKILL_FLOOR_SWEEP_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueuePlayerSkillFloorSweep(queue, result.nextCursor);
}

async function enqueuePlayerSkillFloorSweep(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILL_FLOOR_SWEEP_JOB,
    `${PLAYER_SKILL_FLOOR_SWEEP_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}

// One-shot sweep behind a vibro-detector change: the retention loop already
// drops a stored play whose chart is now vibro-flagged, but only when that
// row recomputes, which waits on a profile view past the 12h TTL. A player
// nobody opens keeps an inflated headline rating, and the skill leaderboards
// read the stored row. So this finds every current-version row still holding
// a droppable play on a flagged chart and queues the ordinary recompute for
// it. Same shape as the floor sweep above, and deliberately not a plays_json
// rewrite: the drop rule needs the live pp-backed set, which only the real
// recompute can build.
//
// Ordering matters: the flags have to exist before this can find them, so it
// is chained off the end of the vibro recompute sweep (see
// runVibroRecomputeJob) rather than seeded independently at boot.
export const PLAYER_SKILL_VIBRO_SWEEP_JOB = "recompute_player_skill_vibro_sweep";
const PLAYER_SKILL_VIBRO_SWEEP_META_KEY = "player_skill_vibro_sweep_done:v1";
const PLAYER_SKILL_VIBRO_SWEEP_CHUNK = 200;
const PLAYER_SKILL_VIBRO_SWEEP_RECOMPUTE_PRIORITY = 5;

// Mirrors the retention rule's droppable half: a flagged chart whose play did
// not come from the top-200. Top-sourced plays keep their pp-backed trust, so
// they are not evidence a row needs recomputing.
const PLAYER_SKILL_VIBRO_SIGNATURE_SQL = `exists (
  select 1
  from json_each(json_extract(plays_json, '$.plays')) as play
  join beatmap_chart_analysis analysis
    on analysis.beatmap_id = json_extract(play.value, '$.beatmapId')
   and analysis.analysis_version = ${CHART_ANALYSIS_VERSION}
  where json_extract(play.value, '$.source') is not 'top'
    and coalesce(json_extract(analysis.classification_json, '$.vibro'), 0) = 1
)`;

export interface PlayerSkillVibroSweepChunkResult {
  nextCursor: number;
  scanned: number;
  enqueued: number[];
  done: boolean;
}

export async function runPlayerSkillVibroSweepChunk(
  db: Db,
  queue: JobQueue,
  cursor: number,
  limit = PLAYER_SKILL_VIBRO_SWEEP_CHUNK,
): Promise<PlayerSkillVibroSweepChunkResult> {
  const rows = (await exec(
    db,
    `select user_id from player_skill_ratings
     where user_id > ? and analysis_version = ? and ${PLAYER_SKILL_VIBRO_SIGNATURE_SQL}
     order by user_id
     limit ?`,
    [Math.max(0, Math.floor(cursor)), PLAYER_SKILLS_VERSION, Math.max(1, Math.floor(limit))],
  )).rows;

  let nextCursor = cursor;
  const enqueued: number[] = [];
  for (const row of rows) {
    const userId = Number(row.user_id);
    nextCursor = Math.max(nextCursor, userId);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    await enqueuePlayerSkills(queue, userId, { priority: PLAYER_SKILL_VIBRO_SWEEP_RECOMPUTE_PRIORITY });
    enqueued.push(userId);
  }
  return { nextCursor, scanned: rows.length, enqueued, done: rows.length < limit };
}

export async function ensurePlayerSkillVibroSweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [PLAYER_SKILL_VIBRO_SWEEP_META_KEY])).rows[0];
  if (done) return;
  // Boot fallback for a chain lost to a restart: only once the flags are in.
  const flagsReady = (await exec(db, "select 1 from live_meta where key = ? limit 1", [VIBRO_RECOMPUTE_META_KEY])).rows[0];
  if (!flagsReady) return;
  const pending = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [PLAYER_SKILL_VIBRO_SWEEP_JOB],
  )).rows[0];
  if (pending) return;
  await enqueuePlayerSkillVibroSweep(queue, 0);
}

export async function runPlayerSkillVibroSweepJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
): Promise<void> {
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  const result = await runPlayerSkillVibroSweepChunk(db, queue, cursor);
  if (result.enqueued.length > 0) {
    logInfo("player_skill_vibro_sweep_enqueued", { users: result.enqueued.length, cursor });
  }
  if (result.done) {
    const now = nowIso();
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [PLAYER_SKILL_VIBRO_SWEEP_META_KEY, json({ finishedAt: now }), now],
    );
    return;
  }
  await enqueuePlayerSkillVibroSweep(queue, result.nextCursor);
}

async function enqueuePlayerSkillVibroSweep(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILL_VIBRO_SWEEP_JOB,
    `${PLAYER_SKILL_VIBRO_SWEEP_JOB}:${cursor}`,
    { cursor },
    { priority: -10, replaceDone: true },
  );
}
