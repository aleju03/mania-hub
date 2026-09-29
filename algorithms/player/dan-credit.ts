// Accuracy credit curve for dan clears. A pass at the ladder's bar credits the
// chart's dan. Accuracy above the bar adds a bonus, and accuracy below it
// decays toward a window edge, under which nothing credits.
import { danTableCeilingFor, danTableFloorFor } from "../classification/chart-classifier";

/**
 * Anchor tables are normalized so one table serves every bar. Above the bar,
 * t = (accuracy - bar) / max(1 - bar, DAN_CREDIT_BONUS_MIN_SPAN). Below it,
 * s = (bar - accuracy) / window. 4K LN keys its bonus in absolute points
 * because its ScoreV2 bar rarely allows 100%.
 */
export type DanCreditAnchors = ReadonlyArray<readonly [at: number, offset: number]>;

/** How far under a rice ladder's bar a pass still credits. A 96% bar credits down to 91%. */
export const DAN_CREDIT_BELOW_BAR_WINDOW = 0.05;

/**
 * The narrowest span the bonus is scored against. Kept separate from the decay
 * window so changing the window does not rescale the bonus.
 */
export const DAN_CREDIT_BONUS_MIN_SPAN = 0.04;

/**
 * Share of the above-bar bonus kept by a 4K rice clear whose primary tile is
 * jack. About a third of 4K jack clears land at 99%+. Halving brings the tile's
 * mean bonus in line with tech and stamina.
 */
export const DAN_CREDIT_JACK_BONUS_SCALE = 0.5;

/**
 * The 6K/7K LN decay window, three points under the 95% bar. Accuracy is cheap
 * on long notes, so a wider window would let routine accuracies dominate.
 */
export const DAN_CREDIT_LN_BELOW_BAR_WINDOW = 0.03;

/** 4K LN decay window, six points under its 97% ScoreV2 bar, down to 91% like rice. */
export const DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW = 0.06;

export function danCreditBelowBarWindowFor(side: "rc" | "ln", keyCount: number): number {
  if (side !== "ln") return DAN_CREDIT_BELOW_BAR_WINDOW;
  return keyCount === 4 ? DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW : DAN_CREDIT_LN_BELOW_BAR_WINDOW;
}

/**
 * Bonus half, on the headroom scale. The first quarter is flat, so the point
 * above the bar is a bare clear. The curve reaches only +0.2 under 99% and
 * rises from there to +1.5 at 100%.
 */
export const DAN_CREDIT_ABOVE_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.25, 0],
  [0.675, 0.2],
  [0.75, 0.7],
  [0.875, 1.1],
  [1, 1.5],
];

/**
 * Rice decay half, falling to -1.5 at the window edge. It meets the bar with no
 * step, so a near miss can keep the chart's display tier.
 */
export const DAN_CREDIT_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.2, -0.5075],
  [0.8, -1.25],
  [1, -1.5],
];

/**
 * 6K/7K LN decay half. It drops to -1.25 over the first point under the bar,
 * then a quarter level per point down to -1.75 at 92%.
 */
export const DAN_CREDIT_LN_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [1 / 3, -1.25],
  [2 / 3, -1.5],
  [1, -1.75],
];

/**
 * 4K LN bonus half, in absolute accuracy points over the 97% ScoreV2 bar. It
 * tops out at +0.7 at 99.7%, since ScoreV2 rarely gives 100% on long notes.
 */
export const DAN_CREDIT_4K_LN_ABOVE_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.01, 0],
  [0.015, 0.15],
  [0.02, 0.3],
  [0.025, 0.5],
  [0.027, 0.7],
];

/**
 * 4K LN decay half. Matches the rice table point for point under the bar, then
 * adds one more point at a quarter level, down to -1.75 at 91%.
 */
export const DAN_CREDIT_4K_LN_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [1 / 6, -0.5075],
  [4 / 6, -1.25],
  [5 / 6, -1.5],
  [1, -1.75],
];

/** Float slack for accuracies exactly on a window edge. */
export const CREDIT_EDGE_TOLERANCE = 1e-9;

export interface DanCreditOptions {
  aboveBar?: DanCreditAnchors;
  belowBar?: DanCreditAnchors;
  belowBarWindow?: number;
  /**
   * Smallest magnitude a sub-bar credit may take. Zero on chart ladders. The
   * course curves keep a minimum deduction.
   */
  nearBarCap?: number;
  /** Off for a ladder that credits from the bar up only (4K LN courses). */
  allowBelowBar?: boolean;
  /**
   * "headroom" keys the above-bar anchors on the normalized t. "delta" keys
   * them in absolute accuracy points over the bar.
   */
  aboveBarScale?: "headroom" | "delta";
  /** Multiplier on the above-bar offset only. Carries the jack tile damping. */
  bonusScale?: number;
}

export interface DanCreditClearContext {
  /** The clear's primary skillset tile. Only "jack" on 4K rice changes anything. */
  primaryTile?: string | null;
}

/**
 * Credited level offset for an accuracy against a bar, or null when the pass
 * is under the credit window. A NaN accuracy credits nothing.
 */
export function danCreditOffset(accuracy: number, bar: number, options: DanCreditOptions = {}): number | null {
  const window = options.belowBarWindow ?? DAN_CREDIT_BELOW_BAR_WINDOW;
  const delta = accuracy - bar;
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
  const headroom = Math.max(1 - bar, DAN_CREDIT_BONUS_MIN_SPAN);
  const t = headroom > 0 ? Math.min(1, Math.max(0, delta) / headroom) : 1;
  return interpolateAnchors(aboveBar, t) * bonusScale;
}

/**
 * Zero on every chart ladder, so each decay meets the bar with no step. The
 * course curves keep a cap of their own in dan-courses.ts.
 */
export function danCreditNearBarCapFor(_side: "rc" | "ln", _keyCount: number): number {
  return 0;
}

/** Whether a clear's primary tile takes the damped jack bonus. */
export function danCreditTakesJackDamping(side: "rc" | "ln", keyCount: number, context?: DanCreditClearContext): boolean {
  return side === "rc" && keyCount === 4 && context?.primaryTile === "jack";
}

/**
 * Ladder options for the chart-clear curve. 4K LN has its own tables on both
 * halves, 6K/7K LN has its own decay, and a 4K rice jack clear takes the
 * damped bonus.
 */
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
  }
  return options;
}

/**
 * A chart clear's credited dan, the chart's dan plus the accuracy offset,
 * clamped to the ladder's floor and ceiling. Null under the credit window. The
 * floor matters because a non-positive dan reads as unrated elsewhere.
 */
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

/** Piecewise-linear lookup; flat before the first anchor and after the last. */
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
