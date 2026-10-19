import { danTableCeilingFor, danTableFloorFor } from "../classification/chart-classifier";

export type DanCreditAnchors = ReadonlyArray<readonly [at: number, offset: number]>;

export const DAN_CREDIT_BELOW_BAR_WINDOW = 0.05;

export const DAN_CREDIT_BONUS_MIN_SPAN = 0.04;

export const DAN_CREDIT_JACK_BONUS_SCALE = 0.5;

export const DAN_CREDIT_7K_ACCURACY_MAP: DanCreditAnchors = [
  [0.96, 0.96],
  [0.965, 0.973],
  [0.97, 0.9782],
  [0.975, 0.9829],
  [0.98, 0.988],
  [0.985, 0.9919],
  [0.99, 0.995],
  [0.995, 0.9984],
  [1, 1],
];

export const DAN_CREDIT_LN_BELOW_BAR_WINDOW = 0.03;

export const DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW = 0.06;

export function danCreditBelowBarWindowFor(side: "rc" | "ln", keyCount: number): number {
  if (side !== "ln") return DAN_CREDIT_BELOW_BAR_WINDOW;
  return keyCount === 4 ? DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW : DAN_CREDIT_LN_BELOW_BAR_WINDOW;
}

export const DAN_CREDIT_ABOVE_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.25, 0],
  [0.675, 0.2],
  [0.75, 0.7],
  [0.875, 1.1],
  [1, 1.5],
];

export const DAN_CREDIT_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.2, -0.5075],
  [0.8, -1.25],
  [1, -1.5],
];

export const DAN_CREDIT_LN_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [1 / 3, -1.25],
  [2 / 3, -1.5],
  [1, -1.75],
];

export const DAN_CREDIT_4K_LN_ABOVE_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.01, 0],
  [0.015, 0.15],
  [0.02, 0.3],
  [0.025, 0.5],
  [0.027, 0.7],
];

export const DAN_CREDIT_4K_LN_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [1 / 6, -0.5075],
  [4 / 6, -1.25],
  [5 / 6, -1.5],
  [1, -1.75],
];

export const CREDIT_EDGE_TOLERANCE = 1e-9;

export interface DanCreditOptions {
  aboveBar?: DanCreditAnchors;
  belowBar?: DanCreditAnchors;
  belowBarWindow?: number;
  nearBarCap?: number;
  allowBelowBar?: boolean;
  aboveBarScale?: "headroom" | "delta";
  bonusScale?: number;
  accuracyMap?: DanCreditAnchors;
}

function interpolateAnchors(anchors: DanCreditAnchors, at: number): number {
  const first = anchors[0];
  if (at <= first[0]) return first[1];
  for (let i = 1; i < anchors.length; i += 1) {
    const [upperAt, upperOffset] = anchors[i];
    if (at > upperAt) continue;
    const [lowerAt, lowerOffset] = anchors[i - 1];
    const span = upperAt - lowerAt;
    const t = span > 0 ? (at - lowerAt) / span : 1;
    return lowerOffset + (upperOffset - lowerOffset) * t;
  }
  return anchors[anchors.length - 1][1];
}

export function danCreditOffset(accuracy: number, bar: number, options: DanCreditOptions = {}): number | null {
  const window = options.belowBarWindow ?? DAN_CREDIT_BELOW_BAR_WINDOW;
  let delta = accuracy - bar;
  if (!(delta >= -window - CREDIT_EDGE_TOLERANCE)) return null;
  if (delta < -CREDIT_EDGE_TOLERANCE) {
    if (options.allowBelowBar === false) return null;
    const belowBar = options.belowBar ?? DAN_CREDIT_BELOW_BAR_ANCHORS;
    const s = Math.min(1, -delta / window);
    const offset = interpolateAnchors(belowBar, s);
    return Math.min(offset, -(options.nearBarCap ?? 0));
  }
  const aboveBar = options.aboveBar ?? DAN_CREDIT_ABOVE_BAR_ANCHORS;
  const bonusScale = options.bonusScale ?? 1;
  if ((options.aboveBarScale ?? "headroom") === "delta") {
    return interpolateAnchors(aboveBar, Math.max(0, delta)) * bonusScale;
  }
  if (options.accuracyMap && accuracy >= options.accuracyMap[0][0]) {
    delta = interpolateAnchors(options.accuracyMap, accuracy) - bar;
  }
  const headroom = Math.max(1 - bar, DAN_CREDIT_BONUS_MIN_SPAN);
  const t = headroom > 0 ? Math.min(1, Math.max(0, delta) / headroom) : 1;
  return interpolateAnchors(aboveBar, t) * bonusScale;
}

export function danCreditNearBarCapFor(_side: "rc" | "ln", _keyCount: number): number {
  return 0;
}

export interface DanCreditClearContext {
  primaryTile?: string | null;
}

export function danCreditTakesJackDamping(side: "rc" | "ln", keyCount: number, context?: DanCreditClearContext): boolean {
  return side === "rc" && keyCount === 4 && context?.primaryTile === "jack";
}

export function danCreditOptionsFor(side: "rc" | "ln", keyCount: number, context?: DanCreditClearContext): DanCreditOptions {
  const options: DanCreditOptions = {
    nearBarCap: danCreditNearBarCapFor(side, keyCount),
    belowBarWindow: danCreditBelowBarWindowFor(side, keyCount),
  };
  if (danCreditTakesJackDamping(side, keyCount, context)) options.bonusScale = DAN_CREDIT_JACK_BONUS_SCALE;
  if (side === "ln" && keyCount === 4) {
    options.aboveBar = DAN_CREDIT_4K_LN_ABOVE_BAR_ANCHORS;
    options.aboveBarScale = "delta";
    options.belowBar = DAN_CREDIT_4K_LN_BELOW_BAR_ANCHORS;
  } else if (side === "ln") {
    options.belowBar = DAN_CREDIT_LN_BELOW_BAR_ANCHORS;
  } else if (keyCount === 7) {
    options.accuracyMap = DAN_CREDIT_7K_ACCURACY_MAP;
  }
  return options;
}

export function creditedDanFor(
  chartDan: number,
  accuracy: number,
  bar: number,
  side: "rc" | "ln",
  keyCount: number,
  context?: DanCreditClearContext,
): number | null {
  const offset = danCreditOffset(accuracy, bar, danCreditOptionsFor(side, keyCount, context));
  if (offset == null) return null;
  let credited = chartDan + offset;
  const ceiling = danTableCeilingFor(side, keyCount);
  if (ceiling != null) credited = Math.min(credited, ceiling);
  return Math.max(credited, danTableFloorFor(side, keyCount));
}
