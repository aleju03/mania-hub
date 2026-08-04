import { createServerFn } from "@tanstack/react-start";
import { getLiveBackendUrl, getServerLiveBackendUrl } from "./live-backend";

// Community skins: public browsing goes straight to the live backend (CORS),
// per-user actions go through server fns that resolve the osu!-verified viewer
// from the auth cookie and forward it with the admin token (the goals bridge).
// The 50MB .osk upload itself is browser -> live backend with a short-lived
// ticket minted by startSkinUpload, so it never touches the Vercel body limit.

export interface SkinScreenshot {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SkinKeymodePreview extends SkinScreenshot {
  keys: number;
}

export interface SkinSummary {
  id: string;
  // URL slug ("pl0x-aleju03-mix"), assigned at publish; null only on rows
  // published before slugs existed and not yet backfilled. Page links prefer
  // it; API endpoints (download, delete, moderate) keep using the id.
  slug: string | null;
  name: string;
  // Who made the skin (skin.ini Author or uploader-provided); distinct from
  // the uploader and the primary credit on cards.
  author: string | null;
  description: string | null;
  ownerUserId: number;
  ownerUsername: string;
  keymodes: number[];
  accentColor: string | null;
  // Public: everyone reads every skin's count.
  downloadCount: number;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  previews: SkinKeymodePreview[];
  screenshots: SkinScreenshot[];
  oskUrl: string | null;
  oskSizeBytes: number | null;
  oskSha256: string | null;
  // When the uploader last swapped the .osk for a newer build; null while the
  // skin still carries the file it was published with.
  oskUpdatedAt: string | null;
  status: "pending" | "published" | "hidden";
  publishedAt: string | null;
}

export interface SkinsListResult {
  skins: SkinSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export const SKINS_PAGE_SIZE = 24;
export const SKIN_NAME_MAX_LENGTH = 80;
export const SKIN_AUTHOR_MAX_LENGTH = 64;
export const SKIN_DESCRIPTION_MAX_LENGTH = 500;
export const SKIN_OSK_MAX_BYTES = 50 * 1024 * 1024;
export const SKIN_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const SKIN_MAX_SCREENSHOTS = 4;

export type SkinsSort = "newest" | "downloads";

export interface SkinsListParams {
  q?: string;
  page?: number;
  sort?: SkinsSort;
  k?: number;
}

// The list endpoint is browser-cached (max-age=60 + stale-while-revalidate
// 300), which made a just-deleted skin linger on /skins even across reloads.
// Mutations stamp a deadline; until it passes, list fetches skip the HTTP
// cache and revalidate against the backend.
const SKINS_LIST_STALE_UNTIL_KEY = "mania-hub-skins-list-stale-until";
const SKINS_LIST_CACHE_WINDOW_MS = 6 * 60 * 1000;

export function markSkinsListStale(): void {
  skinsListMemory.clear();
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SKINS_LIST_STALE_UNTIL_KEY, String(Date.now() + SKINS_LIST_CACHE_WINDOW_MS));
  } catch {
    // Private-mode storage failures just fall back to cached lists.
  }
}

// Coming back from a skin page remounts /skins and refires the list fetch, so
// the grid fell back to skeletons even though the exact same page had just been
// on screen. Results stay in memory for the tab's lifetime; the page renders
// them at once and revalidates quietly behind them.
const SKINS_LIST_MEMORY_TTL_MS = 5 * 60 * 1000;
const SKINS_LIST_MEMORY_MAX = 12;
const skinsListMemory = new Map<string, { at: number; result: SkinsListResult }>();

export function skinsListCacheKey(params: SkinsListParams): string {
  return [params.q?.trim() ?? "", params.page ?? 0, params.sort ?? "newest", params.k ?? 0].join("|");
}

export function readCachedSkinsList(key: string): SkinsListResult | null {
  const entry = skinsListMemory.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SKINS_LIST_MEMORY_TTL_MS) {
    skinsListMemory.delete(key);
    return null;
  }
  return entry.result;
}

export function writeCachedSkinsList(key: string, result: SkinsListResult): void {
  skinsListMemory.set(key, { at: Date.now(), result });
  // Oldest insertion first, so the map stays bounded across a long browse.
  while (skinsListMemory.size > SKINS_LIST_MEMORY_MAX) {
    const oldest = skinsListMemory.keys().next();
    if (oldest.done) break;
    skinsListMemory.delete(oldest.value);
  }
}

// The skin page's back button wants the browse page exactly as it was left,
// filters, page and scroll included, which only a real history.back() gives.
// Opening a skin from the grid stamps the browse entry's history index; the
// back button only steps back when that entry is still the one behind it, so a
// skin opened from anywhere else falls back to a plain /skins navigation.
const SKINS_BROWSE_ENTRY_KEY = "mania-hub-skins-browse-entry";

export function rememberSkinsBrowseEntry(): void {
  if (typeof window === "undefined") return;
  if (!window.location.pathname.startsWith("/skins")) return;
  try {
    const index = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index;
    if (typeof index !== "number") return;
    window.sessionStorage.setItem(SKINS_BROWSE_ENTRY_KEY, String(index));
  } catch {
    // Storage failures just cost the back button its exact target.
  }
}

export function readSkinsBrowseEntry(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SKINS_BROWSE_ENTRY_KEY);
    const index = Number(raw);
    return raw != null && Number.isInteger(index) ? index : null;
  } catch {
    return null;
  }
}

function skinsListCacheMode(): RequestCache | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const until = Number(window.sessionStorage.getItem(SKINS_LIST_STALE_UNTIL_KEY));
    if (Number.isFinite(until) && until > Date.now()) return "no-cache";
  } catch {
    // Unreadable storage: keep default caching.
  }
  return undefined;
}

export async function fetchSkinsListDirect(params: SkinsListParams, init?: RequestInit): Promise<SkinsListResult> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const query = new URLSearchParams();
  const q = params.q?.trim() ?? "";
  if (q) query.set("q", q.slice(0, 80));
  if (params.page) query.set("page", String(params.page));
  if (params.sort === "downloads") query.set("sort", "downloads");
  if (params.k && Number.isInteger(params.k) && params.k >= 1 && params.k <= 10) query.set("k", String(params.k));
  query.set("pageSize", String(SKINS_PAGE_SIZE));
  const response = await fetch(`${base}/api/skins/list?${query.toString()}`, { credentials: "omit", cache: skinsListCacheMode(), ...init });
  if (!response.ok) throw new Error(`Server ${response.status}`);
  return response.json() as Promise<SkinsListResult>;
}

export const fetchSkinById = createServerFn({ method: "GET" })
  .validator((data: { id?: unknown }) => {
    // Accepts a slug or a raw row id; slugs with the short-id collision
    // fallback can run past 64 chars, hence the wider cap.
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 80) throw new Error("Invalid skin id.");
    return { id };
  })
  .handler(async ({ data }): Promise<SkinSummary | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    // The signed-in viewer rides along with the admin token so a true admin
    // reads hidden skins back (to unhide them); everyone else gets the public,
    // cacheable published-only view.
    const query = new URLSearchParams({ id: data.id });
    const headers: HeadersInit = {};
    try {
      const { readCurrentAuth } = await import("./auth-server");
      const auth = await readCurrentAuth();
      if (auth.viewer && process.env.LIVE_ADMIN_TOKEN) {
        headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
        query.set("viewerUserId", String(auth.viewer.id));
        if (auth.isAdmin) query.set("asAdmin", "1");
        const { setResponseHeader } = await import("@tanstack/react-start/server");
        setResponseHeader("Cache-Control", "private, no-store");
      }
    } catch {
      // Anonymous read path: no auth context available.
    }
    try {
      const response = await fetch(`${base}/api/skins/get?${query.toString()}`, { headers });
      if (!response.ok) return null;
      const body = (await response.json()) as { skin?: SkinSummary };
      return body.skin ?? null;
    } catch {
      return null;
    }
  });

// The skin that already holds the .osk bytes being uploaded, so the modal can
// link to it instead of just saying no.
export interface DuplicateSkinRef {
  id: string;
  slug: string | null;
  name: string;
  ownerUsername: string;
}

export type StartSkinUploadResult =
  | { ok: true; id: string; token: string; expiresAt: string }
  | { ok: false; error: "not_logged_in" | "unavailable" | "storage_not_configured" | "invalid_name" | "pending_limit" | "skin_limit" }
  | { ok: false; error: "duplicate"; duplicate: DuplicateSkinRef | null };

// SHA-256 of the picked .osk, hex, computed while the archive is being parsed.
// The backend rejects a hash that already belongs to a published skin, which
// turns a duplicate upload into an instant no instead of a 50MB transfer that
// fails at the end. Returns null wherever WebCrypto is unavailable (an
// insecure context); the server then catches the duplicate on its own hash.
export async function hashOskFile(file: Blob): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

interface SkinsBackend {
  base: string;
  headers: HeadersInit;
  userId: number;
  username: string;
  // A true admin, the same flag requireTrueAdminAccess checks. Moderation
  // paths forward it so an admin can fix up someone else's skin.
  isAdmin: boolean;
}

async function resolveSkinsBackend(): Promise<SkinsBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return { base, headers, userId: auth.viewer.id, username: auth.viewer.username, isAdmin: auth.isAdmin === true };
}

export const startSkinUpload = createServerFn({ method: "POST" })
  .validator((data: { name?: unknown; author?: unknown; description?: unknown; oskSha256?: unknown }) => ({
    name: typeof data.name === "string" ? data.name.slice(0, 80) : "",
    author: typeof data.author === "string" ? data.author.slice(0, SKIN_AUTHOR_MAX_LENGTH) : "",
    description: typeof data.description === "string" ? data.description.slice(0, SKIN_DESCRIPTION_MAX_LENGTH) : "",
    oskSha256: typeof data.oskSha256 === "string" && /^[0-9a-f]{64}$/i.test(data.oskSha256)
      ? data.oskSha256.toLowerCase()
      : null,
  }))
  .handler(async ({ data }): Promise<StartSkinUploadResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false, error: "not_logged_in" };
    try {
      const response = await fetch(`${cfg.base}/api/skins/start`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          username: cfg.username,
          name: data.name,
          author: data.author,
          description: data.description,
          oskSha256: data.oskSha256,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: string; error?: string; duplicate?: DuplicateSkinRef }
        | null;
      if (response.ok && body?.ok && body.id && body.token) {
        return { ok: true, id: body.id, token: body.token, expiresAt: body.expiresAt ?? "" };
      }
      if (body?.error === "duplicate") {
        return { ok: false, error: "duplicate", duplicate: body.duplicate ?? null };
      }
      if (body?.error === "invalid_name" || body?.error === "pending_limit" || body?.error === "skin_limit") {
        return { ok: false, error: body.error };
      }
      if (body?.error === "skin_storage_not_configured") {
        return { ok: false, error: "storage_not_configured" };
      }
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

// The bulk uploader's ticket mint. Same route as startSkinUpload, but it
// verifies a true admin and asks the backend to skip the per-user caps: a
// seeding run publishes a whole collection under one account, and the caps
// exist to stop a visitor filling storage. Duplicates are still refused.
export const startAdminSkinUpload = createServerFn({ method: "POST" })
  .validator((data: { name?: unknown; author?: unknown; description?: unknown; oskSha256?: unknown }) => ({
    name: typeof data.name === "string" ? data.name.slice(0, 80) : "",
    author: typeof data.author === "string" ? data.author.slice(0, SKIN_AUTHOR_MAX_LENGTH) : "",
    description: typeof data.description === "string" ? data.description.slice(0, SKIN_DESCRIPTION_MAX_LENGTH) : "",
    oskSha256: typeof data.oskSha256 === "string" && /^[0-9a-f]{64}$/i.test(data.oskSha256)
      ? data.oskSha256.toLowerCase()
      : null,
  }))
  .handler(async ({ data }): Promise<StartSkinUploadResult> => {
    const { requireTrueAdminAccess } = await import("./auth-server");
    await requireTrueAdminAccess("Bulk skin upload");
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false, error: "not_logged_in" };
    try {
      const response = await fetch(`${cfg.base}/api/skins/start`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          username: cfg.username,
          name: data.name,
          author: data.author,
          description: data.description,
          oskSha256: data.oskSha256,
          bypassLimits: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: string; error?: string; duplicate?: DuplicateSkinRef }
        | null;
      if (response.ok && body?.ok && body.id && body.token) {
        return { ok: true, id: body.id, token: body.token, expiresAt: body.expiresAt ?? "" };
      }
      if (body?.error === "duplicate") {
        return { ok: false, error: "duplicate", duplicate: body.duplicate ?? null };
      }
      if (body?.error === "invalid_name") return { ok: false, error: "invalid_name" };
      if (body?.error === "skin_storage_not_configured") return { ok: false, error: "storage_not_configured" };
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

export const deleteMySkin = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid skin id.");
    return { id };
  })
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/delete`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id }),
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  });

// Repoints an already published skin's card cover at another keymode's stored
// preview. No re-render, no upload: the images all exist, this only says which
// one fronts the card.
export const setSkinCoverKeymode = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; keys?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const keys = Math.round(Number(data.keys));
    if (!id || id.length > 64 || !Number.isInteger(keys) || keys < 1 || keys > 10) {
      throw new Error("Invalid cover request.");
    }
    return { id, keys };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/cover`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id, keys: data.keys, asAdmin: cfg.isAdmin }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// Retitles an already published skin. The URL slug is not rebuilt: it was
// assigned at publish time and is what shared links point at.
export const renameSkin = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; name?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const name = typeof data.name === "string" ? data.name.slice(0, SKIN_NAME_MAX_LENGTH).trim() : "";
    if (!id || id.length > 64 || !name) throw new Error("Invalid rename request.");
    return { id, name };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/rename`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id, name: data.name, asAdmin: cfg.isAdmin }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok || !body.skin) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// Mints an upload ticket against a published skin. Scope "previews" only
// unlocks preview re-renders (a different backdrop, say); "replace" also takes
// a newer .osk, which is how an uploader ships an updated build without
// republishing. Screenshots stay as published either way.
export type SkinEditScope = "previews" | "replace";

export const startSkinEdit = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; scope?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid skin id.");
    return { id, scope: (data.scope === "replace" ? "replace" : "previews") as SkinEditScope };
  })
  .handler(async ({ data }): Promise<StartSkinUploadResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false, error: "not_logged_in" };
    try {
      const response = await fetch(`${cfg.base}/api/skins/edit-start`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id, scope: data.scope, asAdmin: cfg.isAdmin }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: string; error?: string }
        | null;
      if (response.ok && body?.ok && body.id && body.token) {
        return { ok: true, id: body.id, token: body.token, expiresAt: body.expiresAt ?? "" };
      }
      if (body?.error === "skin_storage_not_configured") return { ok: false, error: "storage_not_configured" };
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

// Closes an edit ticket and hands back the skin as it now stands. Direct to
// the backend like finishSkinUpload: the ticket is the credential.
export async function finishSkinEdit(id: string, token: string): Promise<SkinSummary> {
  const base = getLiveBackendUrl();
  if (!base) throw new SkinUploadError("unavailable", "Server is not configured.");
  const query = new URLSearchParams({ id, token });
  const response = await fetch(`${base}/api/skins/edit-finish?${query.toString()}`, { method: "POST", credentials: "omit" });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary; error?: string } | null;
  if (!response.ok || !body?.ok || !body.skin) {
    const code = body?.error ?? "upload_failed";
    throw new SkinUploadError(code, uploadErrorMessage(code, response.status), response.status);
  }
  return body.skin;
}

export const moderateSkin = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; action?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const action = data.action === "hide" || data.action === "unhide" || data.action === "delete" ? data.action : null;
    if (!id || id.length > 64 || !action) throw new Error("Invalid moderation request.");
    return { id, action };
  })
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { requireTrueAdminAccess } = await import("./auth-server");
    await requireTrueAdminAccess("Skin moderation");
    const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
    if (!base) return { ok: false };
    const headers: HeadersInit = { "content-type": "application/json" };
    if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    try {
      const response = await fetch(`${base}/api/admin/skins/moderate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: data.id, action: data.action }),
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  });

export type SkinUploadPart = "osk" | "preview" | "screenshot";

export class SkinUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    // Set on code === "duplicate": the published skin holding these bytes.
    readonly duplicate?: DuplicateSkinRef | null,
    // Set on code === "rate_limited": how long the backend says to wait. The
    // bulk uploader sleeps exactly that long instead of guessing a pace.
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
  }
}

// XMLHttpRequest instead of fetch: only XHR exposes upload progress events,
// and the 65MB .osk deserves a real progress bar.
export function uploadSkinPart(options: {
  id: string;
  token: string;
  part: SkinUploadPart;
  blob: Blob;
  width?: number | null;
  height?: number | null;
  // For part=preview: which keymode this render shows, and whether it is the
  // card cover. The cover also carries the note-art accent sampled during the
  // render, which beats the skin.ini colours parsed server-side.
  keys?: number;
  cover?: boolean;
  accent?: string;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}): Promise<void> {
  const base = getLiveBackendUrl();
  if (!base) return Promise.reject(new SkinUploadError("unavailable", "Server is not configured."));
  const query = new URLSearchParams({ id: options.id, token: options.token, part: options.part });
  if (options.width) query.set("w", String(Math.round(options.width)));
  if (options.height) query.set("h", String(Math.round(options.height)));
  if (options.keys) query.set("keys", String(Math.round(options.keys)));
  if (options.cover) query.set("cover", "1");
  if (options.accent && /^#[0-9a-f]{6}$/i.test(options.accent)) query.set("accent", options.accent);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/api/skins/upload?${query.toString()}`);
    xhr.responseType = "json";
    if (options.onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      const body = xhr.response as { error?: string; reason?: string; duplicate?: DuplicateSkinRef; retryAfterMs?: number } | null;
      const code = body?.error === "invalid_osk" && body.reason ? `invalid_osk:${body.reason}` : body?.error ?? "upload_failed";
      reject(new SkinUploadError(code, uploadErrorMessage(code, xhr.status), xhr.status, body?.duplicate ?? null, body?.retryAfterMs ?? null));
    };
    xhr.onerror = () => reject(new SkinUploadError("network", "The upload failed. Check the connection and try again."));
    xhr.onabort = () => reject(new SkinUploadError("aborted", "The upload was cancelled."));
    xhr.send(options.blob);
  });
}

export async function finishSkinUpload(id: string, token: string): Promise<SkinSummary> {
  const base = getLiveBackendUrl();
  if (!base) throw new SkinUploadError("unavailable", "Server is not configured.");
  const query = new URLSearchParams({ id, token });
  const response = await fetch(`${base}/api/skins/finish?${query.toString()}`, { method: "POST", credentials: "omit" });
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; skin?: SkinSummary; error?: string; retryAfterMs?: number }
    | null;
  if (!response.ok || !body?.ok || !body.skin) {
    const code = body?.error ?? "upload_failed";
    throw new SkinUploadError(code, uploadErrorMessage(code, response.status), response.status, null, body?.retryAfterMs ?? null);
  }
  return body.skin;
}

export function uploadErrorMessage(code: string, status?: number): string {
  if (status === 413 || code === "payload_too_large") return "The file is over the 50 MB limit.";
  if (code === "invalid_ticket") return "The upload session expired. Publish again to restart.";
  if (code.startsWith("invalid_osk")) {
    if (code.includes("missing_skin_ini")) return "No skin.ini was found in this .osk file.";
    if (code.includes("no_mania_keymodes")) return "The skin.ini has no [Mania] section, so this skin has no mania keymodes.";
    if (code.includes("not_a_zip") || code.includes("zip_unreadable")) return "This file is not a readable .osk archive.";
    return "This .osk could not be validated as a mania skin.";
  }
  if (code === "duplicate") return "This exact .osk is already published on the site.";
  if (code === "invalid_image") return "Screenshots must be PNG, JPEG, or WebP images.";
  if (code === "screenshot_limit") return `A skin can have up to ${SKIN_MAX_SCREENSHOTS} screenshots.`;
  if (code === "rate_limited") return "Too many upload requests. Wait a minute and try again.";
  if (status === 503 || code === "skin_storage_not_configured") return "Skin storage is not available right now.";
  return "The upload failed. Try again.";
}

export function skinDownloadUrl(id: string): string | null {
  const base = getLiveBackendUrl();
  return base ? `${base}/api/skins/download?id=${encodeURIComponent(id)}` : null;
}

// CORS-safe .osk fetch for in-page features (asset explorer, map preview):
// the backend streams the stored object by filename without counting it as a
// download the way /api/skins/download does.
export function skinOskFileUrl(skin: Pick<SkinSummary, "id" | "oskUrl">): string | null {
  const base = getLiveBackendUrl();
  // The oskUrl path segment is already percent-encoded; decode before
  // re-encoding or filenames with spaces get double-encoded into 404s.
  const encoded = skin.oskUrl?.split("/").pop();
  if (!base || !encoded) return null;
  let filename = encoded;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    // Malformed escape: treat the segment as a literal filename.
  }
  return `${base}/api/skins/file/${encodeURIComponent(skin.id)}/${encodeURIComponent(filename)}`;
}

export function formatSkinFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function formatKeymodes(keymodes: number[]): string {
  if (keymodes.length === 0) return "";
  const labels = keymodes.map((keys) => `${keys}K`);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
