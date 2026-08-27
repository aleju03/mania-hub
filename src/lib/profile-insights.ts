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

/* Cumulative pp per keymode, the number osu! publishes for 4K and 7K and for
   nothing else. Each keymode's plays are weighted against their own list
   (pp * 0.95^i re-indexed inside the keymode), which is what makes a 5K total
   comparable to the 4K one on someone's osu! profile rather than to their
   share of it.

   Checked against osu!'s own 4K/7K figures over 1.5k stored profiles: on
   keymodes the window covers, this lands within a couple of pp of official
   once the play-count bonus is set aside. Two rules earn that:

   - Converts are out. osu! grows its keymode statistics from natively-mania
     maps only, so a 7K convert of a std map counts toward mania pp and toward
     no keymode. Counting them read 3x over official for players who farm
     converts.
   - Bonus pp is out. osu! adds 416.67 * (1 - 0.9994^n) per keymode, where n
     is that keymode's own ranked-score count. The window shows plays, not
     that count, and estimating it from the window's share overshot small
     keymodes by 120-250pp, so these totals leave it out and say so. */
const KEY_PP_DECAY = 0.95;
/* osu! caps its best-scores endpoint at 200. A window at or above this many
   plays is a cut of a longer list, so plays below its weakest one exist and
   are invisible. Below it, the window is everything the player has. */
const KEY_PP_WINDOW_MIN = 100;
/* How long one keymode's own list may get once tracked plays are folded in.
   Same 200 the window carries, except each keymode now gets its own instead of
   sharing one budget with every keymode the player touches. Past it the 0.95
   decay leaves a play worth under 0.004% of its face value. */
export const KEY_PP_LIST_LIMIT = 200;

/** One play in a keymode's list. The beatmap id is what dedupes the tracked
    tail against the window, since both can hold the same map. */
interface KeyPpPlay {
  beatmapId: number;
  pp: number;
}

/** A play this site tracked, as the live backend serves it. Display fields
    ride along for the per-keymode list and are not read here. */
export interface KeyPpTrackedPlay {
  beatmapId: number;
  keyCount: number;
  pp: number;
}

function getKeyPpWeightedTotal(plays: KeyPpPlay[]): number {
  return plays.reduce((total, play, index) => total + play.pp * KEY_PP_DECAY ** index, 0);
}

/* Every play the window hides is worth less than its cutoff and lands at index
   count or later, so the geometric tail bounds the whole missing remainder. */
function getKeyPpMissingBound(count: number, cutoffPp: number): number {
  if (cutoffPp <= 0) return 0;
  return (cutoffPp * KEY_PP_DECAY ** count) / (1 - KEY_PP_DECAY);
}

function sortKeyPpPlays(plays: KeyPpPlay[]): KeyPpPlay[] {
  return [...plays].sort((a, b) => b.pp - a.pp || a.beatmapId - b.beatmapId);
}

function buildKeyPpBuckets(
  windowByKeyCount: Map<number, KeyPpPlay[]>,
  trackedByKeyCount: Map<number, KeyPpPlay[]>,
  cutoffPp: number,
): UserProfileInsights["keyPp"] {
  const keyCounts = new Set([...windowByKeyCount.keys(), ...trackedByKeyCount.keys()]);
  return [...keyCounts]
    .map((keyCount) => {
      const windowPlays = windowByKeyCount.get(keyCount) ?? [];
      const inWindow = new Set(windowPlays.map((play) => play.beatmapId));
      // The same map can sit in both: the window carries the play osu! ranks,
      // and the tail carries whatever the ingest last saw on it. The window
      // wins, so a map is never counted twice.
      const tracked = (trackedByKeyCount.get(keyCount) ?? []).filter((play) => !inWindow.has(play.beatmapId));
      const trackedIds = new Set(tracked.map((play) => play.beatmapId));
      const merged = sortKeyPpPlays([...windowPlays, ...tracked]).slice(0, KEY_PP_LIST_LIMIT);
      return {
        keyCount,
        weightedPp: getKeyPpWeightedTotal(merged),
        count: merged.length,
        trackedCount: merged.filter((play) => trackedIds.has(play.beatmapId)).length,
        /* Measured from the window alone, on purpose. A play the ingest never
           saw is only known to be below the window's cutoff, so in the worst
           case it outranks every tracked play and lands right behind the window
           ones. Folding the tail in raises the total; it does not narrow what
           is still unseen. */
        missingBound: getKeyPpMissingBound(windowPlays.length, cutoffPp),
      };
    })
    .sort((a, b) => b.weightedPp - a.weightedPp || a.keyCount - b.keyCount);
}

/**
 * The window's own key-pp plays, grouped by keymode.
 *
 * Shared by the totals and by the per-keymode list so the two can never
 * disagree about what the window holds or how it is ordered.
 */
function collectWindowKeyPpPlays(bestScores: OsuScore[]): { byKeyCount: Map<number, KeyPpPlay[]>; converts: number } {
  const byKeyCount = new Map<number, KeyPpPlay[]>();
  let converts = 0;
  bestScores
    .filter((score) => score.beatmap?.mode === "mania")
    .forEach((score, index) => {
      if (score.pp == null || score.pp <= 0) return;
      if (score.beatmap?.convert) {
        converts++;
        return;
      }
      const rawKeyCount = Number(score.beatmap?.cs);
      if (!Number.isFinite(rawKeyCount) || rawKeyCount <= 0) return;
      const keyCount = Math.round(rawKeyCount);
      // A window play with no beatmap id gets a negative one: unique, and it
      // can never collide with a tracked play's id during the merge.
      const rawBeatmapId = Number(score.beatmap?.id);
      const beatmapId = Number.isSafeInteger(rawBeatmapId) && rawBeatmapId > 0 ? rawBeatmapId : -(index + 1);
      const play = { beatmapId, pp: score.pp };
      const bucket = byKeyCount.get(keyCount);
      if (bucket) bucket.push(play);
      else byKeyCount.set(keyCount, [play]);
    });
  return { byKeyCount, converts };
}

/** Tracked plays grouped by keymode, cheapest-to-merge shape. */
function groupTrackedKeyPpPlays(plays: KeyPpTrackedPlay[]): Map<number, KeyPpPlay[]> {
  const byKeyCount = new Map<number, KeyPpPlay[]>();
  for (const play of plays) {
    const keyCount = Math.round(Number(play.keyCount));
    const pp = Number(play.pp);
    const beatmapId = Number(play.beatmapId);
    if (!Number.isFinite(keyCount) || keyCount <= 0) continue;
    if (!Number.isFinite(pp) || pp <= 0) continue;
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    const bucket = byKeyCount.get(keyCount);
    if (bucket) bucket.push({ beatmapId, pp });
    else byKeyCount.set(keyCount, [{ beatmapId, pp }]);
  }
  return byKeyCount;
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
    stars: Number.isFinite(score.beatmap?.difficulty_rating) ? score.beatmap!.difficulty_rating : null,
    rank: display.rank,
    coverUrl: score.beatmapset?.covers?.cover ?? "",
    beatmapUrl: score.beatmap?.url ?? `https://osu.ppy.sh/b/${score.beatmap?.id ?? 0}`,
    scoreUrl: getScoreUrl(score),
    date: getScoreTimestamp(score) ?? "",
    mods: getModAcronyms(score.mods),
  };
}

export function calculateUserProfileInsights(
  bestScores: OsuScore[],
  /* Plays this site tracked below the window, from the live backend. Left out
     (an untracked country, no backend configured, a failed call) the totals are
     exactly the window-only ones this used to return. */
  tracked: { plays: KeyPpTrackedPlay[]; trackedFrom?: string | null } = { plays: [] },
): UserProfileInsights {
  const scores = bestScores.filter((score) => score.beatmap?.mode === "mania");
  const keyCounts = new Map<number, number>();
  const { byKeyCount: keyPpValues, converts: convertPlays } = collectWindowKeyPpPlays(scores);
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

  const keyPpCutoff = scores.length >= KEY_PP_WINDOW_MIN && sortedPpValues.length
    ? sortedPpValues[sortedPpValues.length - 1]
    : 0;

  const keyPp = buildKeyPpBuckets(keyPpValues, groupTrackedKeyPpPlays(tracked.plays), keyPpCutoff);

  return {
    sampleSize: scores.length,
    keySplit: sortedKeySplit,
    keyPp,
    keyPpConverts: convertPlays,
    keyPpCutoff,
    keyPpTracked: keyPp.reduce((total, bucket) => total + bucket.trackedCount, 0),
    keyPpTrackedFrom: tracked.trackedFrom ?? null,
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
