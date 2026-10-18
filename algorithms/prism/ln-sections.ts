import type { ManiaNote } from "../chart/beatmap";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { readEffectiveHolds } from "../dan-estimator/ln-effective";

export const PRISM_LN_SECTION_WINDOW_MS = 15_000;
export const PRISM_LN_SECTION_STEP_MS = 1_000;

export const PRISM_LN_SECTION_MIN_NOTES_PER_SECOND = 1;

export const PRISM_LN_SECTION_MIN_MS = 30_000;

export function prismLnSectionLine(keyCount: number): number {
  return lnPrimaryMinRatioFor(keyCount);
}

export function prismLnSpans(notes: readonly ManiaNote[], keyCount: number, od?: number | null): Array<[number, number]> {
  const effective = od != null && Number.isFinite(od)
    ? readEffectiveHolds(notes as ManiaNote[], { rate: 1, od, keyCount }, { weights: false }).mask : null;
  const valid: Array<{ time: number; hold: boolean }> = [];
  notes.forEach((note, index) => {
    if (!Number.isInteger(note.column) || note.column < 0 || note.column >= keyCount || !Number.isFinite(note.time)) return;
    valid.push({ time: note.time, hold: note.isHold && note.endTime > note.time && (effective == null || effective[index] === true) });
  });
  if (valid.length === 0) return [];
  valid.sort((a, b) => a.time - b.time);
  const origin = valid[0].time;
  const last = valid[valid.length - 1].time - origin;
  const line = prismLnSectionLine(keyCount);
  const minNotes = (PRISM_LN_SECTION_WINDOW_MS / 1000) * PRISM_LN_SECTION_MIN_NOTES_PER_SECOND;
  const spans: Array<[number, number]> = [];
  let total = 0;
  let lo = 0, hi = 0, count = 0, holds = 0;
  for (let step = 0; step * PRISM_LN_SECTION_STEP_MS <= last; step += 1) {
    const start = step * PRISM_LN_SECTION_STEP_MS;
    const centre = start + PRISM_LN_SECTION_STEP_MS / 2;
    const from = centre - PRISM_LN_SECTION_WINDOW_MS / 2, to = centre + PRISM_LN_SECTION_WINDOW_MS / 2;
    while (hi < valid.length && valid[hi].time - origin < to) { count += 1; if (valid[hi].hold) holds += 1; hi += 1; }
    while (lo < hi && valid[lo].time - origin < from) { count -= 1; if (valid[lo].hold) holds -= 1; lo += 1; }
    if (count < minNotes || holds / count < line) continue;
    const end = start + PRISM_LN_SECTION_STEP_MS;
    const open = spans[spans.length - 1];
    if (open && open[1] === start) open[1] = end;
    else spans.push([start, end]);
    total += PRISM_LN_SECTION_STEP_MS;
  }
  return total >= PRISM_LN_SECTION_MIN_MS ? spans : [];
}
