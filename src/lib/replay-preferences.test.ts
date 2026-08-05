import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPLAY_BG_DIM,
  DEFAULT_REPLAY_VOLUME,
  DEFAULT_REPLAY_HITSOUND_VOLUME,
  REPLAY_BG_DIM_STORAGE_KEY,
  REPLAY_BEATMAP_HITSOUND_VOLUME_STORAGE_KEY,
  REPLAY_HITSOUND_VOLUME_STORAGE_KEY,
  REPLAY_SPECTATOR_NAME_CHANGE_EVENT,
  REPLAY_SPECTATOR_NAME_STORAGE_KEY,
  REPLAY_VOLUME_STORAGE_KEY,
  normalizeReplayBackgroundDim,
  normalizeReplayVolume,
  readReplayBackgroundDim,
  readReplayBeatmapHitsoundVolume,
  readReplaySpectatorNameShown,
  readReplayVolume,
  writeReplayBackgroundDim,
  writeReplaySpectatorNameShown,
  writeReplayVolume,
} from "./replay-preferences";

let dispatched: Event[] = [];

describe("replay preferences", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    dispatched = [];
    vi.stubGlobal("window", {
      localStorage: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
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

  it("falls back to the pre-split hitsound volume for the beatmap channel", () => {
    expect(readReplayBeatmapHitsoundVolume()).toBe(DEFAULT_REPLAY_HITSOUND_VOLUME);

    // A user who tuned the old single slider keeps that level on both channels.
    window.localStorage.setItem(REPLAY_HITSOUND_VOLUME_STORAGE_KEY, "0.35");
    expect(readReplayBeatmapHitsoundVolume()).toBe(0.35);

    // Once the split volume is stored, it wins over the legacy key.
    window.localStorage.setItem(REPLAY_BEATMAP_HITSOUND_VOLUME_STORAGE_KEY, "0.8");
    expect(readReplayBeatmapHitsoundVolume()).toBe(0.8);
  });

  it("watches anonymously until the viewer asks to be named", () => {
    expect(readReplaySpectatorNameShown()).toBe(false);

    writeReplaySpectatorNameShown(true);
    expect(window.localStorage.getItem(REPLAY_SPECTATOR_NAME_STORAGE_KEY)).toBe("true");
    expect(readReplaySpectatorNameShown()).toBe(true);
    // The settings drawer opens over a running replay, so the same tab has to
    // hear the flip: "storage" alone would only reach the other ones.
    expect(dispatched.map((event) => event.type)).toEqual([REPLAY_SPECTATOR_NAME_CHANGE_EVENT]);

    writeReplaySpectatorNameShown(false);
    expect(readReplaySpectatorNameShown()).toBe(false);
  });

  it("writes normalized preference values", () => {
    writeReplayVolume(1.5);
    writeReplayBackgroundDim(120);

    expect(window.localStorage.getItem(REPLAY_VOLUME_STORAGE_KEY)).toBe("1");
    expect(window.localStorage.getItem(REPLAY_BG_DIM_STORAGE_KEY)).toBe("100");
  });
});
