import { describe, expect, it } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import { buildReplayNoteBlockEndTimes, REPLAY_NOTE_BLOCK_SIZE } from "../../lib/replay-note-culling";
import type { ManiaNote, ManiaScrollVelocity } from "../../lib/beatmap-parser";
import { getManiaReplayRuleset } from "#replay-judge/mania-replay-judgement";
import type { ReplayNoteState } from "#replay-judge/mania-replay-judgement";

const layout = { judgmentY: 640, noteHeight: 18, pixelsPerMs: 1, h: 768, laneWidth: 70 };
const tap = (time: number, column = 0): ManiaNote => ({ time, endTime: time, isHold: false, column });
const hold = (time: number, endTime: number, column = 0): ManiaNote => ({ time, endTime, isHold: true, column });
function stateFor(note: ManiaNote, index = 0): ReplayNoteState {
  return {
    headTime: note.time + (index % 3 === 0 ? 180 : 15),
    headJudgment: index % 3 === 0 ? 6 : 1,
    tailTime: note.isHold ? note.endTime + 140 : null,
    tailJudgment: note.isHold ? index % 2 === 0 ? 6 : 1 : null,
  } as ReplayNoteState;
}

// Use the real renderNotes, SV integration and hold-consumption logic. Only
// final drawing calls are captured, so changes in visibility/order/geometry
// are observable without a browser or GPU.
function createRenderer(notes: ManiaNote[], states = notes.map(stateFor), velocities: ManiaScrollVelocity[] = []) {
  const commands: unknown[][] = [];
  const draw = (name: string) => (...args: unknown[]) => { commands.push([name, ...args]); };
  const renderer = Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    notes,
    noteStates: states,
    noteBlockEndTimes: buildReplayNoteBlockEndTimes(notes, states),
    maxHoldDuration: notes.reduce((longest, note) => Math.max(longest, note.endTime - note.time), 0),
    currentTime: 0,
    keyCount: 4,
    barePlayfield: false,
    hasVisibilityMod: false,
    skinSettings: { style: "circles", upscroll: false, outlineEnabled: true, percy: true, lnBodyColor: "body", outlineColor: "outline", outlineWidth: 2 },
    skinProfile: { assets: { columns: [{}, {}, {}, {}] } },
    colors: ["red", "blue", "green", "yellow"],
    barTapColors: ["red", "blue", "green", "yellow"],
    circleTapColors: ["red", "blue", "green", "yellow"],
    circleLnHeadColors: ["red-head", "blue-head", "green-head", "yellow-head"],
    segments: Array.from({ length: 4 }, (_, column) => notes.filter(note => note.column === column && note.isHold)
      .map(note => ({ start: note.time + 15, end: note.endTime - 30 }))),
    scrollVelocities: velocities,
    getColumnLayout: (column: number) => ({ x: column * 70, width: 70 }),
    renderHoldSkinImages: () => false,
    circleWithTopFade: draw("circle"),
    strokeCircleWithTopFade: draw("outline"),
    circleLnBodyWithTopFade: draw("circle-body"),
    arrowShapeWithTopFade: draw("arrow"),
    arrowLnBodyWithTopFade: draw("arrow-body"),
    barLnBodyWithTopFade: draw("bar-body"),
    roundRectWithTopFade: draw("bar"),
  });
  renderer.prepareScrollVelocities();
  return { renderer, commands };
}

function renderPair(notes: ManiaNote[], states: ReplayNoteState[], velocities: ManiaScrollVelocity[] = []) {
  const indexed = createRenderer(notes, states, velocities);
  const original = createRenderer(notes, states, velocities);
  // Infinity disables only the new block skip: the original candidate start,
  // per-note judgement checks and rendering continue to run unchanged.
  original.renderer.noteBlockEndTimes.fill(Infinity);
  return { indexed, original };
}

describe("replay note block culling", () => {
  it.each(["circles", "bars", "arrows"])("preserves %s draw commands through seeks, SVs, misses and hold breaks", (style) => {
    const notes = Array.from({ length: 900 }, (_, index) => index % 13 === 0
      ? hold(index * 25, index * 25 + (index === 0 ? 30_000 : 375), index % 4)
      : tap(index * 25, index % 4));
    const { indexed, original } = renderPair(notes, notes.map(stateFor), [
      { time: 0, multiplier: 1 },
      { time: 4000, multiplier: 0.08 },
      { time: 6500, multiplier: 3 },
      { time: 17_000, multiplier: 0.5 },
    ]);
    for (const upscroll of [false, true]) {
      for (const judgmentY of [50, 350, 720]) {
        // Seek backwards as well as forwards; the index has no playhead state.
        for (const time of [0, 7500, 19_850, 3200, 30_100, 15_000, 22_700]) {
          for (const test of [indexed, original]) {
            test.renderer.skinSettings = { ...test.renderer.skinSettings, style, upscroll };
            test.renderer.currentTime = time;
            test.commands.length = 0;
            test.renderer.renderNotes({ ...layout, judgmentY });
          }
          expect(indexed.commands).toEqual(original.commands);
        }
      }
    }
  });

  it.each([false, true])("retains an old hold still attached while its late tail is pending (upscroll %s)", (upscroll) => {
    // Keep the old candidate scan wide with a second, future long hold. The
    // short hold's block has passed its chart end, but its held head is still
    // clamped to the receptor until the tail judgement arrives.
    const notes = [hold(0, 100), hold(50_000, 150_000, 1)];
    const states = [
      { headTime: 0, headJudgment: 1, tailTime: 1200, tailJudgment: 6 },
      stateFor(notes[1]),
    ] as ReplayNoteState[];
    const { indexed, original } = renderPair(notes, states);
    // Give each relevant hold a separate block so the future one cannot keep
    // the first alive accidentally.
    const padding = Array.from({ length: REPLAY_NOTE_BLOCK_SIZE - 1 }, (_, index) => tap(index + 1, 2));
    for (const test of [indexed, original]) {
      test.renderer.notes = [notes[0], ...padding, notes[1]];
      test.renderer.noteStates = [states[0], ...padding.map(note => ({ ...stateFor(note), headTime: note.time, headJudgment: 1 })), states[1]];
      test.renderer.noteBlockEndTimes = buildReplayNoteBlockEndTimes(test.renderer.notes, test.renderer.noteStates);
      if (test === original) test.renderer.noteBlockEndTimes.fill(Infinity);
      test.renderer.skinSettings.upscroll = upscroll;
      test.renderer.segments = [[{ start: 0, end: 1500 }], [], [], []];
      test.renderer.currentTime = 1000;
      test.renderer.renderNotes({ ...layout, judgmentY: upscroll ? 128 : 640 });
    }
    expect(original.commands.length).toBeGreaterThan(0);
    expect(indexed.commands).toEqual(original.commands);
  });

  it.each([false, true])("keeps timed-out taps scrolling beyond the search cutoff with raised receptors (upscroll %s)", (upscroll) => {
    const notes = [tap(600), ...Array.from({ length: 63 }, (_, index) => tap(601 + index, 1)), hold(50_000, 150_000, 2)];
    const states = notes.map(note => ({ ...stateFor(note), headTime: note.time + 100, headJudgment: 6 } as ReplayNoteState));
    const { indexed, original } = renderPair(notes, states);
    for (const test of [indexed, original]) {
      test.renderer.skinSettings.upscroll = upscroll;
      test.renderer.currentTime = 1000;
      test.renderer.renderNotes({ ...layout, judgmentY: upscroll ? 718 : 50 });
    }
    expect(original.commands.length).toBeGreaterThan(0);
    expect(indexed.commands).toEqual(original.commands);
  });

  it("skips expired stretches around an extreme hold without scanning their note states", () => {
    const notes = [hold(0, 300_000), ...Array.from({ length: 20_000 }, (_, index) => tap(1 + index * 15, index % 4))];
    const { indexed, original } = renderPair(notes, notes.map(stateFor));
    const visits = new Map<object, number>();
    for (const test of [indexed, original]) {
      visits.set(test, 0);
      test.renderer.noteStates = new Proxy(test.renderer.noteStates, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) visits.set(test, visits.get(test)! + 1);
          return Reflect.get(target, property, receiver);
        },
      });
      test.renderer.currentTime = 250_000;
      test.renderer.renderNotes(layout);
    }
    expect(indexed.commands).toEqual(original.commands);
    expect(visits.get(original)).toBeGreaterThan(16_000);
    expect(visits.get(indexed)).toBeLessThan(250);
  });

  it("rebuilds culling bounds when preview data replaces an old chart", () => {
    const { renderer, commands } = createRenderer([tap(0)]);
    Object.assign(renderer, {
      od: 8,
      modRate: 1,
      ruleset: getManiaReplayRuleset(false, [], false, 1),
      resetColumnStats: () => {},
      updateSkinCache: () => {},
      buildFallbackLifeBarFrames: () => [],
      rebuildStarRatingTimeline: () => {},
      buildScoreSimulator: () => {},
      buildHitsoundTimeline: () => {},
      measureCanvas: () => {},
      invalidateLayoutCache: () => {},
      recomputeStatsUpTo: () => {},
      resetHiddenCoverage: () => {},
      resetAudioClockSmoothing: () => {},
      render: () => {},
    });
    renderer.setPreviewData([], 4, [hold(0, 30_000)]);
    renderer.currentTime = 15_000;
    renderer.renderNotes(layout);
    expect(commands.some(([kind]) => kind === "circle-body")).toBe(true);
  });
});
