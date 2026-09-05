import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  createPackBinder,
  deletePackBinder,
  listPackBinders,
  listShowcasedPackBinders,
  PackBinderError,
  renamePackBinder,
  reorderPackBinders,
  setPackBinderCards,
  addPackBinderCard,
  addPackBinderCards,
  setPackBinderShowcased,
} from "../../features/pack-binders.js";
import { logWarn } from "../../logger.js";
import type { HttpContext } from "../context.js";
import { DEFAULT_BODY_LIMIT_BYTES, isBridge, readBodyBuffer } from "../request.js";
import { checkRate, sendAccentEnrichedJson, sendJson } from "../respond.js";

/* Routes for the binders feature of the 1M celebration update (docs/packs.md).
   Owner reads and writes are bridge-gated with the collector's id in the path,
   like the showcase write beside them. This module's public read serves enabled
   sets on an individual shelf; the shared showcase feed lives in packs.ts. */
export async function handlePackBindersRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/api/packs/community/binders") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const ownerUserId = Math.floor(Number(url.searchParams.get("userId")) || 0);
    if (ownerUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=60");
    await sendAccentEnrichedJson(req, res, ctx, 200, {
      binders: await listShowcasedPackBinders(ctx.db, ownerUserId),
    });
    return true;
  }

  const ownerMatch = url.pathname.match(/^\/api\/pack-collection\/(\d+)\/binders$/);
  if (!ownerMatch) return false;
  if (!isBridge(req, ctx)) {
    sendJson(req, res, ctx, 401, { error: "unauthorized" });
    return true;
  }
  const ownerUserId = Number(ownerMatch[1]);
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
    sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
    return true;
  }
  if (req.method === "GET") {
    await sendAccentEnrichedJson(req, res, ctx, 200, { binders: await listPackBinders(ctx.db, ownerUserId) });
    return true;
  }
  if (req.method !== "POST") {
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = parseJson<Record<string, unknown>>(
    (await readBodyBuffer(req, DEFAULT_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
    {},
  );
  const writeDb = ctx.serveWriteDb ?? ctx.db;
  const binderId = Math.floor(Number(body.binderId) || 0);
  try {
    switch (String(body.action ?? "")) {
      case "create":
        await createPackBinder(writeDb, ownerUserId, body.name);
        break;
      case "rename":
        await renamePackBinder(writeDb, ownerUserId, binderId, body.name);
        break;
      case "delete":
        await deletePackBinder(writeDb, ownerUserId, binderId);
        break;
      case "set_cards":
        await setPackBinderCards(writeDb, ownerUserId, binderId, body.cardKeys);
        break;
      case "add_cards":
        await addPackBinderCards(writeDb, ownerUserId, binderId, body.cardKeys);
        break;
      case "add_card":
        await addPackBinderCard(writeDb, ownerUserId, binderId, body.cardKey);
        break;
      case "showcase":
        await setPackBinderShowcased(writeDb, ownerUserId, binderId, body.showcased === true);
        break;
      case "reorder":
        await reorderPackBinders(writeDb, ownerUserId, body.binderIds);
        break;
      default:
        sendJson(req, res, ctx, 400, { error: "invalid_action" });
        return true;
    }
  } catch (error) {
    if (error instanceof PackBinderError) {
      sendJson(req, res, ctx, 400, { error: error.code });
      return true;
    }
    logWarn("pack_binders_write_failed", { ownerUserId, action: String(body.action ?? ""), error: String(error) });
    sendJson(req, res, ctx, 500, { error: "write_failed" });
    return true;
  }
  await sendAccentEnrichedJson(req, res, ctx, 200, { binders: await listPackBinders(writeDb, ownerUserId) });
  return true;
}
