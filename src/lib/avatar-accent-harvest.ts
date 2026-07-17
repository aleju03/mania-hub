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
