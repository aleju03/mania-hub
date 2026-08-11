// The maniacard thumbnail object layout, shared by the server store
// (pack-thumbnail-store.ts, hashing with node:crypto) and the browser cache
// (components/packs/cardThumbnailCache.ts, hashing with WebCrypto). Both sides
// have to land on the same object address or the client's existence probe asks
// about a key nobody writes, so the layout lives here once and each side only
// supplies the digest.

export const PACK_THUMBNAIL_PREFIX = "maniacards/";
export const PACK_THUMBNAIL_KEY_PATTERN = /^(v\d+)-w\d+-u(\d+)-[a-f0-9]{16}$/;

export function parsePackThumbnailCacheKey(cacheKey: string): { version: string; userId: string } {
  const match = PACK_THUMBNAIL_KEY_PATTERN.exec(cacheKey);
  if (!match) throw new Error("Invalid maniacard thumbnail cache key.");
  return { version: match[1]!, userId: match[2]! };
}

/** Object key for a cache key, given the full hex sha256 of that cache key. */
export function buildPackThumbnailStorageKey(cacheKey: string, sha256Hex: string): string {
  const { version, userId } = parsePackThumbnailCacheKey(cacheKey);
  const hash = sha256Hex.slice(0, 40);
  // v1 objects predate the inspectable hierarchy and keep their flat address;
  // every newer renderer writes into its own removable namespace and groups a
  // player's variants together in the R2 browser.
  if (version === "v1") return `${PACK_THUMBNAIL_PREFIX}${hash}.webp`;
  return `${PACK_THUMBNAIL_PREFIX}${version}/${userId}/${hash}.webp`;
}
