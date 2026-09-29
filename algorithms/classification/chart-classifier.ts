// The chart classifier: one chart at one rate in, its dan verdict and pattern
// tags out. Each keymode goes to the engine that measured best for it:
//   4K RC      -> LeoBlack Mixed (Roxy/Azusa/Daniel/Sunny blend), refined by
//                 Companella when Mixed asks for it and the caller supplies it
//   4K LN      -> LeoBlack's LN table, with the in-house LN kNN below its floor
//   6K / 7K    -> LeoBlack Sunny star rating mapped through the 6K/7K dan tables
//   other keys -> patterns only, no dan verdict
// Vibro detection, LN identity and the player-dan eligibility gate ride along.
import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { analyzeVibroSections, prepareVibroChart, usesSectionVibro, type VibroAnalysis } from "../vibro/sections";
import { detectLnVibro, detectRiceVibro } from "../vibro/detection";
import type { DanEstimate, DanEstimateInput, DanSkillFamily, ManiaPatternAnalysis } from "../dan-estimator/types";
import { analyzeManiaPatterns } from "../dan-estimator/patterns";
import { extractDanFeatures } from "../dan-estimator/features";
import { danVariantForOffset, getInputRate, parseDan } from "../dan-estimator/labels";
import { LN_LADDER_TOP, estimateLnDan, parseLnDan } from "../dan-estimator/ln";
import { LN_EFFECTIVE_KEY_COUNTS, chartIsLn } from "../dan-estimator/ln-effective";
import {
  parseLeoBlackLnHalf,
  parseLeoBlackRcHalf,
  resolvePlayedOd,
  runLeoBlackMixed,
  runLeoBlackSunny,
  type LeoBlackOdFlag,
  type ParsedDanPart,
} from "../leoblack/estimator";
import { DAN_INDEX, type DanIntervalTable } from "leoblack/estimator/intervals/index";
import {
  analyzePatternFromText,
  type LeoBlackPatternCluster,
  type LeoBlackPatternReport,
} from "leoblack/patterns/service";
import { PATTERNS_CONFIG } from "leoblack/patterns/config";
import { detectVibroFromLongjackPattern } from "leoblack/vibro";
import { applyCompanellaToMixedResult, type LeoBlackReworkResult } from "leoblack/estimator/mixedEstimator";
import type { CompanellaEstimate } from "leoblack/estimator/companellaEstimator";
import { resolveChartLnIdentity } from "./ln-identity";
import { inspectChartDanEligibility, type ChartDanEligibility } from "./dan-eligibility";

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
  /** Hold share of the chart (LeoBlack's reading when it ran, else the parser's). */
  lnRatio: number;
  /** Share of the chart that demands a release at this rate (dan-estimator/ln-effective).
   *  The LN identity input for the keymodes in LN_EFFECTIVE_KEY_COUNTS. */
  lnEffectiveRatio?: number;
  /** True when the LN rating, not structure, put this chart on the LN side (ln-identity). */
  lnRatingIdentity?: boolean;
  /** The measured share behind a rating-lifted lnEffectiveRatio. */
  lnStructuralRatio?: number;
  /** Holds carrying identity work over all holds at 1.0x (ln-effective): what
   *  separates a hybrid from a chart whose holds are vibro notation. */
  lnWorkShare?: number;
  sunnySr: number | null;
  /** Raw LeoBlack Mixed verdict text ("RC || LN" for hybrids), if it ran. */
  verdictText: string | null;
  rc: DanVerdictHalf | null;
  ln: DanVerdictHalf | null;
  primary: DanVerdictHalf | null;
  /** The primary verdict in the DanEstimate shape. */
  estimate: DanEstimate | null;
  patterns: ManiaPatternAnalysis;
  clusters: { report: LeoBlackPatternReport; topFiveClusters: LeoBlackPatternCluster[] } | null;
  vibro: boolean;
  vibroAnalysis?: VibroAnalysis;
  /** Whether this chart may count toward a player's dan. The chart verdict is
   *  still shown when structural abuse makes clears unsafe to credit. */
  danEligibility: ChartDanEligibility;
  /** True when Mixed wanted Companella for the RC half but none was supplied,
   *  so the verdict is still the unrefined one. Classifying again with a
   *  Companella estimate resolves it. */
  companellaPending: boolean;
  warnings: string[];
}

export interface ClassifyChartInput extends DanEstimateInput {
  /** Played OD/mod for LeoBlack; omitted for a chart's own rating. */
  odFlag?: LeoBlackOdFlag;
  /** Player-rating policy only. Ordinary chart estimates rate all notes. */
  adjustVibro?: boolean;
  /** Which half becomes the primary verdict; "auto" uses chartIsLn's keymode-aware identity gates. */
  preferFamily?: "rc" | "ln" | "auto";
  /** Companella verdict for the RC half, when the caller has already run the
   *  model (it is async, so it arrives as an input). Ignored on charts Mixed
   *  did not ask for it. */
  companella?: CompanellaEstimate | null;
  /** Raw MSD at the requested rate, before LN-tail blending. Callers supply it
   *  for marathon candidates and for 4K charts whose LN identity the rating
   *  tiebreak can still decide. */
  marathonMsdValues?: Record<string, number> | null;
  /** Companella-refined RC verdict from a lower rate of this chart. A
   *  Companella-refined RC half here may not fall below it (leoblack/companella). */
  rcFloor?: { text: string; numeric: number } | null;
}

/** Only the fields the 4K rate floor reads; no pattern, LN or player verdict work. */
export interface ChartRcClassification {
  sunnySr: number | null;
  companellaPending: boolean;
  rc: Pick<DanVerdictHalf, "source" | "raw" | "rawDan"> | null;
}

/** A classification as plain data: LeoBlack clusters with their Importance
 *  getter read and their display label resolved at 1x. */
export type ChartClassificationData = Omit<ChartClassification, "clusters"> & {
  clusters: {
    report: Omit<LeoBlackPatternReport, "Clusters" | "ImportantClusters"> & {
      Clusters: ClusterData[];
      ImportantClusters: ClusterData[];
    };
    topFiveClusters: ClusterData[];
  } | null;
};

type ClusterData = Omit<LeoBlackPatternCluster, "format"> & { label: string };

// LeoBlack's marathon correction runs inside Azusa and Roxy, before Mixed's
// routing and Companella fusion. Duration is the unscaled first-to-last note
// span in seconds, breaks included; MSD belongs to the played rate. Without
// MSD the verdict stays uncorrected. The correction can raise the final Mixed
// output when it changes the route or releases the Sunny low-end guard.
export const MARATHON_CORRECTION_MIN_DURATION_S = 300;

// Roxy wins Mixed's routing for 4K RC charts with enough taps, but its
// calibration corpus bottoms out at the dan courses: the raw structural signal
// clamps at -2.5 and the isotonic/meta layers can only extrapolate upward from
// there, so a 0.9 star ranked Easy with 80+ taps came back "Reform 4". Charts
// under Roxy's note gate fall through to Sunny and read "< Intro 1" correctly.
//
// A pinned raw signal alone does not condemn the verdict: Roxy's structural
// curve also collapses on some hard charts (an Alpha-level 6.5 star file read
// raw -2.65), and the meta model exists to rescue those. So the reroute needs
// both signals: raw pinned at the clamp and an independent Sunny run placing
// the chart below Reform 1. Trivial charts that leak measure 0.22-0.95 Sunny
// stars against 5.5+ for the collapsed hard ones.
const ROXY_RAW_FLOOR_PIN = -2.45;
// "Reform 1 low" starts at 3.037 Sunny stars in LeoBlack's 4K RC table. Below
// 3.0 Sunny says sub-Reform-1 while the pinned meta claims Reform 3+, a
// multi-dan disagreement only broken structural input produces.
const SUNNY_LOW_END_MAX_STAR = 3.0;

// Roxy only takes high-difficulty charts (a final numeric under 11 routes to
// Azusa), so trivial charts reach the verdict through Azusa and repeat the
// same overestimate: 2 notes/s singles came back "Reform 3 low" (numeric 2.6)
// while Azusa's own Sunny reference read 3.17 numeric, about 0.24 stars. The
// suspect signature is that internal disagreement: Azusa claims Reform 2+
// while the Sunny reference it blended sits below Reform 1. The reference is
// on the result's debug block, so screening costs no extra engine pass; the
// reroute's own Sunny run stays the final word.
const AZUSA_SUSPECT_MIN_NUMERIC = 2;
// SUNNY_LOW_END_MAX_STAR on Azusa's linear Sunny scale (2.85 + 1.33 * star at
// 3.0 stars). That scale saturates at the low end (a 0-star chart still reads
// 2.85), which is why Azusa's blend cannot pull a trivial chart down alone.
const AZUSA_SUNNY_REFERENCE_MAX_NUMERIC = 6.84;

// Table rows name tiers "<base> low" through "<base> high"; each maps to a
// +/- variant and an offset from the base level.
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

export function classifyChart(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}): ChartClassification {
  const rate = getInputRate(input);
  const analysis = analyzeChart(map, osuText, input);
  map = analysis.map;
  osuText = analysis.osuText;
  const { features, patterns, clusters, vibro, vibroAnalysis, lnVibro, danEligibility } = analysis;
  const warnings = [...analysis.warnings];
  const { mixed, companellaApplied } = resolveMixedVerdict(map, osuText, input, rate, warnings);

  const verdictText = mixed ? String(mixed.estDiff ?? "").trim() : null;
  const verdictUsable = verdictText != null && verdictText.length > 0
    && !/^Invalid\b/i.test(verdictText) && !/^Unknown\b/i.test(verdictText);
  const lnRatio = mixed && Number.isFinite(Number(mixed.lnRatio)) ? Number(mixed.lnRatio) : features.metrics.holdRatio;
  // "This chart is LN" reads hold share plus the effective gate on 4K, hold
  // share alone elsewhere (chartIsLn), then on 4K the rating tiebreak when the
  // caller supplied MSD at this rate (ln-identity). The gate reads the played
  // OD, so a Difficulty Adjust play is filed on the side of the chart it
  // actually played.
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
        // Note: a boundary verdict gets 0.4 even on a vibro chart, above the 0.35 vibro confidence.
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

  // LeoBlack's LN table is the 4K LN verdict wherever it reads a real tier.
  // The in-house kNN drifts above both LeoBlack and a community dan overlay on
  // rated charts, because with no reference chart inside its distance gate it
  // falls through to a regression fed starRating * rate^0.7, so the drift
  // grows with rate (one chart at 1.5x: in-house LN 14+, LeoBlack LN 13, the
  // overlay 12).
  //
  // The table bottoms out at "< LN 5" (4.832 Sunny stars), where every easy LN
  // chart would collapse onto one reading, so the kNN still covers that low
  // end, where its corpus does have references.
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
  // Below the table floor with no kNN verdict either, "< LN 5" is still the
  // honest reading.
  if (!ln) ln = lnFromTables;
  // Same damping as the RC side: an LN dan read off hold density means little
  // when the holds are vibro spam.
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

/** The RC half alone, for the 4K rate floor: same routing and guards as classifyChart. */
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

/** First-to-last note span in seconds, as LeoBlack measures a marathon. */
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
 * Whether MSD values could change this chart's verdict through the marathon
 * correction, so a caller knows when a MinaCalc pass is worth it. The
 * correction's other gates (skill balance, numeric taper) live in LeoBlack and
 * need the values themselves.
 */
export function isMarathonCorrectionCandidate(map: ManiaBeatmap): boolean {
  return map.keyCount === 4 && chartNoteSpanSeconds(map) > MARATHON_CORRECTION_MIN_DURATION_S;
}

/** The Sunny result to re-verdict `mixed` with, or null when the low-end guard does not apply. */
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

// Each ladder speaks its own community's language. 4K rice runs 1-10 then the
// Reform greek levels (parseDan); 4K LN is numeric 1-17 and never goes greek
// (parseLnDan). 6K/7K rawDans are on their LeoBlack table scale, whose level
// names are the real 6K/7K ladders (7K past 10th: Gamma, Azimuth, Zenith,
// Stellium; 6K LN: Terra to Finish). The 4K greek ladder does not exist there,
// so those keymodes label from their table.
export function danLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string {
  if (keyCount !== 4) {
    const tableLabel = danTableLabelFor(rawDan, side, keyCount);
    if (tableLabel != null) return tableLabel;
  }
  const parsed = side === "ln" && keyCount === 4 ? parseLnDan(rawDan) : parseDan(rawDan);
  return `${parsed.label}${parsed.variant ?? ""}`;
}

/**
 * Label a rawDan on a LeoBlack interval-table scale. 6K/7K rice and LN
 * verdicts store rawDan as the table's 0-indexed level (7K Gamma = 11), and
 * the table's level names are those ladders ("Regular 7" -> "7", "LN Gamma"
 * -> "gamma"). Null when no table covers the keymode and side.
 */
export function danTableLabelFor(rawDan: number, side: "rc" | "ln", keyCount: number): string | null {
  const table = danTableFor(side, keyCount);
  if (!table) return null;
  const levels = tableLevels(table);
  if (levels.length === 0) return null;
  const level = Math.min(levels[levels.length - 1].level, Math.max(levels[0].level, Math.round(rawDan)));
  const entry = levels.find((candidate) => candidate.level === level);
  if (!entry) return null;
  const offset = Math.max(-0.5, Math.min(0.5, rawDan - level));
  // A named tier ("LN Mystery low") round-trips to "mystery--".
  const variant = danVariantForOffset(offset);
  return `${tableLabelForBase(entry.base)}${variant ?? ""}`;
}

/**
 * The inverse of danTableLabelFor's naming: the table level a bare ladder
 * label sits on ("gamma" -> 11 on 7K rice, "terra" -> 10 on 6K LN). The dan
 * course registry names courses this way, so a course's level comes from the
 * same table its label is printed from. Takes a label without +/- variant;
 * null when no table covers the keymode and side or the label is not a level.
 */
export function danTableLevelForLabel(label: string, side: "rc" | "ln", keyCount: number): number | null {
  const table = danTableFor(side, keyCount);
  if (!table) return null;
  const wanted = label.trim().toLowerCase();
  const entry = tableLevels(table).find((candidate) => tableLabelForBase(candidate.base) === wanted);
  return entry ? entry.level : null;
}

/**
 * The rawDan a verdict gets above the table's last tier: the "> Regular 9
 * high" sentinel parseTableHalf produces (last level + 0.5). At or past it the
 * ladder stopped measuring; the chart or player does not sit exactly there.
 * 4K LN has no LeoBlack table here but ends at 17, the last course, so it gets
 * the same last level + 0.5. 4K RC continues into the greek levels and has no
 * ceiling. Null when no table covers the pair.
 */
export function danTableCeilingFor(side: "rc" | "ln", keyCount: number): number | null {
  if (keyCount === 4) return side === "ln" ? LN_LADDER_TOP + 0.5 : null;
  const table = danTableFor(side, keyCount);
  if (!table) return null;
  const levels = tableLevels(table);
  if (levels.length === 0) return null;
  return levels[levels.length - 1].level + 0.5;
}

/**
 * The lowest rawDan a credited clear may clamp to. 0.5 on the 4K ladders,
 * whose labelers clamp the level to 1, so it prints as the first level's minus
 * band; the LeoBlack tables open at level 0 (the Normal Kyu band), so theirs
 * is 0. Never negative. Credit also clamps a chart's stored rawDan here on
 * read: the regression can run below the table on a bottom-rung chart whose
 * label still prints as the first band, and a clear on it should credit the
 * floor instead of counting as unrated.
 */
export function danTableFloorFor(side: "rc" | "ln", keyCount: number): number {
  if (keyCount === 4) return 0.5;
  const table = danTableFor(side, keyCount);
  if (!table) return 0.5;
  const levels = tableLevels(table);
  if (levels.length === 0) return 0.5;
  return Math.max(0, levels[0].level - 0.5);
}

/** Resolve LeoBlack's cluster getters and 1x display labels into plain data. */
export function chartClassificationData(classification: ChartClassification): ChartClassificationData {
  const clusters = classification.clusters;
  if (!clusters) return { ...classification, clusters: null };
  const data = new Map<LeoBlackPatternCluster, ClusterData>();
  const clusterData = (cluster: LeoBlackPatternCluster): ClusterData => {
    let entry = data.get(cluster);
    if (!entry) {
      const { format, ...fields } = cluster;
      entry = { ...fields, Importance: cluster.Importance, label: format.call(cluster, 1) };
      data.set(cluster, entry);
    }
    return entry;
  };
  return {
    ...classification,
    clusters: {
      report: {
        ...clusters.report,
        Clusters: clusters.report.Clusters.map(clusterData),
        ImportantClusters: clusters.report.ImportantClusters.map(clusterData),
      },
      topFiveClusters: clusters.topFiveClusters.map(clusterData),
    },
  };
}

/** Everything about the chart except the Mixed verdict: vibro, eligibility, features, patterns, clusters. */
function analyzeChart(map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}) {
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

  return { map, osuText, warnings, features, patterns, clusters, vibro, vibroAnalysis, lnVibro, danEligibility };
}

/** Mixed routing, Companella fusion, the Sunny low-end guard and the RC rate floor. */
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
    const rawMixed = runLeoBlackMixed(osuText, {
      speedRate: rate,
      odFlag: input.odFlag,
      marathonCorrection: isMarathonCorrectionCandidate(map) && input.marathonMsdValues
        ? { durationS: chartNoteSpanSeconds(map), ettValues: input.marathonMsdValues }
        : undefined,
    });
    const validCompanella = input.companella != null
      && typeof input.companella.numericDifficulty === "number"
      && Number.isFinite(input.companella.numericDifficulty);
    companellaApplied = validCompanella && rawMixed.mixedCompanellaPlan != null;
    const candidate = validCompanella && input.companella
      ? applyCompanellaToMixedResult(rawMixed, input.companella)
      : rawMixed;
    // The fusion clears Azusa's numeric hint, so check the pre-fusion verdict
    // too, or a trivial chart escapes the low-end guard after the blend. A
    // Sunny failure here throws into the catch and leaves no verdict, which
    // beats keeping the known-bad pinned one.
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

/** Lift the RC half to the lower-rate floor when it reads below it; the LN half is kept. */
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

/** "RC || LN" into its halves; a single verdict is the RC half. */
function splitVerdict(verdict: string): { rcText: string; lnText: string | null } {
  const parts = verdict.split("||").map((part) => part.trim()).filter(Boolean);
  return { rcText: parts[0] ?? "", lnText: parts.length >= 2 ? parts[parts.length - 1] : null };
}

function isRoxyFloorPinned(mixed: LeoBlackReworkResult): boolean {
  if (mixed.numericDifficultyHint !== "roxy-meta-ridge-v3") return false;
  const raw = Number(mixed.rawNumericDifficulty);
  return Number.isFinite(raw) && raw <= ROXY_RAW_FLOOR_PIN;
}

function isAzusaLowEndSuspect(mixed: LeoBlackReworkResult): boolean {
  if (mixed.numericDifficultyHint !== "azusa-rc-v1") return false;
  const numeric = Number(mixed.numericDifficulty);
  if (!Number.isFinite(numeric) || numeric < AZUSA_SUSPECT_MIN_NUMERIC) return false;
  const sunnyReference = Number((mixed.debug as { sunnyNumeric?: unknown } | undefined)?.sunnyNumeric);
  return Number.isFinite(sunnyReference) && sunnyReference < AZUSA_SUNNY_REFERENCE_MAX_NUMERIC;
}

function danTableFor(side: "rc" | "ln", keyCount: number): DanIntervalTable | undefined {
  const tables = DAN_INDEX[keyCount];
  return tables ? (side === "ln" ? tables.LN?.default : tables.RC.default) : undefined;
}

// Interval tables list five tier rows per dan in ascending order. A base
// carries its level as a trailing number ("Regular 7", "LN 15") or continues
// past the last numbered dan by position ("LN Finish" after "LN 10" -> 11).
function tableLevels(table: DanIntervalTable): TableLevel[] {
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

/** "Regular 7" -> "7", "LN Gamma" -> "gamma", "<prefix> LN Terra" -> "terra". */
function tableLabelForBase(base: string): string {
  return base.replace(/^(Regular|LN)\s+/, "").replace(/^\S+\s+LN\s+/, "").toLowerCase();
}

/** Parse one half of a 6K/7K table verdict ("Regular 7 mid/high", "< LN Terra low"). */
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

// The classifier fills only the dan and LN slots; the pattern families score 0.
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
