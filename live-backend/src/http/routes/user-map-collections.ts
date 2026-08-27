import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJson } from "../../db.js";
import {
  createUserMapCollection,
  deleteUserMapCollection,
  getUserMapCollection,
  listUserMapCollections,
  listUserMapCollectionsForOwner,
  normalizeUserCollectionSort,
  setUserMapCollectionFavourite,
  updateUserMapCollection,
} from "../../features/user-map-collections.js";
import type { HttpContext } from "../context.js";
import { isBridge, readBody } from "../request.js";
import { sendJson } from "../respond.js";

/*
 * /api/map-collections/*: the collections players build themselves.
 *
 * Bridge-token gated end to end, reads included, the same way /communities is:
 * the frontend server functions are the only callers and they forward the
 * osu!-verified viewer id beside the shared token. Nothing here is secret - the
 * directory is public - but the id decides which heart is already filled in and
 * which collection a write is allowed to touch, and taking that from the
 * browser would be taking it from anyone who can type a querystring.
 *
 * The shared token cannot tell an owner's edit from an admin's takedown, so
 * `asAdmin` is a claim the frontend vouches for per request (the pack-community
 * and communities pattern), and it only ever widens delete and update to
 * somebody else's row.
 */

interface CollectionScope {
  tokened: boolean;
  viewerUserId: number | null;
  asAdmin: boolean;
}

function collectionScope(req: IncomingMessage, ctx: HttpContext, url: URL, body?: Record<string, unknown>): CollectionScope {
  const tokened = isBridge(req, ctx);
  const raw = body?.userId ?? url.searchParams.get("viewerUserId");
  const viewerUserId = tokened && Number.isInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  return {
    tokened,
    viewerUserId,
    asAdmin: tokened && (body?.asAdmin === true || url.searchParams.get("asAdmin") === "1"),
  };
}

export async function handleUserMapCollectionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/map-collections")) return false;
  const writeDb = ctx.serveWriteDb ?? ctx.db;

  if (url.pathname === "/api/map-collections/list") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    const scope = collectionScope(req, ctx, url);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    const result = await listUserMapCollections(ctx.db, {
      q: url.searchParams.get("q") ?? "",
      sort: normalizeUserCollectionSort(url.searchParams.get("sort")),
      keys: url.searchParams.get("keys") ?? "",
      tag: url.searchParams.get("tag") ?? "",
      ownerUserId: Number(url.searchParams.get("owner")) || null,
      favouritedBy: url.searchParams.get("favourited") === "1" ? scope.viewerUserId : null,
      page: Number(url.searchParams.get("page")) || 0,
      viewerUserId: scope.viewerUserId,
    });
    // Viewer-scoped (the filled hearts), so it never lands in a shared cache.
    res.setHeader("cache-control", "private, no-store");
    sendJson(req, res, ctx, 200, { ok: true, ...result });
    return true;
  }

  if (url.pathname === "/api/map-collections/get") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    const scope = collectionScope(req, ctx, url);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    const id = url.searchParams.get("id") ?? "";
    if (!id) return badRequest(req, res, ctx);
    const collection = await getUserMapCollection(ctx.db, id, scope.viewerUserId);
    if (!collection) {
      sendJson(req, res, ctx, 404, { ok: false, error: "not_found" });
      return true;
    }
    res.setHeader("cache-control", "private, no-store");
    sendJson(req, res, ctx, 200, { ok: true, collection });
    return true;
  }

  if (url.pathname === "/api/map-collections/mine") {
    if (req.method !== "GET") return methodNotAllowed(req, res, ctx);
    const scope = collectionScope(req, ctx, url);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    if (!scope.viewerUserId) return badRequest(req, res, ctx);
    res.setHeader("cache-control", "private, no-store");
    sendJson(req, res, ctx, 200, { ok: true, collections: await listUserMapCollectionsForOwner(ctx.db, scope.viewerUserId) });
    return true;
  }

  if (
    url.pathname === "/api/map-collections/create"
    || url.pathname === "/api/map-collections/update"
    || url.pathname === "/api/map-collections/delete"
    || url.pathname === "/api/map-collections/favourite"
  ) {
    if (req.method !== "POST") return methodNotAllowed(req, res, ctx);
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const scope = collectionScope(req, ctx, url, body);
    if (!scope.tokened) return unauthorized(req, res, ctx);
    if (!scope.viewerUserId) return badRequest(req, res, ctx);
    const id = typeof body.id === "string" ? body.id : "";

    if (url.pathname === "/api/map-collections/create") {
      const result = await createUserMapCollection(writeDb, {
        ownerUserId: scope.viewerUserId,
        ownerUsername: typeof body.username === "string" ? body.username.slice(0, 64) : String(scope.viewerUserId),
        ownerCountry: typeof body.country === "string" ? body.country : null,
        title: typeof body.title === "string" ? body.title : "",
        description: typeof body.description === "string" ? body.description : "",
        tags: body.tags,
        beatmapIds: body.beatmapIds,
      });
      sendJson(req, res, ctx, result.ok ? 200 : 400, result);
      return true;
    }

    if (!id) return badRequest(req, res, ctx);

    if (url.pathname === "/api/map-collections/update") {
      const result = await updateUserMapCollection(
        writeDb,
        scope.viewerUserId,
        id,
        {
          // Absent fields stay absent, so a rename cannot blank a list it never
          // loaded; `undefined` is what the feature module reads as "untouched".
          title: body.title === undefined ? undefined : body.title,
          description: body.description === undefined ? undefined : body.description,
          tags: body.tags === undefined ? undefined : body.tags,
          beatmapIds: body.beatmapIds === undefined ? undefined : body.beatmapIds,
        },
        { asAdmin: scope.asAdmin },
      );
      sendJson(req, res, ctx, result.ok ? 200 : result.error === "forbidden" ? 403 : result.error === "not_found" ? 404 : 400, result);
      return true;
    }

    if (url.pathname === "/api/map-collections/delete") {
      const result = await deleteUserMapCollection(writeDb, scope.viewerUserId, id, { asAdmin: scope.asAdmin });
      sendJson(req, res, ctx, result.ok ? 200 : result.error === "forbidden" ? 403 : 404, result);
      return true;
    }

    const result = await setUserMapCollectionFavourite(writeDb, id, scope.viewerUserId, body.favourited === true);
    sendJson(req, res, ctx, result.ok ? 200 : 404, result);
    return true;
  }

  return false;
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): true {
  sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
  return true;
}

function unauthorized(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): true {
  sendJson(req, res, ctx, 401, { error: "unauthorized" });
  return true;
}

function badRequest(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): true {
  sendJson(req, res, ctx, 400, { error: "invalid_request" });
  return true;
}
