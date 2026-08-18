// Shared by the backend and the frontend (which reaches it through the #dan/*
// alias); the vendored LeoBlack tree it drives lives in live-backend/vendor.
import type { ManiaBeatmap } from "./beatmap-parser.js";
import type { DanEstimate, DanEstimateInput, DanSkillFamily } from "./dan-estimator/types.js";
import { analyzeManiaPatterns } from "./dan-estimator/patterns.js";
import type { ManiaPatternAnalysis } from "./dan-estimator/types.js";
import { extractDanFeatures } from "./dan-estimator/features.js";
import { getInputRate } from "./dan-estimator/labels.js";
import { estimateLnDan } from "./dan-estimator/ln.js";
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

// The single chart classifier. Routes each chart to the best-performing engine
// per the benchmark in live-backend/vendor/leoblack/PORT_NOTES.md:
//   4K RC        -> LeoBlack Mixed (Roxy/Azusa/Daniel/Sunny blend)
//   4K LN        -> in-house LN kNN (falls back to LeoBlack's LN table)
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
  /**
   * True when Mixed wanted Companella for the RC half but none was supplied,
   * so the verdict is still the Sunny fallback. Re-running through
   * classifyChartWithCompanella resolves it.
   */
  companellaPending: boolean;
  warnings: string[];
}

export interface ClassifyChartInput extends DanEstimateInput {
  /** Which half becomes the primary verdict; "auto" picks LN when lnRatio >= 0.5. */
  preferFamily?: "rc" | "ln" | "auto";
  /**
   * Companella verdict for the RC half, when the caller has already run the
   * model. Ignored on charts Mixed did not ask for it. Async by nature, hence
   * an input rather than something this sync function computes.
   */
  companella?: CompanellaEstimate | null;
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
export function danTableLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string | null {
  const tables = DAN_INDEX[keyCount];
  const table = tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
  if (!table) return null;
  const levels = tableLevels(table);
  if (levels.length === 0) return null;
  const level = Math.min(levels[levels.length - 1].level, Math.max(levels[0].level, Math.round(rawDan)));
  const entry = levels.find((candidate) => candidate.level === level);
  if (!entry) return null;
  const offset = Math.max(-0.5, Math.min(0.5, rawDan - level));
  // parseDan's variant thresholds, so 4K and 6K/7K dan chips read alike.
  const variant = offset <= -0.45 ? "--" : offset <= -0.25 ? "-" : offset < 0.1 ? null : offset < 0.26 ? "+" : "++";
  return `${tableLabelForBase(entry.base)}${variant ?? ""}`;
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

// LN vibro: chart-wide staggered hold spam (the "gabe power" shape - dense LN
// rolls you play by shaking, not reading). The longjack detector only sees
// rice jack clusters, so these charts sailed through with inflated LN dans.
// A p75 row gap this tight sustained over a whole chart is beyond any legit
// LN chart: the densest ranked LN dumps (Denouement) sit at ~75ms rows, the
// calibration corpus bottoms out at 54ms p50 / 76ms p75, vibro at 22ms.
const LN_VIBRO_MIN_ROWS = 150;
const LN_VIBRO_MIN_HOLD_RATIO = 0.5;
const LN_VIBRO_MAX_P75_ROW_GAP_MS = 40;

// Rice vibro measured directly from note timing, because the longjack-cluster
// detector only fires on clusters labeled "Longjacks": chord-wall vibro reads
// as chordjack/quadstream and sailed through (Tamania's "impossible vibro pack"
// indexed as beta++ jack). Thresholds were calibrated against the local corpus:
// vibro-titled packs vs ranked jack files and celebrated dense charts
// (Gengaozo Innocence 1.05x, STRONG 280 1.1x, hurricanic 1.2x all stay clean).
//
// Tier 1 (any keymode): sustained same-column hammering. A run of 24+ hits with
// gaps <= 92ms (~11/s) is beyond human jacking when a quarter of the chart's
// column gaps are that fast; legit speedjack bursts stay under ~16 hits and
// ranked jack files measure runs <= 6.
const RICE_VIBRO_MIN_NOTES = 300;
const RICE_VIBRO_COLUMN_GAP_MS = 92;
const RICE_VIBRO_COLUMN_MIN_RUN = 24;
const RICE_VIBRO_COLUMN_MIN_RATIO = 0.25;
// Tier 2 (4K only): slower chord-wall vibro (~97-105ms quads you shake, not
// jack). Needs both recurring 4-note wall rows and a chart soaked in fast
// column repeats; dense legit 4K charts top out at ~3.3% wall rows, and the
// legit charts that do carry wall rows keep their column repeats at 105ms+,
// so their <=98ms column ratio measures 0.0 - the 0.32 floor has full margin.
const RICE_VIBRO_WALL_GAP_MS = 105;
const RICE_VIBRO_WALL_MIN_ROWS = 12;
const RICE_VIBRO_WALL_MIN_ROW_RATIO = 0.035;
const RICE_VIBRO_WALL_COLUMN_GAP_MS = 98;
const RICE_VIBRO_WALL_COLUMN_MIN_RATIO = 0.32;

// Tier 3 (any keymode): burst-soak vibro. Packs full of 8-23-note same-column
// bursts at <=100ms slip tiers 1-2 (runs too short for tier 1, no quad walls
// for tier 2), but a chart where a fifth of all column gaps sit inside such
// runs is nothing but bursts. Legit files with occasional speedjack stay far
// under: the calibration corpus's densest unflagged charts (William Tell EX
// piano rolls, Gengaozo 7K Z O) measure ~0.13, ranked jack files ~0.
const RICE_VIBRO_BURST_MIN_NOTES = 200;
const RICE_VIBRO_BURST_GAP_MS = 100;
const RICE_VIBRO_BURST_MIN_RUN = 8;
const RICE_VIBRO_BURST_MIN_RUNS = 4;
const RICE_VIBRO_BURST_MIN_FRACTION = 0.2;

function columnFastGaps(map: ManiaBeatmap, cutoffMs: number): { maxRun: number; ratio: number } {
  const byColumn = new Map<number, number[]>();
  for (const note of map.notes) {
    const list = byColumn.get(note.column) ?? [];
    list.push(note.time);
    byColumn.set(note.column, list);
  }
  let maxRun = 0;
  let fast = 0;
  let total = 0;
  for (const times of byColumn.values()) {
    times.sort((a, b) => a - b);
    let run = 0;
    for (let index = 1; index < times.length; index++) {
      const gap = times[index] - times[index - 1];
      if (gap <= 0) continue;
      total++;
      if (gap <= cutoffMs) {
        fast++;
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
  }
  return { maxRun, ratio: total > 0 ? fast / total : 0 };
}

// Same per-column scan, but measuring how much of the chart sits inside fast
// runs of at least minRun hits (the tier-3 burst-soak signal).
function columnBurstRuns(map: ManiaBeatmap, cutoffMs: number, minRun: number): { runs: number; fraction: number } {
  const byColumn = new Map<number, number[]>();
  for (const note of map.notes) {
    const list = byColumn.get(note.column) ?? [];
    list.push(note.time);
    byColumn.set(note.column, list);
  }
  let runs = 0;
  let inRuns = 0;
  let total = 0;
  for (const times of byColumn.values()) {
    times.sort((a, b) => a - b);
    let run = 0;
    const flush = () => {
      if (run >= minRun) {
        runs++;
        inRuns += run;
      }
      run = 0;
    };
    for (let index = 1; index < times.length; index++) {
      const gap = times[index] - times[index - 1];
      if (gap <= 0) continue;
      total++;
      if (gap <= cutoffMs) run++;
      else flush();
    }
    flush();
  }
  return { runs, fraction: total > 0 ? inRuns / total : 0 };
}

function quadWallRows(map: ManiaBeatmap, cutoffMs: number): { rows: number; ratio: number } {
  const rowSizes = new Map<number, number>();
  for (const note of map.notes) rowSizes.set(note.time, (rowSizes.get(note.time) ?? 0) + 1);
  const times = [...rowSizes.keys()].sort((a, b) => a - b);
  let rows = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap <= 0 || gap > cutoffMs) continue;
    if ((rowSizes.get(times[index]) ?? 0) >= 4 && (rowSizes.get(times[index - 1]) ?? 0) >= 4) rows++;
  }
  return { rows, ratio: times.length > 1 ? rows / (times.length - 1) : 0 };
}

export function detectRiceVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (map.notes.length >= RICE_VIBRO_MIN_NOTES) {
    const sustained = columnFastGaps(map, RICE_VIBRO_COLUMN_GAP_MS * rate);
    if (sustained.maxRun >= RICE_VIBRO_COLUMN_MIN_RUN && sustained.ratio >= RICE_VIBRO_COLUMN_MIN_RATIO) return true;

    // The wall tier's chord-size floor assumes 4 columns; wider keymodes carry
    // legit 4-note chords constantly, so it stays 4K-scoped.
    if (map.keyCount === 4) {
      const walls = quadWallRows(map, RICE_VIBRO_WALL_GAP_MS * rate);
      if (walls.rows >= RICE_VIBRO_WALL_MIN_ROWS && walls.ratio >= RICE_VIBRO_WALL_MIN_ROW_RATIO) {
        const fast = columnFastGaps(map, RICE_VIBRO_WALL_COLUMN_GAP_MS * rate);
        if (fast.ratio >= RICE_VIBRO_WALL_COLUMN_MIN_RATIO) return true;
      }
    }
  }

  // Tier 3 has its own lower size floor: TV-size burst packs sit under the
  // tier-1 floor but their soak fraction is unambiguous.
  if (map.notes.length >= RICE_VIBRO_BURST_MIN_NOTES) {
    const bursts = columnBurstRuns(map, RICE_VIBRO_BURST_GAP_MS * rate, RICE_VIBRO_BURST_MIN_RUN);
    if (bursts.runs >= RICE_VIBRO_BURST_MIN_RUNS && bursts.fraction >= RICE_VIBRO_BURST_MIN_FRACTION) return true;
  }
  return false;
}

export function detectLnVibro(map: ManiaBeatmap, rate = 1): boolean {
  let holds = 0;
  const rowTimes = new Set<number>();
  for (const note of map.notes) {
    if (note.isHold && note.endTime > note.time) holds++;
    rowTimes.add(note.time);
  }
  if (map.notes.length === 0 || rowTimes.size < LN_VIBRO_MIN_ROWS) return false;
  if (holds / map.notes.length < LN_VIBRO_MIN_HOLD_RATIO) return false;
  const times = [...rowTimes].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index++) gaps.push(times[index] - times[index - 1]);
  gaps.sort((a, b) => a - b);
  const p75 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.75))];
  // Gaps are chart-time; a rate rescales what the player experiences.
  return p75 <= LN_VIBRO_MAX_P75_ROW_GAP_MS * rate;
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
// (vendor/leoblack/estimator/intervals/4k-rc-reform.js): below 3.0 Sunny is
// asserting sub-Reform-1 (Intro or off-scale) while the pinned meta claims
// Reform 3+, a multi-dan disagreement only broken structural input produces.
const SUNNY_LOW_END_MAX_STAR = 3.0;

function isRoxyFloorPinned(mixed: LeoBlackReworkResult): boolean {
  if (mixed.numericDifficultyHint !== "roxy-meta-ridge-v3") return false;
  const raw = Number(mixed.rawNumericDifficulty);
  return Number.isFinite(raw) && raw <= ROXY_RAW_FLOOR_PIN;
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
  if (!isRoxyFloorPinned(mixed)) return null;
  const sunny = runLeoBlackSunny(osuText, { speedRate: rate });
  return Number(sunny.star) < SUNNY_LOW_END_MAX_STAR ? sunny : null;
}

export function classifyChart(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}): ChartClassification {
  const rate = getInputRate(input);
  const warnings: string[] = [];

  const features = extractDanFeatures(map, input, rate);
  const patterns = analyzeManiaPatterns(map, input, features);

  let clusters: ChartClassification["clusters"] = null;
  try {
    clusters = analyzePatternFromText(osuText);
  } catch (error) {
    warnings.push(`Pattern clustering failed: ${error instanceof Error ? error.message : String(error)}.`);
  }

  const longjackVibro = clusters
    ? detectVibroFromLongjackPattern(
      clusters.report,
      PATTERNS_CONFIG.LONGJACK_VIBRO_RATIO_THRESHOLD,
      PATTERNS_CONFIG.LONGJACK_VIBRO_MIN_BPM / rate,
    )
    : false;
  const lnVibro = detectLnVibro(map, rate);
  const riceVibro = detectRiceVibro(map, rate);
  const vibro = longjackVibro || lnVibro || riceVibro;
  if (lnVibro) {
    warnings.push("Staggered LN-spam (vibro) detected; LN difficulty is likely overestimated.");
  }

  let mixed: LeoBlackReworkResult | null = null;
  let companellaApplied = false;
  try {
    const rawMixed = runLeoBlackMixed(osuText, { speedRate: rate });
    // Applied before the reroute check so the pin guard sees the final RC
    // verdict; a no-op when Mixed asked for no Companella or none was given.
    companellaApplied = input.companella != null && rawMixed.mixedCompanellaPlan != null;
    const candidate = input.companella
      ? applyCompanellaToMixedResult(rawMixed, input.companella)
      : rawMixed;
    // A Sunny failure inside the reroute check throws into the catch below,
    // leaving mixed null: better no verdict than the known-bad pinned one.
    const reroute = sunnyLowEndReroute(candidate, osuText, rate);
    if (reroute) {
      mixed = {
        ...candidate,
        star: reroute.star,
        lnRatio: reroute.lnRatio,
        estDiff: reroute.estDiff,
        numericDifficulty: null,
        numericDifficultyHint: null,
      };
      warnings.push("Roxy raw difficulty pinned at its scale floor; using the Sunny low-end verdict.");
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
    warnings.push("Vibro-like longjack clusters detected; RC difficulty is likely overestimated.");
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
        warnings.push("RC half below 9 stars wants Companella, which was not supplied; showing the Sunny fallback.");
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

  // In-house LN kNN: the stronger LN engine on 4K (it self-gates on LN signals).
  let ln: DanVerdictHalf | null = null;
  if (map.keyCount === 4) {
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
  if (!ln) ln = lnFromTables;
  // Mirror the RC vibro damping: an LN dan computed off hold density means
  // little when the holds are vibro spam.
  if (ln && lnVibro) ln = { ...ln, confidence: Math.min(ln.confidence, 0.35) };

  const prefer = input.preferFamily ?? "auto";
  const primary = prefer === "ln"
    ? ln ?? rc
    : prefer === "rc"
      ? rc ?? ln
      : (lnRatio >= 0.5 && ln ? ln : rc ?? ln);

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
