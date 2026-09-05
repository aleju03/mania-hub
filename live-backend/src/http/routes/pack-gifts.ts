import type { IncomingMessage, ServerResponse } from "node:http";
import { checkWriteGateOverloaded, parseJson } from "../../db.js";
import { acceptPackGift, acknowledgePackGifts, declinePackGift, listPackGiftInbox, searchGiftCollectors, sendPackGift } from "../../features/pack-gifts.js";
import type { HttpContext } from "../context.js";
import { isBridge, readBody } from "../request.js";
import { sendJson, sendWritePressureShed } from "../respond.js";

export async function handlePackGiftRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/pack-collection\/(\d+)\/gifts$/);
  if (!match) return false;
  res.setHeader("cache-control", "private, no-store");
  if (!isBridge(req, ctx)) { sendJson(req, res, ctx, 401, { error: "unauthorized" }); return true; }
  const owner = Number(match[1]);
  if (!Number.isSafeInteger(owner) || owner <= 0) { sendJson(req, res, ctx, 400, { error: "invalid_user_id" }); return true; }
  if (req.method === "GET") {
    const result = url.searchParams.has("q")
      ? { collectors: await searchGiftCollectors(ctx.db, owner, url.searchParams.get("q") ?? "") }
      : await listPackGiftInbox(ctx.db, owner, url.searchParams.get("page"));
    sendJson(req, res, ctx, 200, result);
    return true;
  }
  if (req.method !== "POST") { sendJson(req, res, ctx, 405, { error: "method_not_allowed" }); return true; }
  const shed = checkWriteGateOverloaded(ctx.serveWriteDb);
  if (shed) { sendWritePressureShed(req, res, ctx, "pack-gift", shed.retryAfterMs); return true; }
  const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
  const db = ctx.serveWriteDb ?? ctx.db;
  if (body.action === "ack") {
    await acknowledgePackGifts(db, owner, body.ids);
    sendJson(req, res, ctx, 200, await listPackGiftInbox(db, owner, body.page));
  } else if (body.action === "accept" || body.action === "decline") {
    const decision = body.action === "accept" ? await acceptPackGift(db, owner, body.giftId) : await declinePackGift(db, owner, body.giftId);
    // The answer and the inbox that answer produced travel together: the page
    // has one list on screen and no second read to make.
    sendJson(req, res, ctx, decision.ok ? 200 : 409, { ...decision, ...(await listPackGiftInbox(db, owner, body.page)) });
  } else if (body.action === "send") {
    const result = await sendPackGift(db, owner, {
      recipientUserId: Number(body.recipientUserId), cardKey: typeof body.cardKey === "string" ? body.cardKey : "",
      requestId: typeof body.requestId === "string" ? body.requestId : "",
      message: body.message,
    });
    sendJson(req, res, ctx, result.ok ? 200 : 409, result);
  } else sendJson(req, res, ctx, 400, { error: "invalid_action" });
  return true;
}
