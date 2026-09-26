// Scores a 4K chart for each skill family (jack, stream, jumpstream,
// handstream, stamina, chordjack, tech) on the osu! star rating scale. Every
// family starts from one base pressure estimate built from note density, adds
// its own bonuses, subtracts compressions for chart shapes where the numbers
// overstate the dan, and is scaled down for LN-heavy charts. The family choice
// and the SR-to-dan mapping happen elsewhere; the individual terms live in
// scoring-terms.ts and the debug breakdown in scoring-debug.ts.

import { minGate } from "./math";
import {
  scoringContributions,
  scoringDebugGates,
  scoringDebugTerms,
  type FamilyBonuses,
  type PracticeFamily,
  type PracticeInflation,
} from "./scoring-debug";
import { scoringTerms, type ScoringTerms } from "./scoring-terms";
import type { DanFeatureMetrics, DanScoringDebug, DanSkillFamily } from "./types";

export interface DanFamilyScoreResult {
  skillScores: Record<DanSkillFamily, number>;
  debug: DanScoringDebug;
}

// Base pressure in SR units: the larger of a peak-density estimate (5s and 1s
// peak NPS) and a stamina estimate (best 10s sustained NPS).
const BASE_PRESSURE_CALIBRATION = {
  densityBase: 2.45,
  peak5sWeight: 0.095,
  peak1sWeight: 0.018,
  staminaBase: 2.65,
  sustained10sWeight: 0.16,
};

const PRACTICE_FAMILIES: readonly PracticeFamily[] = ["jack", "stream", "jumpstream", "handstream", "stamina", "chordjack", "tech"];

// starRating is the rate-adjusted osu! star rating (0 when unknown); durationMs
// is the chart length at the played rate.
export function estimateFamilyScores(metrics: DanFeatureMetrics, starRating: number, durationMs: number): DanFamilyScoreResult {
  const densitySr = BASE_PRESSURE_CALIBRATION.densityBase
    + metrics.peakNps5s * BASE_PRESSURE_CALIBRATION.peak5sWeight
    + metrics.peakNps1s * BASE_PRESSURE_CALIBRATION.peak1sWeight;
  const staminaSr = BASE_PRESSURE_CALIBRATION.staminaBase + metrics.sustainedNps10s * BASE_PRESSURE_CALIBRATION.sustained10sWeight;
  const structuralSr = Math.max(densitySr, staminaSr);
  const base = structuralSr;
  // Held notes carry less of the rice difficulty these families measure, so
  // hold ratio (share of notes that are LNs) scales every family down.
  const lnNerf = metrics.holdRatio > 0.45 ? 0.72 : metrics.holdRatio > 0.34 ? 0.76 : metrics.holdRatio > 0.28 ? 0.84 : 1;

  const terms = scoringTerms(metrics, starRating, durationMs);
  const t = { ...terms, ...familyBonuses(metrics, terms) };

  // One term per line; the order of additions is part of the result, since
  // floating-point sums depend on it.
  const rawSkillScores: Record<DanSkillFamily, number> = {
    jack: (base
      + t.jackBonus
      + t.shortLnHybridRiceRequirementBonus * 0.6
      + t.extremeChordwallSpeedBonus
      + t.fastSimpleChordWallJackFloorBonus
      + t.denseSimpleChordWallRateBonus
      + t.highEndFastWallJackBonus
      + t.sustainedHighChordWallBonus
      + t.midHighChordjackDeltaBridgeBonus
      + t.highRateVariedWallJackBridgeBonus
      + t.marathonTechnicalEnduranceBonus
      + t.lowSrDenseWallJackBonus
      + t.compactJackUnderrateBonus
      + t.lowRateHighChordJackBonus
      + t.slowRepetitiveJackstreamBonus
      + t.ratedRepetitiveSpeedjackBonus
      + t.compactHighChordDeltaJackBonus
      + t.denseWallJackPenaltyRelief
      + t.midChordSpeedjackJackBonus
      + t.highRateMidChordSpeedjackJackBonus
      + t.longGammaHighChordjackFloorBonus
      + t.heldLongGammaHighChordjackFloorBonus
      - t.midRatePlainWallJackCompression
      - t.plainHighChordWallRateCompression
      - t.variedMidHighChordWallCompression
      - t.lowRateMidChordJackCompression
      - t.introMidChordJackCompression
      - t.midVarietyHighSpeedCompression
      - t.lowMidRateOverpromotionCompression
      - t.lowMidSustainedPressureCompression
      - t.sparseLowSrTechVocabularyCompression * 0.7
      - t.introHighChordFlowTechCompression * 0.7
      - t.highChordSoftJackPenalty
      - t.denseJackSrCompression
      - t.mediumWallJackSrCompression
      - t.compactJackOverboostCompression
      - t.farmJumptrillJackCompression
      - t.longSparseJackDropJackCompression
      - t.shortLnHybridStructuralCompression
      - t.lowChordSteadySpeedStructuralCompression
      - t.moderateChordSteadyStreamStructuralCompression
      - t.compactHandstreamStaminaStructuralCompression
      - t.compactTechnicalFlowStructuralCompression * 0.65
      - t.compactChordWallStructuralCompression
      - t.simpleDenseChordWallStructuralCompression
      - t.lowRateDenseChordWallCompression
      - t.simpleMidHighChordWallStructuralCompression
      - t.awkwardMidRateChordjackWallCompression
      - t.midHighChordSustainedTechStructuralCompression
      - t.shortDenseWallSrCompression
      - t.compactMidRateWallJackCompression
      - t.lowEdgeMidChordJackCompression
      - t.lowSrShortDenseWallCompression
      - t.mediumWallJackOverrateCompression
      - t.midHighChordGammaCompression
      - t.compactPureChordjackStaminaCompression
      - t.shortSimpleChordjackWallStructuralCompression
      - t.shortHighChordWallStructuralCompression
      - t.shortSpikeCompression
      - t.localizedJumptrillSpikeCompression) * lnNerf,
    stream: (base
      + t.streamBonus
      + t.shortLnHybridRiceRequirementBonus * 0.85
      + t.highSpeedEndgameBonus
      + t.lowChordSpeedjackAnchorBonus
      + t.highEntropyLowChordEnduranceBridgeBonus
      + t.variedLowChordSpeedjackBridgeBonus
      + t.marathonTechnicalEnduranceBonus * 0.85
      + t.lightRowBurstStreamBonus
      - t.introHighChordFlowTechCompression * 0.6
      - t.lowDensityChordFlowTechCompression * 0.5
      - t.lowRateMidChordJackCompression
      - t.introMidChordJackCompression
      - t.midVarietyHighSpeedCompression
      - t.lowMidRateOverpromotionCompression
      - t.lowMidSustainedPressureCompression
      - t.sparseLowSrTechVocabularyCompression
      - t.lowChordBurstStreamNerf
      - t.variedLowChordSpeedCompression
      - t.thinLowChordSpeedCompression
      - t.highVarietyThinStreamEdgeCompression
      - t.longSparseStreamCompression
      - t.farmJumptrillStreamCompression
      - t.longSparseJackDropStreamCompression
      - t.shortLnHybridStructuralCompression
      - t.lowChordSteadySpeedStructuralCompression
      - t.moderateChordSteadyStreamStructuralCompression
      - t.compactHandstreamStaminaStructuralCompression
      - t.compactTechnicalFlowStructuralCompression * 0.6
      - t.compactChordWallStructuralCompression
      - t.simpleDenseChordWallStructuralCompression
      - t.lowRateDenseChordWallCompression
      - t.simpleMidHighChordWallStructuralCompression
      - t.awkwardMidRateChordjackWallCompression
      - t.midHighChordSustainedTechStructuralCompression * 0.85
      - t.shortDenseWallSrCompression
      - t.lowSrShortDenseWallCompression
      - t.mediumWallJackOverrateCompression
      - t.midHighChordGammaCompression
      - t.compactPureChordjackStaminaCompression
      - t.shortSimpleChordjackWallStructuralCompression
      - t.shortHighChordWallStructuralCompression
      - t.shortSpikeCompression
      - t.localizedJumptrillSpikeCompression) * lnNerf,
    jumpstream: (base
      + t.jumpstreamBonus
      + t.sustainedLightJumpstreamBonus
      + t.compactModerateChordSpeedBonus * 0.75
      + t.speedEnduranceBonus * 0.35
      + t.longSteadyStreamBonus * 0.35
      + t.shortLnHybridRiceRequirementBonus * 0.75
      - t.lowRateMidChordJackCompression * 0.5
      - t.introMidChordJackCompression * 0.5
      - t.midVarietyHighSpeedCompression
      - t.lowMidRateOverpromotionCompression
      - t.lowMidSustainedPressureCompression * 0.7
      - t.sparseLowSrTechVocabularyCompression * 0.7
      - t.farmJumptrillStreamCompression
      - t.longSparseStreamCompression * 0.7
      - t.shortLnHybridStructuralCompression
      - t.lowChordSteadySpeedStructuralCompression * 0.7
      - t.compactHandstreamStaminaStructuralCompression * 0.65
      - t.compactTechnicalFlowStructuralCompression * 0.7
      - t.compactChordWallStructuralCompression
      - t.simpleDenseChordWallStructuralCompression
      - t.lowRateDenseChordWallCompression
      - t.simpleMidHighChordWallStructuralCompression
      - t.awkwardMidRateChordjackWallCompression
      - t.midHighChordSustainedTechStructuralCompression * 0.75
      - t.shortDenseWallSrCompression
      - t.lowSrShortDenseWallCompression
      - t.mediumWallJackOverrateCompression
      - t.midHighChordGammaCompression
      - t.compactPureChordjackStaminaCompression
      - t.shortSimpleChordjackWallStructuralCompression
      - t.shortHighChordWallStructuralCompression
      - t.shortSpikeCompression
      - t.localizedJumptrillSpikeCompression) * lnNerf,
    handstream: (base
      + t.handstreamBonus
      + t.fastMidChordHandstreamBridgeBonus
      + t.marathonTechnicalEnduranceBonus * 0.7
      - t.compactMidChordHandstreamCompression
      - t.lowRateMidChordJackCompression
      - t.introMidChordJackCompression
      - t.midVarietyHighSpeedCompression
      - t.lowMidRateOverpromotionCompression
      - t.sparseLowSrTechVocabularyCompression * 0.7
      - t.introHighChordFlowTechCompression * 0.7
      - t.moderateMidChordStaminaNerf * 0.25
      - t.highEndMidChordStaminaNerf * 0.35
      - t.longJumpstreamStaminaCompression * 0.45
      - t.simpleLongJumpstreamPatternCompression * 0.35
      - t.farmJumptrillHandstreamCompression
      - t.longSparseJackDropHandstreamCompression
      - t.shortLnHybridStructuralCompression
      - t.lowChordSteadySpeedStructuralCompression * 0.85
      - t.moderateChordSteadyStreamStructuralCompression
      - t.compactHandstreamStaminaStructuralCompression
      - t.compactTechnicalFlowStructuralCompression * 0.7
      - t.compactChordWallStructuralCompression
      - t.simpleDenseChordWallStructuralCompression
      - t.lowRateDenseChordWallCompression
      - t.simpleMidHighChordWallStructuralCompression
      - t.awkwardMidRateChordjackWallCompression
      - t.midHighChordSustainedTechStructuralCompression
      - t.shortDenseWallSrCompression
      - t.lowSrShortDenseWallCompression
      - t.mediumWallJackOverrateCompression
      - t.midHighChordGammaCompression
      - t.compactPureChordjackStaminaCompression
      - t.shortSimpleChordjackWallStructuralCompression
      - t.shortHighChordWallStructuralCompression
      - t.shortSpikeCompression
      - t.localizedJumptrillSpikeCompression) * lnNerf,
    stamina: (base
      + t.staminaBonus
      + t.highSpeedEndgameBonus * 0.65
      + t.marathonTechnicalEnduranceBonus * 0.9
      + t.lowEndLongMidChordStaminaFloorBonus
      - t.lowRateMidChordJackCompression
      - t.introMidChordJackCompression
      - t.midVarietyHighSpeedCompression
      - t.lowMidRateOverpromotionCompression
      - t.sparseLowSrTechVocabularyCompression * 0.7
      - t.moderateMidChordStaminaNerf
      - t.midChordRateCompressionNerf
      - t.highNoteMidRateHandstreamNerf
      - t.highEndMidChordStaminaNerf
      - t.longJumpstreamStaminaCompression
      - t.simpleLongJumpstreamPatternCompression
      - t.deltaHighMidChordTransitionNerf
      - t.farmJumptrillStaminaCompression
      - t.longSparseJackDropStaminaCompression
      - t.denseChordStaminaCompression
      - t.shortLnHybridStructuralCompression
      - t.lowChordSteadySpeedStructuralCompression * 0.9
      - t.moderateChordSteadyStreamStructuralCompression
      - t.compactHandstreamStaminaStructuralCompression
      - t.compactTechnicalFlowStructuralCompression * 0.6
      - t.compactChordWallStructuralCompression
      - t.simpleDenseChordWallStructuralCompression
      - t.lowRateDenseChordWallCompression
      - t.simpleMidHighChordWallStructuralCompression
      - t.awkwardMidRateChordjackWallCompression
      - t.midHighChordSustainedTechStructuralCompression
      - t.shortDenseWallSrCompression
      - t.lowSrShortDenseWallCompression
      - t.mediumWallJackOverrateCompression
      - t.midHighChordGammaCompression
      - t.compactPureChordjackStaminaCompression
      - t.shortSimpleChordjackWallStructuralCompression
      - t.shortHighChordWallStructuralCompression
      - t.shortSpikeCompression
      - t.localizedJumptrillSpikeCompression) * lnNerf,
    chordjack: (base
      + t.chordjackBonus
      + t.shortLnHybridRiceRequirementBonus * 0.75
      + t.lowRateChordjackWallFloorBonus
      + t.compactHighChordAlphaWallFloorBonus
      + t.compactHighChordGammaWallFloorBonus
      + t.compactHighChordGammaPlusWallBridgeBonus
      + t.compactHighChordDeltaWallBridgeBonus
      + t.sustainedHighChordWallBonus
      + t.extremeChordwallSpeedBonus * 0.6
      + t.marathonTechnicalEnduranceBonus * 0.75
      + t.slowRepetitiveJackstreamBonus * 0.55
      + t.ratedRepetitiveSpeedjackBonus * 0.55
      + t.midChordSpeedjackJackBonus
      + t.longGammaHighChordjackFloorBonus
      + t.heldLongGammaHighChordjackFloorBonus
      - t.lowRateMidChordJackCompression
      - t.introMidChordJackCompression
      - t.midVarietyHighSpeedCompression
      - t.lowMidRateOverpromotionCompression
      - t.sparseLowSrTechVocabularyCompression * 0.7
      - t.introHighChordFlowTechCompression * 0.75
      - t.farmJumptrillChordjackCompression
      - t.longSparseJackDropChordjackCompression
      - t.shortLnHybridStructuralCompression
      - t.lowChordSteadySpeedStructuralCompression * 0.8
      - t.moderateChordSteadyStreamStructuralCompression
      - t.compactHandstreamStaminaStructuralCompression
      - t.compactTechnicalFlowStructuralCompression * 0.75
      - t.compactChordWallStructuralCompression
      - t.simpleDenseChordWallStructuralCompression
      - t.lowRateDenseChordWallCompression
      - t.simpleMidHighChordWallStructuralCompression
      - t.awkwardMidRateChordjackWallCompression
      - t.midHighChordSustainedTechStructuralCompression
      - t.shortDenseWallSrCompression
      - t.lowSrShortDenseWallCompression
      - t.mediumWallJackOverrateCompression
      - t.longHighChordChordjackCompression
      - t.midHighChordGammaCompression
      - t.compactPureChordjackStaminaCompression
      - t.shortSimpleChordjackWallStructuralCompression
      - t.shortHighChordWallStructuralCompression
      - t.shortSpikeCompression
      - t.localizedJumptrillSpikeCompression) * lnNerf,
    tech: (base
      + t.techBonus
      + t.shortLnHybridRiceRequirementBonus
      + t.highSpeedEndgameBonus * 0.85
      + t.lowChordSpeedjackAnchorBonus * 0.6
      + t.variedLowChordSpeedjackBridgeBonus * 0.85
      + t.highRateTechnicalAnchorFloorBonus * 0.23
      + t.highAnchorTechDeltaBridgeBonus
      + t.compactGammaTechCalibrationBridgeBonus
      + t.lowEntropyTechDeltaBridgeBonus
      + t.marathonTechnicalEnduranceBonus * 0.8
      - t.shortLnHybridTechCompression
      - t.midChordTechOvercallCompression
      - t.lowRateMidChordJackCompression
      - t.introMidChordJackCompression
      - t.midVarietyHighSpeedCompression
      - t.lowMidRateOverpromotionCompression
      - t.lowMidSustainedPressureCompression
      - t.sparseLowSrTechVocabularyCompression * 0.7
      - t.lowRateTechnicalVocabularyCompression
      - t.baseRateTechCompression
      - t.ratePackTechStructuralCompression
      - t.highRatePackTechnicalAnchorCompression
      - t.repetitiveSpeedjackTechCompression
      - t.denseJackTechNerf
      - t.wallJackTechNerf
      - t.lowChordBurstTechNerf
      - t.variedLowChordSpeedCompression
      - t.farmJumptrillTechCompression
      - t.longSparseJackDropTechCompression
      - t.shortLnHybridStructuralCompression
      - t.lowChordSteadySpeedStructuralCompression * 0.85
      - t.moderateChordSteadyStreamStructuralCompression
      - t.compactHandstreamStaminaStructuralCompression
      - t.compactHandstreamStaminaTechCompression
      - t.compactTechnicalFlowStructuralCompression
      - t.compactChordWallStructuralCompression
      - t.simpleDenseChordWallStructuralCompression
      - t.lowRateDenseChordWallCompression
      - t.simpleMidHighChordWallStructuralCompression
      - t.awkwardMidRateChordjackWallCompression
      - t.midHighChordSustainedTechStructuralCompression
      - t.shortDenseWallSrCompression
      - t.lowSrShortDenseWallCompression
      - t.mediumWallJackOverrateCompression
      - t.midChordSpeedjackTechCompression
      - t.midHighChordGammaCompression
      - t.compactPureChordjackStaminaCompression
      - t.shortSimpleChordjackWallStructuralCompression
      - t.shortHighChordWallStructuralCompression
      - t.shortSpikeCompression
      - t.localizedJumptrillSpikeCompression * 1.45) * lnNerf,
    ln: 0,
    dan: 0,
  };
  // Jumpstream is a pattern subtype here; keep SR on the existing handstream scale.
  rawSkillScores.jumpstream = rawSkillScores.handstream;

  // Moderate practice walls can stack local jack/chordjack/tech pressure well
  // above their osu! SR without crossing into the next real dan band. The trim
  // is 1.5 SR at full gate, 1.7 for tech.
  const practice: PracticeInflation = {
    gates: {} as Record<PracticeFamily, number>,
    compressions: {} as Record<PracticeFamily, number>,
  };
  for (const family of PRACTICE_FAMILIES) {
    const gate = practicePatternInflationGate(rawSkillScores[family], metrics, starRating);
    practice.gates[family] = gate;
    practice.compressions[family] = gate * (family === "tech" ? 1.7 : 1.5);
  }
  const skillScores: Record<DanSkillFamily, number> = { ...rawSkillScores };
  for (const family of PRACTICE_FAMILIES) {
    skillScores[family] = rawSkillScores[family] - practice.compressions[family];
  }

  return {
    skillScores,
    debug: {
      densitySr,
      staminaSr,
      structuralSr,
      base,
      lnNerf,
      gates: scoringDebugGates(t, practice),
      terms: scoringDebugTerms(t, practice),
      contributions: scoringContributions(base, t),
    },
  };
}

// The main bonus of each family. Jumpstream and handstream are gated on chord
// ratio; chordjack and tech subtract the map-shape gates that mark a chart as
// steady speed, long endurance or long mid-chord stamina instead.
function familyBonuses(metrics: DanFeatureMetrics, t: ScoringTerms): FamilyBonuses {
  const jackBonus = Math.min(
    0.82,
    Math.max(0, (metrics.jackPressure - 92) / 240)
      + t.chordGate * 0.12
      + t.highChordJackBonus,
  );
  const streamBonus = Math.min(
    1.65,
    Math.max(0, metrics.streamPressure / 16)
      + Math.max(0, metrics.peakNps5s - 25) * 0.008
      + t.speedBonus
      + t.pureSpeedBonus
      + t.lowChordSustainedSpeedBonus
      + t.longLowChordSpeedBonus
      + t.lightChordGammaSpeedFloorBonus
      + t.lowSrSpeedUnderrateBonus
      + t.compactDeltaSpeedBridgeBonus
      + t.simpleHighDeltaSpeedBridgeBonus
      + t.sustainedLightJumpstreamBonus
      + t.baseRateSubGammaStreamBonus
      + t.compactModerateChordSpeedBonus
      + t.speedEnduranceBonus
      + t.longSteadyStreamBonus,
  );
  const staminaBonus = Math.min(
    1.45,
    Math.max(0, metrics.sustainedNps10s - 23) * 0.018
      + Math.min(0.16, metrics.noteCount / 16000)
      + t.speedBonus * 0.8
      + t.staminaEnduranceBonus
      + t.longSteadyStreamBonus * 0.45
      + t.fastLongMidChordStaminaGate * 0.02
      - t.longMidChordSrNerf * 0.6
      + Math.max(0, t.longMidChordStaminaMapGate - t.jackyLongMidChordStaminaGate) * 0.28,
  );
  const jumpstreamBonus = Math.max(0, t.jumpstreamChordGate * Math.min(
    1.45,
    Math.max(0, metrics.jumpstreamPressure - 12) * 0.045
      + Math.max(0, metrics.sustainedNps10s - 18) * 0.038
      + Math.max(0, metrics.peakNps5s - 21) * 0.024
      + Math.min(0.2, metrics.noteCount / 18000)
      + Math.max(0, 155 - metrics.jackPressure) * 0.001,
  ) - t.highChordGate * 0.18 - t.denseChordWallGate * 0.42);
  const handstreamBonus = t.handstreamChordGate * Math.min(
    1.35,
    Math.max(0, metrics.sustainedNps10s - 20) * 0.055
      + Math.max(0, metrics.peakNps5s - 23) * 0.022
      + Math.min(0.24, metrics.noteCount / 22000)
      + Math.max(0, 160 - metrics.jackPressure) * 0.0012,
  );
  const chordjackBonus = Math.max(
    0,
    Math.min(1, t.chordGate * 0.35 + Math.max(0, (metrics.chordjackPressure - 70) / 260) + t.denseChordedSpeedBonus * 0.55) * t.chordjackEnduranceMultiplier
      - t.highChordGate * t.strongJackGate * 0.45
      - t.longEnduranceMapGate * 0.32
      - t.longMidChordStaminaMapGate * 0.55
      - t.shortDenseChordWallPenalty * 1.2
      - t.highRateShortDenseChordWallPenalty * 1.18,
  );
  const techBonus = Math.max(
    0,
    Math.min(
      1.95,
      metrics.techPressure * 0.065
        + t.chordGate * 0.14
        + t.denseChordedSpeedBonus
        + t.burstTechBonus
        + t.lowSrTechnicalRhythmBonus
        + t.lowerRateTechBridgeBonus
        + t.syncopatedChordTechBonus
        + t.compactChordSwitchTechBonus
        + t.technicalAnchorBonus
        + t.compactTechnicalMarathonBonus
        + t.earlyVariedPatternTechBonus
        + t.compactChordFlowTechBonus
        + t.fastTechnicalSpeedFloorBonus
        + t.highRateTechnicalAnchorFloorBonus
        + t.variedTechnicalAnchorBridgeBonus
        + t.lowChordTechnicalSpeedBridgeBonus,
    )
      - t.highChordGate * 0.7
      - t.denseChordWallGate * 0.55
      - t.shortDenseChordWallPenalty * 1.55
      - t.highRateShortDenseChordWallPenalty * 1.65
      - t.steadySpeedMapGate * 0.58
      - t.longEnduranceMapGate * 0.75
      - t.longMidChordStaminaMapGate * 0.8
      - t.moderateBurstTechCompression
      - t.lowDensityChordFlowTechCompression
      - t.introHighChordFlowTechCompression
      - t.earlyLowEntropyTechCompression
      - t.sparseLowSrTechVocabularyCompression
      - t.compactHighChordTechCompression,
  );
  return {
    jackBonus,
    streamBonus,
    jumpstreamBonus,
    staminaBonus,
    handstreamBonus,
    chordjackBonus,
    techBonus,
  };
}

// 0-1 gate for a family score that sits more than 0.8 SR above the chart's
// star rating on a moderate (24-31 peak, 24-30 sustained NPS), chord-heavy
// (60%+ chord rows), rice (<12% holds) chart without heavy jack pressure.
function practicePatternInflationGate(score: number, metrics: DanFeatureMetrics, starRating: number): number {
  return metrics.holdRatio < 0.12
    && starRating >= 4.5
    && starRating <= 7
    && metrics.peakNps5s >= 24
    && metrics.peakNps5s <= 31
    && metrics.sustainedNps10s >= 24
    && metrics.sustainedNps10s <= 30
    && metrics.chordRatio >= 0.6
    && metrics.jackPressure <= 170
    ? minGate(
      (score - starRating - 0.8) / 0.8,
      (starRating - 4.5) / 0.5,
      (7 - starRating) / 0.7,
      (metrics.peakNps5s - 24) / 1.5,
      (metrics.sustainedNps10s - 24) / 1.5,
      (31 - metrics.peakNps5s) / 3,
      (30 - metrics.sustainedNps10s) / 3,
      (metrics.chordRatio - 0.6) / 0.15,
      (170 - metrics.jackPressure) / 50,
    )
    : 0;
}
