import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import { getPackWallet, savePackWallet } from "../src/features/pack-wallets.js";

let dir = "";
let db: Db;

const USER_ID = 14600698;

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
});
