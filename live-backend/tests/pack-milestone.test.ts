import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { drawPackHand, type PackDrawDeps } from "../src/features/pack-draw.js";
import type { GlobalRankingEntry } from "../src/features/global-rankings.js";
import {
  claimPackMilestoneOnce,
  countPacksOpened,
  getPackMilestoneStatus,
  isPackMilestoneFoilWindowOpen,
  mintPackMilestoneFoilCard,
  PACK_MILESTONE,
  resetPackMilestoneStatusCache,
} from "../src/features/pack-milestone.js";
import { recordPackPullEvents } from "../src/features/pack-pulls.js";
import {
  applyPackCollectionCardMint,
  getPackCollectionCard,
  isPackWalletEternalPending,
  listPullableEternalCards,
  mintEternalSelfCardOnce,
  spendPackOpen,
} from "../src/features/pack-wallets.js";

/* The pack-count milestone: the golden card for the open that makes the
   number, and the foil window that follows. Everything here is server-decided
   (the sum, the unique claim, the variant keys), and the golden card must not
   collide with the completion reward or the Eternal pull. */

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

function entry(userId: number, rank: number): GlobalRankingEntry {
  return {
    rank,
    user: { id: userId, username: `p${userId}`, avatar_url: `https://a.ppy.sh/${userId}`, cover_url: "", country_code: "CR" },
    pp: 10_000 - rank,
    global_rank: rank,
    country_rank: rank,
    hit_accuracy: null,
    play_count: null,
    ranked_score: null,
    grade_counts: null,
    global_change: null,
    country_change: null,
  };
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
    expect(status?.foilClosesAt).toBeNull();
    await claimPackMilestoneOnce(db, OWNER, async () => IDENTITY, NOW);
    status = await getPackMilestoneStatus(db, NOW + 1);
    expect(status?.claim?.ownerUserId).toBe(OWNER);
    expect(status?.claim?.username).toBe("opener");
    expect(status?.claim?.cardKey).toBe(`${OWNER}:v1`);
    expect(status?.foilOpensAt).toBe(NOW);
    expect(status?.foilClosesAt).toBe(NOW + PACK_MILESTONE.foilWindowMs);
  });
});

describe("the foil", () => {
  async function claim(): Promise<void> {
    await seedOpened(1);
    await spendPackOpen(db, OWNER, { kind: "charge" }, NOW);
    const deal = await claimPackMilestoneOnce(db, OWNER, async () => IDENTITY, NOW);
    expect(deal.dealt).toBe(true);
  }

  it("has a window that opens with the claim and closes a week later", async () => {
    expect(await isPackMilestoneFoilWindowOpen(db, NOW)).toBe(false);
    await claim();
    expect(await isPackMilestoneFoilWindowOpen(db, NOW)).toBe(true);
    expect(await isPackMilestoneFoilWindowOpen(db, NOW + PACK_MILESTONE.foilWindowMs - 1)).toBe(true);
    expect(await isPackMilestoneFoilWindowOpen(db, NOW + PACK_MILESTONE.foilWindowMs)).toBe(false);
  });

  it("is one variant per player, shared by every collector who pulls it", async () => {
    await claim();
    const cardUserId = 555;
    await seedUser(cardUserId);
    const identity = { username: "p555", avatarUrl: "https://a.ppy.sh/555", countryCode: "CR", pp: 900, globalRank: 12 };
    const first = await mintPackMilestoneFoilCard(db, OWNER, cardUserId, identity, NOW + 10);
    const second = await mintPackMilestoneFoilCard(db, OTHER, cardUserId, identity, NOW + 11);
    const repeat = await mintPackMilestoneFoilCard(db, OWNER, cardUserId, identity, NOW + 12);
    expect(first.cardKey).toBe(`${cardUserId}:v1`);
    expect(second.cardKey).toBe(first.cardKey);
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(true);
    expect(repeat.isNew).toBe(false);

    const mine = await getPackCollectionCard(db, OWNER, first.cardKey);
    expect(mine?.copies).toBe(2);
    expect(mine?.tier).toBeNull();
    expect(mine?.customLabel).toBe(PACK_MILESTONE.foilLabel);
    expect(mine?.motif?.url).toBe(PACK_MILESTONE.foilMotif.url);
    expect(mine?.serial).toBe(1);
    expect((await getPackCollectionCard(db, OTHER, first.cardKey))?.serial).toBe(2);
  });

  it("keeps its badge and motif through the reveal's mint pass, which labels the tier", async () => {
    await claim();
    const cardUserId = 555;
    await seedUser(cardUserId);
    const foil = await mintPackMilestoneFoilCard(db, OWNER, cardUserId, { username: "p555", avatarUrl: "", countryCode: "CR", pp: 900, globalRank: 12 }, NOW + 10);
    const mint = await applyPackCollectionCardMint(db, OWNER, foil.cardKey, {
      tier: "rare",
      tierLabel: "Rare",
      skills: { cardPower: 12 },
    }, NOW + 20);
    expect(mint).toEqual({ applied: true, cardKey: foil.cardKey });
    const card = await getPackCollectionCard(db, OWNER, foil.cardKey);
    expect(card?.tier).toBe("rare");
    expect(card?.customLabel).toBe(PACK_MILESTONE.foilLabel);
    expect(card?.motif?.url).toBe(PACK_MILESTONE.foilMotif.url);
    expect(card?.skills).toEqual({ cardPower: 12 });
  });

  it("is reported to the community feed under its own key, and only while that deal is unreported", async () => {
    await claim();
    const cardUserId = 555;
    await seedUser(cardUserId);
    const foil = await mintPackMilestoneFoilCard(db, OWNER, cardUserId, { username: "p555", avatarUrl: "", countryCode: "CR", pp: 900, globalRank: 12 }, NOW + 10);
    const report = await recordPackPullEvents(db, OWNER, "opener", "standard", [
      { userId: cardUserId, username: "p555", countryCode: "CR", tier: "rare", isNew: true, cardKey: foil.cardKey },
    ], NOW + 30);
    expect(report.recorded).toBe(1);
    expect(report.mints[0].cardKey).toBe(foil.cardKey);
    expect(report.mints[0].serial).toBe(1);
    // A replay of the same key, now settled, falls back to the ordinary card.
    const replay = await recordPackPullEvents(db, OWNER, "opener", "standard", [
      { userId: cardUserId, username: "p555", countryCode: "CR", tier: "rare", isNew: false, cardKey: foil.cardKey },
    ], NOW + 40);
    expect(replay.mints[0].cardKey).toBe(`${cardUserId}:rare`.replace(":rare", ""));
    // A key for a card nobody dealt is refused the same way.
    const forged = await recordPackPullEvents(db, OTHER, "other", "standard", [
      { userId: cardUserId, username: "p555", countryCode: "CR", tier: "eternal", isNew: true, cardKey: `${cardUserId}:v9` },
    ], NOW + 50);
    expect(forged.mints[0].cardKey).toBe(String(cardUserId));
    const forgedRow = (await exec(db, "select tier from pack_pull_events where owner_user_id = ?", [OTHER])).rows[0];
    expect(forgedRow.tier).toBeNull();
  });

  it("is rolled by the draw only inside the window, as a ready player from the slice who is not in the hand", async () => {
    const entries = Array.from({ length: 200 }, (_, index) => entry(100_000 + index + 1, index + 1));
    const makeDeps = (windowOpen: boolean, rolls: number[]): PackDrawDeps => {
      const queue = [...rolls];
      return {
        getPoolEntries: async () => entries,
        listOwnedCardKeys: async () => [],
        selectReadyUserIds: async (_db, ids) => [...ids],
        listEternalCards: async () => [],
        isFoilWindowOpen: async () => windowOpen,
        foilChance: 0.02,
        rng: () => (queue.length > 0 ? (queue.shift() as number) : 0.7),
      };
    };
    // Five hand rolls, the honorary miss, the Eternal miss, then the foil hit.
    const hit = [0.1, 0.2, 0.3, 0.4, 0.5, 0.9, 0.9, 0.01];
    const closed = await drawPackHand(db, { packType: "standard", ownerUserId: OWNER }, makeDeps(false, hit));
    expect(closed?.foilPull).toBeNull();
    const open = await drawPackHand(db, { packType: "standard", ownerUserId: OWNER }, makeDeps(true, hit));
    expect(open?.foilPull).not.toBeNull();
    expect(open?.players.some((slot) => slot.userId === open.foilPull?.user.id)).toBe(false);
    const miss = await drawPackHand(db, { packType: "standard", ownerUserId: OWNER }, makeDeps(true, [0.1, 0.2, 0.3, 0.4, 0.5, 0.9, 0.9, 0.5]));
    expect(miss?.foilPull).toBeNull();
  });
});
