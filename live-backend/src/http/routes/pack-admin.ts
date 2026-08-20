import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  getAdminPackCollectionOverview,
  grantAdminPackCard,
  removeAdminPackCard,
  resolveAdminPackUser,
  setAdminPackWalletEconomy,
  type AdminPackCardGrant,
  type AdminPackUser,
} from "../../features/pack-admin.js";
import { logInfo } from "../../logger.js";
import type { HttpContext } from "../context.js";
import { readBody } from "../request.js";
import { sendJson } from "../respond.js";

/* The four routes behind /admin/collections (features/pack-admin.ts). The
   admin gate lives at the call site in admin.ts, so everything here is already
   the owner talking.

   Kept out of routes/packs.ts on purpose: every route in that file is called
   for the signed-in player whose own wallet or collection it touches, and is
   bridge-gated to prove exactly that. These four are the opposite - they act on
   somebody else's collection - so they take the admin token and sit with the
   rest of the admin surface. */

const MAX_PAGE_SIZE = 60;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const next = Math.floor(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/* Both halves of a request name a player the same way: an osu! id, or a
   username the users projection knows. Answers 404 itself so each route below
   is one guard shorter. */
async function resolveTarget(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  spec: { userId?: unknown; username?: unknown },
): Promise<AdminPackUser | null> {
  const user = await resolveAdminPackUser(ctx.db, spec);
  if (!user) {
    sendJson(req, res, ctx, 404, { error: "user_not_found" });
    return null;
  }
  return user;
}

export async function handleAdminPackCollectionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  const writeDb = ctx.serveWriteDb ?? ctx.db;

  if (url.pathname === "/api/admin/packs/collection") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const user = await resolveTarget(req, res, ctx, {
      userId: url.searchParams.get("userId"),
      username: url.searchParams.get("username"),
    });
    if (!user) return true;
    const tier = url.searchParams.get("tier");
    sendJson(req, res, ctx, 200, await getAdminPackCollectionOverview(ctx.db, user, {
      page: clampInt(url.searchParams.get("page"), 0, 10_000, 0),
      pageSize: clampInt(url.searchParams.get("pageSize"), 1, MAX_PAGE_SIZE, 24),
      tier: tier && tier !== "all" ? tier : null,
      query: url.searchParams.get("q"),
      sort: url.searchParams.get("sort") === "newest" ? "newest" : null,
    }));
    return true;
  }

  if (url.pathname === "/api/admin/packs/collection/wallet") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const user = await resolveTarget(req, res, ctx, body);
    if (!user) return true;
    const economy = await setAdminPackWalletEconomy(writeDb, user, {
      shards: optionalNumber(body.shards),
      shardsDelta: optionalNumber(body.shardsDelta),
      shardsSpent: optionalNumber(body.shardsSpent),
      charges: optionalNumber(body.charges),
      openedPacks: optionalNumber(body.openedPacks),
    });
    logInfo("admin_pack_wallet_set", {
      userId: user.userId,
      shards: economy.shards,
      shardsDelta: optionalNumber(body.shardsDelta) ?? 0,
      charges: economy.charges,
    });
    sendJson(req, res, ctx, 200, { ok: true, economy });
    return true;
  }

  if (url.pathname === "/api/admin/packs/collection/grant") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const user = await resolveTarget(req, res, ctx, body);
    if (!user) return true;
    const raw = (body.card && typeof body.card === "object" ? body.card : {}) as Record<string, unknown>;
    const grant: AdminPackCardGrant = {
      cardUserId: Math.floor(Number(raw.cardUserId)),
      // The holding to edit, when the desk listed one. Absent grants against
      // the player, which mints a card of its own for anything customized.
      cardKey: optionalString(raw.cardKey),
      // Absent and explicit null both mean unrated; only a real string is a
      // tier claim, and pack-admin rejects one that is not a known tier.
      tier: typeof raw.tier === "string" && raw.tier.length > 0 ? raw.tier : null,
      tierLabel: raw.tierLabel === undefined ? undefined : optionalString(raw.tierLabel) ?? null,
      copies: optionalNumber(raw.copies),
      copiesMode: raw.copiesMode === "set" ? "set" : "add",
      recycledCopies: optionalNumber(raw.recycledCopies),
      pp: optionalNumber(raw.pp),
      globalRank: optionalNumber(raw.globalRank),
      skills: raw.skills && typeof raw.skills === "object" && !Array.isArray(raw.skills)
        ? (raw.skills as Record<string, unknown>)
        : undefined,
      clearSkills: raw.clearSkills === true,
      firstPulledAt: optionalNumber(raw.firstPulledAt),
      lastPulledAt: optionalNumber(raw.lastPulledAt),
      serialMode: raw.serialMode === "mint" || raw.serialMode === "set" ? raw.serialMode : "keep",
      serial: optionalNumber(raw.serial),
      username: optionalString(raw.username),
      avatarUrl: optionalString(raw.avatarUrl),
      countryCode: optionalString(raw.countryCode),
      // Absent keeps the row's motif, explicit null clears it; anything else is
      // bounded by parseCardMotif before it reaches the column.
      motif: raw.motif === undefined ? undefined : raw.motif ?? null,
      overwriteIdentity: raw.overwriteIdentity === true,
    };
    const outcome = await grantAdminPackCard(writeDb, user, grant);
    if (!outcome.ok) {
      sendJson(req, res, ctx, 400, { error: outcome.error });
      return true;
    }
    logInfo("admin_pack_card_granted", {
      ownerUserId: user.userId,
      cardKey: outcome.result.cardKey,
      tier: grant.tier ?? "unrated",
      created: outcome.result.created,
      copies: outcome.result.card?.copies ?? 0,
    });
    sendJson(req, res, ctx, 200, { ok: true, ...outcome.result });
    return true;
  }

  if (url.pathname === "/api/admin/packs/collection/remove") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const user = await resolveTarget(req, res, ctx, body);
    if (!user) return true;
    const result = await removeAdminPackCard(writeDb, user.userId, body.cardKey, {
      dropSerial: body.dropSerial === true,
    });
    if (result.removed) {
      logInfo("admin_pack_card_removed", {
        ownerUserId: user.userId,
        cardKey: String(body.cardKey ?? ""),
        serialRemoved: result.serialRemoved,
      });
    }
    sendJson(req, res, ctx, result.removed ? 200 : 404, { ok: result.removed, ...result });
    return true;
  }

  sendJson(req, res, ctx, 404, { error: "not_found" });
  return true;
}
