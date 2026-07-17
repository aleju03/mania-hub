import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  getPackWallet,
  listPackCollectionCards,
  listPackCollectionOwnedUserIds,
  recyclePackCollectionCards,
  savePackWallet,
} from "../src/features/pack-wallets.js";

let dir = "";
let db: Db;

const USER_ID = 14600698;

function cardPayload(copies: number, recycledCopies = 0): string {
  return JSON.stringify({
    cards: {
      "42": {
        userId: 42,
        username: "delta",
        avatarUrl: "https://a.ppy.sh/42",
        countryCode: "CR",
        tier: "rare",
        tierLabel: "Rare",
        skills: null,
        pp: 1234,
        globalRank: 5678,
        copies,
        recycledCopies,
        firstPulledAt: 100,
        lastPulledAt: 200,
      },
    },
    shards: 0,
    shardsSpent: 0,
    charges: 5,
    lastRefillAt: 1000,
    openedPacks: 1,
    poolTotal: null,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-pack-wallets-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("pack wallets", () => {
  it("returns null for a user without a wallet", async () => {
    expect(await getPackWallet(db, USER_ID)).toBeNull();
  });

  it("creates a wallet at rev 1 and bumps the rev on matching saves", async () => {
    const first = await savePackWallet(db, USER_ID, '{"shards":0}', 0, 1000);
    expect(first).toEqual({ ok: true, rev: 1 });

    const second = await savePackWallet(db, USER_ID, '{"shards":5}', 1, 2000);
    expect(second).toEqual({ ok: true, rev: 2 });

    const stored = await getPackWallet(db, USER_ID);
    expect(stored).toEqual({ payload: '{"shards":5}', rev: 2, updatedAt: 2000 });
  });

  it("rejects a stale base rev with the current wallet so the client can reconcile", async () => {
    await savePackWallet(db, USER_ID, '{"shards":0}', 0, 1000);
    await savePackWallet(db, USER_ID, '{"shards":5}', 1, 2000);

    const stale = await savePackWallet(db, USER_ID, '{"shards":1}', 1, 3000);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.current.payload).toBe('{"shards":5}');
      expect(stale.current.rev).toBe(2);
    }
    // The stale write must not have clobbered anything.
    expect((await getPackWallet(db, USER_ID))?.payload).toBe('{"shards":5}');
  });

  it("keeps wallets per user", async () => {
    await savePackWallet(db, USER_ID, '{"shards":1}', 0, 1000);
    await savePackWallet(db, 777, '{"shards":2}', 0, 1000);
    expect((await getPackWallet(db, USER_ID))?.payload).toBe('{"shards":1}');
    expect((await getPackWallet(db, 777))?.payload).toBe('{"shards":2}');
  });

  it("strips imported cards from the wallet blob and lists them from card rows", async () => {
    const saved = await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    expect(saved).toEqual({ ok: true, rev: 1 });

    const wallet = await getPackWallet(db, USER_ID);
    expect(wallet?.payload).toContain('"cards":{}');

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.total).toBe(1);
    expect(page.cards[0]).toMatchObject({ userId: 42, username: "delta", copies: 2, recycledCopies: 0 });
    expect(await listPackCollectionOwnedUserIds(db, USER_ID)).toEqual([42]);
  });

  it("treats full wallet imports as snapshots and post-strip imports as deltas", async () => {
    await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    await savePackWallet(db, USER_ID, cardPayload(1), 1, 2000, "snapshot");
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0].copies).toBe(2);

    await savePackWallet(db, USER_ID, cardPayload(1), 2, 3000, "delta");
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).cards[0].copies).toBe(3);
  });

  it("overlays the current identity from users onto listed cards", async () => {
    await savePackWallet(db, USER_ID, cardPayload(1), 0, 1000);
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, ?, ?)",
      [42, "delta_renamed", "https://a.ppy.sh/42?999", "ES", new Date(2000).toISOString()],
    );

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.cards[0]).toMatchObject({
      userId: 42,
      username: "delta_renamed",
      avatarUrl: "https://a.ppy.sh/42?999",
      countryCode: "ES",
      // The pull snapshot stays authoritative for everything non-identity.
      pp: 1234,
      copies: 1,
    });

    // Search matches the displayed (current) name, not the pull-time one.
    const byCurrentName = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15, query: "renamed" });
    expect(byCurrentName.total).toBe(1);
    const byOldName = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15, query: "delta" });
    expect(byOldName.total).toBe(1);
  });

  it("keeps the stored identity for cards without a users row", async () => {
    await savePackWallet(db, USER_ID, cardPayload(1), 0, 1000);
    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.cards[0]).toMatchObject({ username: "delta", avatarUrl: "https://a.ppy.sh/42", countryCode: "CR" });
  });

  it("recycles by the same display name the listing filters on", async () => {
    await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, ?, ?)",
      [42, "delta_renamed", "https://a.ppy.sh/42?999", "ES", new Date(2000).toISOString()],
    );

    const result = await recyclePackCollectionCards(db, USER_ID, { mode: "whole_matching", query: "renamed" }, 3000);
    expect(result.gained).toBe(4);
    expect((await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 })).total).toBe(0);
  });

  it("does not import card rows from stale wallet revisions", async () => {
    await savePackWallet(db, USER_ID, cardPayload(2), 0, 1000);
    await savePackWallet(db, USER_ID, '{"shards":5}', 1, 2000);

    const stale = await savePackWallet(db, USER_ID, cardPayload(10), 1, 3000, "delta");
    expect(stale.ok).toBe(false);

    const page = await listPackCollectionCards(db, USER_ID, { page: 0, pageSize: 15 });
    expect(page.cards[0].copies).toBe(2);
  });
});
