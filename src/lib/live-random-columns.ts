import type { ManiaNote } from "#/lib/beatmap-parser";
import type { ReplayFrame } from "#/lib/types";

/*
 * A stable Random play shuffles the chart's columns once, by a seed the live
 * stream cannot read. The shuffle shows in the presses, though: each column's
 * notes are hit in one column of the keyboard. This finds that column
 * assignment from the play so far.
 */

/** How close a press must be to a note to count as hitting it. */
const MATCH_MS = 120;
/** Notes the play must have passed before the guess is trusted. */
const MIN_NOTES = 24;
/** Of those, the share the best assignment must explain. */
const MIN_SHARE = 0.6;

function pressStartsByColumn(frames: ReplayFrame[], keyCount: number): number[][] {
  const starts: number[][] = Array.from({ length: keyCount }, () => []);
  let previous = 0;
  for (const frame of frames) {
    const pressed = frame.keyState & ~previous;
    for (let column = 0; column < keyCount; column++) {
      if (pressed & (1 << column)) starts[column].push(frame.time);
    }
    previous = frame.keyState;
  }
  return starts;
}

/** How far the press nearest `time` in this column is, or Infinity. */
function nearestPress(sorted: number[], time: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < sorted.length ? sorted[lo] - time : Infinity;
  const before = lo > 0 ? time - sorted[lo - 1] : Infinity;
  return Math.min(after, before);
}

/** Two presses this close are one chord, not one press and a neighbour's. */
const CHORD_MS = 18;

/**
 * The column each chart column was moved to (`map[original] = shown`), or
 * null while the presses do not settle it yet.
 */
export function inferRandomColumnMap(notes: ManiaNote[], frames: ReplayFrame[], keyCount: number): number[] | null {
  if (frames.length === 0 || keyCount < 2) return null;
  const until = frames[frames.length - 1].time - MATCH_MS;
  const presses = pressStartsByColumn(frames, keyCount);
  const score = Array.from({ length: keyCount }, () => new Array<number>(keyCount).fill(0));
  let seen = 0;
  for (const note of notes) {
    if (note.time > until) break;
    seen += 1;
    // Credit the column whose press is nearest the note; a dense chart puts
    // the next note's press within reach too, and that one is further off.
    const distance = presses.map((column) => nearestPress(column, note.time));
    const nearest = Math.min(...distance);
    if (nearest > MATCH_MS) continue;
    for (let shown = 0; shown < keyCount; shown++) {
      if (distance[shown] <= nearest + CHORD_MS) score[note.column][shown] += 1;
    }
  }
  if (seen < MIN_NOTES) return null;

  // Best assignment: exhaustive up to 8 keys, greedy past that.
  let best: number[] | null = null;
  let bestScore = -1;
  if (keyCount <= 8) {
    const used = new Array<boolean>(keyCount).fill(false);
    const current: number[] = [];
    const walk = (column: number, total: number) => {
      if (column === keyCount) {
        if (total > bestScore) {
          bestScore = total;
          best = [...current];
        }
        return;
      }
      for (let shown = 0; shown < keyCount; shown++) {
        if (used[shown]) continue;
        used[shown] = true;
        current.push(shown);
        walk(column + 1, total + score[column][shown]);
        current.pop();
        used[shown] = false;
      }
    };
    walk(0, 0);
  } else {
    const pairs: Array<[number, number, number]> = [];
    for (let column = 0; column < keyCount; column++) {
      for (let shown = 0; shown < keyCount; shown++) pairs.push([score[column][shown], column, shown]);
    }
    pairs.sort((a, b) => b[0] - a[0]);
    const map = new Array<number>(keyCount).fill(-1);
    const taken = new Set<number>();
    bestScore = 0;
    for (const [value, column, shown] of pairs) {
      if (map[column] !== -1 || taken.has(shown)) continue;
      map[column] = shown;
      taken.add(shown);
      bestScore += value;
    }
    best = map;
  }
  return best && bestScore >= seen * MIN_SHARE ? best : null;
}
