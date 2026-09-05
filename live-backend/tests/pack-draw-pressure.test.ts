import { expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../src/http/context.js";

const { pressure, send, shed, draw, spend } = vi.hoisted(() => ({
  pressure: vi.fn(), send: vi.fn(), shed: vi.fn(), draw: vi.fn(), spend: vi.fn(),
}));
vi.mock("../src/db.js", async (original) => ({
  ...await original<typeof import("../src/db.js")>(),
  checkWriteGateOverloaded: pressure,
  getWriteGateStats: () => ({ depth: 20, ewmaWaitMs: 1800 }),
}));
vi.mock("../src/http/request.js", async (original) => ({
  ...await original<typeof import("../src/http/request.js")>(),
  isBridge: () => true,
  readBody: async () => JSON.stringify({ userId: 7095193, packType: "legend" }),
}));
vi.mock("../src/http/respond.js", async (original) => ({
  ...await original<typeof import("../src/http/respond.js")>(),
  checkRate: () => true, sendJson: send, sendWritePressureShed: shed,
}));
vi.mock("../src/features/pack-draw.js", async (original) => ({
  ...await original<typeof import("../src/features/pack-draw.js")>(),
  drawPackHand: draw,
  shouldDealEternalSelfCard: async () => false,
}));
vi.mock("../src/features/pack-wallets.js", async (original) => ({
  ...await original<typeof import("../src/features/pack-wallets.js")>(),
  spendPackOpen: spend,
}));
import { handlePacksRoutes } from "../src/http/routes/packs.js";

it("pressure rejections identify the account and pack without spending or using its draw allowance", async () => {
  const req = { method: "POST" } as IncomingMessage;
  const res = { setHeader: vi.fn() } as unknown as ServerResponse;
  const ctx = { db: {}, serveWriteDb: {} } as HttpContext;
  const url = new URL("http://localhost/api/packs/draw");
  pressure.mockReturnValue({ retryAfterMs: 1500 });
  for (let index = 0; index < 35; index += 1) await handlePacksRoutes(req, res, ctx, url);
  expect(shed).toHaveBeenCalledTimes(35);
  expect(shed).toHaveBeenLastCalledWith(req, res, ctx, "packs-draw", 1500, {
    user_id: 7095193, pack_type: "legend", write_gate: { depth: 20, ewmaWaitMs: 1800 },
  });
  expect(draw).not.toHaveBeenCalled();
  expect(spend).not.toHaveBeenCalled();

  pressure.mockReturnValue(null);
  // Stop at the hand builder: exercise admission without minting a pack.
  draw.mockResolvedValue(null);
  for (let index = 0; index < 30; index += 1) await handlePacksRoutes(req, res, ctx, url);
  expect(draw).toHaveBeenCalledTimes(30);
  await handlePacksRoutes(req, res, ctx, url);
  expect(draw).toHaveBeenCalledTimes(30);
  expect(send).toHaveBeenLastCalledWith(req, res, ctx, 429, { error: "rate_limited" });
  expect(spend).not.toHaveBeenCalled();
});
