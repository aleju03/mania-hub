import { beforeEach, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../src/http/context.js";
const { bridge, body, send, transfer, inbox, ack, search, accept, decline } = vi.hoisted(() => ({ bridge: vi.fn(), body: vi.fn(), send: vi.fn(), transfer: vi.fn(), inbox: vi.fn(), ack: vi.fn(), search: vi.fn(), accept: vi.fn(), decline: vi.fn() }));
vi.mock("../src/http/request.js", () => ({ isBridge: bridge, readBody: body }));
vi.mock("../src/http/respond.js", () => ({ sendJson: send, sendWritePressureShed: vi.fn() }));
vi.mock("../src/features/pack-gifts.js", () => ({ sendPackGift: transfer, listPackGiftInbox: inbox, acknowledgePackGifts: ack, searchGiftCollectors: search, acceptPackGift: accept, declinePackGift: decline }));
import { handlePackGiftRoutes } from "../src/http/routes/pack-gifts.js";
const ctx = { db: {} } as HttpContext;
const res = { setHeader: vi.fn() } as unknown as ServerResponse;
const url = new URL("http://localhost/api/pack-collection/101/gifts");
beforeEach(() => { vi.clearAllMocks(); bridge.mockReturnValue(false); inbox.mockResolvedValue({ gifts: [], total: 0 }); });
it("requires the bridge before reading gifts or accepting transfers", async () => {
  for (const method of ["GET", "POST"]) {
    await handlePackGiftRoutes({ method } as IncomingMessage, res, ctx, url);
  }
  expect(inbox).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled();
  expect(send.mock.calls.every(call => call[3] === 401)).toBe(true);
  expect(res.setHeader).toHaveBeenCalledWith("cache-control", "private, no-store");
});
it("takes the sender from the verified path, never a sender id in the body", async () => {
  bridge.mockReturnValue(true); body.mockResolvedValue(JSON.stringify({ action: "send", senderUserId: 999, recipientUserId: 102, cardKey: "77", requestId: "gift-request-00000001" })); transfer.mockResolvedValue({ ok: true });
  await handlePackGiftRoutes({ method: "POST" } as IncomingMessage, res, ctx, url);
  expect(transfer).toHaveBeenCalledWith(ctx.db, 101, { recipientUserId: 102, cardKey: "77", requestId: "gift-request-00000001", message: undefined });
});
it("answers offers as the bridge-supplied recipient and returns the inbox that answer left", async () => {
  bridge.mockReturnValue(true);
  accept.mockResolvedValue({ ok: true, giftId: 7, status: "accepted" });
  inbox.mockResolvedValue({ gifts: [], total: 0 });
  body.mockResolvedValue(JSON.stringify({ action: "accept", recipientUserId: 999, giftId: 7 }));
  await handlePackGiftRoutes({ method: "POST" } as IncomingMessage, res, ctx, url);
  expect(accept).toHaveBeenCalledWith(ctx.db, 101, 7);
  expect(send.mock.calls.at(-1)?.[4]).toEqual({ ok: true, giftId: 7, status: "accepted", gifts: [], total: 0 });
  body.mockResolvedValue(JSON.stringify({ action: "decline", giftId: 7 }));
  decline.mockResolvedValue({ ok: false, error: "gift_not_found" });
  await handlePackGiftRoutes({ method: "POST" } as IncomingMessage, res, ctx, url);
  expect(decline).toHaveBeenCalledWith(ctx.db, 101, 7);
  expect(send.mock.calls.at(-1)?.[3]).toBe(409);
});
it("reads and dismisses only the bridge-supplied recipient's inbox", async () => {
  bridge.mockReturnValue(true);
  await handlePackGiftRoutes({ method: "GET" } as IncomingMessage, res, ctx, new URL(`${url}?recipientUserId=999`));
  expect(inbox).toHaveBeenCalledWith(ctx.db, 101, null);
  body.mockResolvedValue(JSON.stringify({ action: "ack", recipientUserId: 999, ids: [1] }));
  await handlePackGiftRoutes({ method: "POST" } as IncomingMessage, res, ctx, url);
  expect(ack).toHaveBeenCalledWith(ctx.db, 101, [1]);
});

it("preserves the requested inbox page on reads and decisions", async () => {
  bridge.mockReturnValue(true);
  await handlePackGiftRoutes({ method: "GET" } as IncomingMessage, res, ctx, new URL(`${url}?page=2`));
  expect(inbox).toHaveBeenLastCalledWith(ctx.db, 101, "2");
  accept.mockResolvedValue({ ok: true, giftId: 7, status: "accepted" });
  body.mockResolvedValue(JSON.stringify({ action: "accept", giftId: 7, page: 2 }));
  await handlePackGiftRoutes({ method: "POST" } as IncomingMessage, res, ctx, url);
  expect(inbox).toHaveBeenLastCalledWith(ctx.db, 101, 2);
  body.mockResolvedValue(JSON.stringify({ action: "ack", ids: [7], page: 2 }));
  await handlePackGiftRoutes({ method: "POST" } as IncomingMessage, res, ctx, url);
  expect(inbox).toHaveBeenLastCalledWith(ctx.db, 101, 2);
});
