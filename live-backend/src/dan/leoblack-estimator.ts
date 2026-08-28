// Shared by the backend and the frontend (which reaches it through the #dan/*
// alias); the vendored LeoBlack tree it drives lives in live-backend/vendor.
import type { ManiaBeatmap } from "./beatmap-parser.js";
import type { DanEstimate, DanEstimateInput, DanSkillFamily } from "./dan-estimator/types.js";
import { extractDanFeatures } from "./dan-estimator/features.js";
import { getInputRate } from "./dan-estimator/labels.js";
import { lnPrimaryMinRatioFor } from "./dan-estimator/ln.js";
import {
  runMixedEstimatorFromText,
  type LeoBlackEstimatorOptions,
  type LeoBlackReworkResult,
} from "../../vendor/leoblack/estimator/mixedEstimator.js";
import { runSunnyEstimatorFromText } from "../../vendor/leoblack/estimator/sunnyEstimator.js";
import {
  analyzePatternFromText,
  type LeoBlackPatternCluster,
  type LeoBlackPatternReport,
} from "../../vendor/leoblack/patterns/service.js";
import { PATTERNS_CONFIG } from "../../vendor/leoblack/patterns/config.js";
import { detectVibroFromLongjackPattern } from "../../vendor/leoblack/vibro.js";

// Maps the vendored LeoBlack "Mixed" estimator (live-backend/vendor/leoblack/) onto the app's
// DanEstimate shape and label vocabulary (normal family: 1-10 then greek; LN family:
// plain numbers), so it can run side by side with estimateDan/estimateDanielDan.

export interface LeoBlackDanInput extends DanEstimateInput {
  // Which half of a hybrid "RC || LN" verdict to report. "auto" picks LN when the
  // chart is LN-dominant (the keymode's identity line of holds or more).
  preferFamily?: "rc" | "ln" | "auto";
}

export interface ParsedDanPart {
  label: string;
  variant: string | null;
  rawDan: number;
  boundary: "below" | "above" | null;
}

// Upstream tiers split each dan into five bands, same as the app's --/-/none/+/++.
const RC_TIER_VARIANTS: Record<string, string | null> = {
  low: "--",
  "mid/low": "-",
  mid: null,
  "mid/high": "+",
  high: "++",
};

const RC_TIER_OFFSETS: Record<string, number> = {
  low: -0.4,
  "mid/low": -0.2,
  mid: 0,
  "mid/high": 0.2,
  high: 0.4,
};

// Daniel-sourced labels only have three tiers ("Gamma Mid" style).
const DANIEL_TIER_VARIANTS: Record<string, string | null> = { Low: "-", Mid: null, High: "+" };
const DANIEL_TIER_OFFSETS: Record<string, number> = { Low: -1 / 3, Mid: 0, High: 1 / 3 };

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

function normalLabelForLevel(level: number): string {
  if (level <= 0) return "1";
  if (level <= 10) return String(level);
  return GREEK_LABELS[Math.min(level, 20) - 11];
}

function parseRcBaseLevel(base: string): number | null {
  const intro = base.match(/^Intro ([1-3])$/);
  if (intro) return Number(intro[1]) - 3;
  const reform = base.match(/^Reform (\d+)$/);
  if (reform) return Number(reform[1]);
  return GREEK_LEVELS[base.toLowerCase()] ?? null;
}

export function parseLeoBlackRcHalf(text: string, numericDifficulty: number | null): ParsedDanPart | null {
  let boundary: ParsedDanPart["boundary"] = null;
  let body = text;
  if (body.startsWith("< ")) {
    boundary = "below";
    body = body.slice(2).trim();
  } else if (body.startsWith("> ")) {
    boundary = "above";
    body = body.slice(2).trim();
  }

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
      // Daniel numerics are bottom-anchored (11 + index + t with t in [0,1)).
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

export function parseLeoBlackLnHalf(text: string): ParsedDanPart | null {
  let boundary: ParsedDanPart["boundary"] = null;
  let body = text;
  if (body.startsWith("< ")) {
    boundary = "below";
    body = body.slice(2).trim();
  } else if (body.startsWith("> ")) {
    boundary = "above";
    body = body.slice(2).trim();
  }

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

export function estimateLeoBlackDan(map: ManiaBeatmap, osuText: string, input: LeoBlackDanInput = {}): DanEstimate {
  if (map.keyCount !== 4) {
    throw new Error("LeoBlack dan mapping currently only supports 4K beatmaps (use runLeoBlackMixed for raw 6K/7K verdicts).");
  }

  const rate = getInputRate(input);
  const mixed = runLeoBlackMixed(osuText, { speedRate: rate });
  const verdict = String(mixed.estDiff ?? "").trim();
  if (!verdict || /^Invalid\b/i.test(verdict) || /^Unknown\b/i.test(verdict)) {
    throw new Error(`LeoBlack estimator could not classify this chart (${verdict || "empty verdict"}).`);
  }

  const parts = verdict.split("||").map((part) => part.trim()).filter(Boolean);
  const rcText = parts[0] ?? "";
  const lnText = parts.length >= 2 ? parts[parts.length - 1] : null;

  const prefer = input.preferFamily ?? "auto";
  const lnRatio = Number(mixed.lnRatio);
  const useLn = lnText != null && (prefer === "ln" || (prefer === "auto" && lnRatio >= lnPrimaryMinRatioFor(map.keyCount)));

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
    confidence: vibro ? 0.35 : parsed.boundary ? 0.4 : 0.72,
    metrics: features.metrics,
    skillScores,
    warnings,
  };
}

// NOTE on dedupe: the vendored Mixed chain already shares its expensive work.
// Mixed computes Sunny once and threads it to Roxy/Azusa via
// precomputedSunnyResult, and Roxy computes its Daniel/Azusa references once
// and shares them internally. Do NOT precompute Daniel here and pass it via
// precomputedDanielResult: Roxy canonicalizes the beatmap timing before running
// its references, so an externally computed Daniel sees subtly different input
// and shifts the meta numerics on charts with unusual timing (verified on the
// dan corpus). The pass-through below is the fastest form that keeps output
// byte-identical to upstream.
export function runLeoBlackMixed(osuText: string, options: LeoBlackEstimatorOptions = {}): LeoBlackReworkResult {
  return runMixedEstimatorFromText(osuText, options);
}

// Direct Sunny baseline (no Roxy/Azusa/Daniel routing). The classifier uses it
// to re-verdict charts whose Roxy raw signal is pinned at the scale floor; the
// mixed router itself already lands on this exact result for charts Roxy
// rejects outright (e.g. under its minimum note count).
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

export function detectLeoBlackVibro(report: LeoBlackPatternReport, rate = 1): boolean {
  return detectVibroFromLongjackPattern(
    report,
    PATTERNS_CONFIG.LONGJACK_VIBRO_RATIO_THRESHOLD,
    PATTERNS_CONFIG.LONGJACK_VIBRO_MIN_BPM / rate,
  );
}
