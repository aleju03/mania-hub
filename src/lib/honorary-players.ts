/* The honorary roster: osu!mania's historical greats.

   These ten carry the GOAT tier by user id (see maniacard.ts) rather than by
   card power, and they are the only source of that tier. Most of them stopped
   playing long before the current rating ladder existed, and the ranked pool
   can't represent them:

   - two accounts are deleted outright, so the osu! API 404s and their profiles
     are served from checked-in Wayback reconstructions
     (live-backend/seeds/archived-players);
   - five more still exist but were wiped to 0pp and are unranked, so they are
     absent from the global rankings snapshot the pack pool draws from;
   - only three are still ranked, and a rank-ordered pool would bury them.

   So packs reach them through a dedicated honorary slot instead of the ranked
   pool. Rank/pp here are archival - the peak each player reached, not a live
   figure - because for this roster the peak is the meaningful number.
*/

export interface HonoraryPlayer {
  id: number;
  username: string;
  countryCode: string;
  /* Same-origin path when osu! no longer serves the avatar, a.ppy.sh otherwise. */
  avatarUrl: string;
  /* Best rank the player is recorded as having reached. */
  peakRank: number | null;
  /* pp at the player's recorded peak, or their current pp if still ranked. */
  peakPp: number;
  /* True when the osu! account is gone and the profile comes from a seeded
     reconstruction rather than the live API. */
  archived: boolean;
  /* False while a player has no renderable card yet: a deleted account whose
     reconstruction isn't finished. Those are excluded from pack draws, since a
     pull with no snapshot behind it is a broken reveal. Flip to true once the
     seed lands. */
  cardReady: boolean;
}

export const HONORARY_PLAYERS: readonly HonoraryPlayer[] = [
  {
    id: 259972,
    username: "Jakads",
    countryCode: "KR",
    // a.ppy.sh serves the guest default for deleted accounts, so this is the
    // archived original.
    avatarUrl: "/images/archived-players/jakads.jpg",
    peakRank: 1,
    peakPp: 22684.6,
    archived: true,
    cardReady: true,
  },
  {
    id: 1190879,
    username: "WindyS",
    countryCode: "KR",
    // Deleted account, but a.ppy.sh still serves the original image.
    avatarUrl: "https://a.ppy.sh/1190879",
    peakRank: null,
    peakPp: 19196.5,
    archived: true,
    cardReady: true,
  },
  {
    id: 140148,
    username: "jhlee0133",
    countryCode: "KR",
    avatarUrl: "https://a.ppy.sh/140148?1418788785.png",
    peakRank: null,
    peakPp: 0,
    archived: false,
    cardReady: true,
  },
  {
    id: 8474029,
    username: "wonder5193",
    countryCode: "KR",
    avatarUrl: "https://a.ppy.sh/8474029?1556244814.jpeg",
    peakRank: 2,
    peakPp: 17812.6,
    archived: false,
    cardReady: true,
  },
  {
    id: 86188,
    username: "Staiain",
    countryCode: "NO",
    avatarUrl: "https://a.ppy.sh/86188?1520536033.png",
    peakRank: 108,
    peakPp: 9424.64,
    archived: false,
    cardReady: true,
  },
  {
    id: 5610085,
    username: "EtienneXC",
    countryCode: "US",
    avatarUrl: "https://a.ppy.sh/5610085?1538879568.jpeg",
    peakRank: 336,
    peakPp: 0,
    archived: false,
    cardReady: true,
  },
  {
    id: 3360737,
    username: "Jinjin",
    countryCode: "US",
    avatarUrl: "https://a.ppy.sh/3360737?1565880553.jpeg",
    peakRank: 70,
    peakPp: 14451.5,
    archived: false,
    cardReady: true,
  },
  {
    id: 2531335,
    username: "Fullerene-",
    countryCode: "CA",
    avatarUrl: "https://a.ppy.sh/2531335?1614209495.jpeg",
    peakRank: null,
    peakPp: 0,
    archived: false,
    cardReady: true,
  },
  {
    id: 2520707,
    username: "Shoegazer",
    countryCode: "SG",
    avatarUrl: "https://a.ppy.sh/2520707?1768751983.jpeg",
    peakRank: null,
    peakPp: 0,
    archived: false,
    cardReady: true,
  },
  {
    id: 4140104,
    username: "Abcdullah",
    countryCode: "KR",
    avatarUrl: "https://a.ppy.sh/4140104?1395235069.png",
    peakRank: null,
    peakPp: 0,
    archived: false,
    cardReady: true,
  },
];

/* The subset packs can actually deal. Search and the tier badge cover the whole
   roster; only the draw needs a renderable card behind the pull. */
export const HONORARY_PACK_POOL: readonly HonoraryPlayer[] =
  HONORARY_PLAYERS.filter((player) => player.cardReady);

const BY_ID = new Map(HONORARY_PLAYERS.map((player) => [player.id, player]));

export function honoraryPlayerById(id: number | null | undefined): HonoraryPlayer | null {
  return id == null ? null : BY_ID.get(id) ?? null;
}

export function isHonoraryPlayer(id: number | null | undefined): boolean {
  return id != null && BY_ID.has(id);
}

/* Matches the roster against a search term, so deleted accounts (which the
   osu! user search cannot return) still surface in the player search. */
export function searchHonoraryPlayers(query: string): HonoraryPlayer[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return HONORARY_PLAYERS.filter((player) => player.username.toLowerCase().includes(term));
}
