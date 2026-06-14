import type { CollectedCard } from "#/lib/pack-collection";
import {
  buildManiaCardRenderDataFromSkills,
  getManiaCardRenderDataSignature,
} from "../player/maniacard3d/renderData";
import type { ManiaCardReadyData } from "../player/maniacard3d/types";

export const COLLECTION_CARD_THUMB_WIDTH = 240;

const CACHE_VERSION = "v1";
const CACHE_NAME = `mania-hub-maniacard-thumbs-${CACHE_VERSION}`;
const CACHE_ROUTE = "/__mania-card-thumbnails/";
const MAX_MEMORY_THUMBNAILS = 180;
const MAX_PERSISTED_THUMBNAILS = 900;
const PERSISTED_PRUNE_INTERVAL = 30;

const memoryCache = new Map<string, string>();
const pendingLoads = new Map<string, Promise<string | null>>();
let persistedWritesSincePrune = 0;

function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function cacheRequest(key: string): Request {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://mania-hub.local";
  return new Request(`${origin}${CACHE_ROUTE}${key}.webp`, {
    method: "GET",
    credentials: "same-origin",
  });
}

function canUseCacheStorage(): boolean {
  return typeof window !== "undefined" && typeof caches !== "undefined";
}

function isObjectUrl(url: string): boolean {
  return url.startsWith("blob:");
}

function rememberMemoryThumbnail(key: string, url: string): void {
  const previous = memoryCache.get(key);
  if (previous && previous !== url && isObjectUrl(previous)) URL.revokeObjectURL(previous);
  if (previous) memoryCache.delete(key);
  memoryCache.set(key, url);

  while (memoryCache.size > MAX_MEMORY_THUMBNAILS) {
    const oldestKey = memoryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldestUrl = memoryCache.get(oldestKey);
    memoryCache.delete(oldestKey);
    if (oldestUrl && isObjectUrl(oldestUrl)) URL.revokeObjectURL(oldestUrl);
  }
}

async function prunePersistedThumbnails(cache: Cache): Promise<void> {
  persistedWritesSincePrune += 1;
  if (persistedWritesSincePrune < PERSISTED_PRUNE_INTERVAL) return;
  persistedWritesSincePrune = 0;

  const keys = await cache.keys();
  const extra = keys.length - MAX_PERSISTED_THUMBNAILS;
  if (extra <= 0) return;
  await Promise.all(keys.slice(0, extra).map((request) => cache.delete(request)));
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export function cardThumbnailKeyForData(data: ManiaCardReadyData, width = COLLECTION_CARD_THUMB_WIDTH): string {
  const sourceSignature = [
    getManiaCardRenderDataSignature(data),
    data.user.avatar_url ?? "",
  ].join("|avatar:");
  return `${CACHE_VERSION}-w${width}-u${data.user.id}-${hashString(sourceSignature)}`;
}

export function cardThumbnailKeyForCollectionCard(card: CollectedCard, width = COLLECTION_CARD_THUMB_WIDTH): string | null {
  if (!card.skills) return null;
  return cardThumbnailKeyForData(
    buildManiaCardRenderDataFromSkills({
      user: {
        id: card.userId,
        username: card.username,
        avatar_url: card.avatarUrl,
        country_code: card.countryCode,
        statistics: { global_rank: card.globalRank, pp: card.pp },
      },
      skills: card.skills,
    }),
    width,
  );
}

export function getMemoryCardThumbnail(key: string | null): string | null {
  if (!key) return null;
  const url = memoryCache.get(key);
  if (!url) return null;
  memoryCache.delete(key);
  memoryCache.set(key, url);
  return url;
}

export async function loadPersistedCardThumbnail(key: string): Promise<string | null> {
  const memory = getMemoryCardThumbnail(key);
  if (memory) return memory;
  if (!canUseCacheStorage()) return null;

  const pending = pendingLoads.get(key);
  if (pending) return pending;

  const load = (async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const response = await cache.match(cacheRequest(key));
      if (!response) return null;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      rememberMemoryThumbnail(key, url);
      return url;
    } catch {
      return null;
    } finally {
      pendingLoads.delete(key);
    }
  })();

  pendingLoads.set(key, load);
  return load;
}

export async function rememberCardThumbnailBlob(key: string, blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  rememberMemoryThumbnail(key, url);

  if (canUseCacheStorage()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(
        cacheRequest(key),
        new Response(blob, {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": blob.type || "image/webp",
          },
        }),
      );
      await prunePersistedThumbnails(cache);
    } catch {
      // The in-memory URL is still enough for this session.
    }
  }

  return url;
}

export async function rememberCardThumbnailDataUrl(
  data: ManiaCardReadyData,
  dataUrl: string,
  width = COLLECTION_CARD_THUMB_WIDTH,
): Promise<void> {
  const key = cardThumbnailKeyForData(data, width);
  rememberMemoryThumbnail(key, dataUrl);

  if (!canUseCacheStorage()) return;
  try {
    await rememberCardThumbnailBlob(key, await dataUrlToBlob(dataUrl));
  } catch {
    // The data URL remains in memory for this session.
  }
}
