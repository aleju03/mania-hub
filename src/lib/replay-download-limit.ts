/* A per-client ceiling on replays this site downloads from osu! for someone.

   A replay the site has never fetched costs an osu! replay download, which
   osu! limits on its own, tighter budget: past it every call gets a 429 and
   our whole osu! client pauses. On 2026-11-14 one client walked score ids
   through /api/replay-file at ~550 an hour and kept the budget in 429s for
   hours. Cached replays (R2) cost osu! nothing and are never counted here, so
   a viewer re-watching or a shared replay link is unaffected.

   Per instance and in memory, like the request rate limits in start.ts: the
   apex runs two instances, so the effective ceiling is up to twice this. */

const WINDOW_MS = 60 * 60_000;
const MAX_TRACKED_CLIENTS = 20_000;

export class ReplayDownloadLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Too many replay downloads from this connection, try again later");
    this.name = "ReplayDownloadLimitError";
  }
}

const windows = new Map<string, { count: number; resetAt: number }>();

export function replayDownloadHourlyLimit(): number {
  const value = Number(process.env.REPLAY_DOWNLOADS_PER_HOUR);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30;
}

/** Spends one uncached download for this client, or throws once the hour's ceiling is used up. */
export function takeReplayDownloadSlot(clientKey: string, now = Date.now(), limit = replayDownloadHourlyLimit()): void {
  if (windows.size > MAX_TRACKED_CLIENTS) {
    for (const [key, entry] of windows) {
      if (entry.resetAt <= now) windows.delete(key);
    }
  }
  const existing = windows.get(clientKey);
  if (!existing || existing.resetAt <= now) {
    windows.set(clientKey, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  if (existing.count >= limit) throw new ReplayDownloadLimitError(Math.max(1, existing.resetAt - now));
  existing.count += 1;
}

export function resetReplayDownloadLimits(): void {
  windows.clear();
}
