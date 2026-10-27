import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CUSTOM_THEME_INPUTS } from "#custom-themes/inputs";
import { compileCustomThemeSource } from "#custom-themes/source";
import { layerAssets, layersToGlsl, newLayer, parseLayerDoc, starterLayerDoc, type LayerDoc, type LayerKind } from "./custom-theme-layers";
import { PROFILE_THEME_MAIN, PROFILE_THEME_PRELUDE } from "./profile-theme-shaders";

const NAMES: Record<LayerKind, string> = { background: "Background", image: "Image", particles: "Particles", fog: "Fog", glow: "Glow", stars: "Stars" };
const A = `https://cdn.mania-tracker.com/theme-assets/${"a".repeat(64)}.webp`;
const B = `https://cdn.mania-tracker.com/theme-assets/${"b".repeat(64)}.webp`;

function everyKind(): LayerDoc {
  const doc = starterLayerDoc(NAMES);
  const background = newLayer("background", "Photo");
  if (background.kind === "background") Object.assign(background, { fill: "image", image: A });
  const picture = newLayer("image", "Moon");
  if (picture.kind === "image") picture.image = B;
  const petals = newLayer("particles", "Petals");
  if (petals.kind === "particles") Object.assign(petals, { shape: "image", image: A });
  const streaks = newLayer("particles", "Rain");
  if (streaks.kind === "particles") streaks.shape = "streak";
  return { ...doc, layers: [background, ...doc.layers.slice(1), picture, petals].slice(0, 7).concat(streaks) };
}

const glslang = (() => {
  try {
    execFileSync("glslangValidator", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function glslangErrors(fragment: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "layer-theme-"));
  try {
    const file = join(dir, "theme.frag");
    writeFileSync(file, fragment);
    execFileSync("glslangValidator", [file], { stdio: "pipe" });
    return null;
  } catch (cause) {
    return String((cause as { stdout?: Buffer }).stdout ?? cause);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fullShader = (code: string) => `${PROFILE_THEME_PRELUDE}\n${CUSTOM_THEME_INPUTS}\n${code}\n${PROFILE_THEME_MAIN}`;

describe("layersToGlsl", () => {
  it("makes code the theme checker takes, for every kind of layer", () => {
    for (const doc of [starterLayerDoc(NAMES), everyKind()]) {
      const result = compileCustomThemeSource(layersToGlsl(doc).glsl);
      expect(result.ok ? true : result.errors).toBe(true);
    }
  });

  it.skipIf(!glslang)("compiles as GLSL ES 3.00, saved and live", () => {
    const doc = everyKind();
    const saved = compileCustomThemeSource(layersToGlsl(doc).glsl);
    if (!saved.ok) throw new Error("checker refused it");
    expect(glslangErrors(fullShader(saved.compiled))).toBeNull();
    expect(glslangErrors(fullShader(layersToGlsl(doc, { live: true }).glsl))).toBeNull();
  });

  it("keeps the live code still while only numbers change, and the numbers follow", () => {
    const doc = starterLayerDoc(NAMES);
    const before = layersToGlsl(doc, { live: true });
    const fog = doc.layers.find((layer) => layer.kind === "fog")!;
    const after = layersToGlsl({ ...doc, layers: doc.layers.map((layer) => (layer === fog ? { ...layer, opacity: 0.25 } : layer)) }, { live: true });
    expect(after.glsl).toBe(before.glsl);
    expect([...after.params]).not.toEqual([...before.params]);
    expect([...after.params]).toContain(0.25);
  });

  it("skips hidden layers and image layers without an image", () => {
    const doc = starterLayerDoc(NAMES);
    const glsl = layersToGlsl({ ...doc, layers: [...doc.layers.map((layer) => (layer.kind === "fog" ? { ...layer, hidden: true } : layer)), newLayer("image", "Empty")] }).glsl;
    expect(glsl).not.toContain("// fog");
    expect(glsl).not.toContain("// image");
  });

  it("binds each image once, in the order the layers use them", () => {
    expect(layerAssets(everyKind())).toEqual([A, B]);
  });

  it("writes the starter the same way every time", () => {
    const doc = starterLayerDoc(NAMES);
    const stable = { ...doc, layers: doc.layers.map((layer, index) => ({ ...layer, id: `l${index}` })) };
    expect(layersToGlsl(stable).glsl).toMatchSnapshot();
  });
});

describe("parseLayerDoc", () => {
  it("drops unknown layers, clamps numbers and refuses outside images", () => {
    const doc = parseLayerDoc({
      layers: [
        { kind: "image", image: "https://evil.example/x.png", size: 99, opacity: 3 },
        { kind: "laser" },
        { kind: "stars", density: -1, color: "red" },
      ],
      finish: { grain: 5 },
    });
    expect(doc?.layers.map((layer) => layer.kind)).toEqual(["image", "stars"]);
    const [picture, stars] = doc!.layers;
    expect(picture.kind === "image" && [picture.image, picture.size, picture.opacity]).toEqual([null, 3, 1]);
    expect(stars.kind === "stars" && [stars.density, stars.color]).toEqual([0.01, "#dfe8ff"]);
    expect(doc!.finish.grain).toBe(0.2);
    expect(parseLayerDoc({ layers: "no" })).toBeNull();
  });
});
