import { describe, expect, it } from "vitest";

import { SlidingPcmWindow, staticPcmWindow } from "./pcm-window";
import { SignalsmithTimeStretcher } from "./signalsmith";

const SAMPLE_RATE = 48_000;

function tone(frames: number, hz: number, amplitude = 1): Float32Array {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  return data;
}

function zeroCrossingHz(signal: Float32Array, from = 0): number {
  let count = 0;
  for (let i = Math.max(1, from); i < signal.length; i++) {
    if ((signal[i - 1] < 0 && signal[i] >= 0) || (signal[i - 1] >= 0 && signal[i] < 0)) count++;
  }
  return (count / 2) * (SAMPLE_RATE / (signal.length - from));
}

function rms(signal: Float32Array, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i++) total += signal[i] * signal[i];
  return Math.sqrt(total / (to - from));
}

/** Residual after a least-squares sine fit at `hz`, per 50 ms window, in dB below the tone. */
function toneDistortionDb(signal: Float32Array, hz: number, from: number, to: number): number {
  const span = SAMPLE_RATE / 20;
  let error = 0;
  let power = 0;
  for (let start = from; start + span <= to; start += span) {
    let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
    for (let i = 0; i < span; i++) {
      const phase = (2 * Math.PI * hz * i) / SAMPLE_RATE;
      const s = Math.sin(phase), c = Math.cos(phase), x = signal[start + i];
      ss += s * s; cc += c * c; sc += s * c; xs += x * s; xc += x * c;
    }
    const det = ss * cc - sc * sc;
    const a = (xs * cc - xc * sc) / det;
    const b = (xc * ss - xs * sc) / det;
    for (let i = 0; i < span; i++) {
      const phase = (2 * Math.PI * hz * i) / SAMPLE_RATE;
      const fit = a * Math.sin(phase) + b * Math.cos(phase);
      error += (signal[start + i] - fit) ** 2;
      power += fit * fit;
    }
  }
  return 10 * Math.log10(error / power);
}

async function stretch(speed: number, source: Float32Array, outputFrames: number): Promise<Float32Array> {
  const stretcher = await SignalsmithTimeStretcher.create(speed, 1, SAMPLE_RATE);
  const out = [new Float32Array(outputFrames)];
  stretcher.process(staticPcmWindow([source]), out, 0, outputFrames);
  return out[0];
}

describe("SignalsmithTimeStretcher", () => {
  it("keeps the pitch when it halves the duration", async () => {
    // Two seconds of a 440 Hz tone rendered into one second of output.
    const out = await stretch(2, tone(SAMPLE_RATE * 2, 440), SAMPLE_RATE);
    // A resampler would have put this at 880 Hz; the stretcher must not.
    expect(zeroCrossingHz(out, 2048)).toBeGreaterThan(430);
    expect(zeroCrossingHz(out, 2048)).toBeLessThan(450);
  });

  it("keeps the pitch when it stretches the duration", async () => {
    const out = await stretch(0.75, tone(SAMPLE_RATE, 440), Math.round(SAMPLE_RATE / 0.75) - 4096);
    expect(zeroCrossingHz(out, 2048)).toBeGreaterThan(430);
    expect(zeroCrossingHz(out, 2048)).toBeLessThan(450);
  });

  it.each([55, 110])("keeps a %s Hz bass tone clean at DT", async (hz) => {
    // The WSOLA stretcher this replaced left a 55 Hz tone buried under +13 dB of noise.
    const out = await stretch(1.5, tone(SAMPLE_RATE * 6, hz, 0.5), SAMPLE_RATE * 3);
    expect(toneDistortionDb(out, hz, SAMPLE_RATE / 2, SAMPLE_RATE * 3)).toBeLessThan(-30);
  });

  it.each([0.75, 1.5])("lines output up with the source at %sx", async (speed) => {
    // Clicks every half second from 1 s on must land at source time / speed.
    const source = new Float32Array(SAMPLE_RATE * 6);
    for (let t = SAMPLE_RATE; t < source.length; t += SAMPLE_RATE / 2) source[t] = 1;
    const out = await stretch(speed, source, Math.floor(source.length / speed) - SAMPLE_RATE);
    for (const sourceSeconds of [1, 1.5, 2, 2.5]) {
      const expected = Math.round((sourceSeconds * SAMPLE_RATE) / speed);
      let peak = expected - 480;
      for (let i = expected - 480; i <= expected + 480; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
      expect(Math.abs(peak - expected)).toBeLessThan(96); // 2 ms
    }
  });

  it("consumes source in proportion to the speed", async () => {
    const stretcher = await SignalsmithTimeStretcher.create(1.5, 1, SAMPLE_RATE);
    stretcher.process(staticPcmWindow([tone(SAMPLE_RATE * 4, 440)]), [new Float32Array(24_000)], 0, 24_000);
    // 24,000 output frames at 1.5x walk 36,000 source frames past the opening latency.
    const walked = stretcher.earliestNeededFrame;
    expect(walked).toBeGreaterThan(36_000);
    expect(walked).toBeLessThan(36_000 + 2 * SAMPLE_RATE * 0.12);
  });

  it("carries its state across block boundaries with no seam", async () => {
    const source = tone(SAMPLE_RATE, 440);
    const single = await stretch(1.25, source, 12_000);
    const stretcher = await SignalsmithTimeStretcher.create(1.25, 1, SAMPLE_RATE);
    const chunked = new Float32Array(12_000);
    let offset = 0;
    for (const size of [1000, 37, 4963, 6000]) {
      stretcher.process(staticPcmWindow([source]), [chunked], offset, size);
      offset += size;
    }
    for (let i = 0; i < 12_000; i++) expect(chunked[i]).toBeCloseTo(single[i], 2);
  });

  it("does not fade the opening of a clip in", async () => {
    const out = await stretch(1.5, tone(SAMPLE_RATE, 440), 4096);
    // A full-scale sine has an RMS of 0.707.
    expect(rms(out, 0, 480)).toBeGreaterThan(0.6);
  });

  it("holds level through the stretch", async () => {
    const out = await stretch(1.4, tone(SAMPLE_RATE, 440), 20_000);
    expect(rms(out, 5_000, 20_000)).toBeGreaterThan(0.6);
    expect(rms(out, 5_000, 20_000)).toBeLessThan(0.8);
  });

  it("refuses a speed that is not a positive number", async () => {
    await expect(SignalsmithTimeStretcher.create(0, 2, SAMPLE_RATE)).rejects.toThrow(RangeError);
    await expect(SignalsmithTimeStretcher.create(Number.NaN, 2, SAMPLE_RATE)).rejects.toThrow(RangeError);
  });

  it.each([0.75, 1.5, 2.25])("releases consumed input at %sx without changing any output sample", async (speed) => {
    const source = tone(SAMPLE_RATE * 3, 440);
    const frames = Math.floor(source.length / speed) - 8192;
    const expected = new Float32Array(frames);
    const reference = await SignalsmithTimeStretcher.create(speed, 1, SAMPLE_RATE);
    for (let offset = 0; offset < frames; offset += 997) {
      reference.process(staticPcmWindow([source]), [expected], offset, Math.min(997, frames - offset));
    }
    let cursor = 0;
    const window = new SlidingPcmWindow(1, async () => {
      if (cursor >= source.length) return null;
      const startFrame = cursor;
      cursor += 512;
      return { startFrame, data: [source.slice(startFrame, cursor)] };
    });
    const stretcher = await SignalsmithTimeStretcher.create(speed, 1, SAMPLE_RATE);
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
