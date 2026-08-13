import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  deleteUploadedReplayRow,
  getUploadedReplayRow,
  listUploadedReplays,
  recordUploadedReplay,
} from "../../features/uploaded-replays.js";
import { logInfo } from "../../logger.js";
import type { HttpContext } from "../context.js";
import { isAdmin, readBody } from "../request.js";
import { sendJson } from "../respond.js";

// The owner index behind "your uploads" on /replay's Upload tab. Every route
// here takes the admin-token bridge (the goals/skins pattern): the frontend
// server layer is the only caller, and it forwards the osu!-verified viewer id
// it read from the signed cookie. The backend cannot verify a user by itself,
// so the token is what vouches for the id in the body.
//
// The .osr bytes are not here at all - the frontend owns that bucket - so a
// delete against this table removes the row only, and the caller is the one
// that deletes the objects.

const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function readId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return UPLOAD_ID_PATTERN.test(id) ? id : null;
}

export async function handleUploadedReplayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/uploaded-replays/")) return false;
  if (!isAdmin(req, ctx)) {
    sendJson(req, res, ctx, 401, { error: "unauthorized" });
    return true;
  }

  if (url.pathname === "/api/uploaded-replays/list") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    // One person's own uploads, or - for a request that asserted true admin -
    // every uploader's. Never a shared cache either way.
    res.setHeader("cache-control", "private, no-store");
    const asAdmin = url.searchParams.get("asAdmin") === "1";
    const allOwners = asAdmin && url.searchParams.get("all") === "1";
    const viewerUserId = Number(url.searchParams.get("viewerUserId"));
    const page = Number(url.searchParams.get("page") ?? 0);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 12);
    const list = await listUploadedReplays(ctx.db, {
      ownerUserId: Number.isInteger(viewerUserId) && viewerUserId > 0 ? viewerUserId : null,
      allOwners,
      page: Number.isFinite(page) ? page : 0,
      pageSize: Number.isFinite(pageSize) ? pageSize : 12,
    });
    sendJson(req, res, ctx, 200, list);
    return true;
  }

  if (url.pathname === "/api/uploaded-replays/get") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    res.setHeader("cache-control", "private, no-store");
    const id = readId(url.searchParams.get("id"));
    const row = id ? await getUploadedReplayRow(ctx.db, id) : null;
    sendJson(req, res, ctx, row ? 200 : 404, row ? { upload: row } : { error: "not_found" });
    return true;
  }

  if (url.pathname === "/api/uploaded-replays/record") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{
      id?: unknown;
      userId?: unknown;
      username?: unknown;
      originalFilename?: unknown;
      uploadedAt?: unknown;
    }>((await readBody(req)) || "{}", {});
    const id = readId(body.id);
    const userId = Number(body.userId);
    if (!id || !Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const uploadedAt = typeof body.uploadedAt === "string" && body.uploadedAt
      ? body.uploadedAt
      : new Date().toISOString();
    await recordUploadedReplay(ctx.serveWriteDb ?? ctx.db, {
      id,
      ownerUserId: userId,
      ownerUsername: typeof body.username === "string" ? body.username.slice(0, 60) : "",
      originalFilename: typeof body.originalFilename === "string" && body.originalFilename
        ? body.originalFilename.slice(0, 180)
        : null,
      uploadedAt,
    });
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/uploaded-replays/delete") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ id?: unknown; userId?: unknown; asAdmin?: unknown }>((await readBody(req)) || "{}", {});
    const id = readId(body.id);
    const userId = Number(body.userId);
    const asAdmin = body.asAdmin === true;
    if (!id || (!asAdmin && (!Number.isInteger(userId) || userId <= 0))) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const row = await getUploadedReplayRow(ctx.db, id);
    // A row nobody indexed is still a real file an admin may need to take down,
    // so admins get an ok to go delete the objects. For its uploader the row is
    // the only proof of ownership there is, so a miss reads as not found.
    if (!row) {
      if (!asAdmin) {
        sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
        return true;
      }
      sendJson(req, res, ctx, 200, { ok: true, indexed: false });
      return true;
    }
    if (!asAdmin && row.ownerUserId !== userId) {
      // Same answer a missing upload gives: nothing here confirms whose it is.
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }
    await deleteUploadedReplayRow(ctx.serveWriteDb ?? ctx.db, id);
    logInfo("uploaded_replay_deleted", {
      id,
      ownerUserId: row.ownerUserId,
      by: asAdmin && row.ownerUserId !== userId ? "admin" : "owner",
    });
    sendJson(req, res, ctx, 200, { ok: true, indexed: true });
    return true;
  }

  sendJson(req, res, ctx, 404, { error: "not_found" });
  return true;
}
