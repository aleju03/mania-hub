import type { ManiaBeatmap } from "./beatmap-parser";
import { estimateDanCourseSr, isDanCourse } from "./dan-estimator/courses";
import { extractDanFeatures } from "./dan-estimator/features";
import { chooseSkillFamily } from "./dan-estimator/family-choice";
import { getInputRate, parseDan, srToRawDan } from "./dan-estimator/labels";
import { estimateLnDan } from "./dan-estimator/ln";
import { estimateFamilyScores } from "./dan-estimator/scoring";
import type {
  DanEstimate,
  DanEstimateInput,
} from "./dan-estimator/types";

export type {
  DanEstimate,
  DanEstimateDebug,
  DanEstimateInput,
  DanFamilyChoiceDebug,
  DanFeatureExtractionResult,
  DanFeatureMetrics,
  DanPrimaryFamily,
  DanScoreContribution,
  DanScoringDebug,
  DanSkillFamily,
} from "./dan-estimator/types";

export function estimateDan(map: ManiaBeatmap, input: DanEstimateInput = {}): DanEstimate {
  if (map.keyCount !== 4) {
    throw new Error("Dan estimates are currently only supported for 4K beatmaps.");
  }

  const rate = getInputRate(input);
  const features = extractDanFeatures(map, input, rate);
  const { notes, durationMs, orderedRows, metrics } = features;
  const warnings = [...features.warnings];
  if (metrics.holdRatio > 0.28) {
    warnings.push("This looks LN-heavy; using LN dan calibration when chart pressure is strong.");
  }

  const baseStarRating = Number.isFinite(input.starRating) ? Math.max(0, input.starRating ?? 0) : 0;
  const starRating = baseStarRating > 0 ? baseStarRating * Math.pow(rate, 0.7) : 0;
  const scoring = estimateFamilyScores(metrics, starRating, durationMs);
  const skillScores = scoring.skillScores;
  const lnEstimate = estimateLnDan(map, input, metrics, starRating, durationMs, rate);
  if (lnEstimate) {
    return {
      label: lnEstimate.label,
      variant: lnEstimate.variant,
      displayName: lnEstimate.displayName,
      rawDan: lnEstimate.rawDan,
      estimatedSr: lnEstimate.estimatedSr,
      family: "ln",
      confidence: lnEstimate.confidence,
      metrics,
      skillScores: {
        ...skillScores,
        ln: lnEstimate.estimatedSr,
      },
      warnings,
      debug: {
        scoring: scoring.debug,
        familyChoice: {
          topFamily: "ln",
          topScore: lnEstimate.estimatedSr,
          selectedFamily: "ln",
          reason: lnEstimate.reason,
        },
      },
    };
  }
  const familyChoice = chooseSkillFamily(skillScores, metrics);
  const skillFamily = familyChoice.family;
  const isCourse = isDanCourse(input, orderedRows, durationMs, notes.length);
  const family = isCourse ? "dan" : skillFamily;
  const estimatedSr = isCourse
    ? estimateDanCourseSr(metrics, starRating, skillScores[skillFamily])
    : skillScores[skillFamily];
  const rawDan = srToRawDan(estimatedSr, skillFamily);
  const parsed = parseDan(rawDan);
  const confidence = Math.max(
    0.15,
    Math.min(
      0.92,
      0.55
        + Math.min(0.18, notes.length / 6000)
        + (map.keyCount === 4 ? 0.12 : -0.1)
        + (starRating > 0 ? 0.07 : -0.05)
        - (metrics.holdRatio > 0.45 ? 0.18 : 0),
    ),
  );

  return {
    ...parsed,
    rawDan,
    estimatedSr,
    family,
    confidence,
    metrics,
    skillScores,
    warnings,
    debug: {
      scoring: scoring.debug,
      familyChoice: familyChoice.debug,
    },
  };
}
