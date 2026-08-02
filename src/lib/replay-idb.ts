// The replay viewer's IndexedDB: skin data too big for localStorage.
//
// One database, one version, every store created in the same upgrade. Opening
// the same database at different versions from two modules fails the lower
// one outright, so both stores are declared here rather than where they are
// used.

const DB_NAME = "mania-hub-replay";
const DB_VERSION = 2;

export const REPLAY_SKIN_SOUNDS_STORE = "skin-sounds";
// Decoded player skins (image data URLs plus samples), keyed by skin and the
// time its owner last saved it. Unzipping and decoding a .osk costs about a
// second, which the stage would otherwise spend showing the wrong skin.
export const REPLAY_OWNER_SKINS_STORE = "owner-skins";

const STORES = [REPLAY_SKIN_SOUNDS_STORE, REPLAY_OWNER_SKINS_STORE];

export function openReplayDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !window.indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function withReplayStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openReplayDatabase();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(storeName, mode);
      const request = run(tx.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}
