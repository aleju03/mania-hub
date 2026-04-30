import type { ManiaBeatmap, ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

export const RANDOM_REPLAY_PREVIEW_MS = 10_000;
export const RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS = 1_200;

const RANDOM_REPLAY_TAP_HOLD_MS = 48;

export function pickPreviewStartTime(primaryTimeMs: number, fallbackTimeMs = 0): number {
  if (Number.isFinite(primaryTimeMs) && primaryTimeMs > 0) return primaryTimeMs;
  if (Number.isFinite(fallbackTimeMs) && fallbackTimeMs > 0) return fallbackTimeMs;
  return 0;
}

export function getPreviewNotes(beatmap: ManiaBeatmap, startTimeMs = beatmap.previewTime, timeScale = 1): ManiaNote[] {
  const start = Math.max(0, startTimeMs || 0);
  const scale = Math.max(0.1, timeScale);
  const visualEnd = start + ((RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS) * scale);
  const playbackEnd = RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS;

  return beatmap.notes
    .filter((note) => note.endTime >= start && note.time <= visualEnd)
    .map((note) => ({
      ...note,
      time: Math.max(0, (note.time - start) / scale),
      endTime: Math.min(playbackEnd, Math.max(0, (note.endTime - start) / scale)),
    }))
    .filter((note) => note.endTime >= 0 && note.time <= playbackEnd);
}

export function getPreviewInitialCombo(beatmap: ManiaBeatmap, startTimeMs = beatmap.previewTime): number {
  const start = Math.max(0, startTimeMs || 0);
  return beatmap.notes.reduce((combo, note) => combo + (note.time < start ? 1 : 0), 0);
}

export function getPreviewScrollVelocities(beatmap: ManiaBeatmap, startTimeMs = beatmap.previewTime, timeScale = 1): ManiaBeatmap["scrollVelocities"] {
  const start = Math.max(0, startTimeMs || 0);
  const scale = Math.max(0.1, timeScale);
  const visualEnd = start + ((RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS) * scale);
  const velocities = beatmap.scrollVelocities ?? [];
  let initialMultiplier = 1;

  for (const point of velocities) {
    if (point.time > start) break;
    initialMultiplier = point.multiplier;
  }

  return [
    { time: 0, multiplier: initialMultiplier },
    ...velocities
      .filter((point) => point.time > start && point.time <= visualEnd)
      .map((point) => ({ ...point, time: (point.time - start) / scale })),
  ];
}

export function buildAutoplayFrames(notes: ManiaNote[], keyCount: number): ReplayFrame[] {
  const events: Array<{ time: number; column: number; pressed: boolean }> = [];

  for (const note of notes) {
    if (note.time > RANDOM_REPLAY_PREVIEW_MS) continue;
    const column = Math.max(0, Math.min(keyCount - 1, note.column));
    const start = Math.max(0, Math.round(note.time));
    const end = Math.max(start + 1, Math.round(note.isHold ? note.endTime : note.time + RANDOM_REPLAY_TAP_HOLD_MS));
    events.push({ time: start, column, pressed: true });
    events.push({ time: Math.min(RANDOM_REPLAY_PREVIEW_MS, end), column, pressed: false });
  }

  events.sort((a, b) => a.time - b.time || (a.pressed === b.pressed ? 0 : a.pressed ? -1 : 1));

  const frames: ReplayFrame[] = [{ time: 0, keyState: 0 }];
  let keyState = 0;
  let i = 0;
  while (i < events.length) {
    const time = events[i].time;
    while (i < events.length && events[i].time === time) {
      const bit = 1 << events[i].column;
      keyState = events[i].pressed ? keyState | bit : keyState & ~bit;
      i++;
    }
    frames.push({ time, keyState });
  }
  frames.push({ time: RANDOM_REPLAY_PREVIEW_MS, keyState: 0 });
  return frames;
}
