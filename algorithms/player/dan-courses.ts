// The real dan courses and how a pass of one becomes a player credential.
// Clearing a course at its bar settles the player's dan at that level. Nothing
// here rates a chart. Practice charts matched by content fingerprint use the
// same shape to certify one skillset tile at a level.
import { danTableLevelForLabel } from "../classification/chart-classifier";
import { danCreditOffset, type DanCreditAnchors } from "./dan-credit";
import { danLevelForLabel } from "../dan-estimator/labels";
import { LN_LADDER_TOP } from "../dan-estimator/ln";
import type { OsuMod } from "../chart/score";

export type DanCourseSide = "rc" | "ln";

export interface DanCourse {
  /** Practice-chart credentials floor only this player skillset. */
  skillset?: string;
  /** The registered practice chart a fingerprint-matched upload stands for. */
  referenceBeatmapId?: number;
  /** For a fingerprint-matched upload: the file checksum the match was made on. */
  checksum?: string;
  beatmapId: number;
  keyCount: number;
  side: DanCourseSide;
  /**
   * The bare ladder label for this course, with no +/- variant ("10", "gamma").
   * Resolved through the same ladder the label is printed from.
   */
  level: string;
  /** The course's name as the evidence surfaces show it. */
  courseName: string;
}

/** One credited course pass. */
export interface DanCourseClear {
  skillset?: string;
  referenceBeatmapId?: number;
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
  /** Which formula that accuracy is in. A lazer play displays ScoreV2. */
  currency: "stable" | "v2";
  /** The threshold it was judged against, after any stable conversion. */
  bar: number;
  /** What the client showed, when that is a different number. */
  displayedAccuracy: number | null;
}

/** The accuracy bar a ladder's course rules set (danClearBarFor in dan-clears.ts). */
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

/** One passed run on a registered course, as the credit rules read it. */
export interface DanCoursePass {
  beatmapId: number;
  /** Null when the play's mods were never recorded, which credits nothing. */
  mods: Array<OsuMod | string> | null;
  /** The accuracy the client displayed. */
  displayed: number;
  /** Stable-formula accuracy from the judgement counts; null when counts are gone. */
  stable?: number | null;
  /** ScoreV2 accuracy from the judgement counts; null when counts are gone. */
  scoreV2?: number | null;
  /** The checksum of the file the play was set on, when known. */
  checksum?: string | null;
}

const REFORM = "Dan ~ REFORM ~";

// One upload per course. A re-upload is added only once checked to be the same
// chart, with no edits or rate shift.
const DAN_COURSES: DanCourse[] = [
  // 4K rice. The greek levels are 11 (alpha) to 17 (eta). Courses below level 1
  // are left out.
  { beatmapId: 2259503, keyCount: 4, side: "rc", level: "1", courseName: `${REFORM} 1st` },
  { beatmapId: 2259504, keyCount: 4, side: "rc", level: "2", courseName: `${REFORM} 2nd` },
  { beatmapId: 2259505, keyCount: 4, side: "rc", level: "3", courseName: `${REFORM} 3rd` },
  { beatmapId: 2259506, keyCount: 4, side: "rc", level: "4", courseName: `${REFORM} 4th` },
  { beatmapId: 2259507, keyCount: 4, side: "rc", level: "5", courseName: `${REFORM} 5th` },
  // Two uploads of the 6th, both registered.
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

  // 4K LN.
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

  // 7K rice.
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

  // 7K LN. The 0th to 2nd are left out because the 7K LN table opens at 3, and
  // a credit below it would clamp up to the table's first label.
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

  // 6K rice. An older, superseded cut of the 4th to 6th is not registered.
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

  // 6K LN.
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

const COURSES_BY_BEATMAP = new Map<number, DanCourse>();
for (const course of DAN_COURSES) COURSES_BY_BEATMAP.set(course.beatmapId, course);

// Mods that make a run not the course. These remove failure, slow or reshuffle
// the chart, rewrite its settings or notes, or play for the player. Mods the
// course rules allow are left alone, since a harder run credited at the
// course's level is a lower bound.
const DISALLOWED_COURSE_MODS = new Set([
  "EZ", "NF", "HT", "DC", "DA", "HO", "IN", "NR", "RD", "AT", "CN", "SO", "RX", "AP", "WU", "WD", "AS", "DP",
  "1K", "2K", "3K", "4K", "5K", "6K", "7K", "8K", "9K", "10K",
]);

// Skillset credentials use an allowlist so an unknown mod cannot change the
// reference's OD or notes.
const SKILLSET_ALLOWED_MODS = new Set(["NM", "MR", "HD", "FI", "FL", "SD", "PF", "DT", "NC", "CL", "V2", "SV2"]);

// A course pass credits at most 2 points under its bar, tighter than the
// chart-clear curve, since it is a single run with no quorum behind it.
const COURSE_CREDIT_BELOW_BAR_WINDOW = 0.02;

// Sub-bar course curve. A run under the bar drops straight to -0.26, inside the
// "-" tier, so it never prints as a bare level. The knee one point under puts
// the "-"/"--" boundary there. Anchors sit just inside their tiers, since a
// value on a boundary rounds across it.
const COURSE_CREDIT_BELOW_BAR: DanCreditAnchors = [
  [0, -0.26],
  [0.5, -0.29],
  [1, -0.5],
];

// 7K LN lets a run well short of its 95% bar fall toward the level below, down
// to -0.70 at 93%. Credit at the bar is unchanged.
const COURSE_CREDIT_7K_LN_BELOW_BAR: DanCreditAnchors = [
  [0, -0.26],
  [0.28, -0.29],
  [0.5, -0.6],
  [1, -0.7],
];

// Course bonus in absolute points over the bar. Capped under +0.5 so a maxed
// run cannot round onto the next level. The same play still earns the
// chart-clear bonus as an ordinary clear.
const COURSE_CREDIT_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.015, 0.11],
  [0.02, 0.31],
  [0.035, 0.45],
];

// Minimum deduction for a sub-bar course run, keeping it inside the "-" tier.
const COURSE_NEAR_BAR_CAP = 0.26;

/**
 * The numeric level of a course's label on its keymode and side's ladder, or
 * null when the label is not on that ladder.
 */
export function danCourseLevelFor(course: DanCourse): number | null {
  // Practice credentials also certify 7K LN 0th-2nd, below the estimator table.
  if (course.skillset && course.keyCount === 7 && course.side === "ln" && /^[012]$/.test(course.level)) return Number(course.level);
  if (course.keyCount !== 4) return danTableLevelForLabel(course.level, course.side, course.keyCount);
  if (course.side === "ln") {
    const level = Number(course.level);
    return Number.isInteger(level) && level >= 1 && level <= LN_LADDER_TOP ? level : null;
  }
  return danLevelForLabel(course.level);
}

export function listDanCourses(): readonly DanCourse[] {
  return DAN_COURSES;
}

export function danCourseForBeatmap(beatmapId: number): DanCourse | undefined {
  return COURSES_BY_BEATMAP.get(beatmapId);
}

/**
 * Whether a play's mods leave the course intact. Unrecorded mods (null) credit
 * nothing, since a fifth of above-bar passes on the top 4K courses are HT.
 */
export function danCourseModsAllowed(mods: Array<OsuMod | string> | null | undefined): boolean {
  if (!Array.isArray(mods)) return false;
  for (const mod of mods) {
    const acronym = (typeof mod === "string" ? mod : String(mod?.acronym ?? "")).toUpperCase();
    if (DISALLOWED_COURSE_MODS.has(acronym)) return false;
    const speed = typeof mod === "string" ? null : mod?.settings?.speed_change;
    if (speed != null && !(Number(speed) >= 1)) return false;
  }
  return true;
}

/**
 * Credited level offset for a course run, or null when it is too far under the
 * bar. `allowBelowBar` is off for 4K LN, whose labels have no minus tier, so a
 * sub-bar credit would round up to a full clear.
 */
export function danCourseCreditOffset(
  accuracy: number,
  bar: number,
  allowBelowBar: boolean,
  course?: Pick<DanCourse, "keyCount" | "side">,
): number | null {
  return danCreditOffset(accuracy, bar, {
    aboveBar: COURSE_CREDIT_ANCHORS,
    aboveBarScale: "delta",
    belowBar: course?.keyCount === 7 && course.side === "ln"
      ? COURSE_CREDIT_7K_LN_BELOW_BAR
      : COURSE_CREDIT_BELOW_BAR,
    belowBarWindow: COURSE_CREDIT_BELOW_BAR_WINDOW,
    nearBarCap: COURSE_NEAR_BAR_CAP,
    allowBelowBar,
  });
}

/**
 * Every credited course from a player's passed runs, best per course, strongest
 * first. Pass `courses` with fingerprint-matched practice charts to credit
 * skillset credentials. Failed runs do not belong in `passes`.
 */
export function creditDanCoursePasses(
  passes: DanCoursePass[],
  options: DanCourseCreditOptions,
  courses: ReadonlyMap<number, DanCourse> = COURSES_BY_BEATMAP,
): DanCourseClear[] {
  const credited: DanCourseClear[] = [];
  for (const pass of passes) {
    const course = courses.get(pass.beatmapId);
    if (!course || !registeredModsAllowed(course, pass.mods)) continue;
    // A fingerprint-matched upload only counts on the file it was matched on.
    if (course.checksum && pass.checksum && course.checksum !== pass.checksum.toLowerCase()) continue;
    const clear = creditPass(course, pass.displayed, pass.stable ?? null, pass.scoreV2 ?? null, options);
    if (clear) credited.push(clear);
  }
  return bestPerCourse(credited);
}

function registeredModsAllowed(course: DanCourse, mods: Array<OsuMod | string> | null | undefined): boolean {
  if (!danCourseModsAllowed(mods)) return false;
  return !course.skillset || mods!.every((mod) => SKILLSET_ALLOWED_MODS.has(
    (typeof mod === "string" ? mod : String(mod.acronym)).toUpperCase(),
  ));
}

function creditPass(
  course: DanCourse,
  displayed: number,
  stable: number | null,
  scoreV2: number | null,
  options: DanCourseCreditOptions,
): DanCourseClear | null {
  const level = danCourseLevelFor(course);
  if (level == null) return null;
  const bar = options.barFor(course.side, course.keyCount, level);
  // Same currency walk as collectDanClears, so course passes and rated clears
  // are judged alike. A displayed accuracy that differs from the stable one
  // marks a lazer play, which displays ScoreV2.
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
  // 4K LN courses have nothing under their bar, so a sub-bar run is a fail.
  const allowBelowBar = !(course.keyCount === 4 && course.side === "ln");
  // A skillset credential needs the full bar and grants exactly its level.
  const offset = course.skillset
    ? (Number.isFinite(accuracy) && accuracy <= 1 && accuracy + 1e-9 >= threshold ? 0 : null)
    : danCourseCreditOffset(accuracy, threshold, allowBelowBar, course);
  if (offset == null) return null;
  return {
    ...(course.skillset ? { skillset: course.skillset, referenceBeatmapId: course.referenceBeatmapId } : {}),
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
