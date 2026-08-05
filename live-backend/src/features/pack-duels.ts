import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { DUEL_LOSS_SHARDS, DUEL_TIE_SHARDS, DUEL_WIN_SHARDS, grantPackGameShards } from "./pack-games.js";
import {
  heldPackCollectionCardKeys,
  packCardKey,
  transferPackCollectionCards,
  type PackCardTransfer,
} from "./pack-wallets.js";

// Pack duels: two collectors, two hands of maniacards, four rounds of top
// trumps. No card here enters a collection or mints a serial; the only thing
// that moves is the arcade's shard payout when a duel ends.
//
// A duel is one card from each side per round, and both sides attack at the
// same time: you pick one stat off your own card, they pick one off theirs,
// and an attack lands when your card beats theirs on the stat you chose. So a
// round is worth up to two points, nobody waits for a turn, and neither seat
// gets the advantage of picking last. The two cards and both picks open up the
// moment the round resolves; until then you are choosing against a card you
// cannot see, which is half the game.
//
// The other half, and the reason a duel is not just "attack with your biggest
// number": each stat can be spent only once in a duel, and there are exactly
// as many rounds as there are stats. Every attack therefore costs you that
// stat for the rest of the duel, so the question is never "what is this card
// good at" but "which of my four cards should spend my Speed" - and by the
// last round both sides are down to the stat they held back, which each of
// them can work out. Card fronts are calibrated so a card is a shape rather
// than a single number, and reading those shapes is what wins the allocation.
//
// Card stats are client-reported, exactly like the pull log, so a determined
// client can inflate its own hand; that is the accepted trade for a feature
// whose entire prize is bragging rights. The parts that would actually decide
// a game are server-held: each hand is frozen when its side arrives, a pick is
// written before the other side's is revealed, and no card is visible to the
// other player until the round it was played in is over.

/* Brings an existing pack_duels table up to the current shape.

   The schema lives in a `create table if not exists` migration, which by
   definition does nothing to a table that already exists, so a database that
   met an earlier version of this prototype keeps the old columns and every
   insert fails on the new ones. Adding the missing columns is enough: they are
   all nullable or defaulted. Rows from the retired modes go with them, since
   nothing can read them any more.

   Prototype-only cleanup. Once the mode ships, schema changes belong in a
   numbered migration instead. */
export async function ensurePackDuelsSchema(db: Db): Promise<boolean> {
  const columns = (await exec(db, "pragma table_info(pack_duels)")).rows;
  if (columns.length === 0) return false;
  const present = new Set(columns.map((column) => String(column.name)));
  const additions: Array<[string, string]> = [
    ["spoils_json", "text"],
    ["picks_json", "text"],
    ["picks_count", "integer not null default 0"],
    ["challenger_shards", "integer not null default 0"],
    ["opponent_shards", "integer not null default 0"],
  ];
  let changed = false;
  for (const [name, definition] of additions) {
    if (present.has(name)) continue;
    await exec(db, `alter table pack_duels add column ${name} ${definition}`);
    changed = true;
  }
  const retired = (await exec(db, "delete from pack_duels where kind <> 'trumps'")).rowsAffected;
  return changed || retired > 0;
}

export type PackDuelKind = "trumps";
export type PackDuelStatus = "open" | "resolved";
export type PackDuelWinner = "challenger" | "opponent" | "tie";
export type PackDuelSide = "challenger" | "opponent";

/* What a round can be decided on: the three skills printed on a card front
   plus its star average. Everything you may attack with is a number the card
   itself shows, so a pick never depends on knowing a hidden statistic. */
export type TrumpStat = "control" | "speed" | "precision" | "stars";
export const TRUMP_STATS = ["control", "speed", "precision", "stars"] as const;

/* One round per stat, because each stat is spent once: the duel is the
   allocation of four attacks across four cards, and it ends when you are out
   of stats to spend. Also fits the smallest pack's five cards. */
export const TRUMPS_ROUNDS = TRUMP_STATS.length;

/* A hand freezes whatever the pack dealt, up to the Wild pack's ten. Only the
   first TRUMPS_ROUNDS of it are ever played. */
export const PACK_DUEL_MAX_CARDS = 10;

/* Duels a single account can open per hour. Generous next to any real use;
   it exists so the table cannot be used as free write amplification. */
export const PACK_DUEL_HOURLY_CAP = 60;

/* Card power is a mint statistic in the low hundreds to low thousands, skills
   are drawn on a 0-1500 display scale, and a star rating tops out around 10.
   The clamps keep a tampered client inside a range where the scoreboard still
   reads as a scoreboard. */
const MAX_CARD_POWER = 5000;
const MAX_SKILL_STAT = 2000;
const MAX_STAR_STAT = 15;

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
  /* The numbers a round is decided on, all of them printed on the card. */
  stats: Record<TrumpStat, number>;
  globalRank: number;
  pp: number;
  /* The mint's skills snapshot, so the duel page can redraw the real card
     front offline exactly like the collection does. */
  skills: unknown | null;
}

/* One round of the duel. The stats are nulled by redaction while a round is
   still being played; the picked flags stay truthful either way, so the board
   can say "they have locked theirs in" without saying what it was. */
export interface PackDuelRound {
  round: number;
  challengerStat: TrumpStat | null;
  opponentStat: TrumpStat | null;
  challengerPicked: boolean;
  opponentPicked: boolean;
  /* Whether that side's attack landed. Meaningless until resolved. */
  challengerPoint: boolean;
  opponentPoint: boolean;
  resolved: boolean;
}

export interface PackDuelSideState {
  userId: number | null;
  username: string | null;
  cards: PackDuelCard[];
  /* Rounds won by this side's attacks, which is the duel's score. */
  score: number;
  /* How many cards this side holds, which stays truthful even while the cards
     themselves are hidden from the other player. */
  cardCount: number;
  /* Shards this side was paid when the duel resolved. Zero until then, and
     capped by the arcade's daily allowance, so it can be less than the duel's
     face value. */
  shards: number;
  /* Set on a read where cards were held back from the reader. */
  hidden?: boolean;
}

export interface PackDuelSpoils {
  winner: PackDuelSide;
  /* Every card that changed hands, plus the ones paid out as shards because
     the loser no longer held them. */
  cards: PackCardTransfer[];
  shards: number;
}

export interface PackDuel {
  id: string;
  kind: PackDuelKind;
  packType: string;
  status: PackDuelStatus;
  challenger: PackDuelSideState;
  opponent: PackDuelSideState;
  rounds: PackDuelRound[];
  /* Rounds this duel will play, once both hands are in. Zero while it waits. */
  roundCount: number;
  /* The round being played now, and the count of rounds already resolved. */
  currentRound: number;
  winner: PackDuelWinner | null;
  /* What the winner took, once there is a winner. Null on a tie, where both
     sides keep what they staked. */
  spoils: PackDuelSpoils | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

function clampNumber(value: unknown, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

/* The collection keys a hand puts on the line. */
export function stakeKeysOf(cards: readonly PackDuelCard[]): string[] {
  return [...new Set(cards.map((card) => packCardKey(card.userId, card.tier)))];
}

export function normalizeTrumpStat(value: unknown): TrumpStat | null {
  return TRUMP_STATS.includes(value as TrumpStat) ? (value as TrumpStat) : null;
}

function normalizeStats(value: unknown): Record<TrumpStat, number> {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    control: Math.round(clampNumber(raw.control, 0, MAX_SKILL_STAT)),
    speed: Math.round(clampNumber(raw.speed, 0, MAX_SKILL_STAT)),
    precision: Math.round(clampNumber(raw.precision, 0, MAX_SKILL_STAT)),
    // Two decimals, the precision a star rating is printed at.
    stars: Math.round(clampNumber(raw.stars, 0, MAX_STAR_STAT) * 100) / 100,
  };
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
    stats: normalizeStats(raw.stats),
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

/* The pick log: which stat each side attacked with, in the round it was
   played. Append-only, so the whole board derives from the two hands plus
   this, and a write only ever adds one entry. */
interface TrumpPick {
  round: number;
  side: PackDuelSide;
  stat: TrumpStat;
}

function parsePicks(value: unknown): TrumpPick[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const raw = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    const picks: TrumpPick[] = [];
    const spent = { challenger: new Set<TrumpStat>(), opponent: new Set<TrumpStat>() };
    for (const entry of raw.slice(0, TRUMPS_ROUNDS * 2)) {
      const side = entry?.side === "opponent" ? "opponent" : entry?.side === "challenger" ? "challenger" : null;
      const stat = normalizeTrumpStat(entry?.stat);
      const round = Math.floor(Number(entry?.round));
      if (!side || !stat || !Number.isInteger(round) || round < 0 || round >= TRUMPS_ROUNDS) continue;
      // One pick per side per round, and one use per stat per duel. The write
      // path enforces both; re-enforcing them on the read means a hand-edited
      // row cannot score the same stat twice either.
      if (picks.some((pick) => pick.round === round && pick.side === side)) continue;
      if (spent[side].has(stat)) continue;
      spent[side].add(stat);
      picks.push({ round, side, stat });
    }
    return picks;
  } catch {
    return [];
  }
}

/* The stats a side has already spent, which is what stops the duel being four
   rounds of "attack with your best number". Reading it off the pick log keeps
   it derived rather than stored. */
export function spentTrumpStats(picks: TrumpPick[], side: PackDuelSide): TrumpStat[] {
  return picks.filter((pick) => pick.side === side).map((pick) => pick.stat);
}

function parseSpoils(value: unknown): PackDuelSpoils | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const winner = raw.winner === "opponent" ? "opponent" : raw.winner === "challenger" ? "challenger" : null;
    if (!winner) return null;
    const cards = Array.isArray(raw.cards) ? (raw.cards as PackCardTransfer[]) : [];
    return { winner, cards, shards: Math.max(0, Number(raw.shards) || 0) };
  } catch {
    return null;
  }
}

function parseCards(value: unknown, max: number): PackDuelCard[] {
  if (typeof value !== "string" || !value) return [];
  try {
    return normalizeDuelCards(JSON.parse(value), max);
  } catch {
    return [];
  }
}

/* How many rounds these two hands play. A hand can come up short when a card
   fails to mint, and playing more rounds than the shorter hand can fill would
   hand the longer one free points. */
export function trumpsRoundCount(challengerCards: PackDuelCard[], opponentCards: PackDuelCard[]): number {
  if (challengerCards.length === 0 || opponentCards.length === 0) return 0;
  return Math.min(TRUMPS_ROUNDS, challengerCards.length, opponentCards.length);
}

export interface TrumpsState {
  roundCount: number;
  rounds: PackDuelRound[];
  challengerPoints: number;
  opponentPoints: number;
  currentRound: number;
  complete: boolean;
  winner: PackDuelWinner | null;
}

/* The whole board, derived from the two hands and the pick log.

   An attack lands when your card is strictly higher on the stat you chose, so
   two cards tied on a stat trade nothing: neither of you outplayed the other
   there. */
export function resolveTrumps(
  challengerCards: PackDuelCard[],
  opponentCards: PackDuelCard[],
  picks: TrumpPick[],
): TrumpsState {
  const roundCount = trumpsRoundCount(challengerCards, opponentCards);
  const pickAt = (round: number, side: PackDuelSide): TrumpStat | null =>
    picks.find((pick) => pick.round === round && pick.side === side)?.stat ?? null;

  const rounds: PackDuelRound[] = [];
  let challengerPoints = 0;
  let opponentPoints = 0;
  let currentRound = roundCount;

  for (let round = 0; round < roundCount; round += 1) {
    const challengerStat = pickAt(round, "challenger");
    const opponentStat = pickAt(round, "opponent");
    const resolved = challengerStat !== null && opponentStat !== null;
    const challengerCard = challengerCards[round];
    const opponentCard = opponentCards[round];
    const challengerPoint = Boolean(
      resolved && challengerCard.stats[challengerStat] > opponentCard.stats[challengerStat],
    );
    const opponentPoint = Boolean(
      resolved && opponentCard.stats[opponentStat] > challengerCard.stats[opponentStat],
    );
    if (challengerPoint) challengerPoints += 1;
    if (opponentPoint) opponentPoints += 1;
    if (!resolved && currentRound === roundCount) currentRound = round;
    rounds.push({
      round,
      challengerStat,
      opponentStat,
      challengerPicked: challengerStat !== null,
      opponentPicked: opponentStat !== null,
      challengerPoint,
      opponentPoint,
      resolved,
    });
  }

  const complete = roundCount > 0 && currentRound >= roundCount;
  return {
    roundCount,
    rounds,
    challengerPoints,
    opponentPoints,
    currentRound,
    complete,
    winner: complete
      ? resolveTrumpsWinner(challengerPoints, opponentPoints, challengerCards, opponentCards, roundCount)
      : null,
  };
}

/* More landed attacks wins. A dead heat falls back to the total power of the
   cards actually played, which is the hand you were dealt rather than the way
   you played it, so it only ever settles a duel that was otherwise even. */
export function resolveTrumpsWinner(
  challengerPoints: number,
  opponentPoints: number,
  challengerCards: PackDuelCard[],
  opponentCards: PackDuelCard[],
  roundCount: number,
): PackDuelWinner {
  if (challengerPoints !== opponentPoints) return challengerPoints > opponentPoints ? "challenger" : "opponent";
  const powerOf = (cards: PackDuelCard[]) =>
    cards.slice(0, roundCount).reduce((sum, card) => sum + card.cardPower, 0);
  const challengerPower = powerOf(challengerCards);
  const opponentPower = powerOf(opponentCards);
  if (challengerPower !== opponentPower) return challengerPower > opponentPower ? "challenger" : "opponent";
  return "tie";
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
  return typeof value === "string" && /^[a-z0-9_]{1,24}$/.test(value) ? value : null;
}

interface DuelRowState {
  duel: PackDuel;
  picks: TrumpPick[];
  state: TrumpsState;
}

function readRow(row: Record<string, unknown>): DuelRowState {
  const challengerCards = parseCards(row.challenger_cards_json, PACK_DUEL_MAX_CARDS);
  const opponentCards = parseCards(row.opponent_cards_json, PACK_DUEL_MAX_CARDS);
  const picks = parsePicks(row.picks_json);
  const state = resolveTrumps(challengerCards, opponentCards, picks);
  const opponentUserId = Number(row.opponent_user_id) || 0;
  return {
    picks,
    state,
    duel: {
      id: String(row.id),
      kind: "trumps",
      packType: String(row.pack_type ?? ""),
      // Derived rather than read back: the stored column is a convenience for
      // querying, and the pick log is what actually decides whether a duel is
      // over.
      status: state.complete ? "resolved" : "open",
      challenger: {
        userId: Number(row.challenger_user_id) || 0,
        username: typeof row.challenger_username === "string" ? row.challenger_username : null,
        cards: challengerCards,
        score: state.challengerPoints,
        cardCount: challengerCards.length,
        shards: Math.max(0, Number(row.challenger_shards) || 0),
      },
      opponent: {
        userId: opponentUserId > 0 ? opponentUserId : null,
        username: typeof row.opponent_username === "string" ? row.opponent_username : null,
        cards: opponentCards,
        score: state.opponentPoints,
        cardCount: opponentCards.length,
        shards: Math.max(0, Number(row.opponent_shards) || 0),
      },
      rounds: state.rounds,
      roundCount: state.roundCount,
      currentRound: state.currentRound,
      winner: state.winner,
      spoils: parseSpoils(row.spoils_json),
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

   A card stays face down until the round it is played in is over: that is the
   entire game, since a stat you pick against a card you can already read is
   not a guess. Rounds reveal in order, so the visible part of a hand is always
   its resolved prefix. The pick itself is held back the same way, so nobody
   can wait to see what the other side attacked with.

   Your own hand is always yours to see, which is why this takes a viewer; a
   public read passes null and sees only what both players have already
   played. */
export function redactDuelFor(duel: PackDuel, viewerId: number | null): PackDuel {
  if (duel.status === "resolved") return duel;
  const revealed = duel.currentRound;
  const trim = (side: PackDuelSideState): PackDuelSideState => {
    if (side.userId !== null && side.userId === viewerId) return side;
    if (side.cards.length <= revealed) return side;
    return { ...side, cards: side.cards.slice(0, revealed), hidden: true };
  };
  const showChallengerPicks = duel.challenger.userId !== null && duel.challenger.userId === viewerId;
  const showOpponentPicks = duel.opponent.userId !== null && duel.opponent.userId === viewerId;
  return {
    ...duel,
    challenger: trim(duel.challenger),
    opponent: trim(duel.opponent),
    rounds: duel.rounds.map((round) =>
      round.resolved
        ? round
        : {
            ...round,
            challengerStat: showChallengerPicks ? round.challengerStat : null,
            opponentStat: showOpponentPicks ? round.opponentStat : null,
          },
    ),
  };
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
  packType: unknown;
  /* The challenger's hand, frozen as it was pulled. */
  cards: unknown;
}

export type CreatePackDuelResult =
  | { ok: true; duel: PackDuel }
  | { ok: false; error: "invalid_duel" | "rate_limited" | "stake_not_held" };

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
  const packType = normalizePackType(input.packType);
  if (!packType || !Number.isInteger(challengerUserId) || challengerUserId <= 0) {
    return { ok: false, error: "invalid_duel" };
  }
  const cards = normalizeDuelCards(input.cards, PACK_DUEL_MAX_CARDS);
  if (cards.length === 0) return { ok: false, error: "invalid_duel" };
  // You can only put up cards you hold. Checked here rather than trusted,
  // because losing this duel takes them out of your collection.
  if (!(await holdsWholeStake(db, challengerUserId, cards))) return { ok: false, error: "stake_not_held" };
  if (!(await underHourlyCap(db, challengerUserId, now))) return { ok: false, error: "rate_limited" };

  const id = generateDuelId(random);
  await exec(
    db,
    `insert into pack_duels (
       id, kind, pack_type, status, challenger_user_id, challenger_username,
       challenger_cards_json, challenger_score, picks_json, picks_count, created_at, updated_at
     ) values (?, 'trumps', ?, 'open', ?, ?, ?, 0, '[]', 0, ?, ?)`,
    [id, packType, challengerUserId, challengerUsername.slice(0, 40), JSON.stringify(cards), now, now],
  );
  const duel = await getPackDuel(db, id);
  return duel ? { ok: true, duel } : { ok: false, error: "invalid_duel" };
}

export type JoinPackDuelResult =
  | { ok: true; duel: PackDuel }
  | { ok: false; error: "not_found" | "already_joined" | "own_duel" | "invalid_cards" | "stake_not_held" };

/* Whether this account holds every card in a hand. A stake is all or nothing:
   half a hand on the line would quietly change what the duel is worth after
   the other side has already agreed to it. */
async function holdsWholeStake(db: Db, userId: number, cards: PackDuelCard[]): Promise<boolean> {
  const keys = stakeKeysOf(cards);
  const held = await heldPackCollectionCardKeys(db, userId, keys);
  return keys.every((key) => held.has(key));
}

/* Taking the other seat: the opponent brings their own hand, and round one
   opens the moment it lands. Nothing is compared yet, because neither side has
   attacked. */
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
  if (duel.challenger.userId === opponentUserId && !options.allowSelfDuel) {
    return { ok: false, error: "own_duel" };
  }
  if (duel.opponent.userId) return { ok: false, error: "already_joined" };
  const hand = normalizeDuelCards(cards, PACK_DUEL_MAX_CARDS);
  if (hand.length === 0) return { ok: false, error: "invalid_cards" };
  if (!options.allowSelfDuel && !(await holdsWholeStake(db, opponentUserId, hand))) {
    return { ok: false, error: "stake_not_held" };
  }

  const updated = (await exec(
    db,
    `update pack_duels
     set opponent_user_id = ?, opponent_username = ?, opponent_cards_json = ?, updated_at = ?
     where id = ? and opponent_user_id is null`,
    [opponentUserId, opponentUsername.slice(0, 40), JSON.stringify(hand), now, duel.id],
  )).rowsAffected;
  // Lost the race to another opponent between the read and the write.
  if (updated === 0) return { ok: false, error: "already_joined" };
  const fresh = await getPackDuel(db, duel.id);
  return fresh ? { ok: true, duel: fresh } : { ok: false, error: "not_found" };
}

export type PackDuelPickResult =
  | { ok: true; duel: PackDuel }
  | {
      ok: false;
      error:
        | "not_found"
        | "not_a_player"
        | "already_done"
        | "duel_over"
        | "wrong_round"
        | "invalid_pick"
        | "stat_spent"
        | "retry";
    };

function sideOfViewer(duel: PackDuel, userId: number, round: number): PackDuelSide | null {
  const isChallenger = duel.challenger.userId === userId;
  const isOpponent = duel.opponent.userId === userId;
  // A self-duel (dev hatch) holds both seats; the pick lands on whichever side
  // still owes this round an attack.
  if (isChallenger && isOpponent) {
    const current = duel.rounds[round];
    return current && current.challengerPicked ? "opponent" : "challenger";
  }
  if (isChallenger) return "challenger";
  if (isOpponent) return "opponent";
  return null;
}

/* Attacks with one stat off your card for the round being played. The second
   pick of a round resolves it, and the pick that resolves the last round ends
   the duel. */
export async function pickPackDuelStat(
  db: Db,
  id: string,
  userId: number,
  round: unknown,
  stat: unknown,
  now = Date.now(),
): Promise<PackDuelPickResult> {
  const state = await readDuel(db, id);
  if (!state) return { ok: false, error: "not_found" };
  const { duel, picks } = state;
  if (duel.status === "resolved") return { ok: false, error: "duel_over" };
  if (!duel.opponent.userId || duel.roundCount === 0) return { ok: false, error: "duel_over" };
  const pickStat = normalizeTrumpStat(stat);
  if (!pickStat) return { ok: false, error: "invalid_pick" };
  const side = sideOfViewer(duel, userId, duel.currentRound);
  if (!side) return { ok: false, error: "not_a_player" };
  // The round is named in the request so a stale board cannot land a pick on a
  // round that has already moved on underneath it.
  if (Math.floor(Number(round)) !== duel.currentRound) return { ok: false, error: "wrong_round" };
  const current = duel.rounds[duel.currentRound];
  if (side === "challenger" ? current.challengerPicked : current.opponentPicked) {
    return { ok: false, error: "already_done" };
  }
  // Each stat is spent once per duel, so a side cannot ride its best number
  // through all four rounds.
  if (spentTrumpStats(picks, side).includes(pickStat)) return { ok: false, error: "stat_spent" };

  const nextPicks = [...picks, { round: duel.currentRound, side, stat: pickStat }];
  const next = resolveTrumps(duel.challenger.cards, duel.opponent.cards, nextPicks);
  const updated = (await exec(
    db,
    `update pack_duels
     set picks_json = ?, picks_count = ?, challenger_score = ?, opponent_score = ?,
         status = ?, winner = ?, updated_at = ?, resolved_at = ?
     where id = ? and picks_count = ?`,
    [
      JSON.stringify(nextPicks),
      nextPicks.length,
      next.challengerPoints,
      next.opponentPoints,
      next.complete ? "resolved" : "open",
      next.winner,
      now,
      next.complete ? now : null,
      duel.id,
      picks.length,
    ] as InValue[],
  )).rowsAffected;
  // The pick count in the where clause is the concurrency guard: both sides
  // pick at once, only the first write lands, and the second is told to look
  // again rather than overwriting the log it never read.
  if (updated === 0) return { ok: false, error: "retry" };
  // The pick that ends the duel is also the one that pays for it, and it only
  // gets here after winning the picks_count guard, so a duel pays exactly once.
  if (next.complete) await settleDuel(db, duel, next.winner, now);
  const fresh = await getPackDuel(db, duel.id);
  return fresh ? { ok: true, duel: fresh } : { ok: false, error: "not_found" };
}

/* Settling a finished duel: the winner takes the loser's staked cards, and
   both sides are paid shards on top - the winner for winning, the loser for
   answering at all (which cost them a pack). What each actually receives in
   shards is trimmed by their own daily allowance, so the amounts are stored
   per duel rather than inferred from the result.

   Runs only for the pick that won the picks_count guard, so a duel settles
   exactly once however many clients are polling it. */
async function settleDuel(
  db: Db,
  duel: PackDuel,
  winner: PackDuelWinner | null,
  now: number,
): Promise<void> {
  const owed = (side: PackDuelSide): number => {
    if (winner === "tie") return DUEL_TIE_SHARDS;
    return winner === side ? DUEL_WIN_SHARDS : DUEL_LOSS_SHARDS;
  };
  const pay = async (side: PackDuelSide): Promise<number> => {
    const userId = duel[side].userId;
    if (!userId) return 0;
    return (await grantPackGameShards(db, userId, "duel", owed(side), now)).granted;
  };
  const challengerShards = await pay("challenger");
  const opponentShards = await pay("opponent");

  // A tie leaves both collections alone: nobody outplayed anybody.
  let spoils: PackDuelSpoils | null = null;
  if (winner === "challenger" || winner === "opponent") {
    const loser: PackDuelSide = winner === "challenger" ? "opponent" : "challenger";
    const winnerId = duel[winner].userId;
    const loserId = duel[loser].userId;
    if (winnerId && loserId) {
      const taken = await transferPackCollectionCards(
        db,
        loserId,
        winnerId,
        stakeKeysOf(duel[loser].cards),
        now,
      );
      if (taken.moved.length > 0) spoils = { winner, cards: taken.moved, shards: taken.shards };
    }
  }

  if (challengerShards === 0 && opponentShards === 0 && !spoils) return;
  await exec(
    db,
    "update pack_duels set challenger_shards = ?, opponent_shards = ?, spoils_json = ? where id = ?",
    [challengerShards, opponentShards, spoils ? JSON.stringify(spoils) : null, duel.id],
  );
}
