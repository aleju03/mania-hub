import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPLAY_BG_DIM,
  DEFAULT_REPLAY_VOLUME,
  REPLAY_BG_DIM_STORAGE_KEY,
  REPLAY_VOLUME_STORAGE_KEY,
  normalizeReplayBackgroundDim,
  normalizeReplayVolume,
  readReplayBackgroundDim,
  readReplayVolume,
  writeReplayBackgroundDim,
  writeReplayVolume,
} from "./replay-preferences";

describe("replay preferences", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses replay defaults for missing persisted volume and background dim", () => {
    expect(readReplayVolume()).toBe(DEFAULT_REPLAY_VOLUME);
    expect(readReplayBackgroundDim()).toBe(DEFAULT_REPLAY_BG_DIM);
  });

  it("does not treat null or empty persisted values as zero", () => {
    expect(normalizeReplayVolume(null)).toBe(DEFAULT_REPLAY_VOLUME);
    expect(normalizeReplayVolume("")).toBe(DEFAULT_REPLAY_VOLUME);
    expect(normalizeReplayBackgroundDim(null)).toBe(DEFAULT_REPLAY_BG_DIM);
    expect(normalizeReplayBackgroundDim(" ")).toBe(DEFAULT_REPLAY_BG_DIM);
  });

  it("still allows deliberate zero values", () => {
    expect(normalizeReplayVolume(0)).toBe(0);
    expect(normalizeReplayVolume("0")).toBe(0);
    expect(normalizeReplayBackgroundDim(0)).toBe(0);
    expect(normalizeReplayBackgroundDim("0")).toBe(0);
  });

  it("writes normalized preference values", () => {
    writeReplayVolume(1.5);
    writeReplayBackgroundDim(120);

    expect(window.localStorage.getItem(REPLAY_VOLUME_STORAGE_KEY)).toBe("1");
    expect(window.localStorage.getItem(REPLAY_BG_DIM_STORAGE_KEY)).toBe("100");
  });
});
