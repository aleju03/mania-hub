import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import { getPackGameAllowance, getStreakPlayerMetrics, grantPackGameShards, STREAK_METRICS_MAX_IDS, streakShardReward } from "../../features/pack-games.js";
import { getPackCardCollectors, getPackCardStats, getPackPulledStats, getSharedPackCard, listPackPullsByIds, listRecentPackPulls, PACK_PULL_MAX_CARDS_PER_EVENT, recordPackPullEvents } from "../../features/pack-pulls.js";
import { cashOutStreakRun, getStreakBoard, guessStreakRound, normalizeStreakGuess, normalizeStreakPool, normalizeStreakRunId, startStreakRun } from "../../features/pack-streak.js";
import { applyPackCollectionCardMint, countMissingGoatCards, getPackCollectionPoolProgress, getPackShowcase, getPackWallet, listPackCollectionCards, listPackCollectionMissingPlayers, listPackCollectionOwnedCardKeys, normalizePackCardKey, PACK_COLLECTION_MAX_PAGE_SIZE, recyclePackCollectionCards, savePackWallet, setPackShowcase } from "../../features/pack-wallets.js";
import { getPackPoolMembership, getPackPoolRoster } from "../../features/global-rankings.js";
import { getCachedPackCardSnapshots, PACK_CARD_SNAPSHOT_MAX_IDS, selectReadyPackCardUserIds, warmProfileSnapshots } from "../../features/player-profiles.js";
import type { HttpContext } from "../context.js";
import { DEFAULT_BODY_LIMIT_BYTES, isAdmin, readBody, readBodyBuffer } from "../request.js";
import { checkRate, sendAccentEnrichedJson, sendJson } from "../respond.js";

// A wallet holding the full ~6k tracked-player pool serializes to ~1.5MB,
// so pack wallet pushes get more headroom than the default body limit.
const PACK_WALLET_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const PACK_WALLET_PAYLOAD_MAX_CHARS = 3_500_000;

export async function handlePacksRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/packs/warm") {
    // Pack deals send the drawn user ids here so cold players' profile
    // snapshots start fetching before their card is ever flipped. Responds
    // immediately; the osu! API work runs in the background.
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const userIds = [...new Set(
      (Array.isArray(body.userIds) ? body.userIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    )].slice(0, 10);
    if (userIds.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    sendJson(req, res, ctx, 202, await warmProfileSnapshots(ctx.serveWriteDb ?? ctx.db, ctx.osu, userIds));
    return true;
  }
  if (url.pathname === "/api/packs/cards") {
    // One hand of cards in one read. The per-player alternative is ten
    // concurrent cached-snapshot?view=card requests, which on a single-writer
    // SQLite process is ten interleaved reads that share no beatmap work and
    // spend ten trips through the rate limiter (see getCachedPackCardSnapshots).
    // Its own bucket rather than the shared costly one: a hand covers up to ten
    // players, and when pack bursts and ordinary browsing drew on the same
    // budget, a few Wild packs in a row left the rest of the site 429ing for the
    // remainder of the minute. No honest client opens 30 packs a minute either
    // way, and the blanket publicApi bucket still applies on top.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "packCards")) return true;
    const userIds = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((raw) => Math.floor(Number(raw) || 0))
      .filter((id) => id > 0)
      .slice(0, PACK_CARD_SNAPSHOT_MAX_IDS);
    if (userIds.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=15");
    // Uncached players are simply absent; the client's cold path mints them.
    await sendAccentEnrichedJson(req, res, ctx, 200, { cards: await getCachedPackCardSnapshots(ctx.db, userIds) });
    return true;
  }
  if (url.pathname === "/api/packs/cards/ready") {
    // The draw's "who can I deal?" check. Deliberately not /api/packs/cards:
    // that builds whole cards, and at 245 packs a minute (2026-08-05's peak)
    // paying 17-50ms of synchronous SQLite per draw to answer a yes/no is real
    // event-loop time on the serving process.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "packCards")) return true;
    const userIds = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((raw) => Math.floor(Number(raw) || 0))
      .filter((id) => id > 0)
      .slice(0, PACK_CARD_SNAPSHOT_MAX_IDS);
    if (userIds.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=15");
    sendJson(req, res, ctx, 200, { ready: await selectReadyPackCardUserIds(ctx.db, userIds) });
    return true;
  }
  if (url.pathname === "/api/packs/pulls") {
    // Server-to-server only, like the wallet sync: the frontend's server
    // function authenticates the osu! login cookie and forwards the verified
    // viewer identity, so an event can only ever be logged as yourself.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const ownerUserId = Math.floor(Number(body.userId) || 0);
    const ownerUsername = typeof body.username === "string" ? body.username : "";
    if (ownerUserId <= 0 || !ownerUsername) {
      sendJson(req, res, ctx, 400, { error: "invalid_pull_owner" });
      return true;
    }
    const pullResult = await recordPackPullEvents(ctx.serveWriteDb ?? ctx.db, ownerUserId, ownerUsername, body.packType, body.cards);
    // Fan the new pulls out on the live stream: a null country reaches every
    // /api/live client, which is what makes the packs rail tick in real time
    // instead of on its next poll. Same feed-entry shape as recent-pulls, so
    // the client treats both sources identically. Best-effort: the pull log
    // is already durable, and a failed publish only costs immediacy (the
    // rail's poll backstop still picks the pull up).
    if (pullResult.eventIds.length > 0) {
      try {
        for (const entry of await listPackPullsByIds(ctx.db, pullResult.eventIds)) {
          await ctx.events.append("pack_pull", null, entry, `pack_pull:${entry.id}`, ctx.serveWriteDb);
        }
      } catch {
        // Covered by the poll backstop.
      }
    }
    sendJson(req, res, ctx, 202, { recorded: pullResult.recorded, mints: pullResult.mints });
    return true;
  }
  if (url.pathname === "/api/packs/card-stats") {
    // Community ownership counts for a hand of revealed cards. Public and
    // cheap (one grouped indexed count over pack_collection_cards).
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((raw) => Math.floor(Number(raw) || 0))
      .filter((id) => id > 0)
      .slice(0, PACK_PULL_MAX_CARDS_PER_EVENT);
    if (ids.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    sendJson(req, res, ctx, 200, { cards: await getPackCardStats(ctx.db, ids) });
    return true;
  }
  if (url.pathname === "/api/packs/streak-metrics") {
    // The streak game's question numbers for one page of the pool. Public
    // data (it all shows on osu! profiles), read entirely from local
    // projections: no osu! call, no job, and slow-moving enough that the
    // browser is told to keep a page of it for an hour on top of the
    // feature's own in-memory cache.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((raw) => Math.floor(Number(raw) || 0))
      .filter((id) => id > 0)
      .slice(0, STREAK_METRICS_MAX_IDS);
    if (ids.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=3600");
    sendJson(req, res, ctx, 200, { players: await getStreakPlayerMetrics(ctx.db, ids) });
    return true;
  }
  const packPulledStatsMatch = url.pathname.match(/^\/api\/packs\/pulled-stats\/(\d+)$/);
  if (packPulledStatsMatch) {
    // How the community holds one player's card ("your card got pulled").
    // Public aggregate counts, nothing per-viewer in the response.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const cardUserId = Number(packPulledStatsMatch[1]);
    if (!Number.isInteger(cardUserId) || cardUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getPackPulledStats(ctx.db, cardUserId));
    return true;
  }
  const packPulledByMatch = url.pathname.match(/^\/api\/packs\/pulled-by\/(\d+)$/);
  if (packPulledByMatch) {
    // Who holds one player's card, by name. Server-to-server only, like the
    // wallet sync: the frontend's server function resolves the id from the
    // osu! login cookie, so you can only ever list the collectors of your own
    // card. The public endpoint next to it stays a count.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const cardUserId = Number(packPulledByMatch[1]);
    if (!Number.isInteger(cardUserId) || cardUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, await getPackCardCollectors(ctx.db, cardUserId));
    return true;
  }
  const packPulledCardMatch = url.pathname.match(/^\/api\/packs\/pulled-card\/(\d+)\/(\d+)$/);
  if (packPulledCardMatch) {
    // One owned card as a shareable artifact: backs the /pull/{owner}/{card}
    // permalink page and its OG image. Public; reads the durable collection
    // row so the link outlives pull-event retention.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const shared = await getSharedPackCard(ctx.db, Number(packPulledCardMatch[1]), Number(packPulledCardMatch[2]));
    if (!shared) {
      sendJson(req, res, ctx, 404, { error: "pulled_card_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, shared);
    return true;
  }
  const packShowcaseMatch = url.pathname.match(/^\/api\/packs\/showcase\/(\d+)$/);
  if (packShowcaseMatch) {
    // A collector's pinned shelf. Meant to be public (it exists to be seen),
    // but admin-gated while the showcase design is still being judged: the
    // frontend only renders the shelf for admins, and this keeps the shelves
    // of everyone else unreadable in the meantime.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    sendJson(req, res, ctx, 200, { cards: await getPackShowcase(ctx.db, Number(packShowcaseMatch[1])) });
    return true;
  }
  if (url.pathname === "/api/packs/recent-pulls") {
    // The public pull feed: notable-only by default (high mints and
    // first-ever pulls); ?all=1 includes every pull for the live ticker.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const limit = Number(url.searchParams.get("limit")) || 20;
    const notableOnly = url.searchParams.get("all") !== "1";
    sendJson(req, res, ctx, 200, { pulls: await listRecentPackPulls(ctx.db, limit, notableOnly) });
    return true;
  }
  if (url.pathname === "/api/packs/games/streak/board") {
    // The blitz board. Public, like every other leaderboard on the site: it
    // is a list of usernames and the streak they reached. `me` is whose rank
    // to resolve when they did not make the top ten.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const viewerId = Math.floor(Number(url.searchParams.get("me")) || 0);
    const board = await getStreakBoard(
      ctx.db,
      normalizeStreakPool(url.searchParams.get("pool")),
      viewerId > 0 ? viewerId : null,
    );
    res.setHeader("cache-control", "no-store");
    sendJson(req, res, ctx, 200, board);
    return true;
  }
  const streakRunMatch = url.pathname.match(/^\/api\/packs\/games\/streak\/(start|guess|cashout)$/);
  if (streakRunMatch) {
    /* Blitz runs. Server-to-server like the rest of the arcade: the
       frontend's server function authenticates the osu! cookie and forwards
       the verified viewer, so a run can only ever be played as yourself.
       Unlike the casual claim next to it, nothing here takes the client's word
       for what happened - the pair, the question, the answer and the clock all
       live in the run row. */
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const userId = Math.floor(Number(body.userId) || 0);
    if (userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_game_player" });
      return true;
    }
    const writeDb = ctx.serveWriteDb ?? ctx.db;
    if (streakRunMatch[1] === "start") {
      const run = await startStreakRun(writeDb, {
        userId,
        username: String(body.username ?? ""),
        pool: normalizeStreakPool(body.pool),
      });
      if (!run) {
        sendJson(req, res, ctx, 503, { error: "streak_pool_unavailable" });
        return true;
      }
      sendJson(req, res, ctx, 200, run);
      return true;
    }
    const runId = normalizeStreakRunId(body.runId);
    if (!runId) {
      sendJson(req, res, ctx, 400, { error: "invalid_run" });
      return true;
    }
    if (streakRunMatch[1] === "cashout") {
      const result = await cashOutStreakRun(writeDb, { userId, runId });
      if (!result) {
        sendJson(req, res, ctx, 404, { error: "run_not_found" });
        return true;
      }
      sendJson(req, res, ctx, 200, result);
      return true;
    }
    const guess = normalizeStreakGuess(body.guess);
    if (!guess) {
      sendJson(req, res, ctx, 400, { error: "invalid_guess" });
      return true;
    }
    const result = await guessStreakRound(writeDb, { userId, runId, guess });
    if (!result) {
      sendJson(req, res, ctx, 404, { error: "run_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, result);
    return true;
  }
  const packGameMatch = url.pathname.match(/^\/api\/packs\/games\/(streak|allowance)$/);
  if (packGameMatch) {
    // The arcade's till. Server-to-server like the pull log and the wallet:
    // the frontend's server function authenticates the osu! cookie and
    // forwards the verified viewer, so a run can only ever be claimed as
    // yourself. What stops a scripted run claiming all day is the daily
    // allowance inside grantPackGameShards, not this route.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const userId = Math.floor(Number(body.userId) || 0);
    if (userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_game_player" });
      return true;
    }
    if (packGameMatch[1] === "allowance") {
      sendJson(req, res, ctx, 200, await getPackGameAllowance(ctx.db, userId));
      return true;
    }
    const streak = Math.max(0, Math.floor(Number(body.streak) || 0));
    const result = await grantPackGameShards(
      ctx.serveWriteDb ?? ctx.db,
      userId,
      "streak",
      streakShardReward(streak),
    );
    sendJson(req, res, ctx, 200, result);
    return true;
  }
  const packWalletMatch = url.pathname.match(/^\/api\/pack-wallet\/(\d+)$/);
  if (packWalletMatch) {
    // Server-to-server only: the frontend's server functions authenticate
    // the osu! login cookie and forward the viewer's own wallet with the
    // admin bearer token. Browsers never call this directly.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const walletUserId = Number(packWalletMatch[1]);
    if (!Number.isFinite(walletUserId) || walletUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (req.method === "GET") {
      // getPackWallet can lazily rewrite legacy payloads, so it needs the write connection too.
      const wallet = await getPackWallet(ctx.serveWriteDb ?? ctx.db, walletUserId);
      sendJson(req, res, ctx, 200, wallet ? { payload: wallet.payload, rev: wallet.rev } : { payload: null, rev: 0 });
      return true;
    }
    if (req.method === "POST") {
      const body = parseJson<Record<string, unknown>>(
        (await readBodyBuffer(req, PACK_WALLET_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
        {},
      );
      const payload = typeof body.payload === "string" ? body.payload : "";
      const baseRev = Number(body.baseRev);
      const cardImportMode = body.cardsMode === "delta" ? "delta" : "snapshot";
      if (!payload || payload.length > PACK_WALLET_PAYLOAD_MAX_CHARS || !Number.isFinite(baseRev) || baseRev < 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_wallet_payload" });
        return true;
      }
      const result = await savePackWallet(ctx.serveWriteDb ?? ctx.db, walletUserId, payload, Math.floor(baseRev), Date.now(), cardImportMode);
      if (!result.ok) {
        sendJson(req, res, ctx, 409, { error: "wallet_conflict", payload: result.current.payload, rev: result.current.rev });
        return true;
      }
      sendJson(req, res, ctx, 200, { rev: result.rev });
      return true;
    }
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  const packShowcaseWriteMatch = url.pathname.match(/^\/api\/pack-collection\/(\d+)\/showcase$/);
  if (packShowcaseWriteMatch) {
    // Server-to-server like the wallet: the frontend authenticates the osu!
    // login cookie and forwards the viewer's own id, so a user only ever
    // edits their own shelf. Reads of *other* people's shelves go through the
    // public /api/packs/showcase endpoint instead.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const ownerUserId = Number(packShowcaseWriteMatch[1]);
    if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (req.method === "GET") {
      const cards = await getPackShowcase(ctx.db, ownerUserId);
      sendJson(req, res, ctx, 200, { cardKeys: cards.map((card) => card.cardKey) });
      return true;
    }
    if (req.method === "POST") {
      const body = parseJson<Record<string, unknown>>(
        (await readBodyBuffer(req, DEFAULT_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
        {},
      );
      const cardKeys = await setPackShowcase(ctx.serveWriteDb ?? ctx.db, ownerUserId, body.cardKeys);
      sendJson(req, res, ctx, 200, { cardKeys });
      return true;
    }
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  const packCollectionMatch = url.pathname.match(/^\/api\/pack-collection\/(\d+)$/);
  if (packCollectionMatch) {
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    const walletUserId = Number(packCollectionMatch[1]);
    if (!Number.isFinite(walletUserId) || walletUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    if (req.method === "POST") {
      const body = parseJson<Record<string, unknown>>(
        (await readBodyBuffer(req, DEFAULT_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
        {},
      );
      // Repairing a card's missing skills snapshot: no economy change, so it
      // returns the card key rather than a wallet, and never bumps the rev.
      if (body.mode === "mint") {
        const result = await applyPackCollectionCardMint(
          ctx.serveWriteDb ?? ctx.db,
          walletUserId,
          body.cardKey,
          {
            tier: body.tier,
            tierLabel: body.tierLabel,
            skills: body.skills,
          },
        );
        sendJson(req, res, ctx, 200, result);
        return true;
      }
      const mode =
        body.mode === "duplicates" ||
        body.mode === "whole" ||
        body.mode === "all_duplicates" ||
        body.mode === "whole_matching" ||
        body.mode === "copies"
        ? body.mode
        : null;
      // Cards are addressed by wallet key ("<id>" or "<id>:goat"), so a GOAT
      // and an ordinary card of the same player recycle independently.
      const cardKey = normalizePackCardKey(body.cardKey);
      const cardKeys = mode === "whole" && Array.isArray(body.cardKeys)
        ? body.cardKeys
            .slice(0, 500)
            .map(normalizePackCardKey)
            .filter((key): key is string => key !== null)
        : null;
      const hasBulkKeys = cardKeys !== null && cardKeys.length > 0;
      /* Per-card copy counts, capped at a hand's worth: this mode exists for
         handing back the pack you just opened, not for walking a collection. */
      const cardCopies = mode === "copies" && Array.isArray(body.cardCopies)
        ? body.cardCopies
            .slice(0, 50)
            .map((entry) => {
              const key = normalizePackCardKey((entry as { cardKey?: unknown })?.cardKey);
              const copies = Math.floor(Number((entry as { copies?: unknown })?.copies) || 0);
              return key && copies > 0 ? { cardKey: key, copies: Math.min(copies, 100) } : null;
            })
            .filter((entry): entry is { cardKey: string; copies: number } => entry !== null)
        : null;
      const hasCopyEntries = cardCopies !== null && cardCopies.length > 0;
      if (
        !mode ||
        (mode === "copies" && !hasCopyEntries) ||
        (mode !== "all_duplicates" && mode !== "whole_matching" && mode !== "copies" && !hasBulkKeys && !cardKey)
      ) {
        sendJson(req, res, ctx, 400, { error: "invalid_recycle_request" });
        return true;
      }
      const recycleTier = typeof body.tier === "string" ? body.tier : "all";
      // The "not tracked" filter recycles by player restriction, not by tier.
      // If the pool can't be read the restriction stays empty and nothing is
      // recycled; the alternative would recycle the whole collection.
      const recycleUntracked = mode === "whole_matching" && recycleTier === "untracked";
      const untrackedIds = recycleUntracked
        ? await getPackPoolMembership(ctx.db)
            .then((pool) => getPackCollectionPoolProgress(ctx.db, walletUserId, pool))
            .then((progress) => progress.offPoolUserIds)
            .catch(() => [] as number[])
        : undefined;
      const result = await recyclePackCollectionCards(ctx.serveWriteDb ?? ctx.db, walletUserId, {
        mode,
        cardKey: cardKey ?? undefined,
        cardKeys: hasBulkKeys ? cardKeys : undefined,
        cardCopies: hasCopyEntries ? cardCopies : undefined,
        tier: recycleUntracked ? "all" : recycleTier,
        query: typeof body.query === "string" ? body.query.slice(0, 120) : "",
        restrictToCardUserIds: untrackedIds,
      });
      sendJson(req, res, ctx, 200, { gained: result.gained, payload: result.wallet.payload, rev: result.wallet.rev });
      return true;
    }
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (url.searchParams.get("ownedIds") === "1") {
      sendJson(req, res, ctx, 200, { cardKeys: await listPackCollectionOwnedCardKeys(ctx.db, walletUserId) });
      return true;
    }
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
    const pageSize = Math.min(
      PACK_COLLECTION_MAX_PAGE_SIZE,
      Math.max(1, Math.floor(Number(url.searchParams.get("pageSize")) || 15)),
    );
    const tier = url.searchParams.get("tier");
    const query = url.searchParams.get("q");
    const sort = url.searchParams.get("sort") === "newest" ? ("newest" as const) : null;
    // The missing list is the pool minus the collection, so a pool that
    // cannot be read has no honest answer: better to say so than to serve an
    // empty page that reads as "you have them all".
    if (url.searchParams.get("missing") === "1") {
      const roster = await getPackPoolRoster(ctx.db).catch(() => null);
      if (!roster) {
        sendJson(req, res, ctx, 503, { error: "pool_unavailable" });
        return true;
      }
      const [missing, goatMissing] = await Promise.all([
        listPackCollectionMissingPlayers(ctx.db, walletUserId, roster, { page, pageSize, query }),
        countMissingGoatCards(ctx.db, walletUserId),
      ]);
      sendJson(req, res, ctx, 200, { ...missing, goatMissing });
      return true;
    }
    // Progress is a garnish on the header; a pool board that cannot build
    // right now must not take the collection page down with it.
    const progress = await getPackPoolMembership(ctx.db)
      .then((pool) => getPackCollectionPoolProgress(ctx.db, walletUserId, pool))
      .catch(() => null);
    // "untracked" is not a tier: it lists the owned players who left the draw
    // pool. With no pool to compare against the filter honestly shows nothing.
    const untracked = tier === "untracked";
    const collectionPage = await listPackCollectionCards(ctx.db, walletUserId, {
      page,
      pageSize,
      tier: untracked ? "all" : tier,
      query,
      sort,
      restrictToCardUserIds: untracked ? progress?.offPoolUserIds ?? [] : undefined,
    });
    sendJson(req, res, ctx, 200, {
      ...collectionPage,
      poolProgress: progress
        ? { poolTotal: progress.poolTotal, poolOwnedCount: progress.poolOwnedCount, retiredOwnedCount: progress.retiredOwnedCount }
        : null,
    });
    return true;
  }
  return false;
}
