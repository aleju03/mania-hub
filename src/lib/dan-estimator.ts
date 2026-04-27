import type { ManiaBeatmap, ManiaNote } from "./beatmap-parser";

export type DanSkillFamily = "jack" | "stream" | "stamina" | "chordjack" | "tech" | "dan";

export interface DanEstimateInput {
  starRating?: number;
  totalLength?: number;
  title?: string;
  version?: string;
  rate?: number;
}

export interface DanEstimate {
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  estimatedSr: number;
  family: DanSkillFamily;
  confidence: number;
  metrics: {
    keyCount: number;
    noteCount: number;
    holdRatio: number;
    chordRatio: number;
    peakNps1s: number;
    peakNps5s: number;
    sustainedNps10s: number;
    jackPressure: number;
    streamPressure: number;
    chordjackPressure: number;
    techPressure: number;
    staminaPressure: number;
  };
  skillScores: Record<DanSkillFamily, number>;
  warnings: string[];
}

const DAN_LABELS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
];

const MAX_SUPPORTED_DAN_INDEX = DAN_LABELS.indexOf("eta");

const DAN_MEANS: Record<Exclude<DanSkillFamily, "dan">, number[]> = {
  jack: [3.15, 3.55, 3.95, 4.35, 4.75, 5.15, 5.45, 5.7, 5.92, 6.1, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
  stream: [3.1, 3.5, 3.9, 4.3, 4.7, 5.05, 5.35, 5.6, 5.78, 5.92, 6.12, 6.5, 6.92, 7.42, 8.08, 8.8, 9.65, 10.42, 11.2, 12.0],
  stamina: [3.2, 3.6, 4.0, 4.4, 4.8, 5.15, 5.45, 5.72, 5.92, 6.08, 6.3, 6.7, 7.12, 7.62, 8.28, 8.98, 9.78, 10.52, 11.26, 12.0],
  chordjack: [3.2, 3.6, 4.0, 4.42, 4.82, 5.18, 5.48, 5.75, 5.95, 6.12, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
  tech: [3.25, 3.65, 4.05, 4.48, 4.88, 5.25, 5.55, 5.82, 6.02, 6.18, 6.42, 6.82, 7.22, 7.72, 8.35, 9.02, 9.8, 10.52, 11.26, 12.0],
};

function getInputRate(input: DanEstimateInput): number {
  const rate = Number(input.rate);
  return Number.isFinite(rate) && rate > 0.4 && rate < 2.5 ? rate : 1;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function countInWindow(times: number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function srToRawDan(sr: number, family: Exclude<DanSkillFamily, "dan">): number {
  const means = DAN_MEANS[family];
  const maxIndex = MAX_SUPPORTED_DAN_INDEX >= 0 ? MAX_SUPPORTED_DAN_INDEX : DAN_LABELS.length - 1;
  const cappedMeans = means.slice(0, maxIndex + 1);
  const boundaries = cappedMeans.map((mean, index) => {
    const lower = index === 0 ? mean - (cappedMeans[index + 1] - mean) / 2 : (cappedMeans[index - 1] + mean) / 2;
    const upper = index === cappedMeans.length - 1 ? mean + (mean - cappedMeans[index - 1]) / 2 : (mean + cappedMeans[index + 1]) / 2;
    return { lower, upper, level: index + 1 };
  });

  if (sr < boundaries[0].lower) return 1;
  const last = boundaries[boundaries.length - 1];
  if (sr >= last.upper) return maxIndex + 1;

  for (const boundary of boundaries) {
    if (sr >= boundary.lower && sr < boundary.upper) {
      const t = (sr - boundary.lower) / Math.max(0.001, boundary.upper - boundary.lower);
      return boundary.level + t - 0.5;
    }
  }

  return 1;
}

function parseDan(rawDan: number) {
  const maxLevel = (MAX_SUPPORTED_DAN_INDEX >= 0 ? MAX_SUPPORTED_DAN_INDEX : DAN_LABELS.length - 1) + 1;
  const level = Math.min(maxLevel, Math.max(1, Math.round(rawDan)));
  const offset = rawDan - level;
  const variant = offset <= -0.3 ? "--" : offset <= -0.1 ? "-" : offset < 0.1 ? null : offset < 0.3 ? "+" : "++";
  const label = DAN_LABELS[level - 1];
  return {
    label,
    variant,
    displayName: `${label}${variant ?? ""}`,
  };
}

function estimateFamilyScores(metrics: DanEstimate["metrics"], starRating: number, durationMs: number): Record<DanSkillFamily, number> {
  const densitySr = 2.45 + metrics.peakNps5s * 0.095 + metrics.peakNps1s * 0.018;
  const staminaSr = 2.65 + metrics.sustainedNps10s * 0.16;
  const structuralSr = Math.max(densitySr, staminaSr);
  const base = starRating > 0
    ? starRating * 0.82 + structuralSr * 0.18
    : structuralSr;
  const lnNerf = metrics.holdRatio > 0.45 ? 0.72 : metrics.holdRatio > 0.34 ? 0.76 : metrics.holdRatio > 0.28 ? 0.84 : 1;
  const chordGate = Math.max(0, Math.min(1, (metrics.chordRatio - 0.18) / 0.34));
  const chordedSpeedGate = Math.max(0, Math.min(1, (metrics.chordRatio - 0.12) / 0.22));
  const denseChordedSpeedGate = Math.max(0, Math.min(1, (metrics.chordRatio - 0.32) / 0.28));
  const highChordGate = Math.max(0, Math.min(1, (metrics.chordRatio - 0.5) / 0.2));
  const denseChordWallGate = Math.max(0, Math.min(1, (metrics.chordRatio - 0.78) / 0.08));
  const pureSpeedGate = Math.max(0, Math.min(1, (0.28 - metrics.chordRatio) / 0.2));
  const speedGate = 1 - Math.max(0, Math.min(1, (metrics.chordRatio - 0.08) / 0.22));
  const speedBonus = speedGate * Math.min(0.38, Math.max(0, metrics.sustainedNps10s - 22) * 0.045);
  const pureSpeedBonus = pureSpeedGate * Math.min(
    1.05,
    Math.max(0, metrics.sustainedNps10s - 31) * 0.16
      + Math.max(0, metrics.peakNps5s - 34) * 0.06
      + Math.max(0, metrics.noteCount - 3400) * 0.001,
  );
  const lowSrSpeedUnderrateBonus = metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.3
    && metrics.sustainedNps10s >= 25
    && metrics.peakNps5s >= 26
    && metrics.jackPressure < 165
    && starRating > 0
    && starRating < 6.5
    ? Math.min(
      0.54,
      Math.max(0, 6.6 - starRating) * 0.54
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.045
        + Math.max(0, metrics.peakNps5s - 26) * 0.035,
    )
    : 0;
  const speedEnduranceBonus = metrics.chordRatio <= 0.32
    && metrics.sustainedNps10s >= 29
    && metrics.peakNps5s >= 30
    && metrics.jackPressure < 165
    && metrics.noteCount >= 3000
    && starRating > 0
    && starRating < 7
    ? Math.min(
      0.45,
      Math.max(0, metrics.noteCount - 2800) * 0.00035
        + Math.max(0, metrics.sustainedNps10s - 29) * 0.09
        + Math.max(0, metrics.peakNps5s - 30) * 0.04,
    )
    : 0;
  const staminaEnduranceBonus = metrics.sustainedNps10s >= 28
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.75
    && metrics.jackPressure < 165
    && metrics.noteCount >= 4500
    ? Math.min(
      0.45,
      Math.max(0, metrics.noteCount - 4200) * 0.00012
        + Math.max(0, metrics.sustainedNps10s - 27) * 0.055
        + Math.max(0, metrics.chordRatio - 0.38) * 0.35,
    )
    : 0;
  const longSteadyStreamBonus = metrics.sustainedNps10s >= 25
    && metrics.chordRatio >= 0.26
    && metrics.chordRatio <= 0.42
    && metrics.jackPressure < 155
    && metrics.noteCount >= 4200
    ? Math.min(
      0.28,
      Math.max(0, metrics.noteCount - 4000) * 0.00011
        + Math.max(0, metrics.sustainedNps10s - 25) * 0.055,
    )
    : 0;
  const burstTechBonus = metrics.peakNps1s >= 34
    && metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.36
    && metrics.techPressure >= 5.6
    && metrics.jackPressure >= 130
    && metrics.jackPressure <= 190
    && metrics.sustainedNps10s >= 23
    && metrics.noteCount >= 3000
    ? Math.min(
      1.08,
      Math.max(0, metrics.peakNps1s - 32) * 0.2
        + Math.max(0, metrics.techPressure - 5.5) * 0.3
        + Math.max(0, metrics.jackPressure - 130) * 0.006,
    )
    : 0;
  const chordedSpeedBonus = chordedSpeedGate * Math.min(
    0.95,
    Math.max(0, metrics.sustainedNps10s - 23) * 0.24 + Math.max(0, metrics.peakNps5s - 25) * 0.05,
  );
  const denseChordedSpeedBonus = denseChordedSpeedGate * Math.min(
    0.95,
    Math.max(0, metrics.sustainedNps10s - 23) * 0.2 + Math.max(0, metrics.peakNps5s - 25) * 0.04,
  );
  const chordjackEnduranceGate = Math.max(
    0,
    Math.min(
      1,
      Math.min(
        (durationMs - 90000) / 90000,
        (metrics.noteCount - 1600) / 2600,
      ),
    ),
  );
  const chordjackEnduranceMultiplier = 0.55 + chordjackEnduranceGate * 0.45;
  const strongJackGate = Math.max(0, Math.min(1, (metrics.jackPressure - 110) / 40));
  const etaJackPressureGate = Math.max(0, Math.min(1, (metrics.jackPressure - 185) / 30));
  const highChordJackBonus = highChordGate * Math.min(0.42, Math.max(0, metrics.jackPressure - 100) / 120);
  const highChordSoftJackPenalty = denseChordWallGate * (1 - etaJackPressureGate) * 0.35;
  const shortDenseChordWallPenalty = denseChordWallGate
    * Math.max(0, Math.min(1, (155 - metrics.jackPressure) / 35))
    * Math.max(0, Math.min(1, (2400 - metrics.noteCount) / 900))
    * Math.max(0, Math.min(1, (115000 - durationMs) / 45000));
  const highRateShortDenseChordWallPenalty = shortDenseChordWallPenalty
    * Math.max(0, Math.min(1, (starRating - 5.75) / 0.45));
  const steadySpeedMapGate = Math.max(
    0,
    Math.min(
      1,
      Math.min(
        (0.42 - metrics.chordRatio) / 0.18,
        (155 - metrics.jackPressure) / 45,
        (metrics.sustainedNps10s - 24) / 6,
      ),
    ),
  );
  const longEnduranceMapGate = Math.max(
    0,
    Math.min(
      1,
      Math.min(
        (metrics.noteCount - 4200) / 1800,
        (metrics.sustainedNps10s - 26) / 4,
        (165 - metrics.jackPressure) / 45,
      ),
    ),
  );
  const longMidChordStaminaMapGate = metrics.noteCount >= 4200
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.6
    && metrics.jackPressure < 150
    && metrics.holdRatio < 0.08
    ? Math.max(
      0,
      Math.min(
        1,
        Math.min(
          (metrics.noteCount - 4000) / 1600,
        (metrics.sustainedNps10s - 21) / 10,
          (150 - metrics.jackPressure) / 55,
        ),
      ),
    )
    : 0;
  const fastLongMidChordStaminaGate = longMidChordStaminaMapGate
    * Math.max(0, Math.min(1, (metrics.sustainedNps10s - 27.5) / 2));
  const cyberLikeStaminaGate = longMidChordStaminaMapGate
    * Math.max(0, Math.min(1, (metrics.jackPressure - 110) / 30));
  const longMidChordSrNerf = cyberLikeStaminaGate
    * Math.max(0, Math.min(1, (starRating - 6) / 0.9))
    * Math.max(0, Math.min(1, (metrics.chordRatio - 0.44) / 0.04));
  const jackBonus = Math.min(0.82, Math.max(0, (metrics.jackPressure - 92) / 240) + chordGate * 0.12 + highChordJackBonus);
  const streamBonus = Math.min(1.65, Math.max(0, metrics.streamPressure / 16) + Math.max(0, metrics.peakNps5s - 25) * 0.008 + speedBonus + pureSpeedBonus + lowSrSpeedUnderrateBonus + speedEnduranceBonus + longSteadyStreamBonus);
  const staminaBonus = Math.min(1.45, Math.max(0, metrics.sustainedNps10s - 23) * 0.018 + Math.min(0.16, metrics.noteCount / 16000) + speedBonus * 0.8 + staminaEnduranceBonus + longSteadyStreamBonus * 0.45 + fastLongMidChordStaminaGate * 0.02 - longMidChordSrNerf * 0.6 + Math.max(0, longMidChordStaminaMapGate - cyberLikeStaminaGate) * 0.28);
  const chordjackBonus = Math.max(
    0,
    Math.min(1, chordGate * 0.35 + Math.max(0, (metrics.chordjackPressure - 70) / 260) + denseChordedSpeedBonus * 0.55) * chordjackEnduranceMultiplier
      - highChordGate * strongJackGate * 0.45
      - longEnduranceMapGate * 0.32
      - longMidChordStaminaMapGate * 0.55
      - shortDenseChordWallPenalty * 1.2
      - highRateShortDenseChordWallPenalty * 1.18,
  );
  const techBonus = Math.max(
    0,
    Math.min(1.55, metrics.techPressure * 0.065 + chordGate * 0.14 + denseChordedSpeedBonus + burstTechBonus)
      - highChordGate * 0.7
      - denseChordWallGate * 0.55
      - shortDenseChordWallPenalty * 1.55
      - highRateShortDenseChordWallPenalty * 1.65
      - steadySpeedMapGate * 0.58
      - longEnduranceMapGate * 0.75
      - longMidChordStaminaMapGate * 0.8,
  );

  return {
    jack: (base + jackBonus - highChordSoftJackPenalty) * lnNerf,
    stream: (base + streamBonus) * lnNerf,
    stamina: (base + staminaBonus) * lnNerf,
    chordjack: (base + chordjackBonus) * lnNerf,
    tech: (base + techBonus) * lnNerf,
    dan: 0,
  };
}

function chooseSkillFamily(skillScores: Record<DanSkillFamily, number>, metrics: DanEstimate["metrics"]): Exclude<DanSkillFamily, "dan"> {
  const ranked = (Object.entries(skillScores) as Array<[DanSkillFamily, number]>)
    .filter((entry): entry is [Exclude<DanSkillFamily, "dan">, number] => entry[0] !== "dan")
    .sort((a, b) => b[1] - a[1]);
  const [topFamily, topScore] = ranked[0];

  if (
    metrics.sustainedNps10s >= 34
    && metrics.chordRatio >= 0.32
    && metrics.chordRatio <= 0.7
    && metrics.jackPressure < 195
    && skillScores.stamina >= topScore - 0.85
  ) {
    return "stamina";
  }

  if (
    metrics.sustainedNps10s >= 28
    && metrics.chordRatio >= 0.38
    && metrics.chordRatio <= 0.75
    && metrics.jackPressure < 165
    && metrics.noteCount >= 4500
    && skillScores.stamina >= topScore - 1.05
  ) {
    return "stamina";
  }

  if (
    metrics.noteCount >= 4200
    && metrics.chordRatio >= 0.42
    && metrics.chordRatio <= 0.6
    && metrics.jackPressure < 150
    && metrics.holdRatio < 0.08
    && metrics.sustainedNps10s >= 23
    && skillScores.stamina >= topScore - 0.65
  ) {
    return "stamina";
  }

  if (
    metrics.chordRatio <= 0.28
    && metrics.sustainedNps10s >= 25
    && metrics.peakNps5s >= 26
    && metrics.jackPressure < 165
    && metrics.techPressure < 6.4
    && skillScores.stream >= topScore - 0.7
  ) {
    return "stream";
  }

  if (
    metrics.peakNps1s >= 34
    && metrics.chordRatio >= 0.18
    && metrics.chordRatio <= 0.36
    && metrics.techPressure >= 5.6
    && metrics.jackPressure >= 130
    && metrics.jackPressure <= 190
    && skillScores.tech >= topScore - 0.45
  ) {
    return "tech";
  }

  if (
    metrics.chordRatio <= 0.38
    && metrics.sustainedNps10s >= 25
    && metrics.peakNps5s >= 26
    && metrics.jackPressure < 155
    && skillScores.stream >= topScore - 0.35
  ) {
    return "stream";
  }

  if (
    metrics.chordRatio >= 0.72
    && metrics.holdRatio < 0.18
    && metrics.jackPressure < 150
    && skillScores.chordjack >= topScore - 0.35
  ) {
    return "chordjack";
  }

  return topFamily;
}

function countDanSegments(orderedRows: Array<[number, ManiaNote[]]>): number {
  if (orderedRows.length === 0) return 0;

  let segments = 0;
  let segmentStart = orderedRows[0][0];
  let segmentNotes = 0;

  for (let index = 0; index < orderedRows.length; index++) {
    const [time, rowNotes] = orderedRows[index];
    segmentNotes += rowNotes.length;
    const next = orderedRows[index + 1];
    if (!next || next[0] - time > 2500) {
      if (time - segmentStart >= 30000 && segmentNotes >= 400) segments++;
      if (next) {
        segmentStart = next[0];
        segmentNotes = 0;
      }
    }
  }

  return segments;
}

function isDanCourse(input: DanEstimateInput, orderedRows: Array<[number, ManiaNote[]]>, durationMs: number, noteCount: number): boolean {
  const title = input.title?.toLowerCase() ?? "";
  const version = input.version?.toLowerCase() ?? "";
  const combined = `${title} ${version}`;
  if (!/\bdan\b/.test(combined)) return false;

  const segmentCount = countDanSegments(orderedRows);
  return (durationMs >= 180000 && segmentCount >= 3)
    || (durationMs >= 240000 && noteCount >= 6000 && segmentCount >= 3);
}

function estimateDanCourseSr(metrics: DanEstimate["metrics"], starRating: number, fallbackSr: number): number {
  if (starRating <= 0) return Math.max(1, fallbackSr - 0.8);

  const densityPressure = Math.max(0, metrics.sustainedNps10s - 24) * 0.035
    + Math.max(0, metrics.peakNps5s - 28) * 0.025;
  const endurancePressure = Math.min(0.12, metrics.noteCount / 100000);
  return starRating + Math.min(0.55, densityPressure + endurancePressure);
}

export function estimateDan(map: ManiaBeatmap, input: DanEstimateInput = {}): DanEstimate {
  if (map.keyCount !== 4) {
    throw new Error("Dan estimates are currently only supported for 4K beatmaps.");
  }

  const rate = getInputRate(input);
  const notes = map.notes
    .filter((note) => note.column >= 0 && note.column < map.keyCount)
    .map((note) => rate === 1 ? note : {
      ...note,
      time: note.time / rate,
      endTime: note.endTime / rate,
    });
  const warnings: string[] = [];
  const noteTimes = notes.map((note) => note.time).sort((a, b) => a - b);
  const durationMs = Math.max(input.totalLength ? (input.totalLength * 1000) / rate : 0, map.totalLength / rate, noteTimes.at(-1) ?? 0);

  if (notes.length < 50 || durationMs <= 0) {
    warnings.push("This map has very little note data, so the estimate is low confidence.");
  }

  const rows = new Map<number, ManiaNote[]>();
  for (const note of notes) {
    const row = rows.get(note.time);
    if (row) row.push(note);
    else rows.set(note.time, [note]);
  }
  const orderedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  const chordRows = orderedRows.filter(([, rowNotes]) => rowNotes.length >= 2).length;
  const holdRatio = notes.length ? notes.filter((note) => note.isHold).length / notes.length : 0;
  const chordRatio = orderedRows.length ? chordRows / orderedRows.length : 0;

  const lastByColumn = Array.from({ length: Math.max(1, map.keyCount) }, () => -Infinity);
  const jackValues: number[] = [];
  const streamValues: number[] = [];
  const rowDensities: number[] = [];
  let directionChanges = 0;
  let previousColumn: number | null = null;
  let previousDirection = 0;
  let previousChordSize = 0;
  let chordSizeChanges = 0;
  let previousRowTime: number | null = null;

  for (const [time, rowNotes] of orderedRows) {
    const columns = rowNotes.map((note) => note.column).sort((a, b) => a - b);
    if (previousChordSize && previousChordSize !== columns.length) chordSizeChanges++;
    if (previousRowTime != null) {
      const rowDelta = time - previousRowTime;
      if (rowDelta > 0 && rowDelta < 1200) {
        rowDensities.push((columns.length * 1000) / rowDelta);
      }
    }
    previousChordSize = columns.length;
    previousRowTime = time;

    for (const column of columns) {
      const sameDelta = time - lastByColumn[column];
      if (sameDelta > 0 && sameDelta < 1000) {
        jackValues.push(Math.min(230, 15000 / sameDelta));
      }

      for (const neighbor of [column - 1, column + 1]) {
        if (neighbor < 0 || neighbor >= map.keyCount) continue;
        const delta = time - lastByColumn[neighbor];
        if (delta > 0 && delta < 260) {
          streamValues.push((260 - delta) / 35);
        }
      }

      if (previousColumn != null) {
        const direction = Math.sign(column - previousColumn);
        if (direction && previousDirection && direction !== previousDirection) directionChanges++;
        if (direction) previousDirection = direction;
      }
      previousColumn = column;
      lastByColumn[column] = time;
    }
  }

  const peakNps1s = countInWindow(noteTimes, 1000);
  const peakNps5s = countInWindow(noteTimes, 5000) / 5;
  const sustainedNps10s = countInWindow(noteTimes, 10000) / 10;
  const jackPressure = quantile(jackValues, 0.92);
  const streamPressure = quantile(streamValues, 0.9);
  const burstDensity = quantile(rowDensities, 0.9);
  const chordjackPressure = jackPressure * (0.28 + chordRatio * 1.35) + burstDensity * chordRatio * 0.6;
  const techPressure = orderedRows.length
    ? (directionChanges / orderedRows.length) * 4.4 + (chordSizeChanges / orderedRows.length) * 3.5 + chordRatio * 1.6 + average(rowDensities) * 0.018
    : 0;

  const metrics: DanEstimate["metrics"] = {
    keyCount: map.keyCount,
    noteCount: notes.length,
    holdRatio,
    chordRatio,
    peakNps1s,
    peakNps5s,
    sustainedNps10s,
    jackPressure,
    streamPressure,
    chordjackPressure,
    techPressure,
    staminaPressure: sustainedNps10s,
  };

  const baseStarRating = Number.isFinite(input.starRating) ? Math.max(0, input.starRating ?? 0) : 0;
  const starRating = baseStarRating > 0 ? baseStarRating * Math.pow(rate, 0.7) : 0;
  const skillScores = estimateFamilyScores(metrics, starRating, durationMs);
  const skillFamily = chooseSkillFamily(skillScores, metrics);
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
        - (holdRatio > 0.45 ? 0.18 : 0),
    ),
  );

  if (holdRatio > 0.28) {
    warnings.push("This looks LN-heavy; LN dan handling is intentionally conservative for now.");
  }

  return {
    ...parsed,
    rawDan,
    estimatedSr,
    family,
    confidence,
    metrics,
    skillScores,
    warnings,
  };
}
