import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  clearSignatureImages,
  disableUserSignature,
  enableUserSignature,
  getUserSignature,
  getSignaturePurgeTarget,
  listSignaturesForAdmin,
  normalizeSignatureTypes,
  normalizeTimeZone,
  resolveSignatureToken,
  rotateUserSignatureToken,
  setSignatureBlocked,
  setUserSignatureTimeZone,
} from "../../features/signatures.js";
import { logInfo } from "../../logger.js";
import type { HttpContext } from "../context.js";
import { isAdmin, isBridge, readBody } from "../request.js";
import { sendJson } from "../respond.js";

const SIGNATURE_PATHS = new Set([
  "/api/signature/self",
  "/api/signature/enable",
  "/api/signature/disable",
  "/api/signature/rotate",
  "/api/signature/resolve",
  "/api/signature/time-zone",
]);

/* Moderation. True-admin token, not the bridge: nothing here acts on behalf of
   the player whose row it touches, which is the whole distinction those two
   credentials exist to keep. */
const SIGNATURE_ADMIN_PATHS = new Set([
  "/api/admin/signatures/list",
  "/api/admin/signatures/block",
  "/api/admin/signatures/clear-images",
]);

async function handleSignatureAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  if (!isAdmin(req, ctx)) {
    sendJson(req, res, ctx, 401, { error: "unauthorized" });
    return true;
  }

  if (url.pathname === "/api/admin/signatures/list") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    sendJson(req, res, ctx, 200, {
      signatures: await listSignaturesForAdmin(ctx.db, {
        customOnly: url.searchParams.get("customOnly") === "1",
        limit: Number(url.searchParams.get("limit")) || undefined,
      }),
    });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = parseJson<{ userId?: unknown; blocked?: unknown }>((await readBody(req)) || "{}", {});
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
    return true;
  }
  const writeDb = ctx.serveWriteDb ?? ctx.db;

  /* Captured before the write. Clearing a picture moves the affected versions,
     so reading this afterwards would name the renders nobody has yet, and
     leave the ones actually sitting in caches untouched. */
  const purge = await getSignaturePurgeTarget(writeDb, userId);

  if (url.pathname === "/api/admin/signatures/clear-images") {
    const ok = await clearSignatureImages(writeDb, userId);
    if (ok) logInfo("signature_images_cleared", { userId, by: "admin" });
    sendJson(req, res, ctx, ok ? 200 : 404, { ok, purge: ok ? purge : null });
    return true;
  }

  // /api/admin/signatures/block
  const blocked = body.blocked !== false;
  const ok = await setSignatureBlocked(writeDb, userId, blocked);
  if (ok) logInfo("signature_blocked", { userId, blocked, by: "admin" });
  // Unblocking restores images rather than removing them, so there is nothing
  // to purge - and purging then would only cost a re-render.
  sendJson(req, res, ctx, ok ? 200 : 404, { ok, purge: ok && blocked ? purge : null });
  return true;
}

// Which keymodes a skill radar / dan render may be pinned to. Stored as a
// preference rather than carried in the image URL, so cache-key cardinality
// stays at (types x designs) per player instead of multiplying by keymode.
const ALLOWED_KEY_COUNTS = new Set([4, 6, 7]);

function readKeyCount(raw: unknown): number | null {
  const value = Number(raw);
  return ALLOWED_KEY_COUNTS.has(value) ? value : null;
}

/* The style map is stored opaquely: the frontend owns the option lists and
   normalizes both before sending and after reading, so re-implementing that
   allowlist here would be a second copy to keep in step for no gain. What this
   side does owe is a bound on what lands in the column, and a guarantee it is
   an object - the version hash walks it per type.

   undefined (the key absent) means "leave the stored style alone", which is
   what publishing a type sends. */
const MAX_STYLE_JSON = 4000;

function readStyleJson(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const encoded = JSON.stringify(raw);
  return encoded.length <= MAX_STYLE_JSON ? encoded : undefined;
}

export async function handleSignatureRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  if (SIGNATURE_ADMIN_PATHS.has(url.pathname)) {
    return await handleSignatureAdminRoutes(req, res, ctx, url);
  }
  if (!SIGNATURE_PATHS.has(url.pathname)) return false;

  // Bridge-token gated like the goals routes: the frontend server fn injects the
  // osu!-verified viewer id, so a player can only ever mint or revoke their own
  // signature. `resolve` is on the same footing on purpose - it is called by our
  // own render route, and leaving it public would turn it into a token oracle
  // that maps a pasted URL back to a user id for anyone who asks.
  if (!isBridge(req, ctx)) {
    sendJson(req, res, ctx, 401, { error: "unauthorized" });
    return true;
  }

  if (url.pathname === "/api/signature/resolve") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const token = (url.searchParams.get("token") ?? "").trim();
    if (!token) {
      sendJson(req, res, ctx, 400, { error: "invalid_token" });
      return true;
    }
    const resolved = await resolveSignatureToken(ctx.db, token);
    if (!resolved) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    sendJson(req, res, ctx, 200, resolved);
    return true;
  }

  if (url.pathname === "/api/signature/self") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    sendJson(req, res, ctx, 200, { signature: await getUserSignature(ctx.db, userId) });
    return true;
  }

  if (req.method !== "POST") {
    sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
    return true;
  }

  const body = parseJson<{
    userId?: unknown;
    types?: unknown;
    skillsKeyCount?: unknown;
    styles?: unknown;
    timeZone?: unknown;
  }>((await readBody(req)) || "{}", {});
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
    return true;
  }
  const writeDb = ctx.serveWriteDb ?? ctx.db;

  if (url.pathname === "/api/signature/enable") {
    const types = normalizeSignatureTypes(body.types);
    if (types.length === 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_types" });
      return true;
    }
    const signature = await enableUserSignature(
      writeDb,
      userId,
      types,
      readKeyCount(body.skillsKeyCount),
      readStyleJson(body.styles),
      // Absent leaves the stored zone alone; anything else is validated down to
      // a name Intl accepts, or to null.
      body.timeZone === undefined ? undefined : normalizeTimeZone(body.timeZone),
    );
    sendJson(req, res, ctx, 200, { ok: true, signature });
    return true;
  }

  /* The zone on its own. The page sends this on load when what the browser
     reports differs from the row, which is the only way a player who set their
     signature up before this existed ever gets a local date - they have no
     reason to touch a style again. Deliberately not part of `enable`: that
     turns a signature on, and a background sync must not. */
  if (url.pathname === "/api/signature/time-zone") {
    const signature = await setUserSignatureTimeZone(writeDb, userId, normalizeTimeZone(body.timeZone));
    sendJson(req, res, ctx, signature ? 200 : 404, { ok: Boolean(signature), signature });
    return true;
  }

  if (url.pathname === "/api/signature/disable") {
    const ok = await disableUserSignature(writeDb, userId);
    sendJson(req, res, ctx, ok ? 200 : 404, { ok });
    return true;
  }

  // /api/signature/rotate
  const rotated = await rotateUserSignatureToken(writeDb, userId);
  if (!rotated) {
    sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
    return true;
  }
  sendJson(req, res, ctx, 200, { ok: true, signature: rotated });
  return true;
}
