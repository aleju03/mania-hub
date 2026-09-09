// Shared by the backend and the frontend (which reaches it through the #dan/*
// alias); the vendored LeoBlack tree it drives lives in live-backend/vendor.
import { parseManiaBeatmap, type ManiaBeatmap } from "./beatmap-parser.js";
import { analyzeVibroSections, prepareVibroChart, usesSectionVibro, type VibroAnalysis } from "./vibro-sections.js";
import { detectLnVibro, detectRiceVibro } from "./vibro-detection.js";
import type { DanEstimate, DanEstimateInput, DanSkillFamily } from "./dan-estimator/types.js";
import { analyzeManiaPatterns } from "./dan-estimator/patterns.js";
import type { ManiaPatternAnalysis } from "./dan-estimator/types.js";
import { extractDanFeatures } from "./dan-estimator/features.js";
import { getInputRate, parseDan } from "./dan-estimator/labels.js";
import { LN_LADDER_TOP, estimateLnDan, lnPrimaryMinRatioFor, parseLnDan } from "./dan-estimator/ln.js";
import {
  parseLeoBlackLnHalf,
  parseLeoBlackRcHalf,
  runLeoBlackMixed,
  runLeoBlackSunny,
  type ParsedDanPart,
} from "./leoblack-estimator.js";
import { DAN_INDEX, type DanIntervalTable } from "../../vendor/leoblack/estimator/intervals/index.js";
import {
  analyzePatternFromText,
  type LeoBlackPatternCluster,
  type LeoBlackPatternReport,
} from "../../vendor/leoblack/patterns/service.js";
import { PATTERNS_CONFIG } from "../../vendor/leoblack/patterns/config.js";
import { detectVibroFromLongjackPattern } from "../../vendor/leoblack/vibro.js";
import { applyCompanellaToMixedResult, type LeoBlackReworkResult } from "../../vendor/leoblack/estimator/mixedEstimator.js";
import type { CompanellaEstimate } from "../../vendor/leoblack/estimator/companellaEstimator.js";
import { inspectChartDanEligibility, type ChartDanEligibility } from "./dan-eligibility.js";

// Preserve existing imports while the detection implementation lives separately.
export { detectLnVibro, detectRiceVibro, detectRateVibro, detectRollVibro, detectSustainedChordVibro } from "./vibro-detection.js";

// The single chart classifier. Routes each chart to the best-performing engine
// per the benchmark in live-backend/vendor/leoblack/PORT_NOTES.md:
//   4K RC        -> LeoBlack Mixed (Roxy/Azusa/Daniel/Sunny blend)
//   4K LN        -> LeoBlack's LN table (in-house LN kNN below its LN 5 floor)
//   6K / 7K      -> LeoBlack Sunny star rating mapped through the 6K/7K dan tables
//   other keys   -> patterns only, no dan verdict
// Callers should treat this as THE classifier; estimateDan/estimateDanielDan/
// estimateLeoBlackDan remain only as internals and benchmark baselines.

export type DanVerdictSource = "leoblack-mixed" | "leoblack-companella" | "leoblack-sunny-table" | "inhouse-ln-knn";

export interface DanVerdictHalf {
  kind: "rc" | "ln";
  source: DanVerdictSource;
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  estimatedSr: number;
  confidence: number;
  boundary: "below" | "above" | null;
  /** Verbatim engine output this half was derived from. */
  raw: string;
}

export interface ChartClassification {
  keyCount: number;
  /** True when at least one dan verdict exists (4/6/7K charts). */
  supported: boolean;
  lnRatio: number;
  sunnySr: number | null;
  /** Raw LeoBlack Mixed verdict text ("RC || LN" for hybrids), if it ran. */
  verdictText: string | null;
  rc: DanVerdictHalf | null;
  ln: DanVerdictHalf | null;
  primary: DanVerdictHalf | null;
  /** The primary verdict as a DanEstimate (benchmark / dan_estimates shape). */
  estimate: DanEstimate | null;
  patterns: ManiaPatternAnalysis;
  clusters: { report: LeoBlackPatternReport; topFiveClusters: LeoBlackPatternCluster[] } | null;
  vibro: boolean;
  vibroAnalysis?: VibroAnalysis;
  /** Whether this chart may testify toward a player's dan. The displayed
   * chart verdict remains available even when structural abuse makes clears
   * unsafe to credit. */
  danEligibility: ChartDanEligibility;
  /**
   * True when Mixed wanted Companella for the RC half but none was supplied,
   * so the verdict is still the Sunny fallback. Re-running through
   * classifyChartWithCompanella resolves it.
   */
  companellaPending: boolean;
  warnings: string[];
}

export interface ClassifyChartInput extends DanEstimateInput {
  /** Player-rating policy only. Ordinary chart estimates always rate all notes. */
  adjustVibro?: boolean;
  /** Which half becomes the primary verdict; "auto" picks LN at the keymode's identity line (lnPrimaryMinRatioFor). */
  preferFamily?: "rc" | "ln" | "auto";
  /**
   * Companella verdict for the RC half, when the caller has already run the
   * model. Ignored on charts Mixed did not ask for it. Async by nature, hence
   * an input rather than something this sync function computes.
   */
  companella?: CompanellaEstimate | null;
}

// Marathon duration correction (upstream 2026-08-30, vendored in
// estimator/marathonCorrection.js): Azusa and Roxy shave numeric off long
// charts whose MinaCalc skillsets are evenly spread, on the reading that
// sustained even difficulty is endurance rather than skill.
//
// It is deliberately NOT wired in. The estimators only correct when a caller
// passes `options.marathonCorrection`, and nothing here does. A dan course is
// long and skill-balanced by construction, so the correction lands almost
// entirely on courses, and on our labels it pushes correctly-rated ones down:
// EXTRA-DELTA `delta+` -> `delta-`, EXTRA-GAMMA `gamma+` -> `gamma-`,
// INTRO-1st `1` -> `1--`, against wins that only move already-wrong rows
// closer. Softening the constants softens the damage without removing it
// (measured at scale 0.20/cap 0.25 too), because a uniform downward push on
// that chart shape cannot tell an over-rated course from a correct one. See
// "Re-pin at 5a6144c" in vendor/leoblack/PORT_NOTES.md for the benchmark.
//
// The gate below stays so the decision is testable and so a future re-copy
// that re-enables it has to delete this comment first.
export const MARATHON_CORRECTION_MIN_DURATION_S = 300;

/** First-to-last note span in seconds, as upstream measures a marathon. */
export function chartNoteSpanSeconds(map: ManiaBeatmap): number {
  const notes = map.notes;
  if (notes.length < 2) return 0;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const note of notes) {
    if (note.time < earliest) earliest = note.time;
    if (note.time > latest) latest = note.time;
  }
  return latest > earliest ? (latest - earliest) / 1000 : 0;
}

/**
 * Whether MSD values would change this chart's verdict through the marathon
 * correction, so an async caller knows when computing them is worth a
 * MinaCalc pass. The correction's other gates (skill balance, numeric taper)
 * live in the vendored module and need the values themselves.
 */
export function isMarathonCorrectionCandidate(map: ManiaBeatmap): boolean {
  return map.keyCount === 4 && chartNoteSpanSeconds(map) > MARATHON_CORRECTION_MIN_DURATION_S;
}

const TIER_VARIANTS: Record<string, string | null> = {
  low: "--",
  "mid/low": "-",
  mid: null,
  "mid/high": "+",
  high: "++",
};

const TIER_OFFSETS: Record<string, number> = {
  low: -0.4,
  "mid/low": -0.2,
  mid: 0,
  "mid/high": 0.2,
  high: 0.4,
};

const TABLE_TIER_PATTERN = /^(.+?) (low|mid\/low|mid\/high|mid|high)$/;

interface TableLevel {
  base: string;
  level: number;
}

// Interval tables list five tier rows per dan in ascending order; bases carry
// their level as a trailing number ("Regular 7", "LN 15") or continue past the
// last numbered dan by position ("LN Finish" after "LN 10" -> 11).
function buildTableLevels(table: DanIntervalTable): TableLevel[] {
  const levels: TableLevel[] = [];
  let lastNumeric = 0;
  for (const [, , name] of table) {
    const match = name.match(TABLE_TIER_PATTERN);
    const base = match ? match[1] : name;
    if (levels.some((entry) => entry.base === base)) continue;
    const numberMatch = base.match(/(\d+)$/);
    if (numberMatch) {
      lastNumeric = Number(numberMatch[1]);
      levels.push({ base, level: lastNumeric });
    } else {
      lastNumeric += 1;
      levels.push({ base, level: lastNumeric });
    }
  }
  return levels;
}

const tableLevelCache = new Map<DanIntervalTable, TableLevel[]>();

function tableLevels(table: DanIntervalTable): TableLevel[] {
  let levels = tableLevelCache.get(table);
  if (!levels) {
    levels = buildTableLevels(table);
    tableLevelCache.set(table, levels);
  }
  return levels;
}

function tableLabelForBase(base: string): string {
  return base.replace(/^(Regular|LN)\s+/, "").replace(/^\S+\s+LN\s+/, "").toLowerCase();
}

/**
 * Label a rawDan that lives on a leoblack interval-table scale (6K/7K rice
 * and LN verdicts store rawDan as the table's 0-indexed level, e.g. 7K
 * Gamma = 11). The table's own level names ARE those communities' ladders
 * ("Regular 7" -> "7", "LN Gamma" -> "gamma"); the 4K greek ladder never
 * applies outside 4K, so labeling these from parseDan misnames everything
 * past 10th. Returns null when no table covers the keymode/side.
 */
function formatDanTableLabel(
  rawDan: number,
  side: "rc" | "ln",
  keyCount: number,
  scale: "credit" | "verdict",
): string | null {
  const tables = DAN_INDEX[keyCount];
  const table = tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
  if (!table) return null;
  const levels = tableLevels(table);
  if (levels.length === 0) return null;
  const level = Math.min(levels[levels.length - 1].level, Math.max(levels[0].level, Math.round(rawDan)));
  const entry = levels.find((candidate) => candidate.level === level);
  if (!entry) return null;
  const offset = Math.max(-0.5, Math.min(0.5, rawDan - level));
  // Player credits and averages are continuous, so their suffixes use
  // parseDan's bands and read like the 4K chips. A classifier verdict is one
  // of the table's five named tiers at offsets -.4/-.2/0/.2/.4; use the
  // midpoints between those anchors so "LN Mystery low" round-trips to
  // mystery-- instead of being relabeled mystery- on the evidence surface.
  const variant = scale === "verdict"
    ? offset < -0.3 ? "--" : offset < -0.1 ? "-" : offset < 0.1 ? null : offset < 0.3 ? "+" : "++"
    : offset <= -0.45 ? "--" : offset <= -0.25 ? "-" : offset < 0.1 ? null : offset < 0.26 ? "+" : "++";
  return `${tableLabelForBase(entry.base)}${variant ?? ""}`;
}

export function danTableLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string | null {
  return formatDanTableLabel(rawDan, side, keyCount, "credit");
}

// Each ladder speaks its own community's language. 4K rice runs 1-10 then the
// Reform greek levels (parseDan), 4K LN is numeric 1-17 and never goes greek
// (parseLnDan). 6K/7K rawDans arrive on their leoblack table scale, whose
// level names are the real Sunny/Jinjin ladders (7K past 10th = Gamma,
// Azimuth, Zenith, Stellium; 6K LN = Terra..Finish) - the 4K greek ladder
// ("alpha") does not exist there, so those keymodes label from their table.
export function danLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  if (keyCount !== 4) {
    const tableLabel = danTableLabelFor(rawDan, side, keyCount);
    if (tableLabel != null) return tableLabel;
  }
  const parsed = side === "ln" && keyCount === 4 ? parseLnDan(rawDan) : parseDan(rawDan);
  return `${parsed.label}${parsed.variant ?? ""}`;
}

/** The label of an analyzer verdict, preserving the source table's tier bands. */
export function danTableVerdictLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string | null {
  return formatDanTableLabel(rawDan, side, keyCount, "verdict");
}

/**
 * The inverse of danTableLabelFor's level naming: the table level a bare
 * ladder label sits on ("gamma" -> 11 on 7K rice, "terra" -> 10 on 6K LN).
 *
 * This exists so the dan course registry can name a course by the level its
 * community calls it rather than by a number, and have that number come from
 * the same table the label is printed from. A ladder change then moves both
 * ends together instead of silently shifting every registered course by one.
 * Takes a bare label with no +/- variant; returns null when no table covers
 * the keymode/side or the label is not one of its levels.
 */
export function danTableLevelForLabel(label: string, side: "rc" | "ln", keyCount: number): number | null {
  const tables = DAN_INDEX[keyCount];
  const table = tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
  if (!table) return null;
  const wanted = label.trim().toLowerCase();
  const entry = tableLevels(table).find((candidate) => tableLabelForBase(candidate.base) === wanted);
  return entry ? entry.level : null;
}

/**
 * The rawDan a verdict gets when it lands above the table's last tier: the
 * "> Regular 9 high" sentinel parseTableHalf produces (last level + 0.5).
 * A value at or past it means the ladder stopped measuring, not that the
 * chart or player sits exactly there. Null when no table covers the pair.
 */
export function danTableCeilingFor(side: "rc" | "ln", keyCount: number): number | null {
  // 4K LN speaks its own numeric ladder rather than a leoblack table, but it
  // does end: 17 (Yeehee) is the last course, so the table's "> Lnlism LN 17
  // high" sentinel lands on the same last-level + 0.5 the other keymodes use.
  // 4K RC keeps going into the greek levels, so it still has no ceiling.
  if (keyCount === 4) return side === "ln" ? LN_LADDER_TOP + 0.5 : null;
  const tables = DAN_INDEX[keyCount];
  const table = tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
  if (!table) return null;
  const levels = tableLevels(table);
  if (levels.length === 0) return null;
  return levels[levels.length - 1].level + 0.5;
}

/**
 * The lowest rawDan a credited clear may clamp to. 0.5 on the 4K ladders,
 * whose labelers clamp the level to 1, so it prints as the first level's
 * minus band; the leoblack tables open at level 0 (the Normal Kyu band), so
 * theirs is 0. Never negative: skill surfaces treat a non-positive rawDan as
 * unrated (skill-leaderboards drops it), so a decayed scrape on a bottom-rung
 * chart pins here instead of dropping off the scale.
 */
export function danTableFloorFor(side: "rc" | "ln", keyCount: number): number {
  if (keyCount === 4) return 0.5;
  const tables = DAN_INDEX[keyCount];
  const table = tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
  if (!table) return 0.5;
  const levels = tableLevels(table);
  if (levels.length === 0) return 0.5;
  return Math.max(0, levels[0].level - 0.5);
}

function parseTableHalf(text: string, table: DanIntervalTable): ParsedDanPart | null {
  let boundary: ParsedDanPart["boundary"] = null;
  let body = text.trim();
  if (body.startsWith("< ")) {
    boundary = "below";
    body = body.slice(2).trim();
  } else if (body.startsWith("> ")) {
    boundary = "above";
    body = body.slice(2).trim();
  }

  const match = body.match(TABLE_TIER_PATTERN);
  if (!match) return null;
  const entry = tableLevels(table).find((candidate) => candidate.base === match[1]);
  if (!entry) return null;

  const tier = match[2];
  return {
    label: tableLabelForBase(entry.base),
    variant: boundary === "below" ? "--" : boundary === "above" ? "++" : TIER_VARIANTS[tier],
    rawDan: boundary === "below" ? entry.level - 0.5 : boundary === "above" ? entry.level + 0.5 : entry.level + TIER_OFFSETS[tier],
    boundary,
  };
}

function toHalf(
  parsed: ParsedDanPart,
  kind: "rc" | "ln",
  source: DanVerdictSource,
  estimatedSr: number,
  confidence: number,
  raw: string,
): DanVerdictHalf {
  return {
    kind,
    source,
    label: parsed.label,
    variant: parsed.variant,
    displayName: `${parsed.label}${parsed.variant ?? ""}`,
    rawDan: Math.round(parsed.rawDan * 100) / 100,
    estimatedSr,
    confidence,
    boundary: parsed.boundary,
    raw,
  };
}

function splitVerdict(verdict: string): { rcText: string; lnText: string | null } {
  const parts = verdict.split("||").map((part) => part.trim()).filter(Boolean);
  return { rcText: parts[0] ?? "", lnText: parts.length >= 2 ? parts[parts.length - 1] : null };
}

// Roxy wins the mixed routing for every 4K RC chart with enough taps, but its
// calibration corpus bottoms out at the dan courses: the raw structural signal
// clamps at -2.5 and the isotonic/meta layers can only extrapolate upward from
// there, so a 0.9* ranked Easy with 80+ taps came back "Reform 4" (sub-1* maps
// were landing in the 4-6 dan collections). Charts under Roxy's note gate fall
// through to Sunny and read "< Intro 1" correctly.
//
// A pinned raw signal alone is NOT enough to distrust the verdict: Roxy's
// structural curve also collapses on some genuinely hard charts (measured on
// prod: an Alpha-level 6.5* file with raw -2.65), and rescuing those is exactly
// why the meta model exists. The re-route therefore needs both signals to
// agree: raw pinned at the clamp AND the independent Sunny baseline asserting
// the chart sits below Reform 1 on its own scale. Trivial leakers measure
// 0.22-0.95 Sunny-star vs 5.5+ for the collapsed-but-hard charts, so the two
// populations are far apart.
const ROXY_RAW_FLOOR_PIN = -2.45;
// "Reform 1 low" starts at 3.037 Sunny-star in the 4K RC table
// (vendor/leoblack/estimator/intervals/4k-rc.js): below 3.0 Sunny is
// asserting sub-Reform-1 (Intro or off-scale) while the pinned meta claims
// Reform 3+, a multi-dan disagreement only broken structural input produces.
const SUNNY_LOW_END_MAX_STAR = 3.0;

function isRoxyFloorPinned(mixed: LeoBlackReworkResult): boolean {
  if (mixed.numericDifficultyHint !== "roxy-meta-ridge-v3") return false;
  const raw = Number(mixed.rawNumericDifficulty);
  return Number.isFinite(raw) && raw <= ROXY_RAW_FLOOR_PIN;
}

// Since the 214aedd re-pin Roxy is high-difficulty-only (final numeric under
// 11 routes to Azusa), so the trivial-chart population the floor-pin guard
// was built for now reaches the verdict through Azusa instead - and repeats
// the same overestimation (measured on the guard's own synthetic ranked-Easy
// shape: 2 nps singles came back "Reform 3 low", numeric 2.6, while Azusa's
// own Sunny reference read 3.17, i.e. 0.24 star). The candidate signature is
// that internal disagreement: an Azusa verdict claiming Reform 2+ while the
// Sunny reference it blended sits below Reform 1 on Sunny's own scale. The
// reference rides the result's debug block (estimateSunnyNumeric output), so
// screening costs no extra engine pass; the reroute's independent Sunny run
// stays the final authority.
const AZUSA_SUSPECT_MIN_NUMERIC = 2;
// SUNNY_LOW_END_MAX_STAR mapped through estimateSunnyNumeric's linear scale
// (2.85 + 1.33 * star at star 3.0). The scale saturates the low end (a 0-star
// chart still reads 2.85), which is exactly why Azusa's blend cannot pull a
// trivial chart's verdict down far enough on its own.
const AZUSA_SUNNY_REFERENCE_MAX_NUMERIC = 6.84;

function isAzusaLowEndSuspect(mixed: LeoBlackReworkResult): boolean {
  if (mixed.numericDifficultyHint !== "azusa-rc-v1") return false;
  const numeric = Number(mixed.numericDifficulty);
  if (!Number.isFinite(numeric) || numeric < AZUSA_SUSPECT_MIN_NUMERIC) return false;
  const sunnyReference = Number((mixed.debug as { sunnyNumeric?: unknown } | undefined)?.sunnyNumeric);
  return Number.isFinite(sunnyReference) && sunnyReference < AZUSA_SUNNY_REFERENCE_MAX_NUMERIC;
}

// The Sunny result to re-verdict `mixed` with, or null when the guard should
// not apply. Exported for the one-shot floor-pin recompute sweep
// (chart-analysis.ts), which uses it to find stored analyses that predate this
// guard; keep both callers on this single predicate.
export function sunnyLowEndReroute(
  mixed: LeoBlackReworkResult,
  osuText: string,
  rate: number,
): Omit<LeoBlackReworkResult, "mixedCompanellaPlan"> | null {
  if (!isRoxyFloorPinned(mixed) && !isAzusaLowEndSuspect(mixed)) return null;
  const sunny = runLeoBlackSunny(osuText, { speedRate: rate });
  return Number(sunny.star) < SUNNY_LOW_END_MAX_STAR ? sunny : null;
}

export function classifyChart(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}): ChartClassification {
  const rate = getInputRate(input);
  const warnings: string[] = [];
  const danEligibility = inspectChartDanEligibility(map);
  const sectionVibro = usesSectionVibro(map);
  const prepared = input.adjustVibro ? prepareVibroChart(osuText, rate, map) : null;
  const vibroAnalysis = sectionVibro ? prepared?.analysis ?? analyzeVibroSections(map, rate) : undefined;
  if (prepared?.analysis.status === "adjusted") {
    osuText = prepared.osuText;
    map = { ...parseManiaBeatmap(osuText), totalLength: map.totalLength };
    warnings.push(`Adjusted rating: ${(prepared.analysis.excludedDurationMs / 1000).toFixed(1)}s of vibro excluded; remaining patterns rated at their original timestamps.`);
  }
  if (!danEligibility.eligible) {
    warnings.push(
      `Player dan disabled: ${danEligibility.maxSameColumnHeadStack} objects share one column and head time.`,
    );
  }

  const features = extractDanFeatures(map, input, rate);
  const patterns = analyzeManiaPatterns(map, input, features);

  let clusters: ChartClassification["clusters"] = null;
  try {
    clusters = analyzePatternFromText(osuText);
  } catch (error) {
    warnings.push(`Pattern clustering failed: ${error instanceof Error ? error.message : String(error)}.`);
  }

  const longjackVibro = !sectionVibro && clusters
    ? detectVibroFromLongjackPattern(
      clusters.report,
      PATTERNS_CONFIG.LONGJACK_VIBRO_RATIO_THRESHOLD,
      PATTERNS_CONFIG.LONGJACK_VIBRO_MIN_BPM / rate,
    )
    : false;
  const lnVibro = detectLnVibro(map, rate);
  const riceVibro = sectionVibro ? vibroAnalysis?.status === "excluded" : detectRiceVibro(map, rate);
  const vibro = longjackVibro || lnVibro || riceVibro;
  if (lnVibro) {
    warnings.push("Staggered LN-spam (vibro) detected; LN difficulty is likely overestimated.");
  }

  let mixed: LeoBlackReworkResult | null = null;
  let companellaApplied = false;
  try {
    const rawMixed = runLeoBlackMixed(osuText, { speedRate: rate });
    // The fusion clears Azusa's numeric hint. Check its original verdict too,
    // or a trivial chart can escape the low-end guard after the blend.
    const validCompanella = input.companella != null
      && typeof input.companella.numericDifficulty === "number"
      && Number.isFinite(input.companella.numericDifficulty);
    companellaApplied = validCompanella && rawMixed.mixedCompanellaPlan != null;
    const candidate = validCompanella && input.companella
      ? applyCompanellaToMixedResult(rawMixed, input.companella)
      : rawMixed;
    // A Sunny failure inside the reroute check throws into the catch below,
    // leaving mixed null: better no verdict than the known-bad pinned one.
    const reroute = sunnyLowEndReroute(rawMixed, osuText, rate)
      ?? (candidate !== rawMixed ? sunnyLowEndReroute(candidate, osuText, rate) : null);
    if (reroute) {
      mixed = {
        ...candidate,
        star: reroute.star,
        lnRatio: reroute.lnRatio,
        estDiff: reroute.estDiff,
        numericDifficulty: null,
        numericDifficultyHint: null,
        mixedCompanellaPlan: null,
      };
      companellaApplied = false;
      warnings.push(isRoxyFloorPinned(rawMixed)
        ? "Roxy raw difficulty pinned at its scale floor; using the Sunny low-end verdict."
        : "Azusa low-end verdict contradicts its own Sunny reference; using the Sunny low-end verdict.");
    } else {
      mixed = candidate;
    }
  } catch (error) {
    warnings.push(`LeoBlack estimator failed: ${error instanceof Error ? error.message : String(error)}.`);
  }

  const verdictText = mixed ? String(mixed.estDiff ?? "").trim() : null;
  const verdictUsable = verdictText != null && verdictText.length > 0
    && !/^Invalid\b/i.test(verdictText) && !/^Unknown\b/i.test(verdictText);
  const lnRatio = mixed && Number.isFinite(Number(mixed.lnRatio)) ? Number(mixed.lnRatio) : features.metrics.holdRatio;
  const sunnySr = mixed && Number.isFinite(mixed.star) ? mixed.star : null;

  const rcConfidence = vibro ? 0.35 : 0.72;
  if (vibro) {
    warnings.push("Vibro detected; ordinary difficulty estimates are unreliable.");
  }

  let rc: DanVerdictHalf | null = null;
  let lnFromTables: DanVerdictHalf | null = null;

  if (verdictUsable && mixed) {
    const { rcText, lnText } = splitVerdict(verdictText as string);
    if (map.keyCount === 4) {
      const parsedRc = parseLeoBlackRcHalf(rcText, mixed.numericDifficulty);
      if (parsedRc) {
        rc = toHalf(parsedRc, "rc", companellaApplied ? "leoblack-companella" : "leoblack-mixed", sunnySr ?? 0, parsedRc.boundary ? 0.4 : rcConfidence, rcText);
      }
      if (lnText) {
        const parsedLn = parseLeoBlackLnHalf(lnText);
        if (parsedLn) {
          lnFromTables = toHalf(parsedLn, "ln", "leoblack-sunny-table", sunnySr ?? 0, parsedLn.boundary ? 0.4 : 0.6, lnText);
        }
      }
      if (mixed.mixedCompanellaPlan) {
        warnings.push("RC estimate below 9 stars wants Companella, which was not supplied; showing the unrefined estimate.");
      }
    } else if (map.keyCount === 6 || map.keyCount === 7) {
      const tables = DAN_INDEX[map.keyCount];
      const parsedRc = tables ? parseTableHalf(rcText, tables.RC.default) : null;
      if (parsedRc) {
        rc = toHalf(parsedRc, "rc", "leoblack-sunny-table", sunnySr ?? 0, parsedRc.boundary ? 0.35 : 0.55, rcText);
      }
      if (lnText && tables?.LN) {
        const parsedLn = parseTableHalf(lnText, tables.LN.default);
        if (parsedLn) {
          lnFromTables = toHalf(parsedLn, "ln", "leoblack-sunny-table", sunnySr ?? 0, parsedLn.boundary ? 0.35 : 0.55, lnText);
        }
      }
    }
  }

  // LeoBlack's LN table is the 4K LN verdict wherever it reads a real tier. Its
  // in-house predecessor drifted well above both LeoBlack and Dan-Overlay on
  // rated charts, because it falls through to an SR-linear regression whenever
  // no reference chart is within its distance gate - and that regression is fed
  // starRating * rate^0.7, so the drift widened with rate (chart 5327751 at
  // 1.5x: in-house LN 14+, LeoBlack LN 13, Dan-Overlay Yuugure/12).
  //
  // The table bottoms out at "< LN 5" (4.832 Sunny stars), where every easy LN
  // chart would otherwise collapse onto one reading, so the kNN still covers
  // that low end - the range its corpus does carry references for.
  let ln: DanVerdictHalf | null = lnFromTables && lnFromTables.boundary !== "below" ? lnFromTables : null;
  if (!ln && map.keyCount === 4) {
    const baseStarRating = Number.isFinite(input.starRating) ? Math.max(0, input.starRating ?? 0) : 0;
    const starRating = baseStarRating > 0 ? baseStarRating * Math.pow(rate, 0.7) : 0;
    const lnEstimate = estimateLnDan(map, input, features.metrics, starRating, features.durationMs, rate);
    if (lnEstimate) {
      ln = {
        kind: "ln",
        source: "inhouse-ln-knn",
        label: lnEstimate.label,
        variant: lnEstimate.variant,
        displayName: `${lnEstimate.label}${lnEstimate.variant ?? ""}`,
        rawDan: lnEstimate.rawDan,
        estimatedSr: lnEstimate.estimatedSr,
        confidence: lnEstimate.confidence,
        boundary: null,
        raw: lnEstimate.displayName,
      };
    }
  }
  // Below the table floor with no kNN verdict either, the "< LN 5" boundary is
  // still the honest reading.
  if (!ln) ln = lnFromTables;
  // Mirror the RC vibro damping: an LN dan computed off hold density means
  // little when the holds are vibro spam.
  if (ln && lnVibro) ln = { ...ln, confidence: Math.min(ln.confidence, 0.35) };

  const prefer = input.preferFamily ?? "auto";
  const primary = prefer === "ln"
    ? ln ?? rc
    : prefer === "rc"
      ? rc ?? ln
      : (lnRatio >= lnPrimaryMinRatioFor(map.keyCount) && ln ? ln : rc ?? ln);

  const estimate: DanEstimate | null = primary
    ? {
      label: primary.label,
      variant: primary.variant,
      displayName: primary.displayName,
      rawDan: primary.rawDan,
      estimatedSr: primary.estimatedSr,
      family: primary.kind === "ln" ? "ln" : "dan",
      confidence: primary.confidence,
      metrics: features.metrics,
      skillScores: buildSkillScores(primary),
      warnings,
    }
    : null;

  return {
    keyCount: map.keyCount,
    supported: primary != null,
    lnRatio,
    sunnySr,
    verdictText,
    rc,
    ln,
    primary,
    estimate,
    patterns,
    clusters,
    vibro,
    ...(vibroAnalysis ? { vibroAnalysis } : {}),
    danEligibility,
    companellaPending: mixed?.mixedCompanellaPlan != null,
    warnings,
  };
}

function buildSkillScores(primary: DanVerdictHalf): Record<DanSkillFamily, number> {
  return {
    jack: 0,
    stream: 0,
    jumpstream: 0,
    handstream: 0,
    stamina: 0,
    chordjack: 0,
    tech: 0,
    ln: primary.kind === "ln" ? primary.estimatedSr : 0,
    dan: primary.estimatedSr,
  };
}
