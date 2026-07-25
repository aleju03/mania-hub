// Port of osu!lazer's ManiaPerformanceCalculator - the October 2022
// accuracy-only rework, current as of ppy/osu master 2026-07 (including the
// #38219 miss/accuracy clamps). Mania pp is a pure function of star rating,
// a 320-weighted "custom accuracy" over the judgement counts, a note-count
// length bonus, and flat NF/EZ multipliers: no combo, score, hit-window, or
// unstable-rate terms. Stable and lazer scores run through this same formula
// server-side; only the judgement counts differ (a stable LN yields one
// combined judgement, a lazer LN judges head and tail separately), which is
// already how the replay judgement simulation counts them.

export interface ManiaPpCounts {
  perfect: number; // MAX / 320
  great: number; // 300
  good: number; // 200
  ok: number; // 100
  meh: number; // 50
  miss: number;
}

export interface ManiaPpInput {
  starRating: number;
  counts: ManiaPpCounts;
  // From getManiaPpModMultiplier; defaults to nomod.
  modMultiplier?: number;
}

// Only NF and EZ scale mania pp; rate mods act through the star rating.
export function getManiaPpModMultiplier(modAcronyms: readonly string[]): number {
  let multiplier = 1;
  const acronyms = modAcronyms.map((acronym) => acronym.toUpperCase());
  if (acronyms.includes("NF")) multiplier *= 0.75;
  if (acronyms.includes("EZ")) multiplier *= 0.5;
  return multiplier;
}

// ManiaPerformanceCalculator.calculateCustomAccuracy: weights judgements
// independently of the score's displayed accuracy (Perfect is 320 here in
// both rulesets, unlike stable's 300-weighted display accuracy).
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
    * Math.pow(Math.max(starRating - 0.15, 0.05), 2.2) // Star rating to pp curve
    * Math.max(0, 5 * accuracy - 4) // From 80% accuracy, 1/20th of total pp per additional 1%
    * (1 + 0.1 * Math.min(1, totalHits / 1500)); // Length bonus, capped at 1500 notes

  return difficultyValue * modMultiplier;
}
