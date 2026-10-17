import { createServerFn } from "@tanstack/react-start";
import { getLiveBackendUrl } from "./live-backend";
import { liveBridgeToken } from "./live-backend-tokens";

/* Shared clips, a supporter perk: after exporting a replay video on their own
   device, a supporter can turn the file into a link that plays inline in
   Discord. The export itself never leaves the device; only the finished file
   the supporter chose to share is sent, straight from the browser to the live
   backend in parts (backend features/shared-clips.ts), against a ticket the
   server function below mints for the logged-in viewer. The link is
   /clip/<id>; its video and poster are /clip-media/<id>/video and /poster,
   which redirect to short-lived signed R2 URLs. A clip lives 24 hours. */

export const SHARED_CLIP_MAX_BYTES = 200 * 1024 * 1024;
export const SHARED_CLIP_TTL_HOURS = 24;

export type SharedClipContentType = "video/mp4" | "video/webm";

export interface SharedClip {
  id: string;
  ownerUserId: number;
  ownerUsername: string;
  title: string;
  replayPath: string | null;
  contentType: SharedClipContentType;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  hasPoster: boolean;
  createdAt: number;
  expiresAt: number;
}

export type SharedClipLookup = { state: "ready"; clip: SharedClip } | { state: "expired" } | { state: "missing" };

export function sharedClipPath(id: string): string {
  return `/clip/${id}`;
}

export function sharedClipMediaPath(id: string, file: "video" | "poster"): string {
  return `/clip-media/${id}/${file}`;
}

export function isSharedClipId(value: string): boolean {
  return /^[a-zA-Z0-9]{10}$/.test(value);
}

function serverBackendBase(): string | null {
  return (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "") || null;
}

/* Server side: the clip a link names, as the backend has it. */
export async function lookupSharedClip(id: string): Promise<SharedClipLookup> {
  if (!isSharedClipId(id)) return { state: "missing" };
  const base = serverBackendBase();
  if (!base) return { state: "missing" };
  const response = await fetch(`${base}/api/clips/${id}`, { headers: { accept: "application/json" } }).catch(() => null);
  if (!response) return { state: "missing" };
  if (response.status === 410) return { state: "expired" };
  if (!response.ok) return { state: "missing" };
  const body = (await response.json().catch(() => null)) as { clip?: SharedClip } | null;
  return body?.clip ? { state: "ready", clip: body.clip } : { state: "missing" };
}

export const getSharedClip = createServerFn({ method: "GET" })
  .validator((data: { id?: unknown }) => ({ id: typeof data.id === "string" ? data.id : "" }))
  .handler(async ({ data }) => lookupSharedClip(data.id));

export type StartSharedClipResult =
  | { ok: true; id: string; token: string; partBytes: number }
  | { ok: false; error: "not_logged_in" | "not_supporter" | "daily_limit" | "too_large" | "invalid_type" | "unavailable" };

export const startSharedClip = createServerFn({ method: "POST" })
  .validator((data: { title?: unknown; replayPath?: unknown; contentType?: unknown; sizeBytes?: unknown; width?: unknown; height?: unknown }) => ({
    title: typeof data.title === "string" ? data.title.slice(0, 160) : "",
    replayPath: typeof data.replayPath === "string" ? data.replayPath.slice(0, 512) : null,
    contentType: data.contentType === "video/webm" ? "video/webm" : data.contentType === "video/mp4" ? "video/mp4" : "",
    sizeBytes: Number(data.sizeBytes) || 0,
    width: Number(data.width) || null,
    height: Number(data.height) || null,
  }))
  .handler(async ({ data }): Promise<StartSharedClipResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    if (!auth.viewer) return { ok: false, error: "not_logged_in" };
    const base = serverBackendBase();
    if (!base) return { ok: false, error: "unavailable" };
    const headers: Record<string, string> = { "content-type": "application/json" };
    const bridgeToken = liveBridgeToken();
    if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
    try {
      const response = await fetch(`${base}/api/clips/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...data, userId: auth.viewer.id, username: auth.viewer.username }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; id?: string; token?: string; partBytes?: number; error?: string } | null;
      if (response.ok && body?.ok && body.id && body.token && body.partBytes) {
        return { ok: true, id: body.id, token: body.token, partBytes: body.partBytes };
      }
      if (body?.error === "not_supporter" || body?.error === "daily_limit" || body?.error === "too_large" || body?.error === "invalid_type") {
        return { ok: false, error: body.error };
      }
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

export class SharedClipUploadError extends Error {
  constructor(readonly code: "unavailable" | "rejected" | "network") {
    super(code);
  }
}

function post(url: string, body: Blob, onProgress?: (sent: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (onProgress) xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      // A 4xx is an answer (bad ticket, too big); retrying will not change it.
      else reject(new SharedClipUploadError(xhr.status >= 400 && xhr.status < 500 && xhr.status !== 429 ? "rejected" : "network"));
    };
    xhr.onerror = () => reject(new SharedClipUploadError("network"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function postWithRetry(url: string, body: Blob, onProgress?: (sent: number) => void, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await post(url, body, onProgress, signal);
      return;
    } catch (error) {
      if (!(error instanceof SharedClipUploadError) || error.code === "rejected" || attempt >= 2 || signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

/* Browser side: sends the file part by part (each its own request, so a slow
   uplink never meets a request timeout and a dropped part is retried alone),
   then the poster, then closes the upload. */
export async function uploadSharedClip(options: {
  id: string;
  token: string;
  partBytes: number;
  file: Blob;
  poster: Blob | null;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const base = getLiveBackendUrl();
  if (!base) throw new SharedClipUploadError("unavailable");
  const ticket = `id=${encodeURIComponent(options.id)}&token=${encodeURIComponent(options.token)}`;
  const total = options.file.size;
  let done = 0;
  for (let offset = 0, part = 1; offset < total; offset += options.partBytes, part += 1) {
    const chunk = options.file.slice(offset, Math.min(total, offset + options.partBytes));
    await postWithRetry(
      `${base}/api/clips/part?${ticket}&n=${part}`,
      chunk,
      (sent) => options.onProgress?.(done + sent, total),
      options.signal,
    );
    done += chunk.size;
    options.onProgress?.(done, total);
  }
  if (options.poster) {
    // The poster only dresses the embed; a clip without one still plays.
    await postWithRetry(`${base}/api/clips/poster?${ticket}`, options.poster, undefined, options.signal).catch(() => {});
  }
  await postWithRetry(`${base}/api/clips/finish?${ticket}`, new Blob([]), undefined, options.signal);
}

/* A still from a third of the way in, for the embed's poster: the opening
   frames of an export are usually the dimmed lead-in. Best effort; null when
   the browser cannot decode the file. */
export function captureSharedClipPoster(file: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), 10_000);
    video.muted = true;
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      video.currentTime = Number.isFinite(video.duration) ? video.duration / 3 : 1;
    };
    video.onseeked = () => {
      const width = Math.min(1280, video.videoWidth || 1280);
      const height = Math.round(width * ((video.videoHeight || 720) / (video.videoWidth || 1280)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return finish(null);
      context.drawImage(video, 0, 0, width, height);
      canvas.toBlob((blob) => finish(blob), "image/jpeg", 0.82);
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}
