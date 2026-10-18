import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { analyzeCollapsedNotes, analyzeStackedHeads, analyzeVibroSections, analyzeWideJumptrill, prepareVibroChart, usesSectionVibro, type VibroAnalysis } from "../vibro/sections";
import { detectLnVibro, detectRiceVibro } from "../vibro/detection";
import type { DanEstimate, DanEstimateInput, DanSkillFamily, ManiaPatternAnalysis } from "../dan-estimator/types";
import { analyzeManiaPatterns } from "../dan-estimator/patterns";
import { extractDanFeatures } from "../dan-estimator/features";
import { danVariantForOffset, getInputRate, parseDan } from "../dan-estimator/labels";
import { LN_LADDER_TOP, estimateLnDan, parseLnDan } from "../dan-estimator/ln";
import { LN_EFFECTIVE_KEY_COUNTS, chartIsLn } from "../dan-estimator/ln-effective";
import { resolveChartLnIdentity } from "./ln-identity";
import { parseLeoBlackLnHalf, parseLeoBlackRcHalf, resolvePlayedOd, runLeoBlackMixed, runLeoBlackSunny, type LeoBlackOdFlag, type ParsedDanPart } from "../leoblack/estimator";
import { DAN_INDEX, type DanIntervalTable } from "leoblack/estimator/intervals/index";
import { analyzePatternFromText, type LeoBlackPatternCluster, type LeoBlackPatternReport } from "leoblack/patterns/service";
import { PATTERNS_CONFIG } from "leoblack/patterns/config";
import { detectVibroFromLongjackPattern } from "leoblack/vibro";
import { applyCompanellaToMixedResult, type LeoBlackReworkResult } from "leoblack/estimator/mixedEstimator";
import type { CompanellaEstimate } from "leoblack/estimator/companellaEstimator";
import { inspectChartDanEligibility, type ChartDanEligibility } from "./dan-eligibility";

export { detectLnVibro, detectRiceVibro, detectRateVibro, detectRollVibro, detectSustainedChordVibro } from "../vibro/detection";

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
  raw: string;
}

export interface ChartClassification {
  keyCount: number;
  supported: boolean;
  lnRatio: number;
  lnEffectiveRatio?: number;
  lnRatingIdentity?: boolean;
  lnStructuralRatio?: number;
  lnWorkShare?: number;
  lnRiceShare?: number;
  sunnySr: number | null;
  verdictText: string | null;
  rc: DanVerdictHalf | null;
  ln: DanVerdictHalf | null;
  primary: DanVerdictHalf | null;
  estimate: DanEstimate | null;
  patterns: ManiaPatternAnalysis;
  clusters: { report: LeoBlackPatternReport; topFiveClusters: LeoBlackPatternCluster[] } | null;
  vibro: boolean;
  vibroAnalysis?: VibroAnalysis;
  danEligibility: ChartDanEligibility;
  companellaPending: boolean;
  warnings: string[];
}

export interface ClassifyChartInput extends DanEstimateInput {
  odFlag?: LeoBlackOdFlag;
  adjustVibro?: boolean;
  preferFamily?: "rc" | "ln" | "auto";
  companella?: CompanellaEstimate | null;
  marathonMsdValues?: Record<string, number> | null;
  rcFloor?: { text: string; numeric: number } | null;
  mixedCacheId?: string;
}

const CLASSIFICATION_CACHE_LIMIT = 8;
const mixedCache = new Map<string, { osuText: string; result: LeoBlackReworkResult }>();

function runMixedOnce(
  osuText: string,
  options: Parameters<typeof runLeoBlackMixed>[1],
  cacheId: string | undefined,
): LeoBlackReworkResult {
  if (!cacheId) return runLeoBlackMixed(osuText, options);
  const key = `${cacheId}|${JSON.stringify(options)}`;
  const cached = mixedCache.get(key);
  if (cached?.osuText === osuText) return cached.result;
  const result = runLeoBlackMixed(osuText, options);
  mixedCache.set(key, { osuText, result });
  if (mixedCache.size > CLASSIFICATION_CACHE_LIMIT) mixedCache.delete(mixedCache.keys().next().value!);
  return result;
}

export const MARATHON_CORRECTION_MIN_DURATION_S = 300;

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

function formatDanTableLabel(
  rawDan: number,
  side: "rc" | "ln",
  keyCount: number,
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
  const variant = danVariantForOffset(offset);
  return `${tableLabelForBase(entry.base)}${variant ?? ""}`;
}

export function danTableLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string | null {
  return formatDanTableLabel(rawDan, side, keyCount);
}

export function danLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  if (keyCount !== 4) {
    const tableLabel = danTableLabelFor(rawDan, side, keyCount);
    if (tableLabel != null) return tableLabel;
  }
  const parsed = side === "ln" && keyCount === 4 ? parseLnDan(rawDan) : parseDan(rawDan);
  return `${parsed.label}${parsed.variant ?? ""}`;
}

export function danTableLevelForLabel(label: string, side: "rc" | "ln", keyCount: number): number | null {
  const tables = DAN_INDEX[keyCount];
  const table = tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
  if (!table) return null;
  const wanted = label.trim().toLowerCase();
  const entry = tableLevels(table).find((candidate) => tableLabelForBase(candidate.base) === wanted);
  return entry ? entry.level : null;
}

export function danTableCeilingFor(side: "rc" | "ln", keyCount: number): number | null {
  if (keyCount === 4) return side === "ln" ? LN_LADDER_TOP + 0.5 : null;
  const tables = DAN_INDEX[keyCount];
  const table = tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
  if (!table) return null;
  const levels = tableLevels(table);
  if (levels.length === 0) return null;
  return levels[levels.length - 1].level + 0.5;
}

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

function applyRcFloor(mixed: LeoBlackReworkResult, floor: ClassifyChartInput["rcFloor"]): LeoBlackReworkResult {
  const numeric = mixed.numericDifficulty == null ? NaN : Number(mixed.numericDifficulty);
  if (!floor || !Number.isFinite(numeric) || floor.numeric <= numeric) return mixed;
  const { lnText } = splitVerdict(String(mixed.estDiff ?? ""));
  return {
    ...mixed,
    estDiff: lnText ? `${floor.text} || ${lnText}` : floor.text,
    numericDifficulty: floor.numeric,
    numericDifficultyHint: null,
  };
}

function splitVerdict(verdict: string): { rcText: string; lnText: string | null } {
  const parts = verdict.split("||").map((part) => part.trim()).filter(Boolean);
  return { rcText: parts[0] ?? "", lnText: parts.length >= 2 ? parts[parts.length - 1] : null };
}

const ROXY_RAW_FLOOR_PIN = -2.45;

const SUNNY_LOW_END_MAX_STAR = 3.0;

function isRoxyFloorPinned(mixed: LeoBlackReworkResult): boolean {
  if (mixed.numericDifficultyHint !== "roxy-meta-ridge-v3") return false;
  const raw = Number(mixed.rawNumericDifficulty);
  return Number.isFinite(raw) && raw <= ROXY_RAW_FLOOR_PIN;
}

const AZUSA_SUSPECT_MIN_NUMERIC = 2;

const AZUSA_SUNNY_REFERENCE_MAX_NUMERIC = 6.84;

function isAzusaLowEndSuspect(mixed: LeoBlackReworkResult): boolean {
  if (mixed.numericDifficultyHint !== "azusa-rc-v1") return false;
  const numeric = Number(mixed.numericDifficulty);
  if (!Number.isFinite(numeric) || numeric < AZUSA_SUSPECT_MIN_NUMERIC) return false;
  const sunnyReference = Number((mixed.debug as { sunnyNumeric?: unknown } | undefined)?.sunnyNumeric);
  return Number.isFinite(sunnyReference) && sunnyReference < AZUSA_SUNNY_REFERENCE_MAX_NUMERIC;
}

export function sunnyLowEndReroute(
  mixed: LeoBlackReworkResult,
  osuText: string,
  rate: number,
  odFlag?: ClassifyChartInput["odFlag"],
): Omit<LeoBlackReworkResult, "mixedCompanellaPlan"> | null {
  if (!isRoxyFloorPinned(mixed) && !isAzusaLowEndSuspect(mixed)) return null;
  const sunny = runLeoBlackSunny(osuText, { speedRate: rate, odFlag });
  return Number(sunny.star) < SUNNY_LOW_END_MAX_STAR ? sunny : null;
}

function analyzeChart(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}) {
  const rate = getInputRate(input);
  const warnings: string[] = [];
  const danEligibility = inspectChartDanEligibility(map);
  const sectionVibro = usesSectionVibro(map);
  const prepared = input.adjustVibro ? prepareVibroChart(osuText, rate, map) : null;
  const vibroAnalysis = sectionVibro ? prepared?.analysis ?? analyzeVibroSections(map, rate)
    : analyzeStackedHeads(map, rate) ?? analyzeWideJumptrill(map, rate) ?? analyzeCollapsedNotes(map, rate) ?? undefined;
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
  const riceVibro = vibroAnalysis ? vibroAnalysis.status === "excluded" : detectRiceVibro(map, rate);
  const vibro = longjackVibro || lnVibro || riceVibro;
  if (lnVibro) {
    warnings.push("Staggered LN-spam (vibro) detected; LN difficulty is likely overestimated.");
  }

  return { map, osuText, warnings, features, patterns, clusters, vibro, vibroAnalysis, lnVibro, danEligibility };
}

function resolveMixedVerdict(
  map: ManiaBeatmap,
  osuText: string,
  input: ClassifyChartInput,
  rate: number,
  warnings: string[],
): { mixed: LeoBlackReworkResult | null; companellaApplied: boolean } {
  let mixed: LeoBlackReworkResult | null = null;
  let companellaApplied = false;
  try {
    const rawMixed = runMixedOnce(osuText, {
      speedRate: rate,
      odFlag: input.odFlag,
      marathonCorrection: isMarathonCorrectionCandidate(map) && input.marathonMsdValues
        ? { durationS: chartNoteSpanSeconds(map), ettValues: input.marathonMsdValues }
        : undefined,
    }, input.mixedCacheId);
    const validCompanella = input.companella != null
      && typeof input.companella.numericDifficulty === "number"
      && Number.isFinite(input.companella.numericDifficulty);
    companellaApplied = validCompanella && rawMixed.mixedCompanellaPlan != null;
    const candidate = validCompanella && input.companella
      ? applyCompanellaToMixedResult(rawMixed, input.companella)
      : rawMixed;
    const reroute = sunnyLowEndReroute(rawMixed, osuText, rate, input.odFlag)
      ?? (candidate !== rawMixed ? sunnyLowEndReroute(candidate, osuText, rate, input.odFlag) : null);
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
      mixed = applyRcFloor(candidate, companellaApplied ? input.rcFloor : null);
    }
  } catch (error) {
    warnings.push(`LeoBlack estimator failed: ${error instanceof Error ? error.message : String(error)}.`);
  }

  return { mixed, companellaApplied };
}

export interface ChartRcClassification {
  sunnySr: number | null;
  companellaPending: boolean;
  rc: Pick<DanVerdictHalf, "source" | "raw" | "rawDan"> | null;
}

export function classifyChartRc(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}): ChartRcClassification {
  const rate = getInputRate(input);
  const prepared = input.adjustVibro ? prepareVibroChart(osuText, rate, map) : null;
  if (prepared?.analysis.status === "adjusted") {
    osuText = prepared.osuText;
    map = { ...parseManiaBeatmap(osuText), totalLength: map.totalLength };
  }
  const { mixed, companellaApplied } = resolveMixedVerdict(map, osuText, input, rate, []);
  const verdict = mixed ? String(mixed.estDiff ?? "").trim() : "";
  const rcText = splitVerdict(verdict).rcText;
  const parsed = map.keyCount === 4 && verdict && !/^(Invalid|Unknown)\b/i.test(verdict)
    ? parseLeoBlackRcHalf(rcText, mixed?.numericDifficulty ?? null)
    : null;
  return {
    sunnySr: mixed && Number.isFinite(mixed.star) ? mixed.star : null,
    companellaPending: mixed?.mixedCompanellaPlan != null,
    rc: parsed ? {
      source: companellaApplied ? "leoblack-companella" : "leoblack-mixed",
      raw: rcText,
      rawDan: Math.round(parsed.rawDan * 100) / 100,
    } : null,
  };
}

export function classifyChartLnTableHalf(map: ManiaBeatmap, osuText: string): Pick<DanVerdictHalf, "label" | "displayName" | "rawDan"> | null {
  if (map.keyCount !== 4) return null;
  const { mixed } = resolveMixedVerdict(map, osuText, {}, 1, []);
  const verdict = mixed ? String(mixed.estDiff ?? "").trim() : "";
  if (!verdict || /^(Invalid|Unknown)\b/i.test(verdict)) return null;
  const { lnText } = splitVerdict(verdict);
  const parsed = lnText ? parseLeoBlackLnHalf(lnText) : null;
  if (!parsed || parsed.boundary === "below") return null;
  const half = toHalf(parsed, "ln", "leoblack-sunny-table", mixed?.star ?? 0, 0.6, lnText!);
  return { label: half.label, displayName: half.displayName, rawDan: half.rawDan };
}

const analysisCache = new Map<string, { osuText: string; result: ReturnType<typeof analyzeChart> }>();
function analyzeChartOnce(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput) {
  if (!input.mixedCacheId) return analyzeChart(map, osuText, input);
  const { companella, rcFloor, marathonMsdValues, ...analysisInput } = input;
  const key = JSON.stringify(analysisInput);
  const cached = analysisCache.get(key);
  if (cached?.osuText === osuText) return cached.result;
  const result = analyzeChart(map, osuText, input);
  analysisCache.set(key, { osuText, result });
  if (analysisCache.size > CLASSIFICATION_CACHE_LIMIT) analysisCache.delete(analysisCache.keys().next().value!);
  return result;
}

export function classifyChart(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}): ChartClassification {
  const rate = getInputRate(input);
  const analysis = analyzeChartOnce(map, osuText, input);
  map = analysis.map;
  osuText = analysis.osuText;
  const { features, patterns, clusters, vibro, vibroAnalysis, lnVibro, danEligibility } = analysis;
  const warnings = [...analysis.warnings];
  const { mixed, companellaApplied } = resolveMixedVerdict(map, osuText, input, rate, warnings);

  const verdictText = mixed ? String(mixed.estDiff ?? "").trim() : null;
  const verdictUsable = verdictText != null && verdictText.length > 0
    && !/^Invalid\b/i.test(verdictText) && !/^Unknown\b/i.test(verdictText);
  const lnRatio = mixed && Number.isFinite(Number(mixed.lnRatio)) ? Number(mixed.lnRatio) : features.metrics.holdRatio;
  const lnIdentity = LN_EFFECTIVE_KEY_COUNTS.has(map.keyCount)
    ? resolveChartLnIdentity(map, { rate, od: resolvePlayedOd(map.od, input.odFlag), holdRatio: lnRatio, overall: input.marathonMsdValues?.Overall })
    : null;
  const lnEffectiveRatio = lnIdentity?.lnEffectiveRatio;
  const chartReadsLn = chartIsLn(map.keyCount, { lnRatio, lnEffectiveRatio }) === true;
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
  if (!ln) ln = lnFromTables;
  if (ln && lnVibro) ln = { ...ln, confidence: Math.min(ln.confidence, 0.35) };

  const prefer = input.preferFamily ?? "auto";
  const primary = prefer === "ln"
    ? ln ?? rc
    : prefer === "rc"
      ? rc ?? ln
      : (chartReadsLn && ln ? ln : rc ?? ln);

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
    ...(lnEffectiveRatio != null ? { lnEffectiveRatio } : {}),
    ...(lnIdentity?.lnWorkShare != null ? { lnWorkShare: lnIdentity.lnWorkShare } : {}),
    ...(lnIdentity?.lnRiceShare != null ? { lnRiceShare: lnIdentity.lnRiceShare } : {}),
    ...(lnIdentity?.lnRatingIdentity ? { lnRatingIdentity: true, lnStructuralRatio: lnIdentity.lnStructuralRatio } : {}),
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
