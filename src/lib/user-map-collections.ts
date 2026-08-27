import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";
import {
  EMPTY_USER_COLLECTIONS_LIST,
  USER_COLLECTION_DESCRIPTION_MAX_LENGTH,
  USER_COLLECTION_MAX_ITEMS,
  USER_COLLECTION_MAX_TAGS,
  USER_COLLECTION_TITLE_MAX_LENGTH,
  type UserCollectionSort,
  type UserCollectionWriteResult,
  type UserCollectionsListResult,
  type UserMapCollectionDetail,
  type UserMapCollectionSummary,
} from "./user-map-collections-shared";

/*
 * The /maps Collections tab's community half: collections players build and
 * post themselves.
 *
 * Every call is a server function rather than a direct fetch at the live
 * backend, the way /communities does it. The directory is public, but who is
 * asking still decides two things - which hearts are already filled in, and
 * which rows a write may touch - and keeping the calls server-side is what lets
 * that viewer be read from the signed login cookie instead of taken from the
 * browser. The client never asserts who it is: each handler re-reads the
 * osu!-verified viewer and forwards the id itself, or forwards nobody when
 * there is no session.
 */

export * from "./user-map-collections-shared";

interface CollectionsBackend {
  base: string;
  headers: HeadersInit;
  viewerUserId: number | null;
  username: string;
  country: string | null;
  /** Whether the frontend has already checked this viewer may act on anyone's
      collection; only ever widens delete and update. */
  isAdmin: boolean;
}

function resolveBase(): string | null {
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  return base || null;
}

function backendHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return headers;
}

/** The read scope: a signed-out reader is not an error, only a reader with no
    id, which is the whole directory with no hearts filled in. */
async function resolveRead(): Promise<CollectionsBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  const base = resolveBase();
  if (!base) return null;
  const country = auth.viewer?.countryCode?.trim().toUpperCase() ?? "";
  return {
    base,
    headers: backendHeaders(),
    viewerUserId: auth.viewer?.id ?? null,
    username: auth.viewer?.username ?? "",
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    isAdmin: auth.isAdmin === true,
  };
}

/** The write scope. Posting, editing, deleting and favouriting all need
    somebody signed in, so a missing session refuses here. */
async function resolveWrite(): Promise<(CollectionsBackend & { viewerUserId: number }) | null> {
  const cfg = await resolveRead();
  if (!cfg || cfg.viewerUserId == null) return null;
  return { ...cfg, viewerUserId: cfg.viewerUserId };
}

async function noStore(): Promise<void> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
}

// ------------------------------------------------------------------ reads

export interface UserCollectionsQuery {
  q?: string;
  sort?: UserCollectionSort;
  keys?: string;
  tag?: string;
  owner?: number;
  /** Only the ones the viewer favourited; ignored when signed out. */
  favourited?: boolean;
  page?: number;
}

export const fetchUserMapCollections = createServerFn({ method: "GET" })
  .validator((data: UserCollectionsQuery = {}) => ({
    q: typeof data.q === "string" ? data.q.slice(0, 80) : "",
    sort: (data.sort === "favourites" || data.sort === "maps" || data.sort === "title" ? data.sort : "recent") as UserCollectionSort,
    keys: typeof data.keys === "string" ? data.keys.slice(0, 8) : "",
    tag: typeof data.tag === "string" ? data.tag.slice(0, 24) : "",
    owner: Number.isInteger(data.owner) && Number(data.owner) > 0 ? Number(data.owner) : 0,
    favourited: data.favourited === true,
    page: Number.isInteger(data.page) && Number(data.page) > 0 ? Number(data.page) : 0,
  }))
  .handler(async ({ data }): Promise<UserCollectionsListResult> => {
    await noStore();
    const cfg = await resolveRead();
    if (!cfg) return EMPTY_USER_COLLECTIONS_LIST;
    const query = new URLSearchParams();
    if (data.q) query.set("q", data.q);
    if (data.sort !== "recent") query.set("sort", data.sort);
    if (data.keys) query.set("keys", data.keys);
    if (data.tag) query.set("tag", data.tag);
    if (data.owner) query.set("owner", String(data.owner));
    if (data.favourited) query.set("favourited", "1");
    if (data.page) query.set("page", String(data.page));
    if (cfg.viewerUserId != null) query.set("viewerUserId", String(cfg.viewerUserId));
    try {
      const response = await fetch(`${cfg.base}/api/map-collections/list?${query.toString()}`, { headers: cfg.headers });
      if (!response.ok) return EMPTY_USER_COLLECTIONS_LIST;
      const body = (await response.json()) as UserCollectionsListResult & { ok?: boolean };
      return body.ok === false ? EMPTY_USER_COLLECTIONS_LIST : body;
    } catch {
      return EMPTY_USER_COLLECTIONS_LIST;
    }
  });

export const fetchUserMapCollection = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => ({ id: typeof data?.id === "string" ? data.id.slice(0, 64) : "" }))
  .handler(async ({ data }): Promise<UserMapCollectionDetail | null> => {
    await noStore();
    if (!data.id) return null;
    const cfg = await resolveRead();
    if (!cfg) return null;
    const query = new URLSearchParams({ id: data.id });
    if (cfg.viewerUserId != null) query.set("viewerUserId", String(cfg.viewerUserId));
    try {
      const response = await fetch(`${cfg.base}/api/map-collections/get?${query.toString()}`, { headers: cfg.headers });
      if (!response.ok) return null;
      const body = (await response.json()) as { ok?: boolean; collection?: UserMapCollectionDetail };
      return body.ok && body.collection ? body.collection : null;
    } catch {
      return null;
    }
  });

export const fetchMyMapCollections = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ available: boolean; collections: UserMapCollectionSummary[] }> => {
    await noStore();
    const cfg = await resolveWrite();
    if (!cfg) return { available: false, collections: [] };
    try {
      const response = await fetch(
        `${cfg.base}/api/map-collections/mine?viewerUserId=${cfg.viewerUserId}`,
        { headers: cfg.headers },
      );
      if (!response.ok) return { available: true, collections: [] };
      const body = (await response.json()) as { collections?: UserMapCollectionSummary[] };
      return { available: true, collections: Array.isArray(body.collections) ? body.collections : [] };
    } catch {
      return { available: true, collections: [] };
    }
  });

// ----------------------------------------------------------------- writes

export interface UserCollectionFormInput {
  id?: string;
  title: string;
  description?: string;
  tags?: string[];
  beatmapIds?: number[];
}

/* Bounded here so an oversized body never leaves this process; the backend
   trims and normalizes again, and its answer is the one that is stored. */
function validateForm(data: UserCollectionFormInput) {
  const title = typeof data.title === "string" ? data.title.slice(0, USER_COLLECTION_TITLE_MAX_LENGTH + 20).trim() : "";
  if (!title) throw new Error("Give the collection a title.");
  return {
    id: typeof data.id === "string" ? data.id.slice(0, 64) : "",
    title,
    description: typeof data.description === "string" ? data.description.slice(0, USER_COLLECTION_DESCRIPTION_MAX_LENGTH + 100) : "",
    tags: Array.isArray(data.tags)
      ? data.tags.filter((tag): tag is string => typeof tag === "string").slice(0, USER_COLLECTION_MAX_TAGS + 5)
      : [],
    beatmapIds: Array.isArray(data.beatmapIds)
      ? data.beatmapIds
          .map((id) => Math.floor(Number(id)))
          .filter((id) => Number.isFinite(id) && id > 0)
          .slice(0, USER_COLLECTION_MAX_ITEMS)
      : [],
  };
}

async function postCollection(path: string, payload: Record<string, unknown>): Promise<UserCollectionWriteResult> {
  const cfg = await resolveWrite();
  if (!cfg) return { ok: false, error: "no_access" };
  try {
    const response = await fetch(`${cfg.base}${path}`, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({ userId: cfg.viewerUserId, username: cfg.username, country: cfg.country, ...payload }),
    });
    const body = (await response.json().catch(() => null)) as UserCollectionWriteResult | null;
    if (!body) return { ok: false, error: "write_failed" };
    return body;
  } catch {
    return { ok: false, error: "write_failed" };
  }
}

export const createMapCollection = createServerFn({ method: "POST" })
  .validator((data: UserCollectionFormInput) => validateForm(data))
  .handler(async ({ data }): Promise<UserCollectionWriteResult> => {
    await noStore();
    return postCollection("/api/map-collections/create", {
      title: data.title,
      description: data.description,
      tags: data.tags,
      beatmapIds: data.beatmapIds,
    });
  });

export const updateMapCollection = createServerFn({ method: "POST" })
  .validator((data: UserCollectionFormInput) => {
    const form = validateForm(data);
    if (!form.id) throw new Error("Missing collection.");
    return form;
  })
  .handler(async ({ data }): Promise<UserCollectionWriteResult> => {
    await noStore();
    const cfg = await resolveWrite();
    if (!cfg) return { ok: false, error: "no_access" };
    return postCollection("/api/map-collections/update", {
      id: data.id,
      title: data.title,
      description: data.description,
      tags: data.tags,
      beatmapIds: data.beatmapIds,
      // An admin may fix or take down somebody else's; an owner's own edit
      // needs nothing beyond the id the backend checks against the row.
      asAdmin: cfg.isAdmin,
    });
  });

export const deleteMapCollection = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => ({ id: typeof data?.id === "string" ? data.id.slice(0, 64) : "" }))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    await noStore();
    if (!data.id) return { ok: false, error: "invalid_request" };
    const cfg = await resolveWrite();
    if (!cfg) return { ok: false, error: "no_access" };
    try {
      const response = await fetch(`${cfg.base}/api/map-collections/delete`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.viewerUserId, id: data.id, asAdmin: cfg.isAdmin }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      return { ok: body?.ok === true, error: body?.error };
    } catch {
      return { ok: false, error: "write_failed" };
    }
  });

export const favouriteMapCollection = createServerFn({ method: "POST" })
  .validator((data: { id: string; favourited: boolean }) => ({
    id: typeof data?.id === "string" ? data.id.slice(0, 64) : "",
    favourited: data?.favourited === true,
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; favourited: boolean; favouriteCount: number }> => {
    await noStore();
    const fallback = { ok: false, favourited: false, favouriteCount: 0 };
    if (!data.id) return fallback;
    const cfg = await resolveWrite();
    if (!cfg) return fallback;
    try {
      const response = await fetch(`${cfg.base}/api/map-collections/favourite`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.viewerUserId, id: data.id, favourited: data.favourited }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; favourited?: boolean; favouriteCount?: number }
        | null;
      if (!body?.ok) return fallback;
      return {
        ok: true,
        favourited: body.favourited === true,
        favouriteCount: Math.max(0, Math.floor(Number(body.favouriteCount)) || 0),
      };
    } catch {
      return fallback;
    }
  });
