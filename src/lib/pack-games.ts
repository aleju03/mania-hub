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

// The posting helpers live in pack-games.server.ts and are only imported
// inside handler bodies: this file is pulled into the client bundle by the
// packs page, and a module-scope path to @tanstack/react-start/server would
// trip import protection.

/* What this account can still earn from games today. Null when signed out or
   with no live backend, which is how the page knows not to promise shards. */
export const fetchPackGameAllowance = createServerFn({ method: "POST" }).handler(
  async (): Promise<PackGameAllowance | null> => {
    const { postGame } = await import("./pack-games.server");
    return postGame("/api/packs/games/allowance", {});
  },
);

/* Cashes in a finished streak run. The backend decides what it is worth and
   trims it to whatever is left of the day's allowance. */
export const claimStreakShards = createServerFn({ method: "POST" })
  .validator((input: { streak?: unknown }) => ({
    streak: Math.max(0, Math.min(1000, Math.floor(Number(input?.streak) || 0))),
  }))
  .handler(async ({ data }): Promise<PackGameAllowance | null> => {
    const { postGame } = await import("./pack-games.server");
    return postGame("/api/packs/games/streak", { streak: data.streak });
  });
