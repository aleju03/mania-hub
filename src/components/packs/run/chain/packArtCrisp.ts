import { PACK_TYPES, type PackTypeId } from "#/lib/packs";
import { getCachedPackFrontCanvas, packArtStyleFor } from "../../packArt";

/* Pack wrappers at their full drawn size (600 x 1000), so a pack shown on
   the table or in the shop stays crisp at 2x; the page's selector thumbs
   are 256 px wide. One PNG per pack type, made on first use. */
const cache = new Map<PackTypeId, string>();

export function crispPackUrl(id: PackTypeId): string | null {
  if (typeof document === "undefined") return null;
  const known = cache.get(id);
  if (known) return known;
  const type = PACK_TYPES.find((entry) => entry.id === id);
  if (!type) return null;
  try {
    const url = getCachedPackFrontCanvas(packArtStyleFor(type)).toDataURL("image/png");
    cache.set(id, url);
    return url;
  } catch {
    return null;
  }
}
