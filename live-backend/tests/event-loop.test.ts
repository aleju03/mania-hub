import { afterEach, describe, expect, it } from "vitest";
import { eventLoopStatus, startEventLoopMonitor, stopEventLoopMonitor } from "../src/shared/event-loop.js";

afterEach(() => {
  stopEventLoopMonitor();
});

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Synchronous spin: the same shape as a libsql query or a JSON.parse
    // holding the thread.
  }
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("event loop monitor", () => {
  it("reports null until started", () => {
    expect(eventLoopStatus()).toBeNull();
  });

  it("records a synchronous stall with its length and keeps ordinary ticks out", async () => {
    startEventLoopMonitor("test", { heartbeatMs: 10, stallThresholdMs: 60, logThresholdMs: 10_000 });
    await settle(60);
    expect(eventLoopStatus()?.stalls.sinceStart.count).toBe(0);

    blockFor(150);
    await settle(40);

    const status = eventLoopStatus();
    expect(status).not.toBeNull();
    expect(status!.role).toBe("test");
    expect(status!.stalls.sinceStart.count).toBe(1);
    expect(status!.stalls.lastHour.count).toBe(1);
    expect(status!.stalls.recent).toHaveLength(1);
    // The heartbeat was due at most 10ms into the block, so the recorded
    // lateness is the block minus one interval, never more than the block.
    expect(status!.stalls.recent[0].ms).toBeGreaterThanOrEqual(120);
    expect(status!.stalls.recent[0].ms).toBeLessThanOrEqual(200);
    expect(status!.stalls.sinceStart.maxMs).toBe(status!.stalls.recent[0].ms);
    expect(status!.lastMinute?.maxMs).toBeGreaterThanOrEqual(100);
  });

  it("is idempotent and stops cleanly", async () => {
    startEventLoopMonitor("test", { heartbeatMs: 10, stallThresholdMs: 60, logThresholdMs: 10_000 });
    startEventLoopMonitor("other");
    expect(eventLoopStatus()?.role).toBe("test");
    stopEventLoopMonitor();
    expect(eventLoopStatus()).toBeNull();
  });
});
