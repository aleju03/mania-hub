import { cardMotifSignature } from "#/lib/card-motif";
import { collectedCardTier, type CollectedCard } from "#/lib/pack-collection";
import {
  fetchPackCardThumbnailBaseUrl,
  fetchR2PackCardThumbnails,
  fetchR2PackCardThumbnail,
  uploadR2PackCardThumbnail,
} from "#/lib/pack-card-thumbnails";
import { buildPackThumbnailStorageKey } from "#/lib/pack-thumbnail-shared";
import { buildManiaCardRenderDataFromSkills } from "../player/maniacard3d/renderData";
import type { ManiaCardReadyData } from "../player/maniacard3d/types";

export const COLLECTION_CARD_THUMB_WIDTH = 240;

/* This version describes the pixels in a cached thumbnail, not the wider
   maniacard data model. Bump it whenever cardTexture/textureLayout changes in
   a way that can change the rendered front while these inputs stay equal.

   Bumping is expensive and global: it re-addresses all ~68k objects in the
   shared R2 pool, so every card anyone looks at is re-rendered and re-uploaded
   to produce the same bytes. A change that can only alter one kind of card
   belongs in that card's signature below instead. */
const CACHE_VERSION = "v2";
const CACHE_NAME_PREFIX = "mania-hub-maniacard-thumbs-";
const CACHE_NAME = `${CACHE_NAME_PREFIX}${CACHE_VERSION}`;
const CACHE_ROUTE = "/__mania-card-thumbnails/";
const MAX_MEMORY_THUMBNAILS = 180;
const MAX_PERSISTED_THUMBNAILS = 900;
const PERSISTED_PRUNE_INTERVAL = 30;
const MAX_R2_UPLOADS = 2;

const memoryCache = new Map<string, string>();
const pendingLoads = new Map<string, Promise<string | null>>();
const pendingRemoteLoads = new Map<string, Promise<string | null>>();
const pendingRemoteUploads = new Set<string>();
const remoteUploadQueue: Array<() => void> = [];
let activeRemoteUploads = 0;
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

let cacheOpen: Promise<Cache> | null = null;

/* The thumbnail cache, with the buckets left behind by earlier CACHE_VERSIONs
   dropped on the way. A bump renames the bucket rather than emptying it, and
   nothing else ever looks at the old name again: without this, every bump
   would leave a browser holding a few hundred megabytes of thumbnails of a
   card front that is no longer drawn that way. */
function openThumbnailCache(): Promise<Cache> {
  if (!cacheOpen) {
    cacheOpen = (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        for (const name of await caches.keys()) {
          if (name.startsWith(CACHE_NAME_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
        }
      } catch {
        // Quota this frees is a bonus; the open cache is what was asked for.
      }
      return cache;
    })().catch((error) => {
      /* A failed open must not be remembered. This promise is the only handle
         the page ever builds, so keeping a rejected one would turn the
         persisted tier off for the rest of the visit over what is usually a
         transient failure, and turn it off silently: both callers catch and
         fall back to re-rendering the card. */
      cacheOpen = null;
      throw error;
    });
  }
  return cacheOpen;
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Card thumbnail encoding failed."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Card thumbnail encoding failed."));
    reader.readAsDataURL(blob);
  });
}

/* Which keys the pool is already known to hold, so a reveal of a card someone
   has posted before costs nothing at all. Persisted because the waste this
   avoids is mostly the same browser re-rendering the same cards on later
   visits. Keys are content-addressed, so "present" cannot go stale in the
   wrong direction -- only a lifecycle expiry can falsify it, which the <img>
   404 path catches and corrects through markThumbnailMissing.

   It lives in CacheStorage, beside the thumbnail blobs, and deliberately not
   in localStorage: this list runs to ~100KB, localStorage is a ~5MB budget
   this app already crowds (see the quota-eviction handling in store.ts), and
   overflowing it would not drop this list, it would drop the write the store
   was making at the time. CacheStorage draws on the origin's much larger
   storage pool instead, and losing it to browser eviction only costs a probe.
   Its own cache name keeps it clear of prunePersistedThumbnails' LRU. */
const PRESENT_KEYS_CACHE_NAME = "mania-hub-maniacard-present-v1";
const PRESENT_KEYS_ROUTE = `${CACHE_ROUTE}present-keys.json`;
// Where the same list lived before it moved off localStorage. Read once so a
// returning browser keeps what it learned, then deleted to hand back the quota.
const PRESENT_KEYS_LEGACY_STORAGE = "mania-hub-maniacard-present-v1";
const MAX_PRESENT_KEYS = 3000;
const knownPresentKeys = new Set<string>();
const knownMissingKeys = new Set<string>();

function presentKeysRequest(): Request {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://mania-hub.local";
  return new Request(`${origin}${PRESENT_KEYS_ROUTE}`, { method: "GET", credentials: "same-origin" });
}

function drainLegacyPresentKeys(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PRESENT_KEYS_LEGACY_STORAGE);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) if (typeof entry === "string") knownPresentKeys.add(entry);
    }
    window.localStorage.removeItem(PRESENT_KEYS_LEGACY_STORAGE);
  } catch {
    // Unparseable or blocked: drop it rather than keep paying for it.
    try {
      window.localStorage.removeItem(PRESENT_KEYS_LEGACY_STORAGE);
    } catch {
      // Nothing else to try.
    }
  }
}

let presentKeysReady: Promise<void> | null = null;

function ensurePresentKeysLoaded(): Promise<void> {
  if (!presentKeysReady) {
    presentKeysReady = (async () => {
      drainLegacyPresentKeys();
      if (!canUseCacheStorage()) return;
      try {
        const cache = await caches.open(PRESENT_KEYS_CACHE_NAME);
        const response = await cache.match(presentKeysRequest());
        if (!response) return;
        const parsed = await response.json();
        if (Array.isArray(parsed)) {
          for (const entry of parsed) if (typeof entry === "string") knownPresentKeys.add(entry);
        }
      } catch {
        // A fresh set just means probing again.
      }
    })();
  }
  return presentKeysReady;
}

let presentKeysWriteTimer: number | null = null;

function markThumbnailPresent(key: string): void {
  knownMissingKeys.delete(key);
  if (knownPresentKeys.has(key)) return;
  knownPresentKeys.add(key);
  while (knownPresentKeys.size > MAX_PRESENT_KEYS) {
    const oldest = knownPresentKeys.values().next().value as string | undefined;
    if (!oldest) break;
    knownPresentKeys.delete(oldest);
  }
  if (typeof window === "undefined" || !canUseCacheStorage()) return;
  // Browsing a page marks a screenful at once; one write per burst is enough.
  if (presentKeysWriteTimer != null) return;
  presentKeysWriteTimer = window.setTimeout(() => {
    presentKeysWriteTimer = null;
    void (async () => {
      try {
        // Merge with what is already stored first. Browsing marks keys before
        // anything has read the list back, and writing then would replace an
        // earlier session's knowledge with just this screenful.
        await ensurePresentKeysLoaded();
        const cache = await caches.open(PRESENT_KEYS_CACHE_NAME);
        await cache.put(
          presentKeysRequest(),
          new Response(JSON.stringify([...knownPresentKeys]), {
            headers: { "content-type": "application/json" },
          }),
        );
      } catch {
        // Quota or private mode: the in-memory set still covers this session.
      }
    })();
  }, 1000);
}

/* Called when a pool URL 404s, so the upload that follows can skip its probe
   and tell the server the object is genuinely gone. */
export function markThumbnailMissing(key: string): void {
  knownPresentKeys.delete(key);
  knownMissingKeys.add(key);
}

/* Called when a card's pool image loads: the object provably exists, so a
   later local render of the same card (a duplicate pull is the common one)
   can skip its probe entirely instead of spending a CDN request to learn what
   this load already proved. Only a pool URL counts - a blob or data URL is a
   local render and says nothing about the pool. */
export function noteCardThumbnailStored(card: CollectedCard, displayedUrl: string): void {
  if (!/^https?:/.test(displayedUrl)) return;
  const key = cardThumbnailKeyForCollectionCard(card);
  if (key) markThumbnailPresent(key);
}

let baseUrlPromise: Promise<string | null> | null = null;

function getPoolBaseUrl(): Promise<string | null> {
  if (!baseUrlPromise) {
    baseUrlPromise = fetchPackCardThumbnailBaseUrl()
      .then((result) => result.baseUrl)
      .catch(() => null);
  }
  return baseUrlPromise;
}

async function poolUrlForKey(key: string): Promise<string | null> {
  const baseUrl = await getPoolBaseUrl();
  if (!baseUrl || typeof crypto === "undefined" || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${baseUrl}/${buildPackThumbnailStorageKey(key, hex)}`;
}

const PROBE_TIMEOUT_MS = 6000;

/* Asks the CDN whether the pool already holds this object. A hit is served
   from the edge (or the browser's own cache) and costs no R2 operation, which
   is the whole point: the server-side Head this replaces cost one every time.
   "unknown" means we could not tell, and the caller must let the server decide
   rather than force a blind write. */
function probePoolObject(url: string): Promise<"present" | "missing" | "unknown"> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value: "present" | "missing" | "unknown") => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    image.onload = () => finish("present");
    image.onerror = () => finish("missing");
    window.setTimeout(() => finish("unknown"), PROBE_TIMEOUT_MS);
    image.src = url;
  });
}

async function uploadThumbnailToR2(key: string, blob: Blob): Promise<void> {
  if (pendingRemoteUploads.has(key) || knownPresentKeys.has(key)) return;
  pendingRemoteUploads.add(key);
  // Only a run that actually took a slot may hand one back, or a probe that
  // ended in a skip would release a slot it never held and let the queue run
  // more than MAX_R2_UPLOADS uploads at once.
  let holdsUploadSlot = false;
  try {
    // The persisted set is read lazily, so the cheap synchronous check above
    // can miss on the first upload of a session. Settle it before probing.
    await ensurePresentKeysLoaded();
    if (knownPresentKeys.has(key)) return;

    let probedMissing = knownMissingKeys.has(key);
    if (!probedMissing) {
      const url = await poolUrlForKey(key);
      const verdict = url ? await probePoolObject(url) : "unknown";
      if (verdict === "present") {
        markThumbnailPresent(key);
        return;
      }
      probedMissing = verdict === "missing";
    }

    if (activeRemoteUploads >= MAX_R2_UPLOADS) {
      await new Promise<void>((resolve) => remoteUploadQueue.push(resolve));
    }
    activeRemoteUploads += 1;
    holdsUploadSlot = true;
    await uploadR2PackCardThumbnail({ data: { key, dataUrl: await blobToDataUrl(blob), probedMissing } });
    markThumbnailPresent(key);
  } catch {
    // Best-effort: local caches still cover this browser.
  } finally {
    pendingRemoteUploads.delete(key);
    if (holdsUploadSlot) {
      activeRemoteUploads = Math.max(0, activeRemoteUploads - 1);
      remoteUploadQueue.shift()?.();
    }
  }
}

export function cardThumbnailKeyForData(data: ManiaCardReadyData, width = COLLECTION_CARD_THUMB_WIDTH): string {
  const sourceSignature = getCardThumbnailRenderSignature(data);
  return `${CACHE_VERSION}-w${width}-u${data.user.id}-${hashString(sourceSignature)}`;
}

/* Deliberately narrower than getManiaCardRenderDataSignature: the thumbnail
   is only the card's front texture. Country, next-tier progress and the
   non-displayed skill axes belong to the full 3D panel, so keying on them
   caused identical thumbnails to be re-uploaded when unrelated card data or
   UI behavior changed. The avatar render URL already carries osu!'s version
   token, making the raw source URL redundant here. */
function getCardThumbnailRenderSignature(data: ManiaCardReadyData): string {
  const parts = [
    data.user.username,
    data.avatarUrl,
    data.tier,
    data.tierStyle.label,
    signatureColor(data.glowColor),
    data.badgeGradientStops.map((stop) => `${stop.color}:${signatureNumber(stop.offset)}`).join(","),
    signatureNumber(data.skills.starAvg),
    data.stats.map((stat) => `${stat.label}:${signatureNumber(stat.value)}`).join(","),
  ];
  /* Granted background art, appended only for the cards that float any.

     It has to be in here at all because the pool is shared and keyed on the
     card, not on the holder: two owners of the same player at the same
     snapshot land on one object, so without this the holder who was given art
     and the holder who was not would race for it, and whoever rendered first
     would decide what the other one sees.

     And it has to be appended rather than joined in unconditionally, or every
     thumbnail in the pool changes address over a field that is empty for all
     but a handful of cards. The leading token is the scatter's own version:
     bump it when drawMotifPattern changes, and only cards with art re-render. */
  if (data.motif) parts.push(`motif2:${cardMotifSignature(data.motif)}`);
  return parts.join("|");
}

function signatureColor(color: { r: number; g: number; b: number; a: number }): string {
  return [color.r, color.g, color.b, color.a].map(signatureNumber).join(",");
}

function signatureNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

/* Building a key means rebuilding the render data, parsing the tier colours
   and hashing the front texture's inputs. The album asks for the same cards'
   keys twice on every one of its renders -- once for the spread signature,
   once per slot, both outside the
   memoized slot itself -- so the answer is cached per card object. The wallet
   and the server collection are copy-on-write, so a card whose data changed is
   always a different object and can never be served a stale key. Keyed by
   width too, or the 240px key would be handed to any other size. */
const keyCacheByWidth = new Map<number, WeakMap<CollectedCard, string | null>>();

export function cardThumbnailKeyForCollectionCard(card: CollectedCard, width = COLLECTION_CARD_THUMB_WIDTH): string | null {
  let cached = keyCacheByWidth.get(width);
  if (!cached) {
    cached = new WeakMap();
    keyCacheByWidth.set(width, cached);
  }
  /* Not a truthiness test: null is a legitimate cached answer for a card with
     no skills. */
  const hit = cached.get(card);
  if (hit !== undefined) return hit;
  const key = card.skills ? buildCollectionCardKey(card, card.skills, width) : null;
  cached.set(card, key);
  return key;
}

function buildCollectionCardKey(
  card: CollectedCard,
  skills: NonNullable<CollectedCard["skills"]>,
  width: number,
): string {
  return cardThumbnailKeyForData(
    buildManiaCardRenderDataFromSkills({
      user: {
        id: card.userId,
        username: card.username,
        avatar_url: card.avatarUrl,
        country_code: card.countryCode,
        statistics: { global_rank: card.globalRank, pp: card.pp },
      },
      skills,
      tierOverride: collectedCardTier(card),
      labelOverride: card.customLabel,
      motifOverride: card.motif,
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

/* Remote thumbnail URLs are constructed without an existence check, so a
   lifecycle-expired object surfaces as a 404 on the <img> itself. The two
   helpers below support that path: evict the dead URL so slots fall back to
   their skeleton while the local render runs, and let each key claim exactly
   one render-and-reupload attempt per session so a render failure cannot
   loop. */
export function forgetRemoteCardThumbnail(key: string): void {
  // The object is gone from the pool, so the re-upload that follows can skip
  // its existence probe.
  markThumbnailMissing(key);
  const url = memoryCache.get(key);
  // Object and data URLs came from a local render and cannot 404.
  if (!url || isObjectUrl(url) || !/^https?:/.test(url)) return;
  memoryCache.delete(key);
}

const claimedErrorFallbacks = new Set<string>();

export function claimCardThumbnailErrorFallback(key: string): boolean {
  if (claimedErrorFallbacks.has(key)) return false;
  claimedErrorFallbacks.add(key);
  return true;
}

export async function loadPersistedCardThumbnail(key: string): Promise<string | null> {
  const memory = getMemoryCardThumbnail(key);
  if (memory) return memory;
  if (!canUseCacheStorage()) return null;

  const pending = pendingLoads.get(key);
  if (pending) return pending;

  const load = (async () => {
    try {
      const cache = await openThumbnailCache();
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

export async function loadR2CardThumbnail(key: string): Promise<string | null> {
  const memory = getMemoryCardThumbnail(key);
  if (memory) return memory;

  const pending = pendingRemoteLoads.get(key);
  if (pending) return pending;

  const load = (async () => {
    try {
      const result = await fetchR2PackCardThumbnail({ data: { key } });
      if (!result.url) return null;
      rememberMemoryThumbnail(key, result.url);
      return result.url;
    } catch {
      return null;
    } finally {
      pendingRemoteLoads.delete(key);
    }
  })();

  pendingRemoteLoads.set(key, load);
  return load;
}

export async function loadR2CardThumbnails(keys: string[]): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const missingKeys: string[] = [];
  for (const key of [...new Set(keys)]) {
    const memory = getMemoryCardThumbnail(key);
    if (memory) urls[key] = memory;
    else missingKeys.push(key);
  }
  if (missingKeys.length === 0) return urls;

  try {
    const result = await fetchR2PackCardThumbnails({ data: { keys: missingKeys } });
    for (const [key, url] of Object.entries(result.urls)) {
      rememberMemoryThumbnail(key, url);
      urls[key] = url;
    }
  } catch {
    // Missing/slow remote thumbnails fall through to local rendering.
  }

  return urls;
}

/* Pulls a remote face's bytes into the browser's own cache. Resolving a
   thumbnail only hands back a URL, so a page warmed one turn ahead still had
   forty images to download the moment its tiles mounted, which is the pause a
   page turn used to be. Fetching them while nobody is looking makes the turn
   itself a cache read. Blob URLs are already bytes in hand, and one attempt
   per URL is enough: a failure here costs nothing, the tile fetches it again
   when it mounts. */
const preloadedThumbnails = new Set<string>();

export function preloadRemoteCardThumbnail(url: string): void {
  if (typeof window === "undefined" || !url.startsWith("http")) return;
  if (preloadedThumbnails.has(url)) return;
  preloadedThumbnails.add(url);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
}

export async function rememberCardThumbnailBlob(key: string, blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  rememberMemoryThumbnail(key, url);

  if (canUseCacheStorage()) {
    try {
      const cache = await openThumbnailCache();
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

  void uploadThumbnailToR2(key, blob);

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
