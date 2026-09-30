import type { ManiaNote } from "../chart/beatmap";

export type Lane4K = 0 | 1 | 2 | 3;

export type LnChartObject = {
  id: number;
  lane: Lane4K;
  startMs: number;
} & ({ kind: "tap" } | { kind: "hold"; endMs: number });

export interface LnEventRow4K {
  timeMs: number;
  tapMask: number;
  holdHeadMask: number;
  holdTailMask: number;
  tapIds: number[];
  headIds: number[];
  tailIds: number[];
}

export interface LnTimelineDiagnostic {
  code: "invalid_time" | "invalid_lane" | "invalid_hold_length" | "duplicate_object" | "same_lane_overlap" | "tap_inside_hold";
  objectIds: number[];
}

export interface LnTimeline4K {
  valid: boolean;
  playbackRate: number;
  /** Object ids are indices into the notes; times are played ms from the first note. */
  objects: LnChartObject[];
  rows: LnEventRow4K[];
  diagnostics: LnTimelineDiagnostic[];
}

/**
 * A 4K chart as rows of simultaneous heads, tails and taps at the played rate.
 * Malformed, duplicate and overlapping objects are diagnosed and dropped, and
 * any diagnosis makes the timeline invalid rather than manufacturing strain.
 */
export function buildLnTimeline4K(notes: readonly ManiaNote[], rate = 1): LnTimeline4K {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("LN playback rate must be positive and finite");
  const diagnostics: LnTimelineDiagnostic[] = [];
  const finite = notes.map((note, id) => ({ note, id })).filter(({ note, id }) => {
    const code = !Number.isInteger(note.column) || note.column < 0 || note.column > 3 ? "invalid_lane"
      : !Number.isFinite(note.time) || (note.isHold && !Number.isFinite(note.endTime)) ? "invalid_time"
        : note.isHold && note.endTime <= note.time ? "invalid_hold_length" : null;
    if (code) diagnostics.push({ code, objectIds: [id] });
    return code == null;
  }).sort((a, b) => a.note.time - b.note.time || a.note.column - b.note.column || a.note.endTime - b.note.endTime);

  const originMs = finite[0]?.note.time ?? 0;
  const objects: LnChartObject[] = [];
  // Objects sharing a lane and start sit together in time order: the first
  // is kept, an exact copy is a duplicate, anything else overlaps it.
  const sameStart: Array<{ startMs: number; objects: LnChartObject[] }> = [];
  const lastHold: Array<LnChartObject & { kind: "hold" } | undefined> = [];
  for (const { note, id } of finite) {
    const lane = note.column as Lane4K;
    const startMs = (note.time - originMs) / rate;
    const object: LnChartObject = note.isHold
      ? { id, lane, startMs, endMs: (note.endTime - originMs) / rate, kind: "hold" }
      : { id, lane, startMs, kind: "tap" };
    if (sameStart[lane]?.startMs !== startMs) sameStart[lane] = { startMs, objects: [] };
    const group = sameStart[lane].objects;
    const duplicate = group.find((other) => other.kind === object.kind && (other.kind === "tap" || other.endMs === (object as { endMs: number }).endMs));
    if (duplicate) {
      diagnostics.push({ code: "duplicate_object", objectIds: [duplicate.id, id] });
      continue;
    }
    group.push(object);
    const occupied = lastHold[lane];
    const code = group.length > 1 ? "same_lane_overlap"
      : occupied && occupied.endMs > startMs ? (object.kind === "hold" ? "same_lane_overlap" : "tap_inside_hold") : null;
    if (code) {
      diagnostics.push({ code, objectIds: [group.length > 1 ? group[0].id : occupied!.id, id] });
      continue;
    }
    if (object.kind === "hold") lastHold[lane] = object;
    objects.push(object);
  }

  const rowAt = new Map<number, LnEventRow4K>();
  const at = (timeMs: number) => {
    let row = rowAt.get(timeMs);
    if (!row) rowAt.set(timeMs, row = { timeMs, tapMask: 0, holdHeadMask: 0, holdTailMask: 0, tapIds: [], headIds: [], tailIds: [] });
    return row;
  };
  for (const object of objects) {
    const row = at(object.startMs), bit = 1 << object.lane;
    if (object.kind === "tap") { row.tapMask |= bit; row.tapIds.push(object.id); continue; }
    row.holdHeadMask |= bit;
    row.headIds.push(object.id);
    const tail = at(object.endMs);
    tail.holdTailMask |= bit;
    tail.tailIds.push(object.id);
  }
  const rows = [...rowAt.values()].sort((a, b) => a.timeMs - b.timeMs);
  return { valid: diagnostics.length === 0, playbackRate: rate, objects, rows, diagnostics };
}
