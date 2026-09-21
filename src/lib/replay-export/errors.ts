// Stable failure codes for the local replay video exporter.
//
// The code is the contract: it is what tests assert on, what telemetry counts,
// and what the progress panel maps to copy. Messages are descriptors so the
// panel resolves them against its own i18n instance, the same way the replay
// route's loading copy does.

import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

export const REPLAY_EXPORT_ERROR_CODES = [
  "export_busy",
  "unsupported_video_codec",
  "fast_export_unavailable",
  "unsupported_audio_codec",
  "unsupported_audio_decode",
  "unsupported_pitch_processing",
  "asset_load_failed",
  "asset_not_origin_clean",
  "resource_limit_exceeded",
  "invalid_range",
  "storage_unavailable",
  "storage_write_failed",
  "renderer_failed",
  "encoder_failed",
  "export_interrupted",
] as const;

export type ReplayExportErrorCode = (typeof REPLAY_EXPORT_ERROR_CODES)[number];

/** Codes worth offering a plain Retry for: the same settings may work again. */
const RETRYABLE_CODES = new Set<ReplayExportErrorCode>([
  "asset_load_failed",
  "storage_write_failed",
  "renderer_failed",
  "encoder_failed",
  "export_interrupted",
]);

export class ReplayExportError extends Error {
  readonly code: ReplayExportErrorCode;
  /** Extra context for logs only; never rendered and never sent anywhere. */
  readonly detail?: string;

  constructor(code: ReplayExportErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "ReplayExportError";
    this.code = code;
    this.detail = detail;
  }
}

export function isReplayExportError(value: unknown): value is ReplayExportError {
  return value instanceof ReplayExportError;
}

/** Wraps anything thrown deeper in the pipeline under a known code. */
export function asReplayExportError(value: unknown, fallback: ReplayExportErrorCode): ReplayExportError {
  if (isReplayExportError(value)) return value;
  const detail = value instanceof Error ? value.message : typeof value === "string" ? value : undefined;
  return new ReplayExportError(fallback, detail, { cause: value });
}

export function isRetryableExportError(code: ReplayExportErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export function describeReplayExportError(code: ReplayExportErrorCode): MessageDescriptor {
  switch (code) {
    case "fast_export_unavailable":
      return msg`Fast export isn't available in this browser at this size. Try a lower preset or Smaller file.`;
    case "export_busy":
      return msg`Another replay video is still exporting. Finish or cancel it first.`;
    case "unsupported_video_codec":
      return msg`This browser can't encode video at the selected size and frame rate.`;
    case "unsupported_audio_codec":
      return msg`This browser can't encode the audio track for this format.`;
    case "unsupported_audio_decode":
      return msg`The song file can't be decoded here. Export without audio, or pick a shorter range.`;
    case "unsupported_pitch_processing":
      return msg`Keeping the pitch at this speed isn't supported here. Export at 1x, or let the pitch follow the speed.`;
    case "asset_load_failed":
      return msg`Some of the replay's files couldn't be loaded.`;
    case "asset_not_origin_clean":
      return msg`One of the images can't be recorded into a video because of its origin.`;
    case "resource_limit_exceeded":
      return msg`This export is too large for this browser. Pick a shorter range or a lower preset.`;
    case "invalid_range":
      return msg`That range is too short to export.`;
    case "storage_unavailable":
      return msg`This browser can't save the video file.`;
    case "storage_write_failed":
      return msg`Writing the video file failed.`;
    case "renderer_failed":
      return msg`The replay renderer stopped during the export.`;
    case "encoder_failed":
      return msg`The video encoder stopped during the export.`;
    case "export_interrupted":
      return msg`The export was interrupted before it finished.`;
  }
}
