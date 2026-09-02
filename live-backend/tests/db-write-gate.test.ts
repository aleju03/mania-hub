import { describe, expect, it } from "vitest";
import { checkWriteGateOverloaded, getWriteGateStats, withWriteTurn, type Db } from "../src/db.js";
import { createCoalescedDb, serializeResultSet, WriteCoalescer, type GroupOutcome, type WriteGroup } from "../src/write-coalescer.js";

// A stub executor that records every flush it receives (as the list of group
// labels) and can be held open per flush, so the tests observe batching and
// serialization directly instead of racing a real file lock.
function stubExecutor(flushes: string[][], holdMs = 10) {
  let inFlight = 0;
  let maxInFlight = 0;
  const executor = async (groups: WriteGroup[]): Promise<GroupOutcome[]> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    flushes.push(groups.map((group) => group.statements.map((statement) => statement.sql).join("+")));
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
    inFlight -= 1;
    return groups.map((group) => ({
      ok: true,
      results: group.statements.map(() => serializeResultSet({ columns: [], columnTypes: [], rows: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => null })),
    }));
  };
  return { executor, maxInFlight: () => maxInFlight };
}

function coalesced(flushes: string[][], holdMs?: number): { db: Db; maxInFlight: () => number } {
  const stub = stubExecutor(flushes, holdMs);
  return { db: createCoalescedDb(new WriteCoalescer(stub.executor)), maxInFlight: stub.maxInFlight };
}

describe("serve-write coalescer", () => {
  it("merges a burst into one flush, in order, with one executor call at a time", async () => {
    const flushes: string[][] = [];
    const { db, maxInFlight } = coalesced(flushes);
    await Promise.all([
      db.execute({ sql: "a" }),
      db.execute({ sql: "b" }),
      db.batch([{ sql: "c1" }, { sql: "c2" }], "write"),
    ]);
    expect(flushes).toEqual([["a", "b", "c1+c2"]]);
    expect(maxInFlight()).toBe(1);
    const stats = getWriteGateStats(db)!;
    expect(stats.gatedCalls).toBe(3);
    expect(stats.depth).toBe(0);
    expect(stats.peakDepth).toBe(3);
    expect(stats.flushes).toBe(1);
    expect(stats.groupsFlushed).toBe(3);
  });

  it("batches while busy: writes that arrive mid-flush ride the next one together", async () => {
    const flushes: string[][] = [];
    const { db } = coalesced(flushes, 20);
    const first = db.execute({ sql: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = Promise.all([db.execute({ sql: "x" }), db.execute({ sql: "y" })]);
    await Promise.all([first, later]);
    expect(flushes).toEqual([["first"], ["x", "y"]]);
  });

  it("keeps a write turn's statements contiguous and immediate while others queue", async () => {
    const flushes: string[][] = [];
    const { db } = coalesced(flushes);
    const turn = withWriteTurn(db, async () => {
      await db.execute({ sql: "turn-1" });
      // Yield so a queued outsider would jump in here if the turn leaked.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await db.execute({ sql: "turn-2" });
    });
    const outsider = db.execute({ sql: "outsider" });
    await Promise.all([turn, outsider]);
    expect(flushes).toEqual([["turn-1"], ["turn-2"], ["outsider"]]);
  });

  it("is reentrant: a nested turn on the held connection just runs", async () => {
    const flushes: string[][] = [];
    const { db } = coalesced(flushes);
    await withWriteTurn(db, async () => {
      await withWriteTurn(db, () => db.execute({ sql: "nested" }));
    });
    expect(flushes).toEqual([["nested"]]);
    expect(getWriteGateStats(db)!.depth).toBe(0);
  });

  it("releases the turn when its body throws", async () => {
    const flushes: string[][] = [];
    const { db } = coalesced(flushes);
    await expect(withWriteTurn(db, async () => {
      await db.execute({ sql: "before-throw" });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await db.execute({ sql: "after" });
    expect(flushes).toEqual([["before-throw"], ["after"]]);
    expect(getWriteGateStats(db)!.depth).toBe(0);
  });

  it("is a plain call on a plain db", async () => {
    const log: string[] = [];
    const db = {
      execute: async (stmt: { sql: string }) => {
        log.push(stmt.sql);
        return { rows: [], rowsAffected: 0 };
      },
    } as unknown as Db;
    await withWriteTurn(db, () => db.execute({ sql: "plain" }));
    expect(log).toEqual(["plain"]);
    expect(getWriteGateStats(db)).toBeNull();
    expect(checkWriteGateOverloaded(db)).toBeNull();
  });

  it("sheds only past the depth threshold and counts it", async () => {
    const flushes: string[][] = [];
    const { db } = coalesced(flushes);
    expect(checkWriteGateOverloaded(db)).toBeNull();
    // Pile up nine writers (threshold is depth >= 8) and check mid-flight.
    const pending = Array.from({ length: 9 }, (_, index) => db.execute({ sql: `q${index}` }));
    const shed = checkWriteGateOverloaded(db);
    expect(shed).not.toBeNull();
    expect(shed!.retryAfterMs).toBeGreaterThan(0);
    await Promise.all(pending);
    // Drained: a fresh check passes even though the wait EWMA is warm.
    expect(checkWriteGateOverloaded(db)).toBeNull();
    expect(getWriteGateStats(db)!.sheds).toBe(1);
  });

  it("delivers each group its own outcome, errors included", async () => {
    const executor = async (groups: WriteGroup[]): Promise<GroupOutcome[]> => groups.map((group) =>
      group.statements[0].sql === "bad"
        ? { ok: false, error: { message: "SQLITE_CONSTRAINT: no", code: "SQLITE_CONSTRAINT" } }
        : { ok: true, results: [serializeResultSet({ columns: ["n"], columnTypes: [], rows: [{ n: 1, 0: 1, length: 1 } as never], rowsAffected: 1, lastInsertRowid: 7n, toJSON: () => null })] });
    const db = createCoalescedDb(new WriteCoalescer(executor));
    const [good, bad] = await Promise.allSettled([db.execute("good"), db.execute("bad")]);
    expect(good.status).toBe("fulfilled");
    if (good.status === "fulfilled") {
      expect(good.value.rowsAffected).toBe(1);
      expect(good.value.lastInsertRowid).toBe(7n);
      expect(good.value.rows[0].n).toBe(1);
      expect(good.value.rows[0][0]).toBe(1);
      expect(good.value.rows[0].length).toBe(1);
    }
    expect(bad.status).toBe("rejected");
    if (bad.status === "rejected") expect(String(bad.reason.message)).toContain("SQLITE_CONSTRAINT");
  });

  it("refuses transaction control instead of merging it into a flush", async () => {
    const flushes: string[][] = [];
    const { db } = coalesced(flushes);
    await expect(db.execute("rollback")).rejects.toThrow(/transaction control/);
    expect(flushes).toEqual([]);
  });
});
