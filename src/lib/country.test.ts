import { describe, expect, it } from "vitest";
import {
  COUNTRY_OPTIONS,
  displayCountryName,
  GLOBAL_SCOPE_CODE,
  GLOBAL_SCOPE_ICON_URL,
  getCountryFlagGradient,
  getCountryFlagUrl,
  getCountryName,
  isGlobalScope,
  isSupportedCountryCode,
  isSupportedCountryScope,
  normalizeCountryCode,
  normalizeCountryScope,
} from "./country";

describe("country scope helpers", () => {
  it("recognises the Global scope case-insensitively", () => {
    expect(isGlobalScope("GLOBAL")).toBe(true);
    expect(isGlobalScope(" global ")).toBe(true);
    expect(isGlobalScope("CR")).toBe(false);
    expect(isGlobalScope(null)).toBe(false);
  });

  it("treats Global as a supported scope, not a country", () => {
    expect(isSupportedCountryCode("GLOBAL")).toBe(false);
    expect(isSupportedCountryScope("GLOBAL")).toBe(true);
    expect(normalizeCountryCode("global")).toBe("CR");
    expect(normalizeCountryScope("global")).toBe(GLOBAL_SCOPE_CODE);
    expect(getCountryName("GLOBAL")).toBe("Global");
  });

  it("keeps real country normalisation untouched", () => {
    expect(normalizeCountryCode("cr")).toBe("CR");
    expect(normalizeCountryCode("zz")).toBe("CR"); // unknown falls back to default
    expect(getCountryName("CR")).toBe("Costa Rica");
  });

  it("uses the generated Spanish country and region names", () => {
    expect(displayCountryName("DE", "es")).toBe("Alemania");
    expect(displayCountryName("R-CAMERICA", "es")).toBe("Centroamérica");
    expect(displayCountryName("GLOBAL", "es")).toBe("Global");
  });

  it("sorts country options alphabetically without pinning the default country", () => {
    const names = COUNTRY_OPTIONS.map((country) => country.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(COUNTRY_OPTIONS[0].code).not.toBe("CR");
  });

  it("uses the globe motif as the Global flag and has no stripe gradient", () => {
    expect(getCountryFlagUrl("GLOBAL")).toBe(GLOBAL_SCOPE_ICON_URL);
    expect(getCountryFlagUrl("CR")).toContain("/flags/CR.png");
    expect(getCountryFlagGradient("GLOBAL")).toBeNull();
  });

  it("keeps every flag gradient stripe edge hard", () => {
    for (const { code } of COUNTRY_OPTIONS) {
      const gradient = getCountryFlagGradient(code);
      if (!gradient) continue;
      for (const layer of splitBackgroundLayers(gradient)) {
        if (!/^(linear|radial|conic)-gradient\(/i.test(layer)) continue;
        const stops = parseStops(layer);
        for (let i = 0; i + 1 < stops.length; i += 1) {
          const [a, b] = [stops[i], stops[i + 1]];
          // Adjacent stops must either share a colour (a solid band) or a
          // position (a hard edge); anything else smears one into the next.
          const hard = a.color === b.color || a.offset === b.offset;
          expect(hard, `${code}: "${a.color} ${a.offset}%" blends into "${b.color} ${b.offset}%"`).toBe(true);
        }
      }
    }
  });

  it("keeps the white in the Philippines flag", () => {
    expect(getCountryFlagGradient("PH")).toContain("#fff");
  });
});

// Splits a CSS background shorthand into its comma-separated layers, ignoring
// commas nested inside gradient functions.
function splitBackgroundLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      layers.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers;
}

// Reads "<colour> <pos>" stops, including the two-position "<colour> <from> <to>"
// shorthand. Angles and percentages are both treated as plain offsets; a layer
// only ever mixes one of them.
function parseStops(layer: string): Array<{ color: string; offset: number }> {
  const stops: Array<{ color: string; offset: number }> = [];
  const stopRe = /(#[0-9a-fA-F]{3,8}|transparent)\s+(\d+(?:\.\d+)?)(?:%|deg)?(?:\s+(\d+(?:\.\d+)?)(?:%|deg))?/g;
  let match: RegExpExecArray | null;
  while ((match = stopRe.exec(layer)) !== null) {
    stops.push({ color: match[1], offset: Number(match[2]) });
    if (match[3] !== undefined) stops.push({ color: match[1], offset: Number(match[3]) });
  }
  return stops;
}
