import type { ManiaBeatmap } from "./beatmap-parser";
import type { DanEstimate, DanEstimateInput, DanSkillFamily } from "./dan-estimator";
import { analyzeManiaPatterns } from "./dan-estimator";
import type { ManiaPatternAnalysis } from "./dan-estimator/types";
import { extractDanFeatures } from "./dan-estimator/features";
import { getInputRate } from "./dan-estimator/labels";
import { estimateLnDan } from "./dan-estimator/ln";
import {
  parseLeoBlackLnHalf,
  parseLeoBlackRcHalf,
  runLeoBlackMixed,
  type ParsedDanPart,
} from "./leoblack-estimator";
import { DAN_INDEX, type DanIntervalTable } from "./leoblack/estimator/intervals/index.js";
import {
  analyzePatternFromText,
  type LeoBlackPatternCluster,
  type LeoBlackPatternReport,
} from "./leoblack/patterns/service.js";
import { PATTERNS_CONFIG } from "./leoblack/patterns/config.js";
import { detectVibroFromLongjackPattern } from "./leoblack/vibro.js";
import type { LeoBlackReworkResult } from "./leoblack/estimator/mixedEstimator.js";

// The single chart classifier. Routes each chart to the best-performing engine
// per the benchmark in src/lib/leoblack/PORT_NOTES.md:
//   4K RC        -> LeoBlack Mixed (Roxy/Azusa/Daniel/Sunny blend)
//   4K LN        -> in-house LN kNN (falls back to LeoBlack's LN table)
//   6K / 7K      -> LeoBlack Sunny star rating mapped through the 6K/7K dan tables
//   other keys   -> patterns only, no dan verdict
// Callers should treat this as THE classifier; estimateDan/estimateDanielDan/
// estimateLeoBlackDan remain only as internals and benchmark baselines.

export type DanVerdictSource = "leoblack-mixed" | "leoblack-sunny-table" | "inhouse-ln-knn";

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
  warnings: string[];
}

export interface ClassifyChartInput extends DanEstimateInput {
  /** Which half becomes the primary verdict; "auto" picks LN when lnRatio >= 0.5. */
  preferFamily?: "rc" | "ln" | "auto";
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

export function classifyChart(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}): ChartClassification {
  const rate = getInputRate(input);
  const warnings: string[] = [];

  const features = extractDanFeatures(map, input, rate);
  const patterns = analyzeManiaPatterns(map, input);

  let clusters: ChartClassification["clusters"] = null;
  try {
    clusters = analyzePatternFromText(osuText);
  } catch (error) {
    warnings.push(`Pattern clustering failed: ${error instanceof Error ? error.message : String(error)}.`);
  }

  const vibro = clusters
    ? detectVibroFromLongjackPattern(
      clusters.report,
      PATTERNS_CONFIG.LONGJACK_VIBRO_RATIO_THRESHOLD,
      PATTERNS_CONFIG.LONGJACK_VIBRO_MIN_BPM / rate,
    )
    : false;

  let mixed: LeoBlackReworkResult | null = null;
  try {
    mixed = runLeoBlackMixed(osuText, { speedRate: rate });
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
        rc = toHalf(parsedRc, "rc", "leoblack-mixed", sunnySr ?? 0, parsedRc.boundary ? 0.4 : rcConfidence, rcText);
      }
      if (lnText) {
        const parsedLn = parseLeoBlackLnHalf(lnText);
        if (parsedLn) {
          lnFromTables = toHalf(parsedLn, "ln", "leoblack-sunny-table", sunnySr ?? 0, parsedLn.boundary ? 0.4 : 0.6, lnText);
        }
      }
      if (mixed.mixedCompanellaPlan) {
        warnings.push("RC half below 9 stars normally uses Companella, which is not wired; showing the Sunny fallback.");
      }
    } else if (map.keyCount === 6 || map.keyCount === 7) {
      const tables = DAN_INDEX[map.keyCount];
      const parsedRc = tables ? parseTableHalf(rcText, tables.RC.default) : null;
      if (parsedRc) {
        rc = toHalf(parsedRc, "rc", "leoblack-sunny-table", sunnySr ?? 0, parsedRc.boundary ? 0.35 : 0.55, rcText);
      }
      if (lnText && tables) {
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
