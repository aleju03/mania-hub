// The custom media overlay's local file. Only the newest two are kept, so the
// store never grows with every pick.
import { REPLAY_CUSTOM_MEDIA_STORE, withReplayStore } from "./replay-idb";
import type { ReplayCustomMedia } from "./replay-overlays";

export const REPLAY_CUSTOM_MEDIA_MAX_FILE_BYTES = 200 * 1024 * 1024;

export async function saveReplayCustomMediaFile(file: Blob): Promise<string | null> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Keep the previous file too: the settings that still point at it are only
  // replaced once the new pick is applied.
  const keys = await withReplayStore<IDBValidKey[]>(REPLAY_CUSTOM_MEDIA_STORE, "readonly", (store) => store.getAllKeys());
  const stale = (keys ?? []).map(String).sort().slice(0, -1);
  for (const key of stale) await withReplayStore(REPLAY_CUSTOM_MEDIA_STORE, "readwrite", (store) => store.delete(key));
  const saved = await withReplayStore(REPLAY_CUSTOM_MEDIA_STORE, "readwrite", (store) => store.put(file, id));
  return saved == null ? null : id;
}

export async function loadReplayCustomMediaFile(id: string): Promise<Blob | null> {
  const blob = await withReplayStore<unknown>(REPLAY_CUSTOM_MEDIA_STORE, "readonly", (store) => store.get(id));
  return blob instanceof Blob ? blob : null;
}

/** Where the element loads from; the caller revokes a returned object URL once it is done with it. */
export async function resolveReplayCustomMediaUrl(media: ReplayCustomMedia): Promise<{ url: string; objectUrl: boolean } | null> {
  if (media.url) return { url: media.url, objectUrl: false };
  if (!media.fileId) return null;
  const blob = await loadReplayCustomMediaFile(media.fileId);
  return blob ? { url: URL.createObjectURL(blob), objectUrl: true } : null;
}

/** Whether this page may read the link's bytes, which an exported video needs. */
export async function canReadReplayCustomMediaLink(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal });
    void response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}
