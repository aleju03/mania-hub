// Offline time stretching for rate changes that must keep their pitch.
//
// This is WSOLA: overlap-add at a fixed synthesis hop, where each analysis
// window is nudged within a small search range to the position that lines up
// best with the previous segment's natural continuation. It runs
// single-threaded, needs no WASM, and is deterministic, which is what lets
// the timing tests below the pipeline assert on exact sample positions.
//
// Setting `AudioBufferSourceNode.playbackRate` is not an alternative here:
// that resamples, which moves the pitch. The resampler in `resample.ts` is
// the path for when the pitch is *supposed* to follow the rate.

import type { PcmWindow } from "./resample";

export type TimeStretcherOptions = {
  /** Output frames emitted per overlap-add step. Window length is twice this. */
  synthesisHop?: number;
  /** How far, in frames, a window may slide to find a better overlap. */
  searchRadius?: number;
  /** Source frame the first output frame is aligned to. */
  startFrame?: number;
};

const DEFAULT_SYNTHESIS_HOP = 512;
const DEFAULT_SEARCH_RADIUS = 128;
/** Correlation is decimated: quality barely moves, cost drops fourfold. */
const CORRELATION_STRIDE = 4;
const CORRELATION_LENGTH = 256;

function hannWindow(length: number): Float32Array {
  const values = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // Periodic Hann: with a hop of length/2 the overlapped windows sum to 1,
    // so no gain correction is needed after the overlap-add.
    values[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
  }
  return values;
}

export class TimeStretcher {
  private readonly hop: number;
  private readonly windowLength: number;
  private readonly searchRadius: number;
  private readonly hann: Float32Array;
  private readonly channels: number;
  private readonly analysisHop: number;

  /** Overlap-add remainder carried into the next step, per channel. */
  private readonly tail: Float32Array[];
  /** Natural continuation of the last accepted segment, mixed to mono. */
  private readonly template: Float32Array;
  private hasTemplate = false;
  /** The opening hop is copied straight through; see `produceStep`. */
  private firstStep = true;

  /** Output frames produced but not yet handed out, per channel. */
  private readonly pending: Float32Array[];
  private pendingStart = 0;
  private pendingEnd = 0;

  private analysisPosition: number;

  constructor(private readonly speed: number, channels: number, options: TimeStretcherOptions = {}) {
    if (!(speed > 0) || !Number.isFinite(speed)) {
      throw new RangeError("Time stretcher speed must be finite and positive.");
    }
    this.channels = channels;
    this.hop = Math.max(64, Math.floor(options.synthesisHop ?? DEFAULT_SYNTHESIS_HOP));
    this.windowLength = this.hop * 2;
    this.searchRadius = Math.max(0, Math.floor(options.searchRadius ?? DEFAULT_SEARCH_RADIUS));
    this.hann = hannWindow(this.windowLength);
    this.analysisHop = this.hop * speed;
    this.analysisPosition = options.startFrame ?? 0;
    this.tail = Array.from({ length: channels }, () => new Float32Array(this.hop));
    this.template = new Float32Array(CORRELATION_LENGTH);
    this.pending = Array.from({ length: channels }, () => new Float32Array(this.hop));
  }

  /** Highest source frame producing `outputFrames` more output can touch. */
  lookaheadFrames(outputFrames: number): number {
    const buffered = this.pendingEnd - this.pendingStart;
    const steps = Math.max(0, Math.ceil((outputFrames - buffered) / this.hop));
    const finalPosition = this.analysisPosition + this.analysisHop * steps;
    return Math.ceil(finalPosition) + this.searchRadius + this.windowLength + 2;
  }

  /** Earlier input can be released: pending output, overlap and template are already copied. */
  get earliestNeededFrame(): number {
    return Math.max(0, Math.floor(this.analysisPosition) - this.searchRadius);
  }

  process(window: PcmWindow, out: Float32Array[], offset: number, length: number): void {
    let written = 0;
    while (written < length) {
      if (this.pendingStart >= this.pendingEnd) {
        this.produceStep(window);
      }
      const take = Math.min(length - written, this.pendingEnd - this.pendingStart);
      for (let channel = 0; channel < out.length; channel++) {
        const source = this.pending[Math.min(channel, this.channels - 1)];
        out[channel].set(source.subarray(this.pendingStart, this.pendingStart + take), offset + written);
      }
      this.pendingStart += take;
      written += take;
    }
  }

  /** Mono mix at `frame`, used for the overlap search only. */
  private monoAt(window: PcmWindow, frame: number): number {
    if (this.channels === 1) return window.sample(0, frame);
    let total = 0;
    for (let channel = 0; channel < this.channels; channel++) {
      total += window.sample(Math.min(channel, window.channels - 1), frame);
    }
    return total / this.channels;
  }

  private findBestOffset(window: PcmWindow, center: number): number {
    if (!this.hasTemplate || this.searchRadius === 0 || this.speed === 1) return 0;
    let bestOffset = 0;
    let bestScore = -Infinity;
    for (let offset = -this.searchRadius; offset <= this.searchRadius; offset++) {
      let dot = 0;
      let energy = 0;
      for (let k = 0; k < CORRELATION_LENGTH; k += CORRELATION_STRIDE) {
        const value = this.monoAt(window, center + offset + k);
        dot += value * this.template[k];
        energy += value * value;
      }
      // Normalized correlation, so a loud passage doesn't always win.
      const score = dot / Math.sqrt(energy + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    return bestOffset;
  }

  private produceStep(window: PcmWindow): void {
    const center = Math.round(this.analysisPosition);
    const offset = this.findBestOffset(window, center);
    const start = center + offset;

    for (let channel = 0; channel < this.channels; channel++) {
      const sourceChannel = Math.min(channel, window.channels - 1);
      const output = this.pending[channel];
      const tail = this.tail[channel];
      for (let k = 0; k < this.hop; k++) {
        // There is no previous segment to overlap the opening hop with, so
        // windowing it would fade the first ten milliseconds of every clip
        // in. Take it flat; the overlap-add is exact from the next hop on.
        output[k] = this.firstStep
          ? window.sample(sourceChannel, start + k)
          : tail[k] + window.sample(sourceChannel, start + k) * this.hann[k];
      }
      for (let k = 0; k < this.hop; k++) {
        tail[k] = window.sample(sourceChannel, start + this.hop + k) * this.hann[this.hop + k];
      }
    }

    for (let k = 0; k < CORRELATION_LENGTH; k += CORRELATION_STRIDE) {
      this.template[k] = this.monoAt(window, start + this.hop + k);
    }
    this.hasTemplate = true;

    this.firstStep = false;
    this.pendingStart = 0;
    this.pendingEnd = this.hop;
    this.analysisPosition += this.analysisHop;
  }
}
