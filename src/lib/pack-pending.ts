import type { PackPlayer } from "./packs";

/* The pack a viewer paid for but has not fully revealed yet. The charge is
   spent the moment the pack is slashed, so the unrevealed cards must survive
   leaving /packs (profile peeks, refreshes, closed tabs). Revealed cards are
   recorded into the wallet one by one as they flip; this stores only the
   unrevealed remainder, in draw order. */

export const PENDING_PACK_STORAGE_KEY = "mania-hub-pending-pack-v1";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizePlayer(value: unknown): PackPlayer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PackPlayer>;
  const user = raw.user;
  if (!user || typeof user !== "object") return null;
  if (!isFiniteNumber(user.id) || typeof user.username !== "string") return null;
  if (!isFiniteNumber(raw.pp) || !isFiniteNumber(raw.globalRank)) return null;
  const statistics = user.statistics;
  return {
    user: {
      id: user.id,
      username: user.username,
      avatar_url: typeof user.avatar_url === "string" ? user.avatar_url : "",
      country_code: typeof user.country_code === "string" ? user.country_code : "",
      statistics: {
        global_rank:
          statistics && isFiniteNumber(statistics.global_rank) ? statistics.global_rank : null,
        pp: statistics && isFiniteNumber(statistics.pp) ? statistics.pp : raw.pp,
      },
    },
    globalRank: raw.globalRank,
    pp: raw.pp,
  };
}

export function readPendingPack(): PackPlayer[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PENDING_PACK_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const players = parsed.map(sanitizePlayer);
    if (players.some((player) => player === null)) return null;
    return players as PackPlayer[];
  } catch {
    return null;
  }
}

export function writePendingPack(players: PackPlayer[]): void {
  if (typeof window === "undefined") return;
  try {
    if (players.length === 0) {
      localStorage.removeItem(PENDING_PACK_STORAGE_KEY);
      return;
    }
    localStorage.setItem(PENDING_PACK_STORAGE_KEY, JSON.stringify(players));
  } catch {
    // Quota or privacy mode: the reveal still works this session, the pack
    // just won't survive leaving the page.
  }
}

/* Drops a player from the stored remainder the moment their card flips into
   the wallet. Reveals run in draw order, but match by id anyway so an
   out-of-sync entry cannot eat the wrong card. */
export function consumePendingPackCard(userId: number): void {
  const players = readPendingPack();
  if (!players) return;
  const index = players.findIndex((player) => player.user.id === userId);
  if (index === -1) return;
  players.splice(index, 1);
  writePendingPack(players);
}

export function clearPendingPack(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PENDING_PACK_STORAGE_KEY);
  } catch {
    // ignore
  }
}
