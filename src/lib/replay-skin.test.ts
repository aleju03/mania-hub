import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  REPLAY_SKIN_STORAGE_KEY,
  getReplaySkinColumnColor,
  getReplaySkinProfile,
  normalizeReplaySkinSettings,
  osuManiaHitPositionToReplayHitPosition,
  readReplaySkinSettings,
  replayHitPositionToOsuManiaHitPosition,
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
      version: 2,
      style: "bars",
      tapColor: "#9cf2ae",
      tapColors: [],
      lnHeadColor: "#dfffe6",
      lnHeadColors: [],
      lnBodyColor: "#8b8b93",
      percy: false,
      upscroll: false,
      keysUnderNotes: false,
      columnWidth: 50,
      columnSpacing: 0,
      noteHeightScale: 50,
      hitPosition: 110,
      scorePosition: 438,
      comboPosition: 485,
      keymodeProfiles: {},
    });
  });

  it("normalizes partial persisted settings over defaults", () => {
    expect(normalizeReplaySkinSettings({
      style: "circles",
      tapColor: "#ABC",
      tapColors: ["#fff", "nope", "#123456"],
      percy: true,
    })).toEqual({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      style: "circles",
      tapColor: "#aabbcc",
      tapColors: ["#ffffff", "", "#123456"],
      columnWidth: 50,
      columnSpacing: 0,
      hitPosition: 110,
      percy: true,
    });
  });

  it("falls back per field for invalid persisted values", () => {
    expect(normalizeReplaySkinSettings({
      version: 2,
      style: "diamonds",
      tapColor: "green",
      tapColors: "blue",
      lnHeadColor: "#12345",
      lnHeadColors: ["#456"],
      lnBodyColor: "#123456",
      percy: "yes",
      upscroll: "yes",
      hitPosition: 900,
    })).toEqual({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      lnHeadColors: ["#445566"],
      lnBodyColor: "#123456",
      hitPosition: 768,
    });
  });

  it("migrates legacy percent column widths to skin.ini-style pixels", () => {
    const settings = normalizeReplaySkinSettings({
      version: 1,
      columnWidth: 100,
      keymodeProfiles: {
        4: { columnWidth: 160 },
      },
    });

    expect(settings.columnWidth).toBe(50);
    expect(getReplaySkinProfile(settings, 4).columnWidth).toBe(80);
    expect(settings.columnSpacing).toBe(0);
  });

  it("maps osu!mania skin.ini HitPosition values to replay coordinates", () => {
    expect(osuManiaHitPositionToReplayHitPosition(450)).toBe(48);
    expect(replayHitPositionToOsuManiaHitPosition(48)).toBe(450);
    expect(osuManiaHitPositionToReplayHitPosition(402)).toBe(125);
  });

  it("resolves per-column colors over the shared fallback", () => {
    const settings = normalizeReplaySkinSettings({
      tapColor: "#111111",
      tapColors: ["", "#222222"],
      lnHeadColor: "#333333",
      lnHeadColors: ["#444444"],
    });

    expect(getReplaySkinColumnColor(settings, "tap", 0)).toBe("#111111");
    expect(getReplaySkinColumnColor(settings, "tap", 1)).toBe("#222222");
    expect(getReplaySkinColumnColor(settings, "lnHead", 0)).toBe("#444444");
    expect(getReplaySkinColumnColor(settings, "lnHead", 2)).toBe("#333333");
  });

  it("resolves keymode profiles independently", () => {
    const settings = normalizeReplaySkinSettings({
      tapColor: "#111111",
      keymodeProfiles: {
        7: {
          tapColor: "#222222",
          tapColors: ["", "", "", "#ffcc22"],
          lnHeadColor: "#333333",
          columnWidth: 80,
          columnSpacing: 2,
        },
      },
      hitPosition: 84,
    });

    expect(getReplaySkinProfile(settings, 4).tapColor).toBe("#111111");
    expect(getReplaySkinProfile(settings, 7).tapColor).toBe("#222222");
    expect(getReplaySkinProfile(settings, 7).columnWidth).toBe(80);
    expect(getReplaySkinProfile(settings, 7).columnSpacing).toBe(2);
    expect(getReplaySkinColumnColor(settings, "tap", 3, 7)).toBe("#ffcc22");
    expect(settings.hitPosition).toBe(84);
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
      version: 2,
      style: "circles",
      tapColor: "#101820",
      tapColors: [],
      lnHeadColor: "#f2aa4c",
      lnHeadColors: [],
      lnBodyColor: "#8b8b93",
      percy: true,
      upscroll: false,
      keysUnderNotes: false,
      columnWidth: 50,
      columnSpacing: 0,
      noteHeightScale: 50,
      hitPosition: 110,
      scorePosition: 438,
      comboPosition: 485,
      keymodeProfiles: {},
    });
    expect(readReplaySkinSettings()).toEqual({
      version: 2,
      style: "circles",
      tapColor: "#101820",
      tapColors: [],
      lnHeadColor: "#f2aa4c",
      lnHeadColors: [],
      lnBodyColor: "#8b8b93",
      percy: true,
      upscroll: false,
      keysUnderNotes: false,
      columnWidth: 50,
      columnSpacing: 0,
      noteHeightScale: 50,
      hitPosition: 110,
      scorePosition: 438,
      comboPosition: 485,
      keymodeProfiles: {},
    });
  });

  it("returns defaults when storage cannot be parsed", () => {
    window.localStorage.setItem(REPLAY_SKIN_STORAGE_KEY, "{nope");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readReplaySkinSettings()).toEqual(DEFAULT_REPLAY_SKIN_SETTINGS);

    expect(warn).toHaveBeenCalledOnce();
  });
});
