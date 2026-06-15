import { createServerFn } from "@tanstack/react-start";

const THUMBNAIL_KEY_PATTERN = /^v\d+-w\d+-u\d+-[a-f0-9]{16}$/;
const MAX_THUMBNAIL_BYTES = 350_000;
const MAX_THUMBNAIL_BATCH = 60;
const THUMBNAIL_BATCH_CONCURRENCY = 8;

function normalizeThumbnailKey(input: unknown): string {
  const key = typeof input === "string" ? input.trim() : "";
  if (!THUMBNAIL_KEY_PATTERN.test(key)) throw new Error("Invalid card thumbnail key.");
  return key;
}

function decodeWebpDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/webp;base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid card thumbnail image.");
  const buffer = Buffer.from(match[1]!, "base64");
  if (buffer.length <= 0 || buffer.length > MAX_THUMBNAIL_BYTES) {
    throw new Error("Invalid card thumbnail size.");
  }
  return buffer;
}

export const fetchR2PackCardThumbnail = createServerFn({ method: "GET" })
  .inputValidator((input: { key?: unknown }) => ({
    key: normalizeThumbnailKey(input?.key),
  }))
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { getManiaCardThumbnailUrl } = await import("./r2-cache");
    return { url: await getManiaCardThumbnailUrl(data.key) };
  });

export const fetchR2PackCardThumbnails = createServerFn({ method: "GET" })
  .inputValidator((input: { keys?: unknown }) => {
    const rawKeys = Array.isArray(input?.keys) ? input.keys : [];
    const keys = [...new Set(rawKeys.map((key) => normalizeThumbnailKey(key)))].slice(0, MAX_THUMBNAIL_BATCH);
    return { keys };
  })
  .handler(async ({ data }): Promise<{ urls: Record<string, string> }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { getManiaCardThumbnailUrl } = await import("./r2-cache");
    const urls: Record<string, string> = {};
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(THUMBNAIL_BATCH_CONCURRENCY, data.keys.length) },
      async () => {
        for (;;) {
          const key = data.keys[cursor];
          cursor += 1;
          if (!key) return;
          const url = await getManiaCardThumbnailUrl(key);
          if (url) urls[key] = url;
        }
      },
    );
    await Promise.all(workers);
    return { urls };
  });

export const uploadR2PackCardThumbnail = createServerFn({ method: "POST" })
  .inputValidator((input: { key?: unknown; dataUrl?: unknown }) => {
    const key = normalizeThumbnailKey(input?.key);
    const dataUrl = typeof input?.dataUrl === "string" ? input.dataUrl : "";
    if (dataUrl.length > MAX_THUMBNAIL_BYTES * 2) throw new Error("Invalid card thumbnail payload.");
    return { key, dataUrl };
  })
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { putManiaCardThumbnailAndGetUrl } = await import("./r2-cache");
    return {
      url: await putManiaCardThumbnailAndGetUrl(data.key, decodeWebpDataUrl(data.dataUrl)),
    };
  });
