// Fractional-rate resampling with state that survives across blocks.
//
// One instance covers both jobs the exporter needs: converting a song's own
// sample rate to the output rate, and speeding the song up or down when the
// pitch is meant to follow the rate. Both are the same operation with a
// different step size, so they are the same object.
//
// Reading position is kept as an integer frame plus a fractional remainder
// rather than an accumulating float, so a ten-minute export drifts by
// nothing.

export interface PcmWindow {
  /** Number of channels this window exposes. */
  readonly channels: number;
  /** First source frame currently readable. */
  readonly availableFrom: number;
  /** One past the last readable source frame. */
  readonly availableTo: number;
  /** True once no more source frames will ever arrive. */
  readonly ended: boolean;
  /** Reads one sample. Frames outside the available range read as silence. */
  sample(channel: number, frame: number): number;
}

/** Cubic Hermite through four neighbouring samples. */
function hermite(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

export class Resampler {
  /** Integer part of the next source frame to read. */
  private positionFrames = 0;
  /** Fractional part, in [0, 1). */
  private positionFraction = 0;
  private readonly stepFrames: number;
  private readonly stepFraction: number;
  /** Sub-samples averaged per output frame, to blunt aliasing when speeding up. */
  private readonly oversample: number;

  /**
   * @param step Source frames consumed per output frame. Above 1 the signal
   *   is sped up (and, on this path, pitched up with it).
   * @param startFrame Source frame the first output frame reads from.
   */
  constructor(step: number, startFrame = 0) {
    if (!(step > 0) || !Number.isFinite(step)) throw new RangeError("Resampler step must be finite and positive.");
    this.stepFrames = Math.floor(step);
    this.stepFraction = step - this.stepFrames;
    this.positionFrames = Math.floor(startFrame);
    this.positionFraction = startFrame - this.positionFrames;
    this.oversample = Math.min(4, Math.max(1, Math.ceil(step)));
  }

  /** Source frame the next output frame will read from, fractional part included. */
  get readPosition(): number {
    return this.positionFrames + this.positionFraction;
  }

  /** Highest source frame that producing `outputFrames` more output can touch. */
  lookaheadFrames(outputFrames: number): number {
    return Math.ceil(this.readPosition + (this.stepFrames + this.stepFraction) * (outputFrames + 1)) + 3;
  }

  /**
   * Fills `out` (planar, one Float32Array per channel) with `length` frames
   * starting at `offset`, advancing the read position.
   */
  process(window: PcmWindow, out: Float32Array[], offset: number, length: number): void {
    const subStep = 1 / this.oversample;
    for (let i = 0; i < length; i++) {
      const base = this.positionFrames;
      const frac = this.positionFraction;
      for (let channel = 0; channel < out.length; channel++) {
        const sourceChannel = Math.min(channel, window.channels - 1);
        let total = 0;
        for (let s = 0; s < this.oversample; s++) {
          // Spread the sub-samples across the span this output frame covers.
          const t = frac + s * subStep * (this.stepFrames + this.stepFraction);
          const whole = base + Math.floor(t);
          const fraction = t - Math.floor(t);
          total += hermite(
            window.sample(sourceChannel, whole - 1),
            window.sample(sourceChannel, whole),
            window.sample(sourceChannel, whole + 1),
            window.sample(sourceChannel, whole + 2),
            fraction,
          );
        }
        out[channel][offset + i] = total / this.oversample;
      }
      this.positionFrames += this.stepFrames;
      this.positionFraction += this.stepFraction;
      if (this.positionFraction >= 1) {
        const carry = Math.floor(this.positionFraction);
        this.positionFrames += carry;
        this.positionFraction -= carry;
      }
    }
  }
}
