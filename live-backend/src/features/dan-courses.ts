import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { danTableLevelForLabel } from "../dan/chart-classifier.js";
import { danLevelForLabel } from "../dan/dan-estimator/labels.js";
import { LN_LADDER_TOP } from "../dan/dan-estimator/ln.js";
import { calculateScoreV2Accuracy, calculateStableAccuracy, getDisplayedAccuracy, getDisplayedTotalScore, isLazerScore, scoreHasReplay } from "../shared/score.js";
import type { OscScore, OsuMod } from "../shared/types.js";

// The real dan courses, by beatmap id.
//
// This is the ONE place in the codebase that names charts by identity, and it
// is deliberately not a classification shortcut: nothing here changes what a
// chart is rated. It exists at the player layer, where a course is not a chart
// but an exam - the community says "clearing this map at this accuracy IS
// gamma dan", and a player who has passed that exam should not read as beta
// because the average of their skillset dans happens to land there. Chart
// classification stays algorithmic; see the note in CLAUDE.md.
//
// One upload per course, chosen rather than judged: several of these packs also
// exist as re-uploads (Dan ~ REFORM ~ 2nd Pack sits under MrLanguage,
// jhlee0112, headpriest and Bbrak too), and leaving one out says nothing about
// it beyond that nobody has added it yet. Another is one line, after checking
// it really is the same chart rather than an edit or a rate shift.
//
// The reader-facing half of this list is COURSE_PACKS in
// src/routes/dan-estimates.tsx, which links the same six packs from the step
// that explains the rule. The two move together: a pack added here needs a link
// there, or the page claims a completeness it no longer has.

export type DanCourseSide = "rc" | "ln";

export interface DanCourse {
  beatmapId: number;
  keyCount: number;
  side: DanCourseSide;
  /**
   * The bare ladder label the community calls this course, with no +/- variant
   * ("epsilon", "10", "gamma", "terra"). Resolved to a number through the same
   * ladder the label is printed back from, so a table change moves both ends
   * together instead of silently shifting every course by one level.
   */
  level: string;
  /** What the evidence surface names, e.g. "Dan ~ REFORM ~ EXTRA-EPSILON". */
  courseName: string;
}

const REFORM = "Dan ~ REFORM ~";

const DAN_COURSES: DanCourse[] = [
  // 4K rice - Dan ~ REFORM ~ (Thaumiel). The greek levels are the 4K ladder's
  // own (alpha = 11 .. eta = 17). INTRO-1st/2nd/3rd (2259508/9/10) are left out:
  // they sit below the ladder's level 1 and there is nothing there to credit.
  { beatmapId: 2259503, keyCount: 4, side: "rc", level: "1", courseName: `${REFORM} 1st` },
  { beatmapId: 2259504, keyCount: 4, side: "rc", level: "2", courseName: `${REFORM} 2nd` },
  { beatmapId: 2259505, keyCount: 4, side: "rc", level: "3", courseName: `${REFORM} 3rd` },
  { beatmapId: 2259506, keyCount: 4, side: "rc", level: "4", courseName: `${REFORM} 4th` },
  { beatmapId: 2259507, keyCount: 4, side: "rc", level: "5", courseName: `${REFORM} 5th` },
  // 6th exists in both packs; both are the course.
  { beatmapId: 2588623, keyCount: 4, side: "rc", level: "6", courseName: `${REFORM} 6th` },
  { beatmapId: 2259540, keyCount: 4, side: "rc", level: "6", courseName: `${REFORM} 6th` },
  { beatmapId: 2259541, keyCount: 4, side: "rc", level: "7", courseName: `${REFORM} 7th` },
  { beatmapId: 2259542, keyCount: 4, side: "rc", level: "8", courseName: `${REFORM} 8th` },
  { beatmapId: 2259543, keyCount: 4, side: "rc", level: "9", courseName: `${REFORM} 9th` },
  { beatmapId: 2259539, keyCount: 4, side: "rc", level: "10", courseName: `${REFORM} 10th` },
  { beatmapId: 2259544, keyCount: 4, side: "rc", level: "alpha", courseName: `${REFORM} EXTRA-ALPHA` },
  { beatmapId: 2259545, keyCount: 4, side: "rc", level: "beta", courseName: `${REFORM} EXTRA-BETA` },
  { beatmapId: 2259548, keyCount: 4, side: "rc", level: "gamma", courseName: `${REFORM} EXTRA-GAMMA` },
  { beatmapId: 2259546, keyCount: 4, side: "rc", level: "delta", courseName: `${REFORM} EXTRA-DELTA` },
  { beatmapId: 2259547, keyCount: 4, side: "rc", level: "epsilon", courseName: `${REFORM} EXTRA-EPSILON` },
  { beatmapId: 2738788, keyCount: 4, side: "rc", level: "zeta", courseName: `${REFORM} FINAL-ZETA` },
  { beatmapId: 2738787, keyCount: 4, side: "rc", level: "eta", courseName: `${REFORM} FINAL-ETA` },

  // 4K LN - _underjoy's 4K LN Dan Courses v2, then the two extra-level courses
  // that carried the ladder past 15 (hypersovae's Yokaze, Lnlism's Yeehee).
  { beatmapId: 1862813, keyCount: 4, side: "ln", level: "1", courseName: "4K LN Dan 1st" },
  { beatmapId: 1862814, keyCount: 4, side: "ln", level: "2", courseName: "4K LN Dan 2nd" },
  { beatmapId: 1862815, keyCount: 4, side: "ln", level: "3", courseName: "4K LN Dan 3rd" },
  { beatmapId: 1862816, keyCount: 4, side: "ln", level: "4", courseName: "4K LN Dan 4th" },
  { beatmapId: 1862832, keyCount: 4, side: "ln", level: "5", courseName: "4K LN Dan 5th" },
  { beatmapId: 1862833, keyCount: 4, side: "ln", level: "6", courseName: "4K LN Dan 6th" },
  { beatmapId: 1862834, keyCount: 4, side: "ln", level: "7", courseName: "4K LN Dan 7th" },
  { beatmapId: 1862842, keyCount: 4, side: "ln", level: "8", courseName: "4K LN Dan 8th" },
  { beatmapId: 1862843, keyCount: 4, side: "ln", level: "9", courseName: "4K LN Dan 9th" },
  { beatmapId: 1862841, keyCount: 4, side: "ln", level: "10", courseName: "4K LN Dan 10th" },
  { beatmapId: 1862874, keyCount: 4, side: "ln", level: "11", courseName: "4K LN Dan 11th - Yoake" },
  { beatmapId: 1862875, keyCount: 4, side: "ln", level: "12", courseName: "4K LN Dan 12th - Yuugure" },
  { beatmapId: 1862876, keyCount: 4, side: "ln", level: "13", courseName: "4K LN Dan 13th - Yoru" },
  { beatmapId: 2332319, keyCount: 4, side: "ln", level: "14", courseName: "4K LN Dan 14th - Yami" },
  { beatmapId: 2332320, keyCount: 4, side: "ln", level: "15", courseName: "4K LN Dan 15th - Yume" },
  { beatmapId: 4767800, keyCount: 4, side: "ln", level: "16", courseName: "4K LN Dan 16th - Yokaze" },
  { beatmapId: 5029140, keyCount: 4, side: "ln", level: "17", courseName: "4K LN Dan 17th - Yeehee" },

  // 7K rice - Jinjin's Regular Dan Phases I-III and Phase IV.
  { beatmapId: 965651, keyCount: 7, side: "rc", level: "0", courseName: "7K Regular Dan 0th" },
  { beatmapId: 965652, keyCount: 7, side: "rc", level: "1", courseName: "7K Regular Dan 1st" },
  { beatmapId: 965653, keyCount: 7, side: "rc", level: "2", courseName: "7K Regular Dan 2nd" },
  { beatmapId: 965654, keyCount: 7, side: "rc", level: "3", courseName: "7K Regular Dan 3rd" },
  { beatmapId: 969187, keyCount: 7, side: "rc", level: "4", courseName: "7K Regular Dan 4th" },
  { beatmapId: 969188, keyCount: 7, side: "rc", level: "5", courseName: "7K Regular Dan 5th" },
  { beatmapId: 969189, keyCount: 7, side: "rc", level: "6", courseName: "7K Regular Dan 6th" },
  { beatmapId: 969190, keyCount: 7, side: "rc", level: "7", courseName: "7K Regular Dan 7th" },
  { beatmapId: 1673133, keyCount: 7, side: "rc", level: "8", courseName: "7K Regular Dan 8th" },
  { beatmapId: 1942650, keyCount: 7, side: "rc", level: "9", courseName: "7K Regular Dan 9th" },
  { beatmapId: 1966467, keyCount: 7, side: "rc", level: "10", courseName: "7K Regular Dan 10th" },
  { beatmapId: 1979885, keyCount: 7, side: "rc", level: "gamma", courseName: "7K Regular Gamma Dan" },
  { beatmapId: 2030894, keyCount: 7, side: "rc", level: "azimuth", courseName: "7K Regular Azimuth Dan" },
  { beatmapId: 2194084, keyCount: 7, side: "rc", level: "zenith", courseName: "7K Regular Zenith Dan" },
  { beatmapId: 2221603, keyCount: 7, side: "rc", level: "stellium", courseName: "7K Regular Stellium Dan" },

  // 7K LN - Jinjin's LN Dan Phases I-III and Phase IV. Phase I's 0th/1st/2nd
  // (966813/4/5) are left out: the 7K LN interval table opens at LN 3, so a
  // credit below it would clamp UP to the table's first label and read as more
  // than the player showed rather than less.
  { beatmapId: 966816, keyCount: 7, side: "ln", level: "3", courseName: "7K LN Dan 3rd" },
  { beatmapId: 1875999, keyCount: 7, side: "ln", level: "4", courseName: "7K LN Dan 4th" },
  { beatmapId: 1872112, keyCount: 7, side: "ln", level: "5", courseName: "7K LN Dan 5th" },
  { beatmapId: 1872902, keyCount: 7, side: "ln", level: "6", courseName: "7K LN Dan 6th" },
  { beatmapId: 1870418, keyCount: 7, side: "ln", level: "7", courseName: "7K LN Dan 7th" },
  { beatmapId: 1877529, keyCount: 7, side: "ln", level: "8", courseName: "7K LN Dan 8th" },
  { beatmapId: 2539251, keyCount: 7, side: "ln", level: "9", courseName: "7K LN Dan 9th" },
  { beatmapId: 2545327, keyCount: 7, side: "ln", level: "10", courseName: "7K LN Dan 10th" },
  { beatmapId: 2556940, keyCount: 7, side: "ln", level: "gamma", courseName: "7K LN Gamma Dan" },
  { beatmapId: 2570281, keyCount: 7, side: "ln", level: "azimuth", courseName: "7K LN Azimuth Dan" },
  { beatmapId: 2764028, keyCount: 7, side: "ln", level: "zenith", courseName: "7K LN Zenith Dan" },
  { beatmapId: 3170990, keyCount: 7, side: "ln", level: "stellium", courseName: "7K LN Stellium Dan" },

  // 6K rice - Arkman's 6K Regular Dan Course, Parts I-III. The older
  // "6k Insane Dan Course II" (903975) is the superseded cut of Part II's
  // 4th-6th and is not registered.
  { beatmapId: 3197348, keyCount: 6, side: "rc", level: "0", courseName: "6K Regular Start Dan" },
  { beatmapId: 2335444, keyCount: 6, side: "rc", level: "1", courseName: "6K Regular Dan 1st" },
  { beatmapId: 2335445, keyCount: 6, side: "rc", level: "2", courseName: "6K Regular Dan 2nd" },
  { beatmapId: 2335446, keyCount: 6, side: "rc", level: "3", courseName: "6K Regular Dan 3rd" },
  { beatmapId: 3479168, keyCount: 6, side: "rc", level: "4", courseName: "6K Regular Dan 4th" },
  { beatmapId: 3479169, keyCount: 6, side: "rc", level: "5", courseName: "6K Regular Dan 5th" },
  { beatmapId: 3479170, keyCount: 6, side: "rc", level: "6", courseName: "6K Regular Dan 6th" },
  { beatmapId: 3770229, keyCount: 6, side: "rc", level: "7", courseName: "6K Regular Dan 7th" },
  { beatmapId: 3770230, keyCount: 6, side: "rc", level: "8", courseName: "6K Regular Dan 8th" },
  { beatmapId: 3770231, keyCount: 6, side: "rc", level: "9", courseName: "6K Regular Dan 9th" },

  // 6K LN - [Crz]sunnyxxy's 6K LN Dan Course, Lower/Upper/Extra bands.
  { beatmapId: 2507666, keyCount: 6, side: "ln", level: "0", courseName: "6K LN Start Dan" },
  { beatmapId: 2507667, keyCount: 6, side: "ln", level: "1", courseName: "6K LN Dan 1st" },
  { beatmapId: 2507668, keyCount: 6, side: "ln", level: "2", courseName: "6K LN Dan 2nd" },
  { beatmapId: 2507669, keyCount: 6, side: "ln", level: "3", courseName: "6K LN Dan 3rd" },
  { beatmapId: 2507670, keyCount: 6, side: "ln", level: "4", courseName: "6K LN Dan 4th" },
  { beatmapId: 2565958, keyCount: 6, side: "ln", level: "5", courseName: "6K LN Dan 5th" },
  { beatmapId: 2565959, keyCount: 6, side: "ln", level: "6", courseName: "6K LN Dan 6th" },
  { beatmapId: 2565960, keyCount: 6, side: "ln", level: "7", courseName: "6K LN Dan 7th" },
  { beatmapId: 2565961, keyCount: 6, side: "ln", level: "8", courseName: "6K LN Dan 8th" },
  { beatmapId: 2565962, keyCount: 6, side: "ln", level: "9", courseName: "6K LN Dan 9th" },
  { beatmapId: 2609884, keyCount: 6, side: "ln", level: "terra", courseName: "6K LN Terra Dan" },
  { beatmapId: 2609885, keyCount: 6, side: "ln", level: "celestial", courseName: "6K LN Celestial Dan" },
  { beatmapId: 2609886, keyCount: 6, side: "ln", level: "mystery", courseName: "6K LN Mystery Dan" },
  { beatmapId: 2609887, keyCount: 6, side: "ln", level: "nihility", courseName: "6K LN Nihility Dan" },
  { beatmapId: 2609888, keyCount: 6, side: "ln", level: "finish", courseName: "6K LN Finish Dan" },
];

/**
 * The numeric level a registered course's label sits on, taken from the ladder
 * that keymode and side is labelled with (danLabelFor's own sources): the
 * leoblack interval tables for 6K/7K, DAN_LABELS for 4K rice, the numeric LN
 * ladder for 4K LN. Null when the label is not on that ladder, which the
 * registry test turns into a build failure rather than a silent miscredit.
 */
export function danCourseLevelFor(course: DanCourse): number | null {
  if (course.keyCount !== 4) return danTableLevelForLabel(course.level, course.side, course.keyCount);
  if (course.side === "ln") {
    const level = Number(course.level);
    return Number.isInteger(level) && level >= 1 && level <= LN_LADDER_TOP ? level : null;
  }
  return danLevelForLabel(course.level);
}

const COURSES_BY_BEATMAP = new Map<number, DanCourse>();
for (const course of DAN_COURSES) COURSES_BY_BEATMAP.set(course.beatmapId, course);

export function listDanCourses(): readonly DanCourse[] {
  return DAN_COURSES;
}

export function danCourseForBeatmap(beatmapId: number): DanCourse | undefined {
  return COURSES_BY_BEATMAP.get(beatmapId);
}

// Mods that make a course run not the course. EZ and NF remove the failure the
// exam is, HT/DC and any sub-1.0 rate play a different chart, Random redeals
// the patterns, and the automation mods are not the player. Everything the
// course rules do allow (Mirror, HD/FI, FL, HR, SD/PF, DT/NC) is left alone:
// under a floor rule, crediting a harder run at the course's own level is a
// lower bound, not a claim about what the rate was worth.
//
// The key mods are in the list for completeness rather than because they can
// happen: osu! only offers them on converts, and every registered course is a
// map made for mania. They cost one set lookup to refuse and would be the
// right answer if a course ever were a convert.
const DISALLOWED_COURSE_MODS = new Set([
  "EZ", "NF", "HT", "DC", "RD", "AT", "CN", "SO", "RX", "AP", "WU", "WD", "AS", "DP",
  "1K", "2K", "3K", "4K", "5K", "6K", "7K", "8K", "9K", "10K",
]);

/**
 * Whether a play's mods leave the course intact. `null` mods means the play's
 * mods were never recorded, which is not the same as "no mods": the 2-year
 * activity archive has rows predating best_mods_json, and on the REFORM extra
 * dans alone a fifth of the passes above the bar are HT runs. An unverifiable
 * play credits nothing; the archived-mods backfill fills those rows in time.
 */
export function danCourseModsAllowed(mods: OsuMod[] | null | undefined): boolean {
  if (!Array.isArray(mods)) return false;
  for (const mod of mods) {
    const acronym = (typeof mod === "string" ? mod : String(mod?.acronym ?? "")).toUpperCase();
    if (DISALLOWED_COURSE_MODS.has(acronym)) return false;
    const speed = typeof mod === "string" ? null : mod?.settings?.speed_change;
    if (speed != null && !(Number(speed) >= 1)) return false;
  }
  return true;
}

// How far above or below the course's own pass bar an accuracy sits, in
// credited levels. A course is pass/fail in game, but the ladders' own
// vocabulary is finer than that: barely scraping gamma and overclearing it are
// not the same demonstration, and the dan chips already have the +/- tiers to
// say so. The anchors are placed on parseDan's variant thresholds, relative to
// whatever bar that ladder sets (danClearBarFor), so 4K rice reads:
//
//   94.0% (bar - 2.0) -> -0.50 -> "delta--"
//   94.6% (bar - 1.4) -> -0.46 -> "delta--"
//   95.0% (bar - 1.0) -> -0.44 -> "delta-"
//   95.9% (just under) -> -0.26 -> "delta-"
//   96.0% (the bar)   ->  0.00 -> "delta"
//   97.5% (bar + 1.5) -> +0.11 -> "delta+"
//   98.0% (bar + 2.0) -> +0.28 -> "delta++"
//   99.5% (bar + 3.5) -> +0.45 -> "delta++" (the cap)
//
// The jump at the bar is on purpose. Below it the scale stops at -0.26, one
// hundredth inside the "-" tier, so a run that missed the bar can never print
// as a bare level: 94.59% on a 95% course is not an 8th dan clear and must not
// read as one. Above it the scale starts at 0. Passing and not passing is the
// one genuinely discrete thing on this whole page, and the label says so.
//
// The sub-bar band has its own knee a full point under the bar, because the
// two minus tiers split at -0.45 and a straight line from -0.50 to -0.26 gives
// "--" only the first 0.4 of a point: 94.63% on a 96% course came out "-",
// which reads as a near miss when it is a point and a half short. The knee
// puts the boundary where a reader would put it, at one point under.
//
// Every anchor sits just inside its tier (-0.26, +0.11, +0.28) rather than on
// the -0.25, +0.10 and +0.26 thresholds: an anchor ON the boundary lands a
// hundredth outside it once the accuracy subtraction and the level subtraction
// have each rounded, so 97.5% read back as a bare "delta".
//
// The cap stays under +0.5 because the label rounds: +0.5 would land on the
// NEXT level's "--" and read as a course the player never touched. The bottom
// anchor is exactly -0.5 for the same reason in reverse, which Math.round's
// half-up puts back on this level's "--" (and 0.5 is exact in binary, so it
// needs no margin).
const CREDIT_EDGE_TOLERANCE = 1e-9;

// The sub-bar scale, which never reaches 0: its top anchor is the accuracy an
// epsilon under the bar, and the bar itself is the first entry of the other.
const COURSE_CREDIT_BELOW_BAR: Array<[deltaFromBar: number, offset: number]> = [
  [-0.02, -0.5],
  [-0.01, -0.44],
  [0, -0.26],
];

const COURSE_CREDIT_ANCHORS: Array<[deltaFromBar: number, offset: number]> = [
  [0, 0],
  [0.015, 0.11],
  [0.02, 0.28],
  [0.035, 0.45],
];

/**
 * The credited level offset for an accuracy, or null when it is too far under
 * the bar to credit anything. `allowBelowBar` is off for ladders whose labeler
 * has no minus tier to render the result in (4K LN), where a sub-bar credit
 * would round back up and read as a full clear.
 */
export function danCourseCreditOffset(accuracy: number, bar: number, allowBelowBar: boolean): number | null {
  const floor = COURSE_CREDIT_BELOW_BAR[0];
  const raw = accuracy - bar;
  // Both sides are decimals, so a pass sitting exactly ON an edge subtracts to
  // a hair under it: 0.94 - 0.96 is -0.020000000000000018, which would fall off
  // the bottom anchor and credit nothing. The tolerance is float slack, not a
  // grace band, so it is a billionth rather than a hundredth.
  if (!allowBelowBar && raw < -CREDIT_EDGE_TOLERANCE) return null;
  if (raw < floor[0] - CREDIT_EDGE_TOLERANCE) return null;
  const delta = Math.max(floor[0], raw);
  if (delta <= floor[0]) return floor[1];
  const anchors = delta < -CREDIT_EDGE_TOLERANCE ? COURSE_CREDIT_BELOW_BAR : COURSE_CREDIT_ANCHORS;
  if (anchors === COURSE_CREDIT_ANCHORS && delta <= 0) return anchors[0][1];
  for (let i = 1; i < anchors.length; i += 1) {
    const [upperDelta, upperOffset] = anchors[i];
    if (delta > upperDelta) continue;
    const [lowerDelta, lowerOffset] = anchors[i - 1];
    const span = upperDelta - lowerDelta;
    const t = span > 0 ? (delta - lowerDelta) / span : 1;
    return lowerOffset + (upperOffset - lowerOffset) * t;
  }
  return anchors[anchors.length - 1][1];
}

/** One verified course run, in the shape the dan headline floors against. */
/** The play a credit came off, in the shape the details card reads. */
export interface DanCoursePlay {
  scoreId: number | null;
  soloScoreId: number | null;
  legacyScoreId: number | null;
  mods: OsuMod[];
  statistics: OscScore["statistics"] | null;
  maxCombo: number | null;
  totalScore: number | null;
  rank: string | null;
  playedAt: string | null;
  hasReplay: boolean | null;
  /**
   * Whether the run was submitted from lazer, which decides which id space
   * `scoreId` is in and therefore which osu! score URL resolves. The archive
   * rows do not record it, so it falls back to the accuracy tell: a stable
   * score displays the stable formula, a lazer one displays ScoreV2, so a
   * displayed accuracy that differs from the recomputed stable one is lazer.
   */
  isLazer: boolean | null;
}

export interface DanCourseClear {
  keyCount: number;
  side: DanCourseSide;
  beatmapId: number;
  courseName: string;
  /** The course's own ladder label, before the accuracy offset. */
  level: string;
  /** Credited level: the course's level plus the accuracy offset. */
  rawDan: number;
  /** The accuracy the credit was judged on, in the ladder's own currency. */
  accuracy: number;
  /**
   * Which formula that accuracy is in. Worth publishing rather than keeping
   * internal: a lazer play is displayed on the ScoreV2 formula, so the number
   * the site judged (and quotes) is not the one the player saw, and a reader
   * comparing the two without being told would take it for a mistake.
   */
  currency: "stable" | "v2";
  /** The threshold it was judged against, after any stable conversion. */
  bar: number;
  /** What the client itself showed, when that is a different number. */
  displayedAccuracy: number | null;
  /** The map's osu! status, which decides whether a score has a page to link. */
  beatmapStatus: string | null;
  play: DanCoursePlay;
}

/** The accuracy bar a ladder's course rules set, injected by the dan pipeline. */
export interface DanCourseBar {
  accuracy: number;
  currency: "stable" | "v2";
}

export interface DanCourseCreditOptions {
  /** danClearBarFor: the one place the community bars are written down. */
  barFor: (side: DanCourseSide, keyCount: number, chartDan: number) => DanCourseBar;
  /** STABLE_EQUIVALENT_V2_BAR_OFFSET, for reading a v2 bar off stable counts. */
  stableEquivalentV2BarOffset: number;
}

interface CoursePass {
  course: DanCourse;
  displayed: number;
  stable: number | null;
  scoreV2: number | null;
  play: DanCoursePlay;
}

function creditPass(pass: CoursePass, options: DanCourseCreditOptions, statusByBeatmap?: Map<number, string>): DanCourseClear | null {
  const { course, displayed, stable, scoreV2 } = pass;
  const level = danCourseLevelFor(course);
  if (level == null) return null;
  const bar = options.barFor(course.side, course.keyCount, level);
  // Same currency walk collectDanClears does, so a course pass and an ordinary
  // rated clear are judged on identical terms.
  const isLazerPlay = stable != null && Math.abs(displayed - stable) > 1e-9;
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
    threshold += options.stableEquivalentV2BarOffset;
  }
  // 4K LN labels through parseLnDan, whose only variants are plain and "+";
  // it has no "--" to render a sub-bar credit as, so that ladder credits from
  // the bar up only.
  const allowBelowBar = !(course.keyCount === 4 && course.side === "ln");
  const offset = danCourseCreditOffset(accuracy, threshold, allowBelowBar);
  if (offset == null) return null;
  return {
    keyCount: course.keyCount,
    side: course.side,
    beatmapId: course.beatmapId,
    courseName: course.courseName,
    level: course.level,
    rawDan: Math.round((level + offset) * 100) / 100,
    accuracy,
    currency: bar.currency,
    bar: threshold,
    displayedAccuracy: Math.abs(displayed - accuracy) > 1e-9 ? displayed : null,
    beatmapStatus: statusByBeatmap?.get(course.beatmapId) ?? null,
    play: { ...pass.play, isLazer: pass.play.isLazer ?? isLazerPlay },
  };
}

/** Best credit per course, strongest first. */
function bestPerCourse(clears: DanCourseClear[]): DanCourseClear[] {
  const best = new Map<number, DanCourseClear>();
  for (const clear of clears) {
    const current = best.get(clear.beatmapId);
    if (!current || clear.rawDan > current.rawDan) best.set(clear.beatmapId, clear);
  }
  return [...best.values()].sort((a, b) => b.rawDan - a.rawDan);
}

const COURSE_IDS = DAN_COURSES.map((course) => course.beatmapId);
const COURSE_ID_LIST = COURSE_IDS.join(",");

/**
 * Every registered dan course this player has a verified pass on.
 *
 * Deliberately NOT read off the player's stored SSR plays: that pool is deduped
 * per (chart, rate), capped, and drops archived rows with no mods, and on the
 * live database only one of four players with a qualifying EXTRA-EPSILON pass
 * still had it there. A course credit needs no SSR at all - beatmap, accuracy,
 * mods, passed - so it reads the projections directly. Both queries are keyed
 * on (user, beatmap) indexes against a fixed ~87-id list, so this is two point
 * lookups rather than a scan.
 */
export async function loadDanCourseClears(db: Db, userId: number, options: DanCourseCreditOptions): Promise<DanCourseClear[]> {
  const passes: CoursePass[] = [];

  // The fresh window, with the full payload.
  const scoreRows = (await exec(
    db,
    `select score_json from score_events
     where user_id = ? and passed = 1 and ruleset_id = 3 and beatmap_id in (${COURSE_ID_LIST})`,
    [userId],
  )).rows;
  for (const row of scoreRows) {
    const score = parseJson<OscScore | null>(String(row.score_json ?? ""), null);
    if (!score) continue;
    const course = COURSES_BY_BEATMAP.get(Number(score.beatmap_id));
    if (!course || !danCourseModsAllowed(score.mods)) continue;
    const legacyScoreId = score.legacy_score_id == null ? null : Number(score.legacy_score_id);
    passes.push({
      course,
      displayed: getDisplayedAccuracy(score),
      stable: calculateStableAccuracy(score.statistics ?? {}) || null,
      scoreV2: calculateScoreV2Accuracy(score.statistics) || null,
      play: {
        scoreId: legacyScoreId ?? (Number(score.id) || null),
        soloScoreId: Number(score.id) || null,
        legacyScoreId: legacyScoreId || null,
        mods: Array.isArray(score.mods) ? score.mods : [],
        statistics: score.statistics ?? null,
        maxCombo: score.max_combo == null ? null : Number(score.max_combo),
        totalScore: getDisplayedTotalScore(score),
        rank: score.rank == null ? null : String(score.rank),
        playedAt: score.ended_at == null ? null : String(score.ended_at),
        hasReplay: scoreHasReplay(score),
        isLazer: isLazerScore(score),
      },
    });
  }

  // The 2-year archive. The score_refs join is the pass proof, exactly as
  // loadArchivedTrackedEvidence uses it: player_activity_maps itself records no
  // passed flag, and a failed run is not a clear at any accuracy.
  const activityRows = (await exec(
    db,
    `select m.beatmap_id, m.best_accuracy, m.best_mods_json, m.best_statistics_json,
            m.best_score_id, m.best_solo_score_id, m.best_max_combo, m.best_total_score,
            m.best_rank, m.best_has_replay, m.best_played_at, m.day
     from player_activity_maps m
     where m.user_id = ?
       and m.beatmap_id in (${COURSE_ID_LIST})
       and m.best_accuracy > 0
       and exists (
         select 1 from player_activity_score_refs r
         where r.country = m.country and r.user_id = m.user_id
           and r.day = m.day and r.beatmap_id = m.beatmap_id and r.passed = 1
       )`,
    [userId],
  )).rows;
  for (const row of activityRows) {
    const course = COURSES_BY_BEATMAP.get(Number(row.beatmap_id));
    if (!course) continue;
    const displayed = Number(row.best_accuracy);
    if (!(displayed > 0 && displayed <= 1)) continue;
    const mods = parseJson<OsuMod[] | null>(String(row.best_mods_json ?? ""), null);
    if (!danCourseModsAllowed(mods)) continue;
    const statistics = parseJson<OscScore["statistics"] | null>(String(row.best_statistics_json ?? ""), null);
    const soloScoreId = Number(row.best_solo_score_id) || null;
    const scoreId = Number(row.best_score_id) || null;
    passes.push({
      course,
      displayed,
      stable: statistics ? calculateStableAccuracy(statistics) || null : null,
      scoreV2: statistics ? calculateScoreV2Accuracy(statistics) || null : null,
      play: {
        scoreId,
        soloScoreId,
        // The day-best row keeps the two ids apart, and a row whose ids differ
        // is a stable play: best_score_id preferred the legacy one.
        legacyScoreId: soloScoreId != null && scoreId != null && scoreId !== soloScoreId ? scoreId : null,
        mods: mods ?? [],
        statistics: statistics ?? null,
        maxCombo: row.best_max_combo == null ? null : Number(row.best_max_combo),
        totalScore: row.best_total_score == null ? null : Number(row.best_total_score),
        rank: row.best_rank == null ? null : String(row.best_rank),
        // best_played_at is the instant of the play this row describes; the day
        // is the fallback for rows written before that column existed.
        playedAt: row.best_played_at == null ? `${String(row.day)}T00:00:00Z` : String(row.best_played_at),
        hasReplay: row.best_has_replay == null ? null : Number(row.best_has_replay) === 1,
        isLazer: null,
      },
    });
  }

  // One lookup for the statuses: a loved course has an osu! score page to
  // link, a graveyard one has none, and the evidence surface has to choose.
  const statusByBeatmap = new Map<number, string>();
  if (passes.length > 0) {
    for (const row of (await exec(db, `select beatmap_id, status from beatmaps where beatmap_id in (${COURSE_ID_LIST})`, [])).rows) {
      if (row.status != null) statusByBeatmap.set(Number(row.beatmap_id), String(row.status));
    }
  }

  const clears: DanCourseClear[] = [];
  for (const pass of passes) {
    const clear = creditPass(pass, options, statusByBeatmap);
    if (clear) clears.push(clear);
  }
  return bestPerCourse(clears);
}

/** Test seam over the credit rules, with no database behind them. */
export function creditDanCoursePassesForTest(
  passes: Array<{ beatmapId: number; mods: OsuMod[] | null; displayed: number; stable?: number | null; scoreV2?: number | null }>,
  options: DanCourseCreditOptions,
): DanCourseClear[] {
  const credited: DanCourseClear[] = [];
  for (const pass of passes) {
    const course = COURSES_BY_BEATMAP.get(pass.beatmapId);
    if (!course || !danCourseModsAllowed(pass.mods)) continue;
    const clear = creditPass(
      {
        course,
        displayed: pass.displayed,
        stable: pass.stable ?? null,
        scoreV2: pass.scoreV2 ?? null,
        play: {
          scoreId: null, soloScoreId: null, legacyScoreId: null, mods: pass.mods ?? [],
          statistics: null, maxCombo: null, totalScore: null, rank: null, playedAt: null, hasReplay: null,
          isLazer: null,
        },
      },
      options,
    );
    if (clear) credited.push(clear);
  }
  return bestPerCourse(credited);
}
