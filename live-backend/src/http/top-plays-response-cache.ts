import type { IncomingMessage, ServerResponse } from "node:http";
import { exec, type Db } from "../db.js";
import { enrichPayloadAvatarAccents } from "../features/avatar-accents.js";
import { getTopPlaysSnapshot, type TopPlaysSnapshotOptions } from "../features/top-plays.js";
import type { HttpContext } from "./context.js";
import { createMapsResponseCache, pruneMapsResponseCache, serveMapsResponseCached } from "./maps-response-cache.js";
import { prepareJsonResponse, type PreparedJsonResponse } from "./prepared-json.js";
import { negotiateEncoding } from "./respond.js";

const responseStates = new WeakMap<Db, {
  responses: ReturnType<typeof createMapsResponseCache>;
  inflight: Map<string, Promise<PreparedJsonResponse>>;
}>();

/** Share a brief, prepared snapshot across visitors and reconnects. */
export async function sendTopPlaysSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  country: string,
  requestedWindow: string,
  options: TopPlaysSnapshotOptions,
): Promise<void> {
  let state = responseStates.get(ctx.db);
  if (!state) {
    state = { responses: createMapsResponseCache(64, 8 * 1024 * 1024, 2 * 1024 * 1024), inflight: new Map() };
    responseStates.set(ctx.db, state);
  }
  pruneMapsResponseCache(state.responses, Date.now());
  const window = ["24h", "3d", "30d"].includes(requestedWindow) ? requestedWindow : "7d";
  const query = {
    ...options,
    sort: options.sort ?? "pp",
    userIds: [...new Set(options.userIds ?? [])].sort((a, b) => a - b),
  };
  const encoding = negotiateEncoding(req);
  // One PK lookup invalidates cached pages as soon as an event lands, including
  // writes from another process. The five-second TTL also bounds moving-window
  // cutoffs and edits/deletions that do not change the newest event ID.
  const newest = (await exec(ctx.db, "select max(rowid) as id from top_play_events")).rows[0]?.id ?? 0;
  await serveMapsResponseCached(req, res, ctx, {
    cache: state.responses,
    inflight: state.inflight,
    key: JSON.stringify([country, window, query, encoding, String(newest)]),
    freshnessKey: "",
    staleServeMs: 0,
    build: async () => {
      const body = await getTopPlaysSnapshot(ctx.db, country, window, query);
      await enrichPayloadAvatarAccents(ctx.db, ctx.serveWriteQueue ?? ctx.queue, body);
      return { prepared: await prepareJsonResponse(200, body, encoding), cacheTtlMs: 5_000 };
    },
  });
}
