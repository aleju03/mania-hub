import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  addPackWishlistPlayer,
  listPackWishlist,
  PackWishlistError,
  removePackWishlistPlayer,
} from "../../features/pack-wishlist.js";
import type { HttpContext } from "../context.js";
import { isBridge, readBody } from "../request.js";
import { sendJson } from "../respond.js";

/* The wishlist of the 1M celebration update (docs/packs.md): the players a
   collector is still missing and wants the pity roll to reach for.

   Owner-scoped through the bridge like the wallet and the showcase, with the
   collector's id in the path: the frontend authenticates the osu! login
   cookie and forwards the verified viewer, so nobody edits somebody else's
   list. Both verbs answer with the whole list, since every refusal and every
   accepted write changes what the line on /packs should say. */
export async function handlePackWishlistRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/pack-collection\/(\d+)\/wishlist$/);
  if (!match) return false;
  if (!isBridge(req, ctx)) {
    sendJson(req, res, ctx, 401, { error: "unauthorized" });
    return true;
  }
  const ownerUserId = Number(match[1]);
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
    sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
    return true;
  }
  if (req.method === "GET") {
    sendJson(req, res, ctx, 200, await listPackWishlist(ctx.db, ownerUserId));
    return true;
  }
  if (req.method === "POST") {
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const cardUserId = Math.floor(Number(body.userId) || 0);
    if (cardUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const writeDb = ctx.serveWriteDb ?? ctx.db;
    if (body.action === "remove") {
      sendJson(req, res, ctx, 200, await removePackWishlistPlayer(writeDb, ownerUserId, cardUserId));
      return true;
    }
    if (body.action !== "add") {
      sendJson(req, res, ctx, 400, { error: "invalid_action" });
      return true;
    }
    try {
      sendJson(req, res, ctx, 200, await addPackWishlistPlayer(writeDb, ownerUserId, cardUserId));
    } catch (error) {
      if (error instanceof PackWishlistError) {
        sendJson(req, res, ctx, 409, { error: error.code });
        return true;
      }
      throw error;
    }
    return true;
  }
  sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
  return true;
}
