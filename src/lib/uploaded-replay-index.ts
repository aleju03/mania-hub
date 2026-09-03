// Server-side bridge to the live backend's uploaded_replays owner index.
//
// The .osr files themselves live in R2 and are read straight from there; this
// only answers "who uploaded it", which R2 cannot be queried for. Kept free of
// any TanStack server-function context on purpose: the upload route handler
// (/api/replay-upload) records through here too, and route handlers run outside
// that context.

import { liveBridgeToken } from "./live-backend-tokens";

export interface UploadedReplayIndexRow {
  id: string;
  ownerUserId: number;
  ownerUsername: string;
  originalFilename: string | null;
  uploadedAt: string;
}

export interface UploadedReplayIndexPage {
  uploads: UploadedReplayIndexRow[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

const INDEX_TIMEOUT_MS = 8_000;

function resolveBackend(): { base: string; token: string } | null {
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  const token = liveBridgeToken();
  // The index is bridge-token gated end to end (the token is what vouches for
  // the viewer id we forward), so without one there is no index at all.
  if (!base || !token) return null;
  return { base, token };
}

export function isUploadedReplayIndexConfigured(): boolean {
  return resolveBackend() !== null;
}

async function callIndex(path: string, init: RequestInit = {}): Promise<Response | null> {
  const backend = resolveBackend();
  if (!backend) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INDEX_TIMEOUT_MS);
  try {
    return await fetch(`${backend.base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${backend.token}`,
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort by design: the upload has already been stored when this runs, and
// an index that is briefly behind is a missing row in one shelf, not a lost
// file. backfillUploadedReplayOwners re-derives anything missed from R2.
export async function recordUploadedReplayOwner(entry: {
  id: string;
  userId: number;
  username: string;
  originalFilename?: string | null;
  uploadedAt: string;
}): Promise<boolean> {
  try {
    const response = await callIndex("/api/uploaded-replays/record", {
      method: "POST",
      body: JSON.stringify(entry),
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

export async function fetchUploadedReplayIndexPage(options: {
  viewerUserId: number | null;
  asAdmin: boolean;
  allOwners: boolean;
  page: number;
  pageSize: number;
}): Promise<UploadedReplayIndexPage> {
  const empty: UploadedReplayIndexPage = {
    uploads: [],
    total: 0,
    page: options.page,
    pageSize: options.pageSize,
    hasMore: false,
  };
  const params = new URLSearchParams({
    page: String(options.page),
    pageSize: String(options.pageSize),
  });
  if (options.viewerUserId != null) params.set("viewerUserId", String(options.viewerUserId));
  if (options.asAdmin) params.set("asAdmin", "1");
  if (options.allOwners) params.set("all", "1");

  try {
    const response = await callIndex(`/api/uploaded-replays/list?${params.toString()}`);
    if (!response?.ok) return empty;
    return (await response.json()) as UploadedReplayIndexPage;
  } catch {
    return empty;
  }
}

export async function fetchUploadedReplayIndexRow(id: string): Promise<UploadedReplayIndexRow | null> {
  try {
    const response = await callIndex(`/api/uploaded-replays/get?id=${encodeURIComponent(id)}`);
    if (!response?.ok) return null;
    const body = (await response.json()) as { upload?: UploadedReplayIndexRow };
    return body.upload ?? null;
  } catch {
    return null;
  }
}

// Owner rows for a page of uploads at once (the gallery names the uploader on
// every card); ids the index never saw are simply absent from the map.
export async function fetchUploadedReplayIndexRows(ids: string[]): Promise<Map<string, UploadedReplayIndexRow>> {
  const rows = new Map<string, UploadedReplayIndexRow>();
  if (ids.length === 0) return rows;
  try {
    const response = await callIndex(`/api/uploaded-replays/rows?ids=${encodeURIComponent(ids.join(","))}`);
    if (!response?.ok) return rows;
    const body = (await response.json()) as { uploads?: UploadedReplayIndexRow[] };
    for (const row of body.uploads ?? []) rows.set(row.id, row);
    return rows;
  } catch {
    return rows;
  }
}

export type UploadedReplayIndexDeleteResult =
  | { ok: true; indexed: boolean }
  | { ok: false; error: "not_found" | "unavailable" };

// The authorization step of a delete: the backend checks the row's owner
// against the forwarded viewer id (an admin skips that check) and drops the
// row. The caller deletes the R2 objects afterwards.
export async function deleteUploadedReplayIndexRow(options: {
  id: string;
  userId: number | null;
  asAdmin: boolean;
}): Promise<UploadedReplayIndexDeleteResult> {
  try {
    const response = await callIndex("/api/uploaded-replays/delete", {
      method: "POST",
      body: JSON.stringify({ id: options.id, userId: options.userId, asAdmin: options.asAdmin }),
    });
    if (!response) return { ok: false, error: "unavailable" };
    if (response.status === 404) return { ok: false, error: "not_found" };
    if (!response.ok) return { ok: false, error: "unavailable" };
    const body = (await response.json()) as { ok?: boolean; indexed?: boolean };
    return body.ok ? { ok: true, indexed: body.indexed !== false } : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
