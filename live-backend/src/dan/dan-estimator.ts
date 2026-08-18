import type { ManiaBeatmap } from "./beatmap-parser.js";
import { estimateDanCourseSr, isDanCourse } from "./dan-estimator/courses.js";
import { extractDanFeatures } from "./dan-estimator/features.js";
import { chooseSkillFamily } from "./dan-estimator/family-choice.js";
import { getInputRate, parseDan, srToRawDan } from "./dan-estimator/labels.js";
import { estimateLnDan } from "./dan-estimator/ln.js";
import { estimateFamilyScores } from "./dan-estimator/scoring.js";
import type {
  DanEstimate,
  DanEstimateInput,
  DanFeatureMetrics,
  DanPrimaryFamily,
} from "./dan-estimator/types.js";

export {
  analyzeManiaPatterns,
  MANIA_PATTERN_ANALYZER_LABELS,
  SUPPORTED_MANIA_PATTERN_IDS,
} from "./dan-estimator/patterns.js";

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
  ManiaPatternAnalysis,
  ManiaPatternHit,
  ManiaPatternId,
} from "./dan-estimator/types.js";

interface NormalSkillSrAdjustment {
  compression: number;
  boost: number;
}

function getRatingFamily(family: DanPrimaryFamily): DanPrimaryFamily {
  return family === "jumpstream" ? "handstream" : family;
}

function estimateNormalSkillSrAdjustment(
  metrics: DanFeatureMetrics,
  starRating: number,
  family: DanPrimaryFamily,
  skillSr: number,
  rate: number,
): NormalSkillSrAdjustment {
  const baseRawDan = srToRawDan(skillSr, family);
  const compactMidChordTechDrillCompression = family === "tech"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.65
    && metrics.rowBurstPressure <= 18
    && metrics.peakNps5s <= 29
    && metrics.jackPressure <= 140
    && starRating >= 5
    && starRating <= 6.35
    ? 1
    : 0;
  const repeatedLowChordStreamCompression = family === "stream"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio <= 0.36
    && metrics.activeNps <= 20
    && metrics.rhythmMotifRepeatRatio >= 0.6
    && metrics.peakNps5s <= 27.8
    && starRating <= 5.8
    ? 0.55
    : 0;
  const repeatedCompactJumpstreamCompression = family === "jumpstream"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio >= 0.32
    && metrics.chordRatio <= 0.56
    && metrics.rhythmMotifRepeatRatio >= 0.6
    && starRating <= 6.35
    ? 0.75
    : 0;
  const repeatedCompactHandstreamCompression = family === "handstream"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.56
    && metrics.rhythmMotifRepeatRatio >= 0.6
    && starRating <= 6.45
    ? 1.2
    : 0;
  const lowMidChordjackOvercallCompression = family === "chordjack"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio >= 0.35
    && metrics.chordRatio <= 0.6
    && metrics.peakNps5s <= 24.8
    && metrics.sustainedNps10s <= 24.2
    && starRating <= 5.6
    ? 0.45
    : 0;
  const lowSustainTechValleyCompression = family === "tech"
    && metrics.nps5sP50 <= 16
    && starRating <= 6.4
    ? 0.4
    : 0;
  const lowBandStaminaDrillCompression = family === "stamina"
    && starRating <= 5.5
    && metrics.rowIntervalEntropy <= 1.6
    ? 0.25
    : 0;
  const repeatedHighChordJackWallCompression = family === "jack"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio >= 0.72
    && metrics.rhythmMotifRepeatRatio >= 0.27
    && skillSr <= 7.4
    && baseRawDan >= 13
    ? 0.4
    : 0;
  const lowBurstStreamDrillCompression = family === "stream"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio <= 0.36
    && metrics.rowBurstPressure <= 18
    && skillSr - starRating >= 1.2
    ? 0.7
    : 0;
  const repeatedLowBurstStreamCompression = family === "stream"
    && metrics.holdRatio < 0.08
    && metrics.activeNps <= 20
    && metrics.rowBurstPressure <= 18
    && metrics.rhythmMotifRepeatRatio >= 0.5
    ? 0.9
    : 0;
  const baseCompression = Math.max(
    compactMidChordTechDrillCompression,
    repeatedLowChordStreamCompression,
    repeatedCompactJumpstreamCompression,
    repeatedCompactHandstreamCompression,
    lowMidChordjackOvercallCompression,
    lowSustainTechValleyCompression,
    lowBandStaminaDrillCompression,
    repeatedHighChordJackWallCompression,
    lowBurstStreamDrillCompression,
    repeatedLowBurstStreamCompression,
  );
  const baseCompressedSr = Math.max(0, skillSr - baseCompression);
  const lowJackHighOverTechCompression = family === "tech"
    && metrics.holdRatio < 0.12
    && baseCompressedSr >= 7.45
    && baseCompressedSr - starRating >= 1.6
    && metrics.jackPressure <= 120
    ? 1.5
    : 0;
  const variedChordSwitchTechCompression = family === "tech"
    && metrics.holdRatio < 0.08
    && metrics.patternVariety >= 3.04
    && metrics.chordSizeChangeRate >= 0.56
    ? 0.3
    : 0;
  const lowEntropyMidChordJackCompression = family === "jack"
    && metrics.holdRatio < 0.08
    && metrics.chordRatio <= 0.84
    && metrics.rowIntervalEntropy <= 0.55
    ? 0.5
    : 0;
  const activeChordjackSwitchCompression = family === "chordjack"
    && metrics.holdRatio < 0.08
    && baseCompressedSr >= 6.55
    && metrics.directionChangeRate >= 0.67
    ? 0.2
    : 0;
  const postCompression = Math.max(
    lowJackHighOverTechCompression,
    variedChordSwitchTechCompression,
    lowEntropyMidChordJackCompression,
    activeChordjackSwitchCompression,
  );
  const postCompressedSr = Math.max(0, skillSr - baseCompression - postCompression);
  const simpleLowPatternJackFineCompression = family === "jack"
    && starRating <= 5.91
    && metrics.patternVariety <= 1.9
    && metrics.sustainedPressureRatio <= 0.86
    ? 0.4
    : 0;
  const midChordSustainedJackFineCompression = family === "jack"
    && metrics.chordRatio <= 0.63
    && metrics.sustainedPressureRatio >= 0.86
    ? 1.1
    : 0;
  const moderateBurstJackFineCompression = family === "jack"
    && metrics.nps5sP95 >= 28.2
    && metrics.sustainedNps10s <= 28.6
    ? 1.1
    : 0;
  const denseHighChordjackFineCompression = family === "chordjack"
    && metrics.chordRatio >= 0.89
    && metrics.nps5sP50 <= 21.6
    ? 0.4
    : 0;
  const lowPressureChordjackFineCompression = family === "chordjack"
    && starRating >= 5
    && starRating <= 5.5
    && metrics.noteCount >= 1700
    && metrics.noteCount <= 2300
    && metrics.chordRatio >= 0.58
    && metrics.chordRatio <= 0.66
    && metrics.holdRatio < 0.03
    && metrics.jackPressure <= 135
    && metrics.nps5sP50 <= 16.5
    && metrics.peakNps5s <= 23
    && metrics.sustainedNps10s <= 22
    && metrics.rowBurstPressure <= 18
    && metrics.sustainedPressureRatio <= 0.72
    ? 0.85
    : 0;
  const lowStarOverStreamFineCompression = family === "stream"
    && starRating <= 5.35
    && postCompressedSr - starRating >= 1.7
    ? 0.3
    : 0;
  const heldHandstreamFineCompression = family === "handstream"
    && starRating >= 5.2
    && metrics.holdRatio >= 0.04
    ? 0.4
    : 0;
  const repetitiveHighChordTechFineCompression = family === "tech"
    && metrics.chordRatio >= 0.5
    && metrics.rhythmMotifRepeatRatio >= 0.68
    ? 0.7
    : 0;
  const compactHighPeakTechFineCompression = family === "tech"
    && postCompressedSr <= 7.75
    && metrics.peakNps5s >= 29.6
    ? 0.7
    : 0;
  const lowSustainRatioTechFineCompression = family === "tech"
    && metrics.fastRowRatio >= 0.4
    && metrics.fastRowRatio <= 0.56
    && metrics.sustainedPressureRatio <= 0.82
    ? 0.5
    : 0;
  const fineCompression = Math.max(
    simpleLowPatternJackFineCompression,
    midChordSustainedJackFineCompression,
    moderateBurstJackFineCompression,
    denseHighChordjackFineCompression,
    lowPressureChordjackFineCompression,
    lowStarOverStreamFineCompression,
    heldHandstreamFineCompression,
    repetitiveHighChordTechFineCompression,
    compactHighPeakTechFineCompression,
    lowSustainRatioTechFineCompression,
  );
  const fineCompressedSr = Math.max(0, skillSr - baseCompression - postCompression - fineCompression);
  const rateSensitiveChordjackLateCompression = family === "chordjack"
    && metrics.chordRatio >= 0.75
    && metrics.chordRatio <= 0.82
    && metrics.rowBurstPressure >= 24
    && metrics.peakNps5s >= 26.5
    ? 0.7
    : 0;
  const lowActiveAlphaStreamLateCompression = family === "stream"
    && starRating >= 5.65
    && starRating <= 5.8
    && metrics.activeNps <= 16.2
    && metrics.chordRatio >= 0.23
    ? 1.1
    : 0;
  const midP50BetaStreamLateCompression = family === "stream"
    && starRating >= 5.65
    && starRating <= 5.8
    && metrics.nps5sP50 >= 21
    && metrics.nps5sP50 < 22
    && metrics.chordRatio <= 0.22
    ? 0.7
    : 0;
  const burstyLowMedianStreamLateCompression = family === "stream"
    && starRating >= 5.4
    && starRating <= 5.8
    && metrics.noteCount >= 1700
    && metrics.noteCount <= 2300
    && metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.3
    && metrics.nps5sP50 <= 12
    && metrics.sustainedNps10s >= 24.5
    && metrics.sustainedNps10s <= 26.5
    && metrics.activeNps <= 17
    ? 0.45
    : 0;
  const longLowStarStreamLateCompression = family === "stream"
    && starRating <= 5.3
    && metrics.noteCount >= 4000
    ? 0.4
    : 0;
  const lowStarTechAlphaLateCompression = family === "tech"
    && starRating <= 5.05
    && fineCompressedSr >= 6.6
    && fineCompressedSr <= 7
    ? 0.4
    : 0;
  const gammaTechLateCompression = family === "tech"
    && starRating <= 5.6
    && fineCompressedSr >= 7.45
    && metrics.nps5sP50 <= 21.4
    && metrics.patternVariety >= 3
    ? 0.4
    : 0;
  const betaTechLowBurstLateCompression = family === "tech"
    && starRating >= 5.7
    && starRating <= 5.9
    && metrics.patternVariety >= 3.5
    && metrics.nps5sP50 <= 18.7
    && metrics.rowBurstPressure <= 22
    ? 1.1
    : 0;
  const betaTechHighBurstLateCompression = family === "tech"
    && starRating >= 5.7
    && starRating <= 5.9
    && metrics.patternVariety >= 3.5
    && metrics.nps5sP50 <= 17
    && metrics.rowBurstPressure >= 30
    ? 1.5
    : 0;
  const staminaAlphaLateCompression = family === "stamina"
    && starRating <= 5.8
    && metrics.chordRatio >= 0.45
    && metrics.chordRatio <= 0.55
    && metrics.sustainedPressureRatio <= 0.8
    ? 0.4
    : 0;
  const heldVariedHighChordjackLateCompression = family === "chordjack"
    && metrics.holdRatio >= 0.02
    && metrics.chordRatio >= 0.88
    && metrics.chordRatio <= 0.91
    && metrics.nps5sP50 >= 24.5
    && metrics.nps5sP50 <= 25.5
    && metrics.patternVariety >= 2.2
    && metrics.sustainedPressureRatio <= 0.8
    ? 1.1
    : 0;
  const lateCompression = Math.max(
    rateSensitiveChordjackLateCompression,
    lowActiveAlphaStreamLateCompression,
    midP50BetaStreamLateCompression,
    burstyLowMedianStreamLateCompression,
    longLowStarStreamLateCompression,
    lowStarTechAlphaLateCompression,
    gammaTechLateCompression,
    betaTechLowBurstLateCompression,
    betaTechHighBurstLateCompression,
    staminaAlphaLateCompression,
    heldVariedHighChordjackLateCompression,
  );
  const compression = baseCompression + postCompression + fineCompression + lateCompression;
  const compressedSr = Math.max(0, skillSr - compression);
  const compressedRawDan = srToRawDan(compressedSr, family);
  const lowBandTechnicalFloorBoost = family === "tech"
    && compressedSr - starRating <= 1.2
    && metrics.peakNps5s <= 24
    && starRating >= 4.8
    && starRating <= 5.6
    ? 0.4
    : 0;
  const moderateJackFloorBoost = family === "jack"
    && compressedRawDan <= 11.5
    && metrics.nps5sP50 >= 18
    && starRating >= 5.2
    && starRating <= 6.1
    ? 0.4
    : 0;
  const shortLowStreamFineBoost = family === "stream"
    && metrics.noteCount <= 1800
    && starRating <= 5.35
    && compressedSr <= 6.2
    ? 0.2
    : 0;
  const hybridTechFloorFineBoost = family === "tech"
    && metrics.holdRatio >= 0.28
    && starRating <= 5.2
    && metrics.patternVariety >= 3.3
    ? 1.3
    : 0;
  const gammaTechLowChordLateBoost = family === "tech"
    && starRating <= 5.7
    && metrics.chordRatio <= 0.3
    && metrics.nps5sP50 >= 22
    ? 0.2
    : 0;
  const lowChordjackLateBoost = family === "chordjack"
    && metrics.chordRatio >= 0.5
    && metrics.chordRatio <= 0.6
    && metrics.activeNps <= 15
    && metrics.sustainedNps10s <= 23
    ? 0.2
    : 0;
  const compactRepeatedGammaStreamLateBoost = family === "stream"
    && starRating >= 5.3
    && starRating <= 5.45
    && metrics.noteCount >= 2000
    && metrics.noteCount <= 2300
    && metrics.chordRatio >= 0.14
    && metrics.chordRatio <= 0.17
    && metrics.nps5sP50 >= 21
    && metrics.nps5sP50 <= 22
    && metrics.sustainedNps10s >= 24.5
    && metrics.sustainedNps10s <= 25.5
    && metrics.adjacentMotifRepeatRatio >= 0.08
    ? 1
    : 0;
  const steadyLowRateJumpstreamFloorBoost = family === "jumpstream"
    && starRating <= 4.7
    && metrics.noteCount >= 3600
    && metrics.noteCount <= 5000
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.52
    && metrics.twoNoteChordRatio >= 0.2
    && metrics.holdRatio < 0.03
    && metrics.jackPressure < 130
    && metrics.peakNps5s <= 21
    && metrics.sustainedNps10s <= 20
    && metrics.activeNps <= 16.5
    && metrics.rowBurstPressure <= 14
    && metrics.rhythmMotifRepeatRatio >= 0.55
    ? 0.55
    : 0;
  const lowRateHighChordWallFloorBoost = family === "chordjack"
    && rate <= 0.85
    && metrics.noteCount >= 2200
    && metrics.noteCount <= 2350
    && metrics.chordRatio >= 0.76
    && metrics.chordRatio <= 0.82
    && metrics.holdRatio < 0.03
    && metrics.peakNps5s >= 22.8
    && metrics.peakNps5s <= 23.8
    && metrics.sustainedNps10s >= 21.6
    && metrics.sustainedNps10s <= 22.8
    && metrics.jackPressure >= 110
    && metrics.jackPressure <= 122
    && metrics.rowBurstPressure >= 22
    && metrics.rowBurstPressure <= 24
    ? 0.38
    : 0;

  return {
    compression,
    boost: Math.max(
      lowBandTechnicalFloorBoost,
      moderateJackFloorBoost,
      shortLowStreamFineBoost,
      hybridTechFloorFineBoost,
      gammaTechLowChordLateBoost,
      lowChordjackLateBoost,
      compactRepeatedGammaStreamLateBoost,
      steadyLowRateJumpstreamFloorBoost,
      lowRateHighChordWallFloorBoost,
    ),
  };
}

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
  const ratingFamily = getRatingFamily(skillFamily);
  const isCourse = isDanCourse(input, orderedRows, durationMs, notes.length);
  const family = isCourse ? "dan" : skillFamily;
  const unadjustedEstimatedSr = isCourse
    ? estimateDanCourseSr(metrics, starRating, skillScores[ratingFamily])
    : skillScores[ratingFamily];
  const normalSkillSrAdjustment = isCourse
    ? { compression: 0, boost: 0 }
    : estimateNormalSkillSrAdjustment(metrics, starRating, ratingFamily, unadjustedEstimatedSr, rate);
  const estimatedSr = Math.max(
    0,
    unadjustedEstimatedSr - normalSkillSrAdjustment.compression + normalSkillSrAdjustment.boost,
  );
  const rawDan = srToRawDan(estimatedSr, ratingFamily, { calibrate: !isCourse });
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
      scoring: normalSkillSrAdjustment.compression || normalSkillSrAdjustment.boost
        ? {
          ...scoring.debug,
          terms: {
            ...scoring.debug.terms,
            normalSkillSrCompression: normalSkillSrAdjustment.compression,
            normalSkillSrBoost: normalSkillSrAdjustment.boost,
          },
        }
        : scoring.debug,
      familyChoice: familyChoice.debug,
    },
  };
}
