import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import { cancelReplayVideoExport, createReplayVideoExport, createServerReplayVideoExport, getRecentReplayVideoExport, getReplayVideoExport, markReplayVideoQueued, replayVideoExportResponse, writeReplayVideoUpload } from "../../replay-video/exports.js";
import { isReplayVideoStorageConfigured } from "../../replay-video/r2.js";
import type { HttpContext } from "../context.js";
import { isAdmin, readBody, readBodyBuffer } from "../request.js";
import { checkRate, sendJson } from "../respond.js";

export async function handleReplayVideoRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/replay-video-job") {
    if (!ctx.config.enableReplayVideo) {
      // The whole feature is off (production default): behave as if the
      // endpoint were never registered, before auth or rate accounting.
      sendJson(req, res, ctx, 404, { error: "replay_video_disabled" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!ctx.config.replayVideoPublicEnabled && !isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (!isAdmin(req, ctx) && !checkRate(req, res, ctx, "replayVideo")) return true;
    if (!isAdmin(req, ctx) && !checkRate(req, res, ctx, "publicCostly")) return true;
    if (!isReplayVideoStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "R2 is not configured for replay video uploads." });
      return true;
    }
    const action = url.searchParams.get("action");
    if (action === "start") {
      const job = await createReplayVideoExport(ctx.serveWriteDb ?? ctx.db, ctx.config, parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {}));
      sendJson(req, res, ctx, 200, { id: job.id });
      return true;
    }
    if (action === "server-render") {
      const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
      const job = await createServerReplayVideoExport(ctx.serveWriteDb ?? ctx.db, ctx.config, body);
      await ctx.queue.enqueue("replay_video_server_render", `replay-video-server:${job.id}`, { id: job.id, request: body }, { priority: 85 });
      sendJson(req, res, ctx, 202, replayVideoExportResponse(job));
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    if (action === "status") {
      const job = await getReplayVideoExport(ctx.db, id);
      sendJson(req, res, ctx, job ? 200 : 404, job ? replayVideoExportResponse(job) : { error: "Unknown replay video job." });
      return true;
    }
    if (action === "recent") {
      const scoreId = Number(url.searchParams.get("scoreId"));
      if (!Number.isFinite(scoreId) || scoreId <= 0) {
        sendJson(req, res, ctx, 400, { error: "Invalid scoreId." });
        return true;
      }
      const job = await getRecentReplayVideoExport(ctx.db, Math.floor(scoreId));
      sendJson(req, res, ctx, 200, job ? replayVideoExportResponse(job) : { url: null });
      return true;
    }
    if (action === "upload-video") {
      const buffer = await readBodyBuffer(req, ctx.config.replayVideoUploadMaxBytes);
      const job = await writeReplayVideoUpload(ctx.serveWriteDb ?? ctx.db, ctx.config, id, buffer);
      sendJson(req, res, ctx, 200, replayVideoExportResponse(job));
      return true;
    }
    if (action === "finish") {
      const job = await markReplayVideoQueued(ctx.serveWriteDb ?? ctx.db, id);
      await ctx.queue.enqueue("replay_video_export", `replay-video:${id}`, { id }, { priority: 80 });
      sendJson(req, res, ctx, 202, replayVideoExportResponse(job));
      return true;
    }
    if (action === "cancel") {
      await cancelReplayVideoExport(ctx.serveWriteDb ?? ctx.db, ctx.config, id);
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    sendJson(req, res, ctx, 400, { error: "Unknown replay video job action." });
    return true;
  }
  return false;
}
