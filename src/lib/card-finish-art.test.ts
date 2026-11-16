import { expect, it, vi } from "vitest";
import { PACK_FINISH_IDS, packFinishMotif, packFinishSvg } from "./card-finish-art";
import { cardMotifImageSrc, cardMotifSignature, parseCardMotif } from "./card-motif";
import { parseCardMotif as parseStoredMotif } from "../../backend/src/features/card-motif";
import { getCosmicTierPalette } from "./maniacard-cosmic";
import { MANIA_TIER_STYLES, resolveManiaTierStyle } from "./maniacard";
import { cardMotifDataUrl } from "./maniacard-art";
it("preserves stored finishes through frontend and backend parsers", () => {
  for (const id of PACK_FINISH_IDS) {
    const motif = packFinishMotif(id);
    expect(parseStoredMotif(JSON.stringify(motif))).toEqual(motif);
    expect(parseCardMotif(JSON.stringify(motif))).toEqual(motif);
  }
});
it("changes the appearance and thumbnail identity without relabeling the rarity", () => {
  const signatures = new Set<string>();
  for (const id of PACK_FINISH_IDS) {
    const motif = packFinishMotif(id);
    signatures.add(cardMotifSignature(motif));
    expect(resolveManiaTierStyle("common", motif).label).toBe(MANIA_TIER_STYLES.common.label);
    expect(resolveManiaTierStyle("goat", motif).label).toBe(MANIA_TIER_STYLES.goat.label);
    expect(getCosmicTierPalette("common", motif)).toBeTruthy();
    expect(cardMotifImageSrc(motif)).toMatch(/^data:image\/svg\+xml/);
  }
  expect(signatures.size).toBe(3);
});
it("inlines the same curated vector in browser and share images without a remote fetch", async () => {
  for (const id of PACK_FINISH_IDS) {
    const motif = packFinishMotif(id);
    const art = await cardMotifDataUrl(motif);
    expect(art?.aspect).toBe(1);
    const decoded = Buffer.from(art!.dataUrl.split(',')[1], 'base64').toString();
    expect(decoded).toBe(packFinishSvg(motif.url));
    expect(decodeURIComponent(cardMotifImageSrc(motif).split(',')[1])).toBe(decoded);
  }
  expect(packFinishSvg("https://example.com/prismatic.svg")).toBeNull();
});
it("redraws a WebP motif as a PNG, the only way the share image can size it", async () => {
  const { default: sharp } = await import("sharp");
  const webp = await sharp({ create: { width: 600, height: 300, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).webp().toBuffer();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(webp))));
  try {
    const url = `https://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`;
    const art = await cardMotifDataUrl({ url, scale: 1, opacity: 0.85 });
    expect(art?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(art?.aspect).toBe(2);
    const drawn = await sharp(Buffer.from(art!.dataUrl.split(",")[1], "base64")).metadata();
    expect([drawn.width, drawn.height, drawn.hasAlpha]).toEqual([320, 160, true]);
  } finally {
    vi.unstubAllGlobals();
  }
});
