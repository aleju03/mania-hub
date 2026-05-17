const API_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const ENDPOINT = "/api/sync";
const VISITOR_ID_KEY = "mh_vid";

let cachedVisitorId: string | null = null;
let superProperties: Record<string, unknown> = {};

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
  if (!API_KEY || typeof window === "undefined") return;
  const distinctId = getVisitorId();
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
    const tab = params.get("tab");
    props.maps_tab = tab === "popular" || tab === "favourites" || tab === "random" ? tab : "farmed";
  } else if (pathname === "/rankings") {
    const page = params.get("page");
    if (page) props.rankings_page = page;
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
