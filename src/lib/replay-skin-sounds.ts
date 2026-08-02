// Persistence for hitsound samples imported from a .osk skin.
//
// Sample bytes are too large for localStorage (which already holds the skin's
// image assets), so they live in IndexedDB as a single record that is replaced
// on each skin import.

import { REPLAY_SKIN_SOUNDS_STORE, withReplayStore } from "./replay-idb";

const STORE_NAME = REPLAY_SKIN_SOUNDS_STORE;
const RECORD_KEY = "current";

export const REPLAY_SKIN_SOUNDS_CHANGE_EVENT = "mania-hub:replay-skin-sounds-change";

function dispatchSkinSoundsChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REPLAY_SKIN_SOUNDS_CHANGE_EVENT));
}

export interface ReplaySkinSoundsRecord {
  skinName: string | null;
  updatedAt: number;
  // Keyed by lowercased sample name without extension, e.g. "normal-hitnormal".
  samples: Record<string, ArrayBuffer>;
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return withReplayStore(STORE_NAME, mode, run);
}

export async function readReplaySkinSounds(): Promise<ReplaySkinSoundsRecord | null> {
  const record = await withStore<unknown>("readonly", (store) => store.get(RECORD_KEY));
  if (!record || typeof record !== "object") return null;
  const parsed = record as ReplaySkinSoundsRecord;
  if (!parsed.samples || typeof parsed.samples !== "object") return null;
  return parsed;
}

export async function writeReplaySkinSounds(record: ReplaySkinSoundsRecord): Promise<boolean> {
  const result = await withStore("readwrite", (store) => store.put(record, RECORD_KEY));
  dispatchSkinSoundsChange();
  return result !== null;
}

export async function clearReplaySkinSounds(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(RECORD_KEY));
  dispatchSkinSoundsChange();
}
