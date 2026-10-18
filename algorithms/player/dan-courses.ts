import { danTableLevelForLabel } from "../classification/chart-classifier";
import { danCreditOffset, type DanCreditAnchors } from "./dan-credit";
import { danLevelForLabel } from "../dan-estimator/labels";
import { LN_LADDER_TOP } from "../dan-estimator/ln";
import type { CompanellaScoreMark, OscScore, OsuMod } from "../chart/score";

export type DanCourseSide = "rc" | "ln";

export interface DanCourse {
  skillset?: string;
  referenceBeatmapId?: number;
  checksum?: string;
  beatmapId: number;
  keyCount: number;
  side: DanCourseSide;
  level: string;
  courseName: string;
  added?: string;
}

const REFORM = "Dan ~ REFORM ~";

const DAN_COURSES: DanCourse[] = [
  { beatmapId: 2259503, keyCount: 4, side: "rc", level: "1", courseName: `${REFORM} 1st` },
  { beatmapId: 2259504, keyCount: 4, side: "rc", level: "2", courseName: `${REFORM} 2nd` },
  { beatmapId: 2259505, keyCount: 4, side: "rc", level: "3", courseName: `${REFORM} 3rd` },
  { beatmapId: 2259506, keyCount: 4, side: "rc", level: "4", courseName: `${REFORM} 4th` },
  { beatmapId: 2259507, keyCount: 4, side: "rc", level: "5", courseName: `${REFORM} 5th` },
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
  { beatmapId: 4123991, keyCount: 4, side: "rc", level: "zeta", courseName: `${REFORM} EXTRA-ZETA`, added: "2026-10-11" },
  { beatmapId: 5236209, keyCount: 4, side: "rc", level: "zeta", courseName: `${REFORM} EXTRA-ZETA`, added: "2026-10-11" },
  { beatmapId: 4777121, keyCount: 4, side: "rc", level: "zeta", courseName: `${REFORM} EXTRA-ZETA`, added: "2026-10-11" },
  { beatmapId: 2738787, keyCount: 4, side: "rc", level: "eta", courseName: `${REFORM} FINAL-ETA` },

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

export function danCourseLevelFor(course: DanCourse): number | null {
  if (course.skillset && course.keyCount === 7 && course.side === "ln" && /^[012]$/.test(course.level)) return Number(course.level);
  if (course.keyCount !== 4) return danTableLevelForLabel(course.level, course.side, course.keyCount);
  if (course.side === "ln") {
    const level = Number(course.level);
    return Number.isInteger(level) && level >= 1 && level <= LN_LADDER_TOP ? level : null;
  }
  return danLevelForLabel(course.level);
}

const COURSES_BY_BEATMAP = new Map<number, DanCourse>();

export function listDanCourses(): readonly DanCourse[] {
  return DAN_COURSES;
}

export function danCourseForBeatmap(beatmapId: number): DanCourse | undefined {
  return COURSES_BY_BEATMAP.get(beatmapId);
}

const DISALLOWED_COURSE_MODS = new Set([
  "EZ", "NF", "HT", "DC", "DA", "HO", "IN", "NR", "RD", "AT", "CN", "SO", "RX", "AP", "WU", "WD", "AS", "DP",
  "1K", "2K", "3K", "4K", "5K", "6K", "7K", "8K", "9K", "10K",
]);

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

const COURSE_CREDIT_BELOW_BAR_WINDOW = 0.02;

const SKILLSET_CREDIT_BELOW_BAR_WINDOW = 0.01;

const COURSE_CREDIT_BELOW_BAR: DanCreditAnchors = [
  [0, -0.26],
  [0.5, -0.29],
  [1, -0.5],
];

const COURSE_CREDIT_7K_LN_BELOW_BAR: DanCreditAnchors = [
  [0, -0.26],
  [0.28, -0.29],
  [0.5, -0.6],
  [1, -0.7],
];

const COURSE_CREDIT_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.015, 0.11],
  [0.02, 0.31],
  [0.035, 0.45],
];

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
    nearBarCap: 0.26,
    allowBelowBar,
  });
}

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
  isLazer: boolean | null;
  companella?: Pick<CompanellaScoreMark, "importId" | "replay" | "app" | "video" | "client">;
}

export interface DanCourseClear {
  skillset?: string;
  referenceBeatmapId?: number;
  keyCount: number;
  side: DanCourseSide;
  beatmapId: number;
  courseName: string;
  level: string;
  rawDan: number;
  accuracy: number;
  currency: "stable" | "v2";
  bar: number;
  displayedAccuracy: number | null;
  beatmapStatus: string | null;
  play: DanCoursePlay;
}

export interface DanCourseBar {
  accuracy: number;
  currency: "stable" | "v2";
}

export interface DanCourseCreditOptions {
  barFor: (side: DanCourseSide, keyCount: number, chartDan: number) => DanCourseBar;
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
  const allowBelowBar = !(course.keyCount === 4 && course.side === "ln");
  const offset = course.skillset
    ? (!Number.isFinite(accuracy) || accuracy > 1 ? null
      : accuracy + 1e-9 >= threshold ? 0
      : accuracy + SKILLSET_CREDIT_BELOW_BAR_WINDOW + 1e-9 >= threshold ? danCourseCreditOffset(accuracy, threshold, allowBelowBar, course)
      : null)
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
    beatmapStatus: statusByBeatmap?.get(course.beatmapId) ?? null,
    play: { ...pass.play, isLazer: pass.play.isLazer ?? isLazerPlay },
  };
}

function bestPerCourse(clears: DanCourseClear[]): DanCourseClear[] {
  const best = new Map<number, DanCourseClear>();
  for (const clear of clears) {
    const current = best.get(clear.beatmapId);
    if (!current || clear.rawDan > current.rawDan) best.set(clear.beatmapId, clear);
  }
  return [...best.values()].sort((a, b) => b.rawDan - a.rawDan);
}

const SKILLSET_ALLOWED_MODS = new Set(["NM", "MR", "HD", "FI", "FL", "SD", "PF", "DT", "NC", "CL", "V2", "SV2"]);

function registeredModsAllowed(course: DanCourse, mods: OsuMod[] | null | undefined): boolean {
  if (!danCourseModsAllowed(mods)) return false;
  return !course.skillset || mods!.every((mod) => SKILLSET_ALLOWED_MODS.has(
    (typeof mod === "string" ? mod : String(mod.acronym)).toUpperCase(),
  ));
}

export interface DanCoursePass {
  beatmapId: number;
  mods: OsuMod[] | null;
  displayed: number;
  stable?: number | null;
  scoreV2?: number | null;
  checksum?: string | null;
  play: DanCoursePlay;
}

export function creditDanCoursePasses(
  passes: DanCoursePass[],
  options: DanCourseCreditOptions,
  courses: ReadonlyMap<number, DanCourse> = COURSES_BY_BEATMAP,
): DanCourseClear[] {
  const credited: DanCourseClear[] = [];
  for (const pass of passes) {
    const course = courses.get(pass.beatmapId);
    if (!course || !registeredModsAllowed(course, pass.mods)) continue;
    if (course.checksum && pass.checksum && course.checksum !== pass.checksum.toLowerCase()) continue;
    const clear = creditPass({ course, displayed: pass.displayed, stable: pass.stable ?? null, scoreV2: pass.scoreV2 ?? null, play: pass.play }, options);
    if (clear) credited.push(clear);
  }
  return bestPerCourse(credited);
}
