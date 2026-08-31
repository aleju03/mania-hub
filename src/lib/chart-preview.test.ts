import { describe, expect, it } from "vitest";
import type { ManiaBeatmap } from "./beatmap-parser";
import {
  RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS,
  RANDOM_REPLAY_PREVIEW_MS,
  buildAutoplayFrames,
  createClockStallWatch,
  findDensestPreviewStartTime,
  getChartPreviewPlaybackPlan,
  getSetPreviewReferenceBeatmap,
  hasPreviewNotes,
  getPreviewNotes,
  getPreviewScrollVelocities,
  isLikelyTimedRateVariantSet,
  parseDifficultyRate,
  parseSelectedDifficultyRate,
  pickPreviewStartTime,
  resolveInitialChartPreviewAudioMode,
  shouldUseSetPreviewForReplayAudio,
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

  it("keeps chart previews on the set preview audio until seek", () => {
    expect(resolveInitialChartPreviewAudioMode({
      plannedAudioMode: "set-preview",
      hasSelectedAudioFile: true,
      hasSetPreviewAudio: true,
    })).toBe("set-preview");
  });

  it("does not download the song just because the set has a difficulty picker", () => {
    // A multi-difficulty set used to be forced onto the full audio file here,
    // which meant waiting out an .osz download before anything played even
    // when every difficulty was the same song.
    expect(resolveInitialChartPreviewAudioMode({
      plannedAudioMode: "set-preview",
      hasSelectedAudioFile: true,
      hasSetPreviewAudio: true,
    })).toBe("set-preview");
  });

  it("uses selected audio when the set has no preview clip", () => {
    expect(resolveInitialChartPreviewAudioMode({
      plannedAudioMode: "set-preview",
      hasSelectedAudioFile: true,
      hasSetPreviewAudio: false,
    })).toBe("selected-file");

    expect(resolveInitialChartPreviewAudioMode({
      plannedAudioMode: "set-preview",
      hasSelectedAudioFile: false,
      hasSetPreviewAudio: false,
    })).toBe("set-preview");
  });
});

function difficulty(version: string, totalLength: number, difficultyRating = 5, cs = 4) {
  return { version, totalLength, difficultyRating, cs };
}

describe("set preview audio source", () => {
  it("plays the set preview when every difficulty is the same song", () => {
    expect(shouldUseSetPreviewForReplayAudio("Paralyzer", [
      difficulty("[6K] Sweatin'", 191),
      difficulty("[7K] Hard ROCK!", 191),
      difficulty("[6K] Breezin'", 195),
    ])).toBe(true);
  });

  it("downloads the song when difficulty lengths scatter across a dan course set", () => {
    expect(shouldUseSetPreviewForReplayAudio("Regular Dan Phase I", [
      difficulty("[7K] 0th Dan (Marathon)", 422),
      difficulty("[7K] 1st Dan (Marathon)", 476),
      difficulty("[7K] 2nd Dan (Marathon)", 521),
      difficulty("[7K] 3rd Dan (Marathon)", 531),
    ])).toBe(false);
  });

  it("keeps the set preview for rate variants, whose lengths differ by their own rate", () => {
    const beatmaps = [difficulty("[4K] Macabre", 120), difficulty("[4K] Macabre 1.2x", 100)];
    expect(isLikelyTimedRateVariantSet(beatmaps)).toBe(true);
    expect(shouldUseSetPreviewForReplayAudio("Odoru Mizushibuki", beatmaps)).toBe(true);
  });

  it("vetoes compilations by name when their songs happen to share a length", () => {
    const beatmaps = [difficulty("[6K] Alex c. feat. Yasmin", 114), difficulty("[6K] P*Light", 116)];
    expect(shouldUseSetPreviewForReplayAudio("Some Song", beatmaps)).toBe(true);
    expect(shouldUseSetPreviewForReplayAudio("Alipay's 6k practice pack Vol.2", beatmaps)).toBe(false);
  });

  it("vetoes on the difficulty name too, not just the set title", () => {
    expect(shouldUseSetPreviewForReplayAudio("far in the blue sky", [
      difficulty("[4K] chordjack practice 1", 184),
      difficulty("[4K] chordjack practice 2", 187),
    ])).toBe(false);
  });

  it("always uses the set preview for a single-difficulty set", () => {
    expect(shouldUseSetPreviewForReplayAudio("Pack of One", [difficulty("[4K] Only", 200)])).toBe(true);
  });

  it("ignores difficulties with no usable length", () => {
    expect(shouldUseSetPreviewForReplayAudio("TAKECORE OF YOURSELF", [
      difficulty("[4K] Normal", 0),
      difficulty("[4K] Hard", 280),
      difficulty("[4K] Insane", 283),
    ])).toBe(true);
  });
});

describe("rate variant parsing", () => {
  it("reads comma decimals, which non-English mappers use for rates", () => {
    expect(parseDifficultyRate("[4K] Supersensory [1,05x Rate]")).toBe(1.05);
    expect(parseDifficultyRate("[4K] Meowscarada [0,85x Rate]")).toBe(0.85);
    expect(parseDifficultyRate("[4K] Macabre 1.2x")).toBe(1.2);
    expect(parseDifficultyRate("[4K] Insane")).toBe(1);
  });

  it("treats a comma-decimal set as a rate variant rather than two songs", () => {
    const beatmaps = [difficulty("[4K] Supersensory", 150), difficulty("[4K] Supersensory [1,05x Rate]", 143)];
    expect(isLikelyTimedRateVariantSet(beatmaps)).toBe(true);
    expect(shouldUseSetPreviewForReplayAudio("x7124", beatmaps)).toBe(true);
  });

  it("scales bracket-BPM variants against the base BPM", () => {
    const beatmaps = [difficulty("[4K] Song [130]", 200), difficulty("[4K] Song [160]", 163)];
    expect(parseSelectedDifficultyRate(beatmaps[1], beatmaps)).toBeCloseTo(160 / 130, 5);
    expect(parseSelectedDifficultyRate(beatmaps[0], beatmaps)).toBe(1);
  });

  it("keeps a number that is part of the name out of the rate", () => {
    expect(parseDifficultyRate("[4K] 2mnd")).toBe(1);
    expect(parseDifficultyRate("[4K] 2nd")).toBe(1);
    expect(parseDifficultyRate("[4K] 1st Dan")).toBe(1);
  });

  it("treats the named base of a rate-edit set as the 1.0x difficulty", () => {
    const beatmaps = [
      difficulty("[4K] 0.95", 191),
      difficulty("[4K] 2mnd", 182),
      difficulty("[4K] 1.05", 173),
      difficulty("[4K] 1.1", 165),
      difficulty("[4K] 1.25", 146),
    ];
    expect(parseSelectedDifficultyRate(beatmaps[1], beatmaps)).toBe(1);
    expect(getSetPreviewReferenceBeatmap(beatmaps)?.version).toBe("[4K] 2mnd");
  });

  it("points the reference beatmap at the unscaled difficulty", () => {
    const beatmaps = [difficulty("[4K] Macabre 1.2x", 100), difficulty("[4K] Macabre", 120)];
    expect(getSetPreviewReferenceBeatmap(beatmaps)?.version).toBe("[4K] Macabre");
  });
});

describe("createClockStallWatch", () => {
  it("never reports a stall while the clock keeps advancing", () => {
    const watch = createClockStallWatch(1200, 0.005);
    let stalls = 0;
    // A 240Hz frame loop sampling a media clock: every single sample moves it
    // by less than the epsilon, but the clock is perfectly healthy.
    for (let frame = 0; frame < 2000; frame++) {
      const nowMs = frame * (1000 / 240);
      if (watch.observe(nowMs / 1000, nowMs)) stalls++;
    }
    expect(stalls).toBe(0);
  });

  it("reports a stall only after a full window with the clock still", () => {
    const watch = createClockStallWatch(1200, 0.005);
    expect(watch.observe(10, 0)).toBe(false);
    expect(watch.observe(10, 600)).toBe(false);
    expect(watch.observe(10, 1199)).toBe(false);
    expect(watch.observe(10, 1200)).toBe(true);
  });

  it("re-baselines after reporting so it cannot fire every sample", () => {
    const watch = createClockStallWatch(1200, 0.005);
    watch.observe(10, 0);
    expect(watch.observe(10, 1200)).toBe(true);
    expect(watch.observe(10, 1300)).toBe(false);
    expect(watch.observe(10, 2399)).toBe(false);
    expect(watch.observe(10, 2400)).toBe(true);
  });

  it("measures the window from the last advance, not the last sample", () => {
    const watch = createClockStallWatch(1200, 0.005);
    watch.observe(10, 0);
    watch.observe(10, 900);
    expect(watch.observe(10.5, 1000)).toBe(false);
    expect(watch.observe(10.5, 2100)).toBe(false);
    expect(watch.observe(10.5, 2200)).toBe(true);
  });

  it("forgets its baseline on reset", () => {
    const watch = createClockStallWatch(1200, 0.005);
    watch.observe(10, 0);
    watch.reset(1000);
    expect(watch.observe(10, 2400)).toBe(false);
    expect(watch.observe(10, 3600)).toBe(true);
  });
});
