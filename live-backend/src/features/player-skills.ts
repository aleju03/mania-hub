import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { lnPrimaryMinRatioFor } from "../dan/dan-estimator/ln.js";
import type { MotionFeatures } from "../dan/motion-features.js";
import { LN_TAIL_BLEND_BY_KEYMODE, LN_TAIL_MIN_RATIO, blendLnTailValues, computeMsd, isMsdSupportedKeyCount } from "../dan/msd.js";
import type { JobQueue } from "../jobs/queue.js";
import { readConfig } from "../config.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import { CHART_ANALYSIS_VERSION, HT_RATE_ANALYSIS_META_KEY, JACK_DEMAND_RECOMPUTE_META_KEY, JACK_TAG_META_KEY, LN7_PRIMARY_REPIN_META_KEY, MOTION_FEATURES_RECOMPUTE_META_KEY, SUNNY_REPIN_DT_META_KEY, VIBRO_RECOMPUTE_META_KEY, enqueueMissingChartAnalyses } from "./chart-analysis.js";
import { MAX_RATE_PERCENT, MIN_RATE_PERCENT, computeAndStoreRateDanVerdictFromText, enqueueRateDanEstimate, loadStoredRateDanVerdicts, rateDanVerdictKey } from "./dan-estimates.js";
import { getCachedBeatmapFile, readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import type { OsuApiClient } from "../osu/client.js";
import { fetchAndStoreProfileSnapshotShared, getCachedPlayerProfileSnapshot, persistSessionProfileSnapshot } from "./player-profiles.js";
import { calculateScoreV2Accuracy, calculateStableAccuracy, getDisplayedAccuracy, getModAcronyms, getScoreIdentity, getStoredScoreAccuracy, isLazerScore, nowIso } from "../shared/score.js";
import { selectRowsByIntegerSet } from "../shared/score-storage.js";
import { buildPlayerAccModel } from "./player-acc-model.js";
import { danLabelFor, danTableCeilingFor, danTableVerdictLabelFor } from "../dan/chart-classifier.js";
import { creditedDanFor, danCreditBelowBarWindowFor } from "../dan/dan-credit.js";
import { loadDanCourseClears } from "./dan-courses.js";
import type { DanCourseClear, DanCourseCreditOptions } from "./dan-courses.js";
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

// v22 (current): no pipeline change at all - the bump exists so the
// version-stale drip re-walks the roster after MinaCalc gained 5K and 8-18K
// (MSD_SUPPORTED_KEYS). Rows recomputed between the v21 deploy and that one are
// stamped current but hold no mode outside 4/6/7K, and the drip only picks
// users with no row at the current version, so 3,544 of 17,838 ready rows would
// have kept an incomplete keymode set until a profile view or a new session
// touched them. Earlier bumps: `git log -S PLAYER_SKILLS_VERSION`.
export const PLAYER_SKILLS_VERSION = 22;
// Prior versions whose stored plays_json is a sound seed for this version's
// first compute, so a bump updates ratings in place instead of re-running
// MinaCalc on every play and dropping the durable retained evidence. Sound
// here means the stored SSR values still mean the same thing: v17 -> v18
// changed candidate eligibility (DA), wife-goal inputs (lazer EZ/HR windows)
// and dan credit rules, all of which the reuse key and the retention pass
// re-evaluate per play - the goal is part of the reuse key, so every
// still-visible play whose goal shifted recomputes, and DA identities evict.
// A bump that changes what an SSR value itself means (a calc change like
// v15's LN blend) must ship this list EMPTY, or stale values would be
// reused forever on plays whose goal did not move. v19 moves no SSR value and
// no goal, only the tile a clear files under, so it seeds from every version
// back to the last calc change: v15's LN blend was that change, and v16, v17
// and v18 all rate a play's SSR the same way. Listing only the immediately
// prior version is the trap here rather than the safe choice - a roster
// migrates version by version and most of it is still two bumps back. Measured
// on the local snapshot at the time of the v19 bump: 5,028 ready rows on v18
// against 12,134 on v17 and 383 on v16, so a list of [18] would have sent 71%
// of the roster through a from-zero recompute, re-running MinaCalc on every
// play and dropping the retained evidence for plays that have since aged out
// of the top-100 window.
export const PLAYER_SKILLS_SEED_VERSIONS: readonly number[] = [21, 20, 19, 18, 17, 16];
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
// Keymode-aware since the 7K line moved to 0.375 (its hybrid mapping culture;
// lnPrimaryMinRatioFor). Still the same line the chart identity uses.
const lnPatternRatioMinFor = lnPrimaryMinRatioFor;
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
// ladder's decay window under the bar (danCreditBelowBarWindowFor: five
// points on rice, three on 6K/7K LN, 2.5 on 4K LN) still credits the chart minus a
// decay (capped so it can never equal the chart's own dan, and reaching a level
// and a half down at the rice window's edge, a level and three quarters at the
// 6K/7K LN one), and accuracy above the bar credits a
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
  /**
   * How full the averaging window behind this dan is: `have` clears out of the
   * `need` a complete estimate averages over. On a skillset verdict that is
   * its own window (min(clears, danClearAverageWindowFor)) out of the window;
   * on a side headline it is every published skillset's window summed, so a
   * side with one thin skill reads as short even when the others are full.
   *
   * `skills` carries that headline as skills rather than clears: how many of
   * the published skillsets have their whole window. The sum alone cannot be
   * shown honestly - a side missing one skill entirely still reads 75 of 80,
   * which draws as a full ring - so the badge counts skills and the sum stays
   * for the sentence under it. Absent on a single-pool verdict (a skillset of
   * its own, or a side whose keymode publishes none).
   *
   * Stored so the badge can say the estimate is still filling in without
   * re-deriving a player's clears - the surfaces that show a dan outside the
   * evidence window (profile chips, My Stats, the dan leaderboard) only ever
   * read the stored verdict. Absent on rows written before this shipped and
   * on a headline a course clear set, where the number is a pass rather than
   * an average.
   */
  clearWindow?: { have: number; need: number; skills?: { full: number; total: number } };
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
  // The chart's osu! leaderboard status ("ranked", "loved", "graveyard", ...),
  // lowercased, or null when this backend has never stored the beatmap row.
  // Drives the ranked filter; unknown is not the same as unranked, so a null
  // is kept rather than folded into either side.
  beatmapStatus: string | null;
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
  /** How many plays the active filters leave, which is what `offset` pages. */
  total: number;
  /** How many the bounded order cohort has before any filter. */
  unfilteredTotal: number;
  limit: number;
  offset: number;
}

// The explorer deliberately follows osu!'s top-play window: each ordering is
// a bounded 200-play cohort, paged or progressively revealed 50 at a time by
// its callers. Filters narrow that cohort rather than pulling rank 201 in.
export const PLAYER_SKILL_PLAYS_MAX = 200;

// Overall is listable even though no skill tile opens it: the plays explorer
// ranks a whole keymode by the rating the profile headline is, which is the
// one axis a tile could never stand for.
const PLAYER_SKILL_AXES = new Set<string>([
  ...SKILL_RATING_SKILLSETS,
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
  // True when EZ widened the play's hit windows (ezWindowScale > 1, both
  // clients). The wife goal already prices that in for the skill rating, but
  // a dan clear is accuracy against the bar, so these plays credit no dan.
  // Retained plays cached before the field existed stay undefined and fall
  // back to the live score when one is around.
  ezWindows?: boolean;
  // The OD the play was judged at, set only when Difficulty Adjust moved the
  // slider off the chart's own value. The dan OD floor reads this ahead of the
  // chart's stored OD, so a DA play that raised OD to the floor counts and one
  // that lowered it does not. Unset on every other play, which is judged at
  // whatever OD the chart currently stores.
  odOverride?: number | null;
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
 * Mods under which the judgements testify about a chart the stored .osu never
 * was, so both the SSR (computed from the stored notes) and any dan credit
 * would be mis-rated. Hold Off plays every hold as a bare tap, which turns an
 * LN chart into rice; Invert turns the gaps between notes into holds; No
 * Release frees every hold tail, which is where LN accuracy is earned. Such a
 * play is skipped rather than mis-rated, like the no-single-rate mods.
 *
 * Difficulty Adjust is deliberately not one of them: mania's DA moves the OD
 * slider (and HP drain), never a note, so the stored .osu is still the chart
 * that was played. What it does move is the hit windows, so the play is rated
 * and judged against the OD it was actually set at (difficultyAdjustOd),
 * which is what the wife goal and the dan OD floor both read.
 */
const CHART_REWRITING_MODS = new Set(["HO", "IN", "NR"]);

export function scoreRewritesChart(mods: OsuMod[] | string[] | undefined): boolean {
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (CHART_REWRITING_MODS.has(acronym)) return true;
  }
  return false;
}

/**
 * The OD a Difficulty Adjust play was judged at, or null when the play carries
 * no DA (or a DA that left the slider alone, which lazer sends as a settings-
 * less mod). Mania's DA exposes exactly one difficulty value, OverallDifficulty
 * (ppy/osu ManiaModDifficultyAdjust), so this is the whole of what DA changes
 * about how a play is judged: with Extended Limits the slider runs -15..15,
 * and the value is clamped into the 0..10 the rest of the OD math speaks.
 *
 * Raising OD this way is a real, harder play, so it earns dan credit like any
 * other clear; lowering it below the ladder's floor is caught by that floor
 * rather than by refusing to rate the play at all.
 */
export function difficultyAdjustOd(mods: OsuMod[] | string[] | undefined): number | null {
  for (const mod of mods ?? []) {
    if (typeof mod === "string") continue;
    if (String(mod?.acronym ?? "") !== "DA") continue;
    const od = Number(mod.settings?.overall_difficulty);
    if (!Number.isFinite(od)) return null;
    return Math.max(0, Math.min(10, od));
  }
  return null;
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

// Both clients scale every mania hit window by 1.4 under EZ and by 1/1.4
// under HR. Stable always did; lazer matched it exactly in July 2025
// (ppy/osu 8e53f47, a per-note window multiplier), and before that its EZ/HR
// still widened/narrowed the windows by shifting effective OD, just not by
// this exact factor. 1.4 is exact for stable and current lazer and the close
// approximation for the older lazer plays.
const EZ_WINDOW_SCALE = 1.4;

function ezWindowScale(score: SsrGoalScore): number {
  let scale = 1;
  for (const mod of score.mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "EZ") scale *= EZ_WINDOW_SCALE;
    else if (acronym === "HR") scale /= EZ_WINDOW_SCALE;
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
  const wife = estimateWifeAccuracy(score.statistics, { od, windowScale: ezWindowScale(score) });
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
  /** Structurally detected 4K quadstream/minijack/jack-marathon demand. */
  jackDemand?: boolean;
  // Share of LeoBlack cluster importance (amount x difficulty) on jack and on
  // stream clusters. Null when the chart carries no clusters. See clusterShare.
  jackShare: number | null;
  streamShare: number | null;
  // Whether LeoBlack's headline label for the whole chart carries "Tech".
  // Null when it stored no label. See TECH_CLUSTER_CATEGORY.
  techCategory: boolean | null;
  // Whether that same label names a trill, the one shape 4K players call tech
  // outright when MinaCalc rates it Jumpstream. Null when no label is stored.
  // Read by the 4K Jumpstream arbitration (TRILL_CLUSTER_CATEGORY).
  clusterTrill: boolean | null;
  // Whether that same label names handstream. Null when no label is stored.
  // Read by the Handstream near-tie (HANDSTREAM_NEAR_TIE_MSD).
  handstreamCluster: boolean | null;
  // The analyzer's raw tech score at 1.0x, zeroed when the jack veto strips
  // the tech tag. Read by the 4K speed tile's tech tiebreak
  // (TECH_NEAR_TIE_MIN_SCORE), which needs the score rather than the 0.5 tag.
  techScore: number;
  // The analyzer's raw chordjack score, unzeroed. Read by the dense-trill jack
  // arm (TRILL_JACK_MIN_CHORDJACK), which needs the score rather than the 0.8
  // tag that already routes an outright chordjack chart.
  chordjackScore: number;
  // Wrist-versus-roll note shares at 1.0x (dan/motion-features.ts), 4K only.
  // Null on any chart analysed before the motion sweep reached it, which is
  // how the speed/tech model spells "no reading" (speedTechProbability).
  motion?: MotionFeatures | null;
  lnRatio: number | null;
  vibro: boolean;
  /** False when the chart's raw object structure makes its dan verdict unsafe
   * as player evidence. The chart may still display that verdict on /maps. */
  danEligible: boolean;
  rcRawDan: number | null;
  lnRawDan: number | null;
  // The stored verdict's own printed label per half ("alpha+"), the same words
  // the maps surfaces show. A verdict's tier and its rawDan are decided
  // independently (LeoBlack names the tier, the numeric hint refines rawDan),
  // so re-banding rawDan can print a different suffix than the verdict wears.
  rcDanLabel: string | null;
  lnDanLabel: string | null;
  dtRawDan: number | null;
  dtFamily: "rc" | "ln" | null;
  dtDanLabel: string | null;
  htRawDan: number | null;
  htFamily: "rc" | "ln" | null;
  htDanLabel: string | null;
  /** Drain length at 1.0x, for the stamina gate in bucketingSkillset. For a
   * confirmed pre-rated upload this is the base-rate length its own file no
   * longer has (see applyRateEditBaseLengths), not the stored one. */
  lengthSeconds: number | null;
  /** Stored overall difficulty from the beatmaps row; null when the chart is
   * not yet enriched. Read by the dan-evidence OD floor (DAN_MIN_OD). */
  od: number | null;
}

interface LeanHalfJson {
  rawDan?: unknown;
  displayName?: unknown;
}

interface LeanClassificationJson {
  lnRatio?: unknown;
  vibro?: unknown;
  danEligibility?: { eligible?: unknown } | null;
  rc?: LeanHalfJson | null;
  ln?: LeanHalfJson | null;
  patterns?: Array<{ id?: unknown; score?: unknown }>;
  jackDemand?: { detected?: unknown } | null;
  clusters?: Array<{ pattern?: unknown; importance?: unknown }>;
  clusterCategory?: unknown;
  motion?: Record<string, unknown> | null;
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

// Arbitrates a 4K Jumpstream-argmax clear across the tiles (see
// danSkillsetBuckets). MinaCalc's Jumpstream fires on dense jumptrill, on
// chordstream stamina files and on fast jumpstream alike, so the argmax alone
// names nothing and two signals split it:
//
// 1. LeoBlack's label. A trill name ("Jumptrill", "Split Trill Tech") keeps
//    the clear on tech outright, the one shape 4K players read as tech no
//    matter how it rates - of 44 charts from mapper-named 4K jumptrill packs,
//    43 label "Jumptrill" plain. A plain label ("Jumpstream", "Handstream",
//    "Chordjacks", "Rolls") files stamina, the community reading that
//    jumpstream and handstream ARE endurance.
// 2. For the label that reads tech without naming a trill ("Jumpstream Tech"),
//    which covers both shapes, MinaCalc's own runner-up decides: the strongest
//    skillset other than Jumpstream picks the tile the same way it would if it
//    had won the argmax. This is the reading 4K players gave for the pair the
//    rule has to separate - Blastix Riotz [GRAVITY] rates Jumpstream 27.91 over
//    Technical 26.71 and is tech, goreshit - daddy can change [4K] men (4766898)
//    rates Jumpstream 31.08 over Stamina 29.19 and is stamina, and Finixe
//    [4K] Another rates Jumpstream 22.14 over Stream 20.64 on 222BPM streams
//    and is speed.
//
// There is no length floor on any of it. A 54-second file is still a
// jumpstream file, which is the correction this rule carries: the floor
// shipped 2026-08-29 sent 4766898 to tech on its 54 seconds and 4K players
// reject that reading.
//
// Measured 2026-08-30 against mapper-named 4K pack corpora
// (scripts/dev/tile-variant-sweep.ts, variant G3), alongside the three changes
// below: jumpstream (502 charts) goes 75.9% -> 78.9% stamina-tiled, handstream
// (571) 87.4% -> 88.3%, stamina (1,159) 65.1% -> 67.0% and tech (453) 46.4% ->
// 47.5% tech-tiled, while jumptrill (47) and jack (3,323) do not move at all
// and speed (1,213) loses 8 charts (77.0% -> 76.3%) and stream (686) two. A
// missing label keeps the legacy tech pairing rather than guessing (99.5% of
// ready 4K analyses store one).
const TRILL_CLUSTER_CATEGORY = /trill/i;

// The same label read for handstream, for the near-tie below.
const HANDSTREAM_CLUSTER_CATEGORY = /handstream/i;

// A trill label sends a Jumpstream argmax to tech, EXCEPT when the trill is
// dense enough to be a jack demand. A trill is hit by oscillating the wrist,
// which is the motion a chordjack asks for rather than the finger independence
// a stream asks for, so a jack player picks these up cheaply and a dense one
// is their map. The bar is the analyzer's raw chordjack score, under the 0.8
// tag that already routes an outright chordjack chart and above the trills
// that are genuinely tech.
//
// 0.60 is set on the labelled pair it has to separate, both 240BPM+ jumptrill:
// NANO DEATH!!!!! [4K] DEATH (1021312) scores 0.71 and QZKago Requiem [4K]
// NYARMAGEDDON (4152216) 0.65, which 4K players read as jack files, against
// the Blastix Riotz family at 0.50 (GRAVITY), 0.57 (GRAVITY Lv.16) and 0.23
// (Jinjin's INFINITE), which they read as tech. 0.70 would drop QZKago.
//
// Measured 2026-08-30 over the mapper-named 4K pack corpora
// (scripts/dev/tile-variant-sweep.ts): it moves 1 chart in each of the jack,
// handstream, speed and stamina corpora and 3 in the random one, and nothing
// at all in jumptrill, jumpstream, stream or tech. It is narrow by
// construction - only a Jumpstream argmax reaches the arbitration, and only a
// trill-labelled one reaches this.
const TRILL_JACK_MIN_CHORDJACK = 0.60;

// The second arm, for a trill the chordjack score alone cannot place. The
// score is a texture reading and it saturates on any dense oscillation, so it
// ranks FIN4LE ~Shuushisen no Kanata e~ [4K] HEAVENLY (3468306, 0.59) above
// both Perfect Neglect [4K] Lyz's Another (2031389, 0.57) and M1917 [4K]
// Maximum (1170750, 0.58) - and 4K players call the first a jumpstream file
// and the other two jack. What separates them is whether the trill carries
// actual jack clusters: 33% and 21% of LeoBlack's importance against 0.0% for
// FIN4LE, whose jack-looking mass is 36% Wildcard and Density.
//
// So a lighter trill files jack when the jack clusters corroborate it. 0.15 is
// under both labelled jack files and clear of Blastix Riotz [GRAVITY] (0.114
// at chordjack 0.50) and Villain Virus [4K] Music Virus (0.08 at 0.55), which
// are tech and stamina respectively.
const TRILL_JACK_CORROBORATED_CHORDJACK = 0.55;
const TRILL_JACK_CORROBORATED_SHARE = 0.15;

// Past the two arms above, a trill is not a jack demand, and it does not
// automatically keep tech either: on a file long enough for endurance to be a
// reading, the runner-up skillset decides, the same way an ambiguous
// tech-suffixed label is arbitrated. Villain Virus [4K] Music Virus (1912526)
// is the measured case: 4:25 of Jumpstream 24.92 / Stamina 24.48 / Technical
// 24.24, which 4K players call a stamina file rather than a tech one.
//
// The length gate is what keeps this off the jumptrill packs. Ungated it takes
// 6 of the 47 mapper-named jumptrill charts (70.2% -> 57.4% tech-tiled), all
// of them short practice cuts whose runner-up happens to be Stamina; at 4:00 it
// moves none of them and still reaches Music Virus.
// The same 4:00 as STAMINA_TILE_MIN_LENGTH_SECONDS, written out rather than
// imported because that constant is declared further down the file.
const TRILL_RUNNER_UP_MIN_LENGTH_SECONDS = 240;

/**
 * Whether a trill-labelled chart's wrist demand reads as jack. Runs ahead of
 * the MSD argmax like the analyzer's jack tag override: Perfect Neglect rates
 * Technical first and Jumpstream third, so nothing inside the Jumpstream
 * arbitration could ever reach it.
 */
function trillIsJack(chart: ChartSkillInfo | undefined): boolean {
  if (chart?.clusterTrill !== true) return false;
  if (chart.chordjackScore >= TRILL_JACK_MIN_CHORDJACK) return true;
  return chart.chordjackScore >= TRILL_JACK_CORROBORATED_CHORDJACK
    && (chart.jackShare ?? 0) >= TRILL_JACK_CORROBORATED_SHARE;
}

// Jack contamination keeps a chart off the stamina tile whatever MinaCalc's
// argmax says. AiAe [4K] Wafles' SHD (421066) is the measured case: LeoBlack
// reads it as 62% chordstream against 31% jack (180BPM minijacks, 90BPM
// chordjacks) and never finds a handstream cluster at all, yet DT lifts
// MinaCalc's Handstream from fourth at 1.0x to first, so the chart filed tech
// unrated and stamina with DT. The same chart cannot be two things because a
// mod made it faster.
//
// The share, not the analyzer: this chart scores tech 0.943 and the dense
// chordstream cuts the arbitration exists for score 0.94 to 1.00, so the tech
// detector separates nothing here either. Cluster importance does, because it
// weighs how much of the DIFFICULTY is jack rather than how much jack exists.
//
// 0.30 is set off the corpora the exemptions protect rather than off this
// chart: mapper-named handstream packs run p90 0.224 and p95 0.280, jumpstream
// p90 0.182 and p95 0.284, so 0.30 is past the 95th percentile of both. It sits
// under CLUSTER_SHARE_MIN (0.40, where a chart becomes a jack chart outright),
// which is the band this names: too jack to be endurance, not enough to be jack.
//
// Measured over the mapper-named 4K corpora across all three stamina entry
// paths: the handstream corpus goes 90.3% to 87.2% stamina-tiled, stamina 65.1%
// to 64.2%, and every other corpus moves under 1.5 points. The same veto has to
// guard the Stamina hold, the Handstream exemption and Jumpstream arbitration;
// otherwise the exact same chart can escape it when a rate changes the MSD
// argmax.
const STAMINA_TILE_JACK_VETO_SHARE = 0.30;

// The stored motion block, read strictly: a legacy row has no block at all and
// a partial one is not worth guessing at, so anything short of every share
// being a finite number reads as "no reading" and the older MSD-lead arms
// stand. Shares are clamped rather than rejected, since a rounded 1.0001 is
// still the reading it claims to be.
function readMotionFeatures(value: unknown): MotionFeatures | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const keys = ["sameHand", "miniJack", "oneHandTrill", "crossHandTrill", "roll4", "rhythmBreak", "chordSwing", "densitySwing"] as const;
  const read: Partial<Record<(typeof keys)[number], number>> = {};
  for (const key of keys) {
    const share = Number(raw[key]);
    if (!Number.isFinite(share)) return null;
    read[key] = key === "densitySwing" ? Math.max(0, share) : Math.min(1, Math.max(0, share));
  }
  return read as MotionFeatures;
}

function readRawDan(half: LeanHalfJson | null | undefined): number | null {
  const rawDan = Number(half?.rawDan);
  return Number.isFinite(rawDan) && rawDan > 0 ? rawDan : null;
}

function readDanLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  const rateCandidates: RateEditCandidate[] = [];
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
              json_extract(b.metadata_json, '$.total_length') as total_length,
              json_extract(b.metadata_json, '$.accuracy') as od,
              b.beatmapset_id, b.version
         from beatmap_chart_analysis a
         left join beatmaps b on b.beatmap_id = a.beatmap_id
        where a.analysis_version = ? and a.beatmap_id in (${placeholders})`,
      [CHART_ANALYSIS_VERSION, ...chunk],
    )).rows;
    // Candidates for the rate-edit base length below: only charts short enough
    // to fail the stamina gate whose named rate would carry them over it, which
    // is a few hundred charts in the whole 4K corpus. Everything else skips the
    // sibling query entirely, so the ordinary read costs nothing extra.
    for (const row of rows) {
      if (String(row.status ?? "") !== "ready") continue;
      if (Number(row.key_count) !== 4) continue;
      const length = readLengthSeconds(row.total_length);
      const setId = Number(row.beatmapset_id);
      const rate = parseNamedRate(String(row.version ?? ""));
      if (length == null || rate == null || !Number.isInteger(setId) || setId <= 0) continue;
      if (length >= STAMINA_TILE_MIN_LENGTH_SECONDS) continue;
      // Keep the tolerance band in the candidate set: the named rate and
      // integer-second API lengths can predict 239s while the actual sibling
      // is 240s. The sibling's measured length makes the final decision.
      if (length * rate < STAMINA_TILE_MIN_LENGTH_SECONDS * (1 - RATE_SIBLING_TOLERANCE)) continue;
      rateCandidates.push({ beatmapId: Number(row.beatmap_id), setId, length, rate });
    }
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
      const chartIsLn = lnRatio != null && lnRatio >= lnPatternRatioMinFor(keyCount);
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
      const danDt = parseJson<{ rawDan?: unknown; primaryFamily?: unknown; primaryLabel?: unknown } | null>(String(row.dan_dt_json ?? ""), null);
      const dtRawDan = readRawDan(danDt ?? undefined);
      const danHt = parseJson<{ rawDan?: unknown; primaryFamily?: unknown; primaryLabel?: unknown } | null>(String(row.dan_ht_json ?? ""), null);
      const htRawDan = readRawDan(danHt ?? undefined);
      info.set(Number(row.beatmap_id), {
        patterns: patternIds,
        jackDemand: parsed?.jackDemand?.detected === true,
        jackShare,
        streamShare: clusterShare(parsed, STREAM_CLUSTERS),
        techCategory: typeof parsed?.clusterCategory === "string"
          ? TECH_CLUSTER_CATEGORY.test(parsed.clusterCategory)
          : null,
        clusterTrill: typeof parsed?.clusterCategory === "string" && parsed.clusterCategory.trim() !== ""
          ? TRILL_CLUSTER_CATEGORY.test(parsed.clusterCategory)
          : null,
        handstreamCluster: typeof parsed?.clusterCategory === "string" && parsed.clusterCategory.trim() !== ""
          ? HANDSTREAM_CLUSTER_CATEGORY.test(parsed.clusterCategory)
          : null,
        techScore: vetoesTech ? 0 : (patternScores.get("tech") ?? 0),
        chordjackScore: chordjackScore,
        motion: readMotionFeatures(parsed?.motion),
        lnRatio,
        vibro: parsed?.vibro === true,
        // Legacy rows have no field and stay eligible until the targeted
        // cached-.osu sweep inspects them. Fresh analyses always store it.
        danEligible: parsed?.danEligibility?.eligible !== false,
        rcRawDan: readRawDan(parsed?.rc),
        lnRawDan: readRawDan(parsed?.ln),
        rcDanLabel: readDanLabel(parsed?.rc?.displayName),
        lnDanLabel: readDanLabel(parsed?.ln?.displayName),
        dtRawDan,
        dtFamily: dtRawDan == null ? null : danDt?.primaryFamily === "ln" ? "ln" : "rc",
        dtDanLabel: readDanLabel(danDt?.primaryLabel),
        htRawDan,
        htFamily: htRawDan == null ? null : danHt?.primaryFamily === "ln" ? "ln" : "rc",
        htDanLabel: readDanLabel(danHt?.primaryLabel),
        lengthSeconds: readLengthSeconds(row.total_length),
        od: readStoredOd(row.od),
      });
    }
    if (offset + chunk.length < ids.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  await applyRateEditBaseLengths(db, info, rateCandidates);
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
    const od = readStoredOd(row.od);
    if (od != null) map.set(Number(row.beatmap_id), od);
  }
  return map;
}

// json_extract yields NULL for charts without a stored OD; Number(null)
// would read as a real OD 0.
function readStoredOd(value: unknown): number | null {
  const od = value == null ? Number.NaN : Number(value);
  return Number.isFinite(od) && od >= 0 && od <= 10 ? od : null;
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
// PRIMARY family (LN iff the hold share clears the keymode's identity line,
// lnPrimaryMinRatioFor, the same rule as /maps): accuracy
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
  // The stored verdict's printed label for that dan, when the source kept one;
  // the evidence surface prefers it over re-banding chartDan so the modal
  // agrees with the maps page in the slivers where the two band scales differ.
  chartDanLabel: string | null;
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
type RateVerdictMap = Map<string, { rawDan: number; side: "rc" | "ln"; displayName?: string | null } | null>;

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
    credits.set(key, verdict ? { rawDan: verdict.rawDan, side: verdict.family === "ln" ? "ln" : "rc", displayName: verdict.displayName } : null);
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

// The lowest OD a play may have been judged at to credit dan. Below it the
// windows are loose enough that the accuracy no longer says much about the
// verdict's level; the verdict itself stays visible on /maps, exactly like
// the danEligible structural gate. Normally this is the chart's stored OD, but
// a Difficulty Adjust play is held to the OD it set (odOverride), so raising a
// low-OD chart to the floor counts. A chart with no stored OD yet passes, on
// the same terms as the wife goal's OD8 assumption.
const DAN_MIN_OD = 5.5;

// 7K LN is the one ladder with a lower floor: JinJin's official 7K LN dan
// courses are OD 5, so a 5.5 floor would turn away the very charts the ladder
// is measured against.
const DAN_MIN_OD_7K_LN = 5;

/** The floor the play's own ladder holds it to. */
function danMinOdFor(keyCount: number, side: "rc" | "ln" | null): number {
  return keyCount === 7 && side === "ln" ? DAN_MIN_OD_7K_LN : DAN_MIN_OD;
}

/**
 * Why a rated play credits no dan.
 *
 * Every one of these is a rule the estimate depends on, and each drops a play
 * that the player did in fact set - so the explaining surfaces list the play
 * with its reason rather than leaving a hole the reader has to guess at.
 * `chart_rewritten` is the one class that never reaches here: HO/IN/NR plays
 * are refused a rating at all (scoreRewritesChart), so no stored play carries
 * them and nothing downstream can name them. Difficulty Adjust is not among
 * them: it only moves the OD, so such a play rates normally and answers to the
 * OD floor like any other.
 */
export type DanClearRejectReason =
  | "chart_unanalyzed"
  | "chart_ineligible"
  | "low_od"
  | "ez_windows"
  | "no_accuracy"
  | "no_chart_dan"
  | "below_bar";

/** One rated play that credited no dan, with the rule that stopped it. */
export interface DanClearReject {
  play: StoredPlaySsr;
  reason: DanClearRejectReason;
  /** The side it would have testified for, when the chart names one. */
  side: "rc" | "ln" | null;
  /** The chart's dan at the played rate, when it has one. */
  chartDan: number | null;
  chartDanLabel: string | null;
  /** Only for below_bar: what it was judged on, and the bar it missed. */
  accuracy: number | null;
  bar: number | null;
  /** Only for below_bar: the lowest accuracy that would still have credited. */
  minAccuracy: number | null;
  /** Only for low_od: the OD the play was judged at, which failed the floor. */
  od: number | null;
}

/** The dan a play would testify for at its own rate, before any accuracy gate. */
interface DanClearTarget {
  rawDan: number;
  side: "rc" | "ln";
  label: string | null;
}

/**
 * Which dan a play is measured against, from the chart and the played rate.
 *
 * Split out of collectDanClears so a rejected play can still say what it was
 * aiming at: naming the chart's dan is most of what makes a "does not count"
 * row readable. Pure, and the branch order is the clear rule's own.
 */
function danClearTargetFor(
  play: StoredPlaySsr,
  info: ChartSkillInfo,
  keyCount: number,
  rateVerdicts: RateVerdictMap,
): DanClearTarget | null {
  const target = (rawDan: number | null, side: "rc" | "ln", label: string | null): DanClearTarget | null =>
    rawDan == null ? null : { rawDan, side, label };
  if (play.rate === 1 && info.lnRatio != null) {
    const side = info.lnRatio >= lnPrimaryMinRatioFor(keyCount) ? "ln" : "rc";
    return target(side === "ln" ? info.lnRawDan : info.rcRawDan, side, side === "ln" ? info.lnDanLabel : info.rcDanLabel);
  }
  if (play.rate === 1.5 && info.dtFamily != null) {
    return target(info.dtRawDan, info.dtFamily, info.dtDanLabel);
  }
  if (play.rate === 0.75 && info.htFamily != null) {
    // Credited what the chart is worth AT 0.75x, which is well under its 1.0x
    // dan: slowing a chart down does not clear the chart it used to be.
    return target(info.htRawDan, info.htFamily, info.htDanLabel);
  }
  // Every other rate in the 0.5x-2.0x band - a lazer speed_change, or a
  // 1.5x/0.75x chart the sweeps never stored columns for - credits the
  // dan_estimates verdict at the play's own rate, on the same terms.
  const ratePercent = clearRatePercent(play.rate);
  if (ratePercent == null) return null;
  const verdict = rateVerdicts.get(rateDanVerdictKey(play.beatmapId, ratePercent));
  return verdict ? target(verdict.rawDan, verdict.side, verdict.displayName ?? null) : null;
}

function collectDanClears(
  keyCount: number,
  plays: StoredPlaySsr[],
  scoresByIdentity: Map<string, OscScore>,
  infoByBeatmap: Map<number, ChartSkillInfo>,
  rateVerdicts: RateVerdictMap = new Map(),
  // When given, every play this function turns away is appended here with the
  // rule that turned it away. Left undefined by the verdict compute, which
  // only wants the clears and should not pay to describe the rest.
  rejects?: DanClearReject[],
): DanClearEvidence[] {
  const clears: DanClearEvidence[] = [];
  const reject = (
    play: StoredPlaySsr,
    reason: DanClearRejectReason,
    extra: Partial<Omit<DanClearReject, "play" | "reason">> = {},
  ) => {
    if (!rejects) return;
    rejects.push({ play, reason, side: null, chartDan: null, chartDanLabel: null, accuracy: null, bar: null, minAccuracy: null, od: null, ...extra });
  };
  for (const play of plays) {
    const info = infoByBeatmap.get(play.beatmapId);
    if (!info) {
      reject(play, "chart_unanalyzed");
      continue;
    }
    // Resolved up front so every rejection below can name the dan the play was
    // measured against, and so the OD floor knows which ladder it is guarding.
    // Pure, so hoisting it changes nothing about the clears.
    const target = danClearTargetFor(play, info, keyCount, rateVerdicts);
    const aimed = target
      ? { side: target.side, chartDan: target.rawDan, chartDanLabel: target.label }
      : {};
    if (!info.danEligible) {
      reject(play, "chart_ineligible", aimed);
      continue;
    }
    // A Difficulty Adjust play was judged at the OD it set, not the chart's,
    // so that is the OD the floor holds it to: raising OD to the floor makes
    // the clear count, lowering it below stops counting.
    const playOd = play.odOverride ?? info.od;
    if (playOd != null && playOd < danMinOdFor(keyCount, target?.side ?? null)) {
      reject(play, "low_od", { ...aimed, od: playOd });
      continue;
    }
    // Clear evidence rides on the stored play (retained plays outlive their
    // score payload); the live score object is the fallback for cache entries
    // written before the fields existed.
    const score = scoresByIdentity.get(play.identity);
    // EZ widened every hit window 1.4x (both clients), so the accuracy was
    // not earned against the windows the bar assumes; no dan credit. The play
    // itself stays rated: the wife goal already derates it for the skill
    // rating.
    if (play.ezWindows ?? (score != null && ezWindowScale(score) > 1)) {
      reject(play, "ez_windows", aimed);
      continue;
    }
    const displayed = play.accuracy ?? (score ? getDisplayedAccuracy(score) : null);
    if (typeof displayed !== "number") {
      reject(play, "no_accuracy", aimed);
      continue;
    }
    // Both currencies come off the judgement counts, so a bar written in one
    // of them means the same thing on stable and on lazer. The client's own
    // displayed accuracy is only the fallback for acc-only archived rows,
    // where the counts are gone and there is nothing to recompute from.
    const stable = play.stableAccuracy ?? (score ? calculateStableAccuracy(score.statistics ?? {}) || null : null);
    const scoreV2 = play.scoreV2Accuracy ?? (score ? calculateScoreV2Accuracy(score.statistics) || null : null);
    // A lazer submission displays the ScoreV2 formula already, so its own
    // accuracy is that currency even with no counts to recompute from.
    const isLazerPlay = stable != null && Math.abs(displayed - stable) > 1e-9;
    const push = (rawDan: number | null, side: "rc" | "ln", chartDanLabel: string | null) => {
      if (rawDan == null) {
        reject(play, "no_chart_dan", aimed);
        return;
      }
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
      if (creditedDan == null) {
        // The bar is where a clear credits the chart's full dan, but a pass
        // under it still credits a decayed dan down to the ladder's window
        // edge, so the number this play actually missed is that floor.
        const floor = Math.round((threshold - danCreditBelowBarWindowFor(side, keyCount)) * 1000) / 1000;
        reject(play, "below_bar", { side, chartDan: rawDan, chartDanLabel, accuracy, bar: threshold, minAccuracy: floor });
        return;
      }
      clears.push({ play, side, chartDan: rawDan, chartDanLabel, creditedDan, accuracy, bar: threshold });
    };
    if (play.rate === 1 && info.lnRatio != null) {
      const side = info.lnRatio >= lnPrimaryMinRatioFor(keyCount) ? "ln" : "rc";
      push(side === "ln" ? info.lnRawDan : info.rcRawDan, side, side === "ln" ? info.lnDanLabel : info.rcDanLabel);
    } else if (play.rate === 1.5 && info.dtFamily != null) {
      push(info.dtRawDan, info.dtFamily, info.dtDanLabel);
    } else if (play.rate === 0.75 && info.htFamily != null) {
      // Credited what the chart is worth AT 0.75x, which is well under its 1.0x
      // dan: slowing a chart down does not clear the chart it used to be.
      push(info.htRawDan, info.htFamily, info.htDanLabel);
    } else {
      // Every other rate in the 0.5x-2.0x band - a lazer speed_change, or a
      // 1.5x/0.75x chart the sweeps never stored columns for - credits the
      // dan_estimates verdict at the play's own rate, on the same terms.
      const ratePercent = clearRatePercent(play.rate);
      if (ratePercent == null) {
        reject(play, "no_chart_dan", aimed);
        continue;
      }
      const verdict = rateVerdicts.get(rateDanVerdictKey(play.beatmapId, ratePercent));
      if (verdict) {
        push(verdict.rawDan, verdict.side, verdict.displayName ?? null);
      } else {
        reject(play, "no_chart_dan", aimed);
      }
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
  rejects?: DanClearReject[],
): DanClearEvidence[] {
  return collectDanClears(keyCount, plays, new Map(), infoByBeatmap, rateVerdicts, rejects);
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

// How many best clears the dan averages over (2026-08-28, widened from 5).
// With five, a few strong credits could still set a skillset on their
// own; twenty asks every ladder for a body of work, the same argument that
// had already doubled 4K LN's bucket-less headline to ten. A pool smaller
// than the window simply averages everything it has, down to the quorum.
const DAN_CLEAR_AVERAGE_WINDOW = 20;

// One window for every ladder now: twenty is past the ten 4K LN used to
// demand over the shared five, so that special case dissolved into the base.
export function danClearAverageWindowFor(_side: "rc" | "ln", _keyCount: number): number {
  return DAN_CLEAR_AVERAGE_WINDOW;
}

/**
 * A window's own strays: clears sitting so far under the rest of it that they
 * are a player messing about (a 100% run on a chart eight levels below their
 * body of work) rather than evidence of a level. The reference is the mean of
 * the window's best five - the best three moved with a single spike - the gap
 * is five levels under it, and at most two clears may be ignored.
 *
 * The cap is the whole rule. Without one a tile could lose 12 of its 16
 * clears and jump six levels on the survivors: exactly the "your dan is your
 * best few plays" behaviour the window widened to twenty to stop. Three keeps
 * it a band-aid over an afternoon of messing about and leaves a wide body of
 * work alone. Measured over the corpus's 58,341 rated tiles, 5.7% carry one or
 * two clears under the cut and 1.8% carry three or more; going from two to
 * three moves 5.0% of sides by a median of 0.08 and at most 0.68 of a level,
 * and it exists because a tile whose best five are delta was still averaging
 * in a 100% run on a dan 8 chart once two lower ones had used up the cap.
 */
const DAN_STRAY_CLEAR_REFERENCE = 5;
const DAN_STRAY_CLEAR_GAP = 5;
const DAN_STRAY_CLEAR_MAX_IGNORED = 3;

/**
 * How many of a window's lowest clears the stray rule ignores, given the
 * window already sorted best-first the way every caller holds it. Never trims
 * past DAN_CLEAR_QUORUM: a thin pool keeps a stray rather than stopping being
 * rateable, since a tile that falls under the quorum leaves the headline
 * average entirely and would take the player DOWN.
 */
export function danIgnoredStrayCount(sortedDesc: number[]): number {
  const reference = sortedDesc.slice(0, DAN_STRAY_CLEAR_REFERENCE);
  if (reference.length === 0) return 0;
  const cut = reference.reduce((sum, value) => sum + value, 0) / reference.length - DAN_STRAY_CLEAR_GAP;
  const room = Math.min(DAN_STRAY_CLEAR_MAX_IGNORED, sortedDesc.length - DAN_CLEAR_QUORUM);
  let ignored = 0;
  while (ignored < room && sortedDesc[sortedDesc.length - 1 - ignored] < cut) ignored += 1;
  return ignored;
}

function danFromClears(rawDans: number[], side: "rc" | "ln", keyCount: number): PlayerSkillDanVerdict | null {
  if (rawDans.length < DAN_CLEAR_QUORUM) return null;
  const sorted = [...rawDans].sort((a, b) => b - a);
  // The dan is the mean of the best danClearAverageWindowFor credited clears
  // (all of them on a quorum-sized pool). One outlier clear cannot set the
  // level on its own, but it is no longer discarded the way the old
  // quorum-th-clear rule discarded everything above the 4th: it pulls the
  // average up in proportion to how far it sits above the rest.
  const needed = danClearAverageWindowFor(side, keyCount);
  const window = sorted.slice(0, needed);
  // Strays leave the average but stay in the window's `have`: they are clears
  // the player really has, they just do not set the level, and shrinking
  // `have` would draw a complete window as if it were still filling in.
  const counted = window.slice(0, window.length - danIgnoredStrayCount(window));
  const rawDan = Math.round((counted.reduce((sum, value) => sum + value, 0) / counted.length) * 100) / 100;
  return {
    rawDan,
    label: danLabelFor(rawDan, side, keyCount),
    clears: sorted.filter((value) => value >= rawDan - DAN_ROUNDING_EPSILON).length,
    clearWindow: { have: window.length, need: needed },
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
  const grouped = groupDanClearsBySkillset(keyCount, side, list, infoByBeatmap);
  for (const [id, bucketClears] of grouped.byBucket) {
    // A tile opens on its primary clears alone (see resolveTilesForClear), then
    // averages over everything filed there, shared clears included.
    if ((grouped.primaryByBucket.get(id)?.length ?? 0) < DAN_CLEAR_QUORUM) continue;
    const bucketDan = danFromClears(bucketClears.map((clear) => clear.creditedDan), side, keyCount);
    if (bucketDan) skillsets[id] = bucketDan;
  }
  const headline = averageSkillsetDans(skillsets, clearDans, side, keyCount) ?? quorumDan;
  const withCourse = applyDanCourseFloor(headline, best, side, keyCount, clearDans);
  // A course clear hands the player the level outright, so a floored headline
  // has no window left to fill and carries none.
  const windowed = withCourse.courseClear
    ? withCourse
    : { ...withCourse, clearWindow: danHeadlineClearWindow(keyCount, side, grouped, clearDans.length) };
  return Object.keys(skillsets).length > 0 ? { ...windowed, skillsets } : windowed;
}

/**
 * How full the clear pools behind a side's headline are.
 *
 * Every published skillset wants its own full window, so the headline's is
 * their windows summed: a player with four skills but only three clears of one
 * of them is not done filling the estimate in, however deep the other three
 * are. Buckets under the quorum have no verdict of their own but their clears
 * still count here, because what the marker answers is "how much of this
 * estimate is still missing", not "how many skills are rated".
 *
 * Sides that publish no skillsets (4K and 6K LN) have one pool, so their
 * window is the side's own, which is what the evidence window shows them.
 */
function danHeadlineClearWindow(
  keyCount: number,
  side: "rc" | "ln",
  grouped: GroupedDanClears,
  sideClears: number,
): NonNullable<PlayerSkillDanVerdict["clearWindow"]> {
  const need = danClearAverageWindowFor(side, keyCount);
  const pools = grouped.primaryByBucket;
  if (pools.size === 0) return { have: Math.min(sideClears, need), need };
  // Primary filings only, so a clear that carries two tiles fills one slot
  // rather than two and the sentence this draws ("averaged over N of M
  // clears") stays true.
  let have = 0;
  let full = 0;
  for (const bucketClears of pools.values()) {
    have += Math.min(bucketClears.length, need);
    if (bucketClears.length >= need) full += 1;
  }
  return { have, need: need * pools.size, skills: { full, total: pools.size } };
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
  // Score identities seen carrying a chart-rewriting mod (HO/IN/NR):
  // never candidates, and grounds for evicting a stored play rated before
  // the exclusion existed.
  const rewritingModIdentities = new Set<string>();
  const consider = (score: OscScore, source: "top" | "tracked") => {
    const beatmapId = beatmapIdOf(score);
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      if (source === "top") unsupportedPlays += 1;
      return;
    }
    if (scoreRewritesChart(score.mods)) {
      rewritingModIdentities.add(getScoreIdentity(score));
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
    // DA's OD wins over the chart's: the windows the play was judged against
    // are the ones the wife estimate has to assume.
    const odOverride = difficultyAdjustOd(score.mods);
    const goal = ssrGoalForScore(score, info?.lnRatio ?? null, odOverride ?? odByBeatmap.get(beatmapId) ?? null);
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
      ezWindows: ezWindowScale(score) > 1,
      odOverride: difficultyAdjustOd(score.mods),
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
    // A stored play whose still-visible score turns out to carry a
    // chart-rewriting mod (HO/IN/NR) was rated against a chart it never
    // played (rated before the exclusion existed); evict instead of
    // retaining. Applies to any source: top trust is about the rate, and
    // these disqualify regardless of rate.
    if (rewritingModIdentities.has(previous.identity)) continue;
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

    // Current-version plays first; on a version bump's first compute, the
    // newest seed-compatible superseded row instead (its plays_json survives
    // until this job's ready write deletes it below), so the recompute reuses
    // stored SSRs and keeps retained evidence instead of starting from zero.
    const seedableVersions = [PLAYER_SKILLS_VERSION, ...PLAYER_SKILLS_SEED_VERSIONS];
    const previousRow = (await exec(
      db,
      `select plays_json from player_skill_ratings
       where user_id = ? and analysis_version in (${seedableVersions.map(() => "?").join(", ")})
       order by analysis_version desc`,
      [userId, ...seedableVersions],
    )).rows.find((row) => typeof row.plays_json === "string" && row.plays_json.length > 0);
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
  const rows = (await exec(
    db,
    `select analysis_version, status, modes_json, computed_at, updated_at from player_skill_ratings
     where user_id = ?
     order by analysis_version desc`,
    [userId],
  )).rows;
  const row = rows.find((candidate) => Number(candidate.analysis_version) === PLAYER_SKILLS_VERSION);

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

  // A refresh marks the current row running before it computes, but it leaves
  // the last complete payload in place until the ready write swaps in the new
  // one. Keep serving that payload during the refresh (and after a failed
  // refresh) instead of briefly blanking every skill surface.
  if ((status === "ready" || status === "running" || status === "failed") && summary) {
    return {
      status: "ready",
      version: PLAYER_SKILLS_VERSION,
      computedAt: typeof row?.computed_at === "string" ? row.computed_at : null,
      totalPlays: Math.max(0, Number(summary.totalPlays ?? 0)),
      analyzedPlays: Math.max(0, Number(summary.analyzedPlays ?? 0)),
      pendingPlays: Math.max(0, Number(summary.pendingPlays ?? 0)),
      unsupportedPlays: Math.max(0, Number(summary.unsupportedPlays ?? 0)),
      modes: Array.isArray(summary.modes) ? summary.modes.filter(isValidMode).map(normalizeMode) : [],
      ...(status !== "ready" || shouldEnqueue ? { stale: true } : {}),
    };
  }
  // A version bump must not blank a profile that has a rating: until this
  // player's current-version row is ready, the newest superseded ready row
  // keeps serving, flagged stale (the enqueue above already queued the
  // upgrade, and the ready write deletes this row when it lands).
  const fallbackRow = rows.find(
    (candidate) => Number(candidate.analysis_version) !== PLAYER_SKILLS_VERSION && String(candidate.status) === "ready",
  );
  const fallbackSummary = parseJson<Partial<StoredModesSummary> | null>(String(fallbackRow?.modes_json ?? ""), null);
  if (fallbackRow && fallbackSummary) {
    return {
      status: "ready",
      version: Number(fallbackRow.analysis_version),
      computedAt: typeof fallbackRow.computed_at === "string" ? fallbackRow.computed_at : null,
      totalPlays: Math.max(0, Number(fallbackSummary.totalPlays ?? 0)),
      analyzedPlays: Math.max(0, Number(fallbackSummary.analyzedPlays ?? 0)),
      pendingPlays: Math.max(0, Number(fallbackSummary.pendingPlays ?? 0)),
      unsupportedPlays: Math.max(0, Number(fallbackSummary.unsupportedPlays ?? 0)),
      modes: Array.isArray(fallbackSummary.modes) ? fallbackSummary.modes.filter(isValidMode).map(normalizeMode) : [],
      stale: true,
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
 * The newest complete per-play payload, regardless of the row's compute
 * lifecycle status. A same-version refresh changes `ready` to `running` but
 * deliberately retains `plays_json`; that cached payload remains the evidence
 * behind the estimate already on screen until the atomic ready write replaces
 * it. A first compute has no payload and naturally falls through to an older
 * ready version (or null).
 */
async function loadLatestStoredPlayerSkillPlays(db: Db, userId: number): Promise<StoredPlaySsr[] | null> {
  const rows = (await exec(
    db,
    `select plays_json from player_skill_ratings
     where user_id = ?
     order by analysis_version desc`,
    [userId],
  )).rows;
  for (const row of rows) {
    const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row.plays_json ?? ""), null);
    if (Array.isArray(stored?.plays)) return stored.plays;
  }
  return null;
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
  options: PlayerSkillPlaysOptions = {},
): Promise<PlayerSkillPlaysPage> {
  const limit = Math.max(1, Math.min(PLAYER_SKILL_PLAYS_MAX, Math.floor(Number(options.limit) || 50)));
  const offset = Math.max(0, Math.min(5_000, Math.floor(Number(options.offset) || 0)));
  const sort: PlayerSkillPlaysSort = options.sort === "recent" ? "recent" : "rating";
  const empty: PlayerSkillPlaysPage = { items: [], total: 0, unfilteredTotal: 0, limit, offset };
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(keyCount) || keyCount <= 0 || !isPlayerSkillAxis(axis)) {
    return empty;
  }

  const storedPlays = await loadLatestStoredPlayerSkillPlays(db, userId);
  if (!storedPlays) return empty;
  const patternId = axis.startsWith("pattern:") ? axis.slice("pattern:".length) : null;
  const candidates = storedPlays
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
  const ranked = candidates.sort(comparePlayerSkillPlays(sort));
  const cohort = ranked.slice(0, PLAYER_SKILL_PLAYS_MAX);

  // The active order chooses the osu-style 200-play cohort first. Filters then
  // narrow that fixed cohort rather than pulling rank 201 in, so the explorer
  // can cache it and make every filtering control local and immediate. The
  // ranked filter needs a status for the cohort rather than for the page alone,
  // which is why it reads its own narrow column before the metadata join.
  const statuses = options.hideRanked
    ? await readPlayerSkillPlayStatuses(db, cohort.map(({ play }) => play.beatmapId))
    : null;
  const matches = filterPlayerSkillPlays(cohort, {
    ...(statuses ? { statuses } : {}),
    ...(options.maxPerChart != null ? { maxPerChart: options.maxPerChart } : {}),
  });

  const page = matches.slice(offset, offset + limit);
  const metadata = await readPlayerSkillPlayMetadata(db, page.map(({ play }) => play.beatmapId));
  const items = page.map(({ play, rating }) => buildPlayerSkillPlay(play, rating, keyCount, metadata));
  return { items, total: matches.length, unfilteredTotal: cohort.length, limit, offset };
}

export type PlayerSkillPlaysSort = "rating" | "recent";

export interface PlayerSkillPlaysOptions {
  limit?: number;
  offset?: number;
  /** "recent" reorders the same set by when each play was set, newest first. */
  sort?: PlayerSkillPlaysSort;
  /** Drop plays on charts the osu! leaderboards call ranked/approved/qualified. */
  hideRanked?: boolean;
  /** Keep at most this many plays per beatmap, in the active order. */
  maxPerChart?: number;
}

/**
 * The list order, over the same set either way.
 *
 * A "recent" read is not a play feed: the stored set keeps one best play per
 * chart and rate (the compute keys its candidates `beatmapId:rate`), so this
 * is "the rated plays, newest first" and never "every attempt". A play with no
 * stored timestamp sorts last rather than to the top, where an empty string
 * would otherwise put it.
 */
export function comparePlayerSkillPlays(
  sort: PlayerSkillPlaysSort,
): (left: { play: StoredPlaySsr; rating: number }, right: { play: StoredPlaySsr; rating: number }) => number {
  if (sort === "recent") {
    return (left, right) => {
      const leftAt = typeof left.play.endedAt === "string" ? left.play.endedAt : "";
      const rightAt = typeof right.play.endedAt === "string" ? right.play.endedAt : "";
      if (leftAt !== rightAt) {
        if (leftAt === "") return 1;
        if (rightAt === "") return -1;
        return rightAt.localeCompare(leftAt);
      }
      return right.rating - left.rating || left.play.beatmapId - right.play.beatmapId;
    };
  }
  return (left, right) =>
    right.rating - left.rating
    || Number(right.play.pp ?? 0) - Number(left.play.pp ?? 0)
    || String(right.play.endedAt ?? "").localeCompare(String(left.play.endedAt ?? ""))
    || left.play.beatmapId - right.play.beatmapId;
}

/**
 * The ranked filter and the per-chart cap, applied in the list's own order.
 *
 * The cap keeps the FIRST n plays of each chart, so which rates survive is
 * whatever the active sort put on top: the best n on a rating list, the newest
 * n on a recency list. A chart this backend has never stored a beatmap row for
 * has an unknown status, and unknown is kept - hiding it would quietly drop
 * every chart the catalog has not caught up with, which is most of the
 * graveyard the ranked filter exists to leave behind.
 *
 * Exported for the tests and for the dan list, which filters the clears it
 * already holds rather than asking for a narrower read.
 */
export function filterPlayerSkillPlays<T extends { play: StoredPlaySsr }>(
  plays: T[],
  options: { statuses?: Map<number, string | null>; maxPerChart?: number } = {},
): T[] {
  const maxPerChart = Number.isFinite(options.maxPerChart) && Number(options.maxPerChart) > 0
    ? Math.floor(Number(options.maxPerChart))
    : null;
  if (!options.statuses && maxPerChart == null) return plays;
  const seenPerChart = new Map<number, number>();
  const kept: T[] = [];
  for (const entry of plays) {
    if (options.statuses && isRankedBeatmapStatus(options.statuses.get(entry.play.beatmapId) ?? null)) continue;
    if (maxPerChart != null) {
      const seen = seenPerChart.get(entry.play.beatmapId) ?? 0;
      if (seen >= maxPerChart) continue;
      seenPerChart.set(entry.play.beatmapId, seen + 1);
    }
    kept.push(entry);
  }
  return kept;
}

// The statuses that put a chart on the official leaderboards, which is what
// "hide ranked" means to a player. Loved is not one of them (no pp, and the
// dan tables live there), and neither is anything unsubmitted.
const RANKED_BEATMAP_STATUSES = new Set(["ranked", "approved", "qualified"]);

export function isRankedBeatmapStatus(status: string | null): boolean {
  return status != null && RANKED_BEATMAP_STATUSES.has(status);
}

/**
 * The osu! status of a chart, normalized. Both spellings are in the wild: the
 * v2 API sends the word, older rows kept the integer enum.
 */
export function readBeatmapStatus(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  if (typeof value === "number" && Number.isFinite(value)) {
    return BEATMAP_STATUS_BY_ENUM.get(Math.trunc(value)) ?? null;
  }
  return null;
}

const BEATMAP_STATUS_BY_ENUM = new Map<number, string>([
  [-2, "graveyard"],
  [-1, "wip"],
  [0, "pending"],
  [1, "ranked"],
  [2, "approved"],
  [3, "qualified"],
  [4, "loved"],
]);

/** Status alone for a candidate set, without the covers and title join. */
async function readPlayerSkillPlayStatuses(db: Db, beatmapIds: number[]): Promise<Map<number, string | null>> {
  const rows = await selectRowsByIntegerSet(db, "select beatmap_id, status from beatmaps where beatmap_id in", beatmapIds);
  const statuses = new Map<number, string | null>();
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    statuses.set(beatmapId, readBeatmapStatus(row.status));
  }
  return statuses;
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
    beatmapStatus: map?.status ?? null,
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
// verdict's `clears` count refers to). `ignoredAsStray` marks the clears the
// stray rule dropped out of the average that produced the estimate.
export interface PlayerSkillDanEvidencePlay {
  play: PlayerSkillPlay;
  chartDan: number;
  chartDanLabel: string;
  creditedDan: number;
  creditedDanLabel: string;
  clearAccuracy: number;
  /** The skillset tiles this clear is filed under; two when the rules share it. */
  skillsets: string[];
  countsTowardDan: boolean;
  /**
   * The stray rule left this clear out of the average behind the number above
   * it (danIgnoredStrayCount). It is still a real clear and still listed, it
   * just does not pull the level down.
   */
  ignoredAsStray?: boolean;
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

/**
 * One rated play that credits this side no dan, as the evidence surface shows
 * it: the play, what it was aiming at, and the rule that stopped it.
 *
 * These are deliberately not clears and are never counted anywhere - listing
 * them answers "why is this play missing", which is otherwise unanswerable
 * from the outside.
 */
export interface PlayerSkillDanRejectedPlay {
  play: PlayerSkillPlay;
  reason: DanClearRejectReason;
  /** Null when the chart names no side at this rate, so it shows on both. */
  side: "rc" | "ln" | null;
  chartDan: number | null;
  chartDanLabel: string | null;
  /** Only set for below_bar: what it was judged on, and the bar it missed. */
  clearAccuracy: number | null;
  bar: number | null;
  /** Only set for below_bar: the lowest accuracy that would still have credited. */
  minAccuracy: number | null;
  /** Only set for low_od: the OD the play was judged at, which failed the floor. */
  od: number | null;
  /** The skillset tiles it would have been filed under, had it counted. */
  skillsets: string[];
}

export interface PlayerSkillDanEvidence {
  side: "rc" | "ln";
  keyCount: number;
  quorum: number;
  /** The lowest accuracy that credits anything: barAccuracy minus the credit window. */
  minAccuracy: number;
  /** The ladder's own pass bar, where a clear credits the chart's full dan. */
  barAccuracy: number;
  /** How many best clears each dan averages over (danClearAverageWindowFor). */
  averageWindow: number;
  dan: PlayerSkillDanSide | null;
  totalClears: number;
  clears: PlayerSkillDanEvidencePlay[];
  skillsets: PlayerSkillDanSkillsetEvidence[];
  /** Present only when a course clear set this side's headline. */
  courseClear: PlayerSkillDanCourseEvidence | null;
  /** Present only when the read asked for it (`includeRejected`). */
  rejected?: PlayerSkillDanRejectedPlay[];
  /** How many rejected plays exist for this side, before the page cap. */
  totalRejected?: number;
}

// The OD floor a rejected play reports, so the surface can name the number a
// chart missed rather than just the rule. 7K LN sits at DAN_MIN_OD_7K_LN.
export const DAN_MIN_OD_FLOOR = DAN_MIN_OD;

// Per-request ceiling on the rejected list. Sized like the clears page: it is
// an explanation, not a second leaderboard.
export const DAN_EVIDENCE_MAX_REJECTED = 200;

// Every play the average actually reads must ship: each list averages its best
// DAN_CLEAR_AVERAGE_WINDOW clears, so a shorter cap would hide clears that set
// the number the window exists to explain.
const DAN_EVIDENCE_MAX_CLEARS = DAN_CLEAR_AVERAGE_WINDOW;
const DAN_EVIDENCE_SKILLSET_PLAYS = DAN_CLEAR_AVERAGE_WINDOW;
// Per-request ceiling for a read that pages the "all clears" list. Bounds the
// payload and the metadata read, not the average: nothing past the window
// participates in any number.
export const DAN_EVIDENCE_PAGE_MAX_CLEARS = 200;

interface DanSkillsetBucket {
  id: string;
  /** Analyzer pattern tags that put a clear in this bucket. */
  tags: string[];
  /**
   * MSD skillsets that put a clear in this bucket, by the play's STRONGEST
   * skillset rather than by a tag. Set only where MinaCalc rates the keymode
   * meaningfully (4K). The argmax itself is single-valued, so this is a
   * partition of the side's clears except where resolveTilesForClear
   * deliberately shares a chart between two tiles.
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
 * is an argmax, a clear files under one tile unless resolveTilesForClear gives
 * it a second one - which about one 4K chart in nine earns. Measured over the
 * 2,062,117 rated 4K plays in the corpus:
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
 * them.
 *
 * A Jumpstream argmax is arbitrated rather than paired: MinaCalc's Jumpstream
 * fires on dense jumptrill (tech to 4K players) and on dense chordstream
 * stamina files (Amber Wishes-type practice cuts) alike, and an unconditional
 * tech pairing put 47% of the mapper-named stamina corpus on the tech tile.
 * LeoBlack's headline label separates the shapes where the in-house tech score
 * cannot (those stamina cuts carry tech scores of 0.94-1.00): a label naming a
 * trill keeps the clear on tech, a plain label files stamina, and the
 * tech-suffixed label that covers both hands the choice to MinaCalc's
 * runner-up skillset (TRILL_CLUSTER_CATEGORY has the measurements;
 * bucketsForClear applies it, and a chart with no stored label keeps the tech
 * pairing).
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
 * jumptrill set before touching the constant. Two exceptions inside that band
 * file tech instead: a chart the analyzer confidently calls tech
 * (TECH_NEAR_TIE_MIN_SCORE), and a tech-tagged chart whose Technical outranks
 * Stream by more than argmax noise (TECH_NEAR_TIE_MSD_LEAD). Both carry their
 * own measurements.
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
 * out of its argmax tile rather than adding it, so it is resolveTilesForClear
 * and nothing else that gives a chart two tiles.
 *
 * A second 4K jack correction runs ahead of the tag override and reads the
 * chart itself rather than the MSD argmax: jack-demand.ts (stored as
 * classification_json.jackDemand) files a clear under Jack when the notes show
 * dense alternating chords that reload the same fingers two rows later, when
 * LeoBlack reads the chart's importance as jack clusters (outright, or a
 * quarter of it with the chordjack detector and jack pressure corroborating),
 * or on a long high-pressure jack marathon. MinaCalc suppresses anchored rows, so those
 * shapes reach it as Technical or Jumpstream even when the community reads them
 * as jack. Every arm only counts clusters slow enough to be jacked, or they
 * take the fast trill and speed files the tech and speed packs are built from.
 * Measured as charts that CHANGE tile: 2.9% of a random 4K sample, 4.5% of the
 * jack packs, 1 of 212 tech-pack charts, and none of the 399 speed, stream and
 * handstream pack charts. Like the tag override it MOVES the clear rather than
 * adding a tile.
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
      // Jumpstream is listed on tech as the fallback pairing; bucketsForClear
      // re-files a Jumpstream argmax by LeoBlack's label and, where that label
      // is ambiguous, by the runner-up skillset (TRILL_CLUSTER_CATEGORY).
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
 * verdict rather than adding to it. Every filing then goes through
 * resolveTilesForClear, which settles the speed/tech tile from the notes and
 * is the one place a clear can come back carrying two. Tag keymodes (6K/7K)
 * file by chartBelongsToTagBucket alone, overlapping by design.
 */
function bucketsForClear(
  buckets: DanSkillsetBucket[],
  topSkillset: string | null,
  chart: ChartSkillInfo | undefined,
  values: Record<string, number> | undefined,
  rate = 1,
): DanSkillsetBucket[] {
  // MinaCalc suppresses anchored rows and can rate community-Jack
  // quadstream/minijack shapes as Technical or Jumpstream. Chart analysis
  // verifies that demand from the notes themselves; it outranks every MSD
  // argmax just like the older speedjack/chordjack tag override.
  if (chart?.jackDemand === true || trillIsJack(chart)) {
    const jack = buckets.find((bucket) => bucket.id === "jack" && bucket.skillsets != null);
    if (jack) return resolveTilesForClear([jack], buckets, chart, values, rate);
  }
  const override = buckets.find(
    (bucket) => bucket.skillsets != null && bucket.tags.length > 0 && chartBelongsToTagBucket(bucket, chart),
  );
  if (override != null) return resolveTilesForClear([override], buckets, chart, values, rate);
  // The Jumpstream arbitration (TRILL_CLUSTER_CATEGORY). A trill label keeps
  // the tech pairing the bucket lists already give it; a plain label files
  // stamina; a tech-suffixed label hands the tile to the runner-up skillset,
  // which files through the same bucket lists every other argmax does. A chart
  // with no stored label keeps the tech pairing rather than guessing.
  //
  // The jack veto applies to the endurance readings here too, or a chart it
  // pushed off Handstream would fall into Jumpstream and come back to stamina
  // through this rule.
  const contaminated = jackContaminated(chart?.jackShare ?? null);
  const effectiveTop = topSkillset !== "Jumpstream" || chart?.clusterTrill == null
    ? topSkillset
    : chart.clusterTrill
      // The jack reading already ran as an override above. What is left is a
      // trill that is not a jack demand: on a long file the runner-up decides
      // (TRILL_RUNNER_UP_MIN_LENGTH_SECONDS), otherwise it keeps tech.
      ? ((enduranceSeconds(chart.lengthSeconds, rate) ?? 0) >= TRILL_RUNNER_UP_MIN_LENGTH_SECONDS
        ? jumpstreamRunnerUp(values, contaminated)
        : topSkillset)
      : chart.techCategory === true
        ? jumpstreamRunnerUp(values, contaminated)
        : contaminated ? topSkillset : "Stamina";
  const filed = buckets.filter((bucket) => bucket.skillsets
    ? effectiveTop != null && bucket.skillsets.includes(effectiveTop)
    : chartBelongsToTagBucket(bucket, chart));
  return resolveTilesForClear(filed, buckets, chart, values, rate);
}

/**
 * Which tiles a clear ends on, once the note data has its say.
 *
 * Two things happen here. A speed-or-tech tile is re-decided by the model,
 * which reads the notes alongside both ratings and so replaces the MSD-lead
 * arms in bucketingSkillset rather than adding to them. And a chart files TWO
 * tiles where the evidence for one is not evidence against the other: the
 * model landing between its bars (SPEED_TECH_DUAL_LOW / SPEED_TECH_DUAL_HIGH),
 * or a jack chart long enough that the endurance is the other half of what it
 * asks for (JACK_STAMINA_ENDURANCE_SKILLSETS).
 *
 * Never more than two, and the tile the clear filed under first stays first:
 * that is its PRIMARY, and only a primary filing counts toward a tile's quorum
 * (see groupDanClearsBySkillset). A shared clear raises both tiles' dans but
 * cannot conjure a tile out of nothing, so four long chordjack marathons still
 * light one skill rather than two.
 *
 * 6K/7K file by analyzer tags and already overlap by design, so this only runs
 * where the buckets carry skillset lists.
 */
function resolveTilesForClear(
  filed: DanSkillsetBucket[],
  buckets: DanSkillsetBucket[],
  chart: ChartSkillInfo | undefined,
  values: Record<string, number> | undefined,
  rate: number,
): DanSkillsetBucket[] {
  if (filed.length !== 1 || filed[0].skillsets == null) return filed;
  const primary = filed[0];
  const add = (id: string): DanSkillsetBucket[] => {
    const sibling = buckets.find((bucket) => bucket.id === id && bucket.skillsets != null);
    return sibling ? [primary, sibling] : filed;
  };

  if (primary.id === "tech" || primary.id === "speed") {
    // The model rules the whole speed/tech tile, not just the near-tie: it
    // reads the notes and both ratings, so it subsumes the two MSD-lead arms
    // in bucketingSkillset, which stay as the fallback for a chart whose
    // motion block the sweep has not written yet.
    const modelled = speedTechTiles(values, chart?.motion ?? null, chart?.techScore ?? 0);
    if (!modelled) return filed;
    const decided = buckets.find((bucket) => bucket.id === modelled.primary && bucket.skillsets != null);
    if (!decided) return filed;
    if (!modelled.shared) return [decided];
    const other = buckets.find((bucket) => bucket.id === (modelled.primary === "tech" ? "speed" : "tech") && bucket.skillsets != null);
    return other ? [decided, other] : [decided];
  }

  if (primary.id === "jack") {
    const argmax = dominantSkillset(values);
    if (argmax == null || !JACK_STAMINA_ENDURANCE_SKILLSETS.includes(argmax)) return filed;
    const endurance = enduranceSeconds(chart?.lengthSeconds ?? null, rate);
    if (endurance == null || endurance < STAMINA_TILE_MIN_LENGTH_SECONDS) return filed;
    return add("stamina");
  }

  return filed;
}

// The evidence modal's side-wide list, as a section key the per-tile stray
// marks can never collide with (no bucket id starts with a colon).
const ALL_CLEARS_SECTION = ":all";

interface GroupedDanClears {
  /** Every clear filed into each bucket, its primary tile and its shared one
   *  alike. What each tile's dan is averaged over. */
  byBucket: Map<string, DanClearEvidence[]>;
  /** Only the clears whose FIRST tile is this one. What the quorum counts, so
   *  a shared clear can raise a tile the player already has but cannot open
   *  one on its own. */
  primaryByBucket: Map<string, DanClearEvidence[]>;
}

/**
 * The side's clears filed into their skillset buckets, one entry per bucket the
 * keymode publishes (empty lists included). Shared by the stored verdict and the
 * on-demand evidence window so "your jack dan" is the same number on the
 * leaderboard and in the window that explains it.
 */
/**
 * The skillset tiles a play is filed under, in filing order.
 *
 * Pure over the play and its chart, with no reference to the clear's credit,
 * which is what lets the same rule name the tile on a play that credited
 * nothing. The first entry is the primary on 4K's shared tiles; a chart the
 * rules deliberately share sits in two, and the surface that prints them says
 * so ("Speed/Tech") rather than picking one.
 *
 * Everything that names a tile goes through here, so the grouping behind the
 * per-skill dans and the label on a row can never disagree.
 */
function danSkillsetBucketsForPlay(
  buckets: DanSkillsetBucket[],
  play: StoredPlaySsr,
  chart: ChartSkillInfo | undefined,
): DanSkillsetBucket[] {
  const topSkillset = bucketingSkillset(
    play.values,
    chart?.lengthSeconds ?? null,
    play.rate,
    chart?.techScore ?? 0,
    chart?.jackShare ?? null,
    chart?.handstreamCluster === true,
  );
  return bucketsForClear(buckets, topSkillset, chart, play.values, play.rate);
}

function groupDanClearsBySkillset(
  keyCount: number,
  side: "rc" | "ln",
  clears: DanClearEvidence[],
  infoByBeatmap: Map<number, ChartSkillInfo>,
): GroupedDanClears {
  const buckets = danSkillsetBuckets(keyCount, side);
  const byBucket = new Map<string, DanClearEvidence[]>();
  const primaryByBucket = new Map<string, DanClearEvidence[]>();
  for (const bucket of buckets) {
    byBucket.set(bucket.id, []);
    primaryByBucket.set(bucket.id, []);
  }
  for (const clear of clears) {
    const chart = infoByBeatmap.get(clear.play.beatmapId);
    const filed = danSkillsetBucketsForPlay(buckets, clear.play, chart);
    filed.forEach((bucket, index) => {
      byBucket.get(bucket.id)!.push(clear);
      // Tag keymodes (6K/7K) overlap by analyzer tag rather than by a shared
      // verdict, and every tag filing is as much the clear's own tile as the
      // next, so they are all primary. Only the 4K shared tiles rank.
      if (index === 0 || bucket.skillsets == null) primaryByBucket.get(bucket.id)!.push(clear);
    });
  }
  return { byBucket, primaryByBucket };
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
  // The modal's "load more" paging over the "all clears" list. `maxClears`
  // under the default is ignored so a read can only widen the page the average
  // already ships; `clearsOffset` starts the page partway down the same
  // ordering, leaving every other field of the payload as the full read.
  options: {
    maxClears?: number;
    clearsOffset?: number;
    includeRejected?: boolean;
    rejectedLimit?: number;
    /** Orders the returned play pages only; the dan calculation stays best-first. */
    sort?: PlayerSkillPlaysSort;
  } = {},
): Promise<PlayerSkillDanEvidence | null> {
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(keyCount) || keyCount <= 0) return null;
  const storedPlays = await loadLatestStoredPlayerSkillPlays(db, userId);
  if (!storedPlays) return null;
  const plays = storedPlays
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
  // Collected in the same pass as the clears so the two lists cannot disagree
  // about which rule a play fell to. The array is only handed over when the
  // read asks for it; without it collectDanClears does no extra work.
  const rejectSink: DanClearReject[] | undefined = options.includeRejected ? [] : undefined;
  const clears = collectDanClears(keyCount, plays, new Map(), infoByBeatmap, rateVerdicts, rejectSink)
    .filter((clear) => clear.side === side)
    .sort((left, right) =>
      right.creditedDan - left.creditedDan
      || String(right.play.endedAt ?? "").localeCompare(String(left.play.endedAt ?? ""))
      || left.play.beatmapId - right.play.beatmapId);
  // A play whose chart names no side at this rate cannot be filed under one,
  // so it shows on both rather than vanishing from the surface that exists to
  // account for it.
  const rejectedForSide = (rejectSink ?? [])
    .filter((entry) => entry.side == null || entry.side === side)
    .sort((left, right) =>
      (right.chartDan ?? -1) - (left.chartDan ?? -1)
      || String(right.play.endedAt ?? "").localeCompare(String(left.play.endedAt ?? ""))
      || left.play.beatmapId - right.play.beatmapId);
  const rejectedForPage = options.sort === "recent"
    ? [...rejectedForSide].sort((left, right) => {
      const leftAt = typeof left.play.endedAt === "string" ? left.play.endedAt : "";
      const rightAt = typeof right.play.endedAt === "string" ? right.play.endedAt : "";
      if (leftAt !== rightAt) {
        if (leftAt === "") return 1;
        if (rightAt === "") return -1;
        return rightAt.localeCompare(leftAt);
      }
      return (right.chartDan ?? -1) - (left.chartDan ?? -1) || left.play.beatmapId - right.play.beatmapId;
    })
    : rejectedForSide;
  const rejectedPage = rejectedForPage.slice(0, Math.max(1, Math.min(
    Math.floor(Number(options.rejectedLimit) || DAN_EVIDENCE_MAX_REJECTED),
    DAN_EVIDENCE_MAX_REJECTED,
  )));
  const courseClears = await loadPlayerDanCourseClears(db, userId);
  const dan = danSideFromClears(keyCount, side, clears, infoByBeatmap, courseClears);
  // Everything at or above the estimate "backs" it, matching the stored
  // verdict's clears count.
  const threshold = dan ? dan.rawDan - DAN_ROUNDING_EPSILON : null;

  // Which clears the stray rule left out of the averages on screen. Marked per
  // window rather than per play, because a clear is only a stray relative to
  // the pool it is averaged against: the skillset windows are marked whenever
  // the tiles carry their own dans, and the side-wide window only when it is
  // the one the headline came from (a side with fewer than two rated tiles).
  // A clear can now sit in two tiles, and being a stray in one says nothing
  // about the other, so the marks are kept per tile. The side-wide "all
  // clears" list only calls a shared clear a stray when every published tile
  // it contributes to ignored it.
  const ignoredBySection = new Map<string, Set<DanClearEvidence>>();
  const ignoredInAllClears = new Set<DanClearEvidence>();
  const markStrays = (list: DanClearEvidence[], section: string) => {
    const window = list.slice(0, danClearAverageWindowFor(side, keyCount));
    const ignored = danIgnoredStrayCount(window.map((clear) => clear.creditedDan));
    const marked = ignoredBySection.get(section) ?? new Set<DanClearEvidence>();
    for (const clear of window.slice(window.length - ignored)) {
      marked.add(clear);
    }
    ignoredBySection.set(section, marked);
  };

  // Skillset grouping, by bucket rather than by raw analyzer tag: the tag
  // vocabulary is 18 ids deep and a player reads their dan through the four
  // skills their scene actually names (DAN_SKILLSET_BUCKETS). The dans come
  // off `dan.skillsets` rather than being recomputed here, because they are
  // the terms the headline averaged - deriving them twice invites the window
  // to explain a number it did not produce.
  const buckets = danSkillsetBuckets(keyCount, side);
  const bySkillset = groupDanClearsBySkillset(keyCount, side, clears, infoByBeatmap);
  const publishedBucketIds = Object.keys(dan?.skillsets ?? {});
  if (publishedBucketIds.length >= DAN_SKILLSET_AVERAGE_MIN_BUCKETS) {
    for (const bucketId of publishedBucketIds) {
      markStrays(bySkillset.byBucket.get(bucketId) ?? [], bucketId);
    }
    for (const clear of clears) {
      const contributingBuckets = publishedBucketIds.filter((bucketId) =>
        bySkillset.byBucket.get(bucketId)?.includes(clear) === true);
      if (contributingBuckets.length > 0
        && contributingBuckets.every((bucketId) => ignoredBySection.get(bucketId)?.has(clear) === true)) {
        ignoredInAllClears.add(clear);
      }
    }
  } else {
    markStrays(clears, ALL_CLEARS_SECTION);
    for (const clear of ignoredBySection.get(ALL_CLEARS_SECTION) ?? []) ignoredInAllClears.add(clear);
  }

  const maxClears = Math.min(
    Math.max(Math.floor(options.maxClears ?? DAN_EVIDENCE_MAX_CLEARS), DAN_EVIDENCE_MAX_CLEARS),
    DAN_EVIDENCE_PAGE_MAX_CLEARS,
  );
  const clearsOffset = Math.max(Math.floor(options.clearsOffset ?? 0), 0);
  const clearsForPage = options.sort === "recent"
    ? [...clears].sort((left, right) => {
      const leftAt = typeof left.play.endedAt === "string" ? left.play.endedAt : "";
      const rightAt = typeof right.play.endedAt === "string" ? right.play.endedAt : "";
      if (leftAt !== rightAt) {
        if (leftAt === "") return 1;
        if (rightAt === "") return -1;
        return rightAt.localeCompare(leftAt);
      }
      return right.creditedDan - left.creditedDan || left.play.beatmapId - right.play.beatmapId;
    })
    : clears;
  const topClears = clearsForPage.slice(clearsOffset, clearsOffset + maxClears);
  const courseSource = dan?.courseClear ? bestDanCourseClear(courseClears, keyCount, side) : null;
  const evidenceBeatmapIds = [
    ...(courseSource ? [courseSource.beatmapId] : []),
    ...topClears.map((clear) => clear.play.beatmapId),
    ...rejectedPage.map((entry) => entry.play.beatmapId),
    ...[...bySkillset.byBucket.values()].flatMap((list) => list.slice(0, DAN_EVIDENCE_SKILLSET_PLAYS).map((clear) => clear.play.beatmapId)),
  ];
  const metadata = await readPlayerSkillPlayMetadata(db, evidenceBeatmapIds);
  const toEvidencePlay = (clear: DanClearEvidence, section: string = ALL_CLEARS_SECTION): PlayerSkillDanEvidencePlay => {
    // Prefer the verdict's own stored label, so the modal names the chart the
    // same way the maps page does; the verdict's tier and its rawDan are set
    // independently, and re-banding the number disagrees in the slivers
    // between the two band scales (an 11.29 stored as alpha+ prints alpha++).
    const chartDanLabel = clear.chartDanLabel ?? chartDanLabelFor(clear.chartDan, side, keyCount);
    return {
      play: buildPlayerSkillPlay(clear.play, Number(clear.play.values?.Overall ?? 0), keyCount, metadata),
      chartDan: Math.round(clear.chartDan * 100) / 100,
      chartDanLabel,
      creditedDan: Math.round(clear.creditedDan * 100) / 100,
      // A zero-offset clear credits the chart's exact number, so it keeps the
      // chart's exact words too; only a real credit shift re-bands.
      creditedDanLabel: clear.creditedDan === clear.chartDan ? chartDanLabel : danLabelFor(clear.creditedDan, side, keyCount),
      clearAccuracy: clear.accuracy,
      skillsets: danSkillsetBucketsForPlay(buckets, clear.play, infoByBeatmap.get(clear.play.beatmapId)).map((bucket) => bucket.id),
      countsTowardDan: threshold != null && clear.creditedDan >= threshold,
      ...((section === ALL_CLEARS_SECTION ? ignoredInAllClears.has(clear) : ignoredBySection.get(section)?.has(clear) === true)
        ? { ignoredAsStray: true }
        : {}),
    };
  };

  // Emitted in bucket-declaration order; the client ranks them for display.
  const skillsets = buckets
    .map((bucket): PlayerSkillDanSkillsetEvidence => {
      const list = bySkillset.byBucket.get(bucket.id)!;
      const skillsetDan = dan?.skillsets?.[bucket.id] ?? null;
      return {
        id: bucket.id,
        clears: list.length,
        dan: skillsetDan ? { rawDan: skillsetDan.rawDan, label: skillsetDan.label } : null,
        plays: list.slice(0, DAN_EVIDENCE_SKILLSET_PLAYS).map((clear) => toEvidencePlay(clear, bucket.id)),
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
    averageWindow: danClearAverageWindowFor(side, keyCount),
    dan,
    totalClears: clears.length,
    clears: topClears.map((clear) => toEvidencePlay(clear)),
    skillsets,
    courseClear: courseSource ? toCourseEvidence(courseSource, side, keyCount, metadata) : null,
    ...(rejectSink
      ? {
        totalRejected: rejectedForSide.length,
        rejected: rejectedPage.map((entry): PlayerSkillDanRejectedPlay => ({
          // Rated at Overall, like every other row here: a rejected play has
          // no dan credit to print in that column, so its own skill rating is
          // the only number it can honestly carry.
          play: buildPlayerSkillPlay(entry.play, Number(entry.play.values?.Overall ?? 0), keyCount, metadata),
          reason: entry.reason,
          side: entry.side,
          chartDan: entry.chartDan == null ? null : Math.round(entry.chartDan * 100) / 100,
          chartDanLabel: entry.chartDanLabel
            ?? (entry.chartDan != null && entry.side != null ? chartDanLabelFor(entry.chartDan, entry.side, keyCount) : null),
          clearAccuracy: entry.accuracy,
          bar: entry.bar,
          minAccuracy: entry.minAccuracy,
          od: entry.od,
          skillsets: danSkillsetBucketsForPlay(buckets, entry.play, infoByBeatmap.get(entry.play.beatmapId)).map((bucket) => bucket.id),
        })),
      }
      : {}),
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

// The analyzer arbitrates the same band the other way when it is confident: a
// clear that would file speed moves to tech when Technical also sits within
// SPEED_NEAR_TIE_MSD of Stream AND the chart's raw tech score clears this bar.
// Crescent Moon Island [Kuro 1.05x (181bpm)] (3090568) is the measured case:
// Stream 32.67 over Technical 32.34, a 0.33 gap that is argmax noise, on a
// chart the analyzer calls tech at 0.825 - it filed speed while the maps page
// called it tech.
//
// The bar is the raw score at 0.8, not the 0.5 tech tag, because the tech
// detector fires broadly: filing every tech-tagged chart under tech would take
// the mapper-named stamina corpus (519 charts) from 40.5% to 92.5% tech-tiled
// and the random corpus from 36.6% to 57.8%. Confined to the near-tie band at
// 0.8, measured over mapper-named 4K pack corpora (287 tech / 940 speed / 629
// stream / 519 stamina / 280 jumpstream): the tech corpus goes 41.8% -> 44.9%
// tech-tiled, the speed corpus loses 6 charts (81.6% -> 81.0%), every other
// corpus moves 0-2 charts, and corpus-wide 0.8% of charts change tile. 0.7
// doubles the tech recovery (-> 49.5%) but costs 17 speed-pack charts (1.8%);
// kept at 0.8 to stay under the same 1%-per-corpus line the jack override
// held itself to. Re-measure both corpora before lowering it.
const TECH_NEAR_TIE_MIN_SCORE = 0.8;

// The same band arbitrates a second way, for the charts whose tech score sits
// below that bar: a would-be speed verdict moves to tech when Technical
// OUTRANKS Stream by this much and the analyzer tags the chart tech at all
// (PATTERN_TAG_MIN_SCORE). The tiebreak above answers "the analyzer is sure
// this is tech, and the two skillsets tie"; this one answers "MinaCalc itself
// ranks tech over stream by more than argmax noise, and the analyzer agrees it
// is tech". Matusa Bomber [4K] 2mnd (4189256) is the measured case: Stamina
// 28.57 / Technical 28.44 / Stream 27.63 on a 3:02 file, so the stamina hold
// cannot reach it and Stream wins the near-tie from THIRD place - while /maps,
// which reads the top base skillset, calls the same chart tech. Its tech score
// is 0.54, well under the 0.8 bar.
// It first shipped at 0.6, which left the rest of that beatmapset behind: the
// seven Matusa Bomber diffs are one chart at seven rates and 4K players call
// all seven tech, but their Technical-over-Stream leads run 0.35, 0.36, 0.47,
// 0.47, 0.59, 0.70 and 0.81, so 0.6 took two and the speed tile took five.
// 0.35 is where a rated set stops being split by its own rate.
//
// The near-tie exists for hundredths-level noise, and the alpha speed pack the
// band was widened for has real speed charts with Technical ahead of Stream by
// 0.02 and by 0.50, so this stays a bar the labelled speed evidence can pass.
// Measured 2026-08-30 over the mapper-named 4K pack corpora
// (scripts/dev/tile-variant-sweep.ts): moving 0.6 -> 0.35 takes the tech
// corpus (453 charts) 46.4% -> 49.2% tech-tiled while the speed corpus (1,213)
// loses 8 (77.0% -> 76.3%), stream (686) two and stamina (1,159) three, and
// handstream, jumpstream, jumptrill and jack move nothing. The eight speed
// losses are all named speed-pack charts, so this is the one number here whose
// cost is paid in real labels rather than corpus noise; it buys 13 tech-pack
// charts and a set that stops contradicting itself. Dropping the tech-tag
// demand entirely costs the speed corpus 3.4%. Re-measure both corpora before
// moving either number.
const TECH_NEAR_TIE_MSD_LEAD = 0.35;

// ── The 4K speed/tech split, read off the notes ─────────────────────────────
//
// Both arms above ask MinaCalc and the analyzer's tech score which of Stream
// and Technical a chart is. Neither can answer well, because the two ratings
// measure the same thing from different angles: over the 738 mapper-named
// pack charts sitting in the near-tie, the MSD lead separates the labelled
// tech charts from the labelled speed ones at AUC 0.73 and the analyzer's tech
// score at 0.71. That ceiling is why the lead bar above had to be tuned twice
// and still cost eight named speed-pack charts.
//
// What 4K players use instead is the motion: a tech chart oscillates the wrist
// (two-column trills, minijacks, patterns that keep returning to a column), a
// speed chart rolls the fingers across the hands. dan/motion-features.ts
// measures exactly that off the note data, and those shares separate the same
// 738 charts at AUC 0.84 on their own. Combined with the two ratings, 0.86.
//
// The combination is this logistic model. It is small on purpose: six inputs,
// fitted on charts from 170 packs with the packs held out whole (a chart never
// scores against a model that saw another diff from its own pack), and the
// diagnostics say it is reading a real signal rather than memorising one.
// Repeated grouped 5-fold CV over ten fold splits gives AUC 0.870 +/- 0.003,
// every weight keeps its sign across ten refits on 80% of the packs, and the
// learning curve is flat: training on a quarter of the packs (31 of them)
// scores 0.852 on held-out packs against 0.857 for all 127. A model that had
// memorised its corpus would improve with more of it.
//
// Held out entirely from the fit: the twelve charts a 4K dan player labelled
// by hand on 2026-08-30. Ten get a decisive verdict and all ten are right;
// the other two land in the shared band, which is the honest answer for
// Blastix Riotz [4K] Jinjin's INFINITE (p 0.49).
//
// Standardisation constants are the fitted corpus mean and standard deviation
// per input; they are part of the model and move only with a refit.
const SPEED_TECH_MODEL = {
  bias: -0.5869,
  terms: [
    { mean: 0.0439, sd: 0.0659, weight: 0.7207 },  // rhythmBreak
    { mean: 0.0551, sd: 0.0456, weight: 0.9009 },  // crossHandTrill
    { mean: 0.0044, sd: 0.0065, weight: 0.5595 },  // miniJack
    { mean: 0.2300, sd: 0.0534, weight: 0.2510 },  // sameHand
    { mean: -0.3886, sd: 0.7180, weight: 0.1252 }, // Technical - Stream
    { mean: 0.3927, sd: 0.1981, weight: 1.2100 },  // analyzer tech score
  ],
} as const;

// Where the model stops claiming a single answer and the chart carries both
// tiles. Not symmetric around the 0.5 decision point: the labelled speed
// charts are the ones a decisive tech call gets wrong most often, so the tech
// side of the band is the wider one.
//
// Measured 2026-08-30 against the mapper-named 4K pack corpora, running this
// file's own code over them (scripts/dev/speed-tech-model.ts --impact): the
// tech corpus (454 charts) goes 48.5% -> 78.6% covered, speed (1,222) 76.0% ->
// 77.2%, stream (690) 56.4% -> 55.8%, and jack, stamina, jumpstream and
// handstream do not move. Over a random 6,000-chart sample of the 4K library
// 10.1% of charts carry both tiles on this axis. The same run out-of-fold
// (packs held out whole, so no chart scores against a model that saw its own
// pack) puts the tech corpus at 78.4% and speed at 76.3%, which is the honest
// pair: the in-sample gain over it is a fifth of a point.
//
// Narrowing the band to 0.35/0.65 roughly halves the sharing but costs the
// speed corpus three points and stream three and a half, because the charts it
// stops sharing it starts calling tech outright. Re-measure before moving
// either bar.
const SPEED_TECH_DUAL_LOW = 0.35;
const SPEED_TECH_DUAL_HIGH = 0.75;

/**
 * How strongly the notes and the ratings read a chart as tech rather than
 * speed, in [0, 1]. Null when the chart has no stored motion block, which is
 * every chart analysed before the sweep backfills it - those keep the MSD-lead
 * arms above rather than guessing.
 */
function speedTechProbability(
  values: Record<string, number> | undefined,
  motion: MotionFeatures | null,
  techScore: number,
): number | null {
  if (!motion) return null;
  const inputs = [
    motion.rhythmBreak,
    motion.crossHandTrill,
    motion.miniJack,
    motion.sameHand,
    Number(values?.Technical ?? 0) - Number(values?.Stream ?? 0),
    techScore,
  ];
  let z = SPEED_TECH_MODEL.bias;
  for (let index = 0; index < inputs.length; index++) {
    const term = SPEED_TECH_MODEL.terms[index];
    const input = Number(inputs[index]);
    if (!Number.isFinite(input)) return null;
    z += term.weight * ((input - term.mean) / term.sd);
  }
  return 1 / (1 + Math.exp(-z));
}

/**
 * The tiles a near-tied speed/tech chart belongs to: one of them when the
 * model is sure, both when it is not. Null when there is nothing to read, and
 * the caller keeps the older arms.
 */
function speedTechTiles(
  values: Record<string, number> | undefined,
  motion: MotionFeatures | null,
  techScore: number,
): { primary: "tech" | "speed"; shared: boolean } | null {
  const probability = speedTechProbability(values, motion, techScore);
  if (probability == null) return null;
  return {
    primary: probability >= 0.5 ? "tech" : "speed",
    shared: probability > SPEED_TECH_DUAL_LOW && probability < SPEED_TECH_DUAL_HIGH,
  };
}

// A jack chart is also a stamina chart when it is long enough that the
// endurance is the other half of what it asks for, which the MSD vector says
// outright: the jack override took the tile from an argmax that was Stamina or
// Handstream. STRONG 280 [4K] Conflagration (3798537) is the case that named
// the rule - 4:13 of Stamina 25.50 over Jumpstream 25.39, filed jack on a
// chordjack score of 0.79 and 45% jack cluster importance - and 4K players
// read it as both.
//
// It is deliberately narrow: 1.5% of a random 6,000-chart sample of the 4K
// library, and the overlap only runs one way, since the jack veto
// (STAMINA_TILE_JACK_VETO_SHARE) already keeps a jack-contaminated chart off
// the stamina tile by every other route.
const JACK_STAMINA_ENDURANCE_SKILLSETS = ["Stamina", "Handstream"];

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

// How far the strongest OTHER base skillset may sit under Stream and still let
// a length-qualified Stamina argmax hold the tile. The hold first shipped
// demanding Technical outrank Stream outright, which read Stream in third
// place as proof the chart was a speed file - but on a marathon it is just as
// often the argmax noise the near-tie exists to absorb, only ordered the other
// way. Demiourgos [4K] (3264851) is the measured case: 6:27 at 274 BPM of
// Stamina 29.18 / Stream 29.05 / Technical 28.71, a chart nobody calls a speed
// file, filed under speed because Technical missed Stream by a third of a
// point.
//
// The rival is the best of Technical, Jumpstream and Handstream rather than
// Technical alone, because a marathon's second reading is not always tech.
// Gate Openerz [4K] Christina (2134877) is the measured case: 4:16 of Stamina
// 22.09 / Jumpstream 22.00 / Stream 21.32 / Technical 18.82, so Stream is only
// third and yet Technical missed it by 2.5 and handed a jumpstream marathon to
// the speed tile. The jack families stay out: a marathon whose second reading
// is jack is not endurance, and the jack override and share veto already
// answer for it.
//
// 0.5 of MSD is the line: it covers argmax noise without reaching charts where
// Stream genuinely leads. Measured 2026-08-29 over the mapper-named 4K pack
// corpora (scripts/dev/tile-variant-sweep.ts): the stamina corpus (1,036) goes
// 68.2% -> 68.5% stamina-tiled and the speed corpus (1,088) loses 5 charts
// (77.0% -> 76.6%), all of them 4:00+ speed-training files with a Stamina
// argmax; stream (623) and tech (418) lose one each, and handstream,
// jumpstream and jack do not move at all. Widening the rival to the other two
// skillsets on 2026-08-30 moved nothing in any labelled corpus and three
// charts in the random one. Widening the band to the full near-tie (1.25) or
// dropping the demand entirely costs the speed corpus 14 and 28 charts, and
// holding unconditionally past a longer gate is worse at every length tried
// (5:00 costs 15, 6:00 costs 9) because it reaches charts where Stream leads
// by more than noise. Re-measure the speed corpus before widening this.
const STAMINA_HOLD_BASE_BAND = 0.5;

// The skillsets that can stand in for Stream in the hold above.
const STAMINA_HOLD_RIVALS = ["Technical", "Jumpstream", "Handstream"];
function staminaHoldRival(values: Record<string, number> | undefined): number {
  return Math.max(...STAMINA_HOLD_RIVALS.map((skillset) => Number(values?.[skillset] ?? 0)));
}

// How far under the top skillset Handstream may sit and still call the chart
// handstream, on a chart LeoBlack's headline label names handstream. It shares
// SPEED_NEAR_TIE_MSD rather than inventing a second number: the two answer the
// same question, which is how far apart these skillsets have to be before the
// gap means anything.
//
// The label gate is what keeps it cheap. Ungated it costs the mapper-named
// tech corpus 8 charts (46.4% -> 44.6% tech-tiled); gated it moves at most one
// chart in any labelled corpus.
//
// The ceiling is Matusa Bomber, not a corpus. Its [4K] 1.25 diff (4189255) is
// handstream-labelled and rates Technical 33.46 / Stream 33.10 / Stamina 33.10
// / Handstream 32.47, a Handstream gap of 0.99 on a chart 4K players call
// tech, so the band has to stay under that or the handstream rule eats the
// tech-lead rule's own labelled set. That is what this number is: as much of
// the Hold Angel correction as can be had without reopening Matusa. It first
// shipped at SPEED_NEAR_TIE_MSD (1.25) and did reopen it; the test fixture
// carried no handstream label, so the suite did not catch it.
//
// Measured over Hold Angel's 374 stored plays: 291 filed stamina before the
// rule, 351 at 0.5, 354 here, 364 at 1.25 (which loses Matusa 1.25) and all
// 374 at 2.0 (which loses Matusa 1.05 as well).
const HANDSTREAM_NEAR_TIE_MSD = 0.95;

/** Whether LeoBlack's jack clusters carry too much of a chart to call it endurance. */
function jackContaminated(jackShare: number | null): boolean {
  return jackShare != null && jackShare >= STAMINA_TILE_JACK_VETO_SHARE;
}

// Everything that is not one of the two endurance readings, for a chart whose
// jack share disqualifies both.
const RICE_MSD_SKILLSETS = SKILL_RATING_SKILLSETS.filter(
  (skillset) => skillset !== "Overall" && skillset !== "Stamina" && skillset !== "Handstream",
);

// The base skillsets, i.e. everything the stamina rider rides on top of.
const BASE_MSD_SKILLSETS = SKILL_RATING_SKILLSETS.filter(
  (skillset) => skillset !== "Overall" && skillset !== "Stamina",
);

/**
 * The strongest skillset other than Jumpstream, which picks the tile for a
 * Jumpstream argmax LeoBlack's label cannot resolve (see the arbitration in
 * bucketsForClear). A jack-contaminated chart cannot pick an endurance
 * runner-up, the same veto every other stamina entry path carries. Null values
 * fall back to Jumpstream itself, i.e. the legacy tech pairing.
 */
function jumpstreamRunnerUp(values: Record<string, number> | undefined, contaminated: boolean): string {
  const pool = SKILL_RATING_SKILLSETS.filter((skillset) => skillset !== "Overall"
    && skillset !== "Jumpstream"
    && !(contaminated && (skillset === "Stamina" || skillset === "Handstream")));
  return dominantSkillset(pickSkillsets(values, pool)) ?? "Jumpstream";
}

/**
 * The skillset a play is filed under, which is its strongest EXCEPT that Stream
 * wins from within SPEED_NEAR_TIE_MSD of the top, a speed verdict yields to
 * tech when Technical is in the same band and the analyzer confidently calls
 * the chart tech (TECH_NEAR_TIE_MIN_SCORE) or when Technical simply outranks
 * Stream on a tech-tagged chart (TECH_NEAR_TIE_MSD_LEAD), Handstream wins from
 * within HANDSTREAM_NEAR_TIE_MSD of the top on a chart LeoBlack reads as
 * handstream, and Stamina has to earn it on length - though a Stamina argmax
 * that HAS earned it holds the tile against the near-tie when some other base
 * skillset stays beside Stream (the hold below). Still single-valued: the
 * second tile, where a chart earns one, is added by resolveTilesForClear.
 *
 * `lengthSeconds` is the chart's drain at 1.0x and `rate` the speed it was
 * played at. The gate takes the LONGER of the two readings: a chart whose 1.0x
 * drain is 4:00+ stays stamina even when a 1.5x run compresses it to 3:20
 * (uprating a marathon does not make it stop being one), and a downrate that
 * stretches a shorter chart past 4:00 still earns the tile on the time it
 * actually lasted. An unknown length leaves the old behaviour rather than
 * guessing a chart short. `chartTechScore` is the chart's stored analyzer
 * tech score (ChartSkillInfo.techScore), 0 when no analysis is stored, and
 * `chartHandstreamCluster` whether LeoBlack's headline label names handstream.
 */
function bucketingSkillset(
  values: Record<string, number> | undefined,
  lengthSeconds: number | null = null,
  rate = 1,
  chartTechScore = 0,
  chartJackShare: number | null = null,
  chartHandstreamCluster = false,
): string | null {
  const top = dominantSkillset(values);
  if (top == null) return top;
  const stream = Number(values?.Stream ?? 0);
  // Whether the play demanded endurance, the same reading the length gate at
  // the bottom uses: the LONGER of the 1.0x drain and the played time.
  const endurance = enduranceSeconds(lengthSeconds, rate);
  const demandsEndurance = endurance != null && endurance >= STAMINA_TILE_MIN_LENGTH_SECONDS;
  // A length-qualified Stamina argmax holds the tile before the speed near-tie
  // can reach it, as long as SOME base skillset stays within
  // STAMINA_HOLD_BASE_BAND of Stream: a pile-up at the top of a marathon is
  // the argmax noise the near-tie exists to absorb, not evidence of a speed
  // file. PEACE BREAKER [4K] FINAL PUNISHMENT (777348) is the measured case:
  // 4:51 of Stamina 30.15 / Technical 30.03 / Stream 30.02, which the near-tie
  // filed under speed on a chart players place between tech and stamina.
  //
  // Measured 2026-08-29 over the mapper-named 4K pack corpora
  // (scripts/dev/tile-variant-sweep.ts): the stamina corpus (1,036 charts)
  // goes 67.1% -> 68.5% stamina-tiled while the speed (1,088), stream (623)
  // and tech (418) corpora each lose a handful of marathon-length charts
  // (0.5-1.1%), inside the 1%-per-corpus line the other overrides hold to.
  // Dropping the demand entirely costs the speed corpus 33 charts (3.1%),
  // mostly pure-stream training marathons, so the band stays narrow.
  if (top === "Stamina" && demandsEndurance
    && staminaHoldRival(values) >= stream - STAMINA_HOLD_BASE_BAND
    && !jackContaminated(chartJackShare)) return top;
  const best = Number(values?.[top] ?? 0);
  // Handstream wins a near-tie the same way Stream does, on a chart LeoBlack
  // itself reads as handstream. Handstream names a pattern rather than riding
  // on one, so a hundredths-level loss to Technical is argmax noise rather
  // than a tech verdict - and MinaCalc's Handstream moves with a play's
  // accuracy, so the same chart filed stamina for one player and tech for the
  // next. Hold Angel [4K] Worship (5339691) is the measured case: Handstream
  // 29.13 / Technical 28.00 as a chart, while plays of it land Technical 19.51
  // over Handstream 19.45.
  //
  // The band does not rescue every play of it, and cannot: measured over the
  // 374 stored plays of that chart, 291 filed stamina before this rule and 364
  // after. The 10 that stay on tech are all downrated (0.75x), where the calc
  // shifts the whole vector off Handstream by up to 1.92 - past any band that
  // still means "argmax noise". A rate that changes what the calc reads is a
  // different problem from a rate that changes what it ranks, and this rule
  // only claims the second.
  if (top !== "Handstream" && chartHandstreamCluster && !jackContaminated(chartJackShare)) {
    const handstream = Number(values?.Handstream ?? 0);
    if (handstream > 0 && handstream >= best - HANDSTREAM_NEAR_TIE_MSD) return "Handstream";
  }
  const nearTie = top === "Stream" || (stream > 0 && stream >= best - SPEED_NEAR_TIE_MSD)
    ? "Stream"
    : top;
  if (nearTie === "Stream") {
    const technical = Number(values?.Technical ?? 0);
    const techBacked = chartTechScore >= TECH_NEAR_TIE_MIN_SCORE
      && technical > 0
      && technical >= stream - SPEED_NEAR_TIE_MSD;
    // The low-tech-score arm (TECH_NEAR_TIE_MSD_LEAD): Technical has to be
    // ahead of Stream rather than merely beside it, and the chart has to wear
    // the tech tag.
    const leadBacked = chartTechScore >= PATTERN_TAG_MIN_SCORE
      && technical > 0
      && technical - stream >= TECH_NEAR_TIE_MSD_LEAD;
    return techBacked || leadBacked ? "Technical" : "Stream";
  }
  // Handstream normally holds the tile at any length because it names a
  // pattern rather than riding on one, but a jack-contaminated chart is not
  // the pattern it claims (STAMINA_TILE_JACK_VETO_SHARE), so it re-files
  // without either endurance skillset.
  if (nearTie === "Handstream" && jackContaminated(chartJackShare)) {
    return bucketingSkillset(pickSkillsets(values, RICE_MSD_SKILLSETS), null, 1, chartTechScore, chartJackShare, chartHandstreamCluster);
  }
  if (nearTie !== "Stamina" || lengthSeconds == null) return nearTie;
  if (demandsEndurance && !jackContaminated(chartJackShare)) return nearTie;
  return bucketingSkillset(pickSkillsets(values, BASE_MSD_SKILLSETS), null, 1, chartTechScore, chartJackShare, chartHandstreamCluster);
}

/**
 * How long a play asks for, in seconds: the LONGER of the chart's 1.0x drain
 * and the time the play actually lasted at its rate. Null when the length is
 * unknown. Both length rules read this, so an uprated marathon and a downrated
 * short file are judged the same way wherever the question comes up.
 */
function enduranceSeconds(lengthSeconds: number | null, rate: number): number | null {
  if (lengthSeconds == null) return null;
  const played = lengthSeconds / (Number.isFinite(rate) && rate > 0 ? rate : 1);
  return Math.max(lengthSeconds, played);
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
  const top = bucketingSkillset(values, lengthSeconds, rate, chart?.techScore ?? 0, chart?.jackShare ?? null, chart?.handstreamCluster === true);
  return bucketsForClear(danSkillsetBuckets(keyCount, side), top, chart, values, rate).map((bucket) => bucket.id);
}

// A pre-rated upload bakes its rate into the notes, so its stored length IS the
// rated length and the 1.0x drain the stamina gate wants is gone. That splits
// two identical clears: a 5:16 marathon played with a rate mod keeps the tile
// (bucketingSkillset judges it on the base drain), while the same chart
// uploaded as a standalone 1.4x file at 3:46 loses it.
//
// The diff name alone cannot fix that - a pack holds unrelated charts, and
// plenty of names carry numbers that are not rates - so the name only PROPOSES
// a rate and the beatmapset has to CONFIRM it: the set must hold another diff
// of the same keymode, parsed hold count and exact osu! object counts at the
// length the proposed rate predicts, within RATE_SIBLING_TOLERANCE. A rate edit
// is its base compressed in time, so that sibling is the base itself and its
// measured length is the answer. Exact object counts matter: rice pack diffs
// normally all have zero holds, which let unrelated songs accidentally confirm
// each other when the hold count was the only structural check.
// FUTURE DOMINATORS [NB5 Hard 54235] is the measured shape: five diffs, all
// 6007 notes, at 317 / 288 / 264 / 244 / 226 seconds, exactly 317 over 1.1,
// 1.2, 1.3 and 1.4.
//
// Re-measured 2026-08-29 after adding the exact-object check
// (scripts/dev/rate-edit-tile-impact.ts): 1,248 short 4K candidates resolve a
// base in the potentially gate-crossing pool and 54 actually change tile, all
// outside the mapper-named corpora. The earlier hold-count-only check moved 94,
// including an unrelated song in a jack practice pack. Deliberately NOT the
// looser rule of taking the set's longest structural sibling as the base: sets
// holding downrates make their slowest diff look like the base, which would
// carry genuinely short charts over the bar.
//
// This only ever feeds the stamina length gate. It rates nothing, and no dan
// verdict reads it.
const RATE_SIBLING_TOLERANCE = 0.02;
const RATE_EDIT_MIN = 1.01;
const RATE_EDIT_MAX = 2.5;
// "1.4x", "x1.05", "[1.15x Rate]", "1,1x" (comma decimals appear in the wild).
const NAMED_RATE_PATTERNS = [
  /(?:^|[^\d.,])(\d(?:[.,]\d{1,3})?)\s*x(?![\w])/i,
  /(?:^|[^\w])x\s*(\d(?:[.,]\d{1,3})?)(?![\d.,])/i,
];

interface RateEditCandidate {
  beatmapId: number;
  setId: number;
  length: number;
  rate: number;
}

/** The uprate a diff name claims, if it reads as one. Null otherwise. */
export function parseNamedRate(version: string): number | null {
  for (const pattern of NAMED_RATE_PATTERNS) {
    const match = pattern.exec(version);
    if (!match) continue;
    const rate = Number(match[1].replace(",", "."));
    if (Number.isFinite(rate) && rate >= RATE_EDIT_MIN && rate <= RATE_EDIT_MAX) return rate;
  }
  return null;
}

/**
 * Replaces a confirmed rate edit's stored length with its base-rate length, so
 * the stamina gate judges the chart the marathon it was cut from. Mutates the
 * `info` map in place; a candidate the set does not confirm is left alone.
 */
async function applyRateEditBaseLengths(
  db: Db,
  info: Map<number, ChartSkillInfo>,
  candidates: RateEditCandidate[],
): Promise<void> {
  if (candidates.length === 0) return;
  const setIds = [...new Set(candidates.map((candidate) => candidate.setId))];
  const siblings = new Map<number, Array<{
    beatmapId: number;
    keyCount: number;
    lnCount: number;
    length: number;
    circleCount: number;
    sliderCount: number;
    spinnerCount: number;
  }>>();
  for (let offset = 0; offset < setIds.length; offset += CHART_SKILL_INFO_QUERY_CHUNK) {
    const chunk = setIds.slice(offset, offset + CHART_SKILL_INFO_QUERY_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    // map_search_index rather than beatmaps: it carries the hold-note count and
    // is indexed on beatmapset_id, which beatmaps is not.
    // `length` MUST stay aliased: a libsql row is array-like, so `row.length`
    // reads the column count rather than the column.
    const rows = (await exec(
      db,
      `select m.beatmap_id, m.beatmapset_id, m.key_count, m.ln_count, m.length as length_seconds,
              json_extract(b.metadata_json, '$.count_circles') as circle_count,
              json_extract(b.metadata_json, '$.count_sliders') as slider_count,
              json_extract(b.metadata_json, '$.count_spinners') as spinner_count
         from map_search_index m
         join beatmaps b on b.beatmap_id = m.beatmap_id
        where m.beatmapset_id in (${placeholders})`,
      chunk,
    )).rows;
    for (const row of rows) {
      const setId = Number(row.beatmapset_id);
      const length = Number(row.length_seconds);
      const circleCount = readBeatmapObjectCount(row.circle_count);
      const sliderCount = readBeatmapObjectCount(row.slider_count);
      const spinnerCount = readBeatmapObjectCount(row.spinner_count);
      if (!Number.isFinite(length) || length <= 0
        || circleCount == null || sliderCount == null || spinnerCount == null) continue;
      const entry = {
        beatmapId: Number(row.beatmap_id),
        keyCount: Number(row.key_count),
        lnCount: Number(row.ln_count),
        length,
        circleCount,
        sliderCount,
        spinnerCount,
      };
      const list = siblings.get(setId);
      if (list) list.push(entry); else siblings.set(setId, [entry]);
    }
  }
  for (const candidate of candidates) {
    const list = siblings.get(candidate.setId);
    const self = list?.find((entry) => entry.beatmapId === candidate.beatmapId);
    if (!list || !self) continue;
    if (self.circleCount + self.sliderCount + self.spinnerCount <= 0) continue;
    const predicted = candidate.length * candidate.rate;
    const confirmed = list
      .filter((entry) =>
        entry.beatmapId !== candidate.beatmapId
        && entry.keyCount === self.keyCount
        && entry.lnCount === self.lnCount
        && entry.circleCount === self.circleCount
        && entry.sliderCount === self.sliderCount
        && entry.spinnerCount === self.spinnerCount
        && Math.abs(entry.length - predicted) <= RATE_SIBLING_TOLERANCE * predicted)
      .sort((left, right) =>
        Math.abs(left.length - predicted) - Math.abs(right.length - predicted)
        || left.beatmapId - right.beatmapId)[0];
    const chart = info.get(candidate.beatmapId);
    if (confirmed && chart) chart.lengthSeconds = Math.round(confirmed.length);
  }
}

/** A non-negative object count from osu!'s beatmap metadata. */
function readBeatmapObjectCount(value: unknown): number | null {
  if (value == null) return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
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
  status: string | null;
}

async function readPlayerSkillPlayMetadata(db: Db, beatmapIds: number[]): Promise<Map<number, PlayerSkillPlayMetadata>> {
  const rows = await selectRowsByIntegerSet(
    db,
    `select b.beatmap_id, b.beatmapset_id, b.version, b.status, s.title, s.artist, s.creator, s.covers_json
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
      status: readBeatmapStatus(row.status),
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
// v22 (current): both credit windows opened (dan-credit.ts, 2026-08-31). 6K/7K
// LN went from one accuracy point under its 95% bar to three, crediting 92-94%
// clears down to -1.75, and the rice ladders went from four points to five,
// crediting 91-92% clears down to -1.5. Nothing that already credited moves in
// either case: each curve carries a knee at the old window's edge and keeps the
// old line above it. Stored verdicts were folded without those clears in the
// window at all, so every row has to be folded again. It takes the full scope
// because the fold is a cheap plays_json derivation with no MinaCalc behind it
// and the change reaches every ladder anyway; the narrower 4k-ln scope stays
// for callers that explicitly want the historical curve-only repair.
//
// Two things every bump here inherits. The sweep re-derives from plays_json
// (plus stored rate verdicts) and never re-rates, so it costs no MinaCalc. And
// until it rewrites a row, that player's badge and leaderboard entry show the
// old number while the evidence modal, which recomputes live, already shows the
// new one. Earlier bumps: `git log -S PLAYER_SKILL_DAN_SWEEP_META_KEY`.
const PLAYER_SKILL_DAN_SWEEP_META_KEY = "player_skill_dan_sweep_done:v22";
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

export type PlayerSkillDanSweepScope = "all" | "4k-ln";

export interface PlayerSkillDanSweepPayload {
  cursor?: number;
  startedAt?: string;
  scope?: PlayerSkillDanSweepScope;
}

async function playerSkillDanDependenciesReady(db: Db): Promise<boolean> {
  const rows = (await exec(
    db,
    "select key from live_meta where key in (?, ?)",
    [JACK_DEMAND_RECOMPUTE_META_KEY, MOTION_FEATURES_RECOMPUTE_META_KEY],
  )).rows;
  return new Set(rows.map((row) => String(row.key))).size === 2;
}

export async function recomputePlayerSkillDanChunk(
  db: Db,
  cursor: number,
  limit = PLAYER_SKILL_DAN_SWEEP_CHUNK,
  scope: PlayerSkillDanSweepScope = "all",
): Promise<PlayerSkillDanSweepChunkResult> {
  // The v17 curve only touches 4K LN. Limit that rollout to rows which even
  // carry a 4K mode; the generic scope remains for repairs whose chart/rate
  // inputs can affect any ladder.
  const scopeFilter = scope === "4k-ln" ? `and modes_json like '%"keyCount":4%'` : "";
  const rows = (await exec(
    db,
    `select user_id, modes_json, plays_json, updated_at from player_skill_ratings
     where user_id > ? and analysis_version = ? and status = 'ready'
       ${scopeFilter}
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
      .filter((play) => play
        && Number.isInteger(play.beatmapId)
        && play.beatmapId > 0
        && (scope === "all" || play.keyCount === 4));
    if (!summary || !Array.isArray(summary.modes) || summary.modes.length === 0 || plays.length === 0) continue;
    if (scope === "4k-ln" && !summary.modes.some((mode) => mode.keyCount === 4)) continue;
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
    const modes = summary.modes.map((mode) => {
      if (scope === "4k-ln") {
        if (mode.keyCount !== 4) return mode;
        const modePlays = playsByKeyCount.get(4) ?? [];
        const lnClears = collectDanClears(4, modePlays, new Map(), infoByBeatmap, rateVerdicts)
          .filter((clear) => clear.side === "ln");
        const ln = danSideFromClears(4, "ln", lnClears, infoByBeatmap, courseClears);
        return { ...mode, dan: { rc: mode.dan?.rc ?? null, ln } };
      }
      return {
        ...mode,
        dan: computeModeDan(mode.keyCount, playsByKeyCount.get(mode.keyCount) ?? [], new Map(), infoByBeatmap, courseClears, rateVerdicts),
      };
    });
    // Pure-RC players and 4K LN verdicts which happen to land on the same
    // value need no write. Their old row remains visible throughout the pass.
    if (scope === "4k-ln" && json(modes) === json(summary.modes)) continue;
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
  // The fold consumes classification_json.jackDemand and .motion. Starting
  // before either chart-side cached-.osu sweep finishes would permanently bake
  // a half-patched corpus into the done marker; each finishing worker calls
  // this seeder again after stamping its dependency.
  if (!(await playerSkillDanDependenciesReady(db))) return;
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
  // Jack demand and motion both change 4K RC filing, so the current rollout
  // needs the full fold. The narrower 4K-LN scope remains available to callers
  // that explicitly request the historical curve-only repair.
  await enqueuePlayerSkillDanSweep(queue, 0, "all");
}

/** True when a rate-verdict producer stamped its done key after this dan pass began. */
async function rateVerdictsLandedAfter(db: Db, doneJson: string): Promise<boolean> {
  const sweptAt = parseJson<{ finishedAt?: unknown }>(doneJson, {}).finishedAt;
  for (const key of [HT_RATE_ANALYSIS_META_KEY, SUNNY_REPIN_DT_META_KEY, LN7_PRIMARY_REPIN_META_KEY]) {
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
  payload: PlayerSkillDanSweepPayload | undefined,
): Promise<void> {
  // A queued job can survive a deploy that introduced a new chart-side
  // dependency. Decline to stamp the new done key if such an old job is
  // claimed early; the dependency's finishing worker will seed a fresh pass.
  if (!(await playerSkillDanDependenciesReady(db))) return;
  const cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  // Missing/invalid scope means the legacy full pass. This makes already
  // queued pre-deploy jobs safe when the worker starts running the new code.
  const scope: PlayerSkillDanSweepScope = payload?.scope === "4k-ln" ? "4k-ln" : "all";
  // Carried from the first chunk so the done key can be stamped with when the
  // sweep began reading, not when it stopped: see below.
  const startedAt = typeof payload?.startedAt === "string" ? payload.startedAt : nowIso();
  const result = await recomputePlayerSkillDanChunk(db, cursor, PLAYER_SKILL_DAN_SWEEP_CHUNK, scope);
  if (result.rewritten > 0) {
    logInfo("player_skill_dan_sweep_chunk", { users: result.rewritten, cursor: result.nextCursor, scope });
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
      await enqueuePlayerSkillDanSweep(queue, 0, "all", undefined, true);
    }
    return;
  }
  await enqueuePlayerSkillDanSweep(queue, result.nextCursor, scope, startedAt);
}

async function enqueuePlayerSkillDanSweep(
  queue: JobQueue,
  cursor: number,
  scope: PlayerSkillDanSweepScope,
  startedAt?: string,
  rateVerdictRestart = false,
): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILL_DAN_SWEEP_JOB,
    rateVerdictRestart ? `${PLAYER_SKILL_DAN_SWEEP_JOB}:rate-verdict-restart` : `${PLAYER_SKILL_DAN_SWEEP_JOB}:${cursor}`,
    { cursor, startedAt: startedAt ?? nowIso(), scope },
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
