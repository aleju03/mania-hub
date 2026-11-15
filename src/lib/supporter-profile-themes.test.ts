import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PROFILE_THEME_SHADERS } from "./profile-theme-shaders";
import {
  isSupporterProfileTheme,
  PROFILE_THEME_LOOKS,
  profileThemeStyle,
  SUPPORTER_PROFILE_THEME_LABELS,
  SUPPORTER_PROFILE_THEMES,
} from "./supporter-profile-themes";

describe("supporter profile themes", () => {
  it("gives every theme colours, a label and a backdrop", () => {
    for (const id of SUPPORTER_PROFILE_THEMES) {
      const look = PROFILE_THEME_LOOKS[id];
      expect(look.hue).toBeGreaterThanOrEqual(0);
      expect(look.hue).toBeLessThan(360);
      expect(look.sat).toBeGreaterThanOrEqual(0);
      expect(look.sat).toBeLessThanOrEqual(1);
      expect(look.cover).toBeLessThanOrEqual(0.5);
      expect(SUPPORTER_PROFILE_THEME_LABELS[id]).toBeTruthy();
      expect(PROFILE_THEME_SHADERS[id]).toMatch(/vec3 theme\(vec2 uv, vec2 p, float t\)/);
    }
  });

  it("keeps the same ids as the backend allowlist", () => {
    const source = readFileSync(new URL("../../backend/src/features/supporters.ts", import.meta.url), "utf8");
    const list = /SUPPORTER_PROFILE_THEMES = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    expect([...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual([...SUPPORTER_PROFILE_THEMES]);
  });

  it("re-tints whatever wears it, and nothing without one", () => {
    expect(profileThemeStyle(null)).toBeUndefined();
    expect(profileThemeStyle("noir")).toEqual({ "--theme-hue": "0", "--theme-sat": "0", "--theme-surface": "3" });
    expect(isSupporterProfileTheme("aurora")).toBe(true);
    expect(isSupporterProfileTheme("myspace")).toBe(false);
  });
});
