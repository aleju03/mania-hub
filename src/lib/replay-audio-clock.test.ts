import { describe, expect, it } from "vitest";
import { readReplayAudioClock } from "./replay-audio-clock";

function audio(overrides: Partial<Parameters<typeof readReplayAudioClock>[0]> = {}) {
  return { currentTime: 12.5, paused: false, seeking: false, readyState: 4, error: null, ...overrides };
}

describe("replay audio clock", () => {
  it("follows healthy song audio in milliseconds", () => {
    expect(readReplayAudioClock(audio(), true)).toEqual({ time: 12_500, stalled: false });
  });

  it.each([
    { paused: true },
    { seeking: true },
    { readyState: 2 },
  ])("waits through temporary pauses/seeks/buffering: %j", (state) => {
    expect(readReplayAudioClock(audio(state), true)).toEqual({ time: 12_500, stalled: true });
  });

  it.each([2, 3, 4])("releases a failed network/decoder/source instead of buffering forever (code %i)", (code) => {
    const failed = audio({ paused: true, readyState: 0, error: { code } as MediaError });
    expect(readReplayAudioClock(failed, true)).toBeNull();
  });

  it("releases missing or disabled song audio", () => {
    expect(readReplayAudioClock(null, true)).toBeNull();
    expect(readReplayAudioClock(audio(), false)).toBeNull();
  });

  it("can follow a replacement source after the failed source is reset", () => {
    const element = audio({ error: { code: 2 } as MediaError });
    expect(readReplayAudioClock(element, true)).toBeNull();
    element.error = null;
    element.currentTime = 20;
    expect(readReplayAudioClock(element, true)).toEqual({ time: 20_000, stalled: false });
  });
});
