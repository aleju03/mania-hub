import { danTableCeilingFor, danTableFloorFor } from "./chart-classifier.js";

/**
 * The accuracy-graded credit curve for dan clears: how far above or below a
 * chart's own rawDan a pass credits, as a function of where its accuracy sits
 * against the ladder's bar. The bar is the zero point on purpose: a bare pass
 * at the bar credits the chart's full rawDan, exactly as it always has, and
 * the curve only moves credit away from the bar in both directions. That is
 * what separates this from the removed danCreditFor fade (added 970c48b1,
 * removed 75373b2b), which discounted the at-bar clear itself on top of the
 * quorum and landed below what the community tables ask for.
 *
 * The shared anchor tables are normalized so one table serves every ladder no
 * matter where its bar sits (95%, 96%, 97%):
 *   above the bar, on t = (accuracy - bar) / max(1 - bar, window), the share
 *   of the remaining headroom but never against a span narrower than the
 *   decay window;
 *   below the bar, on s = (bar - accuracy) / window, so the credit window
 *   spans a fixed number of accuracy points under the bar - five on the rice
 *   ladders, three on 6K/7K LN (danCreditBelowBarWindowFor).
 *
 * 4K LN is the exception on both halves and carries tables of its own
 * (danCreditOptionsFor): its bar is written in ScoreV2, where a 100% is not
 * reachable on most charts with long notes, so a curve whose top anchor sits
 * on 100% prices the accuracies people actually set at nearly nothing. Its
 * bonus is keyed in absolute points over the bar and tops out at 99.7%. Its
 * decay reads the rice line point for point under its own 97% bar and runs
 * one point further, six in all, so it reaches 91% like the rice ladders do.
 */
export type DanCreditAnchors = ReadonlyArray<readonly [at: number, offset: number]>;

/**
 * How far under a ladder's bar a pass still credits something, in accuracy
 * points. Five on the rice ladders since 2026-08-31 (four before it), so a 96%
 * bar credits down to 91% rather than 92%. Like the LN widening beside it this
 * is an extension and not a re-pricing: DAN_CREDIT_BELOW_BAR_ANCHORS carries a
 * knee at the old four-point mark, so every accuracy that already credited
 * credits the same.
 */
export const DAN_CREDIT_BELOW_BAR_WINDOW = 0.05;

/**
 * The narrowest span the bonus half ever scores against, which is the decay
 * window as it stood when the bonus was tuned. Held apart from the window
 * itself: a 96% bar has only four points of headroom, so once the window grew
 * to five, reading the clamp off the window would have re-scaled the whole
 * bonus (a 100% on a 96% ladder would credit +0.86 instead of +1.5). Widening
 * what a scrape still credits must never move what a good clear credits.
 */
export const DAN_CREDIT_BONUS_MIN_SPAN = 0.04;

/**
 * How much of the above-bar bonus a 4K rice clear filed primarily under the
 * jack tile keeps (2026-09-13). On jack, 99%+ is what a pass looks like rather
 * than evidence of the next level: measured over every 4K rice clear in the
 * live snapshot, a third of jack clears at 1.0x sit at 99%+ and the tile
 * holds near 30% at every chart length past a minute, where speed, tech and
 * stamina settle at 17-22%. Under the shared curve that priced a 99.3% on an
 * alpha- chart at beta. Halving the bonus brings the jack tile's mean bonus
 * per averaged clear from 0.32 to about 0.16, level with tech and stamina.
 * The decay half is untouched: a jack scrape is still a miss. The same
 * argument already gives 4K LN its own damped table (danCreditOptionsFor).
 */
export const DAN_CREDIT_JACK_BONUS_SCALE = 0.5;

/**
 * The 6K/7K LN ladders' own decay window, still much narrower than rice's five
 * points. Accuracy is cheap to hold on long notes (the same argument behind
 * the bonus damping), so four points under an LN bar
 * is a routine accuracy nowhere near the course requirement, and those credits
 * dominated 4K LN even after the v7 bonus cool-off (measured 2026-08-28: 96.3%
 * of its best-5 windows carried a sub-bar credit, mean drift +0.89 vs +0.63 on
 * 4K rice). One point was too tight in practice (2026-08-31): it cut off at
 * 94% against the 6K/7K 95% stable bar, which turned away runs the owner reads
 * as real evidence a level or so down. Three points keeps the near-miss band
 * wide enough to hold them, down to 92%. The band that was already credited is
 * priced exactly as it was: DAN_CREDIT_LN_BELOW_BAR_ANCHORS keeps the old
 * one-point line as its first third, so widening the window credits new clears
 * without moving a single existing one.
 */
export const DAN_CREDIT_LN_BELOW_BAR_WINDOW = 0.03;

/**
 * 4K LN's own window: six points under its 97% ScoreV2 bar, so it reaches 91%
 * like the rice ladders (2026-09-13). It ran 2.5 points, to 94.5%, from
 * 2026-08-29, on the argument that a ScoreV2 point, with every release judged
 * on its own, is dearer than a stable point. That was priced against 4K LN
 * chart ratings that ran hot; with those rebalanced, the narrow window turned
 * away every 91-94.5% pass and the steep line above it took a full level off
 * a 96%. The decay now reads the rice line point for point
 * (DAN_CREDIT_4K_LN_BELOW_BAR_ANCHORS) and the ladder has no step at the bar.
 */
export const DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW = 0.06;

/** The ladder-aware decay window, mirroring danCreditNearBarCapFor's shape. */
export function danCreditBelowBarWindowFor(side: "rc" | "ln", keyCount: number): number {
  if (side !== "ln") return DAN_CREDIT_BELOW_BAR_WINDOW;
  return keyCount === 4 ? DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW : DAN_CREDIT_LN_BELOW_BAR_WINDOW;
}

/**
 * THE tuning knob for the bonus half. The first quarter of the span is a flat
 * zone: a pass in the point above the bar is a bare clear, not a bonus. The
 * real bonus opens at 99% (2026-08-28, second cool-off): under it the curve
 * only crawls to +0.2, because the 98s were still buying a full level (a
 * 98.3% on a beta++ chart credited bare gamma; the owner prices that run at
 * gamma--, and +0.14 there is what prints it). At a 96% bar this reads:
 * 96-96.99% -> +0, 98% -> +0.12, 98.7% -> +0.2, 99% -> +0.7, 99.5% -> +1.1,
 * 100% -> +1.5 (the 99%-and-up anchors are unchanged).
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
 * The rice decay half. At a 96% bar:
 * 95% -> -0.51, 94% -> -0.76, 92% -> -1.25, 91% -> -1.5, and below 91% no
 * credit at all. The value at 92% deepened from -1 (2026-08-28):
 * a scrape at the very edge of the window was still crediting inside the next
 * level's "+" band (92.09% on an epsilon+ chart printed delta+/delta++), and
 * the owner's read is that a pass a full window under the bar is worth a bare
 * level down, no more.
 *
 * The knee at four fifths of the window is where the old four-point window
 * ended (2026-08-31). The window runs five points now, and the line under the
 * knee simply continues at the slope the first four points set, so the new
 * point credits the 91-92% passes the old window turned away and nothing that
 * already credited moves by a hair.
 *
 * The final point below the bar is continuous (2026-09-06): 95% keeps its
 * existing -0.5075, 95.5% credits -0.25375, and the penalty reaches zero at
 * 96%. This removes the immediate -0.26 cliff without moving any credit at
 * 95% or below, or at/above the bar. A near miss can keep the chart's display
 * tier while contributing a smaller number; the accuracy still misses the
 * full-clear requirement. LN and course curves keep their own anchors/caps.
 */
export const DAN_CREDIT_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [0.2, -0.5075],
  [0.8, -1.25],
  [1, -1.5],
];

/**
 * The 6K/7K LN decay half, over its own three point window (2026-08-31). The
 * knee at a third of the window is where the window ended when it was one
 * point, so the two points below it are the new ground carrying the 92-94%
 * runs the old window turned away. Those extend at a quarter level per point
 * rather than at the first point's slope, which would price a 92% below the
 * bottom of any table: the accuracy is cheap on long notes, but a pass is
 * still a pass. Against the 95% bar: 94.9% -> -0.13, 94.5% -> -0.63,
 * 94% -> -1.25, 93% -> -1.5, 92% -> -1.75, and below 92% no credit at all.
 *
 * The first point is continuous with the bar (2026-09-13): it used to start
 * at -0.26 (the near-bar cap, the one place a curve still jumped) and now
 * runs a straight line from zero at 95% to the same -1.25 at 94%, so nothing
 * from 94% down moves and only the last point under the bar is re-priced,
 * the way rice's was on 2026-09-06.
 */
export const DAN_CREDIT_LN_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [1 / 3, -1.25],
  [2 / 3, -1.5],
  [1, -1.75],
];

/**
 * 4K LN's own bonus half, keyed in absolute accuracy points over its 97%
 * ScoreV2 bar rather than in normalized headroom (2026-08-29). The shared
 * headroom table priced this ladder as if the top of the scale were a 100%,
 * which ScoreV2 does not hand out on a chart with long notes: the peak sat on
 * an accuracy nobody reaches, so everything below it crawled (98.01% credited
 * +0.001). The bonus now tops out at 99.7% and holds that value to 100%, and
 * the band between the flat zone and the top carries real credit:
 * 97-98% -> +0 (a bare clear, as on every ladder), 98.5% -> +0.15,
 * 99% -> +0.3, 99.5% -> +0.5, 99.7%+ -> +0.7. The +0.7 top is unchanged from
 * the v7 cool-off, so the ladder is not re-heated at the top, only filled in
 * under it.
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
 * 4K LN's decay half over its six point window (2026-09-13): the rice table's
 * own numbers, point for point under the bar, plus one more point at the
 * same quarter-level slope. Against the 97% bar: 96.5% -> -0.25, 96% -> -0.51,
 * 95% -> -0.76, 94% -> -1.0, 93% -> -1.25, 92% -> -1.5, 91% -> -1.75, and
 * nothing under that. The anchors sit at whole points under the bar (one,
 * four, five, six), so the first five points are the rice line exactly and
 * the knee rice carries at four points under is the same knee here, at 93%.
 *
 * Until 2026-09-13 this ran from a 0.3 step at the bar through -0.9 half a
 * point under to -1.55 at 94.5%. That priced a 96.5% a whole level down and
 * a 96% at -1.06, twice what the same miss costs on rice, and the step made
 * 96.99% read a third of a level under 97%. There is no step now
 * (danCreditNearBarCapFor returns 0 here, as on rice since 2026-09-06): the
 * credit meets the bar from below.
 */
export const DAN_CREDIT_4K_LN_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, 0],
  [1 / 6, -0.5075],
  [4 / 6, -1.25],
  [5 / 6, -1.5],
  [1, -1.75],
];

// Both sides of the comparison are decimals, so a pass sitting exactly ON an
// edge subtracts to a hair under it: 0.92 - 0.96 is -0.040000000000000036,
// which would fall off the credit window and credit nothing. The tolerance is
// float slack, not a grace band, so it is a billionth rather than a hundredth.
export const CREDIT_EDGE_TOLERANCE = 1e-9;

export interface DanCreditOptions {
  aboveBar?: DanCreditAnchors;
  belowBar?: DanCreditAnchors;
  belowBarWindow?: number;
  /**
   * The smallest magnitude a sub-bar credit may take. Rice uses zero for a
   * continuous near-bar penalty; LN and courses retain a minimum deduction.
   * Applied as a clamp on the interpolated offset.
   */
  nearBarCap?: number;
  /** Off for a ladder that credits from the bar up only (4K LN courses). */
  allowBelowBar?: boolean;
  /**
   * How the above-bar anchors are keyed: "headroom" is the normalized t
   * described above; "delta" reads them as absolute accuracy points over the
   * bar, which is how the course registry's historical tables are written.
   */
  aboveBarScale?: "headroom" | "delta";
  /**
   * Multiplier on the above-bar offset alone; 1 when absent. The jack tile's
   * damping (DAN_CREDIT_JACK_BONUS_SCALE) rides here so the decay half and
   * the bar itself stay exactly where every other clear has them.
   */
  bonusScale?: number;
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

/**
 * The credited level offset for an accuracy against a bar, or null when the
 * pass is too far under the bar to credit anything. NaN-safe the same way the
 * old hard gate was: a NaN accuracy fails the window comparison and credits
 * nothing.
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
  // The bonus always scores against at least the standard 4-point span, not
  // the caller's decay window: narrowing a ladder's window (4K LN) tightens
  // what a near-miss credits without re-heating the bonus v7 cooled, and
  // widening one (rice, 6K/7K LN) does not cool the bonus either.
  const headroom = Math.max(1 - bar, DAN_CREDIT_BONUS_MIN_SPAN);
  const t = headroom > 0 ? Math.min(1, Math.max(0, delta) / headroom) : 1;
  return interpolateAnchors(aboveBar, t) * bonusScale;
}

/**
 * The ladder-aware near-bar cap: zero on every chart ladder now, so each
 * decay meets the bar from below with no step. Rice dropped its 0.26 on
 * 2026-09-06, 4K LN its 0.3 (0.75 before 2026-08-29) on 2026-09-13, and
 * 6K/7K LN its 0.26 the same day, once it was the only curve left with the
 * two halves apart at the bar. The 0.26 was chosen to sit inside the "-"
 * tier of parseDan and danTableLabelFor (their "-" band opens at -0.25) so
 * a sub-bar credit always printed with a minus; a near miss can now keep the
 * chart's display tier while contributing a smaller number. The course
 * curves keep a cap of their own (dan-courses.ts). Kept as a function so the
 * curve page and the estimator read one answer per ladder.
 */
export function danCreditNearBarCapFor(_side: "rc" | "ln", _keyCount: number): number {
  return 0;
}

export interface DanCreditClearContext {
  /**
   * The skillset tile the clear files under first (its primary bucket), when
   * the caller knows it. Only "jack" on 4K rice changes anything.
   */
  primaryTile?: string | null;
}

/** Whether a clear's primary tile takes the damped jack bonus. */
export function danCreditTakesJackDamping(side: "rc" | "ln", keyCount: number, context?: DanCreditClearContext): boolean {
  return side === "rc" && keyCount === 4 && context?.primaryTile === "jack";
}

/**
 * Every ladder-aware knob of the chart-clear curve in one place, so the page
 * that draws the curve and the estimator that credits against it can never
 * drift apart. 4K LN is the one ladder with tables of its own on both halves;
 * 6K/7K LN shares the bonus table and carries its own decay, and rice reads
 * the shared anchors throughout. A 4K rice clear whose primary tile is jack
 * takes the damped bonus (DAN_CREDIT_JACK_BONUS_SCALE) through `context`.
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
 * A chart clear's credited dan: the chart's rawDan plus the accuracy offset,
 * clamped to the ladder's floor and ceiling. Null when the accuracy is below
 * the credit window. The ceiling keeps a maxed clear from crediting past the
 * ladder's "beyond the table" sentinel; the floor keeps a decayed scrape on a
 * bottom-rung chart from going below the scale (skill-leaderboards drops a
 * non-positive rawDan as unrated). At the literal bottom rung the floor can
 * eat some of the decay; nothing meaningful is measured down there.
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
