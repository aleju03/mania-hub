import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { AbuseGuard } from "../src/http/abuse-guard.js";
import { routeHttp } from "../src/http/snapshots.js";
import { JobQueue } from "../src/jobs/queue.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { GAME_SHARD_DAILY_CAP, DUEL_LOSS_SHARDS, DUEL_WIN_SHARDS } from "../src/features/pack-games.js";
import {
  createPackDuel,
  ensurePackDuelsSchema,
  generateDuelId,
  getPackDuel,
  joinPackDuel,
  pickPackDuelStat,
  redactDuelFor,
  resolveTrumps,
  resolveTrumpsWinner,
  trumpsRoundCount,
  TRUMPS_ROUNDS,
  type PackDuelCard,
  type TrumpStat,
} from "../src/features/pack-duels.js";

let dir = "";
let db: Db;
let queue: JobQueue;
let events: LiveEventLog;

const ADMIN = { authorization: "Bearer secret" };

const CHALLENGER = 100;
const OPPONENT = 200;
const BYSTANDER = 300;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-duels-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  queue = new JobQueue(db);
  events = new LiveEventLog(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function card(
  userId: number,
  stats: Partial<Record<TrumpStat, number>> = {},
  cardPower = 500,
): PackDuelCard {
  return {
    userId,
    username: `player${userId}`,
    countryCode: "CR",
    avatarUrl: "",
    tier: "rare",
    tierLabel: "Rare",
    cardPower,
    stats: { control: 500, speed: 500, precision: 500, stars: 5, ...stats },
    globalRank: 1000,
    pp: 5000,
    skills: null,
  };
}

/* A full-length hand of identical cards: the tests then vary one stat and read
   the outcome off it. */
function hand(offset: number, stats: Partial<Record<TrumpStat, number>> = {}, cardPower = 500): PackDuelCard[] {
  return Array.from({ length: TRUMPS_ROUNDS }, (_, index) => card(offset + index + 1, stats, cardPower));
}

/* Spending each stat once, in order, is the only legal way through a duel. */
const STAT_ORDER: TrumpStat[] = ["control", "speed", "precision", "stars"];

/* Duels are played for keeps, so a hand has to be in a collection before it
   can be staked. This is the pull that would have put it there. */
async function grantCards(ownerUserId: number, cards: PackDuelCard[], copies = 1): Promise<void> {
  for (const card of cards) {
    await exec(
      db,
      `insert into pack_collection_cards (
         owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label,
         skills_json, pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
       ) values (?, ?, ?, ?, '', 'CR', ?, ?, null, ?, ?, ?, 0, 1, 1, 1)
       on conflict(owner_user_id, card_key) do update set copies = pack_collection_cards.copies + excluded.copies`,
      [
        ownerUserId,
        card.userId,
        String(card.userId),
        card.username,
        card.tier,
        card.tierLabel,
        card.pp,
        card.globalRank,
        copies,
      ],
    );
  }
}

async function copiesHeld(ownerUserId: number, cardUserId: number): Promise<number> {
  const row = (await exec(
    db,
    "select copies from pack_collection_cards where owner_user_id = ? and card_key = ?",
    [ownerUserId, String(cardUserId)],
  )).rows[0];
  return row ? Number(row.copies) : 0;
}

async function openDuel(cards = hand(0, { control: 900 }, 900)) {
  await grantCards(CHALLENGER, cards);
  const created = await createPackDuel(db, CHALLENGER, "alpha", { packType: "standard", cards });
  if (!created.ok) throw new Error(`duel not created: ${created.error}`);
  return created.duel;
}

async function seatOpponent(id: string, cards = hand(50, { speed: 900 })) {
  await grantCards(OPPONENT, cards);
  const joined = await joinPackDuel(db, id, OPPONENT, "beta", cards);
  if (!joined.ok) throw new Error(`join failed: ${joined.error}`);
  return joined.duel;
}

async function playDuelOut(id: string, rounds = TRUMPS_ROUNDS) {
  let last: Awaited<ReturnType<typeof playRound>> | null = null;
  for (let round = 0; round < rounds; round += 1) {
    last = await playRound(id, round, STAT_ORDER[round], STAT_ORDER[round]);
  }
  if (!last) throw new Error("no rounds played");
  return last;
}

async function playRound(id: string, round: number, challengerStat: TrumpStat, opponentStat: TrumpStat) {
  const first = await pickPackDuelStat(db, id, CHALLENGER, round, challengerStat);
  if (!first.ok) throw new Error(`challenger pick failed: ${first.error}`);
  const second = await pickPackDuelStat(db, id, OPPONENT, round, opponentStat);
  if (!second.ok) throw new Error(`opponent pick failed: ${second.error}`);
  return second.duel;
}

describe("trumps scoring", () => {
  it("lands an attack only when your card is strictly higher on the stat", () => {
    const challenger = [card(1, { control: 900, speed: 400 })];
    const opponent = [card(2, { control: 400, speed: 900 })];
    const state = resolveTrumps(challenger, opponent, [
      { round: 0, side: "challenger", stat: "control" },
      { round: 0, side: "opponent", stat: "speed" },
    ]);
    expect(state.rounds[0]).toMatchObject({ challengerPoint: true, opponentPoint: true, resolved: true });
    expect(state.challengerPoints).toBe(1);
    expect(state.opponentPoints).toBe(1);

    // Attacking into a stat you do not win gives the round away for nothing.
    const missed = resolveTrumps(challenger, opponent, [
      { round: 0, side: "challenger", stat: "speed" },
      { round: 0, side: "opponent", stat: "control" },
    ]);
    expect(missed.challengerPoints).toBe(0);
    expect(missed.opponentPoints).toBe(0);
  });

  it("gives nobody the point when two cards tie on the stat", () => {
    const state = resolveTrumps([card(1, { stars: 6.4 })], [card(2, { stars: 6.4 })], [
      { round: 0, side: "challenger", stat: "stars" },
      { round: 0, side: "opponent", stat: "stars" },
    ]);
    expect(state.rounds[0]).toMatchObject({ challengerPoint: false, opponentPoint: false, resolved: true });
  });

  it("holds a round open until both sides have attacked", () => {
    const state = resolveTrumps(hand(0), hand(50), [{ round: 0, side: "challenger", stat: "control" }]);
    expect(state.currentRound).toBe(0);
    expect(state.complete).toBe(false);
    expect(state.rounds[0]).toMatchObject({ challengerPicked: true, opponentPicked: false, resolved: false });
  });

  it("plays the shorter hand's worth of rounds, capped at the duel length", () => {
    expect(trumpsRoundCount(hand(0), hand(50))).toBe(TRUMPS_ROUNDS);
    expect(trumpsRoundCount(hand(0).slice(0, 2), hand(50))).toBe(2);
    // A hand of ten (the Wild pack) still plays one round per stat.
    expect(trumpsRoundCount([...hand(0), ...hand(20)], [...hand(50), ...hand(70)])).toBe(TRUMPS_ROUNDS);
    expect(trumpsRoundCount([], hand(50))).toBe(0);
  });

  it("breaks a tied duel on the power of the cards actually played", () => {
    const strong = hand(0, {}, 900);
    const weak = hand(50, {}, 300);
    expect(resolveTrumpsWinner(2, 2, strong, weak, TRUMPS_ROUNDS)).toBe("challenger");
    expect(resolveTrumpsWinner(2, 2, weak, strong, TRUMPS_ROUNDS)).toBe("opponent");
    expect(resolveTrumpsWinner(2, 2, weak, hand(70, {}, 300), TRUMPS_ROUNDS)).toBe("tie");
    expect(resolveTrumpsWinner(3, 2, weak, strong, TRUMPS_ROUNDS)).toBe("challenger");
  });

  it("generates link-shaped ids without lookalike characters", () => {
    const id = generateDuelId(() => 0.5);
    expect(id).toMatch(/^[a-z0-9]{10}$/);
    expect(id).not.toMatch(/[ilo01]/);
  });
});

describe("playing a duel", () => {
  it("waits for an opponent before any round exists", async () => {
    const duel = await openDuel();
    expect(duel.status).toBe("open");
    expect(duel.roundCount).toBe(0);
    expect(duel.rounds).toEqual([]);
    expect(duel.opponent.userId).toBeNull();
    expect(await pickPackDuelStat(db, duel.id, CHALLENGER, 0, "control")).toEqual({
      ok: false,
      error: "duel_over",
    });
  });

  it("opens round one when the opponent brings a hand", async () => {
    const duel = await openDuel();
    const joined = await seatOpponent(duel.id);
    expect(joined.roundCount).toBe(TRUMPS_ROUNDS);
    expect(joined.currentRound).toBe(0);
    expect(joined.opponent).toMatchObject({ userId: OPPONENT, username: "beta", cardCount: TRUMPS_ROUNDS });
    expect(joined.status).toBe("open");
  });

  it("scores every round, ties nothing, and settles a dead heat on card power", async () => {
    // Challenger cards win on control, opponent cards on speed, and the two
    // hands are level on precision and stars. Both sides spend their stats in
    // the same order, so each lands exactly one attack and the duel comes down
    // to the tiebreak.
    const duel = await openDuel();
    await seatOpponent(duel.id);

    const first = await playRound(duel.id, 0, "control", "control");
    expect(first.challenger.score).toBe(1);
    expect(first.opponent.score).toBe(0);
    expect(first.currentRound).toBe(1);
    expect(first.status).toBe("open");

    const second = await playRound(duel.id, 1, "speed", "speed");
    expect(second.opponent.score).toBe(1);

    // Level stats trade nothing: neither side outplayed the other there.
    await playRound(duel.id, 2, "precision", "precision");
    const last = await playRound(duel.id, 3, "stars", "stars");
    expect(last.status).toBe("resolved");
    expect(last.challenger.score).toBe(1);
    expect(last.opponent.score).toBe(1);
    // 900-power cards against 500-power ones.
    expect(last.winner).toBe("challenger");
    expect(last.resolvedAt).toBeGreaterThan(0);
    expect(last.currentRound).toBe(TRUMPS_ROUNDS);
  });

  it("spends a stat for the rest of the duel", async () => {
    const duel = await openDuel();
    await seatOpponent(duel.id);
    await playRound(duel.id, 0, "control", "speed");
    // The stat that won round one is gone for rounds two through four, which
    // is the whole reason a pick is a decision.
    expect(await pickPackDuelStat(db, duel.id, CHALLENGER, 1, "control")).toEqual({
      ok: false,
      error: "stat_spent",
    });
    expect(await pickPackDuelStat(db, duel.id, OPPONENT, 1, "speed")).toEqual({
      ok: false,
      error: "stat_spent",
    });
    // The stat the other side spent is still yours to spend.
    const picked = await pickPackDuelStat(db, duel.id, CHALLENGER, 1, "speed");
    expect(picked.ok).toBe(true);
  });

  it("pays both sides when the duel ends, and the winner more", async () => {
    const duel = await openDuel();
    await seatOpponent(duel.id);
    const done = await playDuelOut(duel.id);
    expect(done.winner).toBe("challenger");
    expect(done.challenger.shards).toBe(DUEL_WIN_SHARDS);
    expect(done.opponent.shards).toBe(DUEL_LOSS_SHARDS);

    // The shards are in the wallet, not just on the duel row.
    const wallet = (await exec(db, "select payload from pack_wallets where user_id = ?", [CHALLENGER])).rows[0];
    expect(JSON.parse(String(wallet.payload)).shards).toBe(DUEL_WIN_SHARDS);

    // And a duel already resolved cannot be replayed for a second payout.
    expect(await pickPackDuelStat(db, duel.id, CHALLENGER, 0, "control")).toEqual({
      ok: false,
      error: "duel_over",
    });
  });

  it("stops paying once the day's allowance is gone", async () => {
    // Duels until the cap is spent, then one more that pays nothing.
    const runs = Math.ceil(GAME_SHARD_DAILY_CAP / DUEL_WIN_SHARDS) + 1;
    let lastChallengerPayout = 0;
    for (let run = 0; run < runs; run += 1) {
      const duel = await openDuel();
      await seatOpponent(duel.id);
      lastChallengerPayout = (await playDuelOut(duel.id)).challenger.shards;
    }
    expect(lastChallengerPayout).toBe(0);
    const wallet = (await exec(db, "select payload from pack_wallets where user_id = ?", [CHALLENGER])).rows[0];
    expect(JSON.parse(String(wallet.payload)).shards).toBe(GAME_SHARD_DAILY_CAP);
  });

  it("takes one attack per side per round, on the round being played", async () => {
    const duel = await openDuel();
    await seatOpponent(duel.id);

    const picked = await pickPackDuelStat(db, duel.id, CHALLENGER, 0, "control");
    expect(picked.ok).toBe(true);
    expect(await pickPackDuelStat(db, duel.id, CHALLENGER, 0, "speed")).toEqual({
      ok: false,
      error: "already_done",
    });
    // Running ahead to a round nobody is playing yet.
    expect(await pickPackDuelStat(db, duel.id, OPPONENT, 3, "speed")).toEqual({
      ok: false,
      error: "wrong_round",
    });
    expect(await pickPackDuelStat(db, duel.id, OPPONENT, 0, "nonsense")).toEqual({
      ok: false,
      error: "invalid_pick",
    });
    expect(await pickPackDuelStat(db, duel.id, BYSTANDER, 0, "speed")).toEqual({
      ok: false,
      error: "not_a_player",
    });
  });

  it("refuses a second opponent, a self-duel and an empty hand", async () => {
    const duel = await openDuel();
    await seatOpponent(duel.id);
    await grantCards(BYSTANDER, hand(90));
    expect(await joinPackDuel(db, duel.id, BYSTANDER, "gamma", hand(90))).toEqual({
      ok: false,
      error: "already_joined",
    });
    const other = await openDuel();
    expect(await joinPackDuel(db, other.id, CHALLENGER, "alpha", hand(90))).toEqual({
      ok: false,
      error: "own_duel",
    });
    expect(await joinPackDuel(db, other.id, OPPONENT, "beta", [])).toEqual({
      ok: false,
      error: "invalid_cards",
    });
  });

  it("refuses another pick once the duel is over", async () => {
    const duel = await openDuel();
    await seatOpponent(duel.id);
    await playDuelOut(duel.id);
    expect(await pickPackDuelStat(db, duel.id, CHALLENGER, TRUMPS_ROUNDS - 1, "control")).toEqual({
      ok: false,
      error: "duel_over",
    });
  });

  it("clamps tampered card numbers instead of trusting them", async () => {
    await grantCards(CHALLENGER, [card(1)]);
    const created = await createPackDuel(db, CHALLENGER, "alpha", {
      packType: "standard",
      cards: [{ ...card(1), cardPower: 10 ** 9, stats: { control: 10 ** 9, speed: 1, precision: 1, stars: 900 } }],
    });
    if (!created.ok) throw new Error("not created");
    const [only] = created.duel.challenger.cards;
    expect(only.cardPower).toBe(5000);
    expect(only.stats.control).toBe(2000);
    expect(only.stats.stars).toBe(15);
  });

  it("lets one account play both seats through the dev hatch", async () => {
    const duel = await openDuel();
    expect(await joinPackDuel(db, duel.id, CHALLENGER, "alpha", hand(50))).toEqual({
      ok: false,
      error: "own_duel",
    });
    const seated = await joinPackDuel(db, duel.id, CHALLENGER, "alpha", hand(50), Date.now(), {
      allowSelfDuel: true,
    });
    if (!seated.ok) throw new Error("self-join failed");
    expect(seated.duel.opponent.userId).toBe(CHALLENGER);

    // Holding both seats, the pick lands on whichever side still owes an
    // attack, so one login can play the round out.
    const first = await pickPackDuelStat(db, duel.id, CHALLENGER, 0, "control");
    if (!first.ok) throw new Error("pick failed");
    expect(first.duel.rounds[0]).toMatchObject({ challengerPicked: true, opponentPicked: false });
    const second = await pickPackDuelStat(db, duel.id, CHALLENGER, 0, "speed");
    if (!second.ok) throw new Error("pick failed");
    expect(second.duel.rounds[0].resolved).toBe(true);
    expect(second.duel.currentRound).toBe(1);
  });
});

describe("playing for keeps", () => {
  it("refuses to stake cards you do not hold", async () => {
    // Nothing granted: the hand is a claim, and the claim is checked.
    expect(await createPackDuel(db, CHALLENGER, "alpha", { packType: "standard", cards: hand(0) })).toEqual({
      ok: false,
      error: "stake_not_held",
    });

    const duel = await openDuel();
    expect(await joinPackDuel(db, duel.id, OPPONENT, "beta", hand(50))).toEqual({
      ok: false,
      error: "stake_not_held",
    });

    // Holding four of the five is not holding the hand: half a stake would
    // change what the duel is worth after the other side agreed to it.
    const partial = hand(50);
    await grantCards(OPPONENT, partial.slice(0, partial.length - 1));
    expect(await joinPackDuel(db, duel.id, OPPONENT, "beta", partial)).toEqual({
      ok: false,
      error: "stake_not_held",
    });
  });

  it("moves the loser's staked copies into the winner's collection", async () => {
    const challengerHand = hand(0, { control: 900 }, 900);
    const opponentHand = hand(50, { speed: 900 });
    const duel = await openDuel(challengerHand);
    await seatOpponent(duel.id, opponentHand);

    const lostCard = opponentHand[0];
    expect(await copiesHeld(OPPONENT, lostCard.userId)).toBe(1);
    expect(await copiesHeld(CHALLENGER, lostCard.userId)).toBe(0);

    const done = await playDuelOut(duel.id);
    expect(done.winner).toBe("challenger");
    // Every card the opponent put up is the challenger's now, and gone from
    // the opponent's collection.
    for (const card of opponentHand) {
      expect(await copiesHeld(CHALLENGER, card.userId)).toBe(1);
      expect(await copiesHeld(OPPONENT, card.userId)).toBe(0);
    }
    // The winner keeps their own stake untouched.
    for (const card of challengerHand) {
      expect(await copiesHeld(CHALLENGER, card.userId)).toBe(1);
    }
    expect(done.spoils?.winner).toBe("challenger");
    expect(done.spoils?.cards).toHaveLength(opponentHand.length);
  });

  it("takes one copy, not the shelf", async () => {
    const opponentHand = hand(50, { speed: 900 });
    const duel = await openDuel();
    await grantCards(OPPONENT, opponentHand, 3);
    const joined = await joinPackDuel(db, duel.id, OPPONENT, "beta", opponentHand);
    if (!joined.ok) throw new Error("join failed");

    await playDuelOut(duel.id);
    // Three copies pulled, one staked and lost.
    expect(await copiesHeld(OPPONENT, opponentHand[0].userId)).toBe(2);
    expect(await copiesHeld(CHALLENGER, opponentHand[0].userId)).toBe(1);
  });

  it("pays the shard value for a stake the loser recycled mid-duel", async () => {
    const opponentHand = hand(50, { speed: 900 });
    const duel = await openDuel();
    await seatOpponent(duel.id, opponentHand);

    // Answered, then dumped the whole stake for shards before the last round.
    await exec(
      db,
      "update pack_collection_cards set copies = 0, recycled_copies = 1 where owner_user_id = ?",
      [OPPONENT],
    );
    const done = await playDuelOut(duel.id);
    expect(done.winner).toBe("challenger");
    // Nothing to hand over, so it converts: rare recycles for 2 shards each.
    expect(await copiesHeld(CHALLENGER, opponentHand[0].userId)).toBe(0);
    expect(done.spoils?.shards).toBe(2 * opponentHand.length);
    expect(done.spoils?.cards.every((entry) => entry.shards > 0)).toBe(true);
  });

  it("leaves both collections alone on a tie", async () => {
    // Level hands: every attack meets its equal, and the tiebreak on card
    // power finds them level too.
    const challengerHand = hand(0);
    const opponentHand = hand(50);
    const duel = await openDuel(challengerHand);
    await seatOpponent(duel.id, opponentHand);
    const done = await playDuelOut(duel.id);

    expect(done.winner).toBe("tie");
    expect(done.spoils).toBeNull();
    expect(await copiesHeld(OPPONENT, opponentHand[0].userId)).toBe(1);
    expect(await copiesHeld(CHALLENGER, opponentHand[0].userId)).toBe(0);
  });
});

describe("what a duel shows to whom", () => {
  it("keeps every unplayed card face down and reveals them round by round", async () => {
    const duel = await openDuel();
    const joined = await seatOpponent(duel.id);

    // Before a round is played, neither hand is readable by anyone but its
    // owner: a duel you can size up first is not a duel.
    const asOpponent = redactDuelFor(joined, OPPONENT);
    expect(asOpponent.challenger.cards).toEqual([]);
    expect(asOpponent.challenger.hidden).toBe(true);
    expect(asOpponent.challenger.cardCount).toBe(TRUMPS_ROUNDS);
    expect(asOpponent.opponent.cards).toHaveLength(TRUMPS_ROUNDS);
    expect(redactDuelFor(joined, null).opponent.cards).toEqual([]);

    const played = await playRound(duel.id, 0, "control", "speed");
    const afterRound = redactDuelFor(played, OPPONENT);
    // The card that was played is public now; the four behind it are not.
    expect(afterRound.challenger.cards).toHaveLength(1);
    expect(afterRound.challenger.hidden).toBe(true);
    expect(redactDuelFor(played, null).challenger.cards).toHaveLength(1);
  });

  it("hides a pick until the round it belongs to is over", async () => {
    const duel = await openDuel();
    await seatOpponent(duel.id);
    const picked = await pickPackDuelStat(db, duel.id, CHALLENGER, 0, "control");
    if (!picked.ok) throw new Error("pick failed");

    const asOpponent = redactDuelFor(picked.duel, OPPONENT);
    // They can see that the challenger has locked something in, not what.
    expect(asOpponent.rounds[0].challengerPicked).toBe(true);
    expect(asOpponent.rounds[0].challengerStat).toBeNull();
    expect(redactDuelFor(picked.duel, CHALLENGER).rounds[0].challengerStat).toBe("control");

    const resolved = await pickPackDuelStat(db, duel.id, OPPONENT, 0, "speed");
    if (!resolved.ok) throw new Error("pick failed");
    expect(redactDuelFor(resolved.duel, null).rounds[0]).toMatchObject({
      challengerStat: "control",
      opponentStat: "speed",
    });
  });

  it("opens both hands once the duel is finished", async () => {
    const duel = await openDuel();
    await seatOpponent(duel.id);
    await playDuelOut(duel.id);
    const finished = await getPackDuel(db, duel.id);
    if (!finished) throw new Error("duel vanished");
    const anyone = redactDuelFor(finished, null);
    expect(anyone.challenger.cards).toHaveLength(TRUMPS_ROUNDS);
    expect(anyone.opponent.cards).toHaveLength(TRUMPS_ROUNDS);
    expect(anyone.challenger.hidden).toBeUndefined();
  });
});

describe("pack_duels schema repair", () => {
  it("adds the pick columns to a table left over from an earlier prototype", async () => {
    // A database that met the earlier prototype: the migration's `create table
    // if not exists` leaves it exactly as it is, so an insert would fail on the
    // columns that are missing.
    await exec(db, "drop table pack_duels");
    await exec(
      db,
      `create table pack_duels (
         id text primary key, kind text not null, pack_type text not null, status text not null,
         challenger_user_id integer not null, challenger_username text not null,
         challenger_cards_json text, challenger_score real not null default 0,
         challenger_done integer not null default 0,
         opponent_user_id integer, opponent_username text, opponent_cards_json text,
         opponent_score real not null default 0, opponent_done integer not null default 0,
         pool_json text, deals_json text, deals_count integer not null default 0, winner text,
         created_at integer not null, updated_at integer not null, resolved_at integer
       )`,
    );
    await exec(
      db,
      `insert into pack_duels (id, kind, pack_type, status, challenger_user_id, challenger_username, created_at, updated_at)
       values ('oldduel123', 'blackjack', 'wild', 'open', ?, 'alpha', 1, 1)`,
      [CHALLENGER],
    );

    expect(await ensurePackDuelsSchema(db)).toBe(true);
    const columns = new Set(
      (await exec(db, "pragma table_info(pack_duels)")).rows.map((row) => String(row.name)),
    );
    expect(columns.has("picks_json")).toBe(true);
    expect(columns.has("picks_count")).toBe(true);
    // Rows from a retired mode are unreadable now, so they go.
    expect((await exec(db, "select count(*) as n from pack_duels")).rows[0].n).toBe(0);

    // And the repaired table takes a duel.
    const created = await openDuel();
    expect(created.challenger.cards).toHaveLength(TRUMPS_ROUNDS);

    // Second run has nothing to do.
    expect(await ensurePackDuelsSchema(db)).toBe(false);
  });
});

describe("duel endpoints", () => {
  it("gates writes on the admin token and serves reads publicly", async () => {
    const denied = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      packType: "standard",
      cards: hand(0),
    }));
    expect(denied.status).toBe(401);

    await grantCards(CHALLENGER, hand(0));
    const created = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      packType: "standard",
      cards: hand(0, { control: 900 }, 900),
    }, ADMIN));
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(id).toMatch(/^[a-z0-9]{10}$/);

    const read = await call(mockReq("GET", `/api/packs/duels/${id}`));
    expect(read.status).toBe(200);
    expect(read.body.challenger.cards).toEqual([]);
    expect(read.body.challenger.cardCount).toBe(TRUMPS_ROUNDS);
  });

  it("plays a duel over HTTP and keeps unplayed cards face down", async () => {
    await grantCards(CHALLENGER, hand(0));
    await grantCards(OPPONENT, hand(50));
    const created = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      packType: "standard",
      cards: hand(0, { control: 900 }, 900),
    }, ADMIN));
    const id = created.body.id as string;

    const joined = await call(bodyReq("POST", `/api/packs/duels/${id}/join`, {
      userId: OPPONENT,
      username: "beta",
      cards: hand(50, { speed: 900 }),
    }, ADMIN));
    expect(joined.status).toBe(200);
    expect(joined.body.roundCount).toBe(TRUMPS_ROUNDS);

    // The signed-in view shows your hand and only the played part of theirs.
    const mine = await call(bodyReq("POST", `/api/packs/duels/${id}/view`, {
      userId: OPPONENT,
      username: "beta",
    }, ADMIN));
    expect(mine.body.opponent.cards).toHaveLength(TRUMPS_ROUNDS);
    expect(mine.body.challenger.hidden).toBe(true);

    for (let round = 0; round < TRUMPS_ROUNDS; round += 1) {
      await call(bodyReq("POST", `/api/packs/duels/${id}/pick`, {
        userId: CHALLENGER,
        username: "alpha",
        round,
        stat: STAT_ORDER[round],
      }, ADMIN));
      const answered = await call(bodyReq("POST", `/api/packs/duels/${id}/pick`, {
        userId: OPPONENT,
        username: "beta",
        round,
        // The opponent holds control back to the last round, which by then is
        // the only stat either side has left.
        stat: STAT_ORDER[(round + 1) % TRUMPS_ROUNDS],
      }, ADMIN));
      expect(answered.status).toBe(200);
    }

    const done = await call(mockReq("GET", `/api/packs/duels/${id}`));
    expect(done.body.status).toBe("resolved");
    expect(done.body.winner).toBe("challenger");
    expect(done.body.opponent.cards).toHaveLength(TRUMPS_ROUNDS);
    expect(done.body.challenger.shards).toBe(DUEL_WIN_SHARDS);
  });

  it("opens the self-duel hatch outside production only", async () => {
    await grantCards(CHALLENGER, hand(0));
    const created = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      packType: "standard",
      cards: hand(0),
    }, ADMIN));
    const id = created.body.id as string;
    const selfJoin = (nodeEnv: string) => call(bodyReq("POST", `/api/packs/duels/${id}/join`, {
      userId: CHALLENGER,
      username: "alpha",
      cards: hand(50),
    }, ADMIN), nodeEnv);

    const refused = await selfJoin("production");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("own_duel");

    const allowed = await selfJoin("development");
    expect(allowed.status).toBe(200);
    expect(allowed.body.opponent.userId).toBe(CHALLENGER);
  });

  it("404s an unknown duel", async () => {
    expect((await call(mockReq("GET", "/api/packs/duels/nosuchduel"))).status).toBe(404);
  });
});

function httpCtx(nodeEnv = "production") {
  return {
    db,
    queue,
    events,
    abuse: new AbuseGuard(),
    config: {
      nodeEnv,
      liveAdminToken: "secret",
      allowedOrigins: ["http://localhost:3000"],
      trackedCountries: ["CR"],
      trustProxyHeaders: true,
      publicApiRatePerMinute: 240,
      publicCostlyRatePerMinute: 60,
    },
    osu: { limiter: { state: () => ({ hardPerMinute: 60, usedLastMinute: 0 }) } },
    oscStatus: () => ({ connected: false, lastBatchAt: null, lastError: null }),
  } as never;
}

function mockReq(method: string, url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
}

function bodyReq(method: string, url: string, body: unknown, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
}

function mockRes() {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (key: string, value: number | string | readonly string[]) => {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value);
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    writeHead: (status: number) => {
      res.statusCode = status;
      return res;
    },
    write: (chunk: string | Buffer) => {
      writes.push(String(chunk));
      return true;
    },
    destroy: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk != null) writes.push(String(chunk));
    },
  }) as unknown as ServerResponse & { statusCode: number };
  return { res, writes };
}

async function call(req: IncomingMessage, nodeEnv = "production") {
  const response = mockRes();
  await routeHttp(req, response.res, httpCtx(nodeEnv));
  const raw = response.writes.join("");
  let body: ReturnType<typeof JSON.parse> = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: response.res.statusCode, body };
}
