import { createServerFn } from "@tanstack/react-start";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { getI18n } from "./i18n";
import type { AppLocale } from "./locale";
import { getLiveBackendUrl, getServerLiveBackendUrl } from "./live-backend";
import type { PreviewBackdrop } from "./skin-preview-backdrops";
import type { SkinPreviewChartSnippet } from "./skin-preview-patterns";
import { liveBridgeToken } from "./live-backend-tokens";

// Community skins: public browsing goes straight to the live backend (CORS),
// per-user actions go through server fns that resolve the osu!-verified viewer
// from the auth cookie and forward it with the bridge token (the goals bridge).
// The 50MB .osk upload itself is browser -> live backend with a short-lived
// ticket minted by startSkinUpload, so the archive never transits the frontend server.

export interface SkinImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SkinScreenshot extends SkinImage {
  // What the uploader called this shot ("Score screen"). Null or missing is
  // unnamed, which the gallery numbers instead. Optional because summaries
  // cached before names existed lack it.
  label?: string | null;
}

export interface SkinKeymodePreview extends SkinImage {
  keys: number;
  // Present only in owner-scoped responses. Historical previews have no
  // recipe because their backdrop and notes were flattened into the PNG.
  recipe?: SkinPreviewRecipe;
}

export interface SkinPreviewRecipe {
  backdrop: PreviewBackdrop;
  pattern: SkinPreviewChartSnippet | null;
}

export interface SkinPreviewRecipeUpdate {
  keys: number;
  recipe: SkinPreviewRecipe;
}

export interface SkinSummary {
  id: string;
  // URL slug ("pl0x-aleju03-mix"), assigned at publish; null only on rows
  // published before slugs existed and not yet backfilled. Page links prefer
  // it; API endpoints (download, delete, moderate) keep using the id.
  slug: string | null;
  name: string;
  // Who made the skin (skin.ini Author or uploader-provided); distinct from
  // the uploader and the primary credit on cards.
  author: string | null;
  description: string | null;
  ownerUserId: number;
  ownerUsername: string;
  keymodes: number[];
  // Keymodes whose layout is really (N-1)+1, e.g. [8] on a 7K+1 skin. Derived
  // server-side from skin.ini's ColumnLineWidth (a separator line against the
  // first or last column marks the scratch lane). Optional because summaries
  // cached before the field existed lack it.
  specialKeymodes?: number[];
  accentColor: string | null;
  // Archive traits the backend analyzed out of the .osk, each null (or
  // missing, on summaries cached before they existed) when unknown: whether
  // the skin ships a lane cover, its own mania stage art, and lazer-only
  // modification files.
  laneCover?: boolean | null;
  maniaStage?: boolean | null;
  lazer?: boolean | null;
  // Every distinct tap-note shape across the skin's keymodes, with the
  // primary/majority shape first. Missing on summaries from older backends.
  noteShapes?: SkinNoteShape[];
  // The primary tap-note shape, retained as the catalog-filter label.
  noteShape?: SkinNoteShape | null;
  // On a note-shape-filtered list, the keymode render that actually proves the
  // match. Absent on detail pages and responses from older backends.
  filterKeys?: number | null;
  // The uploader's word on what resolution the skin is made for, normalized
  // to "1920x1080"; null when they never said.
  resolution?: string | null;
  // Public: everyone reads every skin's count.
  downloadCount: number;
  // Also public: opens of the skin's own page, counted once per visitor per
  // 6h. Optional because summaries cached before the field existed lack it.
  viewCount?: number;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  previews: SkinKeymodePreview[];
  screenshots: SkinScreenshot[];
  oskUrl: string | null;
  oskSizeBytes: number | null;
  oskSha256: string | null;
  // When the uploader last swapped the .osk for a newer build; null while the
  // skin still carries the file it was published with.
  oskUpdatedAt: string | null;
  status: "pending" | "published" | "hidden";
  // "private" is the uploader's own skin: off /skins, its page and its .osk
  // answer only to them, and everyone else only ever meets it as the art on
  // their replays. Every URL on a private summary carries the capability the
  // backend asks for, so it is only ever filled in for the owner - a redacted
  // copy has them all null.
  visibility: SkinVisibility;
  // When the .osk was uploaded. The date shown as "Uploaded" on the skin page,
  // and the one to keep using for anything about the file itself.
  publishedAt: string | null;
  // When the skin first reached the catalog, which is a later date for one
  // uploaded private and made public afterwards. This is what /skins orders
  // its newest sort by and what the cards age off, so a skin made public today
  // reads as today's. Optional: summaries cached before the field existed lack
  // it, and it is null on a skin that has never been public.
  listedAt?: string | null;
}

export type SkinVisibility = "public" | "private";

export interface SkinsListResult {
  skins: SkinSummary[];
  total: number;
  page: number;
  pageSize: number;
  // Every resolution uploaders have actually claimed within the rest of the
  // query, smallest display first. Absent on a response from an older backend.
  resolutions?: string[];
}

export const SKINS_PAGE_SIZE = 24;
export const SKIN_NAME_MAX_LENGTH = 80;
export const SKIN_AUTHOR_MAX_LENGTH = 64;
export const SKIN_DESCRIPTION_MAX_LENGTH = 500;
export const SKIN_OSK_MAX_BYTES = 50 * 1024 * 1024;
export const SKIN_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const SKIN_MAX_SCREENSHOTS = 4;
export const SKIN_SCREENSHOT_LABEL_MAX_LENGTH = 40;
// Mirrors the backend's per-user cap; used as the page size for the private
// shelf, which is never paginated.
export const SKIN_MAX_PER_USER = 30;
// The backend's list cap, and the page size of the admin private shelf (every
// uploader's private skins, so the per-user cap is not the bound there).
export const SKIN_LIST_MAX_PAGE_SIZE = 50;

// osu! user ids trusted to fix keymode labels on anyone's public skin, e.g. a
// skin published as 8K that really plays 7K+1. This is the whole grant: no
// other skin control, and nothing else on the site, keys off this list. The
// server fn re-derives membership from the verified viewer id, so the client
// side of this is display only.
const SKIN_KEYMODE_MODERATOR_USER_IDS = [12490530];

export function canModerateSkinKeymodes(userId: number | null | undefined): boolean {
  return userId != null && SKIN_KEYMODE_MODERATOR_USER_IDS.includes(userId);
}

// Three sort options, each a pair: the browse page shows one label per pair and
// clicking the active one flips it to the other direction.
export type SkinsSort = "newest" | "oldest" | "downloads" | "downloads-asc" | "size" | "size-asc";

const SKINS_SORTS: readonly string[] = ["newest", "oldest", "downloads", "downloads-asc", "size", "size-asc"];

export function isSkinsSort(value: unknown): value is SkinsSort {
  return typeof value === "string" && SKINS_SORTS.includes(value);
}

// Refines a keymode filter by layout: "special" is the 7K+1 filter (8K skins
// whose eighth column is a scratch lane), "regular" makes 8K mean actual 8K.
export type SkinsKeymodeVariant = "special" | "regular";

// What the tap notes are, classified server-side from the note art.
export type SkinNoteShape = "circle" | "arrow" | "bar" | "other";

const SKIN_NOTE_SHAPES: readonly string[] = ["circle", "arrow", "bar", "other"];

export function isSkinNoteShape(value: unknown): value is SkinNoteShape {
  return typeof value === "string" && SKIN_NOTE_SHAPES.includes(value);
}

export function skinNoteShapeLabel(shape: SkinNoteShape): string {
  return shape === "circle" ? "Circles" : shape === "arrow" ? "Arrows" : shape === "bar" ? "Bars" : "Other";
}

// Which client a skin is for: "lazer" keeps skins carrying lazer-only
// modifications, "stable" keeps the rest.
export type SkinsClient = "lazer" | "stable";

// Suggestions in the upload and settings forms, nothing more: the field takes
// any WxH, and the browse filter offers whatever uploaders actually answered.
export const SKIN_RESOLUTION_PRESETS = ["1280x720", "1366x768", "1920x1080", "2560x1440", "3840x2160"] as const;

// Mirror of the backend's normalizeSkinResolution: what the upload form
// checks before offering to send the value at all.
export function normalizeSkinResolution(value: string): string | null {
  const match = /^\s*(\d{3,5})\s*[x×*]\s*(\d{3,5})\s*$/i.exec(value);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 240 || width > 16384 || height < 240 || height > 16384) return null;
  return `${width}x${height}`;
}

export interface SkinsListParams {
  q?: string;
  page?: number;
  sort?: SkinsSort;
  k?: number;
  variant?: SkinsKeymodeVariant;
  // One uploader's skins, the "uploader: you" filter. The list stays the public
  // one, so this shows that uploader's public skins only; their private ones
  // live on the shelf above the grid.
  owner?: number | null;
  // The trait filters: skins that ship a lane cover, their own mania stage
  // art, uploader-attached screenshots.
  cover?: boolean;
  stage?: boolean;
  shots?: boolean;
  client?: SkinsClient;
  shape?: SkinNoteShape;
  // Exact match on the normalized recommended resolution ("1920x1080").
  res?: string;
}

// The list endpoint is browser-cached (max-age=60 + stale-while-revalidate
// 300), which made a just-deleted skin linger on /skins even across reloads.
// Mutations stamp a deadline; until it passes, list fetches skip the HTTP
// cache and revalidate against the backend.
const SKINS_LIST_STALE_UNTIL_KEY = "mania-hub-skins-list-stale-until";
const SKINS_LIST_CACHE_WINDOW_MS = 6 * 60 * 1000;

export function markSkinsListStale(): void {
  skinsListMemory.clear();
  // A deleted or newly public skin leaves the private shelf too.
  privateShelfMemory = null;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SKINS_LIST_STALE_UNTIL_KEY, String(Date.now() + SKINS_LIST_CACHE_WINDOW_MS));
  } catch {
    // Private-mode storage failures just fall back to cached lists.
  }
}

// Coming back from a skin page remounts /skins and refires the list fetch, so
// the grid fell back to skeletons even though the exact same page had just been
// on screen. Results stay in memory for the tab's lifetime; the page renders
// them at once and revalidates quietly behind them.
const SKINS_LIST_MEMORY_TTL_MS = 5 * 60 * 1000;
const SKINS_LIST_MEMORY_MAX = 12;
const skinsListMemory = new Map<string, { at: number; result: SkinsListResult }>();

export function skinsListCacheKey(params: SkinsListParams): string {
  return [
    params.q?.trim() ?? "", params.page ?? 0, params.sort ?? "newest", params.k ?? 0, params.variant ?? "", params.owner ?? "",
    params.cover ? 1 : "", params.stage ? 1 : "", params.shots ? 1 : "", params.client ?? "", params.shape ?? "", params.res ?? "",
  ].join("|");
}

export function readCachedSkinsList(key: string): SkinsListResult | null {
  const entry = skinsListMemory.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SKINS_LIST_MEMORY_TTL_MS) {
    skinsListMemory.delete(key);
    return null;
  }
  return entry.result;
}

export function writeCachedSkinsList(key: string, result: SkinsListResult): void {
  skinsListMemory.set(key, { at: Date.now(), result });
  // Oldest insertion first, so the map stays bounded across a long browse.
  while (skinsListMemory.size > SKINS_LIST_MEMORY_MAX) {
    const oldest = skinsListMemory.keys().next();
    if (oldest.done) break;
    skinsListMemory.delete(oldest.value);
  }
}

// The skin page's back button wants the browse page exactly as it was left,
// filters, page and scroll included, which only a real history.back() gives.
// Opening a skin from the grid stamps the browse entry's history index; the
// back button only steps back when that entry is still the one behind it, so a
// skin opened from anywhere else falls back to a plain /skins navigation.
const SKINS_BROWSE_ENTRY_KEY = "mania-hub-skins-browse-entry";

export function rememberSkinsBrowseEntry(): void {
  if (typeof window === "undefined") return;
  if (!window.location.pathname.startsWith("/skins")) return;
  try {
    const index = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index;
    if (typeof index !== "number") return;
    window.sessionStorage.setItem(SKINS_BROWSE_ENTRY_KEY, String(index));
  } catch {
    // Storage failures just cost the back button its exact target.
  }
}

export function readSkinsBrowseEntry(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SKINS_BROWSE_ENTRY_KEY);
    const index = Number(raw);
    return raw != null && Number.isInteger(index) ? index : null;
  } catch {
    return null;
  }
}

function skinsListCacheMode(): RequestCache | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const until = Number(window.sessionStorage.getItem(SKINS_LIST_STALE_UNTIL_KEY));
    if (Number.isFinite(until) && until > Date.now()) return "no-cache";
  } catch {
    // Unreadable storage: keep default caching.
  }
  return undefined;
}

export async function fetchSkinsListDirect(params: SkinsListParams, init?: RequestInit): Promise<SkinsListResult> {
  const base = getLiveBackendUrl();
  if (!base) throw new Error("Server is not configured.");
  const query = new URLSearchParams();
  const q = params.q?.trim() ?? "";
  if (q) query.set("q", q.slice(0, 80));
  if (params.page) query.set("page", String(params.page));
  // Newest is the backend's default too, so only a moved sort travels.
  if (params.sort && params.sort !== "newest") query.set("sort", params.sort);
  if (params.k && Number.isInteger(params.k) && params.k >= 1 && params.k <= 10) {
    query.set("k", String(params.k));
    if (params.variant) query.set("variant", params.variant);
  }
  if (params.owner && Number.isInteger(params.owner) && params.owner > 0) query.set("owner", String(params.owner));
  if (params.cover) query.set("cover", "1");
  if (params.stage) query.set("stage", "1");
  if (params.shots) query.set("shots", "1");
  if (params.client) query.set("client", params.client);
  if (params.shape) query.set("shape", params.shape);
  if (params.res) query.set("res", params.res);
  query.set("pageSize", String(SKINS_PAGE_SIZE));
  const response = await fetch(`${base}/api/skins/list?${query.toString()}`, { credentials: "omit", cache: skinsListCacheMode(), ...init });
  if (!response.ok) throw new Error(`Server ${response.status}`);
  return response.json() as Promise<SkinsListResult>;
}

// How long a server render waits on the backend before giving up and shipping
// the page without its grid. The call is same-box and answers in single-digit
// milliseconds, so this only ever trips on a backend that is down or wedged on
// the write lock - and giving up costs nothing, since the page falls back to
// fetching the list from the browser the way it always did. Failing fast is
// what keeps a stalled backend from turning /skins into a blank tab.
const SKINS_SSR_TIMEOUT_MS = 800;

// The server-render twin of fetchSkinsListDirect: same public list, fetched
// over LIVE_BACKEND_URL (localhost on the VPS) rather than the public api host,
// and only ever the default view - no filters, page 0, newest. That is the one
// /skins URL in the sitemap and the only one a crawler lands on, and asking for
// it anonymously keeps the response the shared-cacheable one.
export async function fetchSkinsListSsr(): Promise<SkinsListResult | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/api/skins/list?pageSize=${SKINS_PAGE_SIZE}`, {
      signal: AbortSignal.timeout(SKINS_SSR_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as SkinsListResult;
    return Array.isArray(body?.skins) ? body : null;
  } catch {
    return null;
  }
}

// One sitemap row per public skin page. Nothing links to these in the
// server-rendered HTML beyond the first page of /skins, so the sitemap is the
// only crawl path the rest of them have.
export interface SkinSitemapEntry {
  path: string;
  // ISO instant of the last change to the skin, or null when unknown; the
  // caller turns it into a lastmod hint.
  lastmod: string | null;
}

// The backend clamps a list page to SKIN_LIST_MAX_PAGE_SIZE, so the whole
// catalogue takes a walk. 40 pages of 50 is 2000 skins: past that the sitemap
// comes up short by design instead of walking forever. Raise it if the count
// ever gets close.
const SKIN_SITEMAP_PAGE_CAP = 40;
const SKIN_SITEMAP_TIMEOUT_MS = 4000;

export async function fetchSkinSitemapEntries(): Promise<SkinSitemapEntry[]> {
  const base = getServerLiveBackendUrl();
  if (!base) return [];
  const entries: SkinSitemapEntry[] = [];
  let seen = 0;
  for (let page = 0; page < SKIN_SITEMAP_PAGE_CAP; page += 1) {
    let body: SkinsListResult;
    try {
      const response = await fetch(
        `${base}/api/skins/list?page=${page}&pageSize=${SKIN_LIST_MAX_PAGE_SIZE}`,
        { signal: AbortSignal.timeout(SKIN_SITEMAP_TIMEOUT_MS) },
      );
      if (!response.ok) break;
      body = (await response.json()) as SkinsListResult;
    } catch {
      // A page that fails mid-walk ends the walk: a sitemap missing its tail
      // still beats a 500, and the next request rebuilds the whole thing.
      break;
    }
    const skins = Array.isArray(body?.skins) ? body.skins : [];
    if (skins.length === 0) break;
    seen += skins.length;
    for (const skin of skins) {
      // An anonymous list is public-only already, but a private skin's page is
      // noindex and 404s for everyone but its uploader. The sitemap must never
      // be the thing that hands a crawler one of those URLs.
      if (skin.visibility === "private") continue;
      // The later of the two dates that change what a crawler finds here: a
      // replaced .osk, and the day the page became reachable at all. A skin
      // uploaded months ago and made public today is new to a crawler, so
      // dating it from the upload would announce it as stale on arrival.
      const listed = skin.listedAt ?? skin.publishedAt;
      const replaced = skin.oskUpdatedAt;
      entries.push({
        path: `/skins/${skin.slug ?? skin.id}`,
        lastmod: replaced && (!listed || replaced > listed) ? replaced : listed,
      });
    }
    if (skins.length < SKIN_LIST_MAX_PAGE_SIZE || seen >= (body.total ?? 0)) break;
  }
  return entries;
}

// A similar-skins entry: the summary plus which of its keymodes the backend's
// visual match was made on, so the strip can front that keymode's render
// instead of the uploader-chosen cover. Absent or null when the match came
// from the accent fallback (or an older backend).
export type SimilarSkin = SkinSummary & { matchKeys?: number | null };

// The detail page's similar-skins strip. The endpoint only answers for skins
// with a public page and only ever recommends public ones, so this is a plain
// browser fetch riding the shared cache; every failure mode is an empty strip.
export async function fetchSimilarSkins(ref: string, keys?: number | null, init?: RequestInit): Promise<SimilarSkin[]> {
  const base = getLiveBackendUrl();
  if (!base) return [];
  const query = new URLSearchParams({ id: ref });
  // The keymode on screen: the backend answers "similar at this keymode", so
  // a skin that only matches elsewhere in its range does not show up here.
  if (keys != null && Number.isInteger(keys) && keys >= 1 && keys <= 10) query.set("keys", String(keys));
  try {
    const response = await fetch(`${base}/api/skins/similar?${query.toString()}`, { credentials: "omit", ...init });
    if (!response.ok) return [];
    const body = (await response.json()) as { skins?: SimilarSkin[] };
    return Array.isArray(body.skins) ? body.skins : [];
  } catch {
    return [];
  }
}

export const fetchSkinById = createServerFn({ method: "GET" })
  .validator((data: { id?: unknown }) => {
    // Accepts a slug or a raw row id; slugs with the short-id collision
    // fallback can run past 64 chars, hence the wider cap.
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 80) throw new Error("Invalid skin id.");
    return { id };
  })
  .handler(async ({ data }): Promise<SkinSummary | null> => {
    const base = getServerLiveBackendUrl();
    if (!base) return null;
    // The signed-in viewer rides along with the bridge token so a true admin
    // reads hidden skins back (to unhide them); everyone else gets the public,
    // cacheable published-only view.
    const query = new URLSearchParams({ id: data.id });
    const headers: HeadersInit = {};
    try {
      const { readCurrentAuth } = await import("./auth-server");
      const auth = await readCurrentAuth();
      const bridgeToken = liveBridgeToken();
      if (auth.viewer && bridgeToken) {
        headers.authorization = `Bearer ${bridgeToken}`;
        query.set("viewerUserId", String(auth.viewer.id));
        if (auth.isAdmin) query.set("asAdmin", "1");
        const { setResponseHeader } = await import("@tanstack/react-start/server");
        setResponseHeader("Cache-Control", "private, no-store");
      }
    } catch {
      // Anonymous read path: no auth context available.
    }
    try {
      const response = await fetch(`${base}/api/skins/get?${query.toString()}`, { headers });
      if (!response.ok) return null;
      const body = (await response.json()) as { skin?: SkinSummary };
      return body.skin ?? null;
    } catch {
      return null;
    }
  });

// The skin that already holds the .osk bytes being uploaded, so the modal can
// link to it instead of just saying no.
export interface DuplicateSkinRef {
  id: string;
  slug: string | null;
  name: string;
  ownerUsername: string;
}

export type StartSkinUploadResult =
  | { ok: true; id: string; token: string; expiresAt: string }
  | { ok: false; error: "not_logged_in" | "unavailable" | "storage_not_configured" | "invalid_name" | "pending_limit" | "skin_limit" }
  | { ok: false; error: "duplicate"; duplicate: DuplicateSkinRef | null };

// SHA-256 of the picked .osk, hex, computed while the archive is being parsed.
// The backend rejects a hash that already belongs to a published skin, which
// turns a duplicate upload into an instant no instead of a 50MB transfer that
// fails at the end. Returns null wherever WebCrypto is unavailable (an
// insecure context); the server then catches the duplicate on its own hash.
export async function hashOskFile(file: Blob): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

interface SkinsBackend {
  base: string;
  headers: HeadersInit;
  userId: number;
  username: string;
  // A true admin, the same flag requireTrueAdminAccess checks. Moderation
  // paths forward it so an admin can fix up someone else's skin.
  isAdmin: boolean;
}

async function resolveSkinsBackend(): Promise<SkinsBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { base, headers, userId: auth.viewer.id, username: auth.viewer.username, isAdmin: auth.isAdmin === true };
}

export const startSkinUpload = createServerFn({ method: "POST" })
  .validator((data: { name?: unknown; author?: unknown; description?: unknown; oskSha256?: unknown; visibility?: unknown; resolution?: unknown }) => ({
    name: typeof data.name === "string" ? data.name.slice(0, 80) : "",
    author: typeof data.author === "string" ? data.author.slice(0, SKIN_AUTHOR_MAX_LENGTH) : "",
    description: typeof data.description === "string" ? data.description.slice(0, SKIN_DESCRIPTION_MAX_LENGTH) : "",
    oskSha256: typeof data.oskSha256 === "string" && /^[0-9a-f]{64}$/i.test(data.oskSha256)
      ? data.oskSha256.toLowerCase()
      : null,
    visibility: (data.visibility === "private" ? "private" : "public") as SkinVisibility,
    resolution: typeof data.resolution === "string" ? normalizeSkinResolution(data.resolution) : null,
  }))
  .handler(async ({ data }): Promise<StartSkinUploadResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false, error: "not_logged_in" };
    try {
      const response = await fetch(`${cfg.base}/api/skins/start`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          username: cfg.username,
          name: data.name,
          author: data.author,
          description: data.description,
          oskSha256: data.oskSha256,
          visibility: data.visibility,
          resolution: data.resolution,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: string; error?: string; duplicate?: DuplicateSkinRef }
        | null;
      if (response.ok && body?.ok && body.id && body.token) {
        return { ok: true, id: body.id, token: body.token, expiresAt: body.expiresAt ?? "" };
      }
      if (body?.error === "duplicate") {
        return { ok: false, error: "duplicate", duplicate: body.duplicate ?? null };
      }
      if (body?.error === "invalid_name" || body?.error === "pending_limit" || body?.error === "skin_limit") {
        return { ok: false, error: body.error };
      }
      if (body?.error === "skin_storage_not_configured") {
        return { ok: false, error: "storage_not_configured" };
      }
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

// The bulk uploader's ticket mint. Same route as startSkinUpload, but it
// verifies a true admin and asks the backend to skip the per-user caps: a
// seeding run publishes a whole collection under one account, and the caps
// exist to stop a visitor filling storage. Duplicates are still refused.
export const startAdminSkinUpload = createServerFn({ method: "POST" })
  .validator((data: { name?: unknown; author?: unknown; description?: unknown; oskSha256?: unknown }) => ({
    name: typeof data.name === "string" ? data.name.slice(0, 80) : "",
    author: typeof data.author === "string" ? data.author.slice(0, SKIN_AUTHOR_MAX_LENGTH) : "",
    description: typeof data.description === "string" ? data.description.slice(0, SKIN_DESCRIPTION_MAX_LENGTH) : "",
    oskSha256: typeof data.oskSha256 === "string" && /^[0-9a-f]{64}$/i.test(data.oskSha256)
      ? data.oskSha256.toLowerCase()
      : null,
  }))
  .handler(async ({ data }): Promise<StartSkinUploadResult> => {
    const { requireTrueAdminAccess } = await import("./auth-server");
    await requireTrueAdminAccess("Bulk skin upload");
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false, error: "not_logged_in" };
    try {
      const response = await fetch(`${cfg.base}/api/skins/start`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          username: cfg.username,
          name: data.name,
          author: data.author,
          description: data.description,
          oskSha256: data.oskSha256,
          bypassLimits: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: string; error?: string; duplicate?: DuplicateSkinRef }
        | null;
      if (response.ok && body?.ok && body.id && body.token) {
        return { ok: true, id: body.id, token: body.token, expiresAt: body.expiresAt ?? "" };
      }
      if (body?.error === "duplicate") {
        return { ok: false, error: "duplicate", duplicate: body.duplicate ?? null };
      }
      if (body?.error === "invalid_name") return { ok: false, error: "invalid_name" };
      if (body?.error === "skin_storage_not_configured") return { ok: false, error: "storage_not_configured" };
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

export const deleteMySkin = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid skin id.");
    return { id };
  })
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/delete`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id }),
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  });

// Repoints an already published skin's card cover at another stored image: a
// keymode's rendered playfield, or one of the uploader's own screenshots by
// position. No re-render, no upload: the images all exist, this only says which
// one fronts the card.
export const setSkinCover = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; keys?: unknown; screenshot?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid cover request.");
    if (data.screenshot !== undefined) {
      const screenshot = Math.round(Number(data.screenshot));
      if (!Number.isInteger(screenshot) || screenshot < 0 || screenshot >= SKIN_MAX_SCREENSHOTS) {
        throw new Error("Invalid cover request.");
      }
      return { id, screenshot };
    }
    const keys = Math.round(Number(data.keys));
    if (!Number.isInteger(keys) || keys < 1 || keys > 10) throw new Error("Invalid cover request.");
    return { id, keys };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/cover`, {
        method: "POST",
        headers: cfg.headers,
        // data is { id, keys } or { id, screenshot }; which one it carries is
        // what picks the target server-side.
        body: JSON.stringify({ userId: cfg.userId, asAdmin: cfg.isAdmin, ...data }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// Renames a published skin's screenshots, by position: "Score screen" instead
// of "Shot 2". An empty entry puts that shot back to being numbered, and the
// list is read against the screenshots the row already holds, so it never adds
// or removes one.
export const setSkinScreenshotLabels = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; labels?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const labels = Array.isArray(data.labels)
      ? data.labels.map((entry) => (typeof entry === "string" ? entry.slice(0, SKIN_SCREENSHOT_LABEL_MAX_LENGTH) : ""))
      : null;
    if (!id || id.length > 64 || !labels || labels.length > SKIN_MAX_SCREENSHOTS) {
      throw new Error("Invalid screenshot names request.");
    }
    return { id, labels };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/screenshot-labels`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id, labels: data.labels, asAdmin: cfg.isAdmin }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok || !body.skin) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// Removes one of a published skin's screenshots by position, for a shot that
// has nothing to do with the skin. Owners prune their own; admins and the
// keymode moderators can prune any public skin's. The stored image is deleted
// for good, and if it fronted the browse card the cover falls back to a
// rendered playfield server-side.
export const removeSkinScreenshot = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; screenshot?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const screenshot = Math.round(Number(data.screenshot));
    if (!id || id.length > 64 || !Number.isInteger(screenshot) || screenshot < 0 || screenshot >= SKIN_MAX_SCREENSHOTS) {
      throw new Error("Invalid screenshot removal request.");
    }
    return { id, screenshot };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/screenshot-remove`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          id: data.id,
          screenshot: data.screenshot,
          asAdmin: cfg.isAdmin,
          asKeymodeModerator: !cfg.isAdmin && canModerateSkinKeymodes(cfg.userId),
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok || !body.skin) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// Corrects which of a skin's keymodes are really (N-1)+1 layouts. Detection
// reads skin.ini's separator lines, which plenty of 7K+1 skins never set, so
// the uploader gets the last word; once set, re-uploads keep the manual list.
// Admins and the keymode moderators can also correct anyone's public skin.
export const setSkinSpecialKeymodes = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; specialKeymodes?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const specialKeymodes = Array.isArray(data.specialKeymodes)
      ? data.specialKeymodes.map((entry) => Math.round(Number(entry)))
      : null;
    if (!id || id.length > 64 || !specialKeymodes || specialKeymodes.length > 10
      || specialKeymodes.some((keys) => !Number.isInteger(keys) || keys < 2 || keys > 10)) {
      throw new Error("Invalid keymodes request.");
    }
    return { id, specialKeymodes };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/special-keymodes`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          id: data.id,
          specialKeymodes: data.specialKeymodes,
          asAdmin: cfg.isAdmin,
          asKeymodeModerator: !cfg.isAdmin && canModerateSkinKeymodes(cfg.userId),
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok || !body.skin) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// Retitles an already published skin and rewrites its description. The URL slug
// is not rebuilt: it was assigned at publish time and is what shared links point
// at. Leaving description out keeps the stored one; an empty string clears it.
export const updateSkinDetails = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; name?: unknown; description?: unknown; resolution?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const name = typeof data.name === "string" ? data.name.slice(0, SKIN_NAME_MAX_LENGTH).trim() : "";
    if (!id || id.length > 64 || !name) throw new Error("Invalid skin details request.");
    const description = typeof data.description === "string"
      ? data.description.slice(0, SKIN_DESCRIPTION_MAX_LENGTH)
      : undefined;
    // Same omission semantics the description has: leaving it out keeps the
    // stored value, an empty or unreadable string clears it.
    const resolution = typeof data.resolution === "string"
      ? (normalizeSkinResolution(data.resolution) ?? "")
      : undefined;
    return { id, name, description, resolution };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/details`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          id: data.id,
          name: data.name,
          description: data.description,
          resolution: data.resolution,
          asAdmin: cfg.isAdmin,
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok || !body.skin) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// Moves a published skin between the catalog and the uploader's own shelf.
// Turning private takes the skin off /skins, closes its page to everyone else
// and moves its .osk to a key the old download link no longer reaches; the
// backend hands back the skin as it now stands, with the owner's capability
// URLs on it.
export const setMySkinVisibility = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; visibility?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid skin id.");
    return { id, visibility: (data.visibility === "private" ? "private" : "public") as SkinVisibility };
  })
  .handler(async ({ data }): Promise<{ ok: boolean; skin?: SkinSummary }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/skins/visibility`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id, visibility: data.visibility, asAdmin: cfg.isAdmin }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary } | null;
      if (!response.ok || !body?.ok || !body.skin) return { ok: false };
      return { ok: true, skin: body.skin };
    } catch {
      return { ok: false };
    }
  });

// The private-skins shelf. For a normal viewer that is their own private skins:
// absent from the browse grid by design, so this is the only way back to their
// pages. For a true admin it is every uploader's private skins, the same
// moderation read /api/skins/get already grants on a single one. It goes
// through a server fn because the list endpoint only trusts an owner id (and an
// admin claim) that arrives with the bridge token.
export interface PrivateSkinsShelf {
  skins: SkinSummary[];
  // Rows matching the shelf query, which can exceed the page fetched above.
  total: number;
}

export const fetchPrivateSkinsShelf = createServerFn({ method: "GET" })
  .handler(async (): Promise<PrivateSkinsShelf> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { skins: [], total: 0 };
    const query = new URLSearchParams({
      visibility: "private",
      viewerUserId: String(cfg.userId),
      pageSize: String(cfg.isAdmin ? SKIN_LIST_MAX_PAGE_SIZE : SKIN_MAX_PER_USER),
    });
    if (cfg.isAdmin) {
      query.set("asAdmin", "1");
      query.set("allPrivate", "1");
    }
    try {
      const response = await fetch(`${cfg.base}/api/skins/list?${query.toString()}`, { headers: cfg.headers });
      if (!response.ok) return { skins: [], total: 0 };
      const body = (await response.json()) as SkinsListResult;
      const skins = Array.isArray(body.skins) ? body.skins : [];
      return { skins, total: Number(body.total) || skins.length };
    } catch {
      return { skins: [], total: 0 };
    }
  });

// The shelf is a per-viewer read behind a server fn, so it lands a beat after
// the grid and used to shove the grid down as it arrived. What it last held
// stays in memory for the tab, which paints it with the grid on the way back
// from a skin page, and its size is remembered across reloads, which is enough
// to hold its space while the fetch runs. Browser only, deliberately: this
// module also runs on the server, where one viewer's private skins must never
// sit in something another request could read.
const PRIVATE_SHELF_MEMORY_TTL_MS = 5 * 60 * 1000;
const PRIVATE_SHELF_SIZE_KEY = "mania-hub-skins-private-size";
const PRIVATE_SHELF_OPEN_KEY = "mania-hub-skins-private-open";
let privateShelfMemory: { at: number; viewerId: number; shelf: PrivateSkinsShelf } | null = null;

export function readCachedPrivateShelf(viewerId: number): PrivateSkinsShelf | null {
  if (typeof window === "undefined") return null;
  const entry = privateShelfMemory;
  if (!entry || entry.viewerId !== viewerId) return null;
  if (Date.now() - entry.at > PRIVATE_SHELF_MEMORY_TTL_MS) {
    privateShelfMemory = null;
    return null;
  }
  return entry.shelf;
}

export function writeCachedPrivateShelf(viewerId: number, shelf: PrivateSkinsShelf): void {
  if (typeof window === "undefined") return;
  privateShelfMemory = { at: Date.now(), viewerId, shelf };
  try {
    window.localStorage.setItem(PRIVATE_SHELF_SIZE_KEY, `${viewerId}:${shelf.skins.length}`);
  } catch {
    // Private-mode storage failures only cost the held space.
  }
}

// How many cards the shelf held for this viewer last time, so a cold load can
// stand the row up at its real height instead of inserting it mid-paint. 0
// when nothing is remembered, which reads the same as an empty shelf.
export function readRememberedPrivateShelfSize(viewerId: number): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(PRIVATE_SHELF_SIZE_KEY);
    if (!raw) return 0;
    const [id, size] = raw.split(":");
    if (Number(id) !== viewerId) return 0;
    const count = Number(size);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

// Whether the shelf is open, or null when the viewer has never said. The
// caller picks the default: an admin's shelf is a moderation list of other
// people's skins and starts shut, an uploader's own handful starts open.
export function readPrivateShelfOpen(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PRIVATE_SHELF_OPEN_KEY);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writePrivateShelfOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRIVATE_SHELF_OPEN_KEY, open ? "1" : "0");
  } catch {
    // A forgotten preference just falls back to the default next visit.
  }
}

// Mints an upload ticket against a published skin. Scope "previews" only
// unlocks preview re-renders (a different backdrop, say); "replace" also takes
// a newer .osk, which is how an uploader ships an updated build without
// republishing. Screenshots stay as published either way.
export type SkinEditScope = "previews" | "replace";

export const startSkinEdit = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; scope?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    if (!id || id.length > 64) throw new Error("Invalid skin id.");
    return { id, scope: (data.scope === "replace" ? "replace" : "previews") as SkinEditScope };
  })
  .handler(async ({ data }): Promise<StartSkinUploadResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveSkinsBackend();
    if (!cfg) return { ok: false, error: "not_logged_in" };
    try {
      const response = await fetch(`${cfg.base}/api/skins/edit-start`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id, scope: data.scope, asAdmin: cfg.isAdmin }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; id?: string; token?: string; expiresAt?: string; error?: string }
        | null;
      if (response.ok && body?.ok && body.id && body.token) {
        return { ok: true, id: body.id, token: body.token, expiresAt: body.expiresAt ?? "" };
      }
      if (body?.error === "skin_storage_not_configured") return { ok: false, error: "storage_not_configured" };
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

// Closes an edit ticket and hands back the skin as it now stands. Direct to
// the backend like finishSkinUpload: the ticket is the credential.
export async function finishSkinEdit(
  id: string,
  token: string,
  recipes: SkinPreviewRecipeUpdate[] = [],
): Promise<SkinSummary> {
  const base = getLiveBackendUrl();
  if (!base) throw new SkinUploadError("unavailable", "Server is not configured.");
  const query = new URLSearchParams({ id, token });
  const response = await fetch(`${base}/api/skins/edit-finish?${query.toString()}`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipes }),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; skin?: SkinSummary; error?: string } | null;
  if (!response.ok || !body?.ok || !body.skin) {
    const code = body?.error ?? "upload_failed";
    throw new SkinUploadError(code, uploadErrorMessage(code, response.status), response.status);
  }
  return body.skin;
}

export const moderateSkin = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; action?: unknown }) => {
    const id = typeof data.id === "string" ? data.id.trim() : "";
    const action = data.action === "hide" || data.action === "unhide" || data.action === "delete" ? data.action : null;
    if (!id || id.length > 64 || !action) throw new Error("Invalid moderation request.");
    return { id, action };
  })
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { requireTrueAdminAccess } = await import("./auth-server");
    await requireTrueAdminAccess("Skin moderation");
    const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
    if (!base) return { ok: false };
    const headers: HeadersInit = { "content-type": "application/json" };
    // The moderation route lives under /api/admin/, so it takes the admin token.
    if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
    try {
      const response = await fetch(`${base}/api/admin/skins/moderate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: data.id, action: data.action }),
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  });

export type SkinUploadPart = "osk" | "preview" | "screenshot";

export class SkinUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    // Set on code === "duplicate": the published skin holding these bytes.
    readonly duplicate?: DuplicateSkinRef | null,
    // Set on code === "rate_limited": how long the backend says to wait. The
    // bulk uploader sleeps exactly that long instead of guessing a pace.
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
  }
}

// XMLHttpRequest instead of fetch: only XHR exposes upload progress events,
// and the 65MB .osk deserves a real progress bar.
export function uploadSkinPart(options: {
  id: string;
  token: string;
  part: SkinUploadPart;
  blob: Blob;
  width?: number | null;
  height?: number | null;
  // For part=preview: which keymode this render shows. A preview also carries
  // the note-art accent sampled during the render, which beats the skin.ini
  // colours parsed server-side. For part=screenshot: what the uploader called
  // it. Either part can be the card cover.
  keys?: number;
  cover?: boolean;
  accent?: string;
  label?: string;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}): Promise<void> {
  const base = getLiveBackendUrl();
  if (!base) return Promise.reject(new SkinUploadError("unavailable", "Server is not configured."));
  const query = new URLSearchParams({ id: options.id, token: options.token, part: options.part });
  if (options.width) query.set("w", String(Math.round(options.width)));
  if (options.height) query.set("h", String(Math.round(options.height)));
  if (options.keys) query.set("keys", String(Math.round(options.keys)));
  if (options.cover) query.set("cover", "1");
  if (options.accent && /^#[0-9a-f]{6}$/i.test(options.accent)) query.set("accent", options.accent);
  if (options.label?.trim()) query.set("label", options.label.trim().slice(0, SKIN_SCREENSHOT_LABEL_MAX_LENGTH));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/api/skins/upload?${query.toString()}`);
    xhr.responseType = "json";
    if (options.onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      const body = xhr.response as { error?: string; reason?: string; duplicate?: DuplicateSkinRef; retryAfterMs?: number } | null;
      const code = body?.error === "invalid_osk" && body.reason ? `invalid_osk:${body.reason}` : body?.error ?? "upload_failed";
      reject(new SkinUploadError(code, uploadErrorMessage(code, xhr.status), xhr.status, body?.duplicate ?? null, body?.retryAfterMs ?? null));
    };
    xhr.onerror = () => reject(new SkinUploadError("network", "The upload failed. Check the connection and try again."));
    xhr.onabort = () => reject(new SkinUploadError("aborted", "The upload was cancelled."));
    xhr.send(options.blob);
  });
}

// Preview images are independent objects, and waiting for the complete R2
// round trip of one before starting the next makes multi-keymode skins feel
// much slower than their byte size warrants. Keep the fan-out deliberately
// small: three connections overlap network/storage latency without turning a
// ten-keymode skin into a burst of ten costly requests.
export const SKIN_PREVIEW_UPLOAD_CONCURRENCY = 3;

export interface SkinPreviewUploadItem {
  keys: number;
  sizeBytes: number;
}

export interface SkinPreviewUploadProgress {
  sentBytes: number;
  completed: number;
  total: number;
  activeKeys: number[];
}

export async function uploadSkinPreviewsParallel<T extends SkinPreviewUploadItem>(
  items: readonly T[],
  upload: (item: T, onProgress: (sentBytes: number) => void) => Promise<void>,
  onProgress?: (progress: SkinPreviewUploadProgress) => void,
): Promise<void> {
  if (items.length === 0) return;
  const sent = items.map(() => 0);
  const active = new Set<number>();
  let cursor = 0;
  let completed = 0;
  let failed = false;
  let firstError: unknown;
  const report = () => onProgress?.({
    sentBytes: sent.reduce((sum, bytes) => sum + bytes, 0),
    completed,
    total: items.length,
    activeKeys: [...active].map((index) => items[index].keys).sort((a, b) => a - b),
  });

  const worker = async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      active.add(index);
      report();
      try {
        await upload(item, (sentBytes) => {
          sent[index] = Math.max(sent[index], Math.min(item.sizeBytes, Math.max(0, sentBytes)));
          report();
        });
        sent[index] = item.sizeBytes;
        completed += 1;
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      } finally {
        active.delete(index);
        report();
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(SKIN_PREVIEW_UPLOAD_CONCURRENCY, items.length) },
    () => worker(),
  ));
  if (failed) throw firstError;
}

function tr(locale: AppLocale, descriptor: MessageDescriptor): string {
  return getI18n(locale)._(descriptor);
}

export function skinPreviewUploadLabel(
  activeKeys: readonly number[],
  completed: number,
  total: number,
  locale: AppLocale = "en",
): string {
  if (activeKeys.length === 1) {
    const keys = activeKeys[0];
    return tr(locale, msg`Uploading the ${keys}K preview.`);
  }
  if (activeKeys.length > 1) {
    const list = activeKeys.map((keys) => `${keys}K`).join(", ");
    return tr(locale, msg`Uploading ${list} previews.`);
  }
  return completed >= total ? tr(locale, msg`Previews uploaded.`) : tr(locale, msg`Uploading previews.`);
}

export async function finishSkinUpload(
  id: string,
  token: string,
  recipes: SkinPreviewRecipeUpdate[] = [],
): Promise<SkinSummary> {
  const base = getLiveBackendUrl();
  if (!base) throw new SkinUploadError("unavailable", "Server is not configured.");
  const query = new URLSearchParams({ id, token });
  const response = await fetch(`${base}/api/skins/finish?${query.toString()}`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipes }),
  });
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; skin?: SkinSummary; error?: string; retryAfterMs?: number }
    | null;
  if (!response.ok || !body?.ok || !body.skin) {
    const code = body?.error ?? "upload_failed";
    throw new SkinUploadError(code, uploadErrorMessage(code, response.status), response.status, null, body?.retryAfterMs ?? null);
  }
  return body.skin;
}

export function uploadErrorMessage(code: string, status?: number): string {
  if (status === 413 || code === "payload_too_large") return "The file is over the 50 MB limit.";
  if (code === "invalid_ticket") return "The upload session expired. Publish again to restart.";
  if (code.startsWith("invalid_osk")) {
    if (code.includes("missing_skin_ini")) return "No skin.ini was found in this .osk file.";
    if (code.includes("no_mania_keymodes")) return "The skin.ini has no [Mania] section, so this skin has no mania keymodes.";
    if (code.includes("not_a_zip") || code.includes("zip_unreadable")) return "This file is not a readable .osk archive.";
    return "This .osk could not be validated as a mania skin.";
  }
  if (code === "duplicate") return "This exact .osk is already published on the site.";
  if (code === "invalid_image") return "Screenshots must be PNG, JPEG, or WebP images.";
  if (code === "screenshot_limit") return `A skin can have up to ${SKIN_MAX_SCREENSHOTS} screenshots.`;
  if (code === "rate_limited") return "Too many upload requests. Wait a minute and try again.";
  if (status === 503 || code === "skin_storage_not_configured") return "Skin storage is not available right now.";
  return "The upload failed. Try again.";
}

// The counted download. Private skins have none: their file is not public, so
// the owner's page links straight at the capability URL on the summary.
export function skinDownloadUrl(id: string): string | null {
  const base = getLiveBackendUrl();
  return base ? `${base}/api/skins/download?id=${encodeURIComponent(id)}` : null;
}

// The counted view. It is its own endpoint rather than a side effect of
// loading the page because that load happens in a server function: the
// backend would see this server's address for every reader and its
// per-visitor dedup would collapse them into one.
export function skinViewUrl(ref: string): string | null {
  const base = getLiveBackendUrl();
  return base ? `${base}/api/skins/view?id=${encodeURIComponent(ref)}` : null;
}

// Fires the counted view: the skin page pings it on open, the browse card on
// a settled hover or a grid download. Fire-and-forget - a view that failed to
// register is not worth a message anywhere it is called from.
export function pingSkinView(ref: string): void {
  const url = skinViewUrl(ref);
  if (!url) return;
  void fetch(url, { method: "POST", credentials: "omit", keepalive: true }).catch(() => {});
}

// The grid's batch of the same, one request for every card a scroll showed.
// The body goes as the default text/plain so the browser sends it without a
// preflight, same as the single ping; the backend parses it as JSON anyway.
export function skinViewsUrl(): string | null {
  const base = getLiveBackendUrl();
  return base ? `${base}/api/skins/views` : null;
}

export function pingSkinViews(refs: string[]): void {
  const url = skinViewsUrl();
  if (!url || refs.length === 0) return;
  void fetch(url, { method: "POST", credentials: "omit", keepalive: true, body: JSON.stringify({ ids: refs }) }).catch(() => {});
}

// CORS-safe .osk fetch for in-page features (asset explorer, map preview):
// the backend streams the stored object by filename without counting it as a
// download the way /api/skins/download does. A private skin's oskUrl carries
// the ?t= capability that unlocks the object, and it has to survive the
// rewrite - without it the endpoint 404s, which is the whole point.
export function skinOskFileUrl(skin: Pick<SkinSummary, "id" | "oskUrl">): string | null {
  const base = getLiveBackendUrl();
  if (!base || !skin.oskUrl) return null;
  const [path, query] = skin.oskUrl.split("?");
  // The oskUrl path segment is already percent-encoded; decode before
  // re-encoding or filenames with spaces get double-encoded into 404s.
  const encoded = path.split("/").pop();
  if (!encoded) return null;
  let filename = encoded;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    // Malformed escape: treat the segment as a literal filename.
  }
  const token = new URLSearchParams(query ?? "").get("t");
  const suffix = token ? `?t=${encodeURIComponent(token)}` : "";
  return `${base}/api/skins/file/${encodeURIComponent(skin.id)}/${encodeURIComponent(filename)}${suffix}`;
}

export function formatSkinFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

// "8K" ordinarily, "7K+1" when the skin declares that keymode as a scratch
// layout; every pill and preview label goes through this so the two never
// disagree about what an 8K block really is.
// What a screenshot is called in the gallery: the uploader's own name for it,
// or its position when they left it unnamed.
export function skinScreenshotLabel(shot: SkinScreenshot, index: number): string {
  return shot.label?.trim() || `Shot ${index + 1}`;
}

export function keymodeLabel(keys: number, specialKeymodes?: number[]): string {
  return specialKeymodes?.includes(keys) ? `${keys - 1}K+1` : `${keys}K`;
}

export function formatKeymodes(keymodes: number[], specialKeymodes?: number[]): string {
  if (keymodes.length === 0) return "";
  const labels = keymodes.map((keys) => keymodeLabel(keys, specialKeymodes));
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
