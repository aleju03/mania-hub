import { describe, expect, it } from "vitest";
import { PROFILE_THEME_MAIN, PROFILE_THEME_PRELUDE, PROFILE_THEME_SHADERS } from "../../../lib/profile-theme-shaders";
import { SUPPORTER_PROFILE_THEMES } from "../../../lib/supporter-profile-themes";
import { stripGlslComments } from "./ThemeEditor";

describe("stripGlslComments", () => {
  it("drops comment lines and trailing comments, keeping one blank line between blocks", () => {
    const source = "// title\nfloat a = 1.; // why\n\n\n// note\n/* block\n   more */\nfloat b = 2.;\n";
    expect(stripGlslComments(source)).toBe("float a = 1.;\n\nfloat b = 2.;\n");
  });

  it("leaves every built-in theme's code free of comments", () => {
    for (const id of SUPPORTER_PROFILE_THEMES) {
      const full = PROFILE_THEME_SHADERS[id];
      const body = full.slice(PROFILE_THEME_PRELUDE.length + 1, full.length - PROFILE_THEME_MAIN.length - 1);
      const stripped = stripGlslComments(body);
      expect(stripped).not.toMatch(/\/\/|\/\*/);
      expect(stripped).toContain("vec3 theme(");
    }
  });
});
