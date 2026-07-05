import { describe, expect, it } from "vitest";
import type { ManiaBeatmap } from "./beatmap-parser";
import {
  RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS,
  RANDOM_REPLAY_PREVIEW_MS,
  buildAutoplayFrames,
  findDensestPreviewStartTime,
  getChartPreviewPlaybackPlan,
  hasPreviewNotes,
  getPreviewNotes,
  getPreviewScrollVelocities,
  pickPreviewStartTime,
  resolveInitialChartPreviewAudioMode,
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
    // Lookahead notes are judged, so the autoplay presses them too instead of
    // leaving them as phantom misses past the window cutoff.
    expect(frames.some((frame) => frame.time === 10_800 && (frame.keyState & 0b10) !== 0)).toBe(true);
    expect(frames.at(-1)).toEqual({ time: RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS, keyState: 0 });
    expect(frames.every((frame) => frame.time <= RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS)).toBe(true);
  });

  it("gives every note a fresh press edge on dense same-column patterns", () => {
    // Hold tail ending exactly on the next head (LN chains) and taps closer
    // together than the 48ms tap hold: both used to swallow the second press
    // entirely, so the autoplay missed notes it was supposed to hit.
    const chain = buildAutoplayFrames(
      [
        { column: 0, time: 0, endTime: 1_000, isHold: true },
        { column: 0, time: 1_000, endTime: 2_000, isHold: true },
      ],
      4,
    );
    expect(chain.some((frame) => frame.time === 999 && frame.keyState === 0)).toBe(true);
    expect(chain.some((frame) => frame.time === 1_000 && frame.keyState === 1)).toBe(true);

    const jacks = buildAutoplayFrames(
      [
        { column: 2, time: 500, endTime: 500, isHold: false },
        { column: 2, time: 530, endTime: 530, isHold: false },
      ],
      4,
    );
    expect(jacks.some((frame) => frame.time === 529 && frame.keyState === 0)).toBe(true);
    expect(jacks.some((frame) => frame.time === 530 && frame.keyState === 4)).toBe(true);
  });

  it("does not clamp already-active long notes into fake preview-start notes", () => {
    const beatmap: ManiaBeatmap = {
      ...baseBeatmap,
      previewTime: 5_000,
      notes: [
        { column: 0, time: 4_000, endTime: 5_000, isHold: true },
        { column: 1, time: 4_500, endTime: 6_200, isHold: true },
        { column: 2, time: 5_250, endTime: 6_000, isHold: true },
      ],
    };

    const notes = getPreviewNotes(beatmap);
    const frames = buildAutoplayFrames(notes, beatmap.keyCount);

    expect(notes).toEqual([
      { column: 2, time: 250, endTime: 1_000, isHold: true },
    ]);
    expect(frames[0]).toEqual({ time: 0, keyState: 0 });
    expect(frames[1]).toEqual({ time: 250, keyState: 4 });
  });

  it("falls back past missing reference preview times", () => {
    expect(pickPreviewStartTime(-1, 54_744)).toBe(54_744);
    expect(pickPreviewStartTime(0, 54_744)).toBe(54_744);
    expect(pickPreviewStartTime(59_716, 54_744)).toBe(59_716);
  });

  it("finds a dense chart preview start when the mapped preview is empty", () => {
    const beatmap: ManiaBeatmap = {
      ...baseBeatmap,
      previewTime: 5_000,
      notes: [
        { column: 0, time: 28_000, endTime: 28_000, isHold: false },
        { column: 1, time: 40_000, endTime: 40_000, isHold: false },
        { column: 2, time: 40_250, endTime: 40_250, isHold: false },
        { column: 3, time: 40_500, endTime: 40_500, isHold: false },
        { column: 0, time: 40_750, endTime: 40_750, isHold: false },
      ],
    };

    expect(hasPreviewNotes(beatmap, beatmap.previewTime)).toBe(false);
    expect(findDensestPreviewStartTime(beatmap)).toBe(39_000);
    expect(hasPreviewNotes(beatmap, findDensestPreviewStartTime(beatmap))).toBe(true);
  });

  it("uses a dense selected-file preview when the mapped preview time is missing", () => {
    const beatmap: ManiaBeatmap = {
      ...baseBeatmap,
      previewTime: -1,
      notes: [
        { column: 0, time: 1_000, endTime: 1_000, isHold: false },
        { column: 1, time: 1_500, endTime: 1_500, isHold: false },
        { column: 0, time: 40_000, endTime: 40_000, isHold: false },
        { column: 1, time: 40_250, endTime: 40_250, isHold: false },
        { column: 2, time: 40_500, endTime: 40_500, isHold: false },
        { column: 3, time: 40_750, endTime: 40_750, isHold: false },
      ],
    };

    expect(hasPreviewNotes(beatmap, pickPreviewStartTime(beatmap.previewTime))).toBe(true);

    const plan = getChartPreviewPlaybackPlan({
      selectedBeatmap: beatmap,
      usesSetPreviewForAudio: true,
      timedRateVariant: false,
      selectedDifficultyRate: 1,
    });

    expect(plan.beatmap).toBe(beatmap);
    expect(plan.startTimeMs).toBe(39_000);
    expect(plan.timeScale).toBe(1);
    expect(plan.audioMode).toBe("selected-file");
  });

  it("can use a mapped reference preview for timed rate variants", () => {
    const selectedBeatmap: ManiaBeatmap = {
      ...baseBeatmap,
      previewTime: -1,
      notes: [
        { column: 0, time: 60_000, endTime: 60_000, isHold: false },
        { column: 1, time: 60_500, endTime: 60_500, isHold: false },
      ],
    };
    const referenceBeatmap: ManiaBeatmap = {
      ...baseBeatmap,
      previewTime: 60_000,
      notes: selectedBeatmap.notes,
    };

    const plan = getChartPreviewPlaybackPlan({
      selectedBeatmap,
      referenceBeatmap,
      usesSetPreviewForAudio: true,
      timedRateVariant: true,
      selectedDifficultyRate: 1.5,
    });

    expect(plan.beatmap).toBe(referenceBeatmap);
    expect(plan.startTimeMs).toBe(60_000);
    expect(plan.timeScale).toBe(1.5);
    expect(plan.audioMode).toBe("set-preview");
  });

  it("keeps set preview audio for timed rate variants with no mapped preview when notes are visible", () => {
    const selectedBeatmap: ManiaBeatmap = {
      ...baseBeatmap,
      previewTime: -1,
      notes: [
        { column: 0, time: 1_000, endTime: 1_000, isHold: false },
        { column: 1, time: 1_500, endTime: 1_500, isHold: false },
      ],
    };
    const referenceBeatmap: ManiaBeatmap = {
      ...baseBeatmap,
      previewTime: -1,
      notes: selectedBeatmap.notes,
    };

    const plan = getChartPreviewPlaybackPlan({
      selectedBeatmap,
      referenceBeatmap,
      usesSetPreviewForAudio: true,
      timedRateVariant: true,
      selectedDifficultyRate: 1.4,
    });

    expect(plan.beatmap).toBe(referenceBeatmap);
    expect(plan.startTimeMs).toBe(0);
    expect(plan.timeScale).toBe(1.4);
    expect(plan.audioMode).toBe("set-preview");
  });

  it("keeps single-diff chart previews on the set preview audio until seek", () => {
    expect(resolveInitialChartPreviewAudioMode({
      plannedAudioMode: "set-preview",
      hasSelectedAudioFile: true,
      hasSetPreviewAudio: true,
      hasDifficultyPicker: false,
      timedRateVariant: false,
    })).toBe("set-preview");
  });

  it("uses selected audio for multi-diff set-preview plans and missing preview audio", () => {
    expect(resolveInitialChartPreviewAudioMode({
      plannedAudioMode: "set-preview",
      hasSelectedAudioFile: true,
      hasSetPreviewAudio: true,
      hasDifficultyPicker: true,
      timedRateVariant: false,
    })).toBe("selected-file");

    expect(resolveInitialChartPreviewAudioMode({
      plannedAudioMode: "set-preview",
      hasSelectedAudioFile: true,
      hasSetPreviewAudio: false,
      hasDifficultyPicker: false,
      timedRateVariant: false,
    })).toBe("selected-file");
  });
});
