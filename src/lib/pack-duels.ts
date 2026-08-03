import { createServerFn } from "@tanstack/react-start";
import type { LivePackDuel, LivePackDuelCard } from "./live-backend";

// Server functions bridging the browser to the backend's pack_duels store.
// The duelling identity always comes from the osu! login cookie, never from
// client input, so a hand can only ever be submitted as yourself and a pick
// only as a side you actually occupy. The backend route is admin-token gated;
// that token only exists server-side.
//
// Duels are bragging rights only: no card here enters a collection, mints a
// serial or moves a shard.
//
// The whole feature is admin-gated while it is being prototyped: every write
// below calls requireAdminAccess, and the /duel page and both entry points on
// /packs are hidden from everyone else. Drop these guards to open it up.

export type PackDuelKind = "challenge" | "blackjack";
export type PackDuelSide = "challenger" | "opponent";

/* Blackjack shape, mirrored from the backend so the packs page can deal a deck
   before a duel exists. */
export const BLACKJACK_DECK_SIZE = 10;
export const BLACKJACK_TARGET = 21;

export type PackDuelError =
  | "not_found"
  | "already_joined"
  | "own_duel"
  | "invalid_cards"
  | "wrong_kind"
  | "not_a_player"
  | "already_done"
  | "no_cards_left"
  | "duel_over"
  | "retry"
  | "rate_limited"
  | "invalid_duel"
  | "unavailable";

export type PackDuelResult = { ok: true; duel: LivePackDuel } | { ok: false; error: PackDuelError };

/* A challenge hand is whatever the pack dealt, up to the Wild pack's ten. */
export const PACK_DUEL_MAX_CARDS = 10;

const CARD_KEYS = [
  "userId",
  "username",
  "countryCode",
  "avatarUrl",
  "tier",
  "tierLabel",
  "cardPower",
  "value",
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

/* Opens a duel. A challenge freezes the hand you just pulled; a draft submits
   the ten-card pool both sides will pick from. */
export const createPackDuel = createServerFn({ method: "POST" })
  .validator((input: { kind?: unknown; packType?: unknown; cards?: unknown }) => {
    const kind: PackDuelKind | null =
      input?.kind === "blackjack" ? "blackjack" : input?.kind === "challenge" ? "challenge" : null;
    const packType =
      typeof input?.packType === "string" && /^[a-z_]{1,24}$/.test(input.packType) ? input.packType : null;
    if (!kind || !packType) throw new Error("Invalid duel request.");
    const cards = validateCards(input?.cards, BLACKJACK_DECK_SIZE);
    if (kind === "blackjack" && cards.length !== BLACKJACK_DECK_SIZE) {
      throw new Error("A blackjack duel needs a full deck.");
    }
    return { kind, packType, cards };
  })
  .handler(async ({ data }): Promise<PackDuelResult> => postDuel("/api/packs/duels", data));

/* Answers a challenge with the hand from your own pack, which resolves it. */
export const joinPackDuel = createServerFn({ method: "POST" })
  .validator((input: { duelId?: unknown; cards?: unknown }) => {
    const duelId = typeof input?.duelId === "string" ? input.duelId.trim().toLowerCase() : "";
    if (!/^[a-z0-9]{6,16}$/.test(duelId)) throw new Error("Invalid duel id.");
    return { duelId, cards: validateCards(input?.cards, PACK_DUEL_MAX_CARDS) };
  })
  .handler(async ({ data }): Promise<PackDuelResult> =>
    postDuel(`/api/packs/duels/${data.duelId}/join`, { kind: "challenge", cards: data.cards }),
  );

function duelIdValidator(input: { duelId?: unknown }) {
  const duelId = typeof input?.duelId === "string" ? input.duelId.trim().toLowerCase() : "";
  if (!/^[a-z0-9]{6,16}$/.test(duelId)) throw new Error("Invalid duel id.");
  return { duelId };
}

/* Takes the free seat at a blackjack duel, which deals your opening two.
   Idempotent for the seat's occupant, so reopening the link mid-hand is not a
   way to be redealt. */
export const joinPackBlackjack = createServerFn({ method: "POST" })
  .validator(duelIdValidator)
  .handler(async ({ data }): Promise<PackDuelResult> =>
    postDuel(`/api/packs/duels/${data.duelId}/join`, { kind: "blackjack" }),
  );

/* One more card. Going over the target ends the hand there. */
export const hitPackDuel = createServerFn({ method: "POST" })
  .validator(duelIdValidator)
  .handler(async ({ data }): Promise<PackDuelResult> => postDuel(`/api/packs/duels/${data.duelId}/hit`, {}));

/* Stops on the hand as it stands. The second side to stop resolves the duel. */
export const standPackDuel = createServerFn({ method: "POST" })
  .validator(duelIdValidator)
  .handler(async ({ data }): Promise<PackDuelResult> => postDuel(`/api/packs/duels/${data.duelId}/stand`, {}));

/* The signed-in read: your own hand is visible to you, the other side's is not
   until both have stopped. The anonymous page read (fetchLivePackDuel) hides
   both, so a player polls through here instead. */
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
    case "already_done":
      return "Your hand is already finished.";
    case "no_cards_left":
      return "No cards left in your half of the deck.";
    case "retry":
      return "That move crossed with another. Try again.";
    case "duel_over":
      return "This duel is already finished.";
    case "not_a_player":
      return "You are not in this duel.";
    case "rate_limited":
      return "That is a lot of duels. Give it a minute.";
    case "invalid_cards":
    case "invalid_duel":
    case "wrong_kind":
      return "That duel move did not make sense.";
    default:
      return "The duel service is unavailable right now.";
  }
}
