import type { Readable } from "node:stream";

// In-memory tier for the skin images (/api/skins/file previews and
// screenshots) that the whole grid loads when no public bucket URL is
// configured: without it every card pays a full R2 round trip off the VPS
// (measured >1s to first byte for a ~25KB webp). Previews are ~25KB canvas
// webps and screenshots are capped at 4MB by upload validation, keys are
// immutable (re-renders land on revisioned keys), and the endpoint authorizes
// against the skin row before reading, so entries never need invalidation -
// the LRU caps alone bound the memory this holds.
// Sized off the real bucket (2026-08: 61 skins, 336 images, ~15MB) so the
// entire image set stays resident with room to grow.
const CACHE_MAX_ENTRIES = 1024;
const CACHE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_OBJECT_BYTES = 4 * 1024 * 1024;
// Nothing legit approaches this (upload validation caps images well below);
// purely a runaway guard so a mislabeled object cannot balloon the buffer.
const READ_HARD_CAP_BYTES = 32 * 1024 * 1024;

export interface SkinImageSource {
  body: Readable;
  contentType: string;
  contentLength: number | null;
  contentDisposition: string | null;
}

export interface CachedSkinImage {
  buffer: Buffer;
  contentType: string;
  contentDisposition: string | null;
}

const cache = new Map<string, CachedSkinImage>();
const inflight = new Map<string, Promise<CachedSkinImage | null>>();
let totalBytes = 0;

export async function readCachedSkinImage(
  key: string,
  load: () => Promise<SkinImageSource | null>,
): Promise<CachedSkinImage | null> {
  const cached = cache.get(key);
  if (cached) {
    // Re-insert so eviction order stays least-recently-used.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const object = await load();
    if (!object) return null;
    const buffer = await readAll(object.body);
    if (!buffer) return null;
    const image: CachedSkinImage = {
      buffer,
      contentType: object.contentType,
      contentDisposition: object.contentDisposition,
    };
    if (buffer.length <= CACHE_MAX_OBJECT_BYTES) remember(key, image);
    return image;
  })().catch(() => null).finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

// Test seam and a restart-equivalent for the admin reset paths.
export function clearSkinImageCache(): void {
  cache.clear();
  totalBytes = 0;
}

async function readAll(body: Readable): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > READ_HARD_CAP_BYTES) {
        body.destroy();
        return null;
      }
      chunks.push(buffer);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

function remember(key: string, image: CachedSkinImage): void {
  cache.set(key, image);
  totalBytes += image.buffer.length;
  while (cache.size > CACHE_MAX_ENTRIES || (totalBytes > CACHE_MAX_TOTAL_BYTES && cache.size > 1)) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    totalBytes -= cache.get(oldest.value)?.buffer.length ?? 0;
    cache.delete(oldest.value);
  }
}
