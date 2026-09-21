import { describe, expect, it } from "vitest";

import { staticPcmWindow } from "./pcm-window";
import { Resampler } from "./resample";

function tone(frames: number, hz: number, sampleRate: number): Float32Array {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return data;
}

function render(step: number, source: Float32Array[], frames: number, startFrame = 0): Float32Array {
  const window = staticPcmWindow(source);
  const resampler = new Resampler(step, startFrame);
  const out = [new Float32Array(frames)];
  resampler.process(window, out, 0, frames);
  return out[0];
}

describe("Resampler", () => {
  it("passes the signal through unchanged at step 1", () => {
    const source = tone(512, 440, 48_000);
    const out = render(1, [source], 256);
    for (let i = 0; i < 256; i++) expect(out[i]).toBeCloseTo(source[i], 5);
  });

  it("reads from the requested start frame", () => {
    const source = tone(512, 440, 48_000);
    const out = render(1, [source], 32, 100);
    expect(out[0]).toBeCloseTo(source[100], 5);
    expect(out[31]).toBeCloseTo(source[131], 5);
  });

  it("consumes source at the step rate", () => {
    const window = staticPcmWindow([tone(4096, 440, 48_000)]);
    const resampler = new Resampler(1.5);
    resampler.process(window, [new Float32Array(1000)], 0, 1000);
    expect(resampler.readPosition).toBeCloseTo(1500, 6);
  });

  it("does not drift when the step is fractional", () => {
    const window = staticPcmWindow([tone(200_000, 440, 48_000)]);
    const resampler = new Resampler(1.0001);
    const out = [new Float32Array(1024)];
    for (let block = 0; block < 100; block++) resampler.process(window, out, 0, 1024);
    // Position is carried as an integer plus a remainder, so 102,400 output
    // frames land exactly where the arithmetic says they should.
    expect(resampler.readPosition).toBeCloseTo(102_400 * 1.0001, 6);
  });

  it("produces the same output whether called in one block or many", () => {
    const source = [tone(8192, 600, 48_000)];
    const single = render(1.37, source, 1024);

    const window = staticPcmWindow(source);
    const resampler = new Resampler(1.37);
    const chunked = new Float32Array(1024);
    const scratch = [chunked];
    let offset = 0;
    for (const size of [100, 300, 24, 600]) {
      resampler.process(window, scratch, offset, size);
      offset += size;
    }
    for (let i = 0; i < 1024; i++) expect(chunked[i]).toBeCloseTo(single[i], 6);
  });

  it("reads silence past the end of the source", () => {
    const out = render(1, [tone(64, 440, 48_000)], 128);
    expect(out[100]).toBe(0);
  });

  it("raises the pitch when it speeds up, which is this path's whole point", () => {
    const sampleRate = 48_000;
    const source = [tone(48_000, 440, sampleRate)];
    const out = render(2, source, 12_000);
    expect(zeroCrossings(out) / (12_000 / sampleRate)).toBeGreaterThan(1500);
  });
});

function zeroCrossings(signal: Float32Array): number {
  let count = 0;
  for (let i = 1; i < signal.length; i++) {
    if ((signal[i - 1] < 0 && signal[i] >= 0) || (signal[i - 1] >= 0 && signal[i] < 0)) count++;
  }
  return count;
}
