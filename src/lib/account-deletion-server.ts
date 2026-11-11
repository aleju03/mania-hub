import { createHash, timingSafeEqual } from "node:crypto";

import { bridgeAuthHeaders, liveBridgeToken } from "./live-backend-tokens";

/* The frontend's half of a "Delete everything" (backend features/self-deletion.ts):
   the worker's sweep calls this once the backend has deleted everything else,
   and the uploaded replays go here because their R2 objects and caches are
   this side's. Server-to-server only, behind the bridge token, and the backend
   is asked again before anything is deleted: a request naming an account its
   backend has not finished with (or one sent from a dev machine to the live
   site) deletes nothing. */

function bearerMatches(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hashed first so the comparison never leaks the length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return presented.length > 0 && timingSafeEqual(a, b);
}

async function backendPost(path: string, userId: number): Promise<Response | null> {
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return null;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: bridgeAuthHeaders(true),
    body: JSON.stringify({ userId }),
  }).catch(() => null);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function finishAccountDeletion(request: Request): Promise<Response> {
  const token = liveBridgeToken();
  if (!token || !bearerMatches(request, token)) return json(401, { error: "unauthorized" });
  const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
  const userId = Number(body?.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return json(400, { error: "invalid_user_id" });

  const due = await backendPost("/api/my-data/self-deletion/account-due", userId);
  const dueBody = (await due?.json().catch(() => null)) as { due?: unknown } | null;
  if (!due?.ok || dueBody?.due !== true) return json(409, { error: "not_due" });

  const { deleteOwnedUploads } = await import("./owner-takedown-server");
  const uploads = await deleteOwnedUploads(userId, { objectsFirst: true });
  if (uploads.failed > 0) return json(502, { error: "uploads_failed", ...uploads });

  const complete = await backendPost("/api/my-data/self-deletion/complete", userId);
  if (!complete?.ok) return json(502, { error: "complete_failed", status: complete?.status ?? null });
  return json(200, { ok: true, uploadsDeleted: uploads.deleted });
}
