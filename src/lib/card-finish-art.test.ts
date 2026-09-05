import { expect, it } from "vitest";
import { PACK_FINISH_IDS, packFinishMotif, packFinishSvg } from "./card-finish-art";
import { cardMotifImageSrc, cardMotifSignature, parseCardMotif } from "./card-motif";
import { parseCardMotif as parseStoredMotif } from "../../live-backend/src/features/card-motif";
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
