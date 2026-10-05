import { etternaOverallFromRatings } from "../../lib/skill-axes";

/** A history snapshot's Overall under the reader's method, derived from its
 * skillsets so older entries read on the same scale as the card. */
export function historyOverall(ratings: Record<string, number>, keyCount: number, etterna: boolean): number {
  const derived = etterna ? etternaOverallFromRatings(keyCount, ratings) : 0;
  return derived > 0 ? derived : ratings.Overall ?? 0;
}

/** Integer ticks at a step that keeps the axis to about five labels. */
export function overallTicks(min: number, max: number): number[] {
  const span = max - min;
  const step = [1, 2, 5, 10].find((candidate) => span / candidate <= 6) ?? 20;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) ticks.push(value);
  return ticks;
}
