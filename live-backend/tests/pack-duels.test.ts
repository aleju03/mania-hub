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
import {
  BLACKJACK_CARDS_PER_SIDE,
  BLACKJACK_DECK_SIZE,
  BLACKJACK_OPENING_CARDS,
  BLACKJACK_TARGET,
  createPackDuel,
  deckSliceFor,
  ensurePackDuelsSchema,
  generateDuelId,
  handTotal,
  hitPackBlackjack,
  joinPackBlackjack,
  joinPackDuel,
  redactDuelFor,
  resolveBlackjackWinner,
  resolveDuelWinner,
  scoreDuelCards,
  standPackBlackjack,
  type PackDuelCard,
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

function card(userId: number, cardPower: number, value = 0): PackDuelCard {
  return {
    userId,
    username: `player${userId}`,
    countryCode: "CR",
    avatarUrl: "",
    tier: "rare",
    tierLabel: "Rare",
    cardPower,
    value,
    globalRank: 1000,
    pp: 5000,
    skills: null,
  };
}

function hand(powers: number[], offset = 0): PackDuelCard[] {
  return powers.map((power, index) => card(offset + index + 1, power));
}

/* A deck whose every card is worth `value` stars, so a hand's total is just
   its size times that: the tests can then aim at exact totals. */
function deck(value: number, overrides: Record<number, number> = {}): PackDuelCard[] {
  return Array.from({ length: BLACKJACK_DECK_SIZE }, (_, index) =>
    card(index + 1, 500, overrides[index] ?? value),
  );
}

async function openChallenge(cards = hand([100, 200, 300])) {
  const created = await createPackDuel(db, CHALLENGER, "alpha", {
    kind: "challenge",
    packType: "standard",
    cards,
  });
  if (!created.ok) throw new Error(`duel not created: ${created.error}`);
  return created.duel;
}

async function openBlackjack(cards = deck(5)) {
  const created = await createPackDuel(db, CHALLENGER, "alpha", {
    kind: "blackjack",
    packType: "wild",
    cards,
  });
  if (!created.ok) throw new Error(`blackjack not created: ${created.error}`);
  return created.duel;
}

describe("duel scoring", () => {
  it("scores a challenge hand as the sum of card power", () => {
    expect(scoreDuelCards(hand([100, 250.4, 300]))).toBe(650);
  });

  it("breaks a tied challenge on the single best card", () => {
    expect(resolveDuelWinner(hand([500, 100]), hand([300, 300]))).toBe("challenger");
    expect(resolveDuelWinner(hand([300, 300]), hand([500, 100]))).toBe("opponent");
    expect(resolveDuelWinner(hand([300, 300]), hand([300, 300]))).toBe("tie");
  });

  it("totals a blackjack hand from card star values", () => {
    expect(handTotal([card(1, 0, 5.31), card(2, 0, 4.2)])).toBe(9.51);
  });

  it("sends a bust to the loser and two busts to a tie", () => {
    const under = [card(1, 0, 10), card(2, 0, 9)];
    const over = [card(3, 0, 10), card(4, 0, 12)];
    expect(resolveBlackjackWinner(under, over)).toBe("challenger");
    expect(resolveBlackjackWinner(over, under)).toBe("opponent");
    expect(resolveBlackjackWinner(over, over)).toBe("tie");
  });

  it("gives the win to the hand closest to the target", () => {
    const twenty = [card(1, 0, 20)];
    const eighteen = [card(2, 0, 18)];
    expect(resolveBlackjackWinner(twenty, eighteen)).toBe("challenger");
    expect(resolveBlackjackWinner(eighteen, twenty)).toBe("opponent");
    expect(resolveBlackjackWinner(twenty, twenty)).toBe("tie");
  });

  it("deals each side its own half of the deck", () => {
    expect(deckSliceFor("challenger")).toEqual({ start: 0, end: BLACKJACK_CARDS_PER_SIDE });
    expect(deckSliceFor("opponent")).toEqual({ start: BLACKJACK_CARDS_PER_SIDE, end: BLACKJACK_DECK_SIZE });
  });

  it("generates link-shaped ids without lookalike characters", () => {
    const id = generateDuelId(() => 0.5);
    expect(id).toMatch(/^[a-z0-9]{10}$/);
    expect(id).not.toMatch(/[ilo01]/);
  });
});

describe("challenge duels", () => {
  it("resolves the moment the opponent submits a hand", async () => {
    const duel = await openChallenge(hand([100, 200, 300]));
    expect(duel.status).toBe("open");
    expect(duel.challenger.score).toBe(600);

    const joined = await joinPackDuel(db, duel.id, OPPONENT, "beta", hand([100, 100, 100], 50));
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.duel.status).toBe("resolved");
    expect(joined.duel.opponent).toMatchObject({ userId: OPPONENT, username: "beta", score: 300 });
    expect(joined.duel.winner).toBe("challenger");
  });

  it("seals the challenger hand from everyone until it resolves", async () => {
    const duel = await openChallenge(hand([100, 200, 300]));
    const sealed = redactDuelFor(duel, null);
    expect(sealed.challenger.cards).toEqual([]);
    expect(sealed.challenger.hidden).toBe(true);
    expect(sealed.challenger.cardCount).toBe(3);
    // Their own hand stays theirs to see.
    expect(redactDuelFor(duel, CHALLENGER).challenger.cards).toHaveLength(3);

    const joined = await joinPackDuel(db, duel.id, OPPONENT, "beta", hand([50]));
    if (!joined.ok) throw new Error("join failed");
    expect(redactDuelFor(joined.duel, null).challenger.cards).toHaveLength(3);
  });

  it("refuses a second opponent and self-duelling", async () => {
    const duel = await openChallenge();
    await joinPackDuel(db, duel.id, OPPONENT, "beta", hand([500]));
    expect(await joinPackDuel(db, duel.id, BYSTANDER, "gamma", hand([9000]))).toEqual({
      ok: false,
      error: "already_joined",
    });
    const other = await openChallenge();
    expect(await joinPackDuel(db, other.id, CHALLENGER, "alpha", hand([500]))).toEqual({
      ok: false,
      error: "own_duel",
    });
  });

  it("clamps a tampered card power instead of trusting it", async () => {
    const duel = await createPackDuel(db, CHALLENGER, "alpha", {
      kind: "challenge",
      packType: "standard",
      cards: [{ ...card(1, 0), cardPower: 10 ** 9 }],
    });
    if (!duel.ok) throw new Error("not created");
    expect(duel.duel.challenger.score).toBe(5000);
  });
});

describe("blackjack duels", () => {
  it("deals the challenger an opening hand and requires a full deck", async () => {
    const duel = await openBlackjack(deck(5));
    expect(duel.challenger.cards).toHaveLength(BLACKJACK_OPENING_CARDS);
    expect(duel.challenger.score).toBe(10);
    expect(duel.target).toBe(BLACKJACK_TARGET);
    expect(duel.opponent.userId).toBeNull();

    expect(await createPackDuel(db, CHALLENGER, "alpha", {
      kind: "blackjack",
      packType: "wild",
      cards: hand([100, 200]),
    })).toEqual({ ok: false, error: "invalid_duel" });
  });

  it("deals the opponent their own opening hand from the other half", async () => {
    // The first card of the opponent's half, whatever the split is.
    const duel = await openBlackjack(deck(5, { [BLACKJACK_CARDS_PER_SIDE]: 9 }));
    const joined = await joinPackBlackjack(db, duel.id, OPPONENT, "beta");
    if (!joined.ok) throw new Error("join failed");
    expect(joined.duel.opponent.cards).toHaveLength(BLACKJACK_OPENING_CARDS);
    // That card belongs to the opponent's half, so only their total moves.
    expect(joined.duel.opponent.score).toBe(14);
    expect(joined.duel.challenger.score).toBe(10);
  });

  it("hides each hand from the other player until both stop", async () => {
    const duel = await openBlackjack();
    const joined = await joinPackBlackjack(db, duel.id, OPPONENT, "beta");
    if (!joined.ok) throw new Error("join failed");

    const asOpponent = redactDuelFor(joined.duel, OPPONENT);
    expect(asOpponent.opponent.cards).toHaveLength(2);
    expect(asOpponent.challenger.cards).toEqual([]);
    expect(asOpponent.challenger.hidden).toBe(true);
    expect(asOpponent.challenger.cardCount).toBe(2);
    expect(redactDuelFor(joined.duel, null).opponent.cards).toEqual([]);

    await standPackBlackjack(db, duel.id, CHALLENGER);
    const done = await standPackBlackjack(db, duel.id, OPPONENT);
    if (!done.ok) throw new Error("stand failed");
    // Resolved: both hands open up.
    const revealed = redactDuelFor(done.duel, null);
    expect(revealed.challenger.cards).toHaveLength(2);
    expect(revealed.opponent.cards).toHaveLength(2);
  });

  it("hits, busts and ends that hand where it stands", async () => {
    // 8 a card: 16 to open, 24 after one hit.
    const duel = await openBlackjack(deck(8));
    await joinPackBlackjack(db, duel.id, OPPONENT, "beta");

    const hit = await hitPackBlackjack(db, duel.id, CHALLENGER);
    if (!hit.ok) throw new Error("hit failed");
    expect(hit.duel.challenger.score).toBe(24);
    expect(hit.duel.challenger.bust).toBe(true);
    expect(hit.duel.challenger.done).toBe(true);
    expect(await hitPackBlackjack(db, duel.id, CHALLENGER)).toEqual({ ok: false, error: "already_done" });

    // The opponent stands on 16 and takes it, because a bust always loses.
    const stood = await standPackBlackjack(db, duel.id, OPPONENT);
    if (!stood.ok) throw new Error("stand failed");
    expect(stood.duel.status).toBe("resolved");
    expect(stood.duel.winner).toBe("opponent");
  });

  it("resolves on the second stand, closest to the target winning", async () => {
    // Challenger cards are 5s, the opponent's half is 7s.
    const values: Record<number, number> = {};
    for (let index = BLACKJACK_CARDS_PER_SIDE; index < BLACKJACK_DECK_SIZE; index += 1) values[index] = 7;
    const duel = await openBlackjack(deck(5, values));
    await joinPackBlackjack(db, duel.id, OPPONENT, "beta");

    // Challenger: 10 -> 15 -> 20. Opponent stands on 14.
    await hitPackBlackjack(db, duel.id, CHALLENGER);
    const twenty = await hitPackBlackjack(db, duel.id, CHALLENGER);
    if (!twenty.ok) throw new Error("hit failed");
    expect(twenty.duel.challenger.score).toBe(20);
    expect(twenty.duel.status).toBe("open");

    await standPackBlackjack(db, duel.id, OPPONENT);
    const done = await standPackBlackjack(db, duel.id, CHALLENGER);
    if (!done.ok) throw new Error("stand failed");
    expect(done.duel.status).toBe("resolved");
    expect(done.duel.winner).toBe("challenger");
    expect(done.duel.resolvedAt).toBeGreaterThan(0);
  });

  it("stands a side that runs out of cards instead of stalling", async () => {
    // Tiny values, so seven cards still cannot bust: 0.5 each = 3.5 total.
    const duel = await openBlackjack(deck(0.5));
    await joinPackBlackjack(db, duel.id, OPPONENT, "beta");
    for (let index = BLACKJACK_OPENING_CARDS; index < BLACKJACK_CARDS_PER_SIDE; index += 1) {
      const result = await hitPackBlackjack(db, duel.id, CHALLENGER);
      expect(result.ok).toBe(true);
    }
    const exhausted = await hitPackBlackjack(db, duel.id, CHALLENGER);
    if (!exhausted.ok) throw new Error("hit failed");
    expect(exhausted.duel.challenger.cards).toHaveLength(BLACKJACK_CARDS_PER_SIDE);
    expect(exhausted.duel.challenger.done).toBe(true);
    expect(exhausted.duel.challenger.bust).toBe(false);
  });

  it("keeps outsiders and the wrong kind out", async () => {
    const duel = await openBlackjack();
    await joinPackBlackjack(db, duel.id, OPPONENT, "beta");
    expect(await hitPackBlackjack(db, duel.id, BYSTANDER)).toEqual({ ok: false, error: "not_a_player" });
    expect(await standPackBlackjack(db, duel.id, BYSTANDER)).toEqual({ ok: false, error: "not_a_player" });

    const challenge = await openChallenge();
    expect(await hitPackBlackjack(db, challenge.id, CHALLENGER)).toEqual({ ok: false, error: "wrong_kind" });
    expect(await joinPackBlackjack(db, challenge.id, OPPONENT, "beta")).toEqual({ ok: false, error: "wrong_kind" });
    expect(await joinPackDuel(db, duel.id, OPPONENT, "beta", hand([1]))).toEqual({ ok: false, error: "wrong_kind" });
  });

  it("refuses a hit before anyone has taken the other seat", async () => {
    const duel = await openBlackjack();
    expect(await hitPackBlackjack(db, duel.id, CHALLENGER)).toEqual({ ok: false, error: "duel_over" });
  });

  it("lets the same opponent reopen the link without redealing", async () => {
    const duel = await openBlackjack();
    await joinPackBlackjack(db, duel.id, OPPONENT, "beta");
    await hitPackBlackjack(db, duel.id, OPPONENT);
    const rejoin = await joinPackBlackjack(db, duel.id, OPPONENT, "beta");
    if (!rejoin.ok) throw new Error("rejoin failed");
    expect(rejoin.duel.opponent.cards).toHaveLength(3);
  });

  it("lets one account play both seats through the dev hatch", async () => {
    const duel = await openBlackjack();
    expect(await joinPackBlackjack(db, duel.id, CHALLENGER, "alpha")).toEqual({ ok: false, error: "own_duel" });

    const seated = await joinPackBlackjack(db, duel.id, CHALLENGER, "alpha", Date.now(), { allowSelfDuel: true });
    if (!seated.ok) throw new Error("self-join failed");
    expect(seated.duel.opponent.userId).toBe(CHALLENGER);

    // With both seats held, moves land on whichever hand is still in play.
    const first = await standPackBlackjack(db, duel.id, CHALLENGER);
    if (!first.ok) throw new Error("stand failed");
    expect(first.duel.challenger.done).toBe(true);
    expect(first.duel.opponent.done).toBe(false);
    const second = await standPackBlackjack(db, duel.id, CHALLENGER);
    if (!second.ok) throw new Error("stand failed");
    expect(second.duel.status).toBe("resolved");
  });
});

describe("pack_duels schema repair", () => {
  it("adds the blackjack columns to a table left over from the draft prototype", async () => {
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
         opponent_user_id integer, opponent_username text, opponent_cards_json text,
         opponent_score real not null default 0, pool_json text, picks_json text,
         picks_count integer not null default 0, winner text,
         created_at integer not null, updated_at integer not null, resolved_at integer
       )`,
    );
    await exec(
      db,
      `insert into pack_duels (id, kind, pack_type, status, challenger_user_id, challenger_username, created_at, updated_at)
       values ('oldduel123', 'draft', 'wild', 'open', ?, 'alpha', 1, 1)`,
      [CHALLENGER],
    );

    expect(await ensurePackDuelsSchema(db)).toBe(true);
    const columns = new Set(
      (await exec(db, "pragma table_info(pack_duels)")).rows.map((row) => String(row.name)),
    );
    expect(columns.has("deals_json")).toBe(true);
    expect(columns.has("deals_count")).toBe(true);
    expect(columns.has("challenger_done")).toBe(true);
    expect(columns.has("opponent_done")).toBe(true);
    // Draft rows are unreadable now, so they go.
    expect((await exec(db, "select count(*) as n from pack_duels")).rows[0].n).toBe(0);

    // And the repaired table takes a blackjack duel.
    const created = await openBlackjack();
    expect(created.challenger.cards).toHaveLength(BLACKJACK_OPENING_CARDS);

    // Second run has nothing to do.
    expect(await ensurePackDuelsSchema(db)).toBe(false);
  });
});

describe("duel endpoints", () => {
  it("gates writes on the admin token and serves reads publicly", async () => {
    const denied = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      kind: "challenge",
      packType: "standard",
      cards: hand([100]),
    }));
    expect(denied.status).toBe(401);

    const created = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      kind: "challenge",
      packType: "standard",
      cards: hand([100, 200]),
    }, ADMIN));
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(id).toMatch(/^[a-z0-9]{10}$/);

    const read = await call(mockReq("GET", `/api/packs/duels/${id}`));
    expect(read.status).toBe(200);
    expect(read.body.challenger.cards).toEqual([]);
    expect(read.body.challenger.cardCount).toBe(2);

    const joined = await call(bodyReq("POST", `/api/packs/duels/${id}/join`, {
      userId: OPPONENT,
      username: "beta",
      kind: "challenge",
      cards: hand([500], 90),
    }, ADMIN));
    expect(joined.status).toBe(200);
    expect(joined.body.winner).toBe("opponent");
    expect((await call(mockReq("GET", `/api/packs/duels/${id}`))).body.status).toBe("resolved");
  });

  it("plays a blackjack duel over HTTP and keeps hands private", async () => {
    const created = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      kind: "blackjack",
      packType: "wild",
      cards: deck(5),
    }, ADMIN));
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    await call(bodyReq("POST", `/api/packs/duels/${id}/join`, {
      userId: OPPONENT,
      username: "beta",
      kind: "blackjack",
    }, ADMIN));

    // The signed-in view shows your hand and hides theirs.
    const mine = await call(bodyReq("POST", `/api/packs/duels/${id}/view`, {
      userId: OPPONENT,
      username: "beta",
    }, ADMIN));
    expect(mine.body.opponent.cards).toHaveLength(2);
    expect(mine.body.challenger.hidden).toBe(true);

    const hit = await call(bodyReq("POST", `/api/packs/duels/${id}/hit`, {
      userId: CHALLENGER,
      username: "alpha",
    }, ADMIN));
    expect(hit.status).toBe(200);
    expect(hit.body.challenger.score).toBe(15);

    await call(bodyReq("POST", `/api/packs/duels/${id}/stand`, { userId: CHALLENGER, username: "alpha" }, ADMIN));
    const end = await call(bodyReq("POST", `/api/packs/duels/${id}/stand`, { userId: OPPONENT, username: "beta" }, ADMIN));
    expect(end.body.status).toBe("resolved");
    expect(end.body.winner).toBe("challenger"); // 15 beats 10
  });

  it("opens the self-duel hatch outside production only", async () => {
    const created = await call(bodyReq("POST", "/api/packs/duels", {
      userId: CHALLENGER,
      username: "alpha",
      kind: "blackjack",
      packType: "wild",
      cards: deck(5),
    }, ADMIN));
    const id = created.body.id as string;
    const selfJoin = (nodeEnv: string) => call(bodyReq("POST", `/api/packs/duels/${id}/join`, {
      userId: CHALLENGER,
      username: "alpha",
      kind: "blackjack",
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
