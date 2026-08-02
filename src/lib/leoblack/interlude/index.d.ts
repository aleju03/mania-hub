/**
 * Interlude star rating. `source` accepts osu text, a fetchable path/url, or an
 * OsuFileParser instance carrying `osuText`. Returns 0 when the chart yields no
 * finite difficulty.
 */
export function calculateInterludeStar(
  source: string,
  rate?: number,
  cvtFlag?: string | null,
): Promise<number>;

export default calculateInterludeStar;
