import { describe, expect, test } from "vitest";
import {
  CARD_TEXTURE_HEIGHT,
  CARD_TEXTURE_WIDTH,
  buildStarSegments,
  clamp,
  resolveQualityProfile,
  truncateToWidth,
} from "./layout";

describe("layout constants", () => {
  test("uses a fixed 5:7 texture surface", () => {
    expect(CARD_TEXTURE_WIDTH).toBe(1000);
    expect(CARD_TEXTURE_HEIGHT).toBe(1400);
    expect(CARD_TEXTURE_WIDTH / CARD_TEXTURE_HEIGHT).toBeCloseTo(5 / 7, 3);
  });
});

describe("truncateToWidth", () => {
  test("keeps short text unchanged", () => {
    const measure = (text: string) => text.length * 10;
    expect(truncateToWidth("Aleju", 80, measure)).toBe("Aleju");
  });

  test("adds an ellipsis when text is too wide", () => {
    const measure = (text: string) => text.length * 10;
    const result = truncateToWidth("VeryLongPlayerName", 70, measure);
    expect(result).toBe("Very...");
    expect(measure(result)).toBeLessThanOrEqual(70);
  });
});

describe("buildStarSegments", () => {
  test("maps fractional star average into full half and empty stars", () => {
    expect(buildStarSegments(4.6, 6)).toEqual(["full", "full", "full", "full", "half", "empty"]);
  });
});

describe("resolveQualityProfile", () => {
  test("caps mobile pixel ratio and reduces idle", () => {
    expect(resolveQualityProfile({ mobile: true, reducedMotion: false, devicePixelRatio: 3 })).toEqual({
      pixelRatio: 1.5,
      antialias: true,
      adaptiveIdle: true,
      shaderQuality: "high",
      idleMotion: "wake-on-input",
    });
  });

  test("disables idle motion when reduced motion is requested", () => {
    expect(resolveQualityProfile({ mobile: false, reducedMotion: true, devicePixelRatio: 2 })).toMatchObject({
      pixelRatio: 1,
      shaderQuality: "medium",
      idleMotion: "off",
    });
  });
});

describe("clamp", () => {
  test("bounds values inclusively", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
