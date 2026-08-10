import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import { appendSkinScreenshot, attachSkinOsk, attachSkinPreview, createPendingSkin, deleteSkin, findPublishedSkinByOskSha256, finishSkin, finishSkinEdit, getSkin, getSkinByRef, getSkinForEdit, getSkinForUpload, listSimilarSkins, listSkins, moveSkinOskKey, parseSkinsListSort, privateSkinSecretMatches, recordSkinDownload, replaceSkinOsk, setSkinAccent, setSkinCover, setSkinScreenshotLabels, setSkinSpecialKeymodes, setSkinVisibility, SKIN_MAX_SCREENSHOTS, startSkinEdit, toSkinSummary, updateSkinDetails, upsertSkinKeymodePreview, type SkinCoverTarget, type SkinRow } from "../../features/skins.js";
import { clearUserReplaySkin, getUserReplaySkin, setUserReplaySkin, USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS } from "../../features/user-replay-skins.js";
import { errorContext, logInfo, logWarn } from "../../logger.js";
import { clientIp } from "../abuse-guard.js";
import { readCachedSkinImage } from "../../skins/image-cache.js";
import { drawPreviewPatterns } from "../../skins/preview-patterns.js";
import { copySkinObject, deleteSkinObjects, getSkinObject, isPrivateSkinKey, isSkinStorageConfigured, nextSkinOskRevision, nextSkinPreviewRevision, oskFilename, privateSkinKey, skinKeymodePreviewKey, skinOskKey, skinPreviewKey, skinScreenshotKey, uploadSkinObject } from "../../skins/r2.js";
import { getReplaySkinBundle, replaySkinBundleVersion } from "../../skins/replay-bundle.js";
import { sniffImage, validateOskBuffer } from "../../skins/validate-osk.js";
import { computeSkinVisualSignature } from "../../skins/visual-signature.js";
import type { HttpContext } from "../context.js";
import { isAdmin, readBody, readBodyBuffer } from "../request.js";
import { checkRate, sendCors, sendJson } from "../respond.js";

// The replay-skin settings payload caps at USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS,
// so the body read gets that plus headroom for the JSON envelope around it;
// the default 1MB limit would 413 a maximal payload before it could be judged.
const REPLAY_SKIN_BODY_LIMIT_BYTES = 1_100_000;

export async function handleSkinsRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/skins/list") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const scope = skinViewerScope(req, ctx, url);
    const includeHidden = url.searchParams.get("includeHidden") === "1" && scope.asAdmin;
    const keymode = Number(url.searchParams.get("k"));
    const page = Number(url.searchParams.get("page") ?? 0);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 24);
    // An admin list can carry hidden skins, and an owner-scoped one carries
    // that viewer's private skins, so neither may land in a shared cache.
    if (scope.tokened) res.setHeader("cache-control", "private, no-store");
    else res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    const variant = url.searchParams.get("variant");
    const owner = Number(url.searchParams.get("owner"));
    const list = await listSkins(ctx.db, {
      q: (url.searchParams.get("q") ?? "").slice(0, 80),
      keymode: Number.isInteger(keymode) && keymode >= 1 && keymode <= 10 ? keymode : null,
      // "special" is the 7K+1 filter (keymode 8 whose layout is really 7+1);
      // "regular" makes the plain keymode filter mean actual 8K.
      keymodeVariant: variant === "special" || variant === "regular" ? variant : null,
      page: Number.isFinite(page) ? page : 0,
      pageSize: Number.isFinite(pageSize) ? pageSize : 24,
      includeHidden,
      sort: parseSkinsListSort(url.searchParams.get("sort")),
      // One uploader's skins ("uploader: you" on the browse page). Anyone may
      // ask for anyone's: it only ever narrows what the visibility gate below
      // already allows this request to see.
      ownerUserId: Number.isInteger(owner) && owner > 0 ? owner : null,
      // Only an admin-token request carries a vouched-for viewer, so a browser
      // cannot ask for someone else's private shelf by guessing an id.
      privateOwnerUserId: scope.viewerUserId,
      onlyPrivate: url.searchParams.get("visibility") === "private",
      // The moderation shelf: every uploader's private skins, and only for a
      // request that proved it is a true admin.
      adminAllPrivate: scope.asAdmin && url.searchParams.get("allPrivate") === "1",
    });
    sendJson(req, res, ctx, 200, list);
    return true;
  }
  if (url.pathname === "/api/skins/get") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    // Accepts the slug from a pretty URL or a raw row id from a pre-slug link.
    const skin = id ? await getSkinByRef(ctx.db, id) : null;
    const scope = skinViewerScope(req, ctx, url);
    // Hidden is a moderation state: only an admin reads one back, its own
    // uploader included.
    if (!skin || (!scope.asAdmin && skin.status !== "published")) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    // A private skin has a page for exactly one person. Admins keep their read
    // (a skin nobody can report still has to be moderatable), everyone else
    // gets the same 404 a deleted skin gives.
    const isOwner = scope.viewerUserId != null && scope.viewerUserId === skin.ownerUserId;
    if (skin.visibility === "private" && !isOwner && !scope.asAdmin) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    if (scope.tokened) res.setHeader("cache-control", "private, no-store");
    else res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=300");
    sendJson(req, res, ctx, 200, { skin: toSkinSummary(skin, { asOwner: isOwner || scope.asAdmin }) });
    return true;
  }
  if (url.pathname === "/api/skins/similar") {
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const ref = url.searchParams.get("id") ?? "";
    const skin = ref ? await getSkinByRef(ctx.db, ref) : null;
    // Only a skin with a public page recommends others: a hidden or private
    // ref gets the same 404 /api/skins/get gives a stranger, which keeps this
    // endpoint tokenless and its responses shareable. The candidates are
    // public rows only either way.
    if (!skin || skin.status !== "published" || skin.visibility !== "public") {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    const limit = Number(url.searchParams.get("limit") ?? 6);
    // The keymode the viewer has open, so the answer is "what looks like the
    // playfield on screen" rather than "what looks like this skin somewhere in
    // its range". Part of the URL, so each keymode caches separately.
    const keys = Number(url.searchParams.get("keys"));
    // Longer-lived than the list: a new upload joining someone's strip five
    // minutes late is invisible, and every skin page hits this once per view.
    res.setHeader("cache-control", "public, max-age=300, stale-while-revalidate=600");
    sendJson(req, res, ctx, 200, {
      skins: await listSimilarSkins(
        ctx.db,
        skin,
        Number.isInteger(limit) ? limit : 6,
        Number.isInteger(keys) && keys >= 1 && keys <= 10 ? keys : null,
      ),
    });
    return true;
  }
  if (url.pathname === "/api/skins/preview-patterns") {
    // The chart snippets a skin preview can be rendered from: cut out of the
    // .osu files already cached here, so an uploader picks a real pattern from
    // a real map instead of the one synthetic layout every skin used to share.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    // A draw is a handful of gunzips and parses, so it does not ride the plain
    // public budget.
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const keys = Number(url.searchParams.get("keys"));
    if (!Number.isInteger(keys) || keys < 1 || keys > 18) {
      sendJson(req, res, ctx, 400, { error: "invalid_keys" });
      return true;
    }
    const count = Number(url.searchParams.get("count") ?? 8);
    const exclude = (url.searchParams.get("exclude") ?? "")
      .split(",")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 64);
    // Every draw is a different set of charts, so caching one would hand the
    // next uploader the previous one's shuffle.
    res.setHeader("cache-control", "no-store");
    sendJson(req, res, ctx, 200, {
      patterns: await drawPreviewPatterns(ctx.db, {
        keys,
        count: Number.isFinite(count) ? count : 8,
        exclude,
      }),
    });
    return true;
  }
  if (url.pathname === "/api/skins/download") {
    // Redirect-through download so each grab counts - once per visitor per
    // skin per day, keyed on IP - then the R2 public URL serves the actual
    // bytes with ContentDisposition: attachment.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    const target = id ? await recordSkinDownload(ctx.serveWriteDb ?? ctx.db, id, clientIp(req, ctx.config)) : null;
    if (!target) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    sendCors(req, res, ctx);
    res.statusCode = 302;
    res.setHeader("location", target);
    res.setHeader("cache-control", "no-store");
    res.end();
    return true;
  }
  if (url.pathname.startsWith("/api/skins/file/")) {
    // Streams a skin's stored objects (.osk, preview, screenshots) from R2
    // when no public bucket URL is configured. Only keys recorded on the
    // skin row are reachable, so the shared bucket stays private.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    // Rate limiting happened at the gate, on the skin-files window
    // (SKIN_FILES_RATE_SUFFIX) — no second charge here.
    const parts = url.pathname.split("/").filter(Boolean);
    const id = decodeURIComponent(parts[3] ?? "");
    const filename = decodeURIComponent(parts[4] ?? "");
    const skin = id && filename ? await getSkin(ctx.db, id) : null;
    // A private skin's objects answer only to the ?t= capability its owner-
    // scoped reads carry. Nothing else about the request identifies anyone:
    // these URLs are what an <img> and the asset explorer fetch straight from
    // the browser, with no cookie and no admin token to check.
    const unlocked = !skin || privateSkinSecretMatches(skin, url.searchParams.get("t"));
    const visible = skin && unlocked && (skin.status === "published" || isAdmin(req, ctx));
    const key = visible
      ? [skin.oskKey, skin.previewKey, ...skin.previews.map((preview) => preview.key), ...skin.screenshots.map((shot) => shot.key)]
          .find((candidate): candidate is string => Boolean(candidate && candidate.split("/").pop() === filename))
      : undefined;
    // Private objects are cached by the one browser allowed to hold them, never
    // by a shared cache that would then serve them without the capability.
    const cacheControl = skin?.visibility === "private"
      ? "private, max-age=86400"
      : "public, max-age=86400, s-maxage=31536000, immutable";
    if (key && !key.toLowerCase().endsWith(".osk")) {
      // Images (previews, screenshots) serve from the in-memory tier: their
      // keys are immutable and the row check above already authorized this
      // request, so a cached buffer is as safe as the R2 read it replaces and
      // saves the grid a >1s round trip per card.
      const image = await readCachedSkinImage(key, () => getSkinObject(ctx.config, key));
      if (!image) {
        sendJson(req, res, ctx, 404, { error: "not_found" });
        return true;
      }
      sendCors(req, res, ctx);
      res.statusCode = 200;
      res.setHeader("content-type", image.contentType);
      res.setHeader("content-length", String(image.buffer.length));
      if (image.contentDisposition) res.setHeader("content-disposition", image.contentDisposition);
      res.setHeader("cache-control", cacheControl);
      res.end(image.buffer);
      return true;
    }
    const object = key ? await getSkinObject(ctx.config, key) : null;
    if (!object) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    sendCors(req, res, ctx);
    res.statusCode = 200;
    res.setHeader("content-type", object.contentType);
    if (object.contentLength != null) res.setHeader("content-length", String(object.contentLength));
    if (object.contentDisposition) res.setHeader("content-disposition", object.contentDisposition);
    res.setHeader("cache-control", cacheControl);
    // pipe() drops the pipeline when the response dies but leaves the R2 stream
    // open, so a cancelled .osk download (a reload, or one impatient
    // double-click) keeps its socket checked out of the S3 pool for good. Fifty
    // of those and every later R2 read in this process queues behind corpses.
    res.on("close", () => object.body.destroy());
    object.body.on("error", () => res.destroy());
    object.body.pipe(res);
    return true;
  }
  if (url.pathname === "/api/replay-skin") {
    // Which community skin (and settings) viewers see on this player's
    // replays. Public by osu! user id: anyone watching a replay resolves it.
    // "No choice", "hidden skin", and "deleted skin" all read back as the same
    // null so a moderation state never leaks through here - the viewer just
    // falls back to its default skin.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicApi")) return true;
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user" });
      return true;
    }
    // Nothing viewer-specific in the response, but the owner changes this
    // interactively and expects a refreshed replay to pick it up immediately.
    // It may be stored by shared caches, but must be revalidated before use.
    res.setHeader("cache-control", "public, no-cache");
    const row = await getUserReplaySkin(ctx.db, userId);
    const skin = row ? await getSkin(ctx.db, row.skinId) : null;
    // A private skin fronts its owner's replays and nobody else's. Someone who
    // picked it while it was public keeps the stored row, but it reads back as
    // "no skin" from the moment it turned private - otherwise turning a skin
    // private would leave its art flowing through a stranger's replays.
    if (!row || !skin || skin.status !== "published"
      || (skin.visibility === "private" && skin.ownerUserId !== userId)) {
      sendJson(req, res, ctx, 200, { replaySkin: null });
      return true;
    }
    // A private skin still fronts its owner's replays; what travels is the
    // redacted summary (no .osk, no page to open) plus the pointer to the
    // filtered bundle the viewer draws from instead.
    const isPrivate = skin.visibility === "private";
    sendJson(req, res, ctx, 200, {
      replaySkin: {
        skin: toSkinSummary(skin),
        settings: parseJson<unknown>(row.payloadJson, null),
        updatedAt: row.updatedAt,
        ...(isPrivate
          ? {
              private: true,
              bundleVersion: replaySkinBundleVersion({
                oskKey: skin.oskKey,
                oskSha256: skin.oskSha256,
                settingsUpdatedAt: row.updatedAt,
              }),
            }
          : null),
      },
    });
    return true;
  }
  if (url.pathname === "/api/replay-skin/bundle") {
    // The only way a private skin's art reaches anyone but its owner: a zip of
    // just the assets this player's stored settings draw, built from the .osk
    // server-side. Public by osu! user id like /api/replay-skin itself, since
    // any visitor watching the replay needs it.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const userId = Number(url.searchParams.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user" });
      return true;
    }
    const row = await getUserReplaySkin(ctx.db, userId);
    const skin = row ? await getSkin(ctx.db, row.skinId) : null;
    // Public skins keep serving their whole .osk through /api/skins/file; only
    // a private one has anything to filter, and only for the player who owns
    // it (same rule as the pointer endpoint above).
    if (!row || !skin || skin.status !== "published" || skin.visibility !== "private"
      || skin.ownerUserId !== userId || !skin.oskKey) {
      sendJson(req, res, ctx, 404, { error: "not_found" });
      return true;
    }
    const version = replaySkinBundleVersion({
      oskKey: skin.oskKey,
      oskSha256: skin.oskSha256,
      settingsUpdatedAt: row.updatedAt,
    });
    const bundle = await getReplaySkinBundle(ctx.config, {
      skinId: skin.id,
      oskKey: skin.oskKey,
      version,
      payload: parseJson<unknown>(row.payloadJson, null),
      oskMaxBytes: ctx.config.skinOskMaxBytes,
    });
    if (!bundle) {
      sendJson(req, res, ctx, 503, { error: "bundle_unavailable" });
      return true;
    }
    sendCors(req, res, ctx);
    res.statusCode = 200;
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-length", String(bundle.length));
    // Inline: this is art a page draws, not a file to save. The version is in
    // the URL the client asks for, so a stale copy can only be a stale URL.
    res.setHeader("content-disposition", "inline");
    res.setHeader("cache-control", "public, max-age=86400");
    res.end(bundle);
    return true;
  }
  if (url.pathname === "/api/replay-skin/set" || url.pathname === "/api/replay-skin/clear") {
    // Same trust contract as the goals endpoints: admin-token gated and called
    // server-to-server, with the frontend server fn injecting the osu!-verified
    // viewer id, so a user only ever points their own replays at a skin.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; skinId?: unknown; settings?: unknown }>(
      (await readBodyBuffer(req, REPLAY_SKIN_BODY_LIMIT_BYTES)).toString("utf8") || "{}",
      {},
    );
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user" });
      return true;
    }
    if (url.pathname === "/api/replay-skin/clear") {
      await clearUserReplaySkin(ctx.serveWriteDb ?? ctx.db, userId);
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    // A skin id longer than any real one can never resolve, so it fails the
    // same way an unknown id does instead of earning its own error shape.
    const skinId = typeof body.skinId === "string" ? body.skinId : "";
    const skin = skinId && skinId.length <= 64 ? await getSkin(ctx.db, skinId) : null;
    // Someone else's private skin is not a skin you can point your replays at:
    // that would publish its art through your own replay bundle.
    if (!skin || skin.status !== "published" || (skin.visibility === "private" && skin.ownerUserId !== userId)) {
      sendJson(req, res, ctx, 404, { error: "skin_not_found" });
      return true;
    }
    const payloadJson = JSON.stringify(body.settings ?? {});
    if (payloadJson.length > USER_REPLAY_SKIN_PAYLOAD_MAX_CHARS) {
      sendJson(req, res, ctx, 413, { error: "payload_too_large" });
      return true;
    }
    // Settings must reference assets by path inside the .osk; a payload that
    // smuggles the images or sounds themselves would turn this table into a
    // second, unmoderated skin store.
    if (payloadJson.includes("data:image/") || payloadJson.includes("data:audio/")) {
      sendJson(req, res, ctx, 400, { error: "embedded_data_url" });
      return true;
    }
    await setUserReplaySkin(ctx.serveWriteDb ?? ctx.db, userId, skin.id, payloadJson);
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/skins/start") {
    // Admin-token gated: the frontend server fn forwards the osu!-verified viewer id with the
    // shared admin token (the goals/pack-wallet bridge), so uploads are always attributed to
    // the logged-in user. The browser then talks to /api/skins/upload with the minted ticket.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!isSkinStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "skin_storage_not_configured" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; username?: unknown; name?: unknown; author?: unknown; description?: unknown; oskSha256?: unknown; bypassLimits?: unknown; visibility?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_user_id" });
      return true;
    }
    const oskSha256 = typeof body.oskSha256 === "string" && /^[0-9a-f]{64}$/i.test(body.oskSha256)
      ? body.oskSha256.toLowerCase()
      : null;
    const result = await createPendingSkin(ctx.serveWriteDb ?? ctx.db, {
      ownerUserId: userId,
      ownerUsername: typeof body.username === "string" ? body.username : "",
      name: typeof body.name === "string" ? body.name : "",
      author: typeof body.author === "string" ? body.author : null,
      description: typeof body.description === "string" ? body.description : null,
      oskSha256,
      // Only the admin bulk uploader asks for this, through a server fn that
      // verifies a true admin before forwarding it on this token-gated route.
      bypassLimits: body.bypassLimits === true,
      visibility: body.visibility === "private" ? "private" : "public",
    });
    if (!result.ok) {
      if (result.error === "duplicate") {
        logInfo("skin_upload_duplicate", { ownerUserId: userId, stage: "start", existingId: result.duplicate.id });
        sendJson(req, res, ctx, 409, { ok: false, error: "duplicate", duplicate: result.duplicate });
        return true;
      }
      sendJson(req, res, ctx, result.error === "invalid_name" ? 400 : 429, { ok: false, error: result.error });
      return true;
    }
    logInfo("skin_upload_start", { id: result.id, ownerUserId: userId });
    sendJson(req, res, ctx, 200, { ok: true, id: result.id, token: result.token, expiresAt: result.expiresAt });
    return true;
  }
  if (url.pathname === "/api/skins/upload" || url.pathname === "/api/skins/finish" || url.pathname === "/api/skins/edit-finish") {
    // Ticket-authenticated: the token minted by /api/skins/start is the credential, so the
    // browser can POST the 65MB .osk directly here instead of transiting the frontend server.
    // /api/skins/edit-start mints the same kind of ticket against a published skin, which
    // only unlocks preview re-uploads (see the part guard below).
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "skinUpload")) return true;
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    if (!isSkinStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "skin_storage_not_configured" });
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname === "/api/skins/finish") {
      const result = await finishSkin(ctx.serveWriteDb ?? ctx.db, id, token);
      if (!result.ok) {
        const status = result.error === "not_found" ? 403 : 400;
        sendJson(req, res, ctx, status, { ok: false, error: result.error === "not_found" ? "invalid_ticket" : result.error });
        return true;
      }
      logInfo("skin_upload_finish", { id, ownerUserId: result.skin.ownerUserId, keymodes: result.skin.keymodes });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    if (url.pathname === "/api/skins/edit-finish") {
      const result = await finishSkinEdit(ctx.serveWriteDb ?? ctx.db, id, token);
      if (!result.ok) {
        sendJson(req, res, ctx, 403, { ok: false, error: "invalid_ticket" });
        return true;
      }
      // Previews for keymodes a replacement .osk no longer ships: the row has
      // already let go of them, so the objects go too.
      if (result.staleKeys.length > 0) {
        await deleteSkinObjects(ctx.config, result.staleKeys).catch((error) => {
          logWarn("skin_preview_stale_cleanup_failed", { id, ...errorContext(error) });
        });
      }
      logInfo("skin_previews_edited", { id, ownerUserId: result.skin.ownerUserId, droppedPreviews: result.staleKeys.length });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    const pending = id && token ? await getSkinForUpload(ctx.db, id, token) : null;
    // A published skin whose owner is re-rendering its previews or shipping a
    // newer .osk. The row keeps its status, so nothing else about it can be
    // touched through this ticket.
    const editing = pending ? null : (id && token ? await getSkinForEdit(ctx.db, id, token) : null);
    const skin = pending ?? editing;
    if (!skin) {
      sendJson(req, res, ctx, 403, { ok: false, error: "invalid_ticket" });
      return true;
    }
    // Private skins write every object under a folder named by their secret, so
    // the bucket's public base URL cannot be derived from the skin id alone.
    const storageKey = (key: string) => (
      skin.visibility === "private" && skin.privateSecret ? privateSkinKey(key, skin.privateSecret) : key
    );
    const part = url.searchParams.get("part") ?? "";
    if (editing && !(part === "preview" || (part === "osk" && editing.tokenScope === "replace"))) {
      // A previews ticket swaps renders and nothing else; a replace ticket also
      // takes the .osk. Screenshots of a published skin stay as uploaded either
      // way.
      sendJson(req, res, ctx, 400, { ok: false, error: "invalid_part" });
      return true;
    }
    if (part === "osk") {
      const buffer = await readBodyBuffer(req, ctx.config.skinOskMaxBytes);
      const validation = await validateOskBuffer(buffer);
      if (!validation.ok) {
        sendJson(req, res, ctx, 400, { ok: false, error: "invalid_osk", reason: validation.error });
        return true;
      }
      // Server-side duplicate check on the hash we computed ourselves: the one
      // at /api/skins/start trusts a client-sent hash, and the file can differ
      // from the one that minted the ticket. Runs before the R2 write, so a
      // rejected duplicate leaves no object behind. Private uploads skip it for
      // the same reason createPendingSkin does: a personal copy of a catalog
      // skin is the point, and the answer would name a stranger's skin.
      const duplicate = skin.visibility === "private"
        ? null
        : await findPublishedSkinByOskSha256(ctx.db, validation.info.sha256, skin.id);
      if (duplicate) {
        logInfo("skin_upload_duplicate", { ownerUserId: skin.ownerUserId, stage: "osk", existingId: duplicate.id });
        sendJson(req, res, ctx, 409, { ok: false, error: "duplicate", duplicate });
        return true;
      }
      // What the notes look like, for the similar-skins scoring. Best effort:
      // an archive with no digestible note art just leaves the column null and
      // scoring falls back to the sampled accent.
      const visual = await computeSkinVisualSignature(buffer).catch(() => null);
      if (editing) {
        // An update lands on a fresh key (the published object is cached
        // immutably) but keeps the skin's own download filename. The old build
        // goes once the row points at the new one.
        const key = storageKey(skinOskKey(skin.id, skin.name, nextSkinOskRevision(skin.oskKey)));
        const uploaded = await uploadSkinObject(ctx.config, key, buffer, "application/octet-stream", "attachment", oskFilename(skin.name));
        await replaceSkinOsk(ctx.serveWriteDb ?? ctx.db, skin, {
          key,
          url: uploaded.url,
          sizeBytes: uploaded.sizeBytes,
          sha256: validation.info.sha256,
          keymodes: validation.info.keymodes,
          specialKeymodes: validation.info.specialKeymodes,
          iniAuthor: validation.info.author,
          visual,
        });
        if (skin.oskKey && skin.oskKey !== key) {
          await deleteSkinObjects(ctx.config, [skin.oskKey]).catch((error) => {
            logWarn("skin_osk_stale_cleanup_failed", { id: skin.id, ...errorContext(error) });
          });
        }
        logInfo("skin_osk_replaced", { id: skin.id, ownerUserId: skin.ownerUserId, sizeBytes: uploaded.sizeBytes, keymodes: validation.info.keymodes });
        sendJson(req, res, ctx, 200, { ok: true, keymodes: validation.info.keymodes });
        return true;
      }
      const key = storageKey(skinOskKey(skin.id, skin.name));
      const uploaded = await uploadSkinObject(ctx.config, key, buffer, "application/octet-stream", "attachment");
      await attachSkinOsk(ctx.serveWriteDb ?? ctx.db, skin, {
        key,
        url: uploaded.url,
        sizeBytes: uploaded.sizeBytes,
        sha256: validation.info.sha256,
        keymodes: validation.info.keymodes,
        specialKeymodes: validation.info.specialKeymodes,
        accentColor: validation.info.accentColor,
        iniAuthor: validation.info.author,
        visual,
      });
      logInfo("skin_upload_osk", { id: skin.id, ownerUserId: skin.ownerUserId, sizeBytes: uploaded.sizeBytes, keymodes: validation.info.keymodes });
      sendJson(req, res, ctx, 200, { ok: true, keymodes: validation.info.keymodes });
      return true;
    }
    if (part === "preview" || part === "screenshot") {
      if (part === "screenshot" && skin.screenshots.length >= SKIN_MAX_SCREENSHOTS) {
        sendJson(req, res, ctx, 400, { ok: false, error: "screenshot_limit" });
        return true;
      }
      const buffer = await readBodyBuffer(req, ctx.config.skinImageMaxBytes);
      const sniffed = sniffImage(buffer);
      if (!sniffed) {
        sendJson(req, res, ctx, 400, { ok: false, error: "invalid_image" });
        return true;
      }
      const width = parseImageDimension(url.searchParams.get("w"));
      const height = parseImageDimension(url.searchParams.get("h"));
      if (part === "preview") {
        // The renderer samples the accent from the note art itself, which is
        // more faithful than the skin.ini colours the .osk validation reads.
        const accent = url.searchParams.get("accent");
        if (accent && /^#[0-9a-f]{6}$/i.test(accent)) await setSkinAccent(ctx.serveWriteDb ?? ctx.db, skin.id, accent);
        // With keys=N the render is stored as that keymode's preview (one per
        // keymode, replace on repeat); cover=1 also makes it the card cover.
        // Without keys it degrades to the single-cover flow.
        const keysParam = Math.round(Number(url.searchParams.get("keys")));
        const keys = Number.isInteger(keysParam) && keysParam >= 1 && keysParam <= 10 ? keysParam : null;
        if (keys != null) {
          // Preview objects are cached immutably, so a re-render has to land on
          // a new key; the displaced object is deleted once the row points at
          // the fresh one.
          const previous = skin.previews.find((preview) => preview.keys === keys) ?? null;
          const key = previous
            ? storageKey(skinKeymodePreviewKey(skin.id, keys, sniffed.ext, nextSkinPreviewRevision(previous.key)))
            : storageKey(skinKeymodePreviewKey(skin.id, keys, sniffed.ext));
          const uploaded = await uploadSkinObject(ctx.config, key, buffer, sniffed.mime, "inline");
          const isCover = url.searchParams.get("cover") === "1";
          const upserted = await upsertSkinKeymodePreview(
            ctx.serveWriteDb ?? ctx.db,
            skin.id,
            { keys, key, url: uploaded.url, width, height },
            isCover,
          );
          if (!upserted.ok) {
            await deleteSkinObjects(ctx.config, [key]).catch(() => {});
            sendJson(req, res, ctx, 400, { ok: false, error: upserted.error });
            return true;
          }
          // What the row no longer points at: the displaced render, plus the
          // standalone cover object of a pre-keymode skin whose card this
          // render just took over. A screenshot the cover is moving off is not
          // one of those - the row still lists it in the gallery.
          const stillReferenced = new Set([
            ...skin.previews.filter((preview) => preview.keys !== keys).map((preview) => preview.key),
            ...skin.screenshots.map((shot) => shot.key),
          ]);
          stillReferenced.add(key);
          // The cover columns follow a re-render of the keymode they point at,
          // so that key counts as referenced only while it stays the cover.
          if (!isCover && skin.previewKey && skin.previewKey !== upserted.replaced?.key) {
            stillReferenced.add(skin.previewKey);
          }
          const staleKeys = [upserted.replaced?.key, isCover ? skin.previewKey : null]
            .filter((candidate): candidate is string => !!candidate && !stillReferenced.has(candidate));
          if (staleKeys.length > 0) {
            await deleteSkinObjects(ctx.config, [...new Set(staleKeys)]).catch((error) => {
              logWarn("skin_preview_stale_cleanup_failed", { id: skin.id, keys, ...errorContext(error) });
            });
          }
        } else {
          const key = storageKey(skinPreviewKey(skin.id, sniffed.ext));
          const uploaded = await uploadSkinObject(ctx.config, key, buffer, sniffed.mime, "inline");
          await attachSkinPreview(ctx.serveWriteDb ?? ctx.db, skin.id, { key, url: uploaded.url, width, height });
        }
      } else {
        const key = storageKey(skinScreenshotKey(skin.id, skin.screenshots.length, sniffed.ext));
        const uploaded = await uploadSkinObject(ctx.config, key, buffer, sniffed.mime, "inline");
        // What the uploader called this shot, and whether they picked it over
        // the rendered playfields as the card cover.
        const label = url.searchParams.get("label");
        const appended = await appendSkinScreenshot(ctx.serveWriteDb ?? ctx.db, skin.id, { key, url: uploaded.url, width, height, label });
        if (!appended.ok) {
          await deleteSkinObjects(ctx.config, [key]).catch(() => {});
          sendJson(req, res, ctx, 400, { ok: false, error: appended.error });
          return true;
        }
        if (url.searchParams.get("cover") === "1") {
          await attachSkinPreview(ctx.serveWriteDb ?? ctx.db, skin.id, { key, url: uploaded.url, width, height });
          // Only a standalone cover object is orphaned by this: the keymode
          // renders and the other screenshots are all still listed on the row.
          const stillReferenced = new Set([
            ...skin.previews.map((preview) => preview.key),
            ...skin.screenshots.map((shot) => shot.key),
            key,
          ]);
          if (skin.previewKey && !stillReferenced.has(skin.previewKey)) {
            await deleteSkinObjects(ctx.config, [skin.previewKey]).catch((error) => {
              logWarn("skin_preview_stale_cleanup_failed", { id: skin.id, ...errorContext(error) });
            });
          }
        }
      }
      sendJson(req, res, ctx, 200, { ok: true });
      return true;
    }
    sendJson(req, res, ctx, 400, { ok: false, error: "invalid_part" });
    return true;
  }
  if (url.pathname === "/api/skins/edit-start" || url.pathname === "/api/skins/cover" || url.pathname === "/api/skins/details" || url.pathname === "/api/skins/visibility" || url.pathname === "/api/skins/special-keymodes" || url.pathname === "/api/skins/screenshot-labels") {
    // Admin-token gated like /api/skins/delete: the frontend server fn forwards the
    // osu!-verified viewer id, and the ownership check below keeps a user off anyone
    // else's skin. asAdmin is set only by the server fn that verified a true admin;
    // asKeymodeModerator only by the special-keymodes server fn after matching the
    // viewer against its hardcoded trusted-corrector list, and no other action
    // honours it.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (url.pathname === "/api/skins/edit-start" && !isSkinStorageConfigured(ctx.config)) {
      sendJson(req, res, ctx, 503, { error: "skin_storage_not_configured" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; id?: unknown; keys?: unknown; screenshot?: unknown; labels?: unknown; name?: unknown; description?: unknown; asAdmin?: unknown; asKeymodeModerator?: unknown; scope?: unknown; visibility?: unknown; specialKeymodes?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    const id = typeof body.id === "string" ? body.id : "";
    if (!Number.isInteger(userId) || userId <= 0 || !id) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const ownerUserId = body.asAdmin === true ? null : userId;
    if (url.pathname === "/api/skins/details") {
      // A missing description is "leave it be", so a caller that only means to
      // retitle never has to resend the blurb.
      const result = await updateSkinDetails(
        ctx.serveWriteDb ?? ctx.db,
        id,
        {
          name: typeof body.name === "string" ? body.name : "",
          description: typeof body.description === "string" ? body.description : undefined,
        },
        ownerUserId,
      );
      if (!result.ok) {
        const status = result.error === "forbidden" ? 403 : result.error === "invalid_name" ? 400 : 404;
        sendJson(req, res, ctx, status, { ok: false, error: result.error });
        return true;
      }
      logInfo("skin_details_updated", { id, by: ownerUserId == null ? "admin" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    if (url.pathname === "/api/skins/visibility") {
      const visibility = body.visibility === "private" ? "private" : "public";
      const result = await setSkinVisibility(ctx.serveWriteDb ?? ctx.db, id, visibility, ownerUserId);
      if (!result.ok) {
        sendJson(req, res, ctx, result.error === "forbidden" ? 403 : 404, { ok: false, error: result.error });
        return true;
      }
      const moved = result.changed ? await moveSkinOskForVisibility(ctx, result.skin) : result.skin;
      logInfo("skin_visibility_changed", { id, visibility, by: ownerUserId == null ? "admin" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: toSkinSummary(moved, { asOwner: true }) });
      return true;
    }
    if (url.pathname === "/api/skins/special-keymodes") {
      // The owner's word on which keymodes are really (N-1)+1; the values must
      // be keymodes the skin ships, which the feature checks against the row.
      const specialKeymodes = Array.isArray(body.specialKeymodes)
        ? body.specialKeymodes.map((entry) => Math.round(Number(entry)))
        : null;
      if (!specialKeymodes || specialKeymodes.length > 10 || specialKeymodes.some((keys) => !Number.isInteger(keys) || keys < 1 || keys > 10)) {
        sendJson(req, res, ctx, 400, { error: "invalid_request" });
        return true;
      }
      const keymodeModerator = ownerUserId != null && body.asKeymodeModerator === true;
      const result = await setSkinSpecialKeymodes(
        ctx.serveWriteDb ?? ctx.db,
        id,
        specialKeymodes,
        keymodeModerator ? null : ownerUserId,
        { keymodeModerator },
      );
      if (!result.ok) {
        const status = result.error === "forbidden" ? 403 : result.error === "invalid_keymodes" ? 400 : 404;
        sendJson(req, res, ctx, status, { ok: false, error: result.error });
        return true;
      }
      logInfo("skin_special_keymodes_changed", { id, specialKeymodes, by: ownerUserId == null ? "admin" : keymodeModerator ? "keymode_moderator" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    if (url.pathname === "/api/skins/cover") {
      // Either a keymode whose render fronts the card, or the position of one
      // of the uploader's own screenshots.
      const screenshot = Math.round(Number(body.screenshot));
      const keys = Math.round(Number(body.keys));
      const target: SkinCoverTarget | null = body.screenshot != null
        ? (Number.isInteger(screenshot) && screenshot >= 0 && screenshot < SKIN_MAX_SCREENSHOTS
          ? { kind: "screenshot", index: screenshot }
          : null)
        : (Number.isInteger(keys) && keys >= 1 && keys <= 10 ? { kind: "keymode", keys } : null);
      if (!target) {
        sendJson(req, res, ctx, 400, { error: "invalid_request" });
        return true;
      }
      const result = await setSkinCover(ctx.serveWriteDb ?? ctx.db, id, target, ownerUserId);
      if (!result.ok) {
        sendJson(req, res, ctx, result.error === "forbidden" ? 403 : 404, { ok: false, error: result.error });
        return true;
      }
      // The pre-keymode standalone cover the card just left, which nothing on
      // the row points at any more.
      if (result.staleKey) {
        await deleteSkinObjects(ctx.config, [result.staleKey]).catch((error) => {
          logWarn("skin_preview_stale_cleanup_failed", { id, ...errorContext(error) });
        });
      }
      logInfo("skin_cover_changed", { id, ...target, by: ownerUserId == null ? "admin" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    if (url.pathname === "/api/skins/screenshot-labels") {
      // Positional: entry N renames screenshot N, an empty one puts it back to
      // being numbered on the page.
      const labels = Array.isArray(body.labels)
        ? body.labels.map((entry) => (typeof entry === "string" ? entry : ""))
        : null;
      if (!labels || labels.length > SKIN_MAX_SCREENSHOTS) {
        sendJson(req, res, ctx, 400, { error: "invalid_request" });
        return true;
      }
      const result = await setSkinScreenshotLabels(ctx.serveWriteDb ?? ctx.db, id, labels, ownerUserId);
      if (!result.ok) {
        sendJson(req, res, ctx, result.error === "forbidden" ? 403 : 404, { ok: false, error: result.error });
        return true;
      }
      logInfo("skin_screenshot_labels_changed", { id, count: labels.length, by: ownerUserId == null ? "admin" : "owner" });
      sendJson(req, res, ctx, 200, { ok: true, skin: result.skin });
      return true;
    }
    // "replace" also unlocks a new .osk on the ticket, which is how an
    // uploader ships an updated build of a skin that is already published.
    const scope = body.scope === "replace" ? "replace" : "previews";
    const started = await startSkinEdit(ctx.serveWriteDb ?? ctx.db, id, ownerUserId, scope);
    if (!started.ok) {
      sendJson(req, res, ctx, started.error === "forbidden" ? 403 : 404, { ok: false, error: started.error });
      return true;
    }
    sendJson(req, res, ctx, 200, { ok: true, id: started.id, token: started.token, expiresAt: started.expiresAt, scope: started.scope });
    return true;
  }
  if (url.pathname === "/api/skins/delete") {
    // Admin-token gated owner delete: the frontend server fn forwards the osu!-verified viewer
    // id, and the ownership check below keeps a user from deleting anyone else's skin.
    if (!isAdmin(req, ctx)) {
      sendJson(req, res, ctx, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const body = parseJson<{ userId?: unknown; id?: unknown }>((await readBody(req)) || "{}", {});
    const userId = Number(body.userId);
    const id = typeof body.id === "string" ? body.id : "";
    if (!Number.isInteger(userId) || userId <= 0 || !id) {
      sendJson(req, res, ctx, 400, { error: "invalid_request" });
      return true;
    }
    const skin = await getSkin(ctx.db, id);
    if (!skin || skin.ownerUserId !== userId) {
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }
    const deleted = await deleteSkin(ctx.serveWriteDb ?? ctx.db, id);
    if (deleted) {
      await deleteSkinObjects(ctx.config, deleted.keys).catch((error) => {
        logWarn("skin_delete_r2_failed", { id, ...errorContext(error) });
      });
    }
    logInfo("skin_deleted", { id, ownerUserId: userId, by: "owner" });
    sendJson(req, res, ctx, 200, { ok: true });
    return true;
  }
  return false;
}

function parseImageDimension(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 8192 ? parsed : null;
}

// Moves a skin's .osk to the key its new visibility calls for, in both
// directions.
//
// Going private, the file has to leave the key anyone could already have: the
// bucket has a public base URL and the row's own osk_url pointed straight at
// it. Going public it moves back out of the secret folder, so the download
// takes the CDN again instead of streaming 65MB through this process for the
// rest of the skin's life. The return trip lands on a fresh revision rather
// than the original key, which an edge cache may have a 404 stored against
// from the private spell.
//
// Only the .osk moves. The preview and screenshot objects keep the keys they
// were written under: a preview shows no more than watching a replay does, the
// streaming endpoint serves them either way (it is the only mode when no
// public bucket is configured at all), and re-keying a dozen images per toggle
// buys nothing for it.
//
// A copy that fails leaves the row on the old key. That is the safe direction
// in both cases - the row's visibility has already changed, so the gate in
// front of the bytes is already right - so it is logged, not rolled back.
async function moveSkinOskForVisibility(ctx: HttpContext, skin: SkinRow): Promise<SkinRow> {
  if (!skin.oskKey) return skin;
  const nextKey = skin.visibility === "private"
    ? (skin.privateSecret ? privateSkinKey(skin.oskKey, skin.privateSecret) : skin.oskKey)
    : (isPrivateSkinKey(skin.oskKey)
      ? skinOskKey(skin.id, skin.name, nextSkinOskRevision(skin.oskKey))
      : skin.oskKey);
  if (nextKey === skin.oskKey) return skin;
  // Local development runs against the production bucket (there is only one,
  // and the local DB is usually a snapshot of the live one), so a toggle here
  // would copy a real skin's file and delete the original out from under the
  // row production is still reading. The visibility flip itself is local and
  // harmless; only the storage move is held back.
  if (ctx.config.nodeEnv !== "production") {
    logWarn("skin_osk_move_skipped_outside_production", { id: skin.id, visibility: skin.visibility });
    return skin;
  }
  const copied = await copySkinObject(
    ctx.config,
    skin.oskKey,
    nextKey,
    "application/octet-stream",
    oskFilename(skin.name),
  ).catch(() => null);
  if (!copied) {
    logWarn("skin_osk_visibility_move_failed", { id: skin.id, visibility: skin.visibility });
    return skin;
  }
  await moveSkinOskKey(ctx.serveWriteDb ?? ctx.db, skin.id, { key: nextKey, url: copied.url });
  await deleteSkinObjects(ctx.config, [skin.oskKey]).catch((error) => {
    logWarn("skin_osk_visibility_cleanup_failed", { id: skin.id, ...errorContext(error) });
  });
  return { ...skin, oskKey: nextKey, oskUrl: copied.url };
}

// Who is asking for skin data, for the endpoints that can hand back hidden
// skins. Only a true admin reads a hidden row, so the request has to carry an
// identity the frontend server fn vouched for with the admin token (the goals
// bridge).
//
// A tokened request with no viewer attached is the admin dashboard calling
// server to server, which keeps the full view it has always had.
function skinViewerScope(
  req: IncomingMessage,
  ctx: HttpContext,
  url: URL,
): { tokened: boolean; asAdmin: boolean; viewerUserId: number | null } {
  const tokened = isAdmin(req, ctx);
  const viewerUserId = tokened ? Number(url.searchParams.get("viewerUserId")) : Number.NaN;
  const viewer = Number.isInteger(viewerUserId) && viewerUserId > 0 ? viewerUserId : null;
  const asAdmin = tokened && (viewer == null || url.searchParams.get("asAdmin") === "1");
  return { tokened, asAdmin, viewerUserId: viewer };
}
