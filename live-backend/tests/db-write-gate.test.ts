import { describe, expect, it } from "vitest";
import type { Client, ResultSet } from "@libsql/client";
import { checkWriteGateOverloaded, getWriteGateStats, withWriteGate, withWriteTurn, type Db } from "../src/db.js";

// A stub connection that records the order statements reach SQLite and can be
// held open per call, so the tests observe serialization directly instead of
// racing a real file lock.
function stubDb(log: string[]) {
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async (label: string, holdMs: number) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    log.push(label);
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
    inFlight -= 1;
    return { rows: [], rowsAffected: 0 } as unknown as ResultSet;
  };
  const client = {
    execute: (stmt: { sql: string } | string) => run(typeof stmt === "string" ? stmt : stmt.sql, 10),
    batch: (stmts: Array<{ sql: string }>) => run(`batch:${stmts.map((s) => s.sql).join(",")}`, 10).then((r) => [r]),
    close: () => {},
  } as unknown as Client;
  return { db: client as Db, maxInFlight: () => maxInFlight };
}

describe("serve-write gate", () => {
  it("runs concurrent statements one at a time, FIFO", async () => {
    const log: string[] = [];
    const stub = stubDb(log);
    const gated = withWriteGate(stub.db);
    await Promise.all([
      gated.execute({ sql: "a" }),
      gated.execute({ sql: "b" }),
      gated.execute({ sql: "c" }),
    ]);
    expect(log).toEqual(["a", "b", "c"]);
    expect(stub.maxInFlight()).toBe(1);
    const stats = getWriteGateStats(gated)!;
    expect(stats.gatedCalls).toBe(3);
    expect(stats.depth).toBe(0);
    expect(stats.peakDepth).toBe(3);
  });

  it("keeps a write turn's statements contiguous while others queue", async () => {
    const log: string[] = [];
    const gated = withWriteGate(stubDb(log).db);
    const turn = withWriteTurn(gated, async () => {
      await gated.execute({ sql: "turn-1" });
      // Yield so a queued outsider would jump in here if the turn leaked.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await gated.execute({ sql: "turn-2" });
    });
    const outsider = gated.execute({ sql: "outsider" });
    await Promise.all([turn, outsider]);
    expect(log).toEqual(["turn-1", "turn-2", "outsider"]);
  });

  it("is reentrant: a nested turn on the held gate just runs", async () => {
    const log: string[] = [];
    const gated = withWriteGate(stubDb(log).db);
    await withWriteTurn(gated, async () => {
      await withWriteTurn(gated, () => gated.execute({ sql: "nested" }));
    });
    expect(log).toEqual(["nested"]);
    expect(getWriteGateStats(gated)!.depth).toBe(0);
  });

  it("releases the turn when its body throws", async () => {
    const log: string[] = [];
    const gated = withWriteGate(stubDb(log).db);
    await expect(withWriteTurn(gated, async () => {
      await gated.execute({ sql: "before-throw" });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await gated.execute({ sql: "after" });
    expect(log).toEqual(["before-throw", "after"]);
    expect(getWriteGateStats(gated)!.depth).toBe(0);
  });

  it("is a plain call on an ungated db", async () => {
    const log: string[] = [];
    const { db } = stubDb(log);
    await withWriteTurn(db, () => db.execute({ sql: "plain" }));
    expect(log).toEqual(["plain"]);
    expect(getWriteGateStats(db)).toBeNull();
    expect(checkWriteGateOverloaded(db)).toBeNull();
  });

  it("sheds only past the depth threshold and counts it", async () => {
    const log: string[] = [];
    const gated = withWriteGate(stubDb(log).db);
    expect(checkWriteGateOverloaded(gated)).toBeNull();
    // Pile up nine writers (threshold is depth >= 8) and check mid-flight.
    const pending = Array.from({ length: 9 }, (_, index) => gated.execute({ sql: `q${index}` }));
    const shed = checkWriteGateOverloaded(gated);
    expect(shed).not.toBeNull();
    expect(shed!.retryAfterMs).toBeGreaterThan(0);
    await Promise.all(pending);
    // Drained: a fresh check passes even though the wait EWMA is warm.
    expect(checkWriteGateOverloaded(gated)).toBeNull();
    expect(getWriteGateStats(gated)!.sheds).toBe(1);
  });
});
