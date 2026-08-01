/* The admin analytics feed's reading layer: turns a captured event row into a
   short sentence ("searched \"camellia\" in Maps"), groups rows into visitor
   sessions, and formats the clock bits around them. Kept free of React and of
   server imports so it stays unit-testable. */

export type AnalyticsDeviceKind = "mobile" | "desktop" | "unknown";

export interface AnalyticsRecentEventRow {
  eventId: string | null;
  /* Display label from the backend, in the site owner's timezone. */
  timestamp: string;
  /* Epoch ms; drives ageing, ordering and session stitching. */
  ts: number;
  event: string;
  path: string;
  country: string | null;
  selectedCountry: string | null;
  deviceKind: AnalyticsDeviceKind;
  distinctId: string;
  mapsTab: string | null;
  mapsQuery: string | null;
  mapsFilters: string | null;
  mapsSort: string | null;
  mapsCollection: string | null;
  mapsPage: string | null;
  mapsBeatmapId: string | null;
  rankingsPage: string | null;
  profileUsername: string | null;
  replayPlayer: string | null;
  replayScoreId: string | null;
  replayTitle: string | null;
  replayArtist: string | null;
  replayDifficulty: string | null;
  viewUrl: string | null;
  farmHelperUser: string | null;
  farmMapTitle: string | null;
  farmMapUser: string | null;
  packType: string | null;
  packUsername: string | null;
  skinsQuery: string | null;
  skinsKeys: string | null;
  skinsSort: string | null;
  skinsPage: string | null;
  skinRef: string | null;
  skinName: string | null;
  skinKeymodes: string | null;
  skinUploadError: string | null;
  viewerUsername: string | null;
  referrer: string | null;
}

/* One bucket per kind of thing a visitor can be doing. Drives the feed's
   colour, icon and quick filters. */
export type AnalyticsActivityKind =
  | "visit"
  | "search"
  | "replay"
  | "profile"
  | "farm"
  | "pack"
  | "skin"
  | "error";

export const ANALYTICS_ACTIVITY_KINDS: AnalyticsActivityKind[] = [
  "visit",
  "search",
  "replay",
  "profile",
  "farm",
  "pack",
  "skin",
  "error",
];

export interface AnalyticsActivity {
  kind: AnalyticsActivityKind;
  /* "searched", "watched", ... - the sentence's verb. */
  verb: string;
  /* The thing acted on; rendered bright. */
  subject: string;
  /* Trailing context; rendered dim. */
  detail: string | null;
}

const ANALYTICS_MAPS_TAB_LABELS: Record<string, string> = {
  search: "Search",
  collections: "Collections",
  farmed: "Most farmed",
  popular: "Widely played",
  favourites: "Community favorites",
  random: "Random picks",
};

const ANALYTICS_PACK_TYPE_LABELS: Record<string, string> = {
  standard: "Standard",
  wild: "Wild",
  elite: "Elite",
  legend: "Legend",
};

const SIMPLE_PAGE_LABELS: Record<string, string> = {
  "/tracker": "the tracker",
  "/top-plays": "top plays",
  "/snipes": "snipes",
  "/packs": "card packs",
  "/rankings": "the rankings",
  "/settings": "settings",
  "/bbcode": "the BBCode editor",
  "/discord": "the Discord page",
};

export function formatAnalyticsMapsTab(tab: string | null): string {
  // No tab recorded means the default view, which is search.
  if (!tab) return ANALYTICS_MAPS_TAB_LABELS.search;
  return ANALYTICS_MAPS_TAB_LABELS[tab] ?? tab;
}

export function formatAnalyticsPackType(type: string | null): string {
  if (!type) return "pack";
  return ANALYTICS_PACK_TYPE_LABELS[type] ?? type;
}

// Pull a query param off the captured $current_url. Used as a fallback so the
// inline label (e.g. who farm help was viewed for) still resolves for events
// captured before the dedicated property existed.
export function analyticsUrlParam(url: string | null, key: string): string | null {
  if (!url) return null;
  try {
    const value = new URL(url).searchParams.get(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export interface AnalyticsReplayMapInfo {
  title: string | null;
  artist: string | null;
  difficulty: string | null;
}

export type AnalyticsReplayMapIndex = Map<string, AnalyticsReplayMapInfo>;

export function analyticsReplayScoreId(row: AnalyticsRecentEventRow): string | null {
  return row.replayScoreId || analyticsUrlParam(row.viewUrl, "scoreId");
}

// The /replay pageview fires while the score is still loading, so only the
// follow-up replay_view event knows the map. Both carry the same score id, so
// the feed borrows the map details from whichever event in view has them.
export function buildAnalyticsReplayMapIndex(rows: AnalyticsRecentEventRow[]): AnalyticsReplayMapIndex {
  const index: AnalyticsReplayMapIndex = new Map();
  for (const row of rows) {
    if (!row.replayTitle) continue;
    const scoreId = analyticsReplayScoreId(row);
    if (!scoreId || index.has(scoreId)) continue;
    index.set(scoreId, { title: row.replayTitle, artist: row.replayArtist, difficulty: row.replayDifficulty });
  }
  return index;
}

function joinDetail(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part && part.trim()));
  return kept.length ? kept.join(" · ") : null;
}

function replayMapName(row: AnalyticsRecentEventRow, mapIndex?: AnalyticsReplayMapIndex): string | null {
  const scoreId = analyticsReplayScoreId(row);
  const borrowed = scoreId ? mapIndex?.get(scoreId) : undefined;
  const title = row.replayTitle || borrowed?.title || null;
  if (!title) return null;
  const artist = row.replayArtist || borrowed?.artist || null;
  const difficulty = row.replayDifficulty || borrowed?.difficulty || null;
  return `${artist ? `${artist} - ` : ""}${title}${difficulty ? ` [${difficulty}]` : ""}`;
}

function describeMaps(row: AnalyticsRecentEventRow): AnalyticsActivity {
  const where = joinDetail([
    `in Maps · ${formatAnalyticsMapsTab(row.mapsTab)}`,
    row.mapsCollection,
    row.mapsFilters,
    row.mapsSort ? `sort: ${row.mapsSort}` : null,
    row.mapsPage ? `page ${row.mapsPage}` : null,
  ]);
  // Every keystroke lands as its own pageview, so the typed query is the story;
  // without one this is plain browsing of a tab.
  if (row.mapsQuery) {
    return { kind: "search", verb: "searched", subject: `"${row.mapsQuery}"`, detail: where };
  }
  if (row.mapsBeatmapId) {
    return { kind: "visit", verb: "opened", subject: `map #${row.mapsBeatmapId}`, detail: where };
  }
  return {
    kind: "visit",
    verb: "browsed",
    subject: `Maps · ${formatAnalyticsMapsTab(row.mapsTab)}`,
    detail: joinDetail([
      row.mapsCollection,
      row.mapsFilters,
      row.mapsSort ? `sort: ${row.mapsSort}` : null,
      row.mapsPage ? `page ${row.mapsPage}` : null,
    ]),
  };
}

function describeSkinsList(row: AnalyticsRecentEventRow): AnalyticsActivity {
  const facets = joinDetail([
    row.skinsKeys,
    row.skinsSort ? `sort: ${row.skinsSort}` : null,
    row.skinsPage ? `page ${row.skinsPage}` : null,
  ]);
  if (row.skinsQuery) {
    return {
      kind: "search",
      verb: "searched",
      subject: `"${row.skinsQuery}"`,
      detail: joinDetail(["in Skins", facets]),
    };
  }
  return { kind: "skin", verb: "browsed", subject: "Skins", detail: facets };
}

/* One captured row as a sentence the admin can skim: verb, subject, context. */
export function describeAnalyticsEvent(
  row: AnalyticsRecentEventRow,
  replayMaps?: AnalyticsReplayMapIndex,
): AnalyticsActivity {
  // Explicit events first: they say more than the page they happened on.
  switch (row.event) {
    case "replay_view": {
      const map = replayMapName(row, replayMaps);
      return {
        kind: "replay",
        verb: "watched",
        subject: map ?? "a replay",
        detail: row.replayPlayer ? `by ${row.replayPlayer}` : null,
      };
    }
    case "skin_download":
      return { kind: "skin", verb: "downloaded", subject: row.skinName || row.skinRef || "a skin", detail: row.skinKeymodes };
    case "skin_upload_published":
      return { kind: "skin", verb: "published", subject: row.skinName || row.skinRef || "a skin", detail: null };
    case "skin_previews_edited":
      return { kind: "skin", verb: "edited previews on", subject: row.skinName || row.skinRef || "a skin", detail: null };
    case "skin_file_updated":
      return { kind: "skin", verb: "shipped a new build of", subject: row.skinName || row.skinRef || "a skin", detail: row.skinKeymodes };
    case "skin_upload_failed":
      return { kind: "error", verb: "failed", subject: "a skin upload", detail: row.skinUploadError };
    case "pack_open": {
      const packType = formatAnalyticsPackType(row.packType);
      return {
        kind: "pack",
        verb: "opened",
        subject: `${/^[aeiou]/i.test(packType) ? "an" : "a"} ${packType} pack`,
        detail: row.packUsername ? `as ${row.packUsername}` : "as a guest",
      };
    }
    case "replay_watch_crash":
    case "replay_renderer_error":
      return { kind: "error", verb: "crashed", subject: "the replay viewer", detail: replayMapName(row, replayMaps) };
    case "replay_load_slow":
      return { kind: "error", verb: "waited on", subject: "a slow replay load", detail: replayMapName(row, replayMaps) };
    case "replay_upload_beatmap_missing":
      return { kind: "error", verb: "uploaded", subject: "a replay with no matching map", detail: null };
    case "replay_upload_community_beatmap":
    case "replay_upload_local_beatmap":
      return { kind: "replay", verb: "uploaded", subject: "a replay of their own", detail: null };
    case "route_error":
    case "react_recoverable_error":
      return { kind: "error", verb: "hit", subject: "a page error", detail: row.path || null };
    default:
      break;
  }

  const path = row.path || "";
  if (!path || path === "/") return { kind: "visit", verb: "landed on", subject: "the home page", detail: null };
  if (path === "/maps") return describeMaps(row);
  if (path === "/skins") return describeSkinsList(row);
  if (path.startsWith("/skins/")) {
    return {
      kind: "skin",
      verb: "opened",
      subject: row.skinName || row.skinRef || decodeURIComponent(path.slice("/skins/".length)) || "a skin",
      detail: row.skinKeymodes,
    };
  }
  if (path.startsWith("/player/")) {
    const username = row.profileUsername || decodeURIComponent(path.slice("/player/".length));
    return { kind: "profile", verb: "viewed", subject: username ? `${username}'s profile` : "a profile", detail: null };
  }
  if (path === "/replay") {
    const map = replayMapName(row, replayMaps);
    const scoreId = analyticsReplayScoreId(row);
    return {
      kind: "replay",
      verb: "opened",
      subject: map ?? (scoreId ? `replay #${scoreId.slice(-6)}` : "a replay"),
      detail: row.replayPlayer ? `by ${row.replayPlayer}` : null,
    };
  }
  if (path === "/farm-helper") {
    const user = row.farmHelperUser || analyticsUrlParam(row.viewUrl, "user");
    return {
      kind: "farm",
      verb: "checked",
      subject: user ? `farm help for ${user}` : "the farm helper",
      detail: null,
    };
  }
  if (path.startsWith("/farm-helper/map/")) {
    const beatmapId = path.slice("/farm-helper/map/".length).split("/")[0];
    return {
      kind: "farm",
      verb: "opened",
      subject: row.farmMapTitle || (beatmapId ? `farm map #${beatmapId}` : "a farm map"),
      detail: row.farmMapUser ? `for ${row.farmMapUser}` : null,
    };
  }
  if (path === "/rankings") {
    return { kind: "visit", verb: "browsed", subject: "the rankings", detail: row.rankingsPage ? `page ${row.rankingsPage}` : null };
  }
  if (path === "/my-stats" || path === "/my-data") {
    return { kind: "profile", verb: "opened", subject: "their own stats", detail: row.viewerUsername ? `as ${row.viewerUsername}` : null };
  }
  if (path === "/goals") {
    return { kind: "profile", verb: "opened", subject: "their goals", detail: row.viewerUsername ? `as ${row.viewerUsername}` : null };
  }
  const simple = SIMPLE_PAGE_LABELS[path];
  if (simple) return { kind: "visit", verb: "visited", subject: simple, detail: null };
  return { kind: "visit", verb: "visited", subject: path, detail: null };
}

/* Flat text of a described event, for tooltips and the compact trail lines. */
export function formatAnalyticsActivityText(activity: AnalyticsActivity): string {
  return joinDetail([`${activity.verb} ${activity.subject}`, activity.detail]) ?? activity.subject;
}

const ADMIN_ANALYTICS_INSPECT_PARAM = "mh_admin_inspect";
const ANALYTICS_PRIMARY_HOSTS = new Set(["mania-tracker.com", "www.mania-tracker.com"]);

function isAnalyticsViewHostAllowed(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  if (typeof window !== "undefined" && host === window.location.host.toLowerCase()) return true;
  if (ANALYTICS_PRIMARY_HOSTS.has(hostname)) return true;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// Turn the captured absolute $current_url into a same-origin link so the admin
// can open exactly what the visitor saw (e.g. /farm-helper?user=X). Admin and
// off-site URLs are dropped so we never link out of the dashboard or to nothing.
export function analyticsViewHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!isAnalyticsViewHostAllowed(parsed)) return null;
    const href = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!href.startsWith("/") || href.startsWith("/admin")) return null;
    return href;
  } catch {
    return null;
  }
}

/* Marks a link as an admin peek so the visited page does not capture a
   pageview of its own (see isAdminAnalyticsInspection in lib/analytics.ts). */
export function analyticsInspectionHref(href: string): string {
  try {
    const parsed = new URL(href, "https://mania-tracker.local");
    const marker = `${ADMIN_ANALYTICS_INSPECT_PARAM}=1`;
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const hashParts = hash ? hash.split("&").filter(Boolean) : [];
    if (!hashParts.some((part) => part === ADMIN_ANALYTICS_INSPECT_PARAM || part.startsWith(`${ADMIN_ANALYTICS_INSPECT_PARAM}=`))) {
      hashParts.push(marker);
    }
    parsed.hash = hashParts.length > 0 ? `#${hashParts.join("&")}` : "";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return href;
  }
}

export function analyticsEventHref(row: AnalyticsRecentEventRow): string | null {
  const href = analyticsViewHref(row.viewUrl);
  return href ? analyticsInspectionHref(href) : null;
}

/* A visitor is "here now" while their last event is inside this window; it
   matches the backend's active-visitor definition. */
export const ANALYTICS_ONLINE_WINDOW_MS = 5 * 60_000;

export interface AnalyticsSession {
  distinctId: string;
  /* Stable index in arrival order; the UI derives a colour and a V-number. */
  slot: number;
  label: string;
  country: string | null;
  deviceKind: AnalyticsDeviceKind;
  viewerUsername: string | null;
  referrer: string | null;
  firstTs: number;
  lastTs: number;
  durationMs: number;
  online: boolean;
  events: AnalyticsRecentEventRow[];
}

/* Rows arrive newest-first, so sessions come out ordered by most recent
   activity and each trail reads top-down from latest to earliest. */
export function buildAnalyticsSessions(rows: AnalyticsRecentEventRow[], now: number): AnalyticsSession[] {
  const sessions = new Map<string, AnalyticsSession>();
  for (const row of rows) {
    const id = row.distinctId || "unknown";
    let session = sessions.get(id);
    if (!session) {
      const slot = sessions.size;
      session = {
        distinctId: id,
        slot,
        label: `V${slot + 1}`,
        country: row.country,
        deviceKind: row.deviceKind,
        viewerUsername: row.viewerUsername,
        referrer: null,
        firstTs: row.ts,
        lastTs: row.ts,
        durationMs: 0,
        online: false,
        events: [],
      };
      sessions.set(id, session);
    }
    if (!session.country && row.country) session.country = row.country;
    if (session.deviceKind === "unknown" && row.deviceKind !== "unknown") session.deviceKind = row.deviceKind;
    if (!session.viewerUsername && row.viewerUsername) session.viewerUsername = row.viewerUsername;
    // Rows run newest to oldest, so the last referrer seen is the entry one.
    if (row.referrer) session.referrer = row.referrer;
    if (Number.isFinite(row.ts)) {
      if (row.ts > session.lastTs) session.lastTs = row.ts;
      if (row.ts < session.firstTs) session.firstTs = row.ts;
    }
    session.events.push(row);
  }
  return Array.from(sessions.values()).map((session) => {
    const timed = Number.isFinite(session.firstTs) && Number.isFinite(session.lastTs);
    return {
      ...session,
      durationMs: timed ? Math.max(0, session.lastTs - session.firstTs) : 0,
      online: timed && now - session.lastTs <= ANALYTICS_ONLINE_WINDOW_MS,
    };
  });
}

/* Compact age for feed rows: "now", "42s", "7m", "3h 20m", "2d". Rows from a
   backend too old to send epoch timestamps age to "—" rather than lying. */
export function formatAnalyticsAgo(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/* Session length, which reads better spelled out than aged. */
export function formatAnalyticsDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const restSeconds = seconds % 60;
    return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

const FRIENDLY_REFERRER_LABELS: Record<string, string> = {
  $direct: "Direct visit",
  "google.com": "Google Search",
  "www.google.com": "Google Search",
  "google.co.uk": "Google Search",
  "google.com.br": "Google Search",
  "duckduckgo.com": "DuckDuckGo",
  "bing.com": "Bing",
  "osu.ppy.sh": "osu! site",
  "old.reddit.com": "Reddit",
  "www.reddit.com": "Reddit",
  "reddit.com": "Reddit",
  "out.reddit.com": "Reddit link out",
  "t.co": "Twitter / X",
  "x.com": "Twitter / X",
  "twitter.com": "Twitter / X",
  "discord.com": "Discord",
  "discordapp.com": "Discord",
  "www.youtube.com": "YouTube",
  "youtube.com": "YouTube",
  "m.youtube.com": "YouTube mobile",
  "github.com": "GitHub",
};

export function formatReferrerLabel(domain: string): string {
  const friendly = FRIENDLY_REFERRER_LABELS[domain];
  if (friendly) return friendly;
  if (/-aleju03s-projects\.vercel\.app$/.test(domain)) {
    return `${domain.replace(/^maniacr-tracker-/, "")} preview`;
  }
  if (domain.endsWith(".vercel.app")) return `${domain} vercel`;
  return domain.replace(/^www\./, "");
}
