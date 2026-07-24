import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __fullArchiveQueueLimitsForTest as LIMITS,
  __getFullArchiveStateForTest,
  __resetFullArchiveQueueForTest,
  __withFullArchiveSlotForTest,
} from "../src/audio/beatmap-archive.js";

// The two full-archive slots sit behind public /api/audio and /api/hitsounds
// requests, so the queue in front of them is what has to stay bounded: these
// tests drive the gate directly instead of through fetch mocks.

type Gate = { promise: Promise<void>; open: () => void };

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// Fake timers are installed, so settle pending microtasks by stepping the clock
// by zero rather than by waiting on a real timeout.
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("full archive queue limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFullArchiveQueueForTest();
  });

  afterEach(() => {
    __resetFullArchiveQueueForTest();
    vi.useRealTimers();
  });

  it("sheds a request instead of queueing it once the wait queue is full", async () => {
    const gates = Array.from({ length: LIMITS.maxConcurrent + LIMITS.maxWaiters }, gate);
    const runs = gates.map((entry) => __withFullArchiveSlotForTest(() => entry.promise));
    await settle();
    expect(__getFullArchiveStateForTest()).toMatchObject({
      active: LIMITS.maxConcurrent,
      waiting: LIMITS.maxWaiters,
    });

    let ran = false;
    const shed = __withFullArchiveSlotForTest(async () => {
      ran = true;
    });
    await expect(shed).rejects.toThrow(/too many archive downloads are queued/);
    // The shed caller never joined the queue and never reached a mirror.
    expect(ran).toBe(false);
    expect(__getFullArchiveStateForTest().waiting).toBe(LIMITS.maxWaiters);

    for (const entry of gates) entry.open();
    await Promise.all(runs);
    expect(__getFullArchiveStateForTest()).toEqual({ inFlight: 0, active: 0, waiting: 0 });
  });

  it("drops a waiter that has been queued for a whole mirror budget", async () => {
    const running = [gate(), gate()];
    const active = running.map((entry) => __withFullArchiveSlotForTest(() => entry.promise));
    await settle();

    let ran = false;
    const queued = __withFullArchiveSlotForTest(async () => {
      ran = true;
    });
    await settle();
    expect(__getFullArchiveStateForTest().waiting).toBe(1);

    const rejection = expect(queued).rejects.toThrow(/timed out waiting for an archive download slot/);
    await vi.advanceTimersByTimeAsync(LIMITS.queueTimeoutMs);
    await rejection;
    expect(ran).toBe(false);
    // Expiring removes the waiter from the queue rather than leaving a dead
    // entry behind: the freed slot goes back to the counter, not to a caller
    // whose client is long gone.
    expect(__getFullArchiveStateForTest().waiting).toBe(0);

    running[0].open();
    await settle();
    expect(__getFullArchiveStateForTest()).toMatchObject({ active: 1, waiting: 0 });

    running[1].open();
    await Promise.all(active);
    expect(__getFullArchiveStateForTest()).toEqual({ inFlight: 0, active: 0, waiting: 0 });
  });

  it("still serves a waiter that arrives after an expired one", async () => {
    const running = [gate(), gate()];
    const active = running.map((entry) => __withFullArchiveSlotForTest(() => entry.promise));
    await settle();

    const expired = __withFullArchiveSlotForTest(async () => "stale");
    const rejection = expect(expired).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(LIMITS.queueTimeoutMs);
    await rejection;

    const fresh = __withFullArchiveSlotForTest(async () => "served");
    await settle();
    expect(__getFullArchiveStateForTest().waiting).toBe(1);

    running[0].open();
    await expect(fresh).resolves.toBe("served");

    running[1].open();
    await Promise.all(active);
    expect(__getFullArchiveStateForTest()).toEqual({ inFlight: 0, active: 0, waiting: 0 });
  });
});
