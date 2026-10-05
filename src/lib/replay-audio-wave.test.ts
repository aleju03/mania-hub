import { describe, expect, it } from "vitest";
import { decodeReplayAudioWave, sampleReplayAudioWave } from "./replay-audio-wave";

function encode(fps: number, bands: number, levels: number[]): Uint8Array {
  const bytes = new Uint8Array(12 + levels.length);
  bytes.set([77, 72, 87, 49, fps, bands]);
  new DataView(bytes.buffer).setUint32(8, levels.length / bands, true);
  bytes.set(levels, 12);
  return bytes;
}

describe("replay audio wave", () => {
  it("reads the backend's table and blends between frames", () => {
    const wave = decodeReplayAudioWave(encode(10, 2, [0, 255, 255, 0]))!;
    expect(wave).toMatchObject({ fps: 10, bands: 2 });
    expect(Array.from(sampleReplayAudioWave(wave, 50, new Float32Array(2)))).toEqual([0.5, 0.5]);
    expect(Array.from(sampleReplayAudioWave(wave, 5_000, new Float32Array(2)))).toEqual([1, 0]);
  });

  it("refuses anything that is not a whole table", () => {
    expect(decodeReplayAudioWave(new Uint8Array(4))).toBeNull();
    expect(decodeReplayAudioWave(encode(10, 2, [0, 255, 255]))).toBeNull();
  });
});
