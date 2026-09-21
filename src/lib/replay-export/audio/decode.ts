// Getting the song out of its file and into the export's PCM window.
//
// The preferred path demuxes and decodes only the range the export needs, so
// a three-second clip from a nine-minute track costs three seconds of memory.
// The fallback decodes the whole file at once, which is why it is admitted
// only after the full decoded size has been budgeted, never after the clip
// length alone.

import { ReplayExportError } from "../errors";
import { REPLAY_EXPORT_SAMPLE_RATE, pcmByteLength } from "../limits";
import { SlidingPcmWindow, staticPcmWindow } from "./pcm-window";

export type SongPcmSource = {
  window: SlidingPcmWindow;
  /** Sample rate of the decoded source, which need not match the output. */
  sampleRate: number;
  channels: number;
  /** Absolute source frame the window starts at. */
  startFrame: number;
  /** Bytes the source expects to hold at peak. */
  estimatedBytes: number;
  close: () => Promise<void>;
};

export type OpenSongPcmOptions = {
  /** First source second the export reads. Decoding starts a little before. */
  startSeconds: number;
  /** Last source second the export reads. */
  endSeconds: number;
  /** Memory the whole-file fallback is allowed to allocate. */
  memoryBudgetBytes: number;
};

/** Decoded ahead of the clip so the stretcher's first window has real audio. */
const DECODE_PREROLL_SECONDS = 0.5;

type WholeFileAudioInfo = { durationSeconds: number; channels: number };

/** Allow for decoder padding when budgeting from packet timestamps. */
const WHOLE_FILE_PADDING_SECONDS = 1;

function toPlanar(sample: import("mediabunny").AudioSample): Float32Array[] {
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < sample.numberOfChannels; channel++) {
    const plane = new Float32Array(sample.numberOfFrames);
    sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
    planes.push(plane);
  }
  return planes;
}

async function openStreamingSource(
  file: Blob,
  options: OpenSongPcmOptions,
): Promise<SongPcmSource | WholeFileAudioInfo> {
  const { ALL_FORMATS, AudioSampleSink, BlobSource, Input } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let disposed = false;

  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      throw new ReplayExportError("unsupported_audio_decode", "No audio track available for this export.");
    }
    if (!(await track.canDecode())) {
      // Read compressed packet metadata, without decoding any PCM. Even a
      // late, short clip must budget the complete song for decodeAudioData.
      const [endSeconds, firstSeconds, channels] = await Promise.all([
        track.computeDuration(),
        track.getFirstTimestamp(),
        track.getNumberOfChannels(),
      ]);
      input.dispose();
      return { durationSeconds: endSeconds - Math.min(0, firstSeconds), channels };
    }

    const sampleRate = track.sampleRate;
    const channels = track.numberOfChannels;
    const from = Math.max(0, options.startSeconds - DECODE_PREROLL_SECONDS);
    const sink = new AudioSampleSink(track);
    const iterator = sink.samples(from, options.endSeconds + DECODE_PREROLL_SECONDS);

    const window = new SlidingPcmWindow(channels, async () => {
      if (disposed) return null;
      const next = await iterator.next();
      if (next.done || !next.value) return null;
      const sample = next.value;
      try {
        return {
          // Normalize against the file's own timeline: a track whose first
          // packet does not sit at zero must not shift the whole song.
          startFrame: Math.round(sample.timestamp * sampleRate),
          data: toPlanar(sample),
        };
      } finally {
        sample.close();
      }
    }, Math.round(from * sampleRate));

    return {
      window,
      sampleRate,
      channels,
      startFrame: Math.round(from * sampleRate),
      // A handful of decoded packets plus the decoder's own queue.
      estimatedBytes: pcmByteLength(2, sampleRate, channels),
      close: async () => {
        disposed = true;
        window.release();
        await iterator.return(undefined).catch(() => {});
        input.dispose();
      },
    };
  } catch (error) {
    input.dispose();
    throw new ReplayExportError(
      "unsupported_audio_decode",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

async function openWholeFileSource(
  file: Blob,
  options: OpenSongPcmOptions,
  info: WholeFileAudioInfo,
): Promise<SongPcmSource> {
  const OfflineCtor = typeof globalThis.OfflineAudioContext === "function"
    ? globalThis.OfflineAudioContext
    : undefined;
  if (!OfflineCtor) {
    throw new ReplayExportError("unsupported_audio_decode", "No audio decoder is available here.");
  }

  if (!Number.isFinite(info.durationSeconds) || info.durationSeconds <= 0
    || !Number.isSafeInteger(info.channels) || info.channels <= 0) {
    throw new ReplayExportError("unsupported_audio_decode", "Cannot safely determine the whole song's decoded size.");
  }
  // The retained Blob and its ArrayBuffer can coexist with the decoded PCM.
  // Web Audio resamples to the context rate, regardless of the input rate.
  const encodedBytes = file.size * 2;
  const predictedBytes = encodedBytes + pcmByteLength(
    info.durationSeconds + WHOLE_FILE_PADDING_SECONDS,
    REPLAY_EXPORT_SAMPLE_RATE,
    info.channels,
  );
  if (predictedBytes > options.memoryBudgetBytes) {
    throw new ReplayExportError(
      "resource_limit_exceeded",
      `Whole-song decoding needs about ${predictedBytes} bytes, over the ${options.memoryBudgetBytes} byte budget.`,
    );
  }

  // Only allocate the full input and invoke the native decoder after admission.
  const bytes = await file.arrayBuffer();
  const context = new OfflineCtor(2, 1, REPLAY_EXPORT_SAMPLE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(bytes);
  } catch (error) {
    throw new ReplayExportError(
      "unsupported_audio_decode",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const estimatedBytes = encodedBytes + buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (estimatedBytes > options.memoryBudgetBytes) {
    throw new ReplayExportError(
      "resource_limit_exceeded",
      `Decoded song needs ${estimatedBytes} bytes, over the ${options.memoryBudgetBytes} byte budget.`,
    );
  }

  const planes: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    // This buffer belongs to the export. Retain its planes directly instead
    // of allocating a second complete copy of the decoded song.
    planes.push(buffer.getChannelData(channel));
  }
  const window = staticPcmWindow(planes, 0);
  return {
    window,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    startFrame: 0,
    estimatedBytes,
    close: async () => {
      window.release();
    },
  };
}

/**
 * Opens the song for the selected range, preferring the range-aware decoder.
 * Falls back when PCM streaming is unsupported but the demuxer can establish
 * the entire song's size before decode, and only within the memory budget.
 */
export async function openSongPcmSource(
  file: Blob,
  options: OpenSongPcmOptions,
): Promise<SongPcmSource> {
  const streamed = await openStreamingSource(file, options);
  if ("window" in streamed) return streamed;
  return openWholeFileSource(file, options, streamed);
}

/** Decodes a short sample (a hitsound) fully. Used for assets of a few KB. */
export async function decodeShortSample(
  bytes: ArrayBuffer,
  sampleRate: number,
): Promise<Float32Array[] | null> {
  const OfflineCtor = typeof globalThis.OfflineAudioContext === "function"
    ? globalThis.OfflineAudioContext
    : undefined;
  if (!OfflineCtor) return null;
  const context = new OfflineCtor(2, 1, sampleRate);
  try {
    // decodeAudioData detaches its input, so decode a copy: the same sample
    // bytes are shared with the viewer's own hitsound player.
    const buffer = await context.decodeAudioData(bytes.slice(0));
    const planes: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      planes.push(buffer.getChannelData(channel).slice());
    }
    // Resample to the output rate now: every sample is short, and doing it
    // once here keeps the mixer a pure add.
    if (buffer.sampleRate === sampleRate) return planes;
    const ratio = sampleRate / buffer.sampleRate;
    const length = Math.round(planes[0].length * ratio);
    return planes.map((plane) => {
      const out = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const position = i / ratio;
        const index = Math.floor(position);
        const fraction = position - index;
        const a = plane[index] ?? 0;
        const b = plane[index + 1] ?? a;
        out[i] = a + (b - a) * fraction;
      }
      return out;
    });
  } catch {
    return null;
  }
}
