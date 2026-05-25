import { describe, expect, it } from "vitest";
import { decodeStableManiaReplayFrames, MANIA_REPLAY_KEY_MASK, unpackReplayFrames } from "./replay-frames";

function b64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

describe("decodeStableManiaReplayFrames", () => {
  it("keeps mania key bits from mouseX's lower 20 bits", () => {
    const frames = decodeStableManiaReplayFrames([
      { time: 0, mouseX: (1 << 19) | (1 << 20), mouseY: 0, buttonState: 0 },
    ]);

    expect(frames).toEqual([{ time: 0, keyState: 1 << 19 }]);
    expect(frames[0].keyState).toBe(((1 << 19) | (1 << 20)) & MANIA_REPLAY_KEY_MASK);
  });

  it("removes stable dummy startup frames", () => {
    const frames = decodeStableManiaReplayFrames([
      { time: 0, mouseX: 256, mouseY: -500, buttonState: 0 },
      { time: 999, mouseX: 256, mouseY: -500, buttonState: 0 },
      { time: 1000, mouseX: 3, mouseY: 0, buttonState: 0 },
    ]);

    expect(frames).toEqual([{ time: 1000, keyState: 3 }]);
  });

  it("applies stable startup timestamp fixes before filtering backward frames", () => {
    const frames = decodeStableManiaReplayFrames([
      { time: 40, mouseX: 1, mouseY: 0, buttonState: 0 },
      { time: 20, mouseX: 2, mouseY: 0, buttonState: 0 },
      { time: 60, mouseX: 4, mouseY: 0, buttonState: 0 },
      { time: 55, mouseX: 8, mouseY: 0, buttonState: 0 },
    ]);

    expect(frames).toEqual([
      { time: 0, keyState: 1 },
      { time: 40, keyState: 2 },
      { time: 60, keyState: 4 },
    ]);
  });
});

describe("unpackReplayFrames", () => {
  it("unpacks 20-bit key states from Uint32 payloads", () => {
    const times = new Int32Array([1000]);
    const keys = new Uint32Array([1 << 19]);

    expect(unpackReplayFrames({
      count: 1,
      keys: b64(keys.buffer),
      times: b64(times.buffer),
    })).toEqual([{ time: 1000, keyState: 1 << 19 }]);
  });
});
