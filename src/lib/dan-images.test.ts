import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { danScaleLabel, danTierName, getDanImageSrc, getDanTierImageSrc, type DanScaleContext } from "./dan-images";

describe("danTierName", () => {
  it("names each suffix with LeoBlack's tier words", () => {
    expect(danTierName("azimuth--")).toBe("azimuth low");
    expect(danTierName("gamma-")).toBe("gamma mid/low");
    expect(danTierName("gamma")).toBe("gamma mid");
    expect(danTierName("gamma+")).toBe("gamma mid/high");
    expect(danTierName("gamma++")).toBe("gamma high");
  });

  it("formats the level before the tier word", () => {
    expect(danTierName("10-", (level) => `${level} dan`)).toBe("10 dan mid/low");
  });
});

describe("dan badge artwork", () => {
  // The signature and OG rasterizer has no system fonts, so an SVG <text>
  // glyph renders as nothing there. Badges have to carry their glyphs as paths.
  it("draws every glyph as a path, never as SVG text", () => {
    const root = join(process.cwd(), "public/images/dans");
    const withText = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".svg"))
      .filter((file) => /<text[\s>]/.test(readFileSync(join(root, file), "utf8")));
    expect(withText).toEqual([]);
  });
});

describe("getDanTierImageSrc", () => {
  it("picks the drawing with the tier painted in, and the plain badge for mid", () => {
    expect(getDanTierImageSrc("7--")).toBe("/images/dans/reform/7-low.svg?v=3");
    expect(getDanTierImageSrc("7-")).toBe("/images/dans/reform/7-mid-low.svg?v=3");
    expect(getDanTierImageSrc("7")).toBe("/images/dans/reform/7.svg");
    expect(getDanTierImageSrc("7+")).toBe("/images/dans/reform/7-mid-high.svg?v=3");
    expect(getDanTierImageSrc("Eta++")).toBe("/images/dans/reform/eta-high.webp?v=3");
    expect(getDanTierImageSrc("12+", "ln")).toBe("/images/dans/ln/12-mid-high.svg?v=3");
    expect(getDanTierImageSrc("Azimuth-", "ln", 7)).toBe("/images/dans/7k/ln-azimuth-mid-low.svg?v=3");
    expect(getDanTierImageSrc("Terra++", undefined, 6)).toBe("/images/dans/6k/terra-high.svg?v=3");
  });

  it("stays null where the ladder has no badge", () => {
    expect(getDanTierImageSrc("18+", "ln")).toBeNull();
    expect(getDanTierImageSrc("7+", undefined, 5)).toBeNull();
  });

  it("has every tier drawing on disk for every badge", () => {
    const ladders: Array<[DanScaleContext, string | undefined, number, number, number]> = [
      ["reform", undefined, 4, 1, 20],
      ["ln", "ln", 4, 1, 17],
      ["7k", undefined, 7, 0, 14],
      ["7k-ln", "ln", 7, 0, 14],
      ["6k", undefined, 6, 0, 14],
      ["6k-ln", "ln", 6, 0, 14],
    ];
    const missing: string[] = [];
    for (const [context, family, keyCount, low, high] of ladders) {
      for (let level = low; level <= high; level++) {
        const label = danScaleLabel(level, context);
        expect(getDanImageSrc(label.toLowerCase(), family, keyCount)).not.toBeNull();
        for (const suffix of ["--", "-", "+", "++"]) {
          const src = getDanTierImageSrc(`${label}${suffix}`, family, keyCount)!.replace(/\?.*$/, "");
          if (!existsSync(join(process.cwd(), "public", src))) missing.push(src);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
