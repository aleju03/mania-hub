import { getMapsPageviewProperties } from "./analytics-maps";

const API_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const ENDPOINT = "/api/sync";
const VISITOR_ID_KEY = "mh_vid";
const ADMIN_ANALYTICS_INSPECT_PARAM = "mh_admin_inspect";

let cachedVisitorId: string | null = null;
let superProperties: Record<string, unknown> = {};

function isAdminAnalyticsInspection(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has(ADMIN_ANALYTICS_INSPECT_PARAM)) return true;
    return window.location.hash.includes(ADMIN_ANALYTICS_INSPECT_PARAM);
  } catch {
    return false;
  }
}

function getVisitorId(): string {
  if (cachedVisitorId) return cachedVisitorId;
  if (typeof window === "undefined") return "ssr";
  try {
    let stored = window.localStorage.getItem(VISITOR_ID_KEY);
    if (!stored) {
      stored = crypto.randomUUID();
      window.localStorage.setItem(VISITOR_ID_KEY, stored);
    }
    cachedVisitorId = stored;
    return stored;
  } catch {
    const fallback = crypto.randomUUID();
    cachedVisitorId = fallback;
    return fallback;
  }
}

function getBaseProperties(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const referrer = document.referrer || "";
  let referringDomain = "$direct";
  if (referrer) {
    try {
      referringDomain = new URL(referrer).hostname;
    } catch {
      referringDomain = "$direct";
    }
  }
  return {
    $current_url: window.location.href,
    $host: window.location.host,
    $pathname: window.location.pathname,
    $referrer: referrer || "$direct",
    $referring_domain: referringDomain,
    $browser_language: navigator.language,
    $screen_width: window.screen.width,
    $screen_height: window.screen.height,
    $viewport_width: window.innerWidth,
    $viewport_height: window.innerHeight,
    $lib: "mania-hub",
  };
}

export function track(event: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  if (isAdminAnalyticsInspection()) return;
  const distinctId = getVisitorId();
  // api_key is only meaningful to the PostHog leg of the /api/sync dual-write;
  // capture must keep flowing to the in-house store without it.
  const payload = {
    api_key: API_KEY,
    event,
    distinct_id: distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      ...getBaseProperties(),
      ...superProperties,
      ...properties,
      distinct_id: distinctId,
    },
  };
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // swallow — analytics must never throw in user code
  }
}

export function registerSuperProperties(props: Record<string, unknown>) {
  superProperties = { ...superProperties, ...props };
}

// Mirrors the key the farm-helper list writes before navigating into a map
// detail, so the pageview can label the entry by map name and subject instead
// of only its id.
const FARM_MAP_CONTEXT_KEY_PREFIX = "mania-hub-farm-helper-map-context-v1:";

function readFarmMapContext(beatmapId: string): { title: string | null; user: string | null } {
  if (!beatmapId || typeof window === "undefined") return { title: null, user: null };
  try {
    const raw = window.sessionStorage.getItem(`${FARM_MAP_CONTEXT_KEY_PREFIX}${beatmapId}`);
    if (!raw) return { title: null, user: null };
    const parsed = JSON.parse(raw) as { title?: unknown; userName?: unknown; username?: unknown; userKey?: unknown };
    const title = typeof parsed?.title === "string" && parsed.title.trim() ? parsed.title : null;
    const userName = typeof parsed?.userName === "string" && parsed.userName.trim()
      ? parsed.userName
      : typeof parsed?.username === "string" && parsed.username.trim()
        ? parsed.username
        : typeof parsed?.userKey === "string" && parsed.userKey.trim()
          ? parsed.userKey
          : null;
    return { title, user: userName };
  } catch {
    return { title: null, user: null };
  }
}

function getPageviewProperties(pathname: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const props: Record<string, unknown> = {};
  const params = new URLSearchParams(window.location.search);

  if (pathname === "/replay") {
    const scoreId = params.get("scoreId");
    const beatmapsetId = params.get("beatmapsetId");
    const player = params.get("player");
    if (scoreId) props.replay_score_id = scoreId;
    if (beatmapsetId) props.replay_beatmapset_id = beatmapsetId;
    if (player) props.replay_player = player;
  } else if (pathname === "/maps") {
    // Tab plus the search text, filters and sort behind it, so the activity
    // feed can show what the visitor is actually looking for.
    Object.assign(props, getMapsPageviewProperties(params));
  } else if (pathname === "/rankings") {
    const page = params.get("page");
    if (page) props.rankings_page = page;
  } else if (pathname === "/farm-helper") {
    const user = params.get("user");
    if (user) props.farm_helper_user = user;
  } else if (pathname.startsWith("/farm-helper/map/")) {
    const beatmapId = pathname.slice("/farm-helper/map/".length).split("/")[0];
    const context = readFarmMapContext(beatmapId);
    if (context.title) props.farm_map_title = context.title;
    if (context.user) props.farm_map_user = context.user;
  } else if (pathname.startsWith("/player/")) {
    const username = decodeURIComponent(pathname.slice("/player/".length));
    if (username) props.profile_username = username;
  }

  return props;
}

export function capturePageview(pathname: string) {
  if (pathname.startsWith("/admin/")) return;
  track("$pageview", getPageviewProperties(pathname));
}
