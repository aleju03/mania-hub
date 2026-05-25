import { describe, expect, it } from "vitest";
import {
  MANIA_FLASHLIGHT_DEFAULT_HEIGHT,
  MANIA_HIDDEN_MAX_COVERAGE,
  MANIA_HIDDEN_MIN_COVERAGE,
  dampManiaHiddenCoverageReference,
  getManiaFlashlightBand,
  getManiaFlashlightSizeReference,
  getManiaHiddenAlphaAtY,
  getManiaHiddenCoveragePx,
  getManiaHiddenCoverageReference,
  getManiaHiddenFadePx,
} from "./replay-visibility-mods";

describe("mania replay visibility mods", () => {
  it("grows Hidden coverage with combo and caps it like lazer mania", () => {
    expect(getManiaHiddenCoverageReference(0)).toBe(MANIA_HIDDEN_MIN_COVERAGE);
    expect(getManiaHiddenCoverageReference(100)).toBe(MANIA_HIDDEN_MIN_COVERAGE + 50);
    expect(getManiaHiddenCoverageReference(9999)).toBe(MANIA_HIDDEN_MAX_COVERAGE);
  });

  it("scales Hidden coverage from osu!mania's 768px playfield reference", () => {
    expect(getManiaHiddenCoveragePx({
      combo: 0,
      hitPosition: 110,
      playfieldHeight: 768,
      referenceHeight: 768,
    })).toBeCloseTo(160 * 768 / (768 - 110), 5);
  });

  it("damps Hidden coverage toward combo changes instead of snapping", () => {
    const halfway = dampManiaHiddenCoverageReference(400, 160, 25);
    const almostThere = dampManiaHiddenCoverageReference(400, 160, 100);

    expect(halfway).toBeCloseTo(280, 5);
    expect(almostThere).toBeGreaterThan(160);
    expect(almostThere).toBeLessThan(180);
  });

  it("fades Hidden notes before the hit line for downscroll", () => {
    const coveragePx = 100;
    const fadePx = getManiaHiddenFadePx(800);
    const judgmentY = 650;

    expect(getManiaHiddenAlphaAtY({ coveragePx, fadePx, judgmentY, upscroll: false, y: judgmentY - coveragePx - fadePx - 1 })).toBe(1);
    expect(getManiaHiddenAlphaAtY({ coveragePx, fadePx, judgmentY, upscroll: false, y: judgmentY - coveragePx })).toBe(0);
    expect(getManiaHiddenAlphaAtY({ coveragePx, fadePx, judgmentY, upscroll: false, y: judgmentY - coveragePx - fadePx / 2 })).toBeCloseTo(0.5, 5);
  });

  it("mirrors Hidden fading for upscroll", () => {
    const coveragePx = 100;
    const fadePx = getManiaHiddenFadePx(800);
    const judgmentY = 120;

    expect(getManiaHiddenAlphaAtY({ coveragePx, fadePx, judgmentY, upscroll: true, y: judgmentY + coveragePx + fadePx + 1 })).toBe(1);
    expect(getManiaHiddenAlphaAtY({ coveragePx, fadePx, judgmentY, upscroll: true, y: judgmentY + coveragePx })).toBe(0);
    expect(getManiaHiddenAlphaAtY({ coveragePx, fadePx, judgmentY, upscroll: true, y: judgmentY + coveragePx + fadePx / 2 })).toBeCloseTo(0.5, 5);
  });

  it("centers Flashlight as a full-width rectangular band", () => {
    const band = getManiaFlashlightBand({
      playfieldHeight: 768,
      referenceHeight: 768,
    });

    expect(band.top).toBeCloseTo(384 - MANIA_FLASHLIGHT_DEFAULT_HEIGHT / 2, 5);
    expect(band.bottom).toBeCloseTo(384 + MANIA_FLASHLIGHT_DEFAULT_HEIGHT / 2, 5);
    expect(band.edgeFade).toBeGreaterThan(0);
  });

  it("keeps Flashlight fixed by default and only shrinks when combo-based size is enabled", () => {
    expect(getManiaFlashlightSizeReference({ combo: 250 })).toBe(MANIA_FLASHLIGHT_DEFAULT_HEIGHT);
    expect(getManiaFlashlightSizeReference({ combo: 250, comboBasedSize: true })).toBeCloseTo(MANIA_FLASHLIGHT_DEFAULT_HEIGHT * 0.625, 5);
    expect(getManiaFlashlightSizeReference({ combo: 150, comboBasedSize: true })).toBeCloseTo(MANIA_FLASHLIGHT_DEFAULT_HEIGHT * 0.8125, 5);
  });
});
