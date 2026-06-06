import type { DanEstimateInput, DanPrimaryFamily } from "./types";

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

const DAN_MEANS: Record<DanPrimaryFamily, number[]> = {
  jack: [3.15, 3.55, 3.95, 4.35, 4.75, 5.15, 5.45, 5.7, 5.92, 6.1, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
  stream: [3.1, 3.5, 3.9, 4.3, 4.7, 5.05, 5.35, 5.6, 5.78, 5.92, 6.12, 6.5, 6.92, 7.42, 8.08, 8.8, 9.65, 10.42, 11.2, 12.0],
  jumpstream: [3.15, 3.55, 3.95, 4.35, 4.75, 5.1, 5.4, 5.66, 5.86, 6.02, 6.35, 6.72, 7.08, 7.55, 8.15, 8.85, 9.65, 10.38, 11.14, 11.95],
  handstream: [3.2, 3.6, 4.0, 4.4, 4.8, 5.15, 5.45, 5.72, 5.92, 6.08, 6.6, 6.9, 6.96, 7.72, 8.48, 9.18, 9.98, 10.72, 11.46, 12.2],
  stamina: [3.2, 3.6, 4.0, 4.4, 4.8, 5.15, 5.45, 5.72, 5.92, 6.08, 6.3, 6.7, 7.12, 7.62, 8.28, 8.98, 9.78, 10.52, 11.26, 12.0],
  chordjack: [3.2, 3.6, 4.0, 4.42, 4.82, 5.18, 5.48, 5.75, 5.95, 6.12, 6.35, 6.75, 7.15, 7.65, 8.25, 8.85, 9.55, 10.25, 11.0, 11.8],
  tech: [3.25, 3.65, 4.05, 4.48, 4.88, 5.25, 5.55, 5.82, 6.02, 6.18, 6.42, 6.82, 7.22, 7.72, 8.35, 9.02, 9.8, 10.52, 11.26, 12.0],
};

function rawDanFromMeans(value: number, means: number[]): number {
  const maxIndex = MAX_SUPPORTED_DAN_INDEX >= 0 ? MAX_SUPPORTED_DAN_INDEX : DAN_LABELS.length - 1;
  const cappedMeans = means.slice(0, maxIndex + 1);
  const boundaries = cappedMeans.map((mean, index) => {
    const lower = index === 0 ? mean - (cappedMeans[index + 1] - mean) / 2 : (cappedMeans[index - 1] + mean) / 2;
    const upper = index === cappedMeans.length - 1 ? mean + (mean - cappedMeans[index - 1]) / 2 : (mean + cappedMeans[index + 1]) / 2;
    return { lower, upper, level: index + 1 };
  });

  if (value < boundaries[0].lower) return 1;
  const last = boundaries[boundaries.length - 1];
  if (value >= last.upper) return maxIndex + 1;

  for (const boundary of boundaries) {
    if (value >= boundary.lower && value < boundary.upper) {
      const t = (value - boundary.lower) / Math.max(0.001, boundary.upper - boundary.lower);
      return boundary.level + t - 0.5;
    }
  }

  return 1;
}

const SR_CALIBRATION: Record<DanPrimaryFamily, { slope: number; offset: number; gateStart: number; gateWidth: number }> = {
  jack: { slope: 0.74, offset: 1.3, gateStart: 7.4, gateWidth: 0.3 },
  stream: { slope: 0.92, offset: -0.4, gateStart: 7, gateWidth: 0.9 },
  jumpstream: { slope: 1.02, offset: -0.45, gateStart: 7.25, gateWidth: 0.55 },
  handstream: { slope: 1.16, offset: -2, gateStart: 7.4, gateWidth: 0.2 },
  stamina: { slope: 1.12, offset: -1.5, gateStart: 7.3, gateWidth: 0.55 },
  chordjack: { slope: 1, offset: 0, gateStart: 7.15, gateWidth: 0.85 },
  tech: { slope: 0.95, offset: -0.9, gateStart: 7.6, gateWidth: 0.9 },
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function calibrateSrForFamily(sr: number, family: DanPrimaryFamily): number {
  const calibration = SR_CALIBRATION[family];
  const targetSr = sr * calibration.slope + calibration.offset;
  const gate = clamp01((sr - calibration.gateStart) / calibration.gateWidth);
  return sr + (targetSr - sr) * gate;
}

function getCalibrationFamily(family: DanPrimaryFamily): DanPrimaryFamily {
  return family === "jumpstream" ? "handstream" : family;
}

export function getInputRate(input: DanEstimateInput): number {
  const rate = Number(input.rate);
  return Number.isFinite(rate) && rate > 0.4 && rate < 2.5 ? rate : 1;
}

export function srToRawDan(sr: number, family: DanPrimaryFamily, options: { calibrate?: boolean } = {}): number {
  const calibrationFamily = getCalibrationFamily(family);
  const calibratedSr = options.calibrate === false ? sr : calibrateSrForFamily(sr, calibrationFamily);
  return rawDanFromMeans(calibratedSr, DAN_MEANS[calibrationFamily]);
}

export function parseDan(rawDan: number) {
  const maxLevel = (MAX_SUPPORTED_DAN_INDEX >= 0 ? MAX_SUPPORTED_DAN_INDEX : DAN_LABELS.length - 1) + 1;
  const level = Math.min(maxLevel, Math.max(1, Math.round(rawDan)));
  const offset = rawDan - level;
  const variant = offset <= -0.45 ? "--" : offset <= -0.25 ? "-" : offset < 0.1 ? null : offset < 0.26 ? "+" : "++";
  const label = DAN_LABELS[level - 1];
  return {
    label,
    variant,
    displayName: `${label}${variant ?? ""}`,
  };
}
