// Adapter from the LeoBlack "Mixed" dan estimator onto this project's
// DanEstimate shape and label vocabulary (rice: 1-10 then greek letters; LN:
// plain numbers). Mixed blends LeoBlack's Sunny, Daniel, Azusa and Roxy
// estimators per chart and returns a text verdict such as "Reform 7 mid/high"
// or, on hybrids, "<rice half> || <LN half>"; this file parses that text.
import type { ManiaBeatmap } from "../chart/beatmap";
import type { DanEstimate, DanEstimateInput, DanSkillFamily } from "../dan-estimator/types";
import { extractDanFeatures } from "../dan-estimator/features";
import { getInputRate } from "../dan-estimator/labels";
import { LN_EFFECTIVE_KEY_COUNTS, analyzeEffectiveLn, chartIsLn } from "../dan-estimator/ln-effective";
import {
  runMixedEstimatorFromText,
  type LeoBlackEstimatorOptions,
  type LeoBlackReworkResult,
} from "leoblack/estimator/mixedEstimator";
import { runSunnyEstimatorFromText } from "leoblack/estimator/sunnyEstimator";
import {
  analyzePatternFromText,
  type LeoBlackPatternCluster,
  type LeoBlackPatternReport,
} from "leoblack/patterns/service";
import { PATTERNS_CONFIG } from "leoblack/patterns/config";
import { detectVibroFromLongjackPattern } from "leoblack/vibro";

export interface LeoBlackDanInput extends DanEstimateInput {
  // Which half of a hybrid "RC || LN" verdict to report. "auto" picks LN when the
  // chart reads as LN (the keymode's identity line of holds or more).
  preferFamily?: "rc" | "ln" | "auto";
  /** Played OD/mod; omitted rates the chart at its own OD. */
  odFlag?: LeoBlackOdFlag;
}

/** LeoBlack resolves HR/EZ itself; numeric values are the played Difficulty Adjust OD. */
export type LeoBlackOdFlag = number | "HR" | "EZ";

export interface ParsedDanPart {
  label: string;
  variant: string | null;
  rawDan: number;
  boundary: "below" | "above" | null;
}

/**
 * The OD a play was actually judged at: Difficulty Adjust replaces the file's
 * value outright, HR/EZ scale it. Same conversion LeoBlack's Sunny and Roxy
 * preprocessing does, so a judgement window read off this OD is the window
 * LeoBlack rated the play against. It matters wherever a window decides
 * structure, above all the 4K effective-LN identity gate: a nominal LN chart
 * at OD 0 releases inside a 96ms window and reads as rice, the same chart at
 * OD 8 has 60ms and reads as LN.
 */
export function resolvePlayedOd(fileOd: number, odFlag?: LeoBlackOdFlag): number {
  if (odFlag == null) return fileOd;
  if (odFlag === "HR") return 6.462 + (0.715 * fileOd);
  if (odFlag === "EZ") return -20.761 + (2.566 * fileOd);
  return Number.isFinite(odFlag) ? odFlag : fileOd;
}

/**
 * Parse the rice half of a Mixed verdict. Two formats arrive: Roxy/Azusa
 * labels ("Reform 7 mid/high", "Intro 2 low", "Gamma mid") on a continuous
 * -2..20.4 scale, and Daniel labels ("Gamma Mid") whose numeric is
 * bottom-anchored at 11 + index + t, t in [0, 1). A leading "<" or ">" means
 * the chart is off the bottom or top of the table.
 */
export function parseLeoBlackRcHalf(text: string, numericDifficulty: number | null): ParsedDanPart | null {
  const { boundary, body } = splitBoundary(text);

  const rcMatch = body.match(RC_TIER_PATTERN);
  if (rcMatch) {
    const level = parseRcBaseLevel(rcMatch[1]);
    if (level != null) {
      const tier = rcMatch[2];
      const rawDan = boundary === "below"
        ? level - 0.5
        : boundary === "above"
          ? level + 0.5
          : Number.isFinite(numericDifficulty)
            ? Number(numericDifficulty)
            : level + RC_TIER_OFFSETS[tier];
      return {
        label: normalLabelForLevel(level),
        variant: boundary === "below" ? "--" : boundary === "above" ? "++" : RC_TIER_VARIANTS[tier],
        rawDan,
        boundary,
      };
    }
  }

  const danielMatch = body.match(DANIEL_TIER_PATTERN);
  if (danielMatch) {
    const level = GREEK_LEVELS[danielMatch[1].toLowerCase()];
    if (level != null) {
      const tier = danielMatch[2];
      // Shift the bottom-anchored Daniel numeric to a mid-anchored one.
      const rawDan = boundary === "below"
        ? level - 0.5
        : boundary === "above"
          ? level + 0.5
          : Number.isFinite(numericDifficulty)
            ? Number(numericDifficulty) - 0.5
            : level + DANIEL_TIER_OFFSETS[tier];
      return {
        label: normalLabelForLevel(level),
        variant: boundary === "below" ? "--" : boundary === "above" ? "++" : DANIEL_TIER_VARIANTS[tier],
        rawDan,
        boundary,
      };
    }
  }

  return null;
}

/** Parse the LN half of a Mixed verdict ("LN 12 mid", optionally after one leading word). */
export function parseLeoBlackLnHalf(text: string): ParsedDanPart | null {
  const { boundary, body } = splitBoundary(text);

  const tierMatch = body.match(RC_TIER_PATTERN);
  if (!tierMatch) return null;
  const baseMatch = tierMatch[1].match(LN_PART_PATTERN);
  if (!baseMatch) return null;

  const level = Number(baseMatch[1]);
  const tier = tierMatch[2];
  return {
    label: String(level),
    variant: boundary === "below" ? "--" : boundary === "above" ? "++" : RC_TIER_VARIANTS[tier],
    rawDan: boundary === "below" ? level - 0.5 : boundary === "above" ? level + 0.5 : level + RC_TIER_OFFSETS[tier],
    boundary,
  };
}

/** A 4K chart's LeoBlack dan as a DanEstimate. Throws on other keymodes and on verdicts it cannot read. */
export function estimateLeoBlackDan(map: ManiaBeatmap, osuText: string, input: LeoBlackDanInput = {}): DanEstimate {
  if (map.keyCount !== 4) {
    throw new Error("LeoBlack dan mapping currently only supports 4K beatmaps (use runLeoBlackMixed for raw 6K/7K verdicts).");
  }

  const rate = getInputRate(input);
  const mixed = runLeoBlackMixed(osuText, { speedRate: rate, odFlag: input.odFlag });
  const verdict = String(mixed.estDiff ?? "").trim();
  if (!verdict || /^Invalid\b/i.test(verdict) || /^Unknown\b/i.test(verdict)) {
    throw new Error(`LeoBlack estimator could not classify this chart (${verdict || "empty verdict"}).`);
  }

  const parts = verdict.split("||").map((part) => part.trim()).filter(Boolean);
  const rcText = parts[0] ?? "";
  const lnText = parts.length >= 2 ? parts[parts.length - 1] : null;

  const prefer = input.preferFamily ?? "auto";
  const lnRatio = Number(mixed.lnRatio);
  // Same identity read as the chart classifier: hold share plus, on 4K, the
  // effective-LN share at the played OD.
  const readsLn = chartIsLn(map.keyCount, {
    lnRatio,
    lnEffectiveRatio: LN_EFFECTIVE_KEY_COUNTS.has(map.keyCount)
      ? analyzeEffectiveLn(map.notes, { rate, od: resolvePlayedOd(map.od, input.odFlag) }).effectiveLnRatio : undefined,
  }) === true;
  const useLn = lnText != null && (prefer === "ln" || (prefer === "auto" && readsLn));

  const parsed = useLn ? parseLeoBlackLnHalf(lnText as string) : parseLeoBlackRcHalf(rcText, mixed.numericDifficulty);
  if (!parsed) {
    throw new Error(`Unrecognized LeoBlack verdict format: "${useLn ? lnText : rcText}".`);
  }

  const features = extractDanFeatures(map, input, rate);
  const warnings = [...features.warnings];
  warnings.push(`LeoBlack Mixed verdict: "${verdict}" (Sunny SR ${mixed.star.toFixed(3)}, LN ratio ${lnRatio.toFixed(2)}).`);
  if (prefer === "ln" && lnText == null) {
    warnings.push("LN verdict requested but the chart has no LN half; reporting the RC verdict.");
  }
  if (mixed.mixedCompanellaPlan) {
    warnings.push("RC half below 9 stars normally uses Companella, which is not wired; showing the Sunny fallback.");
  }
  if (parsed.boundary === "below") {
    warnings.push("Below the bottom of the LeoBlack difficulty table for this mode.");
  } else if (parsed.boundary === "above") {
    warnings.push("Above the top of the LeoBlack difficulty table for this mode.");
  }

  const patterns = analyzePatternFromText(osuText);
  const vibro = detectVibroFromLongjackPattern(
    patterns.report,
    PATTERNS_CONFIG.LONGJACK_VIBRO_RATIO_THRESHOLD,
    PATTERNS_CONFIG.LONGJACK_VIBRO_MIN_BPM / rate,
  );
  if (vibro) {
    warnings.push("Vibro-like longjack clusters detected; LeoBlack difficulty is likely overestimated.");
  }

  const skillScores: Record<DanSkillFamily, number> = {
    jack: 0,
    stream: 0,
    jumpstream: 0,
    handstream: 0,
    stamina: 0,
    chordjack: 0,
    tech: 0,
    ln: useLn ? mixed.star : 0,
    dan: mixed.star,
  };

  return {
    label: parsed.label,
    variant: parsed.variant,
    displayName: `${parsed.label}${parsed.variant ?? ""}`,
    rawDan: Math.round(parsed.rawDan * 100) / 100,
    estimatedSr: mixed.star,
    family: useLn ? "ln" : "dan",
    // Fixed confidences: lowest when vibro inflates the verdict, then off-table charts.
    confidence: vibro ? 0.35 : parsed.boundary ? 0.4 : 0.72,
    metrics: features.metrics,
    skillScores,
    warnings,
  };
}

/**
 * Run LeoBlack's Mixed estimator the way its own full pipeline does.
 *
 * Mixed already computes Sunny once and shares it with Roxy/Azusa, and Roxy
 * shares its Daniel/Azusa references internally. Do not precompute Daniel
 * outside and pass it in: Roxy canonicalizes the beatmap timing before running
 * its references, so an external Daniel sees different input and shifts the
 * meta numerics on charts with unusual timing.
 */
export function runLeoBlackMixed(osuText: string, options: LeoBlackEstimatorOptions = {}): LeoBlackReworkResult {
  const sunny = runSunnyEstimatorFromText(osuText, options);
  const mixed = runMixedEstimatorFromText(osuText, { ...options, precomputedSunnyResult: sunny });
  // Azusa and Roxy return a star-shaped value derived from their dan
  // prediction (Azusa: 3.4 + 0.38 * numeric). LeoBlack's pipeline replaces it
  // with the actual Sunny SR, which Companella needs as an input. Done here,
  // outside Mixed, so Mixed's own routing inputs stay intact.
  const result = { ...mixed, star: sunny.star };
  const plan = result.mixedCompanellaPlan;
  // Mixed creates a Companella plan before checking that Azusa is below Alpha
  // (numeric 11), the only range where the fusion applies. Outside it the plan
  // could never move the verdict, so it is dropped here instead of running the model.
  if (plan?.fuseRc && plan.onDisagree === "azusa"
    && (plan.rcNumeric == null || !Number.isFinite(plan.rcNumeric) || plan.rcNumeric >= 11)) {
    return { ...result, mixedCompanellaPlan: null };
  }
  return result;
}

/**
 * Sunny alone, without Roxy/Azusa/Daniel routing. The classifier uses it to
 * re-verdict charts whose Roxy signal is pinned at the bottom of its scale;
 * Mixed itself lands on this same result for charts Roxy rejects outright
 * (for example under its minimum note count).
 */
export function runLeoBlackSunny(
  osuText: string,
  options: LeoBlackEstimatorOptions = {},
): Omit<LeoBlackReworkResult, "mixedCompanellaPlan"> {
  return runSunnyEstimatorFromText(osuText, options);
}

export function analyzeLeoBlackPatterns(osuText: string): {
  report: LeoBlackPatternReport;
  topFiveClusters: LeoBlackPatternCluster[];
} {
  return analyzePatternFromText(osuText);
}

/** LeoBlack's vibro test: enough of the chart in longjack clusters above a BPM floor (scaled by rate). */
export function detectLeoBlackVibro(report: LeoBlackPatternReport, rate = 1): boolean {
  return detectVibroFromLongjackPattern(
    report,
    PATTERNS_CONFIG.LONGJACK_VIBRO_RATIO_THRESHOLD,
    PATTERNS_CONFIG.LONGJACK_VIBRO_MIN_BPM / rate,
  );
}

// LeoBlack splits each dan into five tiers, matching this project's --, -, (none), +, ++.
const RC_TIER_VARIANTS: Record<string, string | null> = {
  low: "--",
  "mid/low": "-",
  mid: null,
  "mid/high": "+",
  high: "++",
};

// Dan-level offset of each tier from the level's centre.
const RC_TIER_OFFSETS: Record<string, number> = {
  low: -0.4,
  "mid/low": -0.2,
  mid: 0,
  "mid/high": 0.2,
  high: 0.4,
};

// Daniel labels only have three tiers ("Gamma Mid").
const DANIEL_TIER_VARIANTS: Record<string, string | null> = { Low: "-", Mid: null, High: "+" };
const DANIEL_TIER_OFFSETS: Record<string, number> = { Low: -1 / 3, Mid: 0, High: 1 / 3 };

// Greek dans continue the 1-10 ladder at 11. Some tables spell zeta, eta and
// theta with an extra leading word; those spellings map to the same level.
const GREEK_LEVELS: Record<string, number> = {
  alpha: 11,
  beta: 12,
  gamma: 13,
  delta: 14,
  epsilon: 15,
  "emik zeta": 16,
  zeta: 16,
  "thaumiel eta": 17,
  eta: 17,
  "cloverwisp theta": 18,
  theta: 18,
  iota: 19,
  kappa: 20,
};

const GREEK_LABELS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];

const RC_TIER_PATTERN = /^(.+?) (low|mid\/low|mid\/high|mid|high)$/;
const DANIEL_TIER_PATTERN = /^(.+?) (Low|Mid|High)$/;
const LN_PART_PATTERN = /^(?:\S+ )?LN (\d+)$/;

function splitBoundary(text: string): { boundary: ParsedDanPart["boundary"]; body: string } {
  if (text.startsWith("< ")) return { boundary: "below", body: text.slice(2).trim() };
  if (text.startsWith("> ")) return { boundary: "above", body: text.slice(2).trim() };
  return { boundary: null, body: text };
}

// Levels at or below 0 (the Intro dans) all show as "1"; above 20 shows as kappa.
function normalLabelForLevel(level: number): string {
  if (level <= 0) return "1";
  if (level <= 10) return String(level);
  return GREEK_LABELS[Math.min(level, 20) - 11];
}

// "Intro 1".."Intro 3" sit at -2..0, "Reform N" at N, greek letters at 11-20.
function parseRcBaseLevel(base: string): number | null {
  const intro = base.match(/^Intro ([1-3])$/);
  if (intro) return Number(intro[1]) - 3;
  const reform = base.match(/^Reform (\d+)$/);
  if (reform) return Number(reform[1]);
  return GREEK_LEVELS[base.toLowerCase()] ?? null;
}
