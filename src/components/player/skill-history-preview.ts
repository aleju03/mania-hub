import type { LivePlayerSkillHistoryEntry, LivePlayerSkillHistorySnapshot } from "../../lib/live-backend";

/** Local preview only: walk backwards from the player's current rating, with
 * small session gains, occasional drops, and a change to an individual axis. */
export function makeSkillHistoryPreview(keyCount: number, seed?: LivePlayerSkillHistorySnapshot): LivePlayerSkillHistoryEntry[] {
  const patternMode = [6, 7, 8].includes(keyCount);
  let current: LivePlayerSkillHistorySnapshot = seed ?? {
    ratings: patternMode
      ? { Overall: 25.7, "pattern:ln": 25.42, "pattern:tech": 22.74, "pattern:jack": 22.17 }
      : { Overall: 28.6, Stream: 27.8, Jumpstream: 28.4, Technical: 26.9 },
    dan: { rc: null, ln: null },
  };
  const axes = Object.keys(current.ratings).filter((axis) => axis !== "Overall");
  const deltas = [0.07, 0.02, -0.03, 0.12, 0, 0.01, 0.09, 0.04, -0.02, 0.15, 0.03, 0.07];
  const hoursAgo = [0.4, 5.2, 23, 48.7, 75.2, 121, 170.6, 216, 267.4, 337, 411.2, 490, 552];
  const now = Date.now();
  const items: LivePlayerSkillHistoryEntry[] = [];
  const round = (value: number) => Math.max(0, Number(value.toFixed(2)));
  for (let i = 0; i <= deltas.length; i += 1) {
    const previous: LivePlayerSkillHistorySnapshot | null = i < deltas.length ? {
      ratings: { ...current.ratings, Overall: round(current.ratings.Overall - deltas[i]) },
      dan: { ...current.dan },
    } : null;
    if (previous && axes.length > 0) {
      const axis = axes[i % axes.length];
      previous.ratings[axis] = round(current.ratings[axis] - (deltas[i] || 0.04) * 1.8);
      if (i % 3 === 0 && axes.length > 1) {
        const second = axes[(i + 1) % axes.length];
        previous.ratings[second] = round(current.ratings[second] - deltas[i] * 0.7);
      }
    }
    items.push({ id: -(i + 1), recordedAt: new Date(now - hoursAgo[i] * 3_600_000).toISOString(), version: 0, snapshot: current, previous });
    if (previous) current = previous;
  }
  return items;
}
