/* The honorary roster: osu!mania's historical greats.

   These twenty-three carry the GOAT tier by user id (see maniacard.ts) rather
   than by card power, and they are the only source of that tier. Many of them
   stopped playing long before the current rating ladder existed, and the
   ranked pool can't represent them:

   - three accounts are deleted outright, so the osu! API 404s and their profiles
     are served from checked-in Wayback reconstructions
     (live-backend/seeds/archived-players);
   - seven more still exist but were wiped to 0pp and are unranked, so they are
     absent from the global rankings snapshot the pack pool draws from;
   - the rest are still ranked, but a rank-ordered pool would bury the ones
     whose peak is long behind them.

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
  /* Name printed on the card, for players the community knows by something
     other than their current osu! username. Only the card art changes:
     `username` still keys the profile link, so it has to stay resolvable. */
  cardName?: string;
  /* Badge text on the card, replacing the plain GOAT label. */
  cardTierLabel?: string;
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
  {
    id: 19970192,
    username: "saragi",
    countryCode: "AR",
    avatarUrl: "https://a.ppy.sh/19970192?1772470412.jpeg",
    peakRank: 46,
    peakPp: 21161.7,
    archived: false,
    cardReady: true,
  },
  {
    id: 10072733,
    username: "myucchii",
    countryCode: "CL",
    avatarUrl: "https://a.ppy.sh/10072733?1783553838.png",
    peakRank: 53,
    peakPp: 20301.9,
    archived: false,
    cardReady: true,
  },
  {
    id: 903155,
    username: "Transcendence",
    countryCode: "KR",
    avatarUrl: "https://a.ppy.sh/903155?1718724914.png",
    peakRank: 67,
    peakPp: 14513.2,
    archived: false,
    cardReady: true,
  },
  {
    id: 12253636,
    // The name the account carried until it was deleted. A different, live
    // account holds "KaneMining" today, and profiles are keyed by name, so
    // the card prints the name he is known by while the link stays his.
    username: "silicosis et",
    countryCode: "US",
    // Deleted account, but a.ppy.sh still serves the original image.
    avatarUrl: "https://a.ppy.sh/12253636?1564086634.jpeg",
    peakRank: 64,
    peakPp: 14183.5,
    archived: true,
    cardReady: true,
    cardName: "KaneMining",
  },
  {
    id: 2288363,
    username: "SillyFangirl",
    countryCode: "BR",
    avatarUrl: "https://a.ppy.sh/2288363?1739186820.jpeg",
    peakRank: 11,
    peakPp: 21018.7,
    archived: false,
    cardReady: true,
    cardTierLabel: "Manip GOAT",
  },
  {
    id: 10083439,
    username: "bojii",
    countryCode: "PH",
    avatarUrl: "https://a.ppy.sh/10083439?1785211081.png",
    peakRank: 3,
    peakPp: 27107.6,
    archived: false,
    cardReady: true,
  },
  {
    id: 1089335,
    username: "[Crz]Player",
    countryCode: "KR",
    // Account is live but the avatar is gone, so a.ppy.sh serves the guest
    // default; this is the archived original.
    avatarUrl: "/images/archived-players/attang.png",
    peakRank: 28,
    peakPp: 0,
    archived: false,
    cardReady: true,
    cardName: "Attang",
  },
  {
    id: 9530019,
    username: "Lothus",
    countryCode: "BR",
    avatarUrl: "https://a.ppy.sh/9530019?1746485399.jpeg",
    peakRank: 35,
    peakPp: 12595.4,
    archived: false,
    cardReady: true,
  },
  {
    id: 1824775,
    username: "inteliser",
    countryCode: "JP",
    avatarUrl: "https://a.ppy.sh/1824775?1627877794.jpeg",
    peakRank: 22,
    peakPp: 14582.8,
    archived: false,
    cardReady: true,
  },
  {
    id: 15806513,
    username: "jkzu123",
    countryCode: "DE",
    avatarUrl: "https://a.ppy.sh/15806513?1782161482.jpeg",
    peakRank: 97,
    peakPp: 17179.2,
    archived: false,
    cardReady: true,
    cardTierLabel: "Push GOAT",
  },
  {
    id: 3817144,
    username: "cheetose",
    countryCode: "KR",
    // Inactive account with no avatar left: a.ppy.sh serves the guest default
    // and no archived original survives, so the card carries the default until
    // one turns up.
    avatarUrl: "https://a.ppy.sh/3817144",
    peakRank: null,
    peakPp: 0,
    archived: false,
    cardReady: true,
  },
  {
    id: 4477497,
    username: "cheewee10",
    countryCode: "MY",
    avatarUrl: "https://a.ppy.sh/4477497?1706963836.jpeg",
    peakRank: 4,
    peakPp: 26429.1,
    archived: false,
    cardReady: true,
  },
  {
    id: 13601876,
    username: "Orost",
    countryCode: "BR",
    avatarUrl: "https://a.ppy.sh/13601876?1769691318.png",
    peakRank: 139,
    peakPp: 16712.3,
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
   osu! user search cannot return) still surface in the player search. Card
   names match too: those are the names the community searches by. */
export function searchHonoraryPlayers(query: string): HonoraryPlayer[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return HONORARY_PLAYERS.filter(
    (player) =>
      player.username.toLowerCase().includes(term) ||
      !!player.cardName?.toLowerCase().includes(term),
  );
}
