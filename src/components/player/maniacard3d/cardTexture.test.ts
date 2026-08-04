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
