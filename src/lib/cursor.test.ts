import { describe, expect, it } from "vitest";

import {
  DEFAULT_CURSOR_SETTINGS,
  SMOKE_HOLD_MS,
  SMOKE_LIFETIME_MS,
  normalizeCursorSettings,
  segmentHitsCircle,
  smokeAlpha,
} from "./cursor";

describe("normalizeCursorSettings", () => {
  it("returns defaults for missing or invalid input", () => {
    expect(normalizeCursorSettings(null)).toEqual(DEFAULT_CURSOR_SETTINGS);
    expect(normalizeCursorSettings("nope")).toEqual(DEFAULT_CURSOR_SETTINGS);
    expect(normalizeCursorSettings(42)).toEqual(DEFAULT_CURSOR_SETTINGS);
  });

  it("keeps valid settings intact", () => {
    const settings = {
      enabled: true,
      color: "#66baff",
      size: 150,
      glow: 80,
      trail: false,
      trailColor: "#a6e478",
      trailThickness: 60,
    };
    expect(normalizeCursorSettings(settings)).toEqual(settings);
  });

  it("clamps trail thickness", () => {
    expect(normalizeCursorSettings({ trailThickness: 999 }).trailThickness).toBe(200);
    expect(normalizeCursorSettings({ trailThickness: 1 }).trailThickness).toBe(25);
    expect(normalizeCursorSettings({}).trailThickness).toBe(100);
  });

  it("clamps size and falls back on bad colors", () => {
    expect(normalizeCursorSettings({ size: 999 }).size).toBe(200);
    expect(normalizeCursorSettings({ size: 1 }).size).toBe(50);
    expect(normalizeCursorSettings({ size: Number.NaN }).size).toBe(100);
    expect(normalizeCursorSettings({ glow: 999 }).glow).toBe(100);
    expect(normalizeCursorSettings({ glow: -5 }).glow).toBe(0);
    expect(normalizeCursorSettings({ glow: "big" }).glow).toBe(DEFAULT_CURSOR_SETTINGS.glow);
    expect(normalizeCursorSettings({ color: "red" }).color).toBe(DEFAULT_CURSOR_SETTINGS.color);
    expect(normalizeCursorSettings({ color: "FF66AB" }).color).toBe("#ff66ab");
  });

  it("defaults the trail color to the cursor color", () => {
    expect(normalizeCursorSettings({ color: "#66baff" }).trailColor).toBe("#66baff");
    expect(normalizeCursorSettings({ color: "#66baff", trailColor: "nope" }).trailColor).toBe("#66baff");
    expect(normalizeCursorSettings({ color: "#66baff", trailColor: "#ffd673" }).trailColor).toBe("#ffd673");
  });

  it("coerces enabled and trail to booleans with the right defaults", () => {
    expect(normalizeCursorSettings({}).enabled).toBe(false);
    expect(normalizeCursorSettings({}).trail).toBe(true);
    expect(normalizeCursorSettings({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeCursorSettings({ trail: false }).trail).toBe(false);
  });
});

describe("smokeAlpha", () => {
  it("holds at full strength before fading", () => {
    expect(smokeAlpha(0)).toBe(1);
    expect(smokeAlpha(SMOKE_HOLD_MS)).toBe(1);
  });

  it("fades linearly to zero", () => {
    const midFade = SMOKE_HOLD_MS + (SMOKE_LIFETIME_MS - SMOKE_HOLD_MS) / 2;
    expect(smokeAlpha(midFade)).toBeCloseTo(0.5);
    expect(smokeAlpha(SMOKE_LIFETIME_MS)).toBe(0);
    expect(smokeAlpha(SMOKE_LIFETIME_MS + 1000)).toBe(0);
  });
});

describe("segmentHitsCircle", () => {
  it("hits when the segment passes through the circle", () => {
    expect(segmentHitsCircle(-10, 0, 10, 0, 0, 3, 5)).toBe(true);
  });

  it("misses when the segment stays outside the radius", () => {
    expect(segmentHitsCircle(-10, 0, 10, 0, 0, 8, 5)).toBe(false);
  });

  it("clamps to segment endpoints instead of the infinite line", () => {
    // The infinite line through these points passes the circle, the segment does not.
    expect(segmentHitsCircle(20, 0, 40, 0, 0, 0, 5)).toBe(false);
    expect(segmentHitsCircle(4, 0, 40, 0, 0, 0, 5)).toBe(true);
  });

  it("treats a zero-length segment as a point check", () => {
    expect(segmentHitsCircle(1, 1, 1, 1, 0, 0, 2)).toBe(true);
    expect(segmentHitsCircle(5, 5, 5, 5, 0, 0, 2)).toBe(false);
  });
});
