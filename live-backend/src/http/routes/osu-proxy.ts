import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import { getOsuJsonWithProxyCache, normalizeOsuProxyCacheHints } from "../../features/osu-proxy-cache.js";
import { getCachedBeatmapFile, normalizeBeatmapFileChecksum } from "../../osu/beatmap-file-cache.js";
import { OsuApiError } from "../../osu/client.js";
import type { HttpContext } from "../context.js";
import { isBridge, readBody } from "../request.js";
import { sendCors, sendJson } from "../respond.js";

export async function handleOsuProxyRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/osu/v2") {
    if (!isBridge(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const path = normalizeOsuApiPath(body.path, body.params);
    const caller = normalizeCaller(body.caller);
    try {
      if (body.kind === "binary") {
        const buffer = Buffer.from(await ctx.osu.getBinary(path, caller));
        sendCors(req, res, ctx);
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.end(buffer);
        return true;
      }
      if (body.body !== undefined) {
        sendJson(req, res, ctx, 200, await ctx.osu.postJson(path, normalizeOsuApiBody(body.body), caller));
      } else {
        const cacheHints = normalizeOsuProxyCacheHints(body);
        if (cacheHints) {
          const cached = await getOsuJsonWithProxyCache(ctx.db, ctx.serveWriteDb ?? ctx.db, ctx.osu, path, caller, cacheHints);
          res.setHeader("x-osu-proxy-cache", cached.cache);
          sendJson(req, res, ctx, 200, cached.payload);
        } else {
          sendJson(req, res, ctx, 200, await ctx.osu.getJson(path, caller));
        }
      }
    } catch (error) {
      sendOsuError(req, res, ctx, error);
    }
    return true;
  }
  if (url.pathname === "/api/osu/beatmap-file") {
    if (!isBridge(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const beatmapId = Number(url.searchParams.get("beatmapId"));
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap_id" });
      return true;
    }
    const rawChecksum = url.searchParams.get("checksum");
    const expectedChecksum = normalizeBeatmapFileChecksum(rawChecksum);
    if (rawChecksum && !expectedChecksum) {
      sendJson(req, res, ctx, 400, { error: "invalid_checksum" });
      return true;
    }
    try {
      // cachedOnly=1 serves from beatmap_osu_files / stored archives without ever
      // calling the osu! API; callers opt back into the network with a plain request.
      const cachedOnly = url.searchParams.get("cachedOnly") === "1";
      const content = await getCachedBeatmapFile(
        ctx.serveWriteDb ?? ctx.db,
        ctx.osu,
        Math.floor(beatmapId),
        normalizeCaller(url.searchParams.get("caller")),
        cachedOnly ? { allowArchive: true, allowDirect: false, expectedChecksum } : { expectedChecksum },
      );
      sendCors(req, res, ctx);
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(content);
    } catch (error) {
      if (url.searchParams.get("cachedOnly") === "1") {
        sendJson(req, res, ctx, 404, { error: "not_cached" });
        return true;
      }
      sendOsuError(req, res, ctx, error);
    }
    return true;
  }
  return false;
}

function normalizeOsuApiPath(rawPath: unknown, rawParams: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length > 500 || !rawPath.startsWith("/")) {
    throw new Error("Invalid osu! API path.");
  }
  const url = new URL(rawPath, "https://osu.ppy.sh");
  if (url.origin !== "https://osu.ppy.sh" || url.pathname.startsWith("/oauth/")) {
    throw new Error("Invalid osu! API path.");
  }
  if (rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)) {
    for (const [key, value] of Object.entries(rawParams)) {
      if (value === undefined || value === null) continue;
      if (!/^[A-Za-z0-9_[\]-]+$/.test(key)) throw new Error("Invalid osu! API param.");
      if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("Invalid osu! API param.");
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

// Forwarded verbatim as the JSON body of a POST-only osu! v2 read (e.g.
// /beatmaps/{id}/attributes); size-capped so the proxy can't relay junk.
function normalizeOsuApiBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid osu! API body.");
  }
  if (JSON.stringify(raw).length > 2000) throw new Error("Invalid osu! API body.");
  return raw as Record<string, unknown>;
}

function normalizeCaller(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "frontend";
  return raw.trim().replace(/[^\w:.-]/g, "_").slice(0, 120);
}

function sendOsuError(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, error: unknown): void {
  if (error instanceof OsuApiError) {
    sendJson(req, res, ctx, error.status, {
      error: "osu_api_error",
      status: error.status,
      path: error.path,
      retryAfterMs: error.retryAfterMs,
    });
    return;
  }
  sendJson(req, res, ctx, 502, { error: error instanceof Error ? error.message : String(error) });
}
