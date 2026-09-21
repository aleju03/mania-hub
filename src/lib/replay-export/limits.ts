// Every numeric cap the local exporter enforces, in one place.
//
// These are starting product policies, not measured device capabilities. A
// device that fails below one of these caps is a reason to lower the cap, not
// to catch the failure somewhere else.

export type ReplayExportPresetId = "720p30" | "720p60" | "1080p30" | "1080p60";

export type ReplayExportPreset = {
  id: ReplayExportPresetId;
  /** Reference width for bitrate budgeting at 16:9; actual width follows the stage. */
  width: number;
  /** Actual encoded picture height, including for wide and portrait stages. */
  height: number;
  fps: number;
  /** Size estimate for quality encoding; target bitrate for compatibility encoders. */
  videoBitrate: number;
};

export const REPLAY_EXPORT_PRESETS: Record<ReplayExportPresetId, ReplayExportPreset> = {
  // AV1 quality encoding varies with the scene; these nominal rates budget
  // compressed output and serve as VBR targets on the compatibility path.
  "720p60": { id: "720p60", width: 1280, height: 720, fps: 60, videoBitrate: 1_500_000 },
  "720p30": { id: "720p30", width: 1280, height: 720, fps: 30, videoBitrate: 1_000_000 },
  "1080p60": { id: "1080p60", width: 1920, height: 1080, fps: 60, videoBitrate: 3_000_000 },
  "1080p30": { id: "1080p30", width: 1920, height: 1080, fps: 30, videoBitrate: 2_000_000 },
};

export const DEFAULT_REPLAY_EXPORT_PRESET: ReplayExportPresetId = "720p60";

/** Order the preset picker lists them in. */
export const REPLAY_EXPORT_PRESET_ORDER: ReplayExportPresetId[] = ["720p60", "720p30", "1080p60", "1080p30"];

/** Allow wide layouts at true 1080p, bounded to 4096×1080 at 60 FPS. */
export const MAX_EXPORT_WIDTH = 4096;
export const MAX_EXPORT_HEIGHT = 1080;
export const MAX_EXPORT_FPS = 60;

export const REPLAY_EXPORT_AUDIO_BITRATE = 128_000;
export const REPLAY_EXPORT_SAMPLE_RATE = 48_000;
export const REPLAY_EXPORT_CHANNELS = 2;

/** Default range choice: a 30-second clip from the current position. */
export const DEFAULT_EXPORT_CLIP_SECONDS = 30;

/** Headroom for muxing and VBR overshoot in admission checks, not the size shown in the UI. */
export const OUTPUT_SIZE_BUDGET_MARGIN = 0.25;

export type ReplayExportDestinationKind = "file" | "buffer";

export type ReplayExportAdmissionPolicy = {
  /** Longest output duration, in seconds. */
  maxOutputSeconds: number;
  /** Hard stop on bytes actually written. */
  maxOutputBytes: number;
};

export const REPLAY_EXPORT_ADMISSION: Record<ReplayExportDestinationKind, ReplayExportAdmissionPolicy> = {
  // Validated streaming file output.
  file: { maxOutputSeconds: 20 * 60, maxOutputBytes: 2 * 1024 * 1024 * 1024 },
  // In-memory output: the stricter of the two bounds applies.
  buffer: { maxOutputSeconds: 60, maxOutputBytes: 64 * 1024 * 1024 },
};

/**
 * Conservative budget for the allocations we can actually account for:
 * decoded PCM, retained asset bytes, and buffered output. Native encoder and
 * GPU allocations sit outside it and are not observable from here.
 */
export const REPLAY_EXPORT_WORKING_MEMORY_BUDGET = 256 * 1024 * 1024;

/** One second of PCM at a time, with a small bounded lookahead. */
export const AUDIO_BLOCK_SECONDS = 1;
export const AUDIO_BLOCK_LOOKAHEAD = 2;

/** Cooperative yield budget: how long rendering may hold the main thread. */
export const MAIN_THREAD_BUDGET_MS = 8;

export function pcmByteLength(seconds: number, sampleRate: number, channels: number): number {
  return Math.max(0, Math.ceil(seconds * sampleRate * channels * 4));
}

/** Expected compressed size at the target bitrates. Never a hard bound on VBR. */
export function estimateOutputBytes(
  outputSeconds: number,
  videoBitrate: number,
  audioBitrate: number,
): number {
  const bits = Math.max(0, outputSeconds) * (videoBitrate + audioBitrate);
  return Math.ceil(bits / 8);
}

/** Keep estimates and compatibility-encoder quality proportional to picture area. */
export function exportVideoBitrate(
  preset: ReplayExportPreset,
  output: { width: number; height: number },
): number {
  return Math.round(preset.videoBitrate * output.width * output.height / (preset.width * preset.height));
}

export type ReplayExportAdmissionInput = {
  destination: ReplayExportDestinationKind;
  outputSeconds: number;
  videoBitrate: number;
  audioBitrate: number;
  /** Decoded-song and retained-asset bytes the job expects to hold at once. */
  workingMemoryBytes: number;
};

export type ReplayExportAdmissionVerdict =
  | { ok: true; estimatedBytes: number }
  | { ok: false; reason: "duration" | "size" | "memory"; estimatedBytes: number; limit: number };

export function checkExportAdmission(input: ReplayExportAdmissionInput): ReplayExportAdmissionVerdict {
  const policy = REPLAY_EXPORT_ADMISSION[input.destination];
  const estimatedBytes = estimateOutputBytes(input.outputSeconds, input.videoBitrate, input.audioBitrate);
  const budgetedBytes = Math.ceil(estimatedBytes * (1 + OUTPUT_SIZE_BUDGET_MARGIN));

  if (input.outputSeconds > policy.maxOutputSeconds) {
    return { ok: false, reason: "duration", estimatedBytes, limit: policy.maxOutputSeconds };
  }
  if (budgetedBytes > policy.maxOutputBytes) {
    return { ok: false, reason: "size", estimatedBytes, limit: policy.maxOutputBytes };
  }
  // The in-memory path holds the whole file on top of its working set.
  const heldBytes = input.workingMemoryBytes + (input.destination === "buffer" ? budgetedBytes : 0);
  if (heldBytes > REPLAY_EXPORT_WORKING_MEMORY_BUDGET) {
    return { ok: false, reason: "memory", estimatedBytes, limit: REPLAY_EXPORT_WORKING_MEMORY_BUDGET };
  }
  return { ok: true, estimatedBytes };
}

/**
 * Upper bound on encoded packets per track, for MP4 `fastStart: "reserve"`.
 * Reserving too much only costs bytes in a box header; reserving too little
 * corrupts the file, so this carries the 33% headroom Mediabunny asks for on
 * top of counts that are already exact.
 */
export const RESERVED_PACKET_HEADROOM = 1.33;

export function reservedPacketCounts(
  frameCount: number,
  outputSeconds: number,
  sampleRate: number,
): { video: number; audio: number } {
  // AAC-LC packs 1024 frames per packet; the extra covers encoder priming
  // and the flush at the end.
  const audioPackets = Math.ceil((outputSeconds * sampleRate) / 1024) + 64;
  return {
    video: Math.ceil(frameCount * RESERVED_PACKET_HEADROOM) + 16,
    audio: Math.ceil(audioPackets * RESERVED_PACKET_HEADROOM),
  };
}
