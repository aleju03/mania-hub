import { blankCanvas, liveIds, parseDoc, type EditorState, type FrameDoc } from "./doc";
import { canvasToBlob } from "./render";

/* Frame editor drafts, kept in this browser's IndexedDB: the document as
   JSON, each paint layer's pixels and each placed picture as PNG blobs, and
   a small thumbnail for the list. Nothing here leaves the browser until a
   frame is submitted. */

const DB_NAME = "mania-hub-frame-editor";
const STORE = "drafts";

interface DraftRecord {
  id: string;
  name: string;
  updatedAt: number;
  doc: FrameDoc;
  pixels: Record<string, Blob>;
  assets: Record<string, Blob>;
  thumb: Blob | null;
}

export interface DraftSummary {
  id: string;
  name: string;
  updatedAt: number;
  thumb: Blob | null;
  submitted: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the drafts."));
  });
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = body(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Could not reach the drafts."));
    };
  }));
}

export async function listDrafts(): Promise<DraftSummary[]> {
  if (typeof indexedDB === "undefined") return [];
  const all = await run<DraftRecord[]>("readonly", (store) => store.getAll() as IDBRequest<DraftRecord[]>);
  return all.map(({ id, name, updatedAt, thumb, doc }) => ({ id, name, updatedAt, thumb, submitted: doc?.submitted ?? null })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDraft(id: string): Promise<void> {
  await run("readwrite", (store) => store.delete(id));
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

export async function loadDraft(id: string): Promise<EditorState | null> {
  const record = await run<DraftRecord | undefined>("readonly", (store) => store.get(id) as IDBRequest<DraftRecord | undefined>);
  const doc = record ? parseDoc(record.doc) : null;
  if (!record || !doc) return null;
  const pixels: EditorState["pixels"] = {};
  const assets: EditorState["assets"] = {};
  const wanted = liveIds(doc);
  await Promise.all([
    ...Object.entries(record.pixels).filter(([key]) => wanted.pixels.has(key)).map(async ([key, blob]) => {
      pixels[key] = await blobToCanvas(blob).catch(() => blankCanvas());
    }),
    ...Object.entries(record.assets).filter(([key]) => wanted.assets.has(key)).map(async ([key, blob]) => {
      assets[key] = await blobToCanvas(blob).catch(() => blankCanvas(8));
    }),
  ]);
  for (const key of wanted.pixels) pixels[key] ??= blankCanvas();
  return { doc, pixels, assets };
}

/* Blobs already written for a canvas, so an autosave only encodes what changed. */
const encoded = new WeakMap<HTMLCanvasElement, Blob>();

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const known = encoded.get(canvas);
  if (known) return known;
  const blob = await canvasToBlob(canvas);
  encoded.set(canvas, blob);
  return blob;
}

export async function saveDraft(id: string, state: EditorState, thumb: HTMLCanvasElement | null, updatedAt = Date.now()): Promise<void> {
  const wanted = liveIds(state.doc);
  const pixels: Record<string, Blob> = {};
  const assets: Record<string, Blob> = {};
  await Promise.all([
    ...[...wanted.pixels].filter((key) => state.pixels[key]).map(async (key) => {
      pixels[key] = await encode(state.pixels[key]);
    }),
    ...[...wanted.assets].filter((key) => state.assets[key]).map(async (key) => {
      assets[key] = await encode(state.assets[key]);
    }),
  ]);
  const record: DraftRecord = {
    id,
    name: state.doc.name,
    updatedAt,
    doc: state.doc,
    pixels,
    assets,
    thumb: thumb ? await canvasToBlob(thumb).catch(() => null) : null,
  };
  await run("readwrite", (store) => store.put(record));
}

export async function draftUpdatedAt(id: string): Promise<number | null> {
  const record = await run<DraftRecord | undefined>("readonly", (store) => store.get(id) as IDBRequest<DraftRecord | undefined>);
  return record?.updatedAt ?? null;
}

/* --- A draft as one JSON string, for the account copy ------------------------------ */

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the picture."));
    reader.readAsDataURL(blob);
  });
}

export async function draftToJson(state: EditorState): Promise<string> {
  const wanted = liveIds(state.doc);
  const pixels: Record<string, string> = {};
  const assets: Record<string, string> = {};
  await Promise.all([
    ...[...wanted.pixels].filter((key) => state.pixels[key]).map(async (key) => {
      pixels[key] = await blobToDataUrl(await encode(state.pixels[key]));
    }),
    ...[...wanted.assets].filter((key) => state.assets[key]).map(async (key) => {
      assets[key] = await blobToDataUrl(await encode(state.assets[key]));
    }),
  ]);
  return JSON.stringify({ doc: state.doc, pixels, assets });
}

export async function draftFromJson(body: string): Promise<EditorState | null> {
  let raw: { doc?: unknown; pixels?: Record<string, unknown>; assets?: Record<string, unknown> };
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const doc = parseDoc(raw.doc);
  if (!doc) return null;
  const wanted = liveIds(doc);
  const read = async (value: unknown, size?: number) => {
    if (typeof value !== "string" || !value.startsWith("data:image/")) return size ? blankCanvas(size) : blankCanvas();
    return blobToCanvas(await (await fetch(value)).blob()).catch(() => blankCanvas());
  };
  const pixels: EditorState["pixels"] = {};
  const assets: EditorState["assets"] = {};
  await Promise.all([
    ...[...wanted.pixels].map(async (key) => {
      pixels[key] = await read(raw.pixels?.[key]);
    }),
    ...[...wanted.assets].map(async (key) => {
      assets[key] = await read(raw.assets?.[key], 8);
    }),
  ]);
  return { doc, pixels, assets };
}

export async function canvasToDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return blobToDataUrl(await canvasToBlob(canvas));
}

/* Whether a thumbnail shows anything: a draft opened and left blank has nothing worth listing. */
async function thumbHasArt(thumb: Blob | null): Promise<boolean> {
  if (!thumb) return false;
  try {
    const canvas = await blobToCanvas(thumb);
    const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) return true;
    return false;
  } catch {
    return false;
  }
}

/* The drafts worth showing: the ones with something drawn in them. */
export async function listDraftsWithArt(): Promise<DraftSummary[]> {
  const drafts = await listDrafts();
  const keep = await Promise.all(drafts.map((draft) => thumbHasArt(draft.thumb)));
  return drafts.filter((_, index) => keep[index]);
}
