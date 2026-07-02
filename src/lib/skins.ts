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

export interface SkinSummary {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: number;
  ownerUsername: string;
  keymodes: number[];
  accentColor: string | null;
  downloadCount: number;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  screenshots: SkinScreenshot[];
  oskUrl: string | null;
  oskSizeBytes: number | null;
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
export const SKIN_DESCRIPTION_MAX_LENGTH = 500;
export const SKIN_OSK_MAX_BYTES = 50 * 1024 * 1024;
export const SKIN_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const SKIN_MAX_SCREENSHOTS = 4;

export interface SkinsListParams {
  q?: string;
  page?: number;
}

export async function fetchSkinsListDirect(params: SkinsListParams, init?: RequestInit): Promise<SkinsListResult> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const query = new URLSearchParams();
  const q = params.q?.trim() ?? "";
  if (q) query.set("q", q.slice(0, 80));
  if (params.page) query.set("page", String(params.page));
  query.set("pageSize", String(SKINS_PAGE_SIZE));
  const response = await fetch(`${base}/api/skins/list?${query.toString()}`, { credentials: "omit", ...init });
  if (!response.ok) throw new Error(`Server ${response.status}`);
  return response.json() as Promise<SkinsListResult>;
}

export const fetchSkinById = createServerFn({ method: "GET" })
  .inputValidator((data: { id?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid skin id.");
    return { id };
  })
  .handler(async ({ data }): Promise<SkinSummary | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    // A true admin also sees hidden skins (to unhide them); everyone else gets
    // the public published-only view.
    const headers: HeadersInit = {};
    try {
      const { readCurrentAuth } = await import("./auth-server");
      const auth = await readCurrentAuth();
      if (auth.isAdmin && process.env.LIVE_ADMIN_TOKEN) {
        headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
        const { setResponseHeader } = await import("@tanstack/react-start/server");
        setResponseHeader("Cache-Control", "private, no-store");
      }
    } catch {
      // Anonymous read path: no auth context available.
    }
    try {
      const response = await fetch(`${base}/api/skins/get?id=${encodeURIComponent(data.id)}`, { headers });
      if (!response.ok) return null;
      const body = (await response.json()) as { skin?: SkinSummary };
      return body.skin ?? null;
    } catch {
      return null;
    }
  });

export type StartSkinUploadResult =
  | { ok: true; id: string; token: string; expiresAt: string }
  | { ok: false; error: "not_logged_in" | "unavailable" | "invalid_name" | "pending_limit" | "skin_limit" };

interface SkinsBackend {
  base: string;
  headers: HeadersInit;
  userId: number;
  username: string;
}

async function resolveSkinsBackend(): Promise<SkinsBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return { base, headers, userId: auth.viewer.id, username: auth.viewer.username };
}

export const startSkinUpload = createServerFn({ method: "POST" })
  .inputValidator((data: { name?: unknown; description?: unknown }) => ({
    name: typeof data.name === "string" ? data.name.slice(0, 80) : "",
    description: typeof data.description === "string" ? data.description.slice(0, SKIN_DESCRIPTION_MAX_LENGTH) : "",
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
        body: JSON.stringify({ userId: cfg.userId, username: cfg.username, name: data.name, description: data.description }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: string; error?: string }
        | null;
      if (response.ok && body?.ok && body.id && body.token) {
        return { ok: true, id: body.id, token: body.token, expiresAt: body.expiresAt ?? "" };
      }
      if (body?.error === "invalid_name" || body?.error === "pending_limit" || body?.error === "skin_limit") {
        return { ok: false, error: body.error };
      }
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

export const deleteMySkin = createServerFn({ method: "POST" })
  .inputValidator((data: { id?: unknown }) => {
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

export const moderateSkin = createServerFn({ method: "POST" })
  .inputValidator((data: { id?: unknown; action?: unknown }) => {
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
  constructor(readonly code: string, message: string, readonly status?: number) {
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
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}): Promise<void> {
  const base = getLiveBackendUrl();
  if (!base) return Promise.reject(new SkinUploadError("unavailable", "Server is not configured."));
  const query = new URLSearchParams({ id: options.id, token: options.token, part: options.part });
  if (options.width) query.set("w", String(Math.round(options.width)));
  if (options.height) query.set("h", String(Math.round(options.height)));
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
      const body = xhr.response as { error?: string; reason?: string } | null;
      const code = body?.error === "invalid_osk" && body.reason ? `invalid_osk:${body.reason}` : body?.error ?? "upload_failed";
      reject(new SkinUploadError(code, uploadErrorMessage(code, xhr.status), xhr.status));
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
  const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary; error?: string } | null;
  if (!response.ok || !body?.ok || !body.skin) {
    const code = body?.error ?? "upload_failed";
    throw new SkinUploadError(code, uploadErrorMessage(code, response.status), response.status);
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
