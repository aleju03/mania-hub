import { describe, expect, it } from "vitest";

import { OG_NAME_FONTS } from "./og-name-fonts";
import { OG_SHADER_NAME_STYLES } from "./og-name-shaders";
import { OG_NAME_STYLE_IDS } from "./og-name-tag";
import { readOgSupporterLook } from "./og-supporter-look";
import { SUPPORTER_NAME_FONTS } from "./supporter-name-fonts";
import { SHADER_NAME_STYLES, SUPPORTER_NAME_STYLES } from "./supporter-name-styles";

describe("drawn name tags", () => {
  // A style or font added to the site without its drawing would come out plain on the bot's pictures.
  it("draws every name style the site has", () => {
    expect([...OG_NAME_STYLE_IDS].sort()).toEqual([...SUPPORTER_NAME_STYLES].sort());
  });

  it("draws a still of every shader style the site has", () => {
    expect([...OG_SHADER_NAME_STYLES].sort()).toEqual([...SHADER_NAME_STYLES].sort());
  });

  it("has every name font the site has (scripts/build-name-font-ttf.mjs)", () => {
    expect(Object.keys(OG_NAME_FONTS).sort()).toEqual([...SUPPORTER_NAME_FONTS].sort());
  });
});

describe("readOgSupporterLook", () => {
  it("reads a style, font, outline and frame", () => {
    expect(readOgSupporterLook(["holo", "pacifico", "ff66aa2", "sakura"])).toEqual({
      name: { style: "holo", font: "pacifico", outline: "ff66aa2" },
      frame: { id: "sakura", art: null },
    });
  });

  it("is null with nothing to draw", () => {
    expect(readOgSupporterLook(["", "", "", ""])).toBeNull();
    expect(readOgSupporterLook(undefined)).toBeNull();
  });

  it("takes a workshop frame only with its art, from the frames host", () => {
    const still = "a".repeat(64);
    expect(readOgSupporterLook(["", "", "", "u12"])).toBeNull();
    expect(readOgSupporterLook(["", "", "", "u12", [still, "", 0.1, 0.2, 0, 0.25]])).toEqual({
      name: null,
      frame: { id: "u12", art: { still: `https://cdn.mania-tracker.com/frames/${still}.png`, round: null, overhang: [0.1, 0.2, 0, 0.25] } },
    });
    expect(readOgSupporterLook(["", "", "", "u12", ["https://evil.example/x.png", "", 0, 0, 0, 0]])).toBeNull();
  });
});
