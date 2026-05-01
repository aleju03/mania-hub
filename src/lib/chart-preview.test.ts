import { describe, expect, it } from "vitest";
import type { ManiaBeatmap } from "./beatmap-parser";
import {
  RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS,
  RANDOM_REPLAY_PREVIEW_MS,
  buildAutoplayFrames,
  getPreviewNotes,
  getPreviewScrollVelocities,
  pickPreviewStartTime,
} from "./chart-preview";

const baseBeatmap: ManiaBeatmap = {
  title: "Preview Test",
  artist: "Tester",
  version: "4K",
  creator: "Mapper",
  keyCount: 4,
  od: 8,
  bpm: 180,
  notes: [],
  totalLength: 30_000,
  audioFilename: "audio.mp3",
  previewTime: 5_000,
  backgroundFilename: "",
  breakPeriods: [],
  scrollVelocities: [],
};

describe("chart preview helpers", () => {
  it("keeps future notes visible beyond the playback cutoff", () => {
    const beatmap: ManiaBeatmap = {
      ...baseBeatmap,
      notes: [
        { column: 0, time: 5_200, endTime: 5_200, isHold: false },
        { column: 1, time: 15_800, endTime: 15_800, isHold: false },
        { column: 2, time: 16_000 + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS + 1, endTime: 16_000 + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS + 1, isHold: false },
      ],
      scrollVelocities: [
        { time: 14_900, multiplier: 1.2 },
        { time: 15_800, multiplier: 0.75 },
        { time: 16_000 + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS + 1, multiplier: 1.5 },
      ],
    };

    const notes = getPreviewNotes(beatmap);
    const scrollVelocities = getPreviewScrollVelocities(beatmap);
    const frames = buildAutoplayFrames(notes, beatmap.keyCount);

    expect(notes.map((note) => note.time)).toEqual([200, 10_800]);
    expect(scrollVelocities).toEqual([
      { time: 0, multiplier: 1 },
      { time: 9_900, multiplier: 1.2 },
      { time: 10_800, multiplier: 0.75 },
    ]);
    expect(frames.at(-1)).toEqual({ time: RANDOM_REPLAY_PREVIEW_MS, keyState: 0 });
    expect(frames.every((frame) => frame.time <= RANDOM_REPLAY_PREVIEW_MS)).toBe(true);
  });

  it("falls back past missing reference preview times", () => {
    expect(pickPreviewStartTime(-1, 54_744)).toBe(54_744);
    expect(pickPreviewStartTime(0, 54_744)).toBe(54_744);
    expect(pickPreviewStartTime(59_716, 54_744)).toBe(59_716);
  });
});
