import type { IncomingMessage, ServerResponse } from "node:http";
import { activateCountry } from "../countries.js";
import type { HttpContext } from "../http/snapshots.js";
import type { LiveEvent } from "../shared/types.js";

export async function handleSse(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/api/live") return false;
  const origin = req.headers.origin;
  if (origin && !ctx.config.allowedOrigins.includes(origin)) {
    res.statusCode = 403;
    res.end("forbidden");
    return true;
  }
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const country = (url.searchParams.get("country") ?? ctx.config.trackedCountries[0] ?? "CR").toUpperCase();
  await activateCountry(ctx.db, ctx.queue, ctx.config, country);
  const cursor = req.headers["last-event-id"] ?? url.searchParams.get("lastEventId");
  const lastEventId = Number(cursor ?? 0);
  writeEvent(res, { type: "hello", sequence: Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : await ctx.events.latestSequence(), payload: { country, status: "connected" } });
  if (cursor != null && Number.isFinite(lastEventId)) {
    const replay = await ctx.events.replay(country, lastEventId, 100);
    for (const event of replay) writeEvent(res, event);
  }
  const unsubscribe = ctx.events.subscribe((event) => {
    if (event.country != null && event.country !== country) return;
    writeEvent(res, event);
  });
  const heartbeat = setInterval(() => {
    writeEvent(res, { type: "heartbeat", sequence: Date.now(), payload: { t: Date.now() } });
  }, 15_000);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return true;
}

function writeEvent(res: ServerResponse, event: Pick<LiveEvent, "type" | "sequence" | "payload">): void {
  res.write(`id: ${event.sequence}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}
