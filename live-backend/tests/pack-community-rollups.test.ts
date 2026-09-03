import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, execBatch, migrate, type Db } from "../src/db.js";
import { seedCollectionCard } from "./helpers/pack-cards.js";
import { buildPackCardSnapshot, buildPackCollectorSnapshotWire } from "../src/features/pack-community.js";
import {
  ensurePackCommunityRollupTriggers,
  readPackCommunityRollupState,
  reconcilePackCommunityRollups,
} from "../src/features/pack-community-rollups.js";
import { HONORARY_USER_IDS, packCardKey } from "../src/features/pack-wallets.js";

let dir = "";
let db: Db;

const BIG = 100;
const SMALL = 200;
const THIRD = 300;
const GOAT_ID = [...HONORARY_USER_IDS][0];
const NOW = 5_000_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-rollups-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function seedWallet(userId: number, username: string, openedPacks = 5) {
  await exec(
    db,
    "insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, '', 'CR', '2026-01-01')",
    [userId, username],
  );
  await exec(
    db,
    "insert or replace into pack_wallets (user_id, payload, rev, updated_at, owner_username) values (?, ?, 1, 1000, ?)",
    [userId, JSON.stringify({ shards: 1, openedPacks }), username],
  );
}

/* A shelf with enough shape to tell the two paths apart: duplicates, recycled
   copies, a GOAT off the honorary roster and one off it, several tiers, an
   Eternal, a card two people hold and a card only one does. */
async function seedEconomy() {
  await seedWallet(BIG, "bigcollector", 40);
  await seedWallet(SMALL, "smallcollector", 3);
  await seedWallet(THIRD, "thirdcollector", 11);
  await seedCollectionCard(db, BIG, 11, { copies: 3, tier: "rare", recycledCopies: 2, firstPulledAt: 1000 });
  await seedCollectionCard(db, BIG, 12, { copies: 1, tier: "legendary", firstPulledAt: 1500 });
  await seedCollectionCard(db, BIG, GOAT_ID, { copies: 2, tier: "goat", firstPulledAt: 900 });
  await seedCollectionCard(db, BIG, 4242, { copies: 1, tier: "goat", firstPulledAt: 2000 });
  await seedCollectionCard(db, SMALL, 11, { copies: 1, tier: "rare", firstPulledAt: 3000 });
  await seedCollectionCard(db, SMALL, 13, { copies: 4, tier: null, firstPulledAt: 3200 });
  await seedCollectionCard(db, THIRD, 12, { copies: 1, tier: "legendary", firstPulledAt: 4000 });
  await seedCollectionCard(db, THIRD, THIRD, { copies: 1, tier: "eternal", firstPulledAt: 4100 });
  await exec(
    db,
    "insert or replace into pack_card_serials (card_key, card_user_id, owner_user_id, serial, minted_at) values (?, ?, ?, 1, 1000)",
    [packCardKey(11, "rare"), 11, BIG],
  );
}

async function snapshots() {
  return {
    collectors: await buildPackCollectorSnapshotWire(db, NOW),
    cards: await buildPackCardSnapshot(db, NOW),
  };
}

describe("pack community roll-ups", () => {
  it("answers exactly what the full scans answered", async () => {
    await seedEconomy();
    // Nothing has initialized the tables, so this is the scan path.
    const scanned = await snapshots();

    await ensurePackCommunityRollupTriggers(db);
    const result = await reconcilePackCommunityRollups(db, { now: NOW });
    expect(result).toMatchObject({ ready: true, blocked: null, rebuilt: true, backlog: 0 });

    const rolled = await snapshots();
    expect(rolled).toEqual(scanned);
    // The Eternal count comes off the per-tier table on this path.
    expect(rolled.collectors.collectors.find((row) => row.userId === THIRD)?.eternals).toBe(1);
  });

  it("keeps up with a pull, a duplicate and a card recycled to nothing", async () => {
    await seedEconomy();
    await ensurePackCommunityRollupTriggers(db);
    await reconcilePackCommunityRollups(db, { now: NOW });

    // A new holding, an existing one gaining a copy, and one recycled away.
    await seedCollectionCard(db, THIRD, 11, { copies: 1, tier: "rare", firstPulledAt: 4500 });
    await exec(db, "update pack_collection_cards set copies = 5 where owner_user_id = ? and card_key = ?", [
      SMALL,
      packCardKey(13, null),
    ]);
    await exec(db, "delete from pack_collection_cards where owner_user_id = ? and card_key = ?", [
      BIG,
      packCardKey(12, "legendary"),
    ]);

    const drained = await reconcilePackCommunityRollups(db, { now: NOW });
    expect(drained).toMatchObject({ ready: true, rebuilt: false, backlog: 0 });
    const rolled = await snapshots();

    // The same database read the slow way, with the roll-up switched off.
    await exec(db, "delete from live_meta where key = 'pack_community_rollups'");
    expect(await snapshots()).toEqual(rolled);
  });

  /* Regression: the dirty triggers used `insert or ignore`, and SQLite lets the
     statement that fired a trigger override the conflict policy inside its
     body. The pack draw upserts its ownership rows, so `or ignore` became
     `or abort` and the second card of a pack aborted the whole draw with
     "UNIQUE constraint failed: pack_community_dirty_owners.owner_user_id".
     Bookkeeping for a community page must never be able to refuse a pull. */
  it("lets a pack deal several cards to one collector, upsert and all", async () => {
    await seedWallet(BIG, "bigcollector");
    await ensurePackCommunityRollupTriggers(db);

    const deal = (cardUserId: number) => ({
      sql: `insert into pack_collection_cards (
              owner_user_id, card_user_id, card_key, tier, skills_id, pp, global_rank,
              copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
            ) values (?, ?, ?, 'rare', null, 1000, 500, 1, 0, 1000, 1000, 1000)
            on conflict(owner_user_id, card_key) do update set
              copies = pack_collection_cards.copies + 1,
              updated_at = excluded.updated_at`,
      args: [BIG, cardUserId, packCardKey(cardUserId, "rare")],
    });

    // One pack: five cards to the same collector, one of them a duplicate.
    await expect(execBatch(db, [deal(21), deal(22), deal(23), deal(24), deal(21)])).resolves.toBeDefined();

    expect(Number((await exec(db, "select count(*) as n from pack_community_dirty_owners")).rows[0]?.n)).toBe(1);
    expect(Number((await exec(db, "select count(*) as n from pack_community_dirty_cards")).rows[0]?.n)).toBe(4);

    await reconcilePackCommunityRollups(db, { now: NOW });
    const collector = (await buildPackCollectorSnapshotWire(db, NOW)).collectors[0];
    expect(collector).toMatchObject({ userId: BIG, cards: 4, players: 4, copies: 5 });
  });

  it("drops a collector who recycled their last card", async () => {
    await seedEconomy();
    await ensurePackCommunityRollupTriggers(db);
    await reconcilePackCommunityRollups(db, { now: NOW });
    expect((await buildPackCollectorSnapshotWire(db, NOW)).collectors).toHaveLength(3);

    await exec(db, "delete from pack_collection_cards where owner_user_id = ?", [THIRD]);
    await reconcilePackCommunityRollups(db, { now: NOW });

    const collectors = (await buildPackCollectorSnapshotWire(db, NOW)).collectors;
    expect(collectors).toHaveLength(2);
    expect(collectors.map((collector) => collector.userId)).not.toContain(THIRD);
    expect(Number((await exec(db, "select count(*) as n from pack_community_owner_stats")).rows[0]?.n)).toBe(2);
  });

  it("goes back to scanning if nothing is marking rows dirty any more", async () => {
    await seedEconomy();
    await ensurePackCommunityRollupTriggers(db);
    await reconcilePackCommunityRollups(db, { now: NOW });

    /* A trigger can only go missing by the ownership table being rebuilt under
       it, which is exactly when the stored counts stop being trustworthy. The
       page must not keep reading them. */
    await exec(db, "drop trigger pack_community_dirty_ins");
    await seedCollectionCard(db, THIRD, 99, { copies: 1, tier: "rare" });

    const collectors = (await buildPackCollectorSnapshotWire(db, NOW)).collectors;
    expect(collectors.find((collector) => collector.userId === THIRD)?.cards).toBe(3);
    expect(await reconcilePackCommunityRollups(db, { now: NOW })).toMatchObject({
      ready: false,
      blocked: "no_triggers",
    });
  });

  it("rebuilds rather than trusting rows computed under an older generation", async () => {
    await seedEconomy();
    await ensurePackCommunityRollupTriggers(db);
    await reconcilePackCommunityRollups(db, { now: NOW });
    const state = await readPackCommunityRollupState(db);
    expect(state.generation).toMatch(/^v\d+-h/);

    await exec(
      db,
      "update live_meta set value_json = ? where key = 'pack_community_rollups'",
      [JSON.stringify({ ...state, generation: "v0-hstale" })],
    );
    expect(await reconcilePackCommunityRollups(db, { now: NOW })).toMatchObject({ rebuilt: true });
    expect((await readPackCommunityRollupState(db)).generation).toBe(state.generation);
  });

  it("builds the tables once when both snapshots ask for them at the same moment", async () => {
    // Every refresh tick asks for the collector snapshot and the card snapshot
    // together and each reconciles first, so on a cold boot the two arrive
    // inside the same millisecond. Left concurrent that is two full rebuilds of
    // the same tables.
    await ensurePackCommunityRollupTriggers(db);
    await seedEconomy();
    const [first, second] = await Promise.all([
      reconcilePackCommunityRollups(db, { now: NOW }),
      reconcilePackCommunityRollups(db, { now: NOW }),
    ]);
    expect([first.rebuilt, second.rebuilt]).toEqual([true, false]);
    // The second pass ran after the first finished rather than alongside it, so
    // it found the dirty rows already drained.
    expect(second).toMatchObject({ ready: true, owners: 0, cards: 0, backlog: 0 });
    expect(await snapshots()).toEqual(await snapshots());
  });

  it("drains a backlog that will not fit in one batch", async () => {
    // Batches are sized by how long they take, so a bulk grant or an import can
    // leave more dirty collectors than any single transaction takes. Every one
    // of them still has to end up counted.
    await ensurePackCommunityRollupTriggers(db);
    const owners = 300;
    for (let index = 0; index < owners; index += 1) {
      const userId = 1000 + index;
      await seedWallet(userId, `collector${index}`, 1);
      await seedCollectionCard(db, userId, 11, { copies: 2, tier: "rare", firstPulledAt: 1000 + index });
    }
    const result = await reconcilePackCommunityRollups(db, { now: NOW });
    expect(result).toMatchObject({ ready: true, backlog: 0 });
    expect(Number((await exec(db, "select count(*) as n from pack_community_owner_stats")).rows[0]?.n)).toBe(owners);
    const snapshot = await buildPackCollectorSnapshotWire(db, NOW);
    expect(snapshot.collectors).toHaveLength(owners);
    expect(snapshot.tierCopies.rare).toBe(owners * 2);
  });
});
