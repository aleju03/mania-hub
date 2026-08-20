import { getModAcronyms, getScoreDisplayValues, getScoreRate, getScoreTimestamp, getScoreUrl } from "./score";
import type { InsightScoreSnapshot, OsuScore, UserProfileInsights } from "./types";

function getPpDistributionStep(top: number): number {
  if (top < 250) return 50;
  if (top < 1000) return 100;
  if (top < 2000) return 250;
  return 500;
}

function getTopCountEntry(counts: Map<string, number>, total: number): { label: string; count: number; total: number } | null {
  const entries = [...counts.entries()];
  if (!entries.length) return null;

  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [label, count] = entries[0];
  return { label, count, total };
}

// Weighted median: the smallest value whose cumulative weight reaches half the
// total. Robust like the plain median (a single gimmick outlier cannot move
// it), but lets top-play decay weights concentrate the stat in the plays that
// define the profile instead of the stale tail.
function getWeightedMedian(entries: Array<{ value: number; weight: number }>): number | null {
  if (!entries.length) return null;

  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return null;

  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= totalWeight / 2) return entry.value;
  }

  return sorted[sorted.length - 1].value;
}

function getTimestampMs(score: OsuScore): number {
  const timestamp = getScoreTimestamp(score);
  return timestamp ? new Date(timestamp).getTime() : 0;
}

export function buildPpDistribution(ppValues: number[]): UserProfileInsights["ppDistribution"] {
  if (!ppValues.length) return [];

  const top = Math.max(...ppValues);
  const bottom = Math.min(...ppValues);
  const step = getPpDistributionStep(top);
  const maxThreshold = Math.max(step, Math.floor(top / step) * step);
  const minThreshold = Math.max(step, Math.floor(bottom / step) * step);
  const total = ppValues.length;
  const buckets: UserProfileInsights["ppDistribution"] = [];
  for (let threshold = maxThreshold; threshold >= minThreshold; threshold -= step) {
    const upper = threshold === maxThreshold ? null : threshold + step;
    const count = ppValues.filter((pp) => pp >= threshold && (upper == null || pp < upper)).length;
    if (count > 0) {
      buckets.push({
        min: threshold,
        max: upper == null ? null : upper - 1,
        count,
        total,
      });
    }
  }

  const belowCount = ppValues.filter((pp) => pp < minThreshold).length;
  if (belowCount > 0) {
    buckets.push({
      min: null,
      max: minThreshold - 1,
      count: belowCount,
      total,
    });
  }

  return buckets;
}

/* The cumulative ladder behind the profile's "Cumulative" pp view: how many
   top plays sit at or above each threshold, walking down from the player's
   best. Beside buildPpDistribution rather than in the profile route, because
   the dynamic render draws the same ladder and two copies of a bucketing rule
   drift the moment one of them is tuned. */
function getPpCumulativeDistributionStep(top: number): number {
  return top < 250 ? 50 : 100;
}

export interface PpCumulativeDistributionRow {
  threshold: number;
  count: number;
  total: number;
}

export function buildPpCumulativeDistribution(scores: OsuScore[]): PpCumulativeDistributionRow[] {
  const ppValues = scores
    .map((score) => score.pp)
    .filter((pp): pp is number => typeof pp === "number" && Number.isFinite(pp))
    .sort((a, b) => b - a);

  if (!ppValues.length) return [];

  const top = ppValues[0];
  const bottom = ppValues[ppValues.length - 1];
  const step = getPpCumulativeDistributionStep(top);
  const maxThreshold = Math.max(0, Math.floor(top / step) * step);
  const minThreshold = Math.max(0, Math.floor(bottom / step) * step);
  const rows: PpCumulativeDistributionRow[] = [];
  let count = 0;

  for (let threshold = maxThreshold; threshold >= minThreshold; threshold -= step) {
    while (count < ppValues.length && ppValues[count] >= threshold) {
      count += 1;
    }
    rows.push({ threshold, count, total: ppValues.length });
  }

  return rows;
}

function scoreToSnapshot(score: OsuScore): InsightScoreSnapshot {
  const display = getScoreDisplayValues(score);

  return {
    title: score.beatmapset?.title ?? "Unknown",
    artist: score.beatmapset?.artist ?? "",
    version: score.beatmap?.version ?? "",
    pp: score.pp,
    rank: display.rank,
    coverUrl: score.beatmapset?.covers?.cover ?? "",
    beatmapUrl: score.beatmap?.url ?? `https://osu.ppy.sh/b/${score.beatmap?.id ?? 0}`,
    scoreUrl: getScoreUrl(score),
    date: getScoreTimestamp(score) ?? "",
    mods: getModAcronyms(score.mods),
  };
}

export function calculateUserProfileInsights(bestScores: OsuScore[]): UserProfileInsights {
  const scores = bestScores.filter((score) => score.beatmap?.mode === "mania");
  const keyCounts = new Map<number, number>();
  const modCounts = new Map<string, number>();
  let moddedPlayCount = 0;
  const bpmEntries: Array<{ bpm: number; weight: number; keyCount: number | null; score: OsuScore }> = [];
  const ppValues: number[] = [];
  const datedScores: Array<{ score: OsuScore; ms: number }> = [];

  for (const [index, score] of scores.entries()) {
    const rawKeyCount = Number(score.beatmap?.cs);
    const normalizedKeyCount = Number.isFinite(rawKeyCount) && rawKeyCount > 0 ? Math.round(rawKeyCount) : null;
    if (normalizedKeyCount !== null) {
      keyCounts.set(normalizedKeyCount, (keyCounts.get(normalizedKeyCount) ?? 0) + 1);
    }

    const mods = getModAcronyms(score.mods);
    if (mods.length > 0) {
      moddedPlayCount++;
      for (const mod of mods) {
        modCounts.set(mod, (modCounts.get(mod) ?? 0) + 1);
      }
    }

    // Note-derived song tempo (backend chart analysis) over the osu! API's
    // nominal bpm field: the nominal value is the most-common timing point by
    // wall-clock duration and misreads marathons, intros/breaks, and
    // BPM-gimmick charts. Falls back to nominal when analysis is missing
    // (converts, brand-new maps, no live backend).
    const noteBpm = Number(score.beatmap?.note_bpm);
    const nominalBpm = Number(score.beatmap?.bpm);
    const bpm = Number.isFinite(noteBpm) && noteBpm > 0 ? noteBpm : nominalBpm;
    if (Number.isFinite(bpm) && bpm > 0) {
      // Scores arrive pp-descending, so osu!'s own top-play decay by list index
      // weights each play by how much it defines the profile.
      bpmEntries.push({ bpm: bpm * getScoreRate(score.mods), weight: 0.95 ** index, keyCount: normalizedKeyCount, score });
    }

    if (score.pp != null && score.pp > 0) {
      ppValues.push(score.pp);
    }

    const timestampMs = getTimestampMs(score);
    if (Number.isFinite(timestampMs) && timestampMs > 0) {
      datedScores.push({ score, ms: timestampMs });
    }
  }

  const sortedKeySplit = [...keyCounts.entries()]
    .map(([keyCount, count]) => ({ keyCount, count }))
    .sort((a, b) => b.count - a.count || a.keyCount - b.keyCount);
  datedScores.sort((a, b) => a.ms - b.ms);
  const sortedPpValues = [...ppValues].sort((a, b) => b - a);

  let bpmRange: UserProfileInsights["bpmRange"] = null;
  if (bpmEntries.length > 0) {
    let minEntry = bpmEntries[0];
    let maxEntry = bpmEntries[0];
    for (const entry of bpmEntries) {
      if (entry.bpm < minEntry.bpm) minEntry = entry;
      if (entry.bpm > maxEntry.bpm) maxEntry = entry;
    }
    bpmRange = {
      min: minEntry.bpm,
      max: maxEntry.bpm,
      minScore: scoreToSnapshot(minEntry.score),
      maxScore: scoreToSnapshot(maxEntry.score),
    };
  }

  const bpmByKeyMap = new Map<number, Array<{ value: number; weight: number }>>();
  for (const entry of bpmEntries) {
    if (entry.keyCount === null) continue;
    const arr = bpmByKeyMap.get(entry.keyCount);
    if (arr) arr.push({ value: entry.bpm, weight: entry.weight });
    else bpmByKeyMap.set(entry.keyCount, [{ value: entry.bpm, weight: entry.weight }]);
  }
  const bpmByKeyMode = [...bpmByKeyMap.entries()]
    .map(([keyCount, values]) => ({ keyCount, median: getWeightedMedian(values) ?? 0, count: values.length }))
    .sort((a, b) => a.keyCount - b.keyCount);

  return {
    sampleSize: scores.length,
    keySplit: sortedKeySplit,
    mostUsedMod: getTopCountEntry(modCounts, moddedPlayCount),
    modBreakdown: [...modCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count, total: scores.length })),
    medianBpm: getWeightedMedian(bpmEntries.map((entry) => ({ value: entry.bpm, weight: entry.weight }))),
    bpmRange,
    bpmByKeyMode,
    newestTopPlay: datedScores.length ? scoreToSnapshot(datedScores[datedScores.length - 1].score) : null,
    oldestTopPlay: datedScores.length ? scoreToSnapshot(datedScores[0].score) : null,
    ppRange: sortedPpValues.length
      ? {
          top: sortedPpValues[0],
          bottom: sortedPpValues[sortedPpValues.length - 1],
        }
      : null,
    ppDistribution: buildPpDistribution(sortedPpValues),
  };
}
