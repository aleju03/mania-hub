import type { ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

export type Judgment = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ReplaySegment {
  start: number;
  end: number;
}

export interface ManiaReplayHitWindows {
  perfect: number;
  great: number;
  good: number;
  ok: number;
  meh: number;
  miss: number;
}

export interface ManiaReplayRuleset {
  accuracyMode: "stable" | "lazer";
  difficultyMultiplier: number;
  isConvert: boolean;
  speedMultiplier: number;
  useClassicWindows: boolean;
}

export interface ReplayJudgementEvent {
  column: number;
  judgment: Judgment | null;
  noteIndex: number;
  offsetMs: number;
  part: "note" | "hold-head" | "hold-tail" | "hold-break";
  time: number;
}

export interface ReplayNoteState {
  bodyBreakTime: number | null;
  displayJudgment: Judgment;
  displayTime: number;
  headJudgment: Judgment;
  headOffsetMs: number;
  headTime: number;
  releaseTime: number;
  tailJudgment: Judgment | null;
  tailOffsetMs: number;
  tailTime: number | null;
}

const PERFECT_WINDOW_RANGE = { min: 22.4, mid: 19.4, max: 13.9 };
const GREAT_WINDOW_RANGE = { min: 64, mid: 49, max: 34 };
const GOOD_WINDOW_RANGE = { min: 97, mid: 82, max: 67 };
const OK_WINDOW_RANGE = { min: 127, mid: 112, max: 97 };
const MEH_WINDOW_RANGE = { min: 151, mid: 136, max: 121 };
const MISS_WINDOW_RANGE = { min: 188, mid: 173, max: 158 };
const RELEASE_WINDOW_LENIENCE = 1.5;

function difficultyRange(
  difficulty: number,
  min: number,
  mid: number,
  max: number,
): number {
  if (difficulty > 5) {
    return mid + (max - mid) * ((difficulty - 5) / 5);
  }
  if (difficulty < 5) {
    return mid + (mid - min) * ((difficulty - 5) / 5);
  }
  return mid;
}

export function getManiaReplayRuleset(
  isLazer: boolean,
  mods: string[] = [],
  isConvert = false,
): ManiaReplayRuleset {
  const modSet = new Set(mods.map((mod) => mod.toUpperCase()));

  return {
    accuracyMode: isLazer ? "lazer" : "stable",
    difficultyMultiplier: modSet.has("HR") ? 1.4 : modSet.has("EZ") ? 1 / 1.4 : 1,
    isConvert,
    speedMultiplier: modSet.has("DT") || modSet.has("NC") ? 1.5 : modSet.has("HT") ? 0.75 : 1,
    useClassicWindows: !isLazer || (modSet.has("CL") && !modSet.has("SV2")),
  };
}

export function getManiaReplayHitWindows(
  od: number,
  ruleset: ManiaReplayRuleset,
): ManiaReplayHitWindows {
  const totalMultiplier = ruleset.speedMultiplier / ruleset.difficultyMultiplier;

  if (ruleset.useClassicWindows) {
    if (ruleset.isConvert) {
      return {
        perfect: Math.floor(16 * totalMultiplier) + 0.5,
        great: Math.floor((Math.round(od) > 4 ? 34 : 47) * totalMultiplier) + 0.5,
        good: Math.floor((Math.round(od) > 4 ? 67 : 77) * totalMultiplier) + 0.5,
        ok: Math.floor(97 * totalMultiplier) + 0.5,
        meh: Math.floor(121 * totalMultiplier) + 0.5,
        miss: Math.floor(158 * totalMultiplier) + 0.5,
      };
    }

    const invertedOd = Math.max(0, Math.min(10, 10 - od));
    return {
      perfect: Math.floor(16 * totalMultiplier) + 0.5,
      great: Math.floor((34 + 3 * invertedOd) * totalMultiplier) + 0.5,
      good: Math.floor((67 + 3 * invertedOd) * totalMultiplier) + 0.5,
      ok: Math.floor((97 + 3 * invertedOd) * totalMultiplier) + 0.5,
      meh: Math.floor((121 + 3 * invertedOd) * totalMultiplier) + 0.5,
      miss: Math.floor((158 + 3 * invertedOd) * totalMultiplier) + 0.5,
    };
  }

  return {
    perfect: Math.floor(difficultyRange(od, PERFECT_WINDOW_RANGE.min, PERFECT_WINDOW_RANGE.mid, PERFECT_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    great: Math.floor(difficultyRange(od, GREAT_WINDOW_RANGE.min, GREAT_WINDOW_RANGE.mid, GREAT_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    good: Math.floor(difficultyRange(od, GOOD_WINDOW_RANGE.min, GOOD_WINDOW_RANGE.mid, GOOD_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    ok: Math.floor(difficultyRange(od, OK_WINDOW_RANGE.min, OK_WINDOW_RANGE.mid, OK_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    meh: Math.floor(difficultyRange(od, MEH_WINDOW_RANGE.min, MEH_WINDOW_RANGE.mid, MEH_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
    miss: Math.floor(difficultyRange(od, MISS_WINDOW_RANGE.min, MISS_WINDOW_RANGE.mid, MISS_WINDOW_RANGE.max) * totalMultiplier) + 0.5,
  };
}

export function buildReplaySegments(
  frames: ReplayFrame[],
  keyCount: number,
  totalDuration: number,
): ReplaySegment[][] {
  const segments: ReplaySegment[][] = Array.from({ length: keyCount }, () => []);
  const active: Array<number | null> = new Array(keyCount).fill(null);

  for (const frame of frames) {
    for (let column = 0; column < keyCount; column++) {
      const pressed = (frame.keyState & (1 << column)) !== 0;
      if (pressed && active[column] === null) {
        active[column] = frame.time;
      } else if (!pressed && active[column] !== null) {
        segments[column].push({ start: active[column], end: frame.time });
        active[column] = null;
      }
    }
  }

  for (let column = 0; column < keyCount; column++) {
    if (active[column] !== null) {
      segments[column].push({ start: active[column], end: totalDuration });
    }
  }

  return segments;
}

function getJudgmentForOffset(
  offsetMs: number,
  windows: ManiaReplayHitWindows,
): Judgment {
  const delta = Math.abs(offsetMs);
  if (delta <= windows.perfect) return 1;
  if (delta <= windows.great) return 2;
  if (delta <= windows.good) return 3;
  if (delta <= windows.ok) return 4;
  if (delta <= windows.meh) return 5;
  if (delta <= windows.miss) return 6;
  return 0;
}

function createMissState(
  note: ManiaNote,
  noteIndex: number,
  windows: ManiaReplayHitWindows,
  column: number,
  events: ReplayJudgementEvent[],
): ReplayNoteState {
  const headTime = note.time + windows.miss;

  events.push({
    column,
    judgment: 6,
    noteIndex,
    offsetMs: windows.miss,
    part: note.isHold ? "hold-head" : "note",
    time: headTime,
  });

  if (!note.isHold || note.endTime <= note.time) {
    return {
      bodyBreakTime: null,
      displayJudgment: 6,
      displayTime: headTime,
      headJudgment: 6,
      headOffsetMs: windows.miss,
      headTime,
      releaseTime: 0,
      tailJudgment: null,
      tailOffsetMs: 0,
      tailTime: null,
    };
  }

  const tailTime = note.endTime + windows.miss * RELEASE_WINDOW_LENIENCE;
  events.push({
    column,
    judgment: 6,
    noteIndex,
    offsetMs: windows.miss * RELEASE_WINDOW_LENIENCE,
    part: "hold-tail",
    time: tailTime,
  });

  return {
    bodyBreakTime: null,
    displayJudgment: 6,
    displayTime: headTime,
    headJudgment: 6,
    headOffsetMs: windows.miss,
    headTime,
    releaseTime: 0,
    tailJudgment: 6,
    tailOffsetMs: windows.miss * RELEASE_WINDOW_LENIENCE,
    tailTime,
  };
}

export function simulateManiaReplayJudgements(
  notes: ManiaNote[],
  segments: ReplaySegment[][],
  keyCount: number,
  windows: ManiaReplayHitWindows,
): { events: ReplayJudgementEvent[]; noteStates: ReplayNoteState[] } {
  const noteStates: ReplayNoteState[] = new Array(notes.length);
  const events: ReplayJudgementEvent[] = [];
  const notesByColumn: number[][] = Array.from({ length: keyCount }, () => []);

  for (let i = 0; i < notes.length; i++) {
    const column = notes[i].column;
    if (column >= 0 && column < keyCount) {
      notesByColumn[column].push(i);
    }
  }

  for (let column = 0; column < keyCount; column++) {
    const columnNotes = notesByColumn[column];
    const columnSegments = segments[column];
    let segmentCursor = 0;

    for (const noteIndex of columnNotes) {
      const note = notes[noteIndex];
      const nextNoteIndex = columnNotes.find((candidateIndex) => candidateIndex > noteIndex) ?? null;
      const nextNote = nextNoteIndex != null ? notes[nextNoteIndex] : null;

      while (segmentCursor < columnSegments.length && columnSegments[segmentCursor].start < note.time - windows.miss) {
        segmentCursor++;
      }

      let matchedSegmentIndex = -1;
      let headJudgment: Judgment = 0;
      const latestHeadHitTime = nextNote
        ? Math.min(note.time + windows.miss, nextNote.time - Number.EPSILON)
        : note.time + windows.miss;

      for (let s = segmentCursor; s < columnSegments.length; s++) {
        const segment = columnSegments[s];
        if (segment.start > latestHeadHitTime) break;

        headJudgment = getJudgmentForOffset(segment.start - note.time, windows);
        if (headJudgment !== 0) {
          matchedSegmentIndex = s;
          break;
        }
      }

      if (matchedSegmentIndex === -1) {
        noteStates[noteIndex] = createMissState(note, noteIndex, windows, column, events);
        continue;
      }

      const headSegment = columnSegments[matchedSegmentIndex];
      const headOffsetMs = headSegment.start - note.time;
      events.push({
        column,
        judgment: headJudgment,
        noteIndex,
        offsetMs: headOffsetMs,
        part: note.isHold ? "hold-head" : "note",
        time: headSegment.start,
      });

      if (!note.isHold || note.endTime <= note.time) {
        noteStates[noteIndex] = {
          bodyBreakTime: null,
          displayJudgment: headJudgment,
          displayTime: headSegment.start,
          headJudgment,
          headOffsetMs,
          headTime: headSegment.start,
          releaseTime: headSegment.end,
          tailJudgment: null,
          tailOffsetMs: 0,
          tailTime: null,
        };
        segmentCursor = matchedSegmentIndex + 1;
        continue;
      }

      let bodyBreakTime: number | null = null;
      let releaseTime = headSegment.end;
      let scanIndex = matchedSegmentIndex;
      const tailDeadline = note.endTime + windows.miss * RELEASE_WINDOW_LENIENCE;
      let tailJudgment: Judgment = 6;
      let tailOffsetMs = windows.miss * RELEASE_WINDOW_LENIENCE;
      let tailTime = tailDeadline;

      while (scanIndex < columnSegments.length) {
        const segment = columnSegments[scanIndex];
        releaseTime = Math.max(releaseTime, segment.end);

        const releaseOffsetMs = (segment.end - note.endTime) / RELEASE_WINDOW_LENIENCE;
        const rawTailJudgment = getJudgmentForOffset(releaseOffsetMs, windows);

        if (rawTailJudgment !== 0) {
          tailJudgment = bodyBreakTime != null && rawTailJudgment < 5 ? 5 : rawTailJudgment;
          tailOffsetMs = segment.end - note.endTime;
          tailTime = segment.end;
          break;
        }

        if (segment.end >= tailDeadline) {
          tailJudgment = 6;
          tailOffsetMs = tailDeadline - note.endTime;
          tailTime = tailDeadline;
          break;
        }

        if (bodyBreakTime == null) {
          bodyBreakTime = segment.end;
          events.push({
            column,
            judgment: null,
            noteIndex,
            offsetMs: segment.end - note.endTime,
            part: "hold-break",
            time: segment.end,
          });
        }

        scanIndex++;
        if (scanIndex >= columnSegments.length || columnSegments[scanIndex].start > tailDeadline) {
          tailJudgment = 6;
          tailOffsetMs = tailDeadline - note.endTime;
          tailTime = tailDeadline;
          break;
        }
      }

      events.push({
        column,
        judgment: tailJudgment,
        noteIndex,
        offsetMs: tailOffsetMs,
        part: "hold-tail",
        time: tailTime,
      });

      noteStates[noteIndex] = {
        bodyBreakTime,
        displayJudgment: headJudgment,
        displayTime: headSegment.start,
        headJudgment,
        headOffsetMs,
        headTime: headSegment.start,
        releaseTime,
        tailJudgment,
        tailOffsetMs,
        tailTime,
      };

      segmentCursor = matchedSegmentIndex + 1;
    }
  }

  events.sort((a, b) => a.time - b.time || a.noteIndex - b.noteIndex || a.column - b.column);

  return { events, noteStates };
}

export function calculateReplayAccuracy(
  counts: number[],
  accuracyMode: ManiaReplayRuleset["accuracyMode"],
): number {
  const totalNotes = counts[1] + counts[2] + counts[3] + counts[4] + counts[5] + counts[6];
  if (totalNotes <= 0) return 100;

  const perfectValue = accuracyMode === "lazer" ? 305 : 300;
  const totalValue =
    counts[1] * perfectValue +
    counts[2] * 300 +
    counts[3] * 200 +
    counts[4] * 100 +
    counts[5] * 50;

  return (totalValue / (totalNotes * perfectValue)) * 100;
}

export function getTailReleaseWindowLenience() {
  return RELEASE_WINDOW_LENIENCE;
}
