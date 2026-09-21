// The export's audio track, produced one bounded block at a time.
//
//   song bytes -> range decode -> rate/pitch processing -> song samples
//   replay events -> hitsound schedule -> voice mixing -> hitsound samples
//   both -> gain and mix at the output rate -> ~1 second PCM blocks
//
// One integer output-sample cursor runs across the whole export, and every
// DSP stage keeps its state between blocks, so there are no seams at block
// boundaries and no drift at the end of a long track.

import { ReplayExportError } from "../errors";
import { AUDIO_BLOCK_SECONDS } from "../limits";
import type { ReplayExportSpecV1 } from "../render-spec";
import type { ReplayExportTimeline } from "../timeline";
import { audioBlockRanges } from "../timeline";
import type { ReplayHitsoundSchedule } from "../../replay-types";
import { openSongPcmSource, type SongPcmSource } from "./decode";
import { HitsoundMixer, buildHitsoundVoices } from "./hitsounds";
import { SlidingPcmWindow } from "./pcm-window";
import { Resampler, type PcmWindow } from "./resample";
import { TimeStretcher } from "./time-stretch";

export type ReplayExportAudioBlock = {
  /** Planar Float32 output, one array per channel. */
  data: Float32Array[];
  /** Absolute output PCM frame of `data[*][0]`. */
  startFrame: number;
  length: number;
};

export type ReplayExportAudioWarning = "song-missing" | "hitsound-samples-missing";

type SongStage = {
  source: SongPcmSource;
  /** Reads output-rate song frames into a block. */
  render: (out: Float32Array[], offset: number, length: number) => Promise<void>;
  close: () => Promise<void>;
};

/** Frames the intermediate resampled stage produces per pull. */
const INTERMEDIATE_BLOCK_FRAMES = 4096;
/** Source frames kept behind the read head for the interpolator's neighbours. */
const RETAIN_BEHIND_FRAMES = 64;

function createIntermediateWindow(
  source: SlidingPcmWindow,
  resampler: Resampler,
  channels: number,
): SlidingPcmWindow {
  let produced = 0;
  return new SlidingPcmWindow(channels, async () => {
    const needed = resampler.lookaheadFrames(INTERMEDIATE_BLOCK_FRAMES);
    await source.ensure(needed);
    if (source.ended && resampler.readPosition >= source.availableTo) return null;
    const data = Array.from({ length: channels }, () => new Float32Array(INTERMEDIATE_BLOCK_FRAMES));
    resampler.process(source, data, 0, INTERMEDIATE_BLOCK_FRAMES);
    source.discardBefore(Math.floor(resampler.readPosition) - RETAIN_BEHIND_FRAMES);
    const chunk = { startFrame: produced, data };
    produced += INTERMEDIATE_BLOCK_FRAMES;
    return chunk;
  }, 0);
}

async function createSongStage(
  songFile: Blob,
  spec: ReplayExportSpecV1,
  timeline: ReplayExportTimeline,
  memoryBudgetBytes: number,
): Promise<SongStage> {
  const startSeconds = timeline.startMs / 1000;
  const endSeconds = timeline.endMs / 1000;
  const source = await openSongPcmSource(songFile, {
    startSeconds,
    endSeconds,
    memoryBudgetBytes,
  });

  const outputChannels = spec.output.channels;
  const rate = timeline.rate;
  const srcToOut = source.sampleRate / timeline.sampleRate;
  const startSourceFrame = startSeconds * source.sampleRate;

  if (spec.playback.pitchPolicy === "preserved" && rate !== 1) {
    // Sample-rate conversion first, then a pitch-preserving stretch at the
    // output rate. Assigning a playback rate here would move the pitch,
    // which is the behavior this branch exists to avoid.
    const toOutputRate = new Resampler(srcToOut, startSourceFrame);
    const intermediate = createIntermediateWindow(source.window, toOutputRate, outputChannels);
    let stretcher: TimeStretcher;
    try {
      stretcher = new TimeStretcher(rate, outputChannels, { startFrame: 0 });
    } catch (error) {
      await source.close();
      throw new ReplayExportError(
        "unsupported_pitch_processing",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    return {
      source,
      render: async (out, offset, length) => {
        await intermediate.ensure(stretcher.lookaheadFrames(length));
        stretcher.process(intermediate, out, offset, length);
        intermediate.discardBefore(stretcher.earliestNeededFrame);
      },
      close: async () => {
        intermediate.release();
        await source.close();
      },
    };
  }

  // Pitch follows the rate: one resampler covers both the rate change and
  // the sample-rate conversion.
  const combined = new Resampler(rate * srcToOut, startSourceFrame);
  const window: PcmWindow = source.window;
  return {
    source,
    render: async (out, offset, length) => {
      await source.window.ensure(combined.lookaheadFrames(length));
      combined.process(window, out, offset, length);
      source.window.discardBefore(Math.floor(combined.readPosition) - RETAIN_BEHIND_FRAMES);
    },
    close: async () => {
      await source.close();
    },
  };
}

export class ReplayExportAudioPipeline {
  private readonly blocks: Generator<{ start: number; end: number; length: number }, void, unknown>;
  private closed = false;

  private constructor(
    private readonly spec: ReplayExportSpecV1,
    timeline: ReplayExportTimeline,
    private readonly song: SongStage | null,
    private readonly hitsounds: HitsoundMixer,
    readonly warnings: ReplayExportAudioWarning[],
  ) {
    this.blocks = audioBlockRanges(timeline, Math.round(AUDIO_BLOCK_SECONDS * timeline.sampleRate));
  }

  static async create(options: {
    spec: ReplayExportSpecV1;
    timeline: ReplayExportTimeline;
    songFile: Blob | null;
    schedule: ReplayHitsoundSchedule;
    samples: ReadonlyMap<string, ArrayBuffer>;
    memoryBudgetBytes: number;
  }): Promise<ReplayExportAudioPipeline> {
    const { spec, timeline, songFile, schedule, samples, memoryBudgetBytes } = options;
    const warnings: ReplayExportAudioWarning[] = [];

    let song: SongStage | null = null;
    if (spec.audio.songEnabled) {
      if (!songFile) {
        // The user asked for music and there is none. Say so rather than
        // shipping a silent video as a success.
        throw new ReplayExportError("asset_load_failed", "The song file was not available for this export.");
      }
      song = await createSongStage(songFile, spec, timeline, memoryBudgetBytes);
    }

    const { voices, missingKeys } = await buildHitsoundVoices({
      schedule,
      spec: spec.audio,
      timeline,
      samples,
    });
    if (missingKeys.length > 0) warnings.push("hitsound-samples-missing");

    return new ReplayExportAudioPipeline(spec, timeline, song, new HitsoundMixer(voices), warnings);
  }

  /** Next block of output PCM, or null once the timeline is covered. */
  async next(): Promise<ReplayExportAudioBlock | null> {
    if (this.closed) return null;
    const step = this.blocks.next();
    if (step.done || !step.value) return null;
    const { start, end, length } = step.value;

    const channels = this.spec.output.channels;
    const data = Array.from({ length: channels }, () => new Float32Array(length));

    if (this.song) {
      await this.song.render(data, 0, length);
      const gain = this.spec.audio.songVolume;
      if (gain !== 1) {
        for (const plane of data) {
          for (let i = 0; i < length; i++) plane[i] *= gain;
        }
      }
    }

    this.hitsounds.mix(data, start, end);

    for (const plane of data) {
      for (let i = 0; i < length; i++) {
        // Hard limit rather than let a dense chord wrap around in the encoder.
        const value = plane[i];
        if (value > 1) plane[i] = 1;
        else if (value < -1) plane[i] = -1;
      }
    }

    return { data, startFrame: start, length };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.song?.close();
  }
}
