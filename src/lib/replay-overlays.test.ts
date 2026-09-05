import { describe, expect, it } from "vitest";
import { DEFAULT_REPLAY_MISS_THUMB_HAND, DEFAULT_REPLAY_OVERLAY_SETTINGS, normalizeReplayHandAccuracyStyle, normalizeReplayMissThumbHand, normalizeReplayOverlaySettings } from "./replay-overlays";

describe("replay overlay settings", () => {
  it("adds Replay Master to old settings without enabling it and preserves its saved placement", () => {
    expect(normalizeReplayOverlaySettings({}).replayMaster.enabled).toBe(false);
    const placement = { enabled: true, x: 0.64, y: 0.12, scale: 1.3 };
    expect(normalizeReplayOverlaySettings(JSON.parse(JSON.stringify({ replayMaster: placement }))).replayMaster).toEqual({ ...placement, scrollSpeed: 1, transparentBackground: false });
  });

  it("preserves Replay Master speed and transparency through saved settings", () => {
    const placement = { ...DEFAULT_REPLAY_OVERLAY_SETTINGS.replayMaster, scrollSpeed: 0.5, transparentBackground: true };
    expect(normalizeReplayOverlaySettings(JSON.parse(JSON.stringify({ replayMaster: placement }))).replayMaster).toEqual(placement);
    expect(normalizeReplayOverlaySettings({ replayMaster: { scrollSpeed: NaN, transparentBackground: "true" } }).replayMaster).toMatchObject({ scrollSpeed: 1, transparentBackground: false });
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
