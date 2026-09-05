import type { IncomingMessage, ServerResponse } from "node:http";
import { checkWriteGateOverloaded, parseJson } from "../../db.js";
import { getPackGameAllowance, getStreakPlayerMetrics, grantPackGameShards, STREAK_METRICS_MAX_IDS, streakShardReward } from "../../features/pack-games.js";
import { getPackCardCollectors, getPackCardKeyStats, getPackCardStats, getPackPulledStats, getSharedPackCard, listPackPullsByIds, listRecentPackPulls, PACK_PULL_MAX_CARDS_PER_EVENT, recordPackPullEvents } from "../../features/pack-pulls.js";
import { cashOutStreakRun, getStreakBoard, guessStreakRound, normalizeStreakGuess, normalizeStreakPool, normalizeStreakRunId, startStreakRun } from "../../features/pack-streak.js";
import { applyPackCollectionCardMint, countMissingGoatCards, listMissingGoatCardUserIds, listPackCardMotifUrls, getPackCollectionPoolProgress, getPackShowcase, getPackUserIdentity, getPackWallet, getPullableEternalIdentity, listPackCollectionCards, listPackCollectionMissingPlayers, listPackCollectionOwnedCardKeys, mergeImportedPackWallet, mintDealtPackCards, mintEternalSelfCardOnce, mintPulledEternalCard, normalizeAvatarUrl, normalizeCountryCode, normalizePackCardKey, PACK_COLLECTION_MAX_PAGE_SIZE, packCardKey, recyclePackCollectionCards, setPackShowcase, spendPackOpen, type DealtPackCardSlot, type PackUserIdentity } from "../../features/pack-wallets.js";
import { getPackCollectorProfile, getPackCommunityStats, getPackShowcaseCards, listPackCollectors, listPackShowcaseWall, normalizePackCollectorSort, PACK_COLLECTOR_PAGE_MAX_SIZE, resolvePackCollector } from "../../features/pack-community.js";
import { drawPackHand, PACK_DRAW_TYPES, PackPoolUnavailableError, shouldDealEternalSelfCard } from "../../features/pack-draw.js";
import { claimPackMilestoneOnce, PACK_MILESTONE } from "../../features/pack-milestone.js";
import { commitPackWishlistRoll, hasPackWishlistRows, settlePackWishlistOwned } from "../../features/pack-wishlist.js";
import { logInfo, logWarn } from "../../logger.js";
import { getPackPoolMembership, getPackPoolRoster } from "../../features/global-rankings.js";
import { fetchAndStoreProfileSnapshotShared, getCachedPackCardSnapshots, PACK_CARD_SNAPSHOT_MAX_IDS, selectReadyPackCardUserIds, warmProfileSnapshots } from "../../features/player-profiles.js";
import type { HttpContext } from "../context.js";
import { DEFAULT_BODY_LIMIT_BYTES, isBridge, readBody, readBodyBuffer } from "../request.js";
import { checkRate, sendAccentEnrichedJson, sendJson, sendWritePressureShed } from "../respond.js";

// A wallet holding the full ~6k tracked-player pool serializes to ~1.5MB,
// so pack wallet pushes get more headroom than the default body limit.
const PACK_WALLET_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const PACK_WALLET_PAYLOAD_MAX_CHARS = 3_500_000;

/* Per-account draw ceiling. Bridge traffic shares one generous per-IP bucket
   (every signed-in visitor arrives from the frontend server), so a scripted
   account could otherwise spend the whole site's card-build budget alone. No
   honest client opens 30 packs a minute; the 2026-08-05 sitewide peak was 245.
   In-memory on purpose: a restart forgiving a window is fine at this size. */
const PACK_DRAW_MAX_PER_MINUTE = 30;
const PACK_DRAW_WINDOW_MS = 60_000;
const PACK_DRAW_MAX_EXCLUDE_KEYS = 30;
const packDrawWindows = new Map<number, { windowStartMs: number; count: number }>();

function packDrawRateLimited(userId: number): boolean {
  const now = Date.now();
  const window = packDrawWindows.get(userId);
  if (!window || now - window.windowStartMs >= PACK_DRAW_WINDOW_MS) {
    if (packDrawWindows.size > 4096) {
      for (const [key, value] of packDrawWindows) {
        if (now - value.windowStartMs >= PACK_DRAW_WINDOW_MS) packDrawWindows.delete(key);
      }
    }
    packDrawWindows.set(userId, { windowStartMs: now, count: 1 });
    return false;
  }
  window.count += 1;
  return window.count > PACK_DRAW_MAX_PER_MINUTE;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eternalSelfIdentity(
  userId: number,
  snapshotUser: Record<string, unknown> | null,
  stored: PackUserIdentity | null,
  verified: { username: string; avatarUrl: string; countryCode: string },
): PackUserIdentity {
  const statistics = snapshotUser?.statistics && typeof snapshotUser.statistics === "object"
    ? snapshotUser.statistics as Record<string, unknown>
    : null;
  const username = typeof snapshotUser?.username === "string" && snapshotUser.username
    ? snapshotUser.username
    : stored?.username || verified.username || `User ${userId}`;
  const avatarUrl = typeof snapshotUser?.avatar_url === "string" && snapshotUser.avatar_url
    ? snapshotUser.avatar_url
    : stored?.avatarUrl || verified.avatarUrl;
  const countryCode = typeof snapshotUser?.country_code === "string" && snapshotUser.country_code
    ? snapshotUser.country_code
    : stored?.countryCode || verified.countryCode;
  return {
    username: username.slice(0, 40),
    avatarUrl: normalizeAvatarUrl(avatarUrl),
    countryCode: normalizeCountryCode(countryCode),
    pp: Math.max(0, finiteNumber(statistics?.pp) ?? stored?.pp ?? 0),
    globalRank: Math.max(0, Math.floor(finiteNumber(statistics?.global_rank) ?? stored?.globalRank ?? 0)),
  };
}

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
    // The largest pack (Wild) plus another collector's Eternal and the opener,
    // whose completion and milestone cards share an id if both land at once.
    )].slice(0, 12);
    if (userIds.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_ids" });
      return true;
    }
    sendJson(req, res, ctx, 202, await warmProfileSnapshots(ctx.serveWriteDb ?? ctx.db, ctx.osu, userIds));
    return true;
  }
  if (url.pathname === "/api/packs/card-motifs") {
    // The allowlist behind the frontend's /api/card-motif image proxy. Bridge
    // only: it is not interesting to a browser, and it names every image any
    // granted card carries.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!isBridge(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(req, res, ctx, 200, { urls: await listPackCardMotifUrls(ctx.db) });
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
  if (url.pathname === "/api/packs/draw") {
    /* The deal itself, rolled here rather than in the browser. Server-to-server
       like the wallet: the frontend's server function authenticates the osu!
       login cookie and forwards the verified opener, so the pool slice, the
       uniform odds, duplicate protection and the honorary chance are enforced
       where the pool lives instead of advised to the client. The response
       inlines the hand's card snapshots, so one request is the whole open;
       anonymous (browser-local, never-synced) wallets keep the client-side
       draw over the public pool pages. */
    if (!isBridge(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const ownerUserId = Math.floor(Number(body.userId) || 0);
    const packType = typeof body.packType === "string" ? body.packType : "";
    if (ownerUserId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_draw_owner" });
      return true;
    }
    const type = PACK_DRAW_TYPES.get(packType);
    if (!type) {
      sendJson(req, res, ctx, 400, { error: "invalid_pack_type" });
      return true;
    }
    if (packDrawRateLimited(ownerUserId)) {
      res.setHeader("retry-after", "60");
      sendJson(req, res, ctx, 429, { error: "rate_limited" });
      return true;
    }
    // A draw is entertainment: under write pressure it waits a few seconds
    // (the client's existing 429 retry) instead of feeding the saturation
    // that froze the site on 2026-08-07 and 2026-08-29.
    const shed = checkWriteGateOverloaded(ctx.serveWriteDb);
    if (shed) {
      sendWritePressureShed(req, res, ctx, "packs-draw", shed.retryAfterMs);
      return true;
    }
    /* Compat hint from clients built before the draw wrote the collection
       itself: cards pulled moments ago that their debounced wallet push has
       not landed. New clients send nothing here - the previous hand is
       already in pack_collection_cards by the time the next draw reads it. */
    const excludeCardKeys = (Array.isArray(body.excludeCardKeys) ? body.excludeCardKeys : [])
      .slice(0, PACK_DRAW_MAX_EXCLUDE_KEYS)
      .map(normalizePackCardKey)
      .filter((key): key is string => key !== null);
    /* The one-time 100%-completion reward, decided entirely server-side (the
       durable claim, completion-eligible collection rows and pool all live
       here, so no client state can claim it). */
    const eternalSelfCandidate = await shouldDealEternalSelfCard(ctx.db, ownerUserId);
    let hand;
    try {
      hand = await drawPackHand(ctx.db, { packType, ownerUserId, excludeCardKeys });
    } catch (error) {
      if (error instanceof PackPoolUnavailableError) {
        sendJson(req, res, ctx, 503, { error: "pack_pool_unavailable" });
        return true;
      }
      throw error;
    }
    if (!hand) {
      sendJson(req, res, ctx, 400, { error: "invalid_pack_type" });
      return true;
    }
    /* The purchase, after the draw proved servable and before anything is
       minted: a pool outage charges nobody, and a refused wallet mints
       nothing. The refusal carries the stored wallet so the client corrects
       its display instead of retrying against the same answer. */
    const writeDb = ctx.serveWriteDb ?? ctx.db;
    const spend = await spendPackOpen(writeDb, ownerUserId, type.cost, Date.now(), hand.poolTotal);
    if (!spend.ok) {
      sendJson(req, res, ctx, 409, {
        error: "insufficient_funds",
        reason: spend.reason,
        wallet: { payload: spend.wallet.payload, rev: spend.wallet.rev },
      });
      return true;
    }
    /* The wishlist roll was decided before the spend so a refused wallet
       could not move it; now the pack is paid for, it is written down. */
    if (hand.wishlistRoll?.counted) {
      try {
        await commitPackWishlistRoll(writeDb, ownerUserId, hand.wishlistRoll, Date.now());
      } catch (error) {
        logWarn("pack_wishlist_commit_failed", { userId: ownerUserId, error: String(error) });
      }
    }
    /* The dealt hand becomes collection rows here, not via a client push:
       copies are the economy's other half. The client's mint pass labels the
       rows (tier, skills) once the reveal computes them. */
    const dealtSlots: DealtPackCardSlot[] = hand.players.map((slot) =>
      slot.honorary
        ? { userId: slot.userId, tier: "goat", username: "", avatarUrl: "", countryCode: "", pp: 0, globalRank: 0 }
        : {
            userId: slot.userId,
            tier: null,
            username: slot.username ?? "",
            avatarUrl: slot.avatarUrl ?? "",
            countryCode: slot.countryCode ?? "",
            pp: slot.eternal ? 0 : slot.pp,
            globalRank: slot.eternal ? 0 : slot.globalRank ?? 0,
          },
    );
    const isNewByCardKey = await mintDealtPackCards(writeDb, ownerUserId, dealtSlots, Date.now());
    /* A wish is a list of players you are missing, so anything this hand just
       dealt comes off it. One cheap exists() first: most opens belong to a
       collector with no wishlist at all and pay nothing for the feature. */
    try {
      if (hand.players.some((slot) => slot.wished) || (await hasPackWishlistRows(ctx.db, ownerUserId))) {
        await settlePackWishlistOwned(writeDb, ownerUserId);
      }
    } catch (error) {
      // The pack is paid and minted by now; a wishlist that cannot be read
      // or settled is a stale line on the page, never a lost hand.
      logWarn("pack_wishlist_settle_failed", { userId: ownerUserId, error: String(error) });
    }
    /* Somebody else's Eternal card, on the 0.0025% slot. Nothing one-time about
       it, so unlike the completion reward it is an ordinary repeatable mint;
       a failure here still returns the paid hand rather than losing the pack.
       Placed before the completion reward's push so the opener's own card, if
       both ever land in one open, is still the last thing the reveal shows. */
    if (hand.eternalPullUserId > 0) {
      try {
        const identity = await getPullableEternalIdentity(ctx.db, hand.eternalPullUserId);
        if (identity) {
          const pulled = await mintPulledEternalCard(writeDb, ownerUserId, hand.eternalPullUserId, identity, Date.now());
          hand.players.push({ eternal: true, userId: hand.eternalPullUserId, ...identity });
          isNewByCardKey.set(packCardKey(hand.eternalPullUserId, "eternal"), pulled.isNew);
          // Their card renders from their plays like any other, so a holder
          // the pool never warmed joins the warm the cold path would run.
          if ((await selectReadyPackCardUserIds(ctx.db, [hand.eternalPullUserId])).length === 0) {
            hand.notReadyUserIds.push(hand.eternalPullUserId);
          }
          logInfo("pack_eternal_pull", { ownerUserId, cardUserId: hand.eternalPullUserId, packType });
        }
      } catch (error) {
        logWarn("pack_eternal_pull_failed", { userId: ownerUserId, error: String(error) });
      }
    }
    /* The opener's own face, resolved once for whichever of the two one-time
       deals below needs it: the stored/fetched profile snapshot for the
       numbers, the users row and the verified osu! cookie identity as the
       name/avatar fallbacks. */
    let selfIdentity: PackUserIdentity | null = null;
    const resolveSelfIdentity = async (reason: string): Promise<PackUserIdentity> => {
      if (selfIdentity) return selfIdentity;
      let selfSnapshots = await getCachedPackCardSnapshots(ctx.db, [ownerUserId]);
      if (selfSnapshots.length === 0) {
        try {
          await fetchAndStoreProfileSnapshotShared(
            writeDb,
            ctx.osu,
            String(ownerUserId),
            "userId",
            reason,
          );
          selfSnapshots = await getCachedPackCardSnapshots(writeDb, [ownerUserId]);
        } catch {
          // The signed osu! cookie identity below still gives the card its
          // correct face; the normal reveal cold path can retry the scores.
        }
      }
      const storedIdentity = await getPackUserIdentity(writeDb, ownerUserId);
      const verifiedIdentity = {
        username: typeof body.viewerUsername === "string" ? body.viewerUsername.slice(0, 40) : "",
        avatarUrl: normalizeAvatarUrl(body.viewerAvatarUrl),
        countryCode: normalizeCountryCode(typeof body.viewerCountryCode === "string" ? body.viewerCountryCode : ""),
      };
      selfIdentity = eternalSelfIdentity(
        ownerUserId,
        selfSnapshots[0]?.user ?? null,
        storedIdentity,
        verifiedIdentity,
      );
      return selfIdentity;
    };
    /* Eligibility is a read, but the award is a database claim: parallel draw
       requests may both arrive here as candidates, and exactly one random
       claim token wins the primary key while minting the card in that same
       transaction. Only that winner appends the bonus to its response. */
    if (eternalSelfCandidate) {
      try {
        const identity = await resolveSelfIdentity("api:pack_eternal_self");
        const eternal = await mintEternalSelfCardOnce(writeDb, ownerUserId, identity, Date.now());
        if (eternal.dealt) {
          // Appended after the honorary machinery, so this remains the hand's
          // final card even when the same pack also hit a GOAT.
          hand.players.push({ eternal: true, userId: ownerUserId, ...identity });
          isNewByCardKey.set(packCardKey(ownerUserId, "eternal"), eternal.isNew);
        }
      } catch (error) {
        // The ordinary hand is already paid and minted. Return it rather than
        // losing that pack; the atomic claim rolled back, so the reward stays
        // pending for the next open.
        logWarn("pack_eternal_deal_failed", { userId: ownerUserId, error: String(error) });
      }
    }
    /* The milestone's golden card (pack-milestone.ts): this open's spend is
       already banked, so the sum it reads includes this pack, and the pack
       that makes the number is the pack that wins it. One row read while the
       milestone is unclaimed and nothing at all once it is. Last of all, so
       the millionth pack ends on it. */
    if (PACK_MILESTONE.enabled) {
      try {
        const milestone = await claimPackMilestoneOnce(
          writeDb,
          ownerUserId,
          () => resolveSelfIdentity("api:pack_milestone"),
          Date.now(),
        );
        if (milestone.dealt && milestone.cardKey) {
          const identity = await resolveSelfIdentity("api:pack_milestone");
          hand.players.push({
            eternal: true,
            milestone: true,
            userId: ownerUserId,
            ...identity,
            cardKey: milestone.cardKey,
            customLabel: PACK_MILESTONE.goldenLabel,
            motif: PACK_MILESTONE.goldenMotif,
          });
          isNewByCardKey.set(milestone.cardKey, true);
          logInfo("pack_milestone_claimed", {
            milestoneId: PACK_MILESTONE.id,
            ownerUserId,
            cardKey: milestone.cardKey,
            packsOpened: milestone.packsOpened,
            packType,
          });
        }
      } catch (error) {
        logWarn("pack_milestone_claim_failed", { userId: ownerUserId, error: String(error) });
      }
    }
    // Dealt because the slice had no ready replacement left: start their
    // fetch now so the reveal's cold path joins an in-flight warm.
    if (hand.notReadyUserIds.length > 0) {
      void warmProfileSnapshots(writeDb, ctx.osu, hand.notReadyUserIds).catch(() => {});
    }
    const cards = await getCachedPackCardSnapshots(ctx.db, hand.players.map((player) => player.userId));
    const players = hand.players.map((slot) => ({
      ...slot,
      isNew: isNewByCardKey.get(slot.cardKey ?? packCardKey(slot.userId, slot.honorary ? "goat" : slot.eternal ? "eternal" : null)) ?? false,
    }));
    await sendAccentEnrichedJson(req, res, ctx, 200, {
      poolTotal: hand.poolTotal,
      players,
      cards,
      wallet: { payload: spend.wallet.payload, rev: spend.wallet.rev },
    });
    return true;
  }
  if (url.pathname === "/api/packs/pulls") {
    // Server-to-server only, like the wallet sync: the frontend's server
    // function authenticates the osu! login cookie and forwards the verified
    // viewer identity, so an event can only ever be logged as yourself.
    if (!isBridge(req, ctx)) {
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
          await ctx.events.append("pack_pull", null, entry, `pack_pull:${entry.id}`);
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
    //
    // `keys` counts named cards ("in N collections" under one card), `ids`
    // counts every card of a player together, which is all that can be said
    // when the caller has a player and not a card.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const rawKeys = (url.searchParams.get("keys") ?? "").split(",").filter((raw) => raw.length > 0);
    if (rawKeys.length > 0) {
      const cards = await getPackCardKeyStats(ctx.db, rawKeys);
      if (cards.length === 0) {
        sendJson(req, res, ctx, 400, { error: "invalid_card_keys" });
        return true;
      }
      sendJson(req, res, ctx, 200, { cards });
      return true;
    }
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
    if (!isBridge(req, ctx)) {
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
  // The card segment is a card key ("123", "123:goat", "123:v2"), so it also
  // matches a percent-encoded colon: a browser that encodes the path segment
  // and one that does not both address the same card.
  const packPulledCardMatch = url.pathname.match(/^\/api\/packs\/pulled-card\/(\d+)\/([\d]+(?::|%3[Aa])?[a-z0-9]*)$/);
  if (packPulledCardMatch) {
    // One owned card as a shareable artifact: backs the /pull/{owner}/{card}
    // permalink page and its OG image. Public; reads the durable collection
    // row so the link outlives pull-event retention. A live-feed link can add
    // ?pull={eventId} to recover that event's date while the log still has it.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const pullEventId = Math.floor(Number(url.searchParams.get("pull")) || 0);
    const shared = await getSharedPackCard(
      ctx.db,
      Number(packPulledCardMatch[1]),
      decodeURIComponent(packPulledCardMatch[2]),
      pullEventId > 0 ? pullEventId : null,
    );
    if (!shared) {
      sendJson(req, res, ctx, 404, { error: "pulled_card_not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, shared);
    return true;
  }
  /* The community read of the economy, behind /packs/collections. Public and
     browser-direct: every viewer gets the same page, which is also why these
     cache. Collections were always visible one card at a time (the pull ticker
     names owners, /pull/{owner}/{card} is a durable public share); this is the
     same data grouped by collector instead of by pull. */
  if (url.pathname === "/api/packs/community/stats") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    /* Shorter than the boards deserve, because of the four numbers at the top:
       they are maintained on a twenty-second clock now, and a minute of browser
       cache on top of that is what made somebody who had just watched the packs
       counter tick up see it drop back on reload. */
    res.setHeader("cache-control", "public, max-age=15");
    await sendAccentEnrichedJson(req, res, ctx, 200, await getPackCommunityStats(ctx.db));
    return true;
  }
  if (url.pathname === "/api/packs/community/showcases") {
    // The wall of chosen cards, one tile per card. Short cache: this is the one
    // surface a collector edits and then immediately reloads to look at.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
    const pageSize = Math.min(60, Math.max(1, Math.floor(Number(url.searchParams.get("pageSize")) || 40)));
    res.setHeader("cache-control", "public, max-age=10");
    await sendAccentEnrichedJson(req, res, ctx, 200, await listPackShowcaseWall(ctx.db, { page, pageSize }));
    return true;
  }
  if (url.pathname === "/api/packs/community/showcase") {
    /* One collector's chosen cards. Split from the collector profile because
       the viewer reading back their own row wants the cards and nothing else,
       and the profile carries board ranks, which need the cached economy
       roll-up and so can block on a cold rebuild. */
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
    res.setHeader("cache-control", "public, max-age=10");
    await sendAccentEnrichedJson(req, res, ctx, 200, { cards: await getPackShowcaseCards(ctx.db, ownerUserId) });
    return true;
  }
  if (url.pathname === "/api/packs/community/collectors") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
    const pageSize = Math.min(
      PACK_COLLECTOR_PAGE_MAX_SIZE,
      Math.max(1, Math.floor(Number(url.searchParams.get("pageSize")) || 24)),
    );
    res.setHeader("cache-control", "public, max-age=60");
    await sendAccentEnrichedJson(req, res, ctx, 200, await listPackCollectors(ctx.db, {
      page,
      pageSize,
      query: url.searchParams.get("q"),
      sort: normalizePackCollectorSort(url.searchParams.get("sort")),
    }));
    return true;
  }
  if (url.pathname === "/api/packs/community/collector") {
    // Addressed by id or by name, since the shareable link carries whichever
    // the visitor clicked. A name only resolves if something stored the pair.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const collectorUserId = await resolvePackCollector(ctx.db, {
      userId: url.searchParams.get("userId"),
      username: url.searchParams.get("username"),
    });
    const profile = collectorUserId ? await getPackCollectorProfile(ctx.db, collectorUserId) : null;
    if (!profile) {
      sendJson(req, res, ctx, 404, { error: "collector_not_found" });
      return true;
    }
    res.setHeader("cache-control", "public, max-age=60");
    await sendAccentEnrichedJson(req, res, ctx, 200, profile);
    return true;
  }
  const packCommunityCollectionMatch = url.pathname.match(/^\/api\/packs\/community\/collection\/(\d+)$/);
  if (packCommunityCollectionMatch) {
    // The same paged read the owner's own grid uses, minus the recycle
    // economics: what a card is worth in shards is the holder's business.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const ownerUserId = Number(packCommunityCollectionMatch[1]);
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
    const pageSize = Math.min(
      PACK_COLLECTION_MAX_PAGE_SIZE,
      Math.max(1, Math.floor(Number(url.searchParams.get("pageSize")) || 24)),
    );
    const { duplicateShardTotal: _duplicates, filteredShardTotal: _filtered, ...collectionPage } =
      await listPackCollectionCards(ctx.db, ownerUserId, {
        page,
        pageSize,
        tier: url.searchParams.get("tier"),
        query: url.searchParams.get("q"),
      });
    res.setHeader("cache-control", "public, max-age=60");
    await sendAccentEnrichedJson(req, res, ctx, 200, collectionPage);
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
    if (!isBridge(req, ctx)) {
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
    if (!isBridge(req, ctx)) {
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
    if (!isBridge(req, ctx)) {
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
      if (!payload || payload.length > PACK_WALLET_PAYLOAD_MAX_CHARS) {
        sendJson(req, res, ctx, 400, { error: "invalid_wallet_payload" });
        return true;
      }
      /* The one write a client wallet still gets: folding its pre-login
         (browser-local) history into a server wallet that has never played,
         once per account ever. Everything about the payload is capped inside
         the merge; the log line is what makes an abused cap visible. */
      if (body.mode === "merge") {
        const result = await mergeImportedPackWallet(ctx.serveWriteDb ?? ctx.db, walletUserId, payload);
        if (result.merged && result.imported) {
          logInfo("pack_wallet_import", { userId: walletUserId, ...result.imported });
        }
        sendJson(req, res, ctx, 200, {
          merged: result.merged,
          payload: result.wallet.payload,
          rev: result.wallet.rev,
        });
        return true;
      }
      /* Compat for clients built when the wallet blob was client-authored:
         they push their whole economy after every mutation. The economy and
         the copy counts are server-owned now, so nothing here is written -
         the push is acknowledged with the current rev and the response is
         shaped so the old client settles instead of looping on conflicts.
         (Their card mints ride this path too and are dropped; the collected
         card self-repairs through the mint route next time it renders.) */
      const current = await getPackWallet(ctx.serveWriteDb ?? ctx.db, walletUserId);
      sendJson(req, res, ctx, 200, { rev: current?.rev ?? 0 });
      return true;
    }
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  const packShowcaseWriteMatch = url.pathname.match(/^\/api\/pack-collection\/(\d+)\/showcase$/);
  if (packShowcaseWriteMatch) {
    // Server-to-server like the wallet: the frontend authenticates the osu!
    // login cookie and forwards the viewer's own id, so a user only ever
    // edits their own showcase. This is the write path only; every read of a
    // showcase, including your own, is public and browser-direct through
    // /api/packs/community/{showcases,collector}.
    if (!isBridge(req, ctx)) {
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
    if (!isBridge(req, ctx)) {
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
      // Labelling cards: the tier, tier label and skills the browser's
      // maniacard pass computed for rows the server already holds. No economy
      // change and never a new copy - applyPackCollectionCardMint only writes
      // onto an owned row. Two shapes: a single card (the collection panel's
      // legacy-card repair) or a hand's worth at once (the pass that follows
      // every server-dealt open).
      if (body.mode === "mint") {
        if (Array.isArray(body.cards)) {
          const mints = body.cards.slice(0, 13); // Wild pack plus the three bonus slots.
          let applied = 0;
          for (const raw of mints) {
            const mint = (raw ?? {}) as Record<string, unknown>;
            const result = await applyPackCollectionCardMint(ctx.serveWriteDb ?? ctx.db, walletUserId, mint.cardKey, {
              tier: mint.tier,
              tierLabel: mint.tierLabel,
              skills: mint.skills,
              pp: mint.pp,
              globalRank: mint.globalRank,
            });
            if (result.applied) applied += 1;
          }
          sendJson(req, res, ctx, 200, { applied });
          return true;
        }
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
      const [missing, goatMissingUserIds] = await Promise.all([
        listPackCollectionMissingPlayers(ctx.db, walletUserId, roster, { page, pageSize, query }),
        listMissingGoatCardUserIds(ctx.db, walletUserId),
      ]);
      sendJson(req, res, ctx, 200, {
        ...missing,
        goatMissing: goatMissingUserIds.length,
        goatMissingUserIds,
      });
      return true;
    }
    // Progress is a garnish on the header; a pool board that cannot build
    // right now must not take the collection page down with it.
    const [progress, goatMissing] = await Promise.all([
      getPackPoolMembership(ctx.db)
        .then((pool) => getPackCollectionPoolProgress(ctx.db, walletUserId, pool))
        .catch(() => null),
      countMissingGoatCards(ctx.db, walletUserId).catch(() => null),
    ]);
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
      goatMissing,
    });
    return true;
  }
  return false;
}
