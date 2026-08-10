import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { HONORARY_USER_IDS, recyclePackCollectionCards, savePackWallet } from "../src/features/pack-wallets.js";
import { getHonoraryPullsReport, getSharedPackCard } from "../src/features/pack-pulls.js";

// Collection cards are client-supplied and their tier is otherwise trusted.
// GOAT recycles for 1000 shards, so a forged `tier: "goat"` would mint shards
// on demand. Only the honorary roster may hold it.

let dir = "";
let db: Db;

const OWNER = 4242;
const HONORARY_ID = 259972; // Jakads
const ORDINARY_ID = 999001;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-goat-guard-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function card(userId: number, tier: string) {
  return {
    userId,
    username: `player${userId}`,
    avatarUrl: "",
    countryCode: "KR",
    tier,
    tierLabel: tier === "goat" ? "GOAT" : tier,
    skills: null,
    pp: 1000,
    globalRank: 1,
    copies: 3,
    recycledCopies: 0,
    firstPulledAt: 1,
    lastPulledAt: 1,
  };
}

async function storedTier(userId: number): Promise<string | null> {
  const row = (await exec(
    db,
    "select tier from pack_collection_cards where owner_user_id = ? and card_user_id = ?",
    [OWNER, userId],
  )).rows[0];
  return row && typeof row.tier === "string" ? row.tier : null;
}

describe("GOAT tier claims", () => {
  it("mirrors the frontend roster exactly", async () => {
    // The list here is a copy, so a player added to the roster but not to it
    // would have their genuine GOAT card stripped on sync.
    const source = await readFile(new URL("../../src/lib/honorary-players.ts", import.meta.url), "utf8");
    const ids = [...source.matchAll(/^\s+id: (\d+),$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(0);
    expect([...HONORARY_USER_IDS].sort()).toEqual(ids.sort());
  });

  it("strips a forged GOAT tier from a player who is not on the roster", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [ORDINARY_ID]: card(ORDINARY_ID, "goat") }, shards: 0 }), 0);
    expect(await storedTier(ORDINARY_ID)).toBeNull();
  });

  it("keeps the GOAT tier for an honorary player", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);
    expect(await storedTier(HONORARY_ID)).toBe("goat");
  });

  it("does not pay out GOAT shards for a forged card", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [ORDINARY_ID]: card(ORDINARY_ID, "goat") }, shards: 0 }), 0);
    const { gained } = await recyclePackCollectionCards(db, OWNER, { mode: "duplicates", cardKey: String(ORDINARY_ID) });
    // Two duplicates at the unrated rate (1 each), not 2 x 1000.
    expect(gained).toBeLessThanOrEqual(2);
  });

  it("leaves ordinary tiers untouched", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [ORDINARY_ID]: card(ORDINARY_ID, "worldClass") }, shards: 0 }), 0);
    expect(await storedTier(ORDINARY_ID)).toBe("worldClass");
  });
});

const OTHER_OWNER = 4243;
const OTHER_HONORARY_ID = 1190879; // WindyS

describe("honorary pulls report", () => {
  it("counts owners and copies per card and leaves unpulled cards out", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);
    await savePackWallet(db, OTHER_OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    expect(report.rosterSize).toBe(HONORARY_USER_IDS.size);
    expect(report.pulledCards).toBe(1);
    expect(report.distinctOwners).toBe(2);
    // Three copies each, per the card fixture.
    expect(report.totalCopies).toBe(6);

    const jakads = report.cards.find((entry) => entry.cardUserId === HONORARY_ID);
    expect(jakads?.ownerCount).toBe(2);
    expect(jakads?.owners.map((owner) => owner.userId).sort()).toEqual([OWNER, OTHER_OWNER]);
    // A card nobody holds has no row: the frontend fills those in from the roster.
    expect(report.cards.some((entry) => entry.cardUserId === OTHER_HONORARY_ID)).toBe(false);
  });

  it("names owners from the live users row, falling back to the frozen pull name", async () => {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, ?, ?)",
      [OWNER, "TrackedPlayer", "", "CR", new Date().toISOString()],
    );
    await exec(
      db,
      `insert into pack_pull_events (owner_user_id, owner_username, card_user_id, card_username, tier, pack_type, pulled_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [OTHER_OWNER, "UntrackedPlayer", HONORARY_ID, "Jakads", "goat", "legend", Date.now()],
    );
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);
    await savePackWallet(db, OTHER_OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    const names = report.cards[0]?.owners.map((owner) => owner.username).sort();
    expect(names).toEqual(["TrackedPlayer", "UntrackedPlayer"]);
  });

  it("reports the true owner count when the owner list is capped", async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);
    await savePackWallet(db, OTHER_OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS, 1);
    expect(report.cards[0]?.owners).toHaveLength(1);
    expect(report.cards[0]?.ownerCount).toBe(2);
    expect(report.distinctOwners).toBe(2);
  });
});

/* The pull permalink names the pack a GOAT came out of, which only makes sense
   for a card the log saw arrive at that tier: several roster members sit in
   the ranked pool too, so plenty of holders pulled them as ordinary cards
   before the roster ever existed. */
describe("shared pull provenance", () => {
  async function logPull(tier: string, packType: string, pulledAt: number) {
    await exec(
      db,
      `insert into pack_pull_events (owner_user_id, owner_username, card_user_id, card_username, tier, pack_type, pulled_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [OWNER, "Owner", HONORARY_ID, "Jakads", tier, packType, pulledAt],
    );
  }

  beforeEach(async () => {
    await savePackWallet(db, OWNER, JSON.stringify({ cards: { [HONORARY_ID]: card(HONORARY_ID, "goat") }, shards: 0 }), 0);
  });

  it("names the pack when the card was logged as a GOAT", async () => {
    await logPull("goat", "legend", 1000);
    const shared = await getSharedPackCard(db, OWNER, HONORARY_ID);
    expect(shared?.goatPull).toEqual({ packType: "legend", pulledAt: 1000 });
  });

  it("stays silent for a card pulled before it carried the tier", async () => {
    await logPull("worldClass", "standard", 1000);
    const shared = await getSharedPackCard(db, OWNER, HONORARY_ID);
    expect(shared?.goatPull).toBeNull();
  });

  it("stays silent when the pull predates the log", async () => {
    const shared = await getSharedPackCard(db, OWNER, HONORARY_ID);
    expect(shared?.goatPull).toBeNull();
  });

  it("reports the first GOAT pull, not a later duplicate", async () => {
    await logPull("goat", "legend", 2000);
    await logPull("goat", "standard", 3000);
    const shared = await getSharedPackCard(db, OWNER, HONORARY_ID);
    expect(shared?.goatPull?.packType).toBe("legend");
  });
});

/* The report answers "who holds the GOAT card", and several roster members are
   live ranked players whose ordinary card is a separate collectible. A World
   Class bojii is not a GOAT holding and must not be counted as one. */
describe("honorary pulls report scope", () => {
  it("counts GOAT cards only, not the ordinary card of the same player", async () => {
    await savePackWallet(
      db,
      OWNER,
      JSON.stringify({
        cards: {
          [String(HONORARY_ID)]: card(HONORARY_ID, "worldClass"),
          [`${HONORARY_ID}:goat`]: card(HONORARY_ID, "goat"),
        },
        shards: 0,
      }),
      0,
    );
    await savePackWallet(
      db,
      OTHER_OWNER,
      JSON.stringify({ cards: { [String(HONORARY_ID)]: card(HONORARY_ID, "worldClass") }, shards: 0 }),
      0,
    );

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    // Two owners hold a card of this player; only one holds the GOAT.
    expect(report.distinctOwners).toBe(1);
    expect(report.cards[0]?.ownerCount).toBe(1);
    expect(report.cards[0]?.owners[0]?.userId).toBe(OWNER);
  });
});

/* The readout leads with "what was the newest GOAT" and "who holds the most",
   so both are computed over every row rather than the per-card owner lists,
   which are truncated. */
describe("honorary pulls leaderboard", () => {
  /* One write per owner: savePackWallet is revision-checked, so a second call
     with the same base rev would be rejected as a conflict. */
  async function ownCards(owner: number, held: Array<{ cardUserId: number; pulledAt: number; copies?: number }>) {
    const cards: Record<string, unknown> = {};
    for (const entry of held) {
      cards[`${entry.cardUserId}:goat`] = {
        ...card(entry.cardUserId, "goat"),
        copies: entry.copies ?? 1,
        firstPulledAt: entry.pulledAt,
        lastPulledAt: entry.pulledAt,
      };
    }
    await savePackWallet(db, owner, JSON.stringify({ cards, shards: 0 }), 0);
  }

  it("names the newest GOAT in anyone's collection", async () => {
    await ownCards(OWNER, [{ cardUserId: HONORARY_ID, pulledAt: 1000 }]);
    await ownCards(OTHER_OWNER, [{ cardUserId: OTHER_HONORARY_ID, pulledAt: 5000 }]);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    expect(report.latest?.cardUserId).toBe(OTHER_HONORARY_ID);
    expect(report.latest?.ownerUserId).toBe(OTHER_OWNER);
    expect(report.latest?.pulledAt).toBe(5000);
  });

  it("ranks collectors by how much of the roster they hold", async () => {
    await ownCards(OWNER, [
      { cardUserId: HONORARY_ID, pulledAt: 1000, copies: 2 },
      { cardUserId: OTHER_HONORARY_ID, pulledAt: 2000 },
    ]);
    await ownCards(OTHER_OWNER, [{ cardUserId: HONORARY_ID, pulledAt: 3000 }]);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    expect(report.collectors.map((collector) => collector.userId)).toEqual([OWNER, OTHER_OWNER]);
    expect(report.collectors[0]).toMatchObject({ cards: 2, copies: 3 });
    expect(report.collectors[1]).toMatchObject({ cards: 1, copies: 1 });
  });

  it("counts a collector once per card even when the owner list is capped", async () => {
    await ownCards(OWNER, [{ cardUserId: HONORARY_ID, pulledAt: 1000 }]);
    await ownCards(OTHER_OWNER, [{ cardUserId: HONORARY_ID, pulledAt: 2000 }]);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS, 1);
    expect(report.cards[0]?.owners).toHaveLength(1);
    // Truncation is a display cap on one card's list, not on the leaderboard.
    expect(report.collectors).toHaveLength(2);
  });
});

/* Pull stamps are client-authored, and rows synced before the intake refused
   future ones can carry a stamp from a clock running ahead. Such a stamp would
   hold "latest pull" until real time caught up with it - days of the readout
   opening on the same pull, aged "just now". */
describe("future pull stamps", () => {
  // The intake clamps these now, so a legacy row has to be planted directly.
  async function plantRow(owner: number, cardUserId: number, pulledAt: number, updatedAt: number) {
    await exec(
      db,
      `insert into pack_collection_cards
         (owner_user_id, card_user_id, card_key, username, avatar_url, country_code, tier, tier_label,
          skills_json, pp, global_rank, copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at)
       values (?, ?, ?, ?, '', 'KR', 'goat', 'GOAT', null, 1000, 1, 1, 0, ?, ?, ?)`,
      [owner, cardUserId, `${cardUserId}:goat`, `player${cardUserId}`, pulledAt, pulledAt, updatedAt],
    );
  }

  it("never lets a future stamp claim the latest pull", async () => {
    const now = Date.now();
    // Written three days ago, stamped a day into the future by the puller's
    // clock; the other row is a genuinely newer pull from an hour ago.
    await plantRow(OWNER, HONORARY_ID, now + 86_400_000, now - 3 * 86_400_000);
    await plantRow(OTHER_OWNER, OTHER_HONORARY_ID, now - 3_600_000, now - 3_600_000);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    expect(report.latest?.cardUserId).toBe(OTHER_HONORARY_ID);
    expect(report.latest?.ownerUserId).toBe(OTHER_OWNER);
  });

  it("reads a future stamp back as the moment the row was written", async () => {
    const now = Date.now();
    const writtenAt = now - 3_600_000;
    await plantRow(OWNER, HONORARY_ID, now + 86_400_000, writtenAt);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    const card = report.cards[0];
    /* Every stamp the readout ages, not just the newest-pull line: a future
       one on any of them prints as "just now" too. The row's server-written
       updated_at is what they come back as, so the pull ages from there
       instead of sitting at "just now" on every read. */
    expect(card?.lastPulledAt).toBe(writtenAt);
    expect(card?.firstPulledAt).toBe(writtenAt);
    expect(card?.owners[0]?.lastPulledAt).toBe(writtenAt);
    expect(card?.owners[0]?.firstPulledAt).toBe(writtenAt);
    expect(report.collectors[0]?.lastPulledAt).toBe(writtenAt);
    expect(report.latest?.pulledAt).toBe(writtenAt);
  });

  it("leaves an ordinary stamp exactly as stored", async () => {
    const pulledAt = Date.now() - 7_200_000;
    await plantRow(OWNER, HONORARY_ID, pulledAt, pulledAt + 60_000);

    const report = await getHonoraryPullsReport(db, HONORARY_USER_IDS);
    expect(report.cards[0]?.lastPulledAt).toBe(pulledAt);
    expect(report.latest?.pulledAt).toBe(pulledAt);
  });
});
