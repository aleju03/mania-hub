// The one clock a local export runs on.
//
// Every frame index, every audio sample index, and every hitsound event comes
// out of the pure functions here, derived from integer indices rather than
// accumulated floats. Nothing in this file may read `Date.now()`, the audio
// element's `currentTime`, the display refresh rate, or any live viewer state:
// an export must produce the same media timeline whether it took two seconds
// or ten minutes of wall clock to encode.

/** Shortest source interval a custom range may select, in source milliseconds. */
export const MIN_EXPORT_RANGE_MS = 500;

export type ReplayExportTimelineInput = {
  /** Selected source start, inclusive, in replay milliseconds. */
  startMs: number;
  /** Selected source end, exclusive, in replay milliseconds. */
  endMs: number;
  /** Captured effective playback rate (speed * modRate). Finite and > 0. */
  rate: number;
  /** Output frame rate. */
  fps: number;
  /** Output audio sample rate in hertz. */
  sampleRate: number;
};

export type ReplayExportTimeline = ReplayExportTimelineInput & {
  /** Exact source duration of the selection, in milliseconds. */
  sourceDurationMs: number;
  /** Output duration of the selection before frame rounding, in seconds. */
  outputDurationSeconds: number;
  /** Number of encoded video frames. */
  frameCount: number;
  /** Output duration after rounding up to the next whole frame, in seconds. */
  videoDurationSeconds: number;
  /** Total output PCM frames per channel, covering the padded video duration. */
  totalAudioFrames: number;
  /** Seconds each encoded video frame is shown for. */
  frameDurationSeconds: number;
};

export class ReplayExportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayExportRangeError";
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new ReplayExportRangeError(`${label} must be a finite number.`);
}

export function createExportTimeline(input: ReplayExportTimelineInput): ReplayExportTimeline {
  const { startMs, endMs, rate, fps, sampleRate } = input;
  assertFinite(startMs, "Export start");
  assertFinite(endMs, "Export end");
  assertFinite(rate, "Playback rate");
  assertFinite(fps, "Frame rate");
  assertFinite(sampleRate, "Sample rate");
  if (rate <= 0) throw new ReplayExportRangeError("Playback rate must be greater than zero.");
  if (fps <= 0) throw new ReplayExportRangeError("Frame rate must be greater than zero.");
  if (sampleRate <= 0) throw new ReplayExportRangeError("Sample rate must be greater than zero.");
  if (endMs <= startMs) throw new ReplayExportRangeError("Export end must come after its start.");
  const sourceDurationMs = endMs - startMs;
  if (sourceDurationMs < MIN_EXPORT_RANGE_MS) {
    throw new ReplayExportRangeError(`Export range must cover at least ${MIN_EXPORT_RANGE_MS} ms.`);
  }

  const outputDurationSeconds = sourceDurationMs / (1000 * rate);
  // Constant frame rate, duration rounded up to the next whole frame. The
  // excess is under one frame and is padded with silence, not with extra
  // source time: no note event past `endMs` may enter the output.
  const frameCount = Math.max(1, Math.ceil(outputDurationSeconds * fps));
  const videoDurationSeconds = frameCount / fps;

  return {
    startMs,
    endMs,
    rate,
    fps,
    sampleRate,
    sourceDurationMs,
    outputDurationSeconds,
    frameCount,
    videoDurationSeconds,
    totalAudioFrames: Math.round(videoDurationSeconds * sampleRate),
    frameDurationSeconds: 1 / fps,
  };
}

/** Output presentation time of frame `index`, in seconds. */
export function frameOutputSeconds(timeline: ReplayExportTimeline, index: number): number {
  return index / timeline.fps;
}

/**
 * Source time the renderer must draw for frame `index`. Clamped at `endMs` so
 * the padding frame at the tail never reads past the selected range.
 */
export function frameSourceMs(timeline: ReplayExportTimeline, index: number): number {
  const raw = timeline.startMs + 1000 * timeline.rate * frameOutputSeconds(timeline, index);
  return Math.min(timeline.endMs, raw);
}

/** Raw microsecond timestamp for frame `index`, derived from the index alone. */
export function frameMicroseconds(timeline: ReplayExportTimeline, index: number): number {
  return Math.round((index * 1_000_000) / timeline.fps);
}

/** Output time, in seconds, of a gameplay event at source time `sourceMs`. */
export function sourceMsToOutputSeconds(timeline: ReplayExportTimeline, sourceMs: number): number {
  return (sourceMs - timeline.startMs) / (1000 * timeline.rate);
}

/** Output PCM frame index of a gameplay event at source time `sourceMs`. */
export function sourceMsToAudioFrame(timeline: ReplayExportTimeline, sourceMs: number): number {
  return Math.round(sourceMsToOutputSeconds(timeline, sourceMs) * timeline.sampleRate);
}

/** Source time, in seconds, that output PCM frame `frame` reads from. */
export function audioFrameToSourceSeconds(timeline: ReplayExportTimeline, frame: number): number {
  return (timeline.startMs + 1000 * timeline.rate * (frame / timeline.sampleRate)) / 1000;
}

/**
 * Splits the output PCM range into contiguous blocks of at most
 * `blockFrames`. One integer cursor runs across the whole export, so blocks
 * never overlap and never leave a gap.
 */
export function* audioBlockRanges(
  timeline: ReplayExportTimeline,
  blockFrames: number,
): Generator<{ start: number; end: number; length: number }, void, unknown> {
  const size = Math.max(1, Math.floor(blockFrames));
  let cursor = 0;
  while (cursor < timeline.totalAudioFrames) {
    const end = Math.min(timeline.totalAudioFrames, cursor + size);
    yield { start: cursor, end, length: end - cursor };
    cursor = end;
  }
}

export type ExportRangeRequest =
  | { kind: "full" }
  | { kind: "clip"; atMs: number; outputSeconds: number }
  | { kind: "custom"; startMs: number; endMs: number };

/**
 * Turns a UI range choice into concrete source bounds. Out-of-range values are
 * clamped to the replay, but a selection that is still too short is rejected
 * rather than quietly widened.
 */
export function resolveExportRange(
  request: ExportRangeRequest,
  replayDurationMs: number,
  rate: number,
): { startMs: number; endMs: number } {
  const duration = Math.max(0, replayDurationMs);
  const clamp = (value: number) => Math.max(0, Math.min(duration, value));

  if (request.kind === "full") return { startMs: 0, endMs: duration };

  if (request.kind === "clip") {
    const sourceSpan = Math.max(0, request.outputSeconds) * 1000 * Math.max(0.01, rate);
    // Starting inside the last frame of the replay would leave nothing to
    // record, so a clip asked for there covers the opening instead.
    const start = request.atMs >= duration - MIN_EXPORT_RANGE_MS ? 0 : clamp(request.atMs);
    return { startMs: start, endMs: Math.min(duration, start + sourceSpan) };
  }

  const a = clamp(request.startMs);
  const b = clamp(request.endMs);
  return { startMs: Math.min(a, b), endMs: Math.max(a, b) };
}
