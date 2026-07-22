// @vitest-environment jsdom
/* The audio graph used to be built on the first page turn, inside the flip
   engine's animation-end callback -- an AudioContext plus a second of
   Math.random() noise, right in the middle of the turn. Opening an album warms
   it instead, and that tap is still a user gesture so autoplay policy is met. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { warmPackAudio } from "./packSfx";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("warmPackAudio", () => {
  it("builds the context and the noise buffer up front, once", () => {
    const createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) => ({
      sampleRate,
      getChannelData: () => new Float32Array(length),
    }));
    const contexts = vi.fn();
    class AudioContextStub {
      state = "running";
      sampleRate = 48_000;
      destination = {};
      createBuffer = createBuffer;
      createGain = () => ({ gain: { value: 0 }, connect: () => {} });
      constructor() {
        contexts();
      }
    }
    vi.stubGlobal("AudioContext", AudioContextStub);

    warmPackAudio();
    expect(contexts).toHaveBeenCalledTimes(1);
    expect(createBuffer).toHaveBeenCalledTimes(1);
    // One second of noise at the context's rate.
    expect(createBuffer).toHaveBeenCalledWith(1, 48_000, 48_000);

    // Warm already: opening a second album must not rebuild anything.
    warmPackAudio();
    expect(contexts).toHaveBeenCalledTimes(1);
    expect(createBuffer).toHaveBeenCalledTimes(1);
  });
});
