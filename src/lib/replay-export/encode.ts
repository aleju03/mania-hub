// Muxing the two tracks into the destination.
//
// Video frames and audio blocks are handed in as they are produced, in
// nearby media-time windows, so neither track's packets pile up waiting for
// the other to catch up. Timestamps come from the timeline's integer indices
// rather than from anything the encoder reports back.

import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import type { ReplayExportCodecPlan } from "./capabilities";
import type { ReplayExportDestination } from "./destinations";
import { ReplayExportError, asReplayExportError } from "./errors";
import { reservedPacketCounts } from "./limits";
import { QualityVideoSource } from "./quality-video-source";
import { REPLAY_EXPORT_KEYFRAME_SECONDS } from "./video-quality";
import type { ReplayExportSpecV1 } from "./render-spec";
import type { ReplayExportTimeline } from "./timeline";
import { frameOutputSeconds } from "./timeline";
import type { ReplayExportAudioBlock } from "./audio/pipeline";

export type ReplayExportEncoderOptions = {
  plan: ReplayExportCodecPlan;
  spec: ReplayExportSpecV1;
  timeline: ReplayExportTimeline;
  destination: ReplayExportDestination;
  canvas: HTMLCanvasElement;
};

export class ReplayExportEncoder {
  private readonly output: Output;
  private readonly videoSource: CanvasSource | QualityVideoSource["source"];
  private readonly qualityVideo: QualityVideoSource | null;
  private readonly audioSource: AudioSampleSource | null;
  private started = false;
  private settled = false;

  constructor(private readonly options: ReplayExportEncoderOptions) {
    const { plan, spec, timeline, destination } = options;

    const format = plan.container === "mp4"
      ? new Mp4OutputFormat({
          // The streaming path must not hold the whole file in memory to
          // move its metadata; reserving space up front does the same job.
          // The in-memory path already holds everything, so it can use the
          // simpler mode.
          fastStart: destination.kind === "file" ? "reserve" : "in-memory",
        })
      : new WebMOutputFormat();

    this.output = new Output({ format, target: destination.target });

    const reserved = reservedPacketCounts(
      timeline.frameCount,
      timeline.videoDurationSeconds,
      timeline.sampleRate,
    );
    const reserving = plan.container === "mp4" && destination.kind === "file";

    this.qualityVideo = plan.videoCodec === "av1" && plan.videoQuantizer !== undefined
      ? new QualityVideoSource(options.canvas, timeline.fps, plan.videoQuantizer)
      : null;
    this.videoSource = this.qualityVideo?.source ?? new CanvasSource(options.canvas, {
      codec: plan.videoCodec,
      bitrate: spec.output.videoBitrate,
      bitrateMode: "variable",
      latencyMode: "quality",
      keyFrameInterval: REPLAY_EXPORT_KEYFRAME_SECONDS,
      hardwareAcceleration: plan.hardwareAcceleration,
    });
    this.output.addVideoTrack(this.videoSource, {
      frameRate: timeline.fps,
      ...(reserving ? { maximumPacketCount: reserved.video } : {}),
    });

    this.audioSource = plan.audioCodec
      ? new AudioSampleSource({
          codec: plan.audioCodec,
          bitrate: spec.output.audioBitrate,
          // The samples already carry the channel count and rate; this only
          // pins them so a mismatch fails here rather than in the muxer.
          transform: {
            numberOfChannels: spec.output.channels,
            sampleRate: spec.output.sampleRate,
          },
        })
      : null;
    if (this.audioSource) {
      this.output.addAudioTrack(this.audioSource, {
        ...(reserving ? { maximumPacketCount: reserved.audio } : {}),
      });
    }
  }

  get hasAudioTrack(): boolean {
    return this.audioSource !== null;
  }

  async start(): Promise<void> {
    try {
      await this.output.start();
      this.started = true;
    } catch (error) {
      throw asReplayExportError(error, "encoder_failed");
    }
  }

  /**
   * Encodes whatever is currently on the export canvas as frame `index`.
   * Awaiting this is what applies encoder and writer backpressure, which is
   * the only thing bounding how many raw frames exist at once.
   */
  async addFrame(index: number): Promise<void> {
    try {
      if (this.qualityVideo) {
        await this.qualityVideo.addFrame(index);
      } else {
        await (this.videoSource as CanvasSource).add(
          frameOutputSeconds(this.options.timeline, index),
          this.options.timeline.frameDurationSeconds,
        );
      }
    } catch (error) {
      throw asReplayExportError(error, "encoder_failed");
    }
  }

  async addAudioBlock(block: ReplayExportAudioBlock): Promise<void> {
    const source = this.audioSource;
    if (!source) return;
    const { spec, timeline } = this.options;
    const channels = spec.output.channels;
    // AudioSample takes interleaved f32; the pipeline works in planes.
    const interleaved = new Float32Array(block.length * channels);
    for (let channel = 0; channel < channels; channel++) {
      const plane = block.data[Math.min(channel, block.data.length - 1)];
      for (let frame = 0; frame < block.length; frame++) {
        interleaved[frame * channels + channel] = plane[frame];
      }
    }
    // Timestamp from the block's integer sample cursor, never accumulated.
    const sample = new AudioSample({
      data: interleaved,
      format: "f32",
      numberOfChannels: channels,
      sampleRate: timeline.sampleRate,
      timestamp: block.startFrame / timeline.sampleRate,
    });
    try {
      await source.add(sample);
    } catch (error) {
      throw asReplayExportError(error, "encoder_failed");
    } finally {
      sample.close();
    }
  }

  /** Closes both sources and finalizes the container. */
  async finalize(): Promise<void> {
    if (this.settled) throw new ReplayExportError("encoder_failed", "Encoder already settled.");
    this.settled = true;
    try {
      if (this.qualityVideo) await this.qualityVideo.close();
      else this.videoSource.close();
      this.audioSource?.close();
      await this.output.finalize();
    } catch (error) {
      throw asReplayExportError(error, "encoder_failed");
    }
  }

  async cancel(): Promise<void> {
    await this.qualityVideo?.cancel();
    this.settled = true;
    if (!this.started) return;
    if (this.output.state === "pending" || this.output.state === "started") {
      await this.output.cancel().catch(() => {});
    }
  }
}
