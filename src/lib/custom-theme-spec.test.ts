import { describe, expect, it } from "vitest";

import { compileCustomThemeSource, customThemeLineProgram } from "#custom-themes/source";
import { parseDriverLog } from "./custom-theme-editor-gl";
import { CUSTOM_THEME_STARTER, customThemeSpec, preludeHelpers } from "./custom-theme-spec";

describe("custom theme spec", () => {
  it("reads every prelude helper with its signature", () => {
    const names = preludeHelpers().map((helper) => /\s(\w+)\(/.exec(helper.signature)?.[1]);
    expect(names).toEqual(expect.arrayContaining(["hash", "noise", "fbm", "ihash", "inoise", "ifbm", "rot", "pointerP", "stars", "voronoiEdge"]));
    expect(preludeHelpers().find((helper) => helper.signature.startsWith("float stars("))?.note).toMatch(/Twinkling points/);
  });

  it("starts new themes from code that passes the checker", () => {
    const result = compileCustomThemeSource(CUSTOM_THEME_STARTER);
    expect(result.ok).toBe(true);
    expect(customThemeSpec()).toContain(CUSTOM_THEME_STARTER);
  });

  it("numbers the driver's program from the author's first line", () => {
    const program = customThemeLineProgram("vec3 theme(vec2 uv, vec2 p, float t) {\n  return vec3(0.);\n}", "theme");
    expect(program.startsWith("#line 1\nvec3 theme(")).toBe(true);
    const toy = customThemeLineProgram("void mainImage(out vec4 c, in vec2 f) { c = vec4(0.); }", "shadertoy");
    expect(toy).toMatch(/#define iTime u_time[\s\S]*#line 1\nvoid mainImage[\s\S]*vec3 theme\(/);
  });
});

describe("parseDriverLog", () => {
  it("reads ANGLE's and Mesa's error lines", () => {
    expect(parseDriverLog("ERROR: 0:12: 'foo' : undeclared identifier\nERROR: 0:12: '=' : dimension mismatch\nERROR: 2 compilation errors.  No code generated.\n\u0000")).toEqual([
      { line: 12, message: "'foo' : undeclared identifier" },
      { line: 12, message: "'=' : dimension mismatch" },
    ]);
    expect(parseDriverLog("0:4(10): error: `x' undeclared")).toEqual([{ line: 4, message: "`x' undeclared" }]);
  });
});
