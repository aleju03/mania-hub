// Frame editor drafts kept on a player's account, so they follow them to any
// browser. The editor keeps working from IndexedDB and sends a copy here a
// little while after each change. Stored in the private R2 bucket under
// frame-drafts/<user id>/: index.json.gz (names, times, thumbnails) and one
// <draft id>.json.gz per draft (the document with its pixels and pictures as
// PNG data URLs). Kept out of the server-function file so the logic can be
// tested with an in-memory store.

import { deleteFrameDraftObject, getFrameDraftObject, putFrameDraftObject } from "./r2-cache";

export const ACCOUNT_DRAFTS_MAX = 20;
/* A draft's document and pixels, as sent (characters of JSON). */
export const ACCOUNT_DRAFT_MAX_CHARS = 8 * 1024 * 1024;
const THUMB_MAX_CHARS = 60_000;

export interface AccountDraftSummary {
  id: string;
  name: string;
  updatedAt: number;
  thumb: string | null;
  /* the workshop frame it was submitted as, if any */
  submitted: string | null;
}

export interface DraftStore {
  get: (userId: number, file: string) => Promise<Buffer | null>;
  put: (userId: number, file: string, body: Buffer) => Promise<boolean>;
  remove: (userId: number, file: string) => Promise<void>;
}

export const r2DraftStore: DraftStore = { get: getFrameDraftObject, put: putFrameDraftObject, remove: deleteFrameDraftObject };

export function isDraftId(value: unknown): value is string {
  return typeof value === "string" && /^d[a-z0-9]{4,40}$/.test(value);
}

async function readJson<T>(store: DraftStore, userId: number, file: string): Promise<T | null> {
  const buffer = await store.get(userId, file);
  if (!buffer) return null;
  const zlib = await import("node:zlib");
  try {
    return JSON.parse(zlib.gunzipSync(buffer).toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(store: DraftStore, userId: number, file: string, value: unknown): Promise<void> {
  const zlib = await import("node:zlib");
  const ok = await store.put(userId, file, zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
  if (!ok) throw new Error("Drafts can't be saved to your account right now.");
}

function cleanSummary(raw: unknown): AccountDraftSummary | null {
  const value = raw as Partial<AccountDraftSummary> | null;
  if (!value || !isDraftId(value.id)) return null;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name.slice(0, 40) : "",
    updatedAt: Number(value.updatedAt) || 0,
    thumb: typeof value.thumb === "string" && value.thumb.startsWith("data:image/png;base64,") && value.thumb.length <= THUMB_MAX_CHARS ? value.thumb : null,
    submitted: typeof value.submitted === "string" && /^u\d{1,12}$/.test(value.submitted) ? value.submitted : null,
  };
}

export async function listAccountDrafts(userId: number, store: DraftStore = r2DraftStore): Promise<AccountDraftSummary[]> {
  const index = await readJson<{ drafts?: unknown[] }>(store, userId, "index.json.gz");
  return (index?.drafts ?? []).map(cleanSummary).filter((entry): entry is AccountDraftSummary => entry !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadAccountDraft(userId: number, id: string, store: DraftStore = r2DraftStore): Promise<string | null> {
  if (!isDraftId(id)) return null;
  const draft = await readJson<{ body?: unknown }>(store, userId, `${id}.json.gz`);
  return typeof draft?.body === "string" ? draft.body : null;
}

/* Saves one draft and its line in the index. Refuses a new one past the cap, and an older copy over a newer one. */
export async function saveAccountDraft(
  userId: number,
  input: { id: string; name: string; updatedAt: number; thumb: string | null; submitted: string | null; body: string },
  store: DraftStore = r2DraftStore,
): Promise<{ ok: true } | { ok: false; error: "full" | "too_big" | "stale" | "invalid" }> {
  if (!isDraftId(input.id) || typeof input.body !== "string") return { ok: false, error: "invalid" };
  if (input.body.length > ACCOUNT_DRAFT_MAX_CHARS) return { ok: false, error: "too_big" };
  const summary = cleanSummary(input);
  if (!summary) return { ok: false, error: "invalid" };
  const drafts = await listAccountDrafts(userId, store);
  const known = drafts.find((entry) => entry.id === input.id);
  if (known && known.updatedAt > summary.updatedAt) return { ok: false, error: "stale" };
  if (!known && drafts.length >= ACCOUNT_DRAFTS_MAX) return { ok: false, error: "full" };
  await writeJson(store, userId, `${input.id}.json.gz`, { body: input.body });
  await writeJson(store, userId, "index.json.gz", { drafts: [summary, ...drafts.filter((entry) => entry.id !== input.id)] });
  return { ok: true };
}

export async function deleteAccountDraft(userId: number, id: string, store: DraftStore = r2DraftStore): Promise<void> {
  if (!isDraftId(id)) return;
  const drafts = await listAccountDrafts(userId, store);
  await store.remove(userId, `${id}.json.gz`);
  if (drafts.some((entry) => entry.id === id)) await writeJson(store, userId, "index.json.gz", { drafts: drafts.filter((entry) => entry.id !== id) });
}

/* A workshop frame's picture, fetched for its maker to open in the editor (the CDN doesn't send CORS headers for canvas use). */
export function isFramePictureUrl(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/cdn\.mania-tracker\.com\/frames\/[a-f0-9]{64}\.png$/.test(url);
}
