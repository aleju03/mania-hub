import type { ManiaNote } from "../beatmap-parser.js";

export const LN_TIMELINE_VERSION = 1;
export type Lane4K = 0 | 1 | 2 | 3;
export type Hand4K = 0 | 1;
export type HandMapping4K = readonly [Hand4K, Hand4K, Hand4K, Hand4K];
export const DEFAULT_LN_HANDS: HandMapping4K = [0, 0, 1, 1];

export interface LnScoringProfile {
  client: "stable" | "lazer" | "stable-scorev2";
  od: number;
  windowScale: number;
  accuracyGoal: number;
}

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
  heldBeforeMask: number;
  heldAfterMask: number;
  tapIds: number[];
  headIds: number[];
  tailIds: number[];
}

export interface LnTimelineDiagnostic {
  code: "invalid_time" | "invalid_lane" | "invalid_hold_length" | "duplicate_object" | "same_lane_overlap" | "tap_inside_hold";
  objectIds: number[];
  severity: "error" | "warning";
}

export interface LnTimeline4K {
  version: number;
  valid: boolean;
  originMs: number;
  playbackRate: number;
  hands: HandMapping4K;
  scoring: LnScoringProfile;
  /** Real playback milliseconds relative to originMs; never scaled twice. */
  durationMs: number;
  objects: LnChartObject[];
  rows: LnEventRow4K[];
  diagnostics: LnTimelineDiagnostic[];
  cacheKey: string;
}

/** Portable 64-bit FNV-1a cache fingerprint; not an authentication hash. */
export function lnFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function buildLnTimeline4K(
  notes: readonly ManiaNote[],
  options: { rate?: number; hands?: HandMapping4K; scoring?: Partial<LnScoringProfile> } = {},
): LnTimeline4K {
  const playbackRate = options.rate ?? 1;
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) throw new Error("LN playback rate must be positive and finite");
  const hands = options.hands ?? DEFAULT_LN_HANDS;
  if (hands.length !== 4 || hands.filter((hand) => hand === 0).length !== 2 || hands.filter((hand) => hand === 1).length !== 2) {
    throw new Error("The 4K LN hand mapping must assign two lanes to each hand");
  }
  const scoring: LnScoringProfile = {
    client: options.scoring?.client ?? "lazer",
    od: options.scoring?.od ?? 8,
    windowScale: options.scoring?.windowScale ?? 1,
    accuracyGoal: options.scoring?.accuracyGoal ?? 0.93,
  };
  if (!Number.isFinite(scoring.od) || scoring.od < 0 || scoring.od > 10
    || !["stable", "lazer", "stable-scorev2"].includes(scoring.client)
    || !Number.isFinite(scoring.windowScale) || scoring.windowScale <= 0
    || !Number.isFinite(scoring.accuracyGoal) || scoring.accuracyGoal < 0 || scoring.accuracyGoal > 1) {
    throw new Error("Invalid LN scoring profile");
  }
  const diagnostics: LnTimelineDiagnostic[] = [];
  const finite = notes.map((note, id) => ({ note, id })).filter(({ note, id }) => {
    if (!Number.isInteger(note.column) || note.column < 0 || note.column > 3) {
      diagnostics.push({ code: "invalid_lane", objectIds: [id], severity: "error" });
      return false;
    }
    if (!Number.isFinite(note.time) || (note.isHold && !Number.isFinite(note.endTime))) {
      diagnostics.push({ code: "invalid_time", objectIds: [id], severity: "error" });
      return false;
    }
    if (note.isHold && note.endTime <= note.time) {
      diagnostics.push({ code: "invalid_hold_length", objectIds: [id], severity: "error" });
      return false;
    }
    return true;
  }).sort((a, b) => a.note.time - b.note.time || a.note.column - b.note.column || a.note.endTime - b.note.endTime);
  const originMs = finite[0]?.note.time ?? 0;
  const objects: LnChartObject[] = [];
  const seen = new Map<string, number>();
  const starts = new Map<string, number>();
  const lastHold: Array<LnChartObject & { kind: "hold" } | undefined> = [];
  for (const { note, id } of finite) {
    const lane = note.column as Lane4K;
    const startMs = (note.time - originMs) / playbackRate;
    const object: LnChartObject = note.isHold
      ? { id, lane, startMs, endMs: (note.endTime - originMs) / playbackRate, kind: "hold" }
      : { id, lane, startMs, kind: "tap" };
    const key = `${lane}:${startMs}:${object.kind}:${object.kind === "hold" ? object.endMs : ""}`;
    const duplicate = seen.get(key);
    if (duplicate != null) {
      diagnostics.push({ code: "duplicate_object", objectIds: [duplicate, id], severity: "error" });
      continue;
    }
    seen.set(key, id);
    const startKey = `${lane}:${startMs}`;
    const sharedStart = starts.get(startKey);
    if (sharedStart != null) {
      diagnostics.push({ code: "same_lane_overlap", objectIds: [sharedStart, id], severity: "error" });
      continue;
    }
    starts.set(startKey, id);
    const occupied = lastHold[lane];
    if (occupied && occupied.endMs > startMs) {
      diagnostics.push({ code: object.kind === "hold" ? "same_lane_overlap" : "tap_inside_hold",
        objectIds: [occupied.id, id], severity: "error" });
      continue;
    }
    if (object.kind === "hold") lastHold[lane] = object;
    objects.push(object);
  }

  const rowMap = new Map<number, LnEventRow4K>();
  const at = (timeMs: number) => {
    let row = rowMap.get(timeMs);
    if (!row) {
      row = { timeMs, tapMask: 0, holdHeadMask: 0, holdTailMask: 0, heldBeforeMask: 0, heldAfterMask: 0,
        tapIds: [], headIds: [], tailIds: [] };
      rowMap.set(timeMs, row);
    }
    return row;
  };
  let durationMs = 0;
  for (const object of objects) {
    const row = at(object.startMs);
    if (object.kind === "tap") { row.tapMask |= 1 << object.lane; row.tapIds.push(object.id); }
    else {
      row.holdHeadMask |= 1 << object.lane;
      row.headIds.push(object.id);
      const tail = at(object.endMs);
      tail.holdTailMask |= 1 << object.lane;
      tail.tailIds.push(object.id);
    }
    durationMs = Math.max(durationMs, object.kind === "hold" ? object.endMs : object.startMs);
  }
  const rows = [...rowMap.values()].sort((a, b) => a.timeMs - b.timeMs);
  let held = 0;
  for (const row of rows) {
    row.heldBeforeMask = held;
    held = ((held & ~row.holdTailMask) | row.holdHeadMask) & 15;
    row.heldAfterMask = held;
  }
  const identity = JSON.stringify({ version: LN_TIMELINE_VERSION, rate: playbackRate, hands, scoring,
    objects: objects.map((object) => [object.lane, object.kind, object.startMs, object.kind === "hold" ? object.endMs : null]),
    invalid: diagnostics.map((diagnostic) => diagnostic.code).sort() });
  return { version: LN_TIMELINE_VERSION, valid: diagnostics.length === 0, originMs, playbackRate,
    hands: [...hands] as unknown as HandMapping4K, scoring, durationMs, objects, rows, diagnostics,
    cacheKey: `ln-timeline:${LN_TIMELINE_VERSION}:${lnFingerprint(identity)}` };
}
