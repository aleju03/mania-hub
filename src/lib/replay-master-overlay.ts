// Visualization adapted from Mania Replay Master (Apache-2.0).
// Copyright (c) 2020-present, project contributors.
// https://github.com/Mania-Visualization-Project/Mania-Replay-Master
// Ported to a seekable Pixi drawing layer; judgements come from Mania Hub.
// License: public/licenses/mania-replay-master.txt
import type { ManiaNote } from "./beatmap-parser";
import type { Judgment, ReplayNoteState, ReplaySegment } from "./mania-replay-judgement";
import { REPLAY_MASTER_MIN_SCROLL_SPEED, normalizeReplayMasterScrollSpeed } from "./replay-overlays";

export const REPLAY_MASTER_COLORS: Record<Judgment, string> = {
  0: "#646464", 1: "#ffffff", 2: "#ffd237", 3: "#79d020",
  4: "#1e68c5", 5: "#e1349b", 6: "#ff0000",
};

interface MasterShape {
  column: number;
  start: number;
  end: number;
  kind: "note" | "press" | "release" | "hold";
  judgment: Judgment;
}

export interface ReplayMasterTimeline {
  shapes: MasterShape[];
  maxEnds: number[];
}

// Locate an actual input, never turn a miss timeout into a fictional press.
function segmentAt(segments: ReplaySegment[], time: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].end < time) lo = mid + 1;
    else hi = mid;
  }
  return lo < segments.length && (segments[lo].startPrevious ?? segments[lo].start) <= time ? lo : -1;
}

export function buildReplayMasterTimeline(
  notes: ManiaNote[],
  states: ReplayNoteState[],
  segments: ReplaySegment[][],
  rate: number,
): ReplayMasterTimeline {
  const shapes: MasterShape[] = [];
  const actions = segments.map((column, columnIndex) => column.map((segment) => ({
    column: columnIndex,
    start: segment.start,
    end: segment.end,
    head: 6 as Judgment,
    tail: 6 as Judgment,
    hold: false,
  })));
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const state = states[i];
    const column = segments[note.column];
    if (!state || !column) continue;
    shapes.push({
      column: note.column,
      start: note.time,
      end: note.isHold ? note.endTime : note.time,
      kind: "note",
      judgment: state.headJudgment,
    });
    const releaseIndex = state.releaseTime !== 0 ? segmentAt(column, state.releaseTime) : -1;
    const headIndex = state.stableMatchedSegmentIndex
      ?? (state.heldSegments?.length ? segmentAt(column, state.heldSegments[0].start)
        // Tap releaseTime is the raw segment end even when the judged head
        // was interpolated before the first recorded pressed frame.
        : !note.isHold && column[releaseIndex]?.end === state.releaseTime ? releaseIndex
          : state.releaseTime !== 0 ? segmentAt(column, state.headTime) : -1);
    const head = actions[note.column][headIndex];
    if (head) {
      head.head = state.headJudgment;
      head.hold ||= note.isHold;
    }
    if (!note.isHold) continue;
    // Re-grabs and early/late releases retain their raw recorded positions.
    for (const held of state.heldSegments ?? []) {
      const index = segmentAt(column, held.start);
      const action = actions[note.column][index];
      if (action) action.hold = true;
    }
    const tailIndex = state.stableTailSegmentIndex ?? releaseIndex;
    const tail = actions[note.column][tailIndex];
    if (tail) {
      tail.hold = true;
      tail.tail = state.tailJudgment ?? state.displayJudgment;
    }
    // Separate-head/tail rulesets do not expose heldSegments. All raw
    // re-grabs between the matched head and release still need their trails.
    if (headIndex >= 0 && tailIndex >= headIndex) {
      for (let index = headIndex; index <= tailIndex; index++) {
        actions[note.column][index].hold = true;
      }
    }
  }
  for (const column of actions) {
    for (const action of column) {
      shapes.push({ column: action.column, start: action.start, end: action.start, kind: "press", judgment: action.head });
      if (!action.hold) continue;
      shapes.push({ column: action.column, start: action.end, end: action.end, kind: "release", judgment: action.tail });
      shapes.push({ column: action.column, start: action.start, end: action.end, kind: "hold", judgment: 0 });
    }
  }
  shapes.sort((a, b) => a.start - b.start);
  let maxEnd = -Infinity;
  // Index enough padding for fixed-height marks at the slowest supported
  // scroll speed. Speed changes can reuse the timeline without rejudging.
  const markPadding = (40 / 1.2) * rate / REPLAY_MASTER_MIN_SCROLL_SPEED;
  const maxEnds = shapes.map((shape) => (maxEnd = Math.max(maxEnd, shape.end + markPadding)));
  return { shapes, maxEnds };
}

export type ReplayMasterDrawRect = (x: number, y: number, width: number, height: number, color: string) => void;

export function drawReplayMasterTimeline(
  timeline: ReplayMasterTimeline,
  time: number,
  rate: number,
  keyCount: number,
  width: number,
  height: number,
  draw: ReplayMasterDrawRect,
  scrollSpeed = 1,
): void {
  // Match the reference's 540x960 panel, constant-time scroll and geometry.
  // It previews the annotated replay ahead of the current time at the bottom.
  const scale = height / 960;
  const pixelsPerMs = 1.2 * scale * normalizeReplayMasterScrollSpeed(scrollSpeed) / rate;
  const maxTime = time + height / pixelsPerMs;
  const columnWidth = width / keyCount;
  const stroke = 5 * scale;
  const actionHeight = 7 * scale;
  const yAt = (at: number) => height - (at - time) * pixelsPerMs;
  const clipped = (x: number, y: number, w: number, h: number, color: string) => {
    const top = Math.max(0, y);
    const bottom = Math.min(height, y + h);
    if (bottom > top) draw(x, top, w, bottom - top, color);
  };
  let lo = 0;
  let hi = timeline.maxEnds.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline.maxEnds[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  // Outlines first, then input bars/trails, as in the original renderer.
  for (const notesPass of [true, false]) {
    for (let i = lo; i < timeline.shapes.length; i++) {
      const shape = timeline.shapes[i];
      if (shape.start > maxTime) break;
      if ((shape.kind === "note") !== notesPass) continue;
      const color = REPLAY_MASTER_COLORS[shape.judgment];
      const x = shape.column * columnWidth;
      const bottom = yAt(shape.start);
      const markHeight = shape.kind === "note" ? 40 * scale : shape.kind === "hold" ? 0 : actionHeight;
      const top = Math.min(yAt(shape.end), bottom - markHeight);
      if (top >= height) continue;
      if (shape.kind === "note") {
        const left = x + columnWidth * 0.1;
        const w = columnWidth * 0.8;
        clipped(left, top, w, stroke, color);
        clipped(left, bottom - stroke, w, stroke, color);
        clipped(left, top, stroke, bottom - top, color);
        clipped(left + w - stroke, top, stroke, bottom - top, color);
      } else if (shape.kind === "hold") {
        const step = actionHeight * 2;
        // Jump directly to visible dashes, even for a minutes-long hold.
        let distance = Math.max(step, Math.ceil((bottom - height) / step) * step);
        for (; distance + actionHeight <= bottom - top && bottom - distance > 0; distance += step) {
          clipped(x + columnWidth / 2 - 3 * scale, bottom - distance - actionHeight, 6 * scale, actionHeight, color);
        }
      } else {
        clipped(x + columnWidth * 0.3, top, columnWidth * 0.4, bottom - top, color);
      }
    }
  }
}
