import type { DanFamilyChoiceDebug, DanFeatureMetrics, DanPrimaryFamily, DanSkillFamily } from "./types";

const PRIMARY_FAMILIES: DanPrimaryFamily[] = ["jack", "stream", "handstream", "stamina", "chordjack", "tech"];

export interface DanFamilyChoiceResult {
  family: DanPrimaryFamily;
  debug: DanFamilyChoiceDebug;
}

interface DanFamilyChoiceRule {
  id: string;
  family: DanPrimaryFamily;
  applies: (context: {
    metrics: DanFeatureMetrics;
    skillScores: Record<DanSkillFamily, number>;
    topScore: number;
  }) => boolean;
}

const FAMILY_CHOICE_RULES: DanFamilyChoiceRule[] = [
  {
    id: "localized-high-density-jack-spike",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4000
      && metrics.chordRatio >= 0.48
      && metrics.chordRatio <= 0.64
      && metrics.holdRatio < 0.1
      && metrics.peakNps5s >= 35
      && metrics.sustainedNps10s >= 34
      && metrics.jackPressure >= 190
      && metrics.strainSpikiness >= 1.6
      && metrics.nps5sP90 <= metrics.peakNps5s - 4
      && metrics.nps5sP50 <= metrics.peakNps5s - 10
      && skillScores.jack >= topScore - 0.45,
  },
  {
    id: "long-jumpstream-stamina",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 7600
      && metrics.chordRatio >= 0.45
      && metrics.chordRatio <= 0.56
      && metrics.holdRatio < 0.03
      && metrics.jackPressure < 135
      && metrics.sustainedNps10s >= 29
      && metrics.sustainedNps10s <= 32
      && metrics.fastRowRatio >= 0.8
      && metrics.sustainedPressureRatio >= 0.9
      && metrics.patternVariety <= 2.2
      && skillScores.stamina >= topScore - 1.35,
  },
  {
    id: "steady-low-rate-jumpstream",
    family: "stream",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 3600
      && metrics.noteCount <= 5000
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.52
      && metrics.holdRatio < 0.03
      && metrics.jackPressure < 130
      && metrics.peakNps5s <= 21
      && metrics.sustainedNps10s <= 20
      && metrics.activeNps <= 16.5
      && metrics.rowBurstPressure <= 14
      && metrics.rhythmMotifRepeatRatio >= 0.55
      && skillScores.stream >= topScore - 0.5,
  },
  {
    id: "mid-chord-speedjack",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 2200
      && metrics.noteCount <= 2800
      && metrics.chordRatio >= 0.45
      && metrics.chordRatio <= 0.56
      && metrics.holdRatio < 0.06
      && metrics.jackPressure >= 175
      && metrics.chordjackPressure >= 175
      && metrics.sustainedNps10s >= 25
      && metrics.sustainedNps10s <= 28
      && metrics.fastRowRatio >= 0.2
      && metrics.fastRowRatio <= 0.42
      && skillScores.jack >= topScore - 0.45,
  },
  {
    id: "dense-mid-chord-chordjack",
    family: "chordjack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 2600
      && metrics.noteCount <= 3600
      && metrics.chordRatio >= 0.62
      && metrics.chordRatio <= 0.72
      && metrics.holdRatio < 0.08
      && metrics.sustainedNps10s >= 28
      && metrics.jackPressure >= 125
      && metrics.jackPressure <= 190
      && metrics.chordjackPressure >= 170
      && !(metrics.chordRatio < 0.64
        && metrics.noteCount >= 2800
        && metrics.sustainedNps10s <= 30.5
        && skillScores.jack >= skillScores.chordjack - 0.25)
      && skillScores.chordjack >= skillScores.jack - 0.25
      && skillScores.chordjack >= topScore - 0.7,
  },
  {
    id: "short-dense-jack-file",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1800
      && metrics.noteCount <= 3200
      && metrics.chordRatio >= 0.54
      && metrics.chordRatio <= 0.72
      && metrics.holdRatio < 0.06
      && metrics.jackPressure >= 130
      && skillScores.jack >= topScore - 0.25,
  },
  {
    id: "slow-repetitive-jackstream",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1800
      && metrics.noteCount <= 3200
      && metrics.chordRatio >= 0.45
      && metrics.chordRatio <= 0.6
      && metrics.holdRatio < 0.06
      && metrics.jackPressure >= 115
      && metrics.chordjackPressure >= 105
      && metrics.sustainedNps10s >= 16
      && metrics.sustainedNps10s <= 22
      && metrics.fastRowRatio < 0.08
      && metrics.rowIntervalEntropy < 1.6
      && metrics.sustainedPressureRatio >= 0.65
      && skillScores.jack >= topScore - 0.5,
  },
  {
    id: "rated-repetitive-speedjack",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1800
      && metrics.noteCount <= 3200
      && metrics.chordRatio >= 0.45
      && metrics.chordRatio <= 0.6
      && metrics.holdRatio < 0.06
      && metrics.jackPressure >= 150
      && metrics.chordjackPressure >= 150
      && metrics.sustainedNps10s >= 22.5
      && metrics.sustainedNps10s <= 30
      && metrics.fastRowRatio < 0.1
      && metrics.rowIntervalEntropy < 1.7
      && metrics.sustainedPressureRatio >= 0.65
      && skillScores.jack >= topScore - 0.5,
  },
  {
    id: "compact-high-chord-wall-chordjack",
    family: "chordjack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1800
      && metrics.noteCount <= 2200
      && metrics.chordRatio >= 0.84
      && metrics.chordRatio <= 0.9
      && metrics.holdRatio < 0.06
      && metrics.peakNps5s >= 29
      && metrics.sustainedNps10s >= 28
      && skillScores.chordjack >= topScore - 0.95,
  },
  {
    id: "dense-wall-jack",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1800
      && metrics.chordRatio >= 0.74
      && metrics.holdRatio < 0.08
      && metrics.jackPressure >= 140
      && metrics.sustainedNps10s >= 23
      && skillScores.jack >= topScore - 0.45,
  },
  {
    id: "medium-wall-jack",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 3000
      && metrics.chordRatio >= 0.62
      && metrics.chordRatio <= 0.74
      && metrics.holdRatio < 0.08
      && metrics.jackPressure >= 145
      && metrics.sustainedNps10s >= 27
      && skillScores.jack >= topScore - 0.5,
  },
  {
    id: "long-sparse-jack-drop",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4800
      && metrics.noteCount <= 7200
      && metrics.chordRatio >= 0.48
      && metrics.chordRatio <= 0.66
      && metrics.holdRatio < 0.13
      && metrics.sustainedNps10s >= 18
      && metrics.sustainedNps10s <= 27.5
      && metrics.jackPressure >= 135
      && metrics.jackPressure <= 180
      && metrics.fastRowRatio <= 0.38
      && skillScores.jack >= topScore - 0.35,
  },
  {
    id: "compact-mid-chord-handstream",
    family: "handstream",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 2000
      && metrics.noteCount <= 3300
      && metrics.chordRatio >= 0.38
      && metrics.chordRatio <= 0.56
      && metrics.holdRatio < 0.08
      && metrics.jackPressure < 150
      && metrics.sustainedNps10s >= 21
      && metrics.sustainedNps10s < 34
      && metrics.peakNps5s >= 22
      && metrics.chordSizeChangeRate >= 0.45
      && metrics.directionChangeRate >= 0.55
      && skillScores.handstream >= topScore - 0.5,
  },
  {
    id: "sustained-mid-chord-handstream-speed",
    family: "handstream",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 3000
      && metrics.noteCount <= 4300
      && metrics.chordRatio >= 0.32
      && metrics.chordRatio <= 0.42
      && metrics.holdRatio < 0.08
      && metrics.jackPressure < 155
      && metrics.peakNps5s >= 30
      && metrics.sustainedNps10s >= 29
      && metrics.sustainedPressureRatio >= 0.75
      && metrics.rowIntervalEntropy < 2
      && skillScores.handstream >= topScore - 0.25,
  },
  {
    id: "low-sr-technical-rhythm",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 2200
      && metrics.noteCount <= 4200
      && metrics.chordRatio >= 0.16
      && metrics.chordRatio <= 0.38
      && metrics.holdRatio < 0.16
      && metrics.rowBurstPressure >= 20
      && metrics.fastRowRatio >= 0.5
      && metrics.chordSizeChangeRate >= 0.24
      && metrics.directionChangeRate >= 0.62
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "syncopated-chord-tech",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1600
      && metrics.noteCount <= 2600
      && metrics.chordRatio >= 0.28
      && metrics.chordRatio <= 0.38
      && metrics.holdRatio < 0.08
      && metrics.fastRowRatio >= 0.42
      && metrics.fastRowRatio <= 0.72
      && metrics.rowIntervalEntropy >= 2
      && metrics.chordSizeChangeRate >= 0.34
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "compact-chord-switch-tech",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1600
      && metrics.noteCount <= 2500
      && metrics.chordRatio >= 0.3
      && metrics.chordRatio <= 0.48
      && metrics.holdRatio >= 0.025
      && metrics.holdRatio <= 0.12
      && metrics.fastRowRatio >= 0.72
      && metrics.chordSizeChangeRate >= 0.48
      && metrics.jackPressure >= 165
      && metrics.techPressure >= 6.8
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "technical-anchor",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 1700
      && metrics.noteCount <= 3300
      && metrics.chordRatio >= 0.26
      && metrics.chordRatio <= 0.38
      && metrics.holdRatio < 0.08
      && metrics.jackPressure >= 185
      && metrics.peakNps1s >= 32
      && metrics.peakNps5s >= 27
      && skillScores.tech >= topScore - 0.55,
  },
  {
    id: "rated-vibro-jumptrill",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4000
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.58
      && metrics.holdRatio >= 0.1
      && metrics.holdRatio <= 0.24
      && metrics.jackPressure >= 165
      && metrics.peakNps1s >= 44
      && metrics.sustainedNps10s >= 30
      && skillScores.jack >= topScore - 0.4,
  },
  {
    id: "high-sustained-mid-chord-stamina",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.sustainedNps10s >= 34
      && metrics.chordRatio >= 0.32
      && metrics.chordRatio <= 0.7
      && metrics.jackPressure < 195
      && skillScores.stamina >= topScore - 0.95,
  },
  {
    id: "long-fast-mid-chord-stamina-transition",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 5000
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.58
      && metrics.holdRatio < 0.04
      && metrics.jackPressure < 145
      && metrics.sustainedNps10s >= 27
      && metrics.sustainedNps10s <= 33
      && metrics.fastRowRatio >= 0.8
      && metrics.sustainedPressureRatio >= 0.86
      && metrics.patternVariety <= 2.6
      && skillScores.stamina >= topScore - 1.35,
  },
  {
    id: "long-mid-chord-stamina",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.sustainedNps10s >= 28
      && metrics.chordRatio >= 0.38
      && metrics.chordRatio <= 0.75
      && metrics.jackPressure < 165
      && metrics.noteCount >= 4500
      && skillScores.stamina >= topScore - 1.05,
  },
  {
    id: "cyber-like-mid-chord-stamina",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4200
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.6
      && metrics.jackPressure < 150
      && metrics.holdRatio < 0.08
      && metrics.sustainedNps10s >= 23
      && skillScores.stamina >= topScore - 0.65,
  },
  {
    id: "long-mid-chord-stamina-family-bias",
    family: "stamina",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 4500
      && metrics.chordRatio >= 0.42
      && metrics.chordRatio <= 0.6
      && metrics.jackPressure < 150
      && metrics.holdRatio < 0.08
      && metrics.sustainedNps10s >= 20
      && skillScores.stamina >= topScore - 0.75,
  },
  {
    id: "simple-fast-high-chord-wall-jack",
    family: "jack",
    applies: ({ metrics, skillScores, topScore }) => metrics.noteCount >= 3000
      && metrics.chordRatio >= 0.78
      && metrics.holdRatio < 0.08
      && metrics.jackPressure >= 125
      && metrics.jackPressure < 145
      && metrics.peakNps5s >= 32
      && metrics.sustainedNps10s >= 31
      && metrics.rowIntervalEntropy <= 1.2
      && metrics.patternVariety <= 1.8
      && metrics.rowPatternChangeRate <= 0.5
      && skillScores.jack >= topScore - 0.5,
  },
  {
    id: "low-chord-sustained-speed",
    family: "stream",
    applies: ({ metrics, skillScores, topScore }) => metrics.chordRatio <= 0.28
      && metrics.sustainedNps10s >= 25
      && metrics.peakNps5s >= 26
      && metrics.jackPressure < 175
      && metrics.techPressure < 6.4
      && skillScores.stream >= topScore - 0.7,
  },
  {
    id: "burst-tech",
    family: "tech",
    applies: ({ metrics, skillScores, topScore }) => metrics.peakNps1s >= 34
      && metrics.chordRatio >= 0.18
      && metrics.chordRatio <= 0.36
      && metrics.techPressure >= 5.6
      && metrics.jackPressure >= 130
      && metrics.jackPressure <= 190
      && skillScores.tech >= topScore - 0.45,
  },
  {
    id: "steady-stream",
    family: "stream",
    applies: ({ metrics, skillScores, topScore }) => metrics.chordRatio <= 0.38
      && metrics.sustainedNps10s >= 25
      && metrics.peakNps5s >= 26
      && metrics.jackPressure < 155
      && skillScores.stream >= topScore - 0.35,
  },
  {
    id: "dense-chordjack",
    family: "chordjack",
    applies: ({ metrics, skillScores, topScore }) => metrics.chordRatio >= 0.72
      && metrics.holdRatio < 0.18
      && metrics.jackPressure < 150
      && skillScores.chordjack >= topScore - 0.35,
  },
];

export function chooseSkillFamily(skillScores: Record<DanSkillFamily, number>, metrics: DanFeatureMetrics): DanFamilyChoiceResult {
  const ranked = PRIMARY_FAMILIES
    .map((family) => [family, skillScores[family]] as [DanPrimaryFamily, number])
    .sort((a, b) => b[1] - a[1]);
  const [topFamily, topScore] = ranked[0];
  const choose = (selectedFamily: DanPrimaryFamily, reason: string): DanFamilyChoiceResult => ({
    family: selectedFamily,
    debug: {
      topFamily,
      topScore,
      selectedFamily,
      reason,
    },
  });

  for (const rule of FAMILY_CHOICE_RULES) {
    if (rule.applies({ metrics, skillScores, topScore })) {
      return choose(rule.family, rule.id);
    }
  }

  return choose(topFamily, "top-score");
}
