import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec } from "../db.js";

// Pack duels: two collectors, two hands of maniacards, one winner. Bragging
// rights only - no card here enters a collection, mints a serial or moves a
// shard.
//
// Two kinds share one row shape:
//
// - challenge: each side opens a pack of the same type and the totals are
//   compared. The challenger's hand is frozen at creation, the opponent's when
//   they join, and it resolves the moment both are in.
// - blackjack: one deck is dealt per duel, each side gets its own half, and
//   each plays blackjack against a target of 21 - two cards to start, then hit
//   or stand, bust if you go over. A card is worth its star rating. Both sides
//   play at the same time and blind, so nobody waits for a turn and neither
//   seat gets the dealer's advantage of acting last.
//
// Card values are client-reported, exactly like the pull log, so a determined
// client can inflate its own hand; that is the accepted trade for a feature
// whose entire prize is bragging rights. The parts that would actually decide a
// game are server-held: the deck is frozen at creation, the server deals from
// it, and a side can only ever see its own cards until both are done.

/* Brings an existing pack_duels table up to the current shape.

   The schema lives in a `create table if not exists` migration, which by
   definition does nothing to a table that already exists, so a database that
   met an earlier version of this prototype keeps the old columns and every
   insert fails on the new ones. Adding the missing columns is enough: they are
   all nullable or defaulted. Rows from the retired draft mode go with them,
   since nothing can read them any more.

   Prototype-only cleanup. Once the mode ships, schema changes belong in a
   numbered migration instead. */
export async function ensurePackDuelsSchema(db: Db): Promise<boolean> {
  const columns = (await exec(db, "pragma table_info(pack_duels)")).rows;
  if (columns.length === 0) return false;
  const present = new Set(columns.map((column) => String(column.name)));
  const additions: Array<[string, string]> = [
    ["challenger_done", "integer not null default 0"],
    ["opponent_done", "integer not null default 0"],
    ["deals_json", "text"],
    ["deals_count", "integer not null default 0"],
  ];
  let changed = false;
  for (const [name, definition] of additions) {
    if (present.has(name)) continue;
    await exec(db, `alter table pack_duels add column ${name} ${definition}`);
    changed = true;
  }
  if (changed) await exec(db, "delete from pack_duels where kind = 'draft'");
  return changed;
}

export type PackDuelKind = "challenge" | "blackjack";
export type PackDuelStatus = "open" | "resolved";
export type PackDuelWinner = "challenger" | "opponent" | "tie";
export type PackDuelSide = "challenger" | "opponent";

/* A challenge freezes whatever the pack dealt, up to the Wild pack's ten. */
export const PACK_DUEL_MAX_CARDS = 10;

/* Blackjack. The target is 21 and a card is worth its star rating (roughly 3
   to 8), so a hand is three to five cards. Five per side leaves room to keep
   hitting past any sane stopping point while keeping the deck small: every
   card in it has to be minted before the duel can start, and a cold player
   costs an osu! API fetch. */
export const BLACKJACK_TARGET = 21;
export const BLACKJACK_CARDS_PER_SIDE = 5;
export const BLACKJACK_DECK_SIZE = BLACKJACK_CARDS_PER_SIDE * 2;
export const BLACKJACK_OPENING_CARDS = 2;

/* Duels a single account can open per hour. Generous next to any real use;
   it exists so the table cannot be used as free write amplification. */
export const PACK_DUEL_HOURLY_CAP = 60;

/* Card power is a mint statistic in the low hundreds to low thousands, and a
   star rating tops out around 10. Both clamps keep a tampered client inside a
   range where the scoreboard still reads as a scoreboard. */
const MAX_CARD_POWER = 5000;
const MAX_CARD_VALUE = 15;

const VALID_TIERS = new Set([
  "common",
  "rare",
  "elite",
  "superRare",
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
  "goat",
]);

export interface PackDuelCard {
  userId: number;
  username: string;
  countryCode: string;
  avatarUrl: string;
  tier: string | null;
  tierLabel: string | null;
  cardPower: number;
  /* What this card is worth at blackjack: the star rating of the player's
     card, which is the number already printed on its front. */
  value: number;
  globalRank: number;
  pp: number;
  /* The mint's skills snapshot, so the duel page can redraw the real card
     front offline exactly like the collection does. */
  skills: unknown | null;
}

export interface PackDuelSideState {
  userId: number | null;
  username: string | null;
  cards: PackDuelCard[];
  /* Challenge: total card power. Blackjack: the hand's total value. */
  score: number;
  /* Blackjack: how many cards this side holds, which stays truthful even
     while the cards themselves are hidden from the other player. */
  cardCount: number;
  /* Blackjack: the side has stopped, either by standing or by busting. */
  done: boolean;
  bust: boolean;
  /* Set on a public or opposing read while a hand is still hidden. */
  hidden?: boolean;
}

export interface PackDuel {
  id: string;
  kind: PackDuelKind;
  packType: string;
  status: PackDuelStatus;
  challenger: PackDuelSideState;
  opponent: PackDuelSideState;
  /* Blackjack: the target to get closest to without going over. */
  target: number;
  winner: PackDuelWinner | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

function clampNumber(value: unknown, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function normalizeCard(value: unknown): PackDuelCard | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const userId = Math.floor(Number(raw.userId) || 0);
  if (userId <= 0 || typeof raw.username !== "string" || raw.username.length === 0) return null;
  const tier = typeof raw.tier === "string" && VALID_TIERS.has(raw.tier) ? raw.tier : null;
  return {
    userId,
    username: raw.username.slice(0, 40),
    countryCode: typeof raw.countryCode === "string" ? raw.countryCode.slice(0, 2).toUpperCase() : "",
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl.slice(0, 300) : "",
    tier,
    tierLabel: typeof raw.tierLabel === "string" ? raw.tierLabel.slice(0, 40) : null,
    cardPower: clampNumber(raw.cardPower, 0, MAX_CARD_POWER),
    // Two decimals, the precision a star rating is printed at.
    value: Math.round(clampNumber(raw.value, 0, MAX_CARD_VALUE) * 100) / 100,
    globalRank: Math.max(0, Math.floor(Number(raw.globalRank) || 0)),
    pp: clampNumber(raw.pp, 0, 100_000),
    // Kept opaque: the frontend owns the skills shape, and a duel row is
    // display data. Size is bounded by the payload limit on the route.
    skills: raw.skills && typeof raw.skills === "object" ? raw.skills : null,
  };
}

export function normalizeDuelCards(value: unknown, max = PACK_DUEL_MAX_CARDS): PackDuelCard[] {
  return (Array.isArray(value) ? value : [])
    .map(normalizeCard)
    .filter((card): card is PackDuelCard => card !== null)
    .slice(0, max);
}

/* A challenge hand's score: total card power, rounded, because the card front
   prints integers and a duel decided on a hundredth reads as a bug. */
export function scoreDuelCards(cards: PackDuelCard[]): number {
  return Math.round(cards.reduce((sum, card) => sum + card.cardPower, 0));
}

/* A blackjack hand's total: the sum of star values, to two decimals. */
export function handTotal(cards: PackDuelCard[]): number {
  return Math.round(cards.reduce((sum, card) => sum + card.value, 0) * 100) / 100;
}

export function isBust(cards: PackDuelCard[]): boolean {
  return handTotal(cards) > BLACKJACK_TARGET;
}

/* Higher total card power wins a challenge; the tiebreak is the single best
   card, the thing both sides were actually chasing. */
export function resolveDuelWinner(
  challengerCards: PackDuelCard[],
  opponentCards: PackDuelCard[],
): PackDuelWinner {
  const challengerScore = scoreDuelCards(challengerCards);
  const opponentScore = scoreDuelCards(opponentCards);
  if (challengerScore !== opponentScore) return challengerScore > opponentScore ? "challenger" : "opponent";
  const bestOf = (cards: PackDuelCard[]) => cards.reduce((best, card) => Math.max(best, card.cardPower), 0);
  const challengerBest = bestOf(challengerCards);
  const opponentBest = bestOf(opponentCards);
  if (challengerBest !== opponentBest) return challengerBest > opponentBest ? "challenger" : "opponent";
  return "tie";
}

/* Blackjack: a bust always loses, two busts is a tie, otherwise the higher
   total is by definition the one closer to the target. */
export function resolveBlackjackWinner(
  challengerCards: PackDuelCard[],
  opponentCards: PackDuelCard[],
): PackDuelWinner {
  const challengerBust = isBust(challengerCards);
  const opponentBust = isBust(opponentCards);
  if (challengerBust && opponentBust) return "tie";
  if (challengerBust) return "opponent";
  if (opponentBust) return "challenger";
  const challengerTotal = handTotal(challengerCards);
  const opponentTotal = handTotal(opponentCards);
  if (challengerTotal === opponentTotal) return "tie";
  return challengerTotal > opponentTotal ? "challenger" : "opponent";
}

/* Each side deals from its own half of the deck, so both can play at once
   without racing for the next card. */
export function deckSliceFor(side: PackDuelSide): { start: number; end: number } {
  const start = side === "challenger" ? 0 : BLACKJACK_CARDS_PER_SIDE;
  return { start, end: start + BLACKJACK_CARDS_PER_SIDE };
}

const DUEL_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const DUEL_ID_LENGTH = 10;

/* Link-shaped id: lowercase, no lookalike characters, long enough that a duel
   cannot be found by guessing (31^10, and an unguessed duel is merely a page
   showing two hands of cards). */
export function generateDuelId(random: () => number = Math.random): string {
  let id = "";
  for (let index = 0; index < DUEL_ID_LENGTH; index += 1) {
    id += DUEL_ID_ALPHABET[Math.floor(random() * DUEL_ID_ALPHABET.length)] ?? "a";
  }
  return id;
}

export function normalizeDuelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9]{6,16}$/.test(trimmed) ? trimmed : null;
}

function normalizePackType(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_]{1,24}$/.test(value) ? value : null;
}

function parseCards(value: unknown, max: number): PackDuelCard[] {
  if (typeof value !== "string" || !value) return [];
  try {
    return normalizeDuelCards(JSON.parse(value), max);
  } catch {
    return [];
  }
}

/* The deal log: which side each dealt card went to, in deal order. The card
   itself is deck[poolIndex]. */
interface DuelDeal {
  side: PackDuelSide;
  poolIndex: number;
}

function parseDeals(value: unknown): DuelDeal[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const raw = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        const side = entry?.side === "opponent" ? "opponent" : entry?.side === "challenger" ? "challenger" : null;
        const poolIndex = Math.floor(Number(entry?.poolIndex));
        if (!side || !Number.isInteger(poolIndex) || poolIndex < 0 || poolIndex >= BLACKJACK_DECK_SIZE) return null;
        return { side, poolIndex } as DuelDeal;
      })
      .filter((entry): entry is DuelDeal => entry !== null)
      .slice(0, BLACKJACK_DECK_SIZE);
  } catch {
    return [];
  }
}

interface DuelRowState {
  duel: PackDuel;
  /* Server-side only: the undealt deck never leaves this module. */
  deck: PackDuelCard[];
  deals: DuelDeal[];
}

function readRow(row: Record<string, unknown>): DuelRowState {
  const kind: PackDuelKind = row.kind === "blackjack" ? "blackjack" : "challenge";
  const deck = kind === "blackjack" ? parseCards(row.pool_json, BLACKJACK_DECK_SIZE) : [];
  const deals = kind === "blackjack" ? parseDeals(row.deals_json) : [];
  const handOf = (side: PackDuelSide) =>
    deals.filter((deal) => deal.side === side).map((deal) => deck[deal.poolIndex]).filter(Boolean);
  const challengerCards = kind === "blackjack" ? handOf("challenger") : parseCards(row.challenger_cards_json, PACK_DUEL_MAX_CARDS);
  const opponentCards = kind === "blackjack" ? handOf("opponent") : parseCards(row.opponent_cards_json, PACK_DUEL_MAX_CARDS);
  const opponentUserId = Number(row.opponent_user_id) || 0;
  const status: PackDuelStatus = row.status === "resolved" ? "resolved" : "open";
  const scoreOf = (cards: PackDuelCard[]) => (kind === "blackjack" ? handTotal(cards) : scoreDuelCards(cards));
  return {
    deck,
    deals,
    duel: {
      id: String(row.id),
      kind,
      packType: String(row.pack_type ?? ""),
      status,
      challenger: {
        userId: Number(row.challenger_user_id) || 0,
        username: typeof row.challenger_username === "string" ? row.challenger_username : null,
        cards: challengerCards,
        score: scoreOf(challengerCards),
        cardCount: challengerCards.length,
        done: Number(row.challenger_done) === 1,
        bust: kind === "blackjack" && isBust(challengerCards),
      },
      opponent: {
        userId: opponentUserId > 0 ? opponentUserId : null,
        username: typeof row.opponent_username === "string" ? row.opponent_username : null,
        cards: opponentCards,
        score: scoreOf(opponentCards),
        cardCount: opponentCards.length,
        done: Number(row.opponent_done) === 1,
        bust: kind === "blackjack" && isBust(opponentCards),
      },
      target: BLACKJACK_TARGET,
      winner:
        row.winner === "challenger" || row.winner === "opponent" || row.winner === "tie" ? row.winner : null,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      resolvedAt: Number(row.resolved_at) || null,
    },
  };
}

async function readDuel(db: Db, id: string): Promise<DuelRowState | null> {
  const duelId = normalizeDuelId(id);
  if (!duelId) return null;
  const row = (await exec(db, "select * from pack_duels where id = ?", [duelId])).rows[0];
  return row ? readRow(row as Record<string, unknown>) : null;
}

export async function getPackDuel(db: Db, id: string): Promise<PackDuel | null> {
  return (await readDuel(db, id))?.duel ?? null;
}

/* What one reader may see.

   A challenge keeps the challenger's hand sealed until someone answers: a duel
   you can size up before accepting is not a duel. Blackjack hides each side's
   cards from the other until both have stopped, so neither can play against
   the other's total. Your own hand is always yours to see, which is why this
   takes a viewer; a public read passes null and sees neither hand. */
export function redactDuelFor(duel: PackDuel, viewerId: number | null): PackDuel {
  if (duel.status === "resolved") return duel;
  const hide = (side: PackDuelSideState): PackDuelSideState =>
    side.userId !== null && side.userId === viewerId
      ? side
      : { ...side, cards: [], score: 0, bust: false, hidden: true };
  if (duel.kind === "challenge") {
    return { ...duel, challenger: hide(duel.challenger) };
  }
  return { ...duel, challenger: hide(duel.challenger), opponent: hide(duel.opponent) };
}

async function underHourlyCap(db: Db, userId: number, now: number): Promise<boolean> {
  const row = (await exec(
    db,
    "select count(*) as n from pack_duels where challenger_user_id = ? and created_at > ?",
    [userId, now - 60 * 60 * 1000],
  )).rows[0];
  return (Number(row?.n) || 0) < PACK_DUEL_HOURLY_CAP;
}

export interface CreatePackDuelInput {
  kind: unknown;
  packType: unknown;
  /* challenge: the challenger's frozen hand. blackjack: the deck. */
  cards: unknown;
}

export type CreatePackDuelResult =
  | { ok: true; duel: PackDuel }
  | { ok: false; error: "invalid_duel" | "rate_limited" };

/* Dev-only escape hatch: lets one account sit on both sides of a duel, so the
   whole flow can be played through with a single osu! login. The HTTP layer
   only ever passes this outside production, and it is the sole rule any of the
   duel writes will bend. */
export interface PackDuelOptions {
  allowSelfDuel?: boolean;
}

export async function createPackDuel(
  db: Db,
  challengerUserId: number,
  challengerUsername: string,
  input: CreatePackDuelInput,
  now = Date.now(),
  random: () => number = Math.random,
): Promise<CreatePackDuelResult> {
  const kind: PackDuelKind | null =
    input.kind === "blackjack" ? "blackjack" : input.kind === "challenge" ? "challenge" : null;
  const packType = normalizePackType(input.packType);
  if (!kind || !packType || !Number.isInteger(challengerUserId) || challengerUserId <= 0) {
    return { ok: false, error: "invalid_duel" };
  }
  const cards = normalizeDuelCards(input.cards, kind === "blackjack" ? BLACKJACK_DECK_SIZE : PACK_DUEL_MAX_CARDS);
  // Blackjack needs its whole deck up front: hands are dealt from fixed
  // per-side slices of it, so a short deck would quietly shorten a side.
  if (kind === "blackjack" ? cards.length !== BLACKJACK_DECK_SIZE : cards.length === 0) {
    return { ok: false, error: "invalid_duel" };
  }
  if (!(await underHourlyCap(db, challengerUserId, now))) return { ok: false, error: "rate_limited" };

  // The challenger's opening hand is dealt with the duel, so the board is
  // never empty when they arrive.
  const opening: DuelDeal[] =
    kind === "blackjack"
      ? Array.from({ length: BLACKJACK_OPENING_CARDS }, (_, index) => ({
          side: "challenger" as PackDuelSide,
          poolIndex: deckSliceFor("challenger").start + index,
        }))
      : [];

  const id = generateDuelId(random);
  await exec(
    db,
    `insert into pack_duels (
       id, kind, pack_type, status, challenger_user_id, challenger_username,
       challenger_cards_json, challenger_score, pool_json, deals_json, deals_count, created_at, updated_at
     ) values (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      kind,
      packType,
      challengerUserId,
      challengerUsername.slice(0, 40),
      kind === "blackjack" ? null : JSON.stringify(cards),
      kind === "blackjack" ? 0 : scoreDuelCards(cards),
      kind === "blackjack" ? JSON.stringify(cards) : null,
      kind === "blackjack" ? JSON.stringify(opening) : null,
      opening.length,
      now,
      now,
    ],
  );
  const duel = await getPackDuel(db, id);
  return duel ? { ok: true, duel } : { ok: false, error: "invalid_duel" };
}

export type JoinPackDuelResult =
  | { ok: true; duel: PackDuel }
  | { ok: false; error: "not_found" | "already_joined" | "own_duel" | "invalid_cards" | "wrong_kind" };

/* The opponent's side of a challenge duel: their hand lands, and the duel
   resolves immediately because there is nothing else to wait for. */
export async function joinPackDuel(
  db: Db,
  id: string,
  opponentUserId: number,
  opponentUsername: string,
  cards: unknown,
  now = Date.now(),
  options: PackDuelOptions = {},
): Promise<JoinPackDuelResult> {
  const duel = await getPackDuel(db, id);
  if (!duel) return { ok: false, error: "not_found" };
  if (duel.kind !== "challenge") return { ok: false, error: "wrong_kind" };
  if (duel.challenger.userId === opponentUserId && !options.allowSelfDuel) {
    return { ok: false, error: "own_duel" };
  }
  if (duel.opponent.userId) return { ok: false, error: "already_joined" };
  const hand = normalizeDuelCards(cards, PACK_DUEL_MAX_CARDS);
  if (hand.length === 0) return { ok: false, error: "invalid_cards" };

  const winner = resolveDuelWinner(duel.challenger.cards, hand);
  const updated = (await exec(
    db,
    `update pack_duels
     set opponent_user_id = ?, opponent_username = ?, opponent_cards_json = ?, opponent_score = ?,
         status = 'resolved', winner = ?, updated_at = ?, resolved_at = ?
     where id = ? and opponent_user_id is null`,
    [
      opponentUserId,
      opponentUsername.slice(0, 40),
      JSON.stringify(hand),
      scoreDuelCards(hand),
      winner,
      now,
      now,
      duel.id,
    ],
  )).rowsAffected;
  // Lost the race to another opponent between the read and the write.
  if (updated === 0) return { ok: false, error: "already_joined" };
  const fresh = await getPackDuel(db, duel.id);
  return fresh ? { ok: true, duel: fresh } : { ok: false, error: "not_found" };
}

export type BlackjackJoinResult =
  | { ok: true; duel: PackDuel }
  | { ok: false; error: "not_found" | "already_joined" | "own_duel" | "wrong_kind" };

/* Taking the other seat at a blackjack duel. The opponent brings no hand: they
   are dealt their opening two from their half of the deck on arrival. Coming
   back to the link later is a no-op rather than a redeal. */
export async function joinPackBlackjack(
  db: Db,
  id: string,
  opponentUserId: number,
  opponentUsername: string,
  now = Date.now(),
  options: PackDuelOptions = {},
): Promise<BlackjackJoinResult> {
  const state = await readDuel(db, id);
  if (!state) return { ok: false, error: "not_found" };
  const { duel, deals } = state;
  if (duel.kind !== "blackjack") return { ok: false, error: "wrong_kind" };
  if (duel.challenger.userId === opponentUserId && !options.allowSelfDuel) {
    return { ok: false, error: "own_duel" };
  }
  if (duel.opponent.userId && duel.opponent.userId !== opponentUserId) {
    return { ok: false, error: "already_joined" };
  }
  if (!duel.opponent.userId) {
    const slice = deckSliceFor("opponent");
    const opening: DuelDeal[] = [
      ...deals,
      ...Array.from({ length: BLACKJACK_OPENING_CARDS }, (_, index) => ({
        side: "opponent" as PackDuelSide,
        poolIndex: slice.start + index,
      })),
    ];
    const updated = (await exec(
      db,
      `update pack_duels
       set opponent_user_id = ?, opponent_username = ?, deals_json = ?, deals_count = ?, updated_at = ?
       where id = ? and opponent_user_id is null`,
      [opponentUserId, opponentUsername.slice(0, 40), JSON.stringify(opening), opening.length, now, duel.id],
    )).rowsAffected;
    if (updated === 0) return { ok: false, error: "already_joined" };
  }
  const fresh = await getPackDuel(db, duel.id);
  return fresh ? { ok: true, duel: fresh } : { ok: false, error: "not_found" };
}

export type BlackjackMoveResult =
  | { ok: true; duel: PackDuel }
  | {
      ok: false;
      error: "not_found" | "wrong_kind" | "not_a_player" | "already_done" | "no_cards_left" | "duel_over" | "retry";
    };

function sideOfViewer(duel: PackDuel, userId: number): PackDuelSide | null {
  // A self-duel (dev hatch) holds both seats; the side still in play is the
  // one that move belongs to.
  if (duel.challenger.userId === userId && duel.opponent.userId === userId) {
    return duel.challenger.done ? "opponent" : "challenger";
  }
  if (duel.challenger.userId === userId) return "challenger";
  if (duel.opponent.userId === userId) return "opponent";
  return null;
}

/* Resolves the duel when both sides have stopped. */
function blackjackOutcome(
  challengerDone: boolean,
  opponentDone: boolean,
  challengerCards: PackDuelCard[],
  opponentCards: PackDuelCard[],
): { status: PackDuelStatus; winner: PackDuelWinner | null } {
  if (!challengerDone || !opponentDone) return { status: "open", winner: null };
  return { status: "resolved", winner: resolveBlackjackWinner(challengerCards, opponentCards) };
}

/* Takes one more card. Going over the target ends that side's hand there and
   then: a bust has nothing left to decide. */
export async function hitPackBlackjack(
  db: Db,
  id: string,
  userId: number,
  now = Date.now(),
): Promise<BlackjackMoveResult> {
  const state = await readDuel(db, id);
  if (!state) return { ok: false, error: "not_found" };
  const { duel, deck, deals } = state;
  if (duel.kind !== "blackjack") return { ok: false, error: "wrong_kind" };
  if (duel.status === "resolved") return { ok: false, error: "duel_over" };
  const side = sideOfViewer(duel, userId);
  if (!side) return { ok: false, error: "not_a_player" };
  if (!duel.opponent.userId) return { ok: false, error: "duel_over" };
  if (side === "challenger" ? duel.challenger.done : duel.opponent.done) {
    return { ok: false, error: "already_done" };
  }

  const slice = deckSliceFor(side);
  const dealt = deals.filter((deal) => deal.side === side).length;
  const nextIndex = slice.start + dealt;
  // Out of cards: the hand stands where it is rather than stalling.
  if (nextIndex >= slice.end) {
    return standPackBlackjack(db, id, userId, now);
  }

  const nextDeals = [...deals, { side, poolIndex: nextIndex }];
  const handOf = (target: PackDuelSide) =>
    nextDeals.filter((deal) => deal.side === target).map((deal) => deck[deal.poolIndex]).filter(Boolean);
  const challengerCards = handOf("challenger");
  const opponentCards = handOf("opponent");
  const busted = isBust(side === "challenger" ? challengerCards : opponentCards);
  const challengerDone = side === "challenger" ? duel.challenger.done || busted : duel.challenger.done;
  const opponentDone = side === "opponent" ? duel.opponent.done || busted : duel.opponent.done;
  const outcome = blackjackOutcome(challengerDone, opponentDone, challengerCards, opponentCards);

  const updated = (await exec(
    db,
    `update pack_duels
     set deals_json = ?, deals_count = ?, challenger_done = ?, opponent_done = ?,
         challenger_score = ?, opponent_score = ?, status = ?, winner = ?, updated_at = ?, resolved_at = ?
     where id = ? and deals_count = ?`,
    [
      JSON.stringify(nextDeals),
      nextDeals.length,
      challengerDone ? 1 : 0,
      opponentDone ? 1 : 0,
      handTotal(challengerCards),
      handTotal(opponentCards),
      outcome.status,
      outcome.winner,
      now,
      outcome.status === "resolved" ? now : null,
      duel.id,
      deals.length,
    ] as InValue[],
  )).rowsAffected;
  // The deal count in the where clause is the concurrency guard: two hits
  // fired at once, only the first lands, and the second is told to look again.
  if (updated === 0) return { ok: false, error: "retry" };
  const fresh = await getPackDuel(db, duel.id);
  return fresh ? { ok: true, duel: fresh } : { ok: false, error: "not_found" };
}

/* Stops on the hand as it stands. The second side to stop resolves the duel. */
export async function standPackBlackjack(
  db: Db,
  id: string,
  userId: number,
  now = Date.now(),
): Promise<BlackjackMoveResult> {
  const state = await readDuel(db, id);
  if (!state) return { ok: false, error: "not_found" };
  const { duel } = state;
  if (duel.kind !== "blackjack") return { ok: false, error: "wrong_kind" };
  if (duel.status === "resolved") return { ok: false, error: "duel_over" };
  const side = sideOfViewer(duel, userId);
  if (!side) return { ok: false, error: "not_a_player" };
  if (!duel.opponent.userId) return { ok: false, error: "duel_over" };
  if (side === "challenger" ? duel.challenger.done : duel.opponent.done) {
    return { ok: false, error: "already_done" };
  }

  const challengerDone = side === "challenger" ? true : duel.challenger.done;
  const opponentDone = side === "opponent" ? true : duel.opponent.done;
  const outcome = blackjackOutcome(challengerDone, opponentDone, duel.challenger.cards, duel.opponent.cards);
  const updated = (await exec(
    db,
    `update pack_duels
     set challenger_done = ?, opponent_done = ?, status = ?, winner = ?, updated_at = ?, resolved_at = ?
     where id = ? and ${side === "challenger" ? "challenger_done" : "opponent_done"} = 0`,
    [
      challengerDone ? 1 : 0,
      opponentDone ? 1 : 0,
      outcome.status,
      outcome.winner,
      now,
      outcome.status === "resolved" ? now : null,
      duel.id,
    ] as InValue[],
  )).rowsAffected;
  if (updated === 0) return { ok: false, error: "retry" };
  const fresh = await getPackDuel(db, duel.id);
  return fresh ? { ok: true, duel: fresh } : { ok: false, error: "not_found" };
}
