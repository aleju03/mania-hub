import { createServerFn } from "@tanstack/react-start";

import { PACK_THUMBNAIL_KEY_PATTERN as THUMBNAIL_KEY_PATTERN } from "./pack-thumbnail-shared";
const MAX_THUMBNAIL_BYTES = 350_000;
const MAX_THUMBNAIL_BATCH = 60;

function normalizeThumbnailKey(input: unknown): string {
  const key = typeof input === "string" ? input.trim() : "";
  if (!THUMBNAIL_KEY_PATTERN.test(key)) throw new Error("Invalid card thumbnail key.");
  return key;
}

/* The canvas size of a WebP, read from its first chunk; null for anything
   that is not one. */
export function readWebpSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === "VP8 ") {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

/* A thumbnail is a WebP at the width its key names and the card's shape, so
   the pool cannot be handed some other picture or file. */
function decodeWebpDataUrl(dataUrl: string, key: string): Buffer {
  const match = /^data:image\/webp;base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid card thumbnail image.");
  const buffer = Buffer.from(match[1]!, "base64");
  if (buffer.length <= 0 || buffer.length > MAX_THUMBNAIL_BYTES) {
    throw new Error("Invalid card thumbnail size.");
  }
  const size = readWebpSize(buffer);
  const width = Number(/-w(\d+)-/.exec(key)?.[1]);
  if (!size || size.width !== width || Math.abs(size.height - Math.round(width * 1.4)) > 2) {
    throw new Error("Invalid card thumbnail image.");
  }
  return buffer;
}

// URL resolution is a pure computation now (no existence check; a 404 falls
// back to a local render client-side), so the answer is stable and cacheable
// for as long as the bucket config can be trusted not to change mid-day.
const THUMBNAIL_URL_CACHE_CONTROL = "private, max-age=3600";

export const fetchR2PackCardThumbnail = createServerFn({ method: "GET" })
  .validator((input: { key?: unknown }) => ({
    key: normalizeThumbnailKey(input?.key),
  }))
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", THUMBNAIL_URL_CACHE_CONTROL);
    const { getPackCardThumbnailUrl } = await import("./pack-thumbnail-store");
    return { url: getPackCardThumbnailUrl(data.key) };
  });

export const fetchR2PackCardThumbnails = createServerFn({ method: "GET" })
  .validator((input: { keys?: unknown }) => {
    const rawKeys = Array.isArray(input?.keys) ? input.keys : [];
    const keys = [...new Set(rawKeys.map((key) => normalizeThumbnailKey(key)))].slice(0, MAX_THUMBNAIL_BATCH);
    return { keys };
  })
  .handler(async ({ data }): Promise<{ urls: Record<string, string> }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", THUMBNAIL_URL_CACHE_CONTROL);
    const { getPackCardThumbnailUrl } = await import("./pack-thumbnail-store");
    const urls: Record<string, string> = {};
    for (const key of data.keys) {
      const url = getPackCardThumbnailUrl(key);
      if (url) urls[key] = url;
    }
    return { urls };
  });

// The CDN origin the thumbnail pool is served from, so the browser can build an
// object's URL itself and check whether it is already stored without spending
// an R2 operation. Static for the life of the deploy, so clients fetch it once.
export const fetchPackCardThumbnailBaseUrl = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ baseUrl: string | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "public, max-age=3600");
    const { getPublicBucketBaseUrl } = await import("./public-image-store");
    return { baseUrl: getPublicBucketBaseUrl() };
  });

export const uploadR2PackCardThumbnail = createServerFn({ method: "POST" })
  .validator((input: { key?: unknown; dataUrl?: unknown; probedMissing?: unknown }) => {
    const key = normalizeThumbnailKey(input?.key);
    const dataUrl = typeof input?.dataUrl === "string" ? input.dataUrl : "";
    if (dataUrl.length > MAX_THUMBNAIL_BYTES * 2) throw new Error("Invalid card thumbnail payload.");
    return { key, dataUrl, probedMissing: input?.probedMissing === true };
  })
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    // signed-in viewers fill the shared pool; everyone else renders locally
    const { readCurrentAuth } = await import("./auth-server");
    const viewer = (await readCurrentAuth()).viewer;
    if (!viewer) return { url: null };
    const { putPackCardThumbnail } = await import("./pack-thumbnail-store");
    return {
      url: await putPackCardThumbnail(data.key, decodeWebpDataUrl(data.dataUrl, data.key), {
        probedMissing: data.probedMissing,
        uploaderId: viewer.id,
      }),
    };
  });
