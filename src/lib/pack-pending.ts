import { sanitizePackDamage, type PackDamage } from "./pack-damage";
import { packPlayerVariantFields, type PackPlayer } from "./packs";

/* The pack a viewer paid for but has not fully revealed yet. The charge is
   spent the moment the pack is slashed, so the unrevealed cards must survive
   leaving /packs (profile peeks, refreshes, closed tabs). Revealed cards are
   recorded into the wallet one by one as they flip; this stores only the
   unrevealed remainder, in draw order, plus the damage a slash through the
   pack's middle did to them - a pack that comes back has to come back cut. */

export const PENDING_PACK_STORAGE_KEY = "mania-hub-pending-pack-v1";

export interface PendingPack {
  players: PackPlayer[];
  damage: PackDamage | null;
}

/* An Eternal card overrides the cut-pack gag. The completion reward and
   golden milestone card can never be earned again, and the 0.0025% pull is
   the rarest thing a pack deals, so a hand containing any of them reveals
   intact and is never routed into the summary's automatic recycler. */
export function effectivePackDamage(players: readonly PackPlayer[], damage: PackDamage | null): PackDamage | null {
  return players.some((player) => player.eternal) ? null : damage;
}

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
    /* Kept so a completion-reward card interrupted mid-reveal resumes as the
       Eternal it was dealt as. Display-only: hand-writing this into
       localStorage paints a card on your own screen and nothing else - the
       server minted (or didn't mint) the ":eternal" row at draw time and
       refuses the tier from every client claim. */
    ...(raw.eternal === true ? { eternal: true as const } : {}),
    /* A milestone card's key, badge and motif, plus the wishlist flag, on the
       same terms: the server
       already minted the holding, so this only decides what the resumed
       reveal draws and which key its mint pass names. */
    ...packPlayerVariantFields({ userId: user.id, ...raw }),
  };
}

export function readPendingPack(): PendingPack | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PENDING_PACK_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    /* A bare array is a pack left pending by a build that predates cut
       packs; it was opened along the perforation, so it resumes intact. */
    const record =
      Array.isArray(parsed)
        ? { players: parsed as unknown[], damage: null }
        : parsed && typeof parsed === "object"
          ? {
              players: (parsed as { players?: unknown }).players,
              damage: sanitizePackDamage((parsed as { damage?: unknown }).damage),
            }
          : null;
    if (!record || !Array.isArray(record.players) || record.players.length === 0) return null;
    const players = record.players.map(sanitizePlayer);
    if (players.some((player) => player === null)) return null;
    return { players: players as PackPlayer[], damage: record.damage };
  } catch {
    return null;
  }
}

export function writePendingPack(players: PackPlayer[], damage: PackDamage | null = null): void {
  if (typeof window === "undefined") return;
  try {
    if (players.length === 0) {
      localStorage.removeItem(PENDING_PACK_STORAGE_KEY);
      return;
    }
    localStorage.setItem(PENDING_PACK_STORAGE_KEY, JSON.stringify({ players, damage }));
  } catch {
    // Quota or privacy mode: the reveal still works this session, the pack
    // just won't survive leaving the page.
  }
}

/* Drops a player from the stored remainder the moment their card flips into
   the wallet. Reveals run in draw order, but match by id anyway so an
   out-of-sync entry cannot eat the wrong card. */
export function consumePendingPackCard(userId: number): void {
  const pending = readPendingPack();
  if (!pending) return;
  const index = pending.players.findIndex((player) => player.user.id === userId);
  if (index === -1) return;
  pending.players.splice(index, 1);
  // The remainder of a cut pack is still cut.
  writePendingPack(pending.players, pending.damage);
}

export function clearPendingPack(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PENDING_PACK_STORAGE_KEY);
  } catch {
    // ignore
  }
}
