// The custom media overlay's local file. A pick removes every stored file the
// saved settings no longer point at, so the store never grows with every pick
// and a file the saved settings still use is never removed.
import { REPLAY_CUSTOM_MEDIA_STORE, withReplayStore } from "./replay-idb";
import { readReplayOverlaySettings, type ReplayCustomMedia } from "./replay-overlays";

export const REPLAY_CUSTOM_MEDIA_MAX_FILE_BYTES = 200 * 1024 * 1024;

export async function saveReplayCustomMediaFile(file: Blob): Promise<string | null> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // The settings modal only saves on Save, so an earlier unsaved pick can go
  // but the file the saved settings use stays until a save replaces it.
  await pruneReplayCustomMediaFiles(readReplayOverlaySettings().media?.media?.fileId);
  const saved = await withReplayStore(REPLAY_CUSTOM_MEDIA_STORE, "readwrite", (store) => store.put(file, id));
  return saved == null ? null : id;
}

/** Deletes every stored file except `keep`. */
export async function pruneReplayCustomMediaFiles(...keep: Array<string | undefined>): Promise<void> {
  const keys = await withReplayStore<IDBValidKey[]>(REPLAY_CUSTOM_MEDIA_STORE, "readonly", (store) => store.getAllKeys());
  const kept = new Set(keep.filter(Boolean));
  for (const key of (keys ?? []).map(String)) {
    if (!kept.has(key)) await withReplayStore(REPLAY_CUSTOM_MEDIA_STORE, "readwrite", (store) => store.delete(key));
  }
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

/**
 * The media's bytes, for drawing it on the stage: the stored file, or the
 * link when its site allows other pages to read it. A link is held to the
 * same size cap as a picked file; null when it is over it or unreadable.
 */
export async function loadReplayCustomMediaBlob(media: ReplayCustomMedia, maxBytes = REPLAY_CUSTOM_MEDIA_MAX_FILE_BYTES): Promise<Blob | null> {
  if (!media.url) {
    const file = media.fileId ? await loadReplayCustomMediaFile(media.fileId) : null;
    return file && file.size <= maxBytes ? file : null;
  }
  const response = await fetch(media.url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) return null;
  const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) {
    const blob = await response.blob();
    return blob.size <= maxBytes ? blob : null;
  }
  // The declared length can be missing or wrong, so count what arrives.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], { type });
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
