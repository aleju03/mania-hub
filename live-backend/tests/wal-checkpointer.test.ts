import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, type Db } from "../src/db.js";
import { runWalTruncateCheckpoint } from "../src/wal-checkpointer.js";

// Regression for the 2026-07-07 WAL death-spiral: nothing under normal load ever
// forced a WAL reset, so the -wal file grew unbounded until reads spiraled. The
// checkpointer's core is a PASSIVE-then-TRUNCATE that must reset a grown WAL.
describe("wal checkpointer", () => {
  let dir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-wal-"));
    dbPath = join(dir, "test.db");
    db = await createDb({ databaseUrl: `file:${dbPath}` });
    // migrate() is where prod enables WAL; this test doesn't run it, so set it here.
    await exec(db, "pragma journal_mode = WAL");
    // Disable auto-checkpoint so the WAL grows monotonically with our writes,
    // making the "grown then reset" assertion deterministic.
    await exec(db, "pragma wal_autocheckpoint = 0");
    await exec(db, "create table t (id integer primary key, blob text)");
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function walBytes(): Promise<number> {
    try {
      return (await stat(`${dbPath}-wal`)).size;
    } catch {
      return 0;
    }
  }

  it("TRUNCATE checkpoint resets a grown WAL when no reader pins it", async () => {
    const blob = "x".repeat(8192);
    for (let i = 0; i < 2000; i += 1) {
      await exec(db, "insert into t (blob) values (?)", [blob]);
    }
    const grown = await walBytes();
    expect(grown).toBeGreaterThan(1024 * 1024); // WAL accumulated many frames

    // A separate connection (like the worker's dedicated checkpointer) with
    // busy_timeout=0 resets the WAL the writer produced.
    const checkpointer = await createDb({ databaseUrl: `file:${dbPath}`, sqliteBusyTimeoutMs: 0, sqliteCacheMb: 2, sqliteMmapMb: 0 });
    const result = await runWalTruncateCheckpoint(checkpointer);
    checkpointer.close();

    expect(result.busy).toBe(0); // no active reader -> full reset
    const after = await walBytes();
    expect(after).toBeLessThan(grown);
    expect(after).toBeLessThan(64 * 1024); // truncated back to ~empty
  });

  it("reports busy != 0 (does not fully reset) while another connection holds an open read", async () => {
    const blob = "y".repeat(8192);
    for (let i = 0; i < 500; i += 1) {
      await exec(db, "insert into t (blob) values (?)", [blob]);
    }
    // Hold an explicit read transaction on a second connection so the checkpoint
    // cannot advance past its snapshot — the exact condition that defeated resets
    // in the incident. The checkpointer (busy_timeout=0) must return busy=1 fast,
    // not block.
    const reader = await createDb({ databaseUrl: `file:${dbPath}` });
    await exec(reader, "begin");
    await exec(reader, "select count(*) from t");

    const checkpointer = await createDb({ databaseUrl: `file:${dbPath}`, sqliteBusyTimeoutMs: 0, sqliteCacheMb: 2, sqliteMmapMb: 0 });
    const started = Date.now();
    const result = await runWalTruncateCheckpoint(checkpointer);
    const elapsed = Date.now() - started;
    await exec(reader, "commit");
    checkpointer.close();
    reader.close();

    expect(result.busy).toBe(1); // reader pinned it -> could not fully truncate
    expect(elapsed).toBeLessThan(1000); // busy_timeout=0 -> returns promptly, never a long block
  });
});
