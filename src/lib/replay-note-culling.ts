import type { ManiaNote } from "./beatmap-parser";
import type { ReplayNoteState } from "#replay-judge/mania-replay-judgement";

export const REPLAY_NOTE_BLOCK_SIZE = 64;

/**
 * A chart-wide long hold extends the renderer's candidate scan far into the
 * past. These small blocks let it skip expired stretches while keeping note
 * order. Judgement times matter too: a hold with a pending tail can still be
 * attached to the receptor even after its chart end has scrolled offscreen.
 */
export function buildReplayNoteBlockEndTimes(
  notes: readonly ManiaNote[],
  states: readonly (Pick<ReplayNoteState, "headTime" | "tailTime"> | undefined)[],
): Float64Array {
  const ends = new Float64Array(Math.ceil(notes.length / REPLAY_NOTE_BLOCK_SIZE)).fill(-Infinity);
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    const state = states[index];
    const block = Math.floor(index / REPLAY_NOTE_BLOCK_SIZE);
    ends[block] = Math.max(ends[block], note.time, note.endTime, state?.headTime ?? -Infinity, state?.tailTime ?? -Infinity);
  }
  return ends;
}
