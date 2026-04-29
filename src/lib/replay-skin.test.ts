import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  REPLAY_SKIN_STORAGE_KEY,
  normalizeReplaySkinSettings,
  readReplaySkinSettings,
  writeReplaySkinSettings,
} from "./replay-skin";

describe("replay skin settings", () => {
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

  it("uses bar defaults that preserve the existing replay skin", () => {
    expect(DEFAULT_REPLAY_SKIN_SETTINGS).toEqual({
      version: 1,
      style: "bars",
      tapColor: "#9cf2ae",
      lnHeadColor: "#dfffe6",
      lnBodyColor: "#8b8b93",
      percy: false,
    });
  });

  it("normalizes partial persisted settings over defaults", () => {
    expect(normalizeReplaySkinSettings({
      style: "circles",
      tapColor: "#ABC",
      percy: true,
    })).toEqual({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      style: "circles",
      tapColor: "#aabbcc",
      percy: true,
    });
  });

  it("falls back per field for invalid persisted values", () => {
    expect(normalizeReplaySkinSettings({
      version: 2,
      style: "arrows",
      tapColor: "green",
      lnHeadColor: "#12345",
      lnBodyColor: "#123456",
      percy: "yes",
    })).toEqual({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      lnBodyColor: "#123456",
    });
  });

  it("reads and writes settings through localStorage", () => {
    window.localStorage.clear();

    writeReplaySkinSettings({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      style: "circles",
      tapColor: "#101820",
      lnHeadColor: "#f2aa4c",
      percy: true,
    });

    expect(JSON.parse(window.localStorage.getItem(REPLAY_SKIN_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      style: "circles",
      tapColor: "#101820",
      lnHeadColor: "#f2aa4c",
      lnBodyColor: "#8b8b93",
      percy: true,
    });
    expect(readReplaySkinSettings()).toEqual({
      version: 1,
      style: "circles",
      tapColor: "#101820",
      lnHeadColor: "#f2aa4c",
      lnBodyColor: "#8b8b93",
      percy: true,
    });
  });

  it("returns defaults when storage cannot be parsed", () => {
    window.localStorage.setItem(REPLAY_SKIN_STORAGE_KEY, "{nope");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readReplaySkinSettings()).toEqual(DEFAULT_REPLAY_SKIN_SETTINGS);

    expect(warn).toHaveBeenCalledOnce();
  });
});
