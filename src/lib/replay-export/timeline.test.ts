import { describe, expect, it } from "vitest";

import {
  MIN_EXPORT_RANGE_MS,
  ReplayExportRangeError,
  audioBlockRanges,
  audioFrameToSourceSeconds,
  createExportTimeline,
  frameMicroseconds,
  frameOutputSeconds,
  frameSourceMs,
  resolveExportRange,
  sourceMsToAudioFrame,
  sourceMsToOutputSeconds,
} from "./timeline";

const base = { startMs: 0, endMs: 60_000, rate: 1, fps: 60, sampleRate: 48_000 };

describe("createExportTimeline", () => {
  it("turns a rated source interval into output frames", () => {
    // The worked example from the release spec: 60 s of source at 1.5x is
    // 40 s of video, which is 2,400 frames at 60 FPS.
    const timeline = createExportTimeline({ ...base, rate: 1.5 });
    expect(timeline.outputDurationSeconds).toBeCloseTo(40, 10);
    expect(timeline.frameCount).toBe(2400);
    expect(timeline.videoDurationSeconds).toBeCloseTo(40, 10);
  });

  it("rounds the final duration up to a whole frame", () => {
    const timeline = createExportTimeline({ ...base, endMs: 1016 });
    expect(timeline.outputDurationSeconds).toBeCloseTo(1.016, 10);
    expect(timeline.frameCount).toBe(61);
    expect(timeline.videoDurationSeconds).toBeCloseTo(61 / 60, 10);
    // The extra is under one frame, never a whole extra frame of source.
    expect(timeline.videoDurationSeconds - timeline.outputDurationSeconds).toBeLessThan(1 / 60);
  });

  it("sizes the audio track against the padded video duration", () => {
    const timeline = createExportTimeline({ ...base, endMs: 1016 });
    expect(timeline.totalAudioFrames).toBe(Math.round((61 / 60) * 48_000));
  });

  it("rejects ranges that are inverted, too short, or non-finite", () => {
    expect(() => createExportTimeline({ ...base, endMs: 0 })).toThrow(ReplayExportRangeError);
    expect(() => createExportTimeline({ ...base, endMs: MIN_EXPORT_RANGE_MS - 1 })).toThrow(ReplayExportRangeError);
    expect(() => createExportTimeline({ ...base, rate: 0 })).toThrow(ReplayExportRangeError);
    expect(() => createExportTimeline({ ...base, rate: Number.NaN })).toThrow(ReplayExportRangeError);
  });
});

describe("frame mapping", () => {
  it("derives every frame from its index, never by accumulation", () => {
    const timeline = createExportTimeline({ ...base, startMs: 12_345, rate: 1.4, fps: 48 });
    for (const index of [0, 1, 17, 500]) {
      expect(frameOutputSeconds(timeline, index)).toBeCloseTo(index / 48, 12);
      expect(frameSourceMs(timeline, index)).toBeCloseTo(12_345 + 1000 * 1.4 * (index / 48), 9);
    }
  });

  it("keeps raw timestamps monotonic and free of drift", () => {
    const timeline = createExportTimeline({ ...base, fps: 30 });
    let previous = -1;
    for (let index = 0; index < timeline.frameCount; index++) {
      const micros = frameMicroseconds(timeline, index);
      expect(micros).toBeGreaterThan(previous);
      previous = micros;
    }
    expect(previous).toBe(Math.round(((timeline.frameCount - 1) * 1_000_000) / 30));
  });

  it("clamps the padding frame to the selected end", () => {
    const timeline = createExportTimeline({ ...base, endMs: 1016 });
    expect(frameSourceMs(timeline, timeline.frameCount - 1)).toBeLessThanOrEqual(1016);
  });
});

describe("audio mapping", () => {
  it("places an event at its output time, not at a frame boundary", () => {
    const timeline = createExportTimeline({ ...base, startMs: 1000, rate: 2 });
    expect(sourceMsToOutputSeconds(timeline, 3000)).toBeCloseTo(1, 12);
    expect(sourceMsToAudioFrame(timeline, 3000)).toBe(48_000);
    // Half a millisecond of source still lands on its own sample.
    expect(sourceMsToAudioFrame(timeline, 1000.5)).toBe(12);
  });

  it("round-trips a sample index back to its source time", () => {
    const timeline = createExportTimeline({ ...base, startMs: 2500, rate: 0.75 });
    const frame = 33_333;
    const seconds = audioFrameToSourceSeconds(timeline, frame);
    expect(sourceMsToAudioFrame(timeline, seconds * 1000)).toBe(frame);
  });

  it("splits the output into blocks with one continuous cursor", () => {
    const timeline = createExportTimeline({ ...base, endMs: 2_500 });
    const blocks = [...audioBlockRanges(timeline, 48_000)];
    expect(blocks[0].start).toBe(0);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].start).toBe(blocks[i - 1].end);
    }
    expect(blocks.at(-1)?.end).toBe(timeline.totalAudioFrames);
    expect(blocks.reduce((total, block) => total + block.length, 0)).toBe(timeline.totalAudioFrames);
  });
});

describe("resolveExportRange", () => {
  it("spans rate-scaled source time for a clip", () => {
    // A 30-second output clip at 1.5x covers 45 seconds of source time.
    const range = resolveExportRange({ kind: "clip", atMs: 0, outputSeconds: 30 }, 600_000, 1.5);
    expect(range).toEqual({ startMs: 0, endMs: 45_000 });
  });

  it("stops a clip at the end of the replay", () => {
    const range = resolveExportRange({ kind: "clip", atMs: 580_000, outputSeconds: 30 }, 600_000, 1.5);
    expect(range.endMs).toBe(600_000);
  });

  it("restarts a clip asked for past the end", () => {
    const range = resolveExportRange({ kind: "clip", atMs: 599_900, outputSeconds: 30 }, 600_000, 1);
    expect(range.startMs).toBe(0);
  });

  it("orders and clamps custom marks", () => {
    const range = resolveExportRange({ kind: "custom", startMs: 9_000, endMs: 3_000 }, 8_000, 1);
    expect(range).toEqual({ startMs: 3_000, endMs: 8_000 });
  });

  it("covers the whole replay for a full export", () => {
    expect(resolveExportRange({ kind: "full" }, 123_456, 2)).toEqual({ startMs: 0, endMs: 123_456 });
  });
});
