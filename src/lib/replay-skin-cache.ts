// Decoded skins, kept in IndexedDB.
//
// Rebuilding one means downloading the .osk, unzipping it and decoding every
// image it references (for Percy-style bodies, a 20MB+ bitmap). That is about
// a second of work a stage would otherwise spend showing the wrong skin, so
// the finished result is cached under a key that changes whenever the skin or
// its customization does. Superseded entries age out by eviction.

import { REPLAY_OWNER_SKINS_STORE, withReplayStore } from "./replay-idb";
import type { ReplaySkinSettings } from "./replay-skin";

const INDEX_KEY = "index";
const CACHE_MAX_ENTRIES = 4;
// Bumped whenever the importer learns a new element, or corrects one it was
// already reading: entries decoded by an older build carry the old answer, and
// nothing else in the key would change. v6 also re-decodes on mobile so the
// adaptive 2048px texture cap replaces previously cached 4096px skin art.
const CACHE_VERSION = "v6";

function versionedKey(key: string): string {
  return `${CACHE_VERSION}:${key}`;
}

export interface CachedReplaySkin {
  settings: ReplaySkinSettings;
  sounds: Record<string, ArrayBuffer>;
}

interface CacheIndexEntry {
  key: string;
  cachedAt: number;
}

export async function readCachedReplaySkin(key: string): Promise<CachedReplaySkin | null> {
  const record = await withReplayStore<unknown>(REPLAY_OWNER_SKINS_STORE, "readonly", (store) => store.get(versionedKey(key)));
  if (!record || typeof record !== "object") return null;
  const entry = record as CachedReplaySkin;
  if (!entry.settings || typeof entry.settings !== "object") return null;
  return { settings: entry.settings, sounds: entry.sounds ?? {} };
}

// The index rides alongside the entries so eviction never has to read the
// (multi-MB) entries themselves just to find the oldest one.
async function readCacheIndex(): Promise<CacheIndexEntry[]> {
  const raw = await withReplayStore<unknown>(REPLAY_OWNER_SKINS_STORE, "readonly", (store) => store.get(INDEX_KEY));
  return Array.isArray(raw) ? (raw as CacheIndexEntry[]).filter((entry) => typeof entry?.key === "string") : [];
}

export async function writeCachedReplaySkin(
  key: string,
  entry: CachedReplaySkin,
  now: number,
): Promise<void> {
  const stored = await withReplayStore(REPLAY_OWNER_SKINS_STORE, "readwrite", (store) => store.put(entry, versionedKey(key)));
  // A quota rejection is not worth surfacing: the skin still loaded, the next
  // page just pays for the decode again.
  if (stored === null) return;

  // Entries from an older cache version go out with this pass; nothing reads
  // them again, and the index is the only record that they exist.
  const previous = (await readCacheIndex()).filter((existing) => existing.key !== versionedKey(key));
  const stale = previous.filter((existing) => !existing.key.startsWith(`${CACHE_VERSION}:`));
  const index = [
    { key: versionedKey(key), cachedAt: now },
    ...previous.filter((existing) => existing.key.startsWith(`${CACHE_VERSION}:`)),
  ];
  for (const evicted of [...stale, ...index.slice(CACHE_MAX_ENTRIES)]) {
    await withReplayStore(REPLAY_OWNER_SKINS_STORE, "readwrite", (store) => store.delete(evicted.key));
  }
  await withReplayStore(REPLAY_OWNER_SKINS_STORE, "readwrite", (store) =>
    store.put(index.slice(0, CACHE_MAX_ENTRIES), INDEX_KEY));
}
