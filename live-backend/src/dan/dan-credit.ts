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
 *   spans a fixed number of accuracy points under the bar - four on the rice
 *   ladders, narrower on 6K/7K LN (danCreditBelowBarWindowFor).
 *
 * 4K LN is the exception on both halves and carries tables of its own
 * (danCreditOptionsFor): its bar is written in ScoreV2, where a 100% is not
 * reachable on most charts with long notes, so a curve whose top anchor sits
 * on 100% prices the accuracies people actually set at nearly nothing. Its
 * bonus is keyed in absolute points over the bar and tops out at 99.7%, and
 * its window runs 2.5 points under the bar rather than one.
 */
export type DanCreditAnchors = ReadonlyArray<readonly [at: number, offset: number]>;

/** How far under a ladder's bar a pass still credits something, in accuracy points. */
export const DAN_CREDIT_BELOW_BAR_WINDOW = 0.04;

/**
 * The LN ladders' own, much narrower decay window. Accuracy is cheap to hold
 * on long notes (the same argument behind the bonus damping and the 4K
 * near-bar cap), so four points under an LN bar is a routine accuracy nowhere
 * near the course requirement, and those credits dominated 4K LN even after
 * the v7 bonus cool-off (measured 2026-08-28: 96.3% of its best-5 windows
 * carried a sub-bar credit, mean drift +0.89 vs +0.63 on 4K rice). One point
 * under the bar keeps only the near-miss band: 94%+ against the 6K/7K 95%
 * stable bar.
 */
export const DAN_CREDIT_LN_BELOW_BAR_WINDOW = 0.01;

/**
 * 4K LN's own window, wider than the other LN ladders' (2026-08-29). Its bar
 * is written in ScoreV2, where a hold's release is judged separately and a
 * 100% is not on the table on most charts, so a ScoreV2 point there is not
 * the cheap point the stable ladders price: 94.5% is the near-miss band
 * against the 97% bar, the same way 96% is against a stable 97%.
 */
export const DAN_CREDIT_4K_LN_BELOW_BAR_WINDOW = 0.025;

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
 * The decay half, before the near-bar cap clamps its top. At a 96% bar:
 * 95% -> -0.51, 94% -> -0.76, 92% -> -1.25, and below 92% no credit at all.
 * The bottom deepened from -1 (2026-08-28): a scrape at the very edge of the
 * window was still crediting inside the next level's "+" band (92.09% on an
 * epsilon+ chart printed delta+/delta++), and the owner's read is that a pass
 * a full window under the bar is worth a bare level down, no more.
 *
 * A curve was tried here and reverted (2026-08-29): bending the line so a near
 * miss left the bar slowly was worth up to 0.15 of a level to every sub-bar
 * clear on these ladders, and the straight line reads truer. 4K LN, whose
 * window is 2.5 points rather than four, keeps a shaped decay of its own.
 */
export const DAN_CREDIT_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, -0.26],
  [1, -1.25],
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
 * 4K LN's decay half, over its own 2.5 point window: 97% -> -0.3,
 * 96.5% -> -0.9, 96% -> -1.06, 95% -> -1.39, 94.5% -> -1.55, and nothing under
 * that. The bottom is deeper than the other ladders' -1.25 (2026-08-29): the
 * window itself is 2.5 points wide here, so a scrape at its edge is much
 * further off the bar than a rice scrape at the edge of four. -1.55 rather
 * than a round -1.5 is priced off one run: a 94.74% on a 14 dan chart, which
 * the owner reads as 13-- and which -1.5 credited a band too high.
 *
 * The knee at 96.5% is what keeps the step at the bar small. Every ladder's
 * credit jumps where the bar is (the near-bar cap: a near miss must never be
 * credited the chart's own dan), but on 4K LN that jump was the 0.75 cap, so
 * 96.99% credited a level less than 97% did - a cliff people read as a bug on
 * the curve. The cap is 0.3 here now, and the first half point under the bar
 * carries the drop the cap used to make in one step, so nothing from 96.5%
 * down moved.
 */
export const DAN_CREDIT_4K_LN_BELOW_BAR_ANCHORS: DanCreditAnchors = [
  [0, -0.3],
  [0.2, -0.9],
  [1, -1.55],
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
   * The smallest magnitude a sub-bar credit may take, so a near-miss can
   * never be credited the chart's own dan (danCreditNearBarCapFor picks the
   * ladder-aware value). Applied as a clamp on the interpolated offset, which
   * keeps the anchor table ladder-free and stays monotone.
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
    return Math.min(offset, -(options.nearBarCap ?? 0.26));
  }
  const aboveBar = options.aboveBar ?? DAN_CREDIT_ABOVE_BAR_ANCHORS;
  if ((options.aboveBarScale ?? "headroom") === "delta") {
    return interpolateAnchors(aboveBar, Math.max(0, delta));
  }
  // The bonus always scores against at least the standard 4-point span, not
  // the caller's decay window: narrowing a ladder's window (4K LN) tightens
  // what a near-miss credits without re-heating the bonus v7 cooled.
  const headroom = Math.max(1 - bar, DAN_CREDIT_BELOW_BAR_WINDOW);
  const t = headroom > 0 ? Math.min(1, Math.max(0, delta) / headroom) : 1;
  return interpolateAnchors(aboveBar, t);
}

/**
 * The ladder-aware near-bar cap. 0.26 is one hundredth inside the "-" tier of
 * parseDan and danTableLabelFor (their "-" band opens at -0.25), so a sub-bar
 * credit on those ladders prints as at least the chart's level with a minus.
 * The 4K LN cap is 0.3, a hair deeper for the same reason and no deeper than
 * that: it used to be 0.75, which made the credit fall a full level between
 * 97% and 96.99% (2026-08-29). The pricing that cap carried lives in that
 * ladder's own decay anchors instead, which reach the same -0.9 half a point
 * under the bar rather than at it.
 *
 * For a chart whose rawDan is not an integer this is a floor on the credit
 * rather than a label guarantee (a 15.2 chart credited at -0.26 still prints
 * bare epsilon); the load-bearing part is that a sub-bar credit can never
 * equal the chart's own dan.
 */
export function danCreditNearBarCapFor(side: "rc" | "ln", keyCount: number): number {
  return keyCount === 4 && side === "ln" ? 0.3 : 0.26;
}

/**
 * Every ladder-aware knob of the chart-clear curve in one place, so the page
 * that draws the curve and the estimator that credits against it can never
 * drift apart. 4K LN is the one ladder with tables of its own; the rest read
 * the shared anchors and differ only in window and cap.
 */
export function danCreditOptionsFor(side: "rc" | "ln", keyCount: number): DanCreditOptions {
  const options: DanCreditOptions = {
    nearBarCap: danCreditNearBarCapFor(side, keyCount),
    belowBarWindow: danCreditBelowBarWindowFor(side, keyCount),
  };
  if (side === "ln" && keyCount === 4) {
    options.aboveBar = DAN_CREDIT_4K_LN_ABOVE_BAR_ANCHORS;
    options.aboveBarScale = "delta";
    options.belowBar = DAN_CREDIT_4K_LN_BELOW_BAR_ANCHORS;
  }
  return options;
}

/**
 * A chart clear's credited dan: the chart's rawDan plus the accuracy offset,
 * clamped to the ladder's floor and ceiling. Null when the accuracy is below
 * the credit window. The ceiling keeps a maxed clear from crediting past the
 * ladder's "beyond the table" sentinel; the floor keeps a decayed scrape on a
 * bottom-rung chart from going below the scale (skill surfaces treat a
 * non-positive rawDan as unrated). At the literal bottom rung the floor can
 * eat some of the decay; nothing meaningful is measured down there.
 */
export function creditedDanFor(
  chartDan: number,
  accuracy: number,
  bar: number,
  side: "rc" | "ln",
  keyCount: number,
): number | null {
  const offset = danCreditOffset(accuracy, bar, danCreditOptionsFor(side, keyCount));
  if (offset == null) return null;
  let credited = chartDan + offset;
  const ceiling = danTableCeilingFor(side, keyCount);
  if (ceiling != null) credited = Math.min(credited, ceiling);
  return Math.max(credited, danTableFloorFor(side, keyCount));
}
