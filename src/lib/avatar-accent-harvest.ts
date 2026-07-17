import { getAvatarAccentStoreKey } from "./avatar-accent";
import { useAppStore } from "../store";

// Player-name accent colors ride inside live-backend payloads (`avatarAccent` next to `avatarUrl`,
// `avatar_accent` next to `avatar_url` on osu-shaped score objects). This walks any payload the
// frontend receives (snapshot fetches, SSE events), collects those pairs, and feeds the URL-keyed
// accent store that UsernameText reads. Names and their colors therefore land in the same React
// commit: no follow-up request, no flash. The legacy client batch-fetch pipeline is gone.

function collectPairs(payload: unknown, out: Map<string, string>, depth: number): void {
  if (depth > 24 || payload === null || typeof payload !== "object") return;
  if (Array.isArray(payload)) {
    for (const item of payload) collectPairs(item, out, depth + 1);
    return;
  }
  const record = payload as Record<string, unknown>;
  const snakeUrl = record.avatar_url;
  const snakeAccent = record.avatar_accent;
  if (typeof snakeUrl === "string" && snakeUrl && typeof snakeAccent === "string" && snakeAccent) {
    out.set(snakeUrl, snakeAccent);
  }
  const camelUrl = record.avatarUrl;
  const camelAccent = record.avatarAccent;
  if (typeof camelUrl === "string" && camelUrl && typeof camelAccent === "string" && camelAccent) {
    out.set(camelUrl, camelAccent);
  }
  for (const value of Object.values(record)) {
    collectPairs(value, out, depth + 1);
  }
}

/** Extracts `avatar url -> accent` pairs from a payload. Exposed for tests. */
export function collectAvatarAccentsFromPayload(payload: unknown): Map<string, string> {
  const pairs = new Map<string, string>();
  collectPairs(payload, pairs, 0);
  return pairs;
}

// ── Request-on-miss ────────────────────────────────────────────────────────
// Surfaces fed by the osu! API server fns (home top players, /rankings) never
// receive live-backend payloads, so nothing harvests accents for them.
// UsernameText registers its avatar URL when it renders without an accent;
// registrations batch into one POST /api/avatar-accents per burst and the
// response feeds the same store, coloring the names in place.

const ACCENT_REQUEST_FLUSH_MS = 250;
const ACCENT_REQUEST_MAX_URLS = 100;

const pendingAccentUrls = new Set<string>();
const requestedAccentUrls = new Set<string>();
let accentFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Read directly instead of importing live-backend.ts: that module imports this
// one for harvesting, and the accent path must not create an import cycle.
function liveBackendBase(): string | null {
  const value = import.meta.env.VITE_LIVE_BACKEND_URL || import.meta.env.LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

async function flushAccentRequests(): Promise<void> {
  accentFlushTimer = null;
  const base = liveBackendBase();
  if (!base || pendingAccentUrls.size === 0) return;
  const urls = [...pendingAccentUrls].slice(0, ACCENT_REQUEST_MAX_URLS);
  for (const url of urls) pendingAccentUrls.delete(url);
  try {
    const response = await fetch(`${base}/api/avatar-accents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    if (response.ok) {
      const payload = (await response.json()) as { accents?: Record<string, string> };
      if (payload.accents && Object.keys(payload.accents).length > 0) {
        useAppStore.getState().setAvatarAccents(payload.accents);
      }
    }
  } catch {
    // Cosmetic: names stay in the surrounding text color until a later
    // payload or session carries the accent.
  }
  if (pendingAccentUrls.size > 0) scheduleAccentFlush();
}

function scheduleAccentFlush(): void {
  if (accentFlushTimer !== null) return;
  accentFlushTimer = setTimeout(() => {
    void flushAccentRequests();
  }, ACCENT_REQUEST_FLUSH_MS);
}

/** Registers an avatar URL rendered without an accent; requested at most once per session. */
export function requestAvatarAccent(url: string): void {
  if (typeof window === "undefined") return;
  if (!url || requestedAccentUrls.has(url)) return;
  if (useAppStore.getState().avatarAccents[getAvatarAccentStoreKey(url)]?.value) return;
  requestedAccentUrls.add(url);
  pendingAccentUrls.add(url);
  scheduleAccentFlush();
}

/** Feeds any accents found in `payload` into the store. Cheap no-op when there are none. */
export function harvestAvatarAccents(payload: unknown): void {
  // Server-side the store is per-process and never shipped to the browser; harvesting there would
  // only leak memory across requests.
  if (typeof window === "undefined") return;
  const pairs = collectAvatarAccentsFromPayload(payload);
  if (pairs.size === 0) return;

  // Skip entries the store already has with the same value: avoids a redundant store write (and
  // the re-render it would trigger) on every snapshot poll.
  const current = useAppStore.getState().avatarAccents;
  const fresh: Record<string, string> = {};
  for (const [url, accent] of pairs) {
    if (current[getAvatarAccentStoreKey(url)]?.value !== accent) {
      fresh[url] = accent;
    }
  }
  if (Object.keys(fresh).length === 0) return;
  useAppStore.getState().setAvatarAccents(fresh);
}
