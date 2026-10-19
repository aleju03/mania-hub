export interface ManiaPpCounts {
  perfect: number;
  great: number;
  good: number;
  ok: number;
  meh: number;
  miss: number;
}

export interface ManiaPpInput {
  starRating: number;
  counts: ManiaPpCounts;
  modMultiplier?: number;
}

export function getManiaPpModMultiplier(modAcronyms: readonly string[]): number {
  let multiplier = 1;
  const acronyms = modAcronyms.map((acronym) => acronym.toUpperCase());
  if (acronyms.includes("NF")) multiplier *= 0.75;
  if (acronyms.includes("EZ")) multiplier *= 0.5;
  return multiplier;
}

export function calculateManiaCustomAccuracy(counts: ManiaPpCounts): number {
  const miss = Math.max(0, counts.miss);
  const totalHits = counts.perfect + counts.great + counts.good + counts.ok + counts.meh + miss;
  if (totalHits <= 0) return 0;
  const weighted = counts.perfect * 320 + counts.great * 300 + counts.good * 200 + counts.ok * 100 + counts.meh * 50;
  return Math.min(1, Math.max(0, weighted / (totalHits * 320)));
}

export function calculateManiaPp({ starRating, counts, modMultiplier = 1 }: ManiaPpInput): number {
  if (!Number.isFinite(starRating)) return 0;
  const miss = Math.max(0, counts.miss);
  const totalHits = counts.perfect + counts.great + counts.good + counts.ok + counts.meh + miss;
  const accuracy = calculateManiaCustomAccuracy(counts);

  const difficultyValue = 8.0
    * Math.pow(Math.max(starRating - 0.15, 0.05), 2.2)
    * Math.max(0, 5 * accuracy - 4)
    * (1 + 0.1 * Math.min(1, totalHits / 1500));

  return difficultyValue * modMultiplier;
}
