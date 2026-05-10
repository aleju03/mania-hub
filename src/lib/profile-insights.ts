import { getModAcronyms, getScoreDisplayValues, getScoreRate, getScoreTimestamp } from "./score";
import type { InsightScoreSnapshot, OsuScore, UserProfileInsights } from "./types";

function getTopCountEntry(counts: Map<string, number>, total: number): { label: string; count: number; total: number } | null {
  const entries = [...counts.entries()];
  if (!entries.length) return null;

  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [label, count] = entries[0];
  return { label, count, total };
}

function getMedian(values: number[]): number | null {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }

  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function getTimestampMs(score: OsuScore): number {
  const timestamp = getScoreTimestamp(score);
  return timestamp ? new Date(timestamp).getTime() : 0;
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
    date: getScoreTimestamp(score) ?? "",
    mods: getModAcronyms(score.mods),
  };
}

export function calculateUserProfileInsights(bestScores: OsuScore[]): UserProfileInsights {
  const scores = bestScores.filter((score) => score.beatmap?.mode === "mania");
  const keyCounts = new Map<number, number>();
  const modCounts = new Map<string, number>();
  let moddedPlayCount = 0;
  const bpmEntries: Array<{ bpm: number; keyCount: number | null; score: OsuScore }> = [];
  const ppValues: number[] = [];
  const datedScores: Array<{ score: OsuScore; ms: number }> = [];

  for (const score of scores) {
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

    const bpm = Number(score.beatmap?.bpm);
    if (Number.isFinite(bpm) && bpm > 0) {
      bpmEntries.push({ bpm: bpm * getScoreRate(score.mods), keyCount: normalizedKeyCount, score });
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
  const sortedPpValues = ppValues.sort((a, b) => b - a);
  const bpms = bpmEntries.map((e) => e.bpm);

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

  const bpmByKeyMap = new Map<number, number[]>();
  for (const entry of bpmEntries) {
    if (entry.keyCount === null) continue;
    const arr = bpmByKeyMap.get(entry.keyCount);
    if (arr) arr.push(entry.bpm);
    else bpmByKeyMap.set(entry.keyCount, [entry.bpm]);
  }
  const bpmByKeyMode = [...bpmByKeyMap.entries()]
    .map(([keyCount, values]) => ({ keyCount, median: getMedian(values) ?? 0, count: values.length }))
    .sort((a, b) => a.keyCount - b.keyCount);

  return {
    sampleSize: scores.length,
    keySplit: sortedKeySplit,
    mostUsedMod: getTopCountEntry(modCounts, moddedPlayCount),
    modBreakdown: [...modCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count, total: scores.length })),
    medianBpm: getMedian(bpms),
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
  };
}
