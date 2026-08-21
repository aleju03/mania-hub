import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  REPLAY_SKIN_PRESETS_STORAGE_KEY,
  REPLAY_SKIN_STORAGE_KEY,
  createReplaySkinPreset,
  createReplaySkinShareKey,
  getReplaySkinColumnColor,
  getReplaySkinProfile,
  getReplaySkinStagePosition,
  normalizeReplaySkinSettings,
  osuManiaHitPositionToReplayHitPosition,
  parseReplaySkinShareKey,
  readReplaySkinPresets,
  readReplaySkinSettings,
  replayHitPositionToOsuManiaHitPosition,
  writeReplaySkinPresets,
  writeReplaySkinSettings,
} from "./replay-skin";
import type { ReplaySkinSettings } from "./replay-skin";
import type { SkinSummary } from "./skins";

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

  it("resolves a stage position per keymode, falling back to the settings-wide value", () => {
    const settings = normalizeReplaySkinSettings({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      hitPosition: 110,
      keymodeProfiles: {
        "7": { hitPosition: 139 },
      },
    });

    // 7K carries the skin's own hit line; 4K never declared one, so the value
    // the Layout tab edits stands.
    expect(getReplaySkinStagePosition(getReplaySkinProfile(settings, 7), settings, "hitPosition")).toBe(139);
    expect(getReplaySkinStagePosition(getReplaySkinProfile(settings, 4), settings, "hitPosition")).toBe(110);
  });

  it("keeps per-keymode stage positions through a share key round trip", () => {
    const settings = normalizeReplaySkinSettings({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      keymodeProfiles: { "7": { hitPosition: 139, scorePosition: 528, comboPosition: 288 } },
    });
    const restored = parseReplaySkinShareKey(createReplaySkinShareKey("Two modes", settings));

    expect(restored?.settings.keymodeProfiles["7"].hitPosition).toBe(139);
    expect(restored?.settings.keymodeProfiles["7"].scorePosition).toBe(528);
    expect(restored?.settings.keymodeProfiles["7"].comboPosition).toBe(288);
  });

  it("uses the shared default replay skin preset", () => {
    expect(DEFAULT_REPLAY_SKIN_SETTINGS).toEqual({
      version: 2,
      style: "circles",
      tapColor: "#9cf2ae",
      tapColors: [],
      lnHeadColor: "#dfffe6",
      lnHeadColors: [],
      lnBodyColor: "#8b8b93",
      outlineEnabled: false,
      outlineColor: "#ffffff",
      outlineWidth: 2,
      percy: true,
      upscroll: false,
      columnWidth: 50,
      columnSpacing: 0,
      noteHeightScale: 50,
      hitPosition: 48,
      scorePosition: 438,
      comboPosition: 485,
      comboFontSet: "set11",
      judgementSet: "set18",
      judgementScale: 102,
      judgementScales: {
        set09: 102,
        set10: 102,
        set08: 181,
        set12: 102,
        set06: 102,
        set18: 102,
        set02: 102,
        set26: 199,
        set30: 199,
      },
      keymodeProfiles: {
        4: {
          tapColor: "#9cf2ae",
          tapColors: [],
          lnHeadColor: "#dfffe6",
          lnHeadColors: ["#e3a5de", "#e3a5de", "#e3a5de", "#e3a5de", "#e3a5de"],
          columnWidth: 75,
          columnSpacing: 2,
          columnWidths: [],
          columnSpacings: [],
          columnLineWidths: [],
          columnLineColor: "",
          columnBackgrounds: [],
          judgementLine: true,
          judgementLineColor: "",
          columnStart: null,
          lightPosition: null,
          hitPosition: null,
          scorePosition: null,
          comboPosition: null,
          comboHidden: false,
          keysUnderNotes: false,
          noteBodyStyles: [],
          comboScale: 1,
          noteHeightScale: 50,
          assets: {
            columns: [],
            judgements: {},
            combo: null,
            stage: { lightingWidths: [], lightColors: [] },
          },
        },
      },
    });
  });

  it("parses the shared default skin code", () => {
    const code = "mhreplay3.WyJEZWZhdWx0Iix7ImEiOjEsImciOjAsImoiOjEsIm4iOjQ4LCJ0Ijoic2V0MTEiLCJ1Ijoic2V0MTgiLCJ3Ijp7InNldDA5IjoxMDIsInNldDEwIjoxMDIsInNldDA4IjoxODEsInNldDEyIjoxMDIsInNldDA2IjoxMDIsInNldDE4IjoxMDIsInNldDAyIjoxMDIsInNldDI2IjoxOTksInNldDMwIjoxOTl9LCJxIjp7IjQiOnsiZSI6ImUzYTVkZWUzYTVkZWUzYTVkZWUzYTVkZWUzYTVkZSIsImgiOjc1LCJpIjoyfX19XQ";
    const payload = parseReplaySkinShareKey(code);

    expect(payload?.name).toBe("Default");
    expect(payload?.settings).toEqual(DEFAULT_REPLAY_SKIN_SETTINGS);
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
      hitPosition: 48,
      judgementScale: 100,
      judgementScales: {},
      keymodeProfiles: {},
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
      judgementScale: 100,
      judgementScales: {},
      keymodeProfiles: {},
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

  it("creates compact v3 share codes and parses them losslessly", () => {
    const settings = normalizeReplaySkinSettings({
      style: "arrows",
      outlineEnabled: false,
      hitPosition: 48,
      scorePosition: 416,
      comboPosition: 528,
      keymodeProfiles: {
        4: {
          lnHeadColors: ["#e3a5de", "#e3a5de", "#e3a5de", "#e3a5de"],
          columnWidth: 91,
          columnSpacing: 2,
          noteBodyStyles: [0, 0, 1, 0],
        },
      },
    });

    const code = createReplaySkinShareKey("insano", settings);
    const payload = parseReplaySkinShareKey(code);

    expect(code.startsWith("mhreplay3.")).toBe(true);
    expect(code.length).toBeLessThan(180);
    expect(payload?.name).toBe("insano");
    expect(payload?.settings).toEqual(settings);
  });

  it("round-trips column and judgement line styling through v3 share codes", () => {
    const settings = normalizeReplaySkinSettings({
      keymodeProfiles: {
        8: {
          columnWidths: [65, 65, 65, 65, 65, 65, 65, 65],
          columnLineWidths: [0, 1, 0, 0, 0, 0, 0, 0, 0],
          columnLineColor: "#ffffff96",
          judgementLine: false,
          judgementLineColor: "#11223380",
        },
      },
    });
    const profile = settings.keymodeProfiles["8"];
    expect(profile.columnLineWidths).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(profile.columnLineColor).toBe("#ffffff96");
    expect(profile.judgementLine).toBe(false);
    expect(profile.judgementLineColor).toBe("#11223380");

    const payload = parseReplaySkinShareKey(createReplaySkinShareKey("lines", settings));
    expect(payload?.settings).toEqual(settings);
  });

  it("continues to parse existing v2 share codes", () => {
    const code = "mhreplay2.eyJuIjoiaW5zYW5vIiwicyI6eyJzdHlsZSI6ImFycm93cyIsIm91dGxpbmVFbmFibGVkIjpmYWxzZSwiaGl0UG9zaXRpb24iOjQ4LCJzY29yZVBvc2l0aW9uIjo0MTYsImNvbWJvUG9zaXRpb24iOjUyOCwia2V5bW9kZVByb2ZpbGVzIjp7IjQiOnsibG5IZWFkQ29sb3JzIjpbIiNlM2E1ZGUiLCIjZTNhNWRlIiwiI2UzYTVkZSIsIiNlM2E1ZGUiXSwiY29sdW1uV2lkdGgiOjkxLCJjb2x1bW5TcGFjaW5nIjoyfX19fQ";
    const payload = parseReplaySkinShareKey(code);

    expect(payload?.name).toBe("insano");
    expect(payload?.settings).toEqual(normalizeReplaySkinSettings({
      style: "arrows",
      outlineEnabled: false,
      hitPosition: 48,
      scorePosition: 416,
      comboPosition: 528,
      keymodeProfiles: {
        4: {
          lnHeadColors: ["#e3a5de", "#e3a5de", "#e3a5de", "#e3a5de"],
          columnWidth: 91,
          columnSpacing: 2,
        },
      },
    }));
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
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      tapColor: "#101820",
      lnHeadColor: "#f2aa4c",
    });
    expect(readReplaySkinSettings()).toEqual({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      tapColor: "#101820",
      lnHeadColor: "#f2aa4c",
    });
  });

  it("normalizes and shares combo font sets", () => {
    const settings = normalizeReplaySkinSettings({ comboFontSet: "set17", judgementSet: "set18" });

    expect(settings.comboFontSet).toBe("set17");
    expect(settings.judgementSet).toBe("set18");
    expect(normalizeReplaySkinSettings({ comboFontSet: "set99" }).comboFontSet).toBe("set1");
    expect(normalizeReplaySkinSettings({ judgementSet: "set99" }).judgementSet).toBe("skin");
    expect(parseReplaySkinShareKey(createReplaySkinShareKey("combo", settings))?.settings).toEqual(settings);
  });

  it("returns defaults when storage cannot be parsed", () => {
    window.localStorage.setItem(REPLAY_SKIN_STORAGE_KEY, "{nope");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(readReplaySkinSettings()).toEqual(DEFAULT_REPLAY_SKIN_SETTINGS);

    expect(warn).toHaveBeenCalledOnce();
  });

  it("round-trips community preset links through the preset store", () => {
    const skin = { id: "sk_1", name: "aleju03 lazer" } as SkinSummary;
    const payload = { v: 1, settings: { style: "bars" } };
    const community = createReplaySkinPreset("aleju03 lazer", DEFAULT_REPLAY_SKIN_SETTINGS, { skin, payload });
    const plain = createReplaySkinPreset("plain", DEFAULT_REPLAY_SKIN_SETTINGS);
    writeReplaySkinPresets([community, plain]);

    const read = readReplaySkinPresets();
    expect(read).toHaveLength(2);
    expect(read[0].community?.skin.id).toBe("sk_1");
    expect(read[0].community?.payload).toEqual(payload);
    expect(read[1].community).toBeUndefined();
  });

  it("carries a public community pointer through a share code", () => {
    const skin = { id: "sk_1", name: "aleju03 lazer", visibility: "public" } as SkinSummary;
    const payload = { v: 1, settings: { style: "bars" } };

    const parsed = parseReplaySkinShareKey(
      createReplaySkinShareKey("linked", DEFAULT_REPLAY_SKIN_SETTINGS, { skin, payload }),
    );

    expect(parsed?.community?.skin.id).toBe("sk_1");
    expect(parsed?.community?.payload).toEqual(payload);
  });

  it("never puts a private skin's summary into a share code", () => {
    // A private summary's URLs carry the owner's capability token; a code is
    // made to be pasted around.
    const skin = {
      id: "sk_2",
      name: "my private skin",
      visibility: "private",
      oskUrl: "/api/skins/file/sk_2/skin.osk?t=capability-secret",
    } as SkinSummary;

    const key = createReplaySkinShareKey("private", DEFAULT_REPLAY_SKIN_SETTINGS, { skin, payload: { v: 1 } });

    const decoded = Buffer.from(key.slice("mhreplay3.".length), "base64url").toString();
    expect(decoded).not.toContain("capability-secret");
    expect(parseReplaySkinShareKey(key)?.community).toBeUndefined();
  });

  it("drops a forged community pointer that does not say it is public", () => {
    const forged = `mhreplay3.${Buffer.from(JSON.stringify([
      "forged",
      {},
      { skin: { id: "sk_3" }, payload: { v: 1 } },
    ])).toString("base64url")}`;

    const parsed = parseReplaySkinShareKey(forged);
    expect(parsed).not.toBeNull();
    expect(parsed?.community).toBeUndefined();
  });

  it("drops a malformed community link but keeps the preset", () => {
    window.localStorage.setItem(REPLAY_SKIN_PRESETS_STORAGE_KEY, JSON.stringify([
      { id: "p1", name: "broken link", settings: {}, community: { skin: {}, payload: { v: 1 } } },
      { id: "p2", name: "no payload", settings: {}, community: { skin: { id: "sk_2" } } },
    ]));

    const read = readReplaySkinPresets();
    expect(read).toHaveLength(2);
    expect(read[0].community).toBeUndefined();
    expect(read[1].community).toBeUndefined();
  });
});

describe("replay skin storage under quota pressure", () => {
  // A decoded Percy-style body is megabytes of base64. Anything past this
  // stands in for the browser's real quota: big enough that settings and a
  // couple of presets fit comfortably, small enough that one piece of art
  // does not.
  const LIMIT = 5000;
  const ART = `data:image/png;base64,${"A".repeat(6000)}`;

  let storage: Map<string, string>;

  const settingsWithArt = () => normalizeReplaySkinSettings({
    ...DEFAULT_REPLAY_SKIN_SETTINGS,
    tapColor: "#101820",
    hitPosition: 137,
    keymodeProfiles: {
      "4": {
        columnWidth: 91,
        assets: { columns: [{ lnBody: { name: "LN_Body.png", src: ART, width: 128, height: 4096 } }] },
      },
    },
  });

  beforeEach(() => {
    storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => {
          if (value.length > LIMIT) {
            const error = new Error(`Setting the value of '${key}' exceeded the quota.`);
            error.name = "QuotaExceededError";
            throw error;
          }
          storage.set(key, value);
        },
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a skin's colors and layout when its art will not fit", () => {
    const settings = settingsWithArt();
    expect(settings.keymodeProfiles["4"].assets.columns[0]?.lnBody?.src).toBe(ART);

    writeReplaySkinSettings(settings);

    // The art is what did not fit, so the art is what goes; everything the
    // same write carried survives. Losing the whole object to the quota took
    // the colors, the hit position and the column width with it.
    const stored = readReplaySkinSettings();
    expect(stored.tapColor).toBe("#101820");
    expect(stored.hitPosition).toBe(137);
    expect(stored.keymodeProfiles["4"].columnWidth).toBe(91);
    expect(stored.keymodeProfiles["4"].assets.columns[0]?.lnBody).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("data:image/");
  });

  it("strips only the pixels, not the stage metadata beside them", () => {
    // LightingNWidth / ColourLight are skin.ini numbers riding in the assets
    // block next to the images. Swapping the whole block for an empty one
    // threw them out with the art they were meant to survive.
    writeReplaySkinSettings(normalizeReplaySkinSettings({
      ...DEFAULT_REPLAY_SKIN_SETTINGS,
      keymodeProfiles: {
        "4": {
          assets: {
            columns: [{ lnBody: { name: "LN_Body.png", src: ART } }],
            stage: {
              light: { name: "mania-stage-light.png", src: ART },
              lightingWidths: [30, 30, 30, 30],
              lightColors: ["#ff0000", "", "", "#00ff00"],
            },
          },
        },
      },
    }));

    const stage = readReplaySkinSettings().keymodeProfiles["4"].assets.stage;
    expect(stage.light).toBeUndefined();
    expect(stage.lightingWidths).toEqual([30, 30, 30, 30]);
    expect(stage.lightColors).toEqual(["#ff0000", "", "", "#00ff00"]);
  });

  it("announces the settings it was handed, not the copy it could store", () => {
    // The page that just applied the skin still has its art in memory, and the
    // other surfaces listen for it here. Dropping the event on a failed write
    // left them drawing the previous skin until a reload.
    const detail: unknown[] = [];
    const stubbed = window as unknown as { dispatchEvent: (event: CustomEvent) => void };
    stubbed.dispatchEvent = (event: CustomEvent) => detail.push(event.detail);

    writeReplaySkinSettings(settingsWithArt());

    expect(detail).toHaveLength(1);
    expect((detail[0] as ReplaySkinSettings).keymodeProfiles["4"].assets.columns[0]?.lnBody?.src).toBe(ART);
  });

  it("keeps the other presets when one of them is too big to store", () => {
    const heavy = createReplaySkinPreset("mokou skin", settingsWithArt());
    const light = createReplaySkinPreset("plain", DEFAULT_REPLAY_SKIN_SETTINGS);

    writeReplaySkinPresets([heavy, light]);

    const read = readReplaySkinPresets();
    expect(read.map((preset) => preset.name)).toEqual(["mokou skin", "plain"]);
    expect(read[0].settings.tapColor).toBe("#101820");
    expect(read[0].settings.keymodeProfiles["4"].assets.columns[0]?.lnBody).toBeUndefined();
  });

  it("gives up rather than looping when there is no art to drop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Nothing here embeds art, so there is no smaller version to fall back to.
    writeReplaySkinPresets(Array.from({ length: 24 }, (_, index) => createReplaySkinPreset(
      `preset ${index} ${"x".repeat(80)}`.slice(0, 80),
      DEFAULT_REPLAY_SKIN_SETTINGS,
    )));

    expect(storage.get(REPLAY_SKIN_PRESETS_STORAGE_KEY)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
