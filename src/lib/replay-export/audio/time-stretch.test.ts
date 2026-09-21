import { describe, expect, it } from "vitest";

import { SlidingPcmWindow, staticPcmWindow } from "./pcm-window";
import { TimeStretcher } from "./time-stretch";

const SAMPLE_RATE = 48_000;

function tone(frames: number, hz: number): Float32Array {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  return data;
}

function zeroCrossingHz(signal: Float32Array, from = 0): number {
  let count = 0;
  for (let i = Math.max(1, from); i < signal.length; i++) {
    if ((signal[i - 1] < 0 && signal[i] >= 0) || (signal[i - 1] >= 0 && signal[i] < 0)) count++;
  }
  return (count / 2) * (SAMPLE_RATE / (signal.length - from));
}

function stretch(speed: number, source: Float32Array, outputFrames: number): Float32Array {
  const window = staticPcmWindow([source]);
  const stretcher = new TimeStretcher(speed, 1);
  const out = [new Float32Array(outputFrames)];
  stretcher.process(window, out, 0, outputFrames);
  return out[0];
}

describe("TimeStretcher", () => {
  it("passes the signal through at speed 1", () => {
    const source = tone(8192, 440);
    const out = stretch(1, source, 4096);
    for (let i = 0; i < 4096; i++) expect(out[i]).toBeCloseTo(source[i], 4);
  });

  it("keeps the pitch when it halves the duration", () => {
    // Two seconds of a 440 Hz tone rendered into one second of output.
    const source = tone(SAMPLE_RATE * 2, 440);
    const out = stretch(2, source, SAMPLE_RATE);
    // A resampler would have put this at 880 Hz; the stretcher must not.
    expect(zeroCrossingHz(out, 2048)).toBeGreaterThan(400);
    expect(zeroCrossingHz(out, 2048)).toBeLessThan(480);
  });

  it("keeps the pitch when it stretches the duration", () => {
    const source = tone(SAMPLE_RATE, 440);
    const out = stretch(0.75, source, Math.round(SAMPLE_RATE / 0.75) - 4096);
    expect(zeroCrossingHz(out, 2048)).toBeGreaterThan(400);
    expect(zeroCrossingHz(out, 2048)).toBeLessThan(480);
  });

  it("consumes source in proportion to the speed", () => {
    const source = tone(SAMPLE_RATE * 4, 440);
    const window = staticPcmWindow([source]);
    const stretcher = new TimeStretcher(1.5, 1);
    stretcher.process(window, [new Float32Array(24_000)], 0, 24_000);
    // 24,000 output frames at 1.5x should have walked ~36,000 source frames.
    expect(stretcher.lookaheadFrames(0)).toBeGreaterThan(35_000);
    expect(stretcher.lookaheadFrames(0)).toBeLessThan(38_000);
  });

  it("carries its state across block boundaries with no seam", () => {
    const source = tone(SAMPLE_RATE, 440);
    const single = stretch(1.25, source, 12_000);

    const window = staticPcmWindow([source]);
    const stretcher = new TimeStretcher(1.25, 1);
    const chunked = new Float32Array(12_000);
    const scratch = [chunked];
    let offset = 0;
    // Deliberately unaligned with the 512-frame synthesis hop.
    for (const size of [1000, 37, 4963, 6000]) {
      stretcher.process(window, scratch, offset, size);
      offset += size;
    }
    for (let i = 0; i < 12_000; i++) expect(chunked[i]).toBeCloseTo(single[i], 6);
  });

  it("does not fade the opening of a clip in", () => {
    const source = tone(SAMPLE_RATE, 440);
    const out = stretch(1.5, source, 4096);
    for (let i = 0; i < 128; i++) expect(out[i]).toBeCloseTo(source[i], 5);
  });

  it("holds level through the stretch rather than dipping between windows", () => {
    const source = tone(SAMPLE_RATE, 440);
    const out = stretch(1.4, source, 20_000);
    let peak = 0;
    for (let i = 5_000; i < 20_000; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(1.05);
  });

  it("refuses a speed that is not a positive number", () => {
    expect(() => new TimeStretcher(0, 2)).toThrow(RangeError);
    expect(() => new TimeStretcher(Number.NaN, 2)).toThrow(RangeError);
  });

  it.each([0.75, 1.5, 2.25])("releases consumed input at %sx without changing any output sample", async (speed) => {
    const source = tone(SAMPLE_RATE * 3, 440);
    const frames = Math.floor(source.length / speed) - 4096;
    const expected = stretch(speed, source, frames);
    let cursor = 0;
    const window = new SlidingPcmWindow(1, async () => {
      if (cursor >= source.length) return null;
      const startFrame = cursor;
      cursor += 512;
      return { startFrame, data: [source.slice(startFrame, cursor)] };
    });
    const stretcher = new TimeStretcher(speed, 1);
    const actual = new Float32Array(frames);
    for (let offset = 0; offset < frames; offset += 997) {
      const length = Math.min(997, frames - offset);
      await window.ensure(stretcher.lookaheadFrames(length));
      stretcher.process(window, [actual], offset, length);
      window.discardBefore(stretcher.earliestNeededFrame);
      expect(window.bufferedFrames).toBeLessThan(4096);
    }
    expect(actual).toEqual(expected);
  });
});
