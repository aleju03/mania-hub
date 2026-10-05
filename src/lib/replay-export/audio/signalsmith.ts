// Pitch-preserving rate changes for the export, on Signalsmith Stretch.
//
// The stretcher is a phase vocoder compiled to WASM. Each call takes N input
// frames and returns M output frames, so the rate is the ratio of the two and
// the pipeline can keep pulling one block at a time. It is primed with a
// single seek over its input latency; from then on the output trails the
// source by exactly its output latency, and those frames are dropped so that
// output frame 0 lines up with source frame `startFrame`.
//
// An in-house WSOLA stretcher did this job before. Its 2.7ms search could not
// reach a matching phase on bass notes (a 55 Hz cycle is 18ms), so kicks and
// bass came out buzzy and the rest grainy on every DT/HT export.

import type { PcmWindow } from "./resample";
import type { SignalsmithStretchModule } from "./vendor/signalsmith-stretch";

/** The library's own Web Audio node uses this tonality limit. */
const TONALITY_LIMIT_HZ = 8000;

export type SignalsmithTimeStretcherOptions = {
  /** Source frame the first output frame is aligned to. */
  startFrame?: number;
};

export class SignalsmithTimeStretcher {
  private readonly inputLatency: number;
  private readonly bufferLength: number;
  private readonly bufferPointer: number;
  /** Most output frames one call can produce without overrunning the input buffer. */
  private readonly maxOutputPerCall: number;

  /** Next source frame to hand the stretcher. */
  private inputPosition: number;
  /** Fractional source frame carried between calls, in [0, 1). */
  private inputFraction = 0;
  private primed = false;
  /** Output frames still owed to the stretcher's latency before real output starts. */
  private latencyToDrop: number;

  static async create(
    speed: number,
    channels: number,
    sampleRate: number,
    options: SignalsmithTimeStretcherOptions = {},
  ): Promise<SignalsmithTimeStretcher> {
    if (!(speed > 0) || !Number.isFinite(speed)) {
      throw new RangeError("Time stretcher speed must be finite and positive.");
    }
    const { default: createModule } = await import("./vendor/signalsmith-stretch");
    return new SignalsmithTimeStretcher(await createModule(), speed, channels, sampleRate, options.startFrame ?? 0);
  }

  private constructor(
    private readonly module: SignalsmithStretchModule,
    private readonly speed: number,
    private readonly channels: number,
    sampleRate: number,
    startFrame: number,
  ) {
    module._presetDefault(channels, sampleRate);
    module._setTransposeSemitones(0, TONALITY_LIMIT_HZ / sampleRate);
    module._setFormantSemitones(0, false);
    module._setFormantBase(0);
    this.inputLatency = module._inputLatency();
    this.latencyToDrop = module._outputLatency();
    this.bufferLength = this.inputLatency + this.latencyToDrop;
    this.bufferPointer = module._setBuffers(channels, this.bufferLength);
    this.maxOutputPerCall = Math.max(1, Math.min(this.bufferLength, Math.floor((this.bufferLength - 1) / speed)));
    this.inputPosition = Math.floor(startFrame);
  }

  /** Highest source frame producing `outputFrames` more output can touch. */
  lookaheadFrames(outputFrames: number): number {
    const priming = this.primed ? 0 : this.inputLatency;
    const consumed = (outputFrames + this.latencyToDrop) * this.speed + this.inputFraction;
    return this.inputPosition + priming + Math.ceil(consumed) + 1;
  }

  /** Everything before this has already been copied into the stretcher. */
  get earliestNeededFrame(): number {
    return this.inputPosition;
  }

  process(window: PcmWindow, out: Float32Array[], offset: number, length: number): void {
    if (!this.primed) {
      this.feed(window, this.inputLatency);
      this.module._seek(this.inputLatency, this.speed);
      this.primed = true;
    }
    let written = 0;
    while (written < length) {
      const dropping = this.latencyToDrop > 0;
      const frames = Math.min(dropping ? this.latencyToDrop : length - written, this.maxOutputPerCall);
      const exact = frames * this.speed + this.inputFraction;
      const inputFrames = Math.floor(exact);
      this.inputFraction = exact - inputFrames;
      this.feed(window, inputFrames);
      this.module._process(inputFrames, frames);
      if (dropping) {
        this.latencyToDrop -= frames;
        continue;
      }
      for (let channel = 0; channel < out.length; channel++) {
        const source = this.view(this.channels + Math.min(channel, this.channels - 1), frames);
        out[channel].set(source, offset + written);
      }
      written += frames;
    }
  }

  /** Copies the next `frames` source frames into the stretcher's input buffers. */
  private feed(window: PcmWindow, frames: number): void {
    for (let channel = 0; channel < this.channels; channel++) {
      const sourceChannel = Math.min(channel, window.channels - 1);
      const input = this.view(channel, frames);
      for (let i = 0; i < frames; i++) input[i] = window.sample(sourceChannel, this.inputPosition + i);
    }
    this.inputPosition += frames;
  }

  /** Buffer `index` is input channel `index`, or output channel `index - channels`. */
  private view(index: number, frames: number): Float32Array {
    // Re-read the memory each time: a grown WASM heap detaches old views.
    const memory = this.module.exports ? this.module.exports.memory.buffer : this.module.HEAP8.buffer;
    return new Float32Array(memory, this.bufferPointer + index * this.bufferLength * 4, frames);
  }
}
