import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  claimPackMilestoneOnce,
  countPacksOpened,
  getPackMilestoneStatus,
  PACK_MILESTONE,
  resetPackMilestoneStatusCache,
} from "../src/features/pack-milestone.js";
import {
  getPackCollectionCard,
  isPackWalletEternalPending,
  listPullableEternalCards,
  mintEternalSelfCardOnce,
  spendPackOpen,
} from "../src/features/pack-wallets.js";

/* The pack-count milestone: the golden card for the open that makes the
   number. Everything here is server-decided (the sum, the unique claim and
   the variant key), and the golden card must not collide with the completion
   reward or the Eternal pull. */

let dir = "";
let db: Db;

const OWNER = 14600698;
const OTHER = 7777777;
const FILLER = 4242;
const IDENTITY = { username: "opener", avatarUrl: "https://a.ppy.sh/u/14600698", countryCode: "CR", pp: 12_345, globalRank: 42 };
const NOW = 1_760_000_000_000;

async function seedUser(userId: number, username = `player${userId}`): Promise<void> {
  await exec(
    db,
    "insert or replace into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, 'https://a.ppy.sh/u', 'CR', '2026-01-01')",
    [userId, username],
  );
}

/* Puts the site-wide total at `target - short` through one filler wallet. */
async function seedOpened(short: number): Promise<void> {
  await exec(
    db,
    "insert or replace into pack_wallets (user_id, payload, rev, updated_at) values (?, ?, 1, ?)",
    [FILLER, JSON.stringify({ openedPacks: PACK_MILESTONE.target - short, shards: 0, charges: 0 }), NOW],
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-milestone-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  resetPackMilestoneStatusCache();
  await seedUser(OWNER, "opener");
  await seedUser(OTHER, "other");
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the golden card", () => {
  it("is not dealt short of the target, and the identity is never resolved for it", async () => {
    await seedOpened(2);
    await spendPackOpen(db, OWNER, { kind: "charge" }, NOW);
    let resolved = 0;
    const deal = await claimPackMilestoneOnce(db, OWNER, async () => {
      resolved += 1;
      return IDENTITY;
    }, NOW);
    expect(deal.dealt).toBe(false);
    expect(deal.packsOpened).toBe(PACK_MILESTONE.target - 1);
    expect(resolved).toBe(0);
  });

  it("is dealt once to the open that makes the number, as an Eternal variant with the badge and motif", async () => {
    await seedOpened(1);
    await spendPackOpen(db, OWNER, { kind: "charge" }, NOW);
    expect(await countPacksOpened(db)).toBe(PACK_MILESTONE.target);
    const deal = await claimPackMilestoneOnce(db, OWNER, async () => IDENTITY, NOW);
    expect(deal.dealt).toBe(true);
    expect(deal.cardKey).toBe(`${OWNER}:v1`);
    expect(deal.isNew).toBe(true);

    const card = await getPackCollectionCard(db, OWNER, deal.cardKey!);
    expect(card?.tier).toBe("eternal");
    expect(card?.customLabel).toBe(PACK_MILESTONE.goldenLabel);
    expect(card?.motif?.url).toBe(PACK_MILESTONE.goldenMotif.url);
    expect(card?.motif?.palette).toBe("gold");
    expect(card?.copies).toBe(1);
    expect(card?.serial).toBe(1);
    expect(card?.grantedAt ?? null).toBeNull();

    const registry = (await exec(db, "select * from pack_milestones")).rows;
    expect(registry).toHaveLength(1);
    expect(registry[0].owner_user_id).toBe(OWNER);
    expect(registry[0].packs_opened).toBe(PACK_MILESTONE.target);

    // The next open, from anyone, gets nothing: the milestone is claimed.
    await spendPackOpen(db, OTHER, { kind: "charge" }, NOW + 1);
    const again = await claimPackMilestoneOnce(db, OTHER, async () => IDENTITY, NOW + 1);
    expect(again.dealt).toBe(false);
    expect((await exec(db, "select count(*) as n from pack_milestones")).rows[0].n).toBe(1);
  });

  it("does not retire the completion reward and never circulates on the Eternal pull", async () => {
    await seedOpened(1);
    await spendPackOpen(db, OWNER, { kind: "charge" }, NOW);
    const deal = await claimPackMilestoneOnce(db, OWNER, async () => IDENTITY, NOW);
    expect(deal.dealt).toBe(true);
    // Their own Eternal, but the milestone's, not the collection's.
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(true);
    const completion = await mintEternalSelfCardOnce(db, OWNER, IDENTITY, NOW + 5);
    expect(completion.dealt).toBe(true);
    expect(await isPackWalletEternalPending(db, OWNER)).toBe(false);
    // Only the ":eternal" card is pullable by others; the golden variant is one of one.
    const pullable = await listPullableEternalCards(db, OTHER);
    expect(pullable).toEqual([{ userId: OWNER, owned: false }]);
  });

  it("reads back on the public status with the winner's name", async () => {
    await seedOpened(1);
    await spendPackOpen(db, OWNER, { kind: "charge" }, NOW);
    let status = await getPackMilestoneStatus(db, NOW);
    expect(status?.opened).toBe(PACK_MILESTONE.target);
    expect(status?.claim).toBeNull();
    await claimPackMilestoneOnce(db, OWNER, async () => IDENTITY, NOW);
    status = await getPackMilestoneStatus(db, NOW + 1);
    expect(status?.claim?.ownerUserId).toBe(OWNER);
    expect(status?.claim?.username).toBe("opener");
    expect(status?.claim?.cardKey).toBe(`${OWNER}:v1`);
  });
});
