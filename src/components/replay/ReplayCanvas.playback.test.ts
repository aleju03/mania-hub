import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";

// Exercise the real transport/tick/smoothing methods without initializing GPU
// resources. Rendering and score processing are irrelevant to the clock.
function createPlayback(readClock: () => { time: number; stalled: boolean }) {
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    _isPlaying: false,
    animFrameId: 0,
    currentTime: 10_000,
    totalDuration: 100_000,
    playbackSpeed: 1,
    modRate: 1.5,
    audioClockAnchorTime: null,
    audioClockAnchorNow: 0,
    externalClock: readClock,
    advanceStats: vi.fn(),
    fireHitsounds: vi.fn(),
    updateFpsCounter: vi.fn(),
    render: vi.fn(),
  }) as Pick<ManiaReplayRenderer, "play" | "pause"> & { currentTime: number; render: ReturnType<typeof vi.fn> };
}

describe("replay pause/resume timing", () => {
  let now: number;
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    now = 1_000;
    frameId = 0;
    frames = new Map();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function drawFrame() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }

  it("queues both sides before drawing the first resumed frame", () => {
    const clock = { time: 10_000, stalled: false };
    const sides = [createPlayback(() => clock), createPlayback(() => clock)];

    for (const side of sides) side.play();
    for (const side of sides) expect(side.render).not.toHaveBeenCalled();
    expect(frames.size).toBe(2);
    drawFrame();

    for (const side of sides) side.pause();
    expect(frames.size).toBe(0);
    now += 5_000;
    for (const side of sides) {
      side.render.mockClear();
      side.play();
      side.play(); // Repeated play must not create a second loop.
      expect(side.render).not.toHaveBeenCalled();
    }
    expect(frames.size).toBe(2);
    drawFrame();
    for (const side of sides) {
      expect(side.currentTime).toBe(clock.time);
      expect(side.render).toHaveBeenCalledTimes(1);
    }
  });

  it("does not count short pauses as playback time, including repeated resumes", () => {
    const clock = { time: 10_000, stalled: false };
    const renderer = createPlayback(() => clock);
    renderer.play();
    drawFrame();

    // Below the smoother's hard-correction threshold: stale anchors used to
    // count most of each pause as elapsed chart time.
    for (let repeat = 0; repeat < 5; repeat++) {
      renderer.pause();
      now += 40;
      renderer.play();
      drawFrame();
      expect(renderer.currentTime).toBe(clock.time);
      now += 16;
      clock.time += 24; // DT: 16ms of playback advances the chart by 24ms.
      drawFrame();
      expect(renderer.currentTime).toBe(clock.time);
    }
  });

  it("holds the paused frame while audio is starting, then follows the song", () => {
    const clock = { time: 10_000, stalled: false };
    const renderer = createPlayback(() => clock);
    renderer.play();
    drawFrame();
    renderer.pause();
    clock.stalled = true;
    now += 5_000;
    renderer.play();
    drawFrame();
    now += 100;
    drawFrame();
    expect(renderer.currentTime).toBe(10_000);
    clock.stalled = false;
    clock.time += 24;
    now += 16;
    drawFrame();
    expect(renderer.currentTime).toBe(clock.time);
  });
});
