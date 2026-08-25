import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { seedCollectionCard } from "./helpers/pack-cards.js";
import {
  getPackCollector,
  listPackShowcaseWall,
  getPackCollectorProfile,
  getPackCommunityStats,
  listPackCollectors,
  normalizePackCollectorSort,
  orderByCompletion,
  packCommunitySnapshotStatus,
  registerPackCommunitySnapshots,
  resolvePackCollector,
} from "../src/features/pack-community.js";
import {
  ensurePackCommunityRollupTriggers,
  reconcilePackCommunityRollups,
} from "../src/features/pack-community-rollups.js";
import { HONORARY_USER_IDS } from "../src/features/pack-wallets.js";

let dir = "";
let db: Db;

const BIG = 100;
const SMALL = 200;
/* A collector with cards but no users row: half the point of the durable
   owner_username column, and the case a directory built off `users` misses. */
const UNTRACKED = 300;
const GOAT_ID = [...HONORARY_USER_IDS][0];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-community-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedCollector(userId: number, username: string, options: { tracked?: boolean; openedPacks?: number | null } = {}) {
  const { tracked = true, openedPacks = 0 } = options;
  if (tracked) {
    await exec(
      db,
      "insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, 'CR', '2026-01-01')",
      [userId, username, `https://a.ppy.sh/${userId}?stored`],
    );
  }
  const payload = openedPacks === null
    ? JSON.stringify({ shards: 5 })
    : JSON.stringify({ shards: 5, openedPacks });
  await exec(
    db,
    "insert or replace into pack_wallets (user_id, payload, rev, updated_at, owner_username) values (?, ?, 1, 1000, ?)",
    [userId, payload, username],
  );
}

/* A pullable player: the pack pool is the global ranking board, which is the
   tracked country rosters joined to users by pp. */
async function seedPoolPlayer(userId: number, pp: number) {
  await exec(
    db,
    "insert or replace into users (user_id, username, avatar_url, country_code, pp, global_rank, updated_at) values (?, ?, '', 'CR', ?, ?, '2026-01-01')",
    [userId, `player${userId}`, pp, Math.round(10000 - pp)],
  );
  await exec(
    db,
    "insert or replace into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', ?, ?, 'test', 1, '2026-01-01')",
    [userId, Math.round(10000 - pp)],
  );
}

async function seedSerial(cardUserId: number, ownerUserId: number, serial: number, tier: string | null = "rare") {
  const cardKey = tier === "goat" ? `${cardUserId}:goat` : String(cardUserId);
  await exec(
    db,
    "insert or replace into pack_card_serials (card_key, card_user_id, owner_user_id, serial, minted_at) values (?, ?, ?, ?, 1000)",
    [cardKey, cardUserId, ownerUserId, serial],
  );
}

describe("pack community stats", () => {
  it("counts the economy across every collector", async () => {
    await seedCollector(BIG, "bigcollector", { openedPacks: 40 });
    await seedCollector(SMALL, "smallcollector", { openedPacks: 3 });
    await seedCollectionCard(db, BIG, 11, { copies: 3, tier: "rare", recycledCopies: 2 });
    await seedCollectionCard(db, BIG, 12, { copies: 1, tier: "legendary" });
    await seedCollectionCard(db, BIG, GOAT_ID, { copies: 1, tier: "goat" });
    await seedCollectionCard(db, SMALL, 11, { copies: 1, tier: "rare" });

    const stats = await getPackCommunityStats(db);

    expect(stats.totals).toMatchObject({
      collectors: 2,
      packsOpened: 43,
      cardsMinted: 6,
      distinctHoldings: 4,
      playersCarded: 3,
      goatCardsMinted: 1,
      cardsRecycled: 2,
      goatRosterSize: HONORARY_USER_IDS.size,
    });
    expect(stats.totals.tierCopies).toEqual({ rare: 4, legendary: 1, goat: 1 });
    // Player 12 and the GOAT sit in one collection each; player 11 in two.
    expect(stats.totals.oneOfAKind).toBe(2);
  });

  it("leaves a card out of the totals once its last copy is recycled", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11, { copies: 0, recycledCopies: 4, tier: "rare" });

    const stats = await getPackCommunityStats(db);

    expect(stats.totals.collectors).toBe(0);
    expect(stats.totals.playersCarded).toBe(0);
  });

  it("ranks the boards by what each one is about", async () => {
    await seedCollector(BIG, "bigcollector", { openedPacks: 5 });
    await seedCollector(SMALL, "smallcollector", { openedPacks: 90 });
    await seedCollectionCard(db, BIG, 11, { tier: "rare", firstPulledAt: 100 });
    await seedCollectionCard(db, BIG, 12, { tier: "rare", firstPulledAt: 200 });
    await seedCollectionCard(db, BIG, GOAT_ID, { tier: "goat", firstPulledAt: 300 });
    await seedCollectionCard(db, SMALL, 11, { tier: "rare", firstPulledAt: 50 });
    await seedSerial(11, SMALL, 1);
    await seedSerial(12, BIG, 1);
    await seedSerial(GOAT_ID, BIG, 2, "goat");

    const { boards } = await getPackCommunityStats(db);

    expect(boards.biggestCollections.map((row) => row.userId)).toEqual([BIG, SMALL]);
    // Opened packs is its own board: the small collection bought the most.
    expect(boards.packsOpened.map((row) => row.userId)).toEqual([SMALL, BIG]);
    expect(boards.goatHolders.map((row) => row.userId)).toEqual([BIG]);
    // A serial of 1 is the first collector anywhere; BIG holds one, SMALL one.
    expect(boards.firstFinds.map((row) => [row.userId, row.firstFinds])).toEqual([[BIG, 1], [SMALL, 1]]);
    // Oldest surviving holding first.
    expect(boards.longestStanding.map((row) => row.userId)).toEqual([SMALL, BIG]);
  });

  it("names the cards fewest and most collections hold", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedCollector(SMALL, "smallcollector");
    await seedCollectionCard(db, BIG, 11, { tier: "rare" });
    await seedCollectionCard(db, SMALL, 11, { tier: "rare" });
    await seedCollectionCard(db, BIG, 12, { tier: "rare", username: "lonelyplayer" });

    const { boards } = await getPackCommunityStats(db);

    expect(boards.rarestCards[0]).toMatchObject({ userId: 12, owners: 1, username: "lonelyplayer" });
    expect(boards.mostOwnedCards[0]).toMatchObject({ userId: 11, owners: 2, copies: 2 });
  });

  it("degrades the completion board rather than the page when no pool can be built", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11);

    const stats = await getPackCommunityStats(db);

    expect(stats.totals.poolTotal).toBe(0);
    expect(stats.boards.completion).toEqual([]);
    expect(stats.boards.biggestCollections).toHaveLength(1);
  });

  it("serves a cached snapshot, and a stale one while the next is building", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11);
    const first = await getPackCommunityStats(db, 1_000_000);
    expect(first.totals.distinctHoldings).toBe(1);

    await seedCollectionCard(db, BIG, 12);
    // Inside the collector TTL nothing is re-read.
    expect((await getPackCommunityStats(db, 1_060_000)).totals.distinctHoldings).toBe(1);

    /* Past it, the rebuild is kicked off and the caller is handed the snapshot
       that already exists rather than made to wait on the scan. The read after
       that has the new card. */
    await getPackCommunityStats(db, 1_400_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await getPackCommunityStats(db, 1_400_000)).totals.distinctHoldings).toBe(2);
  });

  it("moves the totals on a pull while the boards stay on the snapshot they were built from", async () => {
    /* The point of the split: the four numbers at the top are cheap enough to
       re-read every twenty seconds off the maintained tables, so what somebody
       watched tick up live is still there when they reload. The boards under
       them keep their own two-minute clock. */
    await seedCollector(BIG, "bigcollector", { openedPacks: 3 });
    await seedCollectionCard(db, BIG, 11);
    await ensurePackCommunityRollupTriggers(db);
    await reconcilePackCommunityRollups(db, { now: 1_000_000 });

    const first = await getPackCommunityStats(db, 1_000_000);
    expect(first.totals).toMatchObject({ packsOpened: 3, distinctHoldings: 1 });
    expect(first.computedAt).toBe(1_000_000);

    // A pack opened: another banked open on the wallet and a card on the shelf.
    await exec(db, "update pack_wallets set payload = ? where user_id = ?", [JSON.stringify({ openedPacks: 4 }), BIG]);
    await seedCollectionCard(db, BIG, 12);
    await reconcilePackCommunityRollups(db, { now: 1_000_100 });

    /* Past the totals' lifetime and well inside the collector snapshot's. The
       first read after expiry is handed what was already in hand, same as the
       snapshots. */
    await getPackCommunityStats(db, 1_030_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await getPackCommunityStats(db, 1_030_000);

    expect(second.totals).toMatchObject({ packsOpened: 4, distinctHoldings: 2 });
    // The clock the page counts live pulls from is the totals' own, or it would
    // count the ones already in them a second time.
    expect(second.computedAt).toBe(1_030_000);
    // The boards are still the ones built a moment ago, card and all.
    expect(second.boards.biggestCollections[0]).toMatchObject({ cards: 1 });
  });

  it("keeps the snapshot's totals, and its clock, where the roll-up is not usable", async () => {
    // Nothing armed the triggers, so the stored counts cannot be trusted and
    // the only other way to answer is the scans. The totals stay whatever the
    // cached snapshot worked out.
    await seedCollector(BIG, "bigcollector", { openedPacks: 3 });
    await seedCollectionCard(db, BIG, 11);
    const first = await getPackCommunityStats(db, 1_000_000);
    expect(first.totals.packsOpened).toBe(3);

    await exec(db, "update pack_wallets set payload = ? where user_id = ?", [JSON.stringify({ openedPacks: 9 }), BIG]);
    await getPackCommunityStats(db, 1_030_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await getPackCommunityStats(db, 1_030_000);

    expect(second.totals.packsOpened).toBe(3);
    expect(second.computedAt).toBe(1_000_000);
  });

  it("counts only roster GOATs toward the roster, so a granted one cannot pass it", async () => {
    await seedCollector(BIG, "bigcollector");
    // /admin/collections can mint a GOAT for a player off the honorary roster.
    // That card is real, but it is not one of the 24 there are to find.
    await seedCollectionCard(db, BIG, GOAT_ID, { tier: "goat" });
    await seedCollectionCard(db, BIG, 4242, { tier: "goat" });

    const { boards } = await getPackCommunityStats(db);

    expect(boards.goatHolders[0]).toMatchObject({ goats: 1 });
    expect(boards.goatHolders[0].completion).toMatchObject({
      goatsOwned: 1,
      goatsTotal: HONORARY_USER_IDS.size,
    });
  });

  it("keeps ranked honorary players in the GOAT roster instead of the ordinary pool ratio", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedPoolPlayer(GOAT_ID, 5000);
    await seedPoolPlayer(11, 4000);
    // Retired: carded, but no longer on any tracked roster.
    await seedCollectionCard(db, BIG, 99, { tier: "rare" });
    await seedCollectionCard(db, BIG, 11, { tier: "rare" });
    await seedCollectionCard(db, BIG, GOAT_ID, { tier: "goat" });
    await seedCollectionCard(db, BIG, GOAT_ID, { tier: "rare" });

    const profile = await getPackCollectorProfile(db, BIG);

    expect(profile?.completion.poolTotal).toBe(1);
    // Three players held, but the honorary player's two variants belong only
    // to the separately-counted GOAT roster. The ordinary pool is player 11.
    expect(profile?.collector.cards).toBe(4);
    expect(profile?.collector.players).toBe(3);
    expect(profile?.completion.poolOwnedCount).toBe(1);
  });

  it("does not let a collector's Eternal variant fill their ordinary pool slot", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedPoolPlayer(BIG, 5000);
    await seedCollectionCard(db, BIG, BIG, { tier: "eternal" });

    const profile = await getPackCollectorProfile(db, BIG);

    expect(profile?.collector.cards).toBe(1);
    expect(profile?.completion.poolTotal).toBe(1);
    expect(profile?.completion.poolOwnedCount).toBe(0);
  });

});

describe("pack collector directory", () => {
  beforeEach(async () => {
    await seedCollector(BIG, "bigcollector", { openedPacks: 40 });
    await seedCollector(SMALL, "smallcollector", { openedPacks: 3 });
    await seedCollector(UNTRACKED, "ghostcollector", { tracked: false, openedPacks: 1 });
    await seedCollectionCard(db, BIG, 11, { copies: 2 });
    await seedCollectionCard(db, BIG, 12);
    await seedCollectionCard(db, SMALL, 11);
    await seedCollectionCard(db, UNTRACKED, 11);
  });

  it("lists collectors biggest first and pages them", async () => {
    const first = await listPackCollectors(db, { page: 0, pageSize: 2 });
    expect(first.total).toBe(3);
    expect(first.collectors.map((row) => row.userId)).toEqual([BIG, SMALL]);

    const second = await listPackCollectors(db, { page: 1, pageSize: 2 });
    expect(second.collectors.map((row) => row.userId)).toEqual([UNTRACKED]);
  });

  it("filters by name against the name the rows print", async () => {
    const found = await listPackCollectors(db, { page: 0, pageSize: 10, query: "GHOST" });
    expect(found.total).toBe(1);
    expect(found.collectors[0]).toMatchObject({ userId: UNTRACKED, username: "ghostcollector", tracked: false });
  });

  it("keeps a collector with no users row, naming and picturing them anyway", async () => {
    const collector = await getPackCollector(db, UNTRACKED);
    expect(collector).toMatchObject({
      username: "ghostcollector",
      tracked: false,
      countryCode: null,
      avatarUrl: `https://a.ppy.sh/${UNTRACKED}`,
    });
  });

  it("sorts on whichever column was asked for", async () => {
    const byPacks = await listPackCollectors(db, { page: 0, pageSize: 10, sort: "packs" });
    expect(byPacks.collectors.map((row) => row.userId)).toEqual([BIG, SMALL, UNTRACKED]);

    const byCopies = await listPackCollectors(db, { page: 0, pageSize: 10, sort: "copies" });
    expect(byCopies.collectors[0]).toMatchObject({ userId: BIG, copies: 3 });
  });

  it("falls back to the default sort for anything it does not recognise", () => {
    expect(normalizePackCollectorSort("goats")).toBe("goats");
    // Recency is deliberately not a public directory ordering: accepting the
    // old query would preserve the player-activity view after its UI was gone.
    expect(normalizePackCollectorSort("recent")).toBe("cards");
    expect(normalizePackCollectorSort("toString")).toBe("cards");
    expect(normalizePackCollectorSort(null)).toBe("cards");
  });

  it("resolves a collector by id, by tracked name, and by the name their wallet froze", async () => {
    expect(await resolvePackCollector(db, { userId: BIG })).toBe(BIG);
    expect(await resolvePackCollector(db, { username: "BigCollector" })).toBe(BIG);
    expect(await resolvePackCollector(db, { username: "ghostcollector" })).toBe(UNTRACKED);
    expect(await resolvePackCollector(db, { username: "nobody" })).toBeNull();
  });
});

describe("pack collector profile", () => {
  it("carries the collector's standing and their pinned shelf", async () => {
    await seedCollector(BIG, "bigcollector", { openedPacks: 40 });
    await seedCollector(SMALL, "smallcollector", { openedPacks: 3 });
    await seedCollectionCard(db, BIG, 11, { tier: "rare" });
    await seedCollectionCard(db, BIG, GOAT_ID, { tier: "goat" });
    await seedCollectionCard(db, SMALL, 11, { tier: "rare" });
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, 1000)",
      [BIG, String(11)],
    );

    const profile = await getPackCollectorProfile(db, BIG);

    expect(profile?.collector).toMatchObject({ userId: BIG, cards: 2, goats: 1, packsOpened: 40 });
    expect(profile?.completion).toMatchObject({ goatsOwned: 1, goatsTotal: HONORARY_USER_IDS.size });
    expect(profile?.showcase.map((card) => card.userId)).toEqual([11]);
    expect(profile?.ranks).toEqual({ cards: 1, packsOpened: 1 });

    const smaller = await getPackCollectorProfile(db, SMALL);
    expect(smaller?.ranks).toEqual({ cards: 2, packsOpened: 2 });
  });

  it("leaves the opened-packs rank off a wallet that never banked the count", async () => {
    await seedCollector(BIG, "bigcollector", { openedPacks: null });
    await seedCollectionCard(db, BIG, 11);

    const profile = await getPackCollectorProfile(db, BIG);

    expect(profile?.collector.packsOpened).toBeNull();
    expect(profile?.ranks.packsOpened).toBeNull();
  });

  it("has nothing to show for an account that never opened a pack", async () => {
    await seedCollector(BIG, "bigcollector");
    expect(await getPackCollectorProfile(db, BIG)).toBeNull();
    expect(await getPackCollector(db, 999)).toBeNull();
  });
});

describe("showcase wall", () => {
  it("is one tile per card, most recently chosen first, whoever chose it", async () => {
    /* Not one row per collector: the card is the unit, so a collector who put
       up two cards is two tiles and they sort independently of each other. */
    await seedCollector(BIG, "bigcollector");
    await seedCollector(SMALL, "smallcollector");
    await seedCollectionCard(db, BIG, 11, { tier: "rare" });
    await seedCollectionCard(db, BIG, 12, { tier: "epic" });
    await seedCollectionCard(db, SMALL, 13, { tier: "rare" });
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, 1000)",
      [BIG, "11"],
    );
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 1, ?, 9000)",
      [BIG, "12"],
    );
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, 5000)",
      [SMALL, "13"],
    );

    const wall = await listPackShowcaseWall(db, { page: 0, pageSize: 10 });

    expect(wall.total).toBe(3);
    expect(wall.cards.map((entry) => [entry.collector.userId, entry.card.userId])).toEqual([
      [BIG, 12],
      [SMALL, 13],
      [BIG, 11],
    ]);
    expect(wall.cards[0].showcasedAt).toBe(9000);
  });

  it("pages over cards rather than over collectors", async () => {
    await seedCollector(BIG, "bigcollector");
    for (const [index, cardId] of [11, 12, 13].entries()) {
      await seedCollectionCard(db, BIG, cardId, { tier: "rare" });
      await exec(
        db,
        "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, ?, ?, ?)",
        [BIG, index, String(cardId), 1000 + index],
      );
    }

    const first = await listPackShowcaseWall(db, { page: 0, pageSize: 2 });
    const second = await listPackShowcaseWall(db, { page: 1, pageSize: 2 });

    // One collector, three tiles, two pages: the person is not the page unit.
    expect(first.total).toBe(3);
    expect(first.cards.map((entry) => entry.card.userId)).toEqual([13, 12]);
    expect(second.cards.map((entry) => entry.card.userId)).toEqual([11]);
  });

  it("leaves out a card that was recycled away, and does not count it either", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11, { copies: 0, tier: "rare" });
    await seedCollectionCard(db, BIG, 12, { tier: "rare" });
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, 1000)",
      [BIG, "11"],
    );
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 1, ?, 2000)",
      [BIG, "12"],
    );

    const wall = await listPackShowcaseWall(db, { page: 0, pageSize: 10 });

    // Counted as well as hidden: a pin that draws nothing would otherwise pad
    // the total and leave the last page short.
    expect(wall.total).toBe(1);
    expect(wall.cards.map((entry) => entry.card.userId)).toEqual([12]);
  });

  it("describes the collectors it shows without building the economy roll-up", async () => {
    /* The wall is the default tab, so it must not wait on the cached roll-up
       (a full scan of the ownership table, seconds on a cold process). It
       groups the handful of owners it is about to print instead. */
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11, { tier: "rare" });
    await seedCollectionCard(db, BIG, GOAT_ID, { tier: "goat" });
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, 1000)",
      [BIG, "11"],
    );

    const wall = await listPackShowcaseWall(db, { page: 0, pageSize: 10 });

    expect(wall.cards[0].collector).toEqual({
      userId: BIG,
      username: "bigcollector",
      countryCode: "CR",
      avatarUrl: `https://a.ppy.sh/${BIG}?stored`,
      tracked: true,
      cards: 2,
      goats: 1,
    });
  });

  it("names a collector with no users row from the name their wallet froze", async () => {
    await seedCollector(UNTRACKED, "ghostcollector", { tracked: false });
    await seedCollectionCard(db, UNTRACKED, 11, { tier: "rare" });
    await exec(
      db,
      "insert into pack_showcase_cards (owner_user_id, position, card_key, updated_at) values (?, 0, ?, 1000)",
      [UNTRACKED, "11"],
    );

    const wall = await listPackShowcaseWall(db, { page: 0, pageSize: 10 });

    expect(wall.cards[0].collector).toMatchObject({
      username: "ghostcollector",
      tracked: false,
      countryCode: null,
    });
  });

  it("has nothing to show before anyone picks a card", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11);
    expect(await listPackShowcaseWall(db, { page: 0, pageSize: 10 })).toEqual({ cards: [], total: 0 });
  });
});

describe("completion ordering", () => {
  it("puts the fullest collection first, breaking ties on GOATs then on who started earliest", () => {
    const row = (userId: number, poolOwnedCount: number, goatsOwned: number, joinedAt: number) => ({
      userId,
      joinedAt,
      completion: { poolTotal: 100, poolOwnedCount, retiredOwnedCount: 0, goatsOwned, goatsTotal: 24 },
    });

    const ordered = orderByCompletion([
      row(1, 40, 2, 500),
      row(2, 90, 0, 900),
      row(3, 40, 2, 100),
      row(4, 40, 9, 900),
    ]);

    expect(ordered.map((entry) => entry.userId)).toEqual([2, 4, 3, 1]);
  });
});

/* The snapshot is written next to the database after every successful build, so
   a restart serves the last good one instead of making its first visitor sit
   through a cold scan. That was the whole shape of the 25-second load on
   /packs/collections: the process had restarted three minutes earlier and the
   first read of the endpoint paid for both roll-ups. */
describe("snapshot disk cache", () => {
  const COLLECTOR_TTL_MS = 2 * 60_000;

  async function waitForCacheFiles(): Promise<string[]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const written = (await readdir(dir)).filter((name) => name.startsWith("pack-community-"));
      if (written.length >= 2) return written;
      await new Promise((done) => setTimeout(done, 10));
    }
    return (await readdir(dir)).filter((name) => name.startsWith("pack-community-"));
  }

  it("serves a restarted process the snapshot the last one left on disk", async () => {
    registerPackCommunitySnapshots(db, { databaseUrl: `file:${join(dir, "test.db")}` });
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11);
    expect((await getPackCommunityStats(db)).totals.distinctHoldings).toBe(1);
    expect(await waitForCacheFiles()).toHaveLength(2);

    // A card pulled after that snapshot was written. A restarted process must
    // answer from the file rather than scan for it, which is what makes the
    // first read after a deploy cost nothing.
    await seedCollectionCard(db, BIG, 12);
    const restarted = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    registerPackCommunitySnapshots(restarted, { databaseUrl: `file:${join(dir, "test.db")}` });

    /* Inside the collector lifetime the restored snapshot is simply the answer:
       nothing rebuilds, and the second card is not there yet. */
    expect((await getPackCommunityStats(restarted)).totals.distinctHoldings).toBe(1);
    expect(packCommunitySnapshotStatus(restarted).collector.source).toBe("disk");

    /* Past it, the restored snapshot is what the reader is handed while the
       rebuild runs, rather than what they wait behind. */
    const past = Date.now() + COLLECTOR_TTL_MS + 1;
    expect((await getPackCommunityStats(restarted, past)).totals.distinctHoldings).toBe(1);
    await new Promise((done) => setTimeout(done, 100));
    expect((await getPackCommunityStats(restarted, past)).totals.distinctHoldings).toBe(2);
    restarted.close();
  });

  it("keeps building in memory when nothing registered a cache directory", async () => {
    await seedCollector(BIG, "bigcollector");
    await seedCollectionCard(db, BIG, 11);
    expect((await getPackCommunityStats(db)).totals.distinctHoldings).toBe(1);
    expect(packCommunitySnapshotStatus(db)).toMatchObject({
      diskCache: false,
      collector: { source: "inline" },
    });
    expect((await readdir(dir)).filter((name) => name.startsWith("pack-community-"))).toEqual([]);
  });
});
