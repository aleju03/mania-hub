import type { PrismWorkloadParams, PrismPattern } from "./workload";

export const PRISM_VERSION = "0.25";

export { PRISM_ENABLED, PRISM_KEY_COUNTS, usesPrism } from "./switch";

export const PRISM_BASE_GOAL = 0.965;
export const PRISM_MAX_GOAL = 0.98;

export const PRISM_GOAL_FLOOR = 0.9;

export const PRISM_EXTRAPOLATION_MAX_SLOPE = 1.2;

export const PRISM_UNDER_BASE_STRETCH = 1.5;

export interface PrismModel extends PrismWorkloadParams {
  goalExponent: number;
}

export interface PrismScale {
  strain: readonly number[];
  rating: readonly number[];
}

const PRESS: PrismModel = {
  chordUnits: 0.0097, jackUnits: 2.857, jackWindowMs: 180, jackChordShare: 0.078, graceMs: 22.54, graceDiscount: 0.1933, rollDiscount: 0.4458,
  speedPower: 0.098, shapeUnits: 0.3483, bracketUnits: 0.5, centreUnits: 0.3794, independenceUnits: 0.495,
  independenceHeldPower: 1.24, heldBodyFullMs: 518, releaseUnits: 0.1592,
  releaseLongUnits: 1.452, releaseLongFullMs: 1000, odPower: 0.2, flamUnits: 1, halfLifeMs: 248, sustainRatio: 12.1, sustainWeight: 0.3788, staminaHalfLifeMs: 93510,
  staminaWeight: 0.14, handShare: 0.2083, goalExponent: 4.114,
};

const LN: PrismModel = {
  ...PRESS, jackUnits: 6.533, jackChordShare: 0, releaseUnits: 0.0564, independenceUnits: 0.5454, independenceHeldPower: 1.25, heldBodyFullMs: 435,
  releaseLongUnits: 3.293, releaseLongFullMs: 714, releaseRepressMs: 168, releaseRepressDiscount: 0.4, odPower: 0.4, flamUnits: 1.167, sustainWeight: 0.19,
};

const SCALE_7K: PrismScale = {
  strain: [0.9903, 1.688, 2.928, 3.814, 4.424, 4.907, 5.357, 5.792, 6.338, 6.81, 7.558, 8.248, 9.136, 10.73, 12.61],
  rating: [2.151, 5.006, 10.21, 14.3, 17.02, 19.09, 20.82, 22.81, 24.59, 26.53, 28.51, 30.41, 33, 36.68, 40.62],
};
const SCALE_6K: PrismScale = {
  strain: [0.8068, 1.47, 2.464, 3.282, 3.843, 4.141, 4.511, 4.971, 5.313, 5.629, 5.991, 6.381, 7.191, 8.341, 9.911],
  rating: [2.716, 5.316, 10.49, 13.68, 16.02, 17.91, 19.82, 21.29, 22.65, 24.23, 25.46, 27.09, 29.16, 33.98, 37.35],
};
const SCALE_8K: PrismScale = { strain: SCALE_7K.strain, rating: SCALE_7K.rating.map((rating) => rating * 0.892) };
const LN_SCALE_7K: PrismScale = {
  strain: [2.079, 3.783, 5.305, 6.591, 7.534, 8.225, 8.881, 9.563, 10.18, 10.96, 11.56, 12.89, 14.13, 16.74, 20.07],
  rating: [3.994, 9.566, 15.8, 21.12, 24.54, 26.71, 28.21, 29.45, 30.59, 32.27, 33.45, 35.17, 36.72, 39.58, 43.01],
};
const LN_SCALE_6K: PrismScale = {
  strain: [1.859, 2.604, 4.697, 5.59, 6.051, 6.663, 6.881, 7.164, 7.523, 7.713, 8.027, 8.748, 9.888, 12.88, 15.73],
  rating: [4.237, 6.534, 14.97, 19.43, 20.77, 22.63, 22.85, 24.14, 25.06, 26.74, 27.52, 28.23, 31.15, 35.44, 38.8],
};
const LN_SCALE_8K: PrismScale = { strain: SCALE_8K.strain.map((strain) => strain * 1.599), rating: SCALE_8K.rating };

export interface PrismKeymodeModel {
  press: PrismModel;
  scale: PrismScale;
  ln: PrismModel;
  lnScale: PrismScale;
}

export const PRISM_MODELS: Readonly<Record<number, PrismKeymodeModel>> = {
  6: { press: PRESS, scale: SCALE_6K, ln: LN, lnScale: LN_SCALE_6K },
  7: { press: PRESS, scale: SCALE_7K, ln: LN, lnScale: LN_SCALE_7K },
  8: { press: PRESS, scale: SCALE_8K, ln: LN, lnScale: LN_SCALE_8K },
};

export const PRISM_SKILLSET_FLOOR = 0.6;

export const PRISM_SKILLSET_SHAPE: Readonly<Record<PrismPattern, { reference: number; exponent: number }>> = {
  stream: { reference: 0.9765, exponent: 0.625 },
  chordstream: { reference: 0.625, exponent: 0.5 },
  bracket: { reference: 1, exponent: 0.625 },
  jack: { reference: 0.18, exponent: 0.96 },
  chordjack: { reference: 0.45, exponent: 0.5 },
  ln: { reference: 0.5, exponent: 1 },
  technical: { reference: 0.0922, exponent: 0.45 },
  speed: { reference: 0.5, exponent: 1.2 },
};
