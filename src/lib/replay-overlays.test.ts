import { describe, expect, it } from "vitest";
import { DEFAULT_REPLAY_MISS_THUMB_HAND, DEFAULT_REPLAY_OVERLAY_SETTINGS, REPLAY_OVERLAY_ANCHORED_COORD, getReplayOverlayMinX, getReplayOverlayPlacement, updateReplayOverlayPlacement, normalizeReplayHandAccuracyStyle, normalizeReplayColumnStatStyle, normalizeReplayColumnStatMetric, normalizeReplayMissStyle, normalizeReplayHitErrorStyle, normalizeReplayJudgementLayout, normalizeReplayMissThumbHand, normalizeReplayOverlaySettings } from "./replay-overlays";

describe("replay overlay settings", () => {
  it("preserves and copies authored geometry through normalization and storage", () => {
    const reference = { width: 2048, height: 1020, playfieldX: 600, playfieldWidth: 848, hudScale: 1.45 };
    const settings = { judgements: { ...DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements, reference } };
    const normalized = normalizeReplayOverlaySettings(JSON.parse(JSON.stringify(settings)));
    expect(normalized.judgements.reference).toEqual(reference);
    expect(normalizeReplayOverlaySettings(settings).judgements.reference).not.toBe(reference);
    expect(normalizeReplayOverlaySettings({ judgements: { ...settings.judgements, reference: { ...reference, height: 0 } } }).judgements.reference).toBeUndefined();
  });

  it("preserves an independent size reference and rejects invalid size baselines", () => {
    const size = { width: 2048, height: 900, hudScale: 1.5, region: "left", groupExtent: 500 };
    const reference = { width: 900, height: 1000, playfieldX: 150, playfieldWidth: 600, hudScale: 0.45, size };
    const settings = { handAccuracy: { enabled: true, reference } };
    const normalized = normalizeReplayOverlaySettings(JSON.parse(JSON.stringify(settings)));
    expect(normalized.handAccuracy.reference).toEqual(reference);
    expect(normalizeReplayOverlaySettings(settings).handAccuracy.reference?.size).not.toBe(size);
    for (const invalid of [{ ...size, width: 0 }, { ...size, hudScale: NaN }, { ...size, height: -1 }]) {
      const result = normalizeReplayOverlaySettings({ handAccuracy: { reference: { ...reference, size: invalid } } });
      expect(result.handAccuracy.reference?.size).toBeUndefined();
      expect(result.handAccuracy.reference?.hudScale).toBe(0.45);
    }
  });

  it("preserves a leaderboard parked past the left edge through a settings round trip", () => {
    const leaderboard = { enabled: true, x: -0.06, y: 0.24, scale: 1.5 };
    const settings = normalizeReplayOverlaySettings({ leaderboard });
    const restored = normalizeReplayOverlaySettings(JSON.parse(JSON.stringify(settings)));
    expect(restored.leaderboard).toMatchObject({ x: 0, y: 0.24, scale: 1.5 });
    expect(getReplayOverlayPlacement(restored, "leaderboard", true)).toMatchObject(leaderboard);
  });

  it("allows negative horizontal placement only for the lazer leaderboard and preserves anchored defaults", () => {
    const settings = normalizeReplayOverlaySettings({ leaderboard: { x: -0.1, y: -0.1 }, accuracy: { x: -0.1 } });
    expect(settings.leaderboard.x).toBe(0);
    expect(settings.leaderboard.lazerPosition?.x).toBe(-0.1);
    expect(settings.leaderboard.y).toBe(0);
    expect(settings.accuracy.x).toBe(0);
    expect(settings.hitError.x).toBe(REPLAY_OVERLAY_ANCHORED_COORD);
  });

  it("saves independent leaderboard geometry while sharing visibility", () => {
    const reference = { width: 1600, height: 900, playfieldX: 500, playfieldWidth: 600, hudScale: 1.5 };
    let settings = normalizeReplayOverlaySettings({});
    settings = updateReplayOverlayPlacement(settings, "leaderboard", { x: -0.08, y: 0.4, scale: 1.4, reference }, true);
    settings = normalizeReplayOverlaySettings(JSON.parse(JSON.stringify(settings)));
    const lazer = getReplayOverlayPlacement(settings, "leaderboard", true);
    settings = updateReplayOverlayPlacement(settings, "leaderboard", { x: 0.2, y: 0.1, scale: 0.7, enabled: false }, false);
    settings = normalizeReplayOverlaySettings(JSON.parse(JSON.stringify(settings)));
    expect(getReplayOverlayPlacement(settings, "leaderboard", false)).toMatchObject({ x: 0.2, y: 0.1, scale: 0.7, enabled: false });
    expect(getReplayOverlayPlacement(settings, "leaderboard", true)).toEqual({ ...lazer, enabled: false });
    expect(settings.leaderboard.lazerPosition?.reference).toEqual(reference);
    expect(settings.leaderboard.lazerPosition?.reference).not.toBe(reference);
  });

  it("opts into compact lazer rows without losing the setting when either leaderboard is moved", () => {
    expect(normalizeReplayOverlaySettings({}).leaderboard.collapseDuringPlay).toBe(false);
    expect(normalizeReplayOverlaySettings({ leaderboard: { collapseDuringPlay: "true" } }).leaderboard.collapseDuringPlay).toBe(false);
    let settings = normalizeReplayOverlaySettings({ leaderboard: { collapseDuringPlay: true } });
    settings = updateReplayOverlayPlacement(settings, "leaderboard", { x: 0.08, scale: 1.5 }, true);
    settings = updateReplayOverlayPlacement(settings, "leaderboard", { x: 0.2 }, false);
    const restored = normalizeReplayOverlaySettings(JSON.parse(JSON.stringify(settings)));
    expect(restored.leaderboard.collapseDuringPlay).toBe(true);
    expect(getReplayOverlayPlacement(restored, "leaderboard", true)).toMatchObject({ x: 0.08, scale: 1.5, collapseDuringPlay: true });
    expect(getReplayOverlayPlacement(restored, "leaderboard", false)).toMatchObject({ x: 0.2, collapseDuringPlay: true });
  });

  it("lets the lazer leaderboard cross the edge while leaving enough visible to drag it back", () => {
    const width = 400;
    const stageWidth = 1000;
    const left = getReplayOverlayMinX("leaderboard", width, stageWidth, true) * stageWidth;
    expect(left).toBeLessThan(-50);
    expect(left + width).toBe(32);
    expect(getReplayOverlayMinX("leaderboard", width, stageWidth, false)).toBe(0);
    expect(getReplayOverlayMinX("accuracy", width, stageWidth, true)).toBe(0);
    expect(getReplayOverlayMinX("leaderboard", 20, stageWidth, true)).toBe(0);
    expect(getReplayOverlayMinX("leaderboard", 2000, stageWidth, true)).toBeGreaterThan(REPLAY_OVERLAY_ANCHORED_COORD);
  });

  it("adds Replay Master to old settings without enabling it and preserves its saved placement", () => {
    expect(normalizeReplayOverlaySettings({}).replayMaster.enabled).toBe(false);
    const placement = { enabled: true, x: 0.64, y: 0.12, scale: 1.3 };
    expect(normalizeReplayOverlaySettings(JSON.parse(JSON.stringify({ replayMaster: placement }))).replayMaster).toEqual({ ...placement, scrollSpeed: 1, transparentBackground: false, followSv: false });
  });

  it("preserves Replay Master speed, transparency and SV through saved settings", () => {
    const placement = { ...DEFAULT_REPLAY_OVERLAY_SETTINGS.replayMaster, scrollSpeed: 0.5, transparentBackground: true, followSv: true };
    expect(normalizeReplayOverlaySettings(JSON.parse(JSON.stringify({ replayMaster: placement }))).replayMaster).toEqual(placement);
    expect(normalizeReplayOverlaySettings({ replayMaster: { scrollSpeed: NaN, transparentBackground: "true", followSv: "true" } }).replayMaster).toMatchObject({ scrollSpeed: 1, transparentBackground: false, followSv: false });
    expect(normalizeReplayOverlaySettings({ replayMaster: { scrollSpeed: 0 } }).replayMaster.scrollSpeed).toBe(0.25);
    expect(normalizeReplayOverlaySettings({ replayMaster: { scrollSpeed: 100 } }).replayMaster.scrollSpeed).toBe(3);
  });
  it("uses the larger miss counter in the default layout", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.misses.scale).toBe(1);
  });

  it("uses a larger judgement overlay in the default layout", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements.scale).toBe(1.5);
  });

  it("ships accuracy as a draggable readout on the left", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.accuracy).toEqual({ enabled: true, x: 0.03, y: 0.03, scale: 1 });
  });

  it("ships per-hand accuracy as an opt-in draggable overlay", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.handAccuracy).toEqual({ enabled: false, x: 0.03, y: 0.16, scale: 1, style: "meters" });
    expect(normalizeReplayOverlaySettings({}).handAccuracy).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.handAccuracy);
  });

  it("ships the per-finger strip as an opt-in overlay above the keypresses", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.columnStats).toEqual({ enabled: false, x: 0.035, y: 0.57, scale: 1, style: "meters", metric: "accuracy" });
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.columnStats.y).toBeLessThan(DEFAULT_REPLAY_OVERLAY_SETTINGS.keypresses.y);
    expect(normalizeReplayOverlaySettings({}).columnStats).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.columnStats);
  });

  it("keeps the detached progress pie clear of the accuracy cluster", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.progress).toEqual({ enabled: false, x: 0.03, y: 0.1, scale: 1 });
  });

  it("migrates the mis-sized accuracy readout defaults to the current default", () => {
    for (const scale of [1.5, 1.1, 0.95, 0.8]) {
      const settings = normalizeReplayOverlaySettings({
        accuracy: { enabled: true, x: 0.03, y: 0.03, scale },
      });

      expect(settings.accuracy).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.accuracy);
    }
  });

  it("migrates the score-block era defaults to the current defaults", () => {
    const settings = normalizeReplayOverlaySettings({
      accuracy: { enabled: false, x: 0.74, y: 0.02, scale: 1 },
      judgements: { enabled: true, x: 0.92, y: 0.2, scale: 1.25 },
    });

    expect(settings.accuracy).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.accuracy);
    expect(settings.judgements).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements);
  });

  it("migrates the old compact miss counter default to the current default", () => {
    const settings = normalizeReplayOverlaySettings({
      misses: { enabled: true, x: 0.085, y: 0.77, scale: 0.75 },
    });

    expect(settings.misses).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.misses);
  });

  it("migrates the old judgement overlay default to the current default", () => {
    const settings = normalizeReplayOverlaySettings({
      judgements: { enabled: true, x: 0.74, y: 0.07, scale: 1 },
    });

    expect(settings.judgements).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements);
  });

  it("ships the pp counter disabled by default, in the top-right corner", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.pp).toEqual({ enabled: false, x: 0.88, y: 0.02, scale: 1 });
    expect(normalizeReplayOverlaySettings({}).pp).toEqual(DEFAULT_REPLAY_OVERLAY_SETTINGS.pp);
  });

  it("preserves custom miss counter scale choices", () => {
    const settings = normalizeReplayOverlaySettings({
      misses: { enabled: true, x: 0.085, y: 0.77, scale: 1.2 },
    });

    expect(settings.misses.scale).toBe(1.2);
  });
});

describe("miss counter thumb hand", () => {
  it("assumes the right thumb until the viewer says otherwise", () => {
    expect(DEFAULT_REPLAY_MISS_THUMB_HAND).toBe("right");
    expect(normalizeReplayMissThumbHand(null)).toBe("right");
    expect(normalizeReplayMissThumbHand("nonsense")).toBe("right");
  });

  it("keeps a stored left-thumb choice", () => {
    expect(normalizeReplayMissThumbHand("left")).toBe("left");
  });
});

describe("replay per-hand accuracy style", () => {
  it("falls back to the meters shape for anything unknown", () => {
    expect(normalizeReplayHandAccuracyStyle(undefined)).toBe("meters");
    expect(normalizeReplayHandAccuracyStyle("nonsense")).toBe("meters");
    expect(normalizeReplayHandAccuracyStyle("rings")).toBe("rings");
  });

  it("keeps a picked style through a stored-settings round trip", () => {
    const stored = { handAccuracy: { enabled: true, x: 0.2, y: 0.3, scale: 1, style: "balance" } };

    expect(normalizeReplayOverlaySettings(stored).handAccuracy.style).toBe("balance");
  });

  it("keeps the style when a legacy layout resets the placement", () => {
    const legacy = { ...DEFAULT_REPLAY_OVERLAY_SETTINGS.handAccuracy, style: "plain" };

    expect(normalizeReplayOverlaySettings({ handAccuracy: legacy }).handAccuracy.style).toBe("plain");
  });
});


describe("per-finger stat styles", () => {
  it("defaults the shape to meters and the reading to accuracy", () => {
    expect(normalizeReplayColumnStatStyle(undefined)).toBe("meters");
    expect(normalizeReplayColumnStatStyle("nonsense")).toBe("meters");
    expect(normalizeReplayColumnStatStyle("leaderboard")).toBe("leaderboard");
    expect(normalizeReplayColumnStatMetric(undefined)).toBe("accuracy");
    // The shape names and the metric names live in separate sets.
    expect(normalizeReplayColumnStatMetric("circles")).toBe("accuracy");
    expect(normalizeReplayColumnStatStyle("ur")).toBe("meters");
    expect(normalizeReplayColumnStatMetric("ur")).toBe("ur");
  });

  it("keeps a picked shape and reading through storage without touching the other styled overlays", () => {
    const stored = JSON.parse(JSON.stringify({
      columnStats: { enabled: true, x: 0.2, y: 0.4, scale: 1.2, style: "circles", metric: "ur" },
      handAccuracy: { style: "rings" },
      misses: { style: "compact" },
    }));
    const settings = normalizeReplayOverlaySettings(stored);
    expect(settings.columnStats).toEqual(stored.columnStats);
    expect(settings.handAccuracy.style).toBe("rings");
    expect(settings.misses.style).toBe("compact");
  });
});

describe("replay miss counter styles", () => {
  it("defaults to Classic without moving custom placements", () => {
    expect(normalizeReplayMissStyle(undefined)).toBe("plain");
    expect(normalizeReplayMissStyle("rings")).toBe("plain");
    const placement = { enabled: true, x: 0.24, y: 0.63, scale: 1.4 };
    expect(normalizeReplayOverlaySettings({ misses: placement }).misses).toEqual({ ...placement, style: "plain" });
  });

  it("migrates removed Results selections to Classic without changing placement", () => {
    const placement = { enabled: true, x: 0.24, y: 0.63, scale: 1.4, style: "cards" };
    expect(normalizeReplayMissStyle("cards")).toBe("plain");
    expect(normalizeReplayOverlaySettings({ misses: placement }).misses).toEqual({ ...placement, style: "plain" });
  });

  it.each(["compact", "stacked", "plain"])("preserves %s through storage and legacy placement migration", (style) => {
    const stored = JSON.parse(JSON.stringify({ misses: { enabled: true, x: 0.24, y: 0.63, scale: 1.4, style } }));
    expect(normalizeReplayOverlaySettings(stored).misses).toEqual(stored.misses);
    const legacy = { enabled: true, x: 0.085, y: 0.77, scale: 0.75, style };
    expect(normalizeReplayOverlaySettings({ misses: legacy }).misses).toEqual({ ...DEFAULT_REPLAY_OVERLAY_SETTINGS.misses, style });
    expect(normalizeReplayOverlaySettings({ handAccuracy: { style: "balance" }, misses: { style } }).handAccuracy.style).toBe("balance");
  });
});

describe("hit error bar styles", () => {
  it("ships the hit windows behind the ticks", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.hitError.style).toBe("bands");
    expect(normalizeReplayHitErrorStyle(undefined)).toBe("bands");
    expect(normalizeReplayHitErrorStyle("plain")).toBe("bands");
  });

  it("keeps the hits-only pick through storage without disturbing the anchored placement", () => {
    const stored = JSON.parse(JSON.stringify({
      hitError: { enabled: true, x: REPLAY_OVERLAY_ANCHORED_COORD, y: REPLAY_OVERLAY_ANCHORED_COORD, scale: 1, style: "ticks" },
    }));
    expect(normalizeReplayOverlaySettings(stored).hitError).toEqual(stored.hitError);
  });
});

describe("judgement overlay layouts", () => {
  it("ships the stacked column and rejects unknown arrangements", () => {
    expect(DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements.style).toBe("vertical");
    expect(normalizeReplayJudgementLayout(undefined)).toBe("vertical");
    expect(normalizeReplayJudgementLayout("inline")).toBe("vertical");
  });

  it("keeps a horizontal pick through storage and legacy placement migration", () => {
    const stored = JSON.parse(JSON.stringify({ judgements: { enabled: true, x: 0.4, y: 0.6, scale: 1.25, style: "horizontal" } }));
    expect(normalizeReplayOverlaySettings(stored).judgements).toEqual(stored.judgements);
    const legacy = { enabled: true, x: 0.74, y: 0.07, scale: 1.25, style: "horizontal" };
    expect(normalizeReplayOverlaySettings({ judgements: legacy }).judgements)
      .toEqual({ ...DEFAULT_REPLAY_OVERLAY_SETTINGS.judgements, style: "horizontal" });
  });
});
