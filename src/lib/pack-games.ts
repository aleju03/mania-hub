import { createServerFn } from "@tanstack/react-start";

// The arcade's till, bridged to the backend's pack_game_rewards ledger. The
// earning identity always comes from the osu! login cookie, never from client
// input, so a run can only ever be claimed as yourself.
//
// A casual streak is scored in the browser, which means a scripted client
// could claim a run it never played - the answers are public data either way.
// The daily allowance on the backend is what makes that pointless rather than
// this route: a day of play is worth the same whether it was earned or faked,
// and it is priced below a single Wild pack. Blitz runs are a different
// thing entirely and live in streak-blitz.ts, because a leaderboard cannot be
// fed by a number the client picked.

export interface PackGameAllowance {
  granted: number;
  remainingToday: number;
  cap: number;
}

async function gameTarget(): Promise<
  { base: string; headers: HeadersInit; userId: number; username: string } | null
> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return { base, headers, userId: auth.viewer.id, username: auth.viewer.username };
}

/* One place that knows the arcade's server-to-server convention: the admin
   token plus the viewer the osu! cookie proved, never an id off the request
   body. Everything the arcade posts goes through here. */
export async function postPackGame<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const target = await gameTarget();
  if (!target) return null;
  const response = await fetch(`${target.base}${path}`, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify({ ...body, userId: target.userId, username: target.username }),
  });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

async function postGame(path: string, body: Record<string, unknown>): Promise<PackGameAllowance | null> {
  const payload = await postPackGame<Record<string, unknown>>(path, body);
  if (!payload) return null;
  return {
    granted: Math.max(0, Number(payload.granted) || 0),
    remainingToday: Math.max(0, Number(payload.remainingToday) || 0),
    cap: Math.max(0, Number(payload.cap) || 0),
  };
}

/* What this account can still earn from games today. Null when signed out or
   with no live backend, which is how the page knows not to promise shards. */
export const fetchPackGameAllowance = createServerFn({ method: "POST" }).handler(
  async (): Promise<PackGameAllowance | null> => postGame("/api/packs/games/allowance", {}),
);

/* Cashes in a finished streak run. The backend decides what it is worth and
   trims it to whatever is left of the day's allowance. */
export const claimStreakShards = createServerFn({ method: "POST" })
  .validator((input: { streak?: unknown }) => ({
    streak: Math.max(0, Math.min(1000, Math.floor(Number(input?.streak) || 0))),
  }))
  .handler(async ({ data }): Promise<PackGameAllowance | null> =>
    postGame("/api/packs/games/streak", { streak: data.streak }),
  );
