import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTER_NAME_FONTS } from "../src/lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLES } from "../src/lib/supporter-name-styles";
import { buildSupporterNamesCss, ORIGIN_PLACEHOLDER } from "./supporter-names-css";

const css = buildSupporterNamesCss(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));

describe("supporter names stylesheet", () => {
  it("has every name style, font and the outline", () => {
    for (const style of [...SUPPORTER_NAME_STYLES, "solid"]) expect(css, style).toMatch(new RegExp(`\\.name-tag--${style}\\b`));
    for (const font of SUPPORTER_NAME_FONTS) expect(css, font).toMatch(new RegExp(`\\.name-font--${font}\\b`));
    expect(css).toContain(".name-tag--terminal.name-tag--bare::after");
    expect(css).toMatch(/\.name-outline\s*\{/);
  });

  it("leaves out what only the site's big names and pickers use", () => {
    expect(css).not.toMatch(/name-tag--(hero|live|pending|waiting)\b|name-tag-shader|name-tag-grid|glow-room|:root/);
    expect(css).not.toContain("@tailwind");
    expect(css).not.toContain("@import");
  });

  it("keeps only the keyframes its rules run, and every one they run", () => {
    const defined = new Set([...css.matchAll(/@keyframes ([a-z0-9-]+)/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/animation(?:-name)?:\s*([^;]+);/g)].flatMap((m) => m[1].match(/name-tag-[a-z0-9-]+/g) ?? []));
    expect(defined).toEqual(used);
  });

  it("uses no site variable but the ones a name sets or falls back from", () => {
    const vars = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    expect([...vars].sort()).toEqual(["--font-sans", "--name-outline", "--name-outline-width"]);
    expect(css).not.toMatch(/var\(--font-sans\)/);
  });

  it("loads every name font from the site's origin", () => {
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]).filter((url) => !url.startsWith("data:"));
    expect(urls.length).toBeGreaterThanOrEqual(SUPPORTER_NAME_FONTS.length);
    for (const url of urls) expect(url).toMatch(new RegExp(`^${ORIGIN_PLACEHOLDER}/fonts/name/[^?]+\\?cors=1$`));
  });
});
