import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { danTierName } from "./dan-images";

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
