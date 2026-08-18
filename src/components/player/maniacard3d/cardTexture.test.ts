import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadCardFonts } from "./cardTexture";

type LoadFn = (font: string) => Promise<unknown>;

/* Stands in for FontFaceSet.load, which node has no equivalent of. */
function installFonts(load: LoadFn): string[] {
  const requested: string[] = [];
  (globalThis as { document?: unknown }).document = {
    fonts: {
      load: (font: string) => {
        requested.push(font);
        return load(font);
      },
    },
  };
  return requested;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  vi.useRealTimers();
});

describe("loadCardFonts", () => {
  it("asks for every weight the card draws with, since canvas loads none itself", async () => {
    const requested = installFonts(() => Promise.resolve([]));
    await loadCardFonts();
    // 900 is the username and the stat values, 800 the stat labels and the
    // star average: the pair that used to come out in two different fonts.
    expect(requested.map((font) => font.split(" ")[0]).sort()).toEqual(["800", "900"]);
    for (const font of requested) expect(font).toContain("Torus");
  });

  it("draws in the fallback instead of failing when a face will not load", async () => {
    installFonts(() => Promise.reject(new Error("404")));
    await expect(loadCardFonts()).resolves.toBeUndefined();
  });

  it("gives up on a stalled font request rather than hanging the card", async () => {
    vi.useFakeTimers();
    installFonts(() => new Promise(() => {}));
    const pending = loadCardFonts();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBeUndefined();
  });

  it("is a no-op where there is no font set, so SSR and older browsers still draw", async () => {
    delete (globalThis as { document?: unknown }).document;
    await expect(loadCardFonts()).resolves.toBeUndefined();
  });
});

describe("createCardTextures", () => {
  it("waits for the fonts before measuring, not just before drawing", () => {
    // The username is auto-sized from its measured width, so a late font would
    // leave the card sized off Arial metrics even once it drew in Torus.
    const source = readFileSync(fileURLToPath(new URL("./cardTexture.ts", import.meta.url)), "utf8");
    const awaited = source.indexOf("await loadCardFonts();");
    const measured = source.indexOf("buildFaceLayout(data, measure)");
    expect(awaited).toBeGreaterThan(-1);
    expect(measured).toBeGreaterThan(awaited);
  });
});

describe("the granted background art", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  it("samples each drifting copy the right way up", () => {
    /* The sprite texture is uploaded flipped (three's default, same as the
       card face), and the shader's local y runs up the card, so the two agree
       only if neither is negated. Negating one drew every card's art on its
       head. */
    const shaders = read("./cardShaders.ts");
    expect(shaders).toContain("vec2 spriteUv = vec2(local.x, local.y) * 0.5 + 0.5;");
    expect(shaders).not.toContain("0.5 - local.y");
  });

  it("fills every cell of its grid and lets each copy roam inside one", () => {
    /* A jittered grid in all three renderers: even coverage without a visible
       lattice. Both halves matter. Skipping cells the way the triangles do
       (42% of them) leaves holes at picture size, and pinning each copy near
       its cell centre turns the layer into wallpaper. */
    const shaders = read("./cardShaders.ts");
    expect(shaders).toContain("vec2 center = id + 0.5 + (vec2(");
    expect(shaders).not.toContain("if (variant < 0.42) return vec4(0.0);");
    for (const still of [read("./cardTexture.ts"), read("../../../routes/api/og.ts")]) {
      expect(still).toMatch(/\(col \+ 0\.5 \+ \(/);
      // The triangles' skip, which both files still use for their own flecks.
      expect(still).not.toMatch(/\(index \* 19\.17 \+ 4\.2\) < 0\.42\) continue/);
    }
  });

  it("paints still copies only where nothing can move them", () => {
    // The 3D card's overlay floats the image itself; a second set painted into
    // the front canvas would just sit there under the moving one.
    expect(read("./ManiaCardRenderer.ts")).toContain("driftingMotif: true");
    expect(read("./cardTexture.ts")).toContain("if (!driftingMotif) drawMotifPattern(");
    // Thumbnails have no shader, so they keep the painted copies.
    expect(read("../../packs/cardSnapshot.ts")).not.toContain("driftingMotif");
  });
});
