import { createServerFn } from "@tanstack/react-start";
import type { LivePackDuel, LivePackDuelCard } from "./live-backend";

// Server functions bridging the browser to the backend's pack_duels store.
// The duelling identity always comes from the osu! login cookie, never from
// client input, so a hand can only ever be submitted as yourself and a pick
// only as a side you actually occupy. The backend route is admin-token gated;
// that token only exists server-side.
//
// A duel is played for keeps: both sides stake the hand they play with, and
// the winner takes the loser's copies. The backend checks every staked card
// against the collection before a duel can open or be answered, so a hand is
// not something the client can invent, and it pays shards on top of the cards
// when a duel resolves.
//
// The whole feature is admin-gated while it is being prototyped: every write
// below calls requireAdminAccess, and the /duel page and both entry points on
// /packs are hidden from everyone else. Drop these guards to open it up.

export type PackDuelSide = "challenger" | "opponent";

/* The duel's shape, mirrored from the backend so the board can be drawn and
   labelled before any round has been played. */
export const TRUMP_STATS = ["control", "speed", "precision", "stars"] as const;
/* One round per stat, because a stat can only be spent once in a duel. */
export const TRUMPS_ROUNDS = TRUMP_STATS.length;
export type TrumpStat = (typeof TRUMP_STATS)[number];

/* What each stat is called on the card front, so the duel board and the card
   art never disagree about a number. */
export const TRUMP_STAT_LABELS: Record<TrumpStat, string> = {
  control: "Control",
  speed: "Speed",
  precision: "Precision",
  stars: "Stars",
};

export type PackDuelError =
  | "not_found"
  | "already_joined"
  | "own_duel"
  | "invalid_cards"
  | "not_a_player"
  | "already_done"
  | "wrong_round"
  | "invalid_pick"
  | "stat_spent"
  | "stake_not_held"
  | "duel_over"
  | "retry"
  | "rate_limited"
  | "invalid_duel"
  | "unavailable";

export type PackDuelResult = { ok: true; duel: LivePackDuel } | { ok: false; error: PackDuelError };

/* A hand is whatever the pack dealt, up to the Wild pack's ten. */
export const PACK_DUEL_MAX_CARDS = 10;

const CARD_KEYS = [
  "userId",
  "username",
  "countryCode",
  "avatarUrl",
  "tier",
  "tierLabel",
  "cardPower",
  "stats",
  "globalRank",
  "pp",
  "skills",
] as const;

/* Trims a submitted hand to the fields a duel row stores. The backend
   sanitizes again; this keeps the request small and the shape predictable. */
export function toDuelCardPayload(cards: readonly LivePackDuelCard[], max: number): LivePackDuelCard[] {
  return cards.slice(0, max).map((card) => {
    const trimmed: Record<string, unknown> = {};
    for (const key of CARD_KEYS) trimmed[key] = card[key];
    return trimmed as unknown as LivePackDuelCard;
  });
}

function validateCards(input: unknown, max: number): LivePackDuelCard[] {
  const cards = Array.isArray(input) ? input : [];
  if (cards.length === 0 || cards.length > max) throw new Error("Invalid duel hand.");
  return toDuelCardPayload(cards as LivePackDuelCard[], max);
}

async function duelTarget(): Promise<
  { base: string; headers: HeadersInit; viewer: { id: number; username: string } } | null
> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return { base, headers, viewer: { id: auth.viewer.id, username: auth.viewer.username } };
}

/* One shape for every duel write: post as the verified viewer, and turn a
   backend refusal into a typed error the UI can phrase, rather than a throw. */
async function postDuel(path: string, body: Record<string, unknown>): Promise<PackDuelResult> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  // Prototype gate: duelling is admin-only until the mode is finished.
  const { requireAdminAccess } = await import("./auth");
  await requireAdminAccess("Pack duels");
  const target = await duelTarget();
  if (!target) return { ok: false, error: "unavailable" };
  const response = await fetch(`${target.base}${path}`, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify({ ...body, userId: target.viewer.id, username: target.viewer.username }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : "unavailable";
    return { ok: false, error: error as PackDuelError };
  }
  return { ok: true, duel: payload as unknown as LivePackDuel };
}

/* Opens a duel, freezing the hand you just pulled as the challenger's side. */
export const createPackDuel = createServerFn({ method: "POST" })
  .validator((input: { packType?: unknown; cards?: unknown }) => {
    const packType =
      typeof input?.packType === "string" && /^[a-z0-9_]{1,24}$/.test(input.packType) ? input.packType : null;
    if (!packType) throw new Error("Invalid duel request.");
    return { packType, cards: validateCards(input?.cards, PACK_DUEL_MAX_CARDS) };
  })
  .handler(async ({ data }): Promise<PackDuelResult> => postDuel("/api/packs/duels", data));

/* Takes the other seat with the hand from your own pack, which opens round
   one. */
export const joinPackDuel = createServerFn({ method: "POST" })
  .validator((input: { duelId?: unknown; cards?: unknown }) => {
    const duelId = typeof input?.duelId === "string" ? input.duelId.trim().toLowerCase() : "";
    if (!/^[a-z0-9]{6,16}$/.test(duelId)) throw new Error("Invalid duel id.");
    return { duelId, cards: validateCards(input?.cards, PACK_DUEL_MAX_CARDS) };
  })
  .handler(async ({ data }): Promise<PackDuelResult> =>
    postDuel(`/api/packs/duels/${data.duelId}/join`, { cards: data.cards }),
  );

function duelIdValidator(input: { duelId?: unknown }) {
  const duelId = typeof input?.duelId === "string" ? input.duelId.trim().toLowerCase() : "";
  if (!/^[a-z0-9]{6,16}$/.test(duelId)) throw new Error("Invalid duel id.");
  return { duelId };
}

/* Attacks with one stat off your card for the round being played. The round
   the pick belongs to travels with it, so a board that has moved on cannot
   land a stale attack. */
export const pickPackDuelStat = createServerFn({ method: "POST" })
  .validator((input: { duelId?: unknown; round?: unknown; stat?: unknown }) => {
    const { duelId } = duelIdValidator(input);
    const round = Math.floor(Number(input?.round));
    if (!Number.isInteger(round) || round < 0 || round >= TRUMPS_ROUNDS) throw new Error("Invalid duel round.");
    if (!TRUMP_STATS.includes(input?.stat as TrumpStat)) throw new Error("Invalid duel stat.");
    return { duelId, round, stat: input.stat as TrumpStat };
  })
  .handler(async ({ data }): Promise<PackDuelResult> =>
    postDuel(`/api/packs/duels/${data.duelId}/pick`, { round: data.round, stat: data.stat }),
  );

/* The signed-in read: your own hand is visible to you, and of theirs only the
   cards already played. The anonymous page read (fetchLivePackDuel) hides both
   sides' unplayed cards, so a player polls through here instead. */
export const viewPackDuel = createServerFn({ method: "POST" })
  .validator(duelIdValidator)
  .handler(async ({ data }): Promise<PackDuelResult> => postDuel(`/api/packs/duels/${data.duelId}/view`, {}));

/* Which side of a duel a viewer sits on, if any. */
export function duelSideOf(duel: LivePackDuel, viewerId: number | null): PackDuelSide | null {
  if (!viewerId) return null;
  if (duel.challenger.userId === viewerId) return "challenger";
  if (duel.opponent.userId === viewerId) return "opponent";
  return null;
}

/* Human phrasing for a refusal. Anything unmapped is a backend hiccup rather
   than a rule, so it reads as one. */
export function duelErrorMessage(error: PackDuelError): string {
  switch (error) {
    case "not_found":
      return "That duel does not exist.";
    case "already_joined":
      return "Someone else already took this duel.";
    case "own_duel":
      return "You cannot duel yourself.";
    case "stake_not_held":
      return "Those cards are not in your collection any more, so there is nothing to stake.";
    case "already_done":
      return "You have already attacked this round.";
    case "wrong_round":
      return "That round has moved on. Look again.";
    case "stat_spent":
      return "You have already spent that stat.";
    case "retry":
      return "That attack crossed with theirs. Try again.";
    case "duel_over":
      return "This duel is already finished.";
    case "not_a_player":
      return "You are not in this duel.";
    case "rate_limited":
      return "That is a lot of duels. Give it a minute.";
    case "invalid_cards":
    case "invalid_duel":
    case "invalid_pick":
      return "That duel move did not make sense.";
    default:
      return "The duel service is unavailable right now.";
  }
}
