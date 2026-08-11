import { createServerFn } from "@tanstack/react-start";
import {
  COMMUNITIES_PAGE_SIZE,
  COMMUNITY_MAX_ACCESS_SCOPES,
  COMMUNITY_MAX_TAGS,
  COMMUNITY_PITCH_MAX_LENGTH,
  COMMUNITY_REPORT_DETAILS_MAX_LENGTH,
  type CommunitiesListResult,
  type CommunityReport,
  type CommunityInvitePreview,
  type CommunitySort,
  type CommunitySummary,
  type ManageableGuild,
} from "./communities-shared";

/*
 * Client-side access to the /communities directory.
 *
 * Everything here is a server function rather than a direct fetch at the live
 * backend, which is what skins does for its public reads. The directory is
 * open to everyone, but what is in it is not the same for everyone: which
 * restricted listings a viewer is shown, and whether an invite comes with them,
 * both depend on the osu!-verified country. Keeping the reads server-side is
 * what lets that country be read from the session instead of taken from the
 * browser, so the backend routes stay behind the admin-token bridge.
 *
 * The client never asserts who it is. Every handler re-reads the osu!-verified
 * viewer and forwards the id itself, or forwards nobody when there is no
 * session: a signed-out read is a stranger's read, which is the whole public
 * directory minus the listings that named the places they are for.
 */

export * from "./communities-shared";

/** Who is acting, for everything that writes or reads only your own rows. */
interface CommunitiesBackend {
  base: string;
  headers: HeadersInit;
  userId: number;
  username: string;
}

/*
 * Resolves the backend plus the verified viewer, or null if either is missing.
 * Posting, editing, flagging and the Discord side all need somebody signed in,
 * so a missing session is the same refusal as a missing backend here.
 */
async function resolveCommunitiesBackend(): Promise<CommunitiesBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = resolveBackendBase();
  if (!base) return null;
  return {
    base,
    headers: backendHeaders(),
    userId: auth.viewer.id,
    username: auth.viewer.username,
  };
}

/** What a read forwards about whoever is asking, when anyone is. */
interface CommunitiesReadScope {
  base: string;
  headers: HeadersInit;
  viewerUserId: number | null;
  // Where the viewer is, off their osu! profile. It decides which restricted
  // listings they are shown and which invites they are handed, so it is read
  // here from the verified viewer and never accepted from the browser.
  viewerCountry: string | null;
  isModerator: boolean;
}

/*
 * The read variant, for the two routes anyone may open. A signed-out reader is
 * not an error here, only a reader the backend knows nothing about: no id and
 * no country, so a listing that named the places it is for withholds its invite
 * and a hidden one is not in the page at all.
 */
async function resolveCommunitiesRead(): Promise<CommunitiesReadScope | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const { canModerateCommunities } = await import("./communities-shared");
  const auth = await readCurrentAuth();
  const base = resolveBackendBase();
  if (!base) return null;
  return {
    base,
    headers: backendHeaders(),
    viewerUserId: auth.viewer?.id ?? null,
    viewerCountry: auth.viewer?.countryCode ?? null,
    isModerator: canModerateCommunities(auth),
  };
}

function resolveBackendBase(): string | null {
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  return base || null;
}

function backendHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return headers;
}

/*
 * The reviewer variant. Not requireTrueAdminAccess: reviewing is a per-feature
 * moderator list the owner keeps by hand, and those people are not site admins.
 * Re-derived from the verified viewer on every call, so the button being hidden
 * is the courtesy and this is the actual gate.
 */
async function resolveModeratorBackend(): Promise<CommunitiesBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const { canModerateCommunities } = await import("./communities-shared");
  const auth = await readCurrentAuth();
  if (!auth.viewer || !canModerateCommunities(auth)) return null;
  const base = resolveBackendBase();
  if (!base) return null;
  return {
    base,
    headers: backendHeaders(),
    userId: auth.viewer.id,
    username: auth.viewer.username,
  };
}

async function noStore(): Promise<void> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
}

const EMPTY_LIST: CommunitiesListResult = {
  communities: [],
  total: 0,
  page: 0,
  pageSize: COMMUNITIES_PAGE_SIZE,
  facets: { countries: [], languages: [], tags: [] },
};

// ------------------------------------------------------------------ reads

export interface CommunitiesQuery {
  q?: string;
  page?: number;
  sort?: CommunitySort;
  country?: string;
  lang?: string;
  tag?: string;
}

export const fetchCommunities = createServerFn({ method: "GET" })
  .validator((data: CommunitiesQuery = {}) => ({
    q: typeof data.q === "string" ? data.q.slice(0, 80) : "",
    page: Number.isInteger(data.page) && Number(data.page) > 0 ? Number(data.page) : 0,
    sort: (data.sort === "newest" || data.sort === "name" ? data.sort : "members") as CommunitySort,
    country: typeof data.country === "string" ? data.country.slice(0, 4) : "",
    lang: typeof data.lang === "string" ? data.lang.slice(0, 8) : "",
    tag: typeof data.tag === "string" ? data.tag.slice(0, 24) : "",
  }))
  .handler(async ({ data }): Promise<CommunitiesListResult> => {
    await noStore();
    const cfg = await resolveCommunitiesRead();
    if (!cfg) return EMPTY_LIST;
    const query = new URLSearchParams();
    if (data.q) query.set("q", data.q);
    if (data.page) query.set("page", String(data.page));
    if (data.sort !== "members") query.set("sort", data.sort);
    if (data.country) query.set("country", data.country);
    if (data.lang) query.set("lang", data.lang);
    if (data.tag) query.set("tag", data.tag);
    if (cfg.viewerUserId != null) query.set("viewerUserId", String(cfg.viewerUserId));
    if (cfg.viewerCountry) query.set("viewerCountry", cfg.viewerCountry);
    try {
      const response = await fetch(`${cfg.base}/api/communities/list?${query.toString()}`, { headers: cfg.headers });
      if (!response.ok) return EMPTY_LIST;
      return (await response.json()) as CommunitiesListResult;
    } catch {
      return EMPTY_LIST;
    }
  });

/**
 * One listing for its own page, or null when there is nothing you may see:
 * approved and working for anyone, any state for its owner, anyone's for a
 * moderator. The backend decides all three; this only forwards who is asking.
 */
export const fetchCommunity = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => ({ id: typeof data?.id === "string" ? data.id.slice(0, 64) : "" }))
  .handler(async ({ data }): Promise<CommunitySummary | null> => {
    await noStore();
    if (!data.id) return null;
    const cfg = await resolveCommunitiesRead();
    if (!cfg) return null;
    const query = new URLSearchParams({ id: data.id });
    if (cfg.viewerUserId != null) query.set("viewerUserId", String(cfg.viewerUserId));
    if (cfg.viewerCountry) query.set("viewerCountry", cfg.viewerCountry);
    if (cfg.isModerator) query.set("asAdmin", "1");
    try {
      const response = await fetch(`${cfg.base}/api/communities/get?${query.toString()}`, { headers: cfg.headers });
      if (!response.ok) return null;
      const body = (await response.json()) as { ok?: boolean; community?: CommunitySummary };
      return body.ok && body.community ? body.community : null;
    } catch {
      return null;
    }
  });

export interface MyCommunitiesResult {
  communities: CommunitySummary[];
  // Whether a Discord connection is currently in hand, and who it says you are.
  discordUsername: string | null;
  discordAvatarUrl: string | null;
}

export const fetchMyCommunities = createServerFn({ method: "GET" })
  .handler(async (): Promise<MyCommunitiesResult> => {
    await noStore();
    const cfg = await resolveCommunitiesBackend();
    if (!cfg) return { communities: [], discordUsername: null, discordAvatarUrl: null };
    const link = await readLink(cfg.userId);
    try {
      const response = await fetch(
        `${cfg.base}/api/communities/mine?viewerUserId=${cfg.userId}`,
        { headers: cfg.headers },
      );
      if (!response.ok) {
        return { communities: [], discordUsername: link?.discordUsername ?? null, discordAvatarUrl: link?.discordAvatarUrl ?? null };
      }
      const body = (await response.json()) as { communities?: CommunitySummary[] };
      return {
        communities: Array.isArray(body.communities) ? body.communities : [],
        discordUsername: link?.discordUsername ?? null,
        discordAvatarUrl: link?.discordAvatarUrl ?? null,
      };
    } catch {
      return { communities: [], discordUsername: link?.discordUsername ?? null, discordAvatarUrl: link?.discordAvatarUrl ?? null };
    }
  });

/*
 * What the directory last showed, kept for the tab's lifetime.
 *
 * Opening a server's page and coming back remounts /communities, which refires
 * the list fetch, so the grid fell back to a screen of skeletons even though
 * the same page had been on it a second earlier. A cached page paints at once
 * and the fetch behind it only swaps the rows in.
 *
 * Browser only, on purpose. A listing is viewer-scoped - which restricted
 * servers you are shown, and whether an invite comes with them, both depend on
 * who is asking - so a map living in the SSR process would be one viewer's
 * answers handed to the next. Signing in or out is a full page load, which is
 * what clears it.
 */
const COMMUNITIES_LIST_TTL_MS = 5 * 60 * 1000;
const COMMUNITIES_LIST_MAX = 12;
const communitiesListMemory = new Map<string, { at: number; result: CommunitiesListResult }>();
let myCommunitiesMemory: { at: number; communities: CommunitySummary[] } | null = null;

export function communitiesListCacheKey(query: CommunitiesQuery = {}): string {
  return [
    query.q?.trim() ?? "",
    query.page ?? 0,
    query.sort ?? "members",
    query.country ?? "",
    query.lang ?? "",
    query.tag ?? "",
  ].join("|");
}

export function readCachedCommunities(key: string): CommunitiesListResult | null {
  if (typeof window === "undefined") return null;
  const entry = communitiesListMemory.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > COMMUNITIES_LIST_TTL_MS) {
    communitiesListMemory.delete(key);
    return null;
  }
  return entry.result;
}

export function writeCachedCommunities(key: string, result: CommunitiesListResult): void {
  if (typeof window === "undefined") return;
  communitiesListMemory.set(key, { at: Date.now(), result });
  // Oldest insertion first, so the map stays bounded across a long browse.
  while (communitiesListMemory.size > COMMUNITIES_LIST_MAX) {
    const oldest = communitiesListMemory.keys().next();
    if (oldest.done) break;
    communitiesListMemory.delete(oldest.value);
  }
}

export function readCachedMyCommunities(): CommunitySummary[] | null {
  if (typeof window === "undefined") return null;
  if (!myCommunitiesMemory) return null;
  if (Date.now() - myCommunitiesMemory.at > COMMUNITIES_LIST_TTL_MS) {
    myCommunitiesMemory = null;
    return null;
  }
  return myCommunitiesMemory.communities;
}

export function writeCachedMyCommunities(communities: CommunitySummary[]): void {
  if (typeof window === "undefined") return;
  myCommunitiesMemory = { at: Date.now(), communities };
}

/**
 * Dropped whenever a listing is posted, edited, taken down or reviewed: a page
 * held from before the change would repaint the old rows for the moment before
 * the refetch lands, which is exactly where a just-deleted server would flash
 * back onto the grid.
 */
export function clearCommunitiesCache(): void {
  communitiesListMemory.clear();
  myCommunitiesMemory = null;
}

/**
 * The servers the connected Discord account owns or manages. Fetched live from
 * Discord on every call rather than stored, so the cookie stays small and the
 * list is never stale.
 */
export const fetchManageableGuilds = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ ok: boolean; guilds: ManageableGuild[]; error?: string }> => {
    await noStore();
    const cfg = await resolveCommunitiesBackend();
    if (!cfg) return { ok: false, guilds: [], error: "no_access" };
    const link = await readLink(cfg.userId);
    if (!link) return { ok: false, guilds: [], error: "no_discord" };
    const { fetchManageableGuilds: fetchGuilds } = await import("./discord-auth-server");
    try {
      return { ok: true, guilds: await fetchGuilds(link.accessToken) };
    } catch {
      // Almost always an expired or revoked grant; reconnecting fixes it.
      return { ok: false, guilds: [], error: "no_discord" };
    }
  });

// ----------------------------------------------------------------- writes

export interface SubmitCommunityInput {
  guildId: string;
  invite: string;
  pitch: string;
  countryCode?: string;
  language?: string;
  tags?: string[];
  // The places the server is for, empty meaning everyone, and whether someone
  // outside them sees it locked or not at all.
  accessScopes?: string[];
  accessHidden?: boolean;
}

/**
 * Resolves an invite without posting anything, so the form can show the server
 * it is about to list and refuse a bad link while it is still being typed. Goes
 * through the backend rather than calling Discord from here, so the refusal
 * reasons are the same ones submit will give.
 */
export const checkCommunityInvite = createServerFn({ method: "POST" })
  .validator((data: { invite: string; guildId?: string; id?: string }) => ({
    invite: typeof data.invite === "string" ? data.invite.trim().slice(0, 200) : "",
    guildId: typeof data.guildId === "string" ? data.guildId.slice(0, 32) : "",
    id: typeof data.id === "string" ? data.id.slice(0, 64) : "",
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; invite?: CommunityInvitePreview; error?: string }> => {
    await noStore();
    const cfg = await resolveCommunitiesBackend();
    if (!cfg) return { ok: false, error: "no_access" };
    // An empty invite with a guild behind it is the "find one for me" case,
    // which the backend answers from the server's own widget when it has one.
    if (!data.invite && !data.guildId) return { ok: false, error: "invalid_url" };
    try {
      const response = await fetch(`${cfg.base}/api/communities/preview`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ invite: data.invite, guildId: data.guildId, id: data.id }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; invite?: CommunityInvitePreview; error?: string }
        | null;
      if (!body) return { ok: false, error: "lookup_failed" };
      return body.ok === true && body.invite
        ? { ok: true, invite: body.invite }
        : { ok: false, error: body.error ?? "lookup_failed" };
    } catch {
      return { ok: false, error: "lookup_failed" };
    }
  });

export type CommunityWriteResult =
  | { ok: true; community: CommunitySummary }
  | { ok: false; error: string };

function validateDetails(data: Partial<SubmitCommunityInput>) {
  return {
    pitch: typeof data.pitch === "string" ? data.pitch.slice(0, COMMUNITY_PITCH_MAX_LENGTH + 100) : "",
    countryCode: typeof data.countryCode === "string" ? data.countryCode.slice(0, 4) : "",
    language: typeof data.language === "string" ? data.language.slice(0, 8) : "",
    // Bounded here and normalized by the backend, which is what decides.
    tags: Array.isArray(data.tags)
      ? data.tags.filter((tag): tag is string => typeof tag === "string").slice(0, COMMUNITY_MAX_TAGS + 5)
      : [],
    accessScopes: Array.isArray(data.accessScopes)
      ? data.accessScopes
          .filter((scope): scope is string => typeof scope === "string")
          .slice(0, COMMUNITY_MAX_ACCESS_SCOPES)
      : [],
    accessHidden: data.accessHidden === true,
  };
}

export const submitCommunity = createServerFn({ method: "POST" })
  .validator((data: SubmitCommunityInput) => {
    const guildId = typeof data.guildId === "string" ? data.guildId.trim() : "";
    const invite = typeof data.invite === "string" ? data.invite.trim() : "";
    if (!guildId || guildId.length > 32) throw new Error("Pick a server.");
    if (!invite || invite.length > 200) throw new Error("Paste an invite link.");
    return { guildId, invite, ...validateDetails(data) };
  })
  .handler(async ({ data }): Promise<CommunityWriteResult> => {
    await noStore();
    const cfg = await resolveCommunitiesBackend();
    if (!cfg) return { ok: false, error: "no_access" };
    const link = await readLink(cfg.userId);
    if (!link) return { ok: false, error: "no_discord" };

    /*
     * The ownership check. The client says which guild it wants to list; this
     * asks Discord which guilds that account actually owns or manages, and a
     * guild that is not on that list never reaches the backend. Re-derived here
     * rather than trusted from the submit call, because the picker that produced
     * it is just a UI.
     */
    const { fetchManageableGuilds: fetchGuilds, revokeDiscordToken } = await import("./discord-auth-server");
    let guild: ManageableGuild | undefined;
    try {
      const guilds = await fetchGuilds(link.accessToken);
      guild = guilds.find((entry) => entry.id === data.guildId);
    } catch {
      return { ok: false, error: "no_discord" };
    }
    if (!guild) return { ok: false, error: "forbidden" };

    try {
      const response = await fetch(`${cfg.base}/api/communities/submit`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          username: cfg.username,
          guildId: data.guildId,
          invite: data.invite,
          discordUserId: link.discordUserId,
          discordUsername: link.discordUsername,
          isGuildOwner: guild.owner,
          pitch: data.pitch,
          countryCode: data.countryCode || null,
          language: data.language || null,
          tags: data.tags,
          accessScopes: data.accessScopes,
          accessHidden: data.accessHidden,
        }),
      });
      const body = (await response.json().catch(() => null)) as CommunityWriteResult | null;
      if (!body) return { ok: false, error: "lookup_failed" };
      if (body.ok) {
        // The proof did its job. Hand the token back and drop the cookie rather
        // than leaving a live Discord grant sitting in the browser.
        const { deleteCookie } = await import("@tanstack/react-start/server");
        const { DISCORD_LINK_COOKIE_NAME } = await import("./discord-auth-server");
        deleteCookie(DISCORD_LINK_COOKIE_NAME, { path: "/" });
        void revokeDiscordToken(link.accessToken);
      }
      return body;
    } catch {
      return { ok: false, error: "lookup_failed" };
    }
  });

export const updateMyCommunity = createServerFn({ method: "POST" })
  .validator((data: Partial<SubmitCommunityInput> & { id: string; invite?: string }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid listing.");
    const invite = typeof data.invite === "string" ? data.invite.trim().slice(0, 200) : "";
    return { id, invite, ...validateDetails(data) };
  })
  .handler(async ({ data }): Promise<CommunityWriteResult> => {
    await noStore();
    const cfg = await resolveCommunitiesBackend();
    if (!cfg) return { ok: false, error: "no_access" };
    try {
      const response = await fetch(`${cfg.base}/api/communities/update`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          id: data.id,
          // Only sent when it was actually changed; the backend leaves the
          // stored invite alone otherwise.
          ...(data.invite ? { invite: data.invite } : {}),
          pitch: data.pitch,
          countryCode: data.countryCode || null,
          language: data.language || null,
          tags: data.tags,
          accessScopes: data.accessScopes,
          accessHidden: data.accessHidden,
        }),
      });
      const body = (await response.json().catch(() => null)) as CommunityWriteResult | null;
      return body ?? { ok: false, error: "lookup_failed" };
    } catch {
      return { ok: false, error: "lookup_failed" };
    }
  });

export const deleteMyCommunity = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid listing.");
    return { id };
  })
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await noStore();
    const cfg = await resolveCommunitiesBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/communities/delete`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      return { ok: response.ok && body?.ok === true };
    } catch {
      return { ok: false };
    }
  });

/**
 * Flagging a listing from its page. Anyone who can see the directory can send
 * one; the backend keeps it to one per person per listing and refuses your own.
 * Nothing about it is public: it goes to the review page and nowhere else.
 */
export const reportCommunity = createServerFn({ method: "POST" })
  .validator((data: { id: string; reason: string; details?: string }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid listing.");
    return {
      id,
      // Normalized by the backend, which is what decides; anything unknown
      // there reads back as "other".
      reason: typeof data.reason === "string" ? data.reason.slice(0, 24) : "other",
      details: typeof data.details === "string" ? data.details.slice(0, COMMUNITY_REPORT_DETAILS_MAX_LENGTH) : "",
    };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    await noStore();
    const cfg = await resolveCommunitiesBackend();
    if (!cfg) return { ok: false, error: "no_access" };
    try {
      const response = await fetch(`${cfg.base}/api/communities/report`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          username: cfg.username,
          id: data.id,
          reason: data.reason,
          details: data.details,
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!body) return { ok: false, error: "lookup_failed" };
      return body.ok === true ? { ok: true } : { ok: false, error: body.error ?? "lookup_failed" };
    } catch {
      return { ok: false, error: "lookup_failed" };
    }
  });

/** Drops the Discord connection without submitting anything. */
export const disconnectDiscord = createServerFn({ method: "POST" })
  .handler(async (): Promise<{ ok: boolean }> => {
    await noStore();
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    if (!auth.viewer) return { ok: false };
    const link = await readLink(auth.viewer.id);
    const { deleteCookie } = await import("@tanstack/react-start/server");
    const { DISCORD_LINK_COOKIE_NAME, revokeDiscordToken } = await import("./discord-auth-server");
    deleteCookie(DISCORD_LINK_COOKIE_NAME, { path: "/" });
    if (link) void revokeDiscordToken(link.accessToken);
    return { ok: true };
  });

// -------------------------------------------------------------- moderation

export interface CommunityQueue {
  pending: CommunitySummary[];
  edited: CommunitySummary[];
  // Listings the directory flagged, and the reports themselves keyed by listing
  // id. Reports ride along for every list, since a pending listing can be
  // flagged too and its card should carry them.
  reported: CommunitySummary[];
  reports: Record<string, CommunityReport[]>;
}

const EMPTY_QUEUE: CommunityQueue = { pending: [], edited: [], reported: [], reports: {} };

/**
 * Everything the review page has waiting, as one number. The three lists are
 * disjoint - a flagged listing that is also pending rides in `pending` only -
 * so they add up without deduping.
 */
export function countCommunityQueue(queue: Partial<CommunityQueue>): number {
  return (queue.pending?.length ?? 0) + (queue.edited?.length ?? 0) + (queue.reported?.length ?? 0);
}

export const fetchCommunityQueue = createServerFn({ method: "GET" })
  .handler(async (): Promise<CommunityQueue> => {
    await noStore();
    const cfg = await resolveModeratorBackend();
    if (!cfg) return EMPTY_QUEUE;
    try {
      const response = await fetch(`${cfg.base}/api/communities/queue`, { headers: cfg.headers });
      if (!response.ok) return EMPTY_QUEUE;
      const body = (await response.json()) as Partial<CommunityQueue>;
      return {
        pending: Array.isArray(body.pending) ? body.pending : [],
        edited: Array.isArray(body.edited) ? body.edited : [],
        reported: Array.isArray(body.reported) ? body.reported : [],
        reports: body.reports && typeof body.reports === "object" ? body.reports : {},
      };
    } catch {
      return EMPTY_QUEUE;
    }
  });

/**
 * The same queue, counted, for the badge on the directory's Review button: a
 * server waiting on a decision should be visible from /communities rather than
 * only to whoever thinks to open the review page. It goes through the queue
 * endpoint rather than a count route of its own - the queue is a handful of
 * rows, and one source means the badge cannot disagree with the page it opens -
 * but only the number crosses to the browser.
 */
export const fetchCommunityQueueCount = createServerFn({ method: "GET" })
  .handler(async (): Promise<number> => {
    await noStore();
    const cfg = await resolveModeratorBackend();
    if (!cfg) return 0;
    try {
      const response = await fetch(`${cfg.base}/api/communities/queue`, { headers: cfg.headers });
      if (!response.ok) return 0;
      return countCommunityQueue((await response.json()) as Partial<CommunityQueue>);
    } catch {
      return 0;
    }
  });

export const reviewCommunity = createServerFn({ method: "POST" })
  .validator((data: { id: string; action: string; reason?: string }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const action = typeof data.action === "string" ? data.action : "";
    if (!id || !["approve", "reject", "hide", "unhide", "delete"].includes(action)) {
      throw new Error("Invalid review action.");
    }
    return { id, action, reason: typeof data.reason === "string" ? data.reason.slice(0, 200) : "" };
  })
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await noStore();
    const cfg = await resolveModeratorBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/communities/review`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id, action: data.action, reason: data.reason }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      return { ok: response.ok && body?.ok === true };
    } catch {
      return { ok: false };
    }
  });

/** The admin page's "check invites now" button. */
export const refreshCommunityInvites = createServerFn({ method: "POST" })
  .handler(async (): Promise<{ ok: boolean; checked?: number; hidden?: number }> => {
    await noStore();
    const cfg = await resolveModeratorBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/communities/refresh`, {
        method: "POST",
        headers: cfg.headers,
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; checked?: number; hidden?: number }
        | null;
      return { ok: response.ok && body?.ok === true, checked: body?.checked, hidden: body?.hidden };
    } catch {
      return { ok: false };
    }
  });

async function readLink(osuUserId: number) {
  const { getCookie } = await import("@tanstack/react-start/server");
  const { DISCORD_LINK_COOKIE_NAME, readDiscordLink } = await import("./discord-auth-server");
  return readDiscordLink(getCookie(DISCORD_LINK_COOKIE_NAME), osuUserId);
}
