import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModuleWorker } from "../src/module-worker.js";
import { ServingReadError, ServingReadThread } from "../src/serving-read-thread.js";
import { ReadCache } from "../src/shared/read-cache.js";

vi.mock("../src/module-worker.js", () => ({ createModuleWorker: vi.fn() }));
class FakeWorker extends EventEmitter {
  postMessage = vi.fn();
  ref = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(async () => 0);
}
let worker: FakeWorker;
let thread: ServingReadThread;
const request = { kind: "metrics", userIds: [1], now: 100 } as const;
const read = () => thread.run({ ...request, userIds: [...request.userIds] });
function finish(id: number) { worker.emit("message", { id, json: new TextEncoder().encode('{}') }); }
beforeEach(() => {
  vi.useFakeTimers();
  worker = new FakeWorker();
  vi.mocked(createModuleWorker).mockReset().mockReturnValue(worker as unknown as Worker);
  thread = new ServingReadThread({ databaseUrl: "file:/tmp/unused-reader.db" });
});
afterEach(async () => { await thread.close(); vi.useRealTimers(); });

describe("serving read admission and recovery", () => {
  it("bounds queued work and dispatches one read at a time", async () => {
    const reads = Array.from({ length: 16 }, read);
    await expect(read()).rejects.toBeInstanceOf(ServingReadError);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    for (let id = 1; id <= 16; id++) finish(id);
    await expect(Promise.all(reads)).resolves.toHaveLength(16);
    expect(worker.postMessage).toHaveBeenCalledTimes(16);
  });
  it("fails every waiter on timeout and permits a fresh worker after cooldown", async () => {
    const settled = Promise.allSettled([read(), read()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await settled).every((r) => r.status === "rejected" && r.reason instanceof ServingReadError)).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(read()).rejects.toBeInstanceOf(ServingReadError);
    await vi.advanceTimersByTimeAsync(30_000);
    const retry = read();
    finish(3);
    await expect(retry).resolves.toEqual({});
  });
  it.each(["error", "exit"])("rejects all waiters after a worker %s", async (event) => {
    const settled = Promise.allSettled([read(), read()]);
    worker.emit(event, event === "exit" ? 1 : new Error("crash"));
    expect((await settled).every((r) => r.status === "rejected")).toBe(true);
  });
  it("does not poison later reads when a query fails", async () => {
    const first = expect(read()).rejects.toThrow("query failed");
    const second = read();
    worker.emit("message", { id: 1, error: "query failed" });
    finish(2);
    await first;
    await expect(second).resolves.toEqual({});
  });
  it("rejects a spawn failure without executing inline", async () => {
    vi.mocked(createModuleWorker).mockImplementation(() => { throw new Error("spawn failed"); });
    await expect(read()).rejects.toThrow("spawn failed");
  });
});

describe("read cache", () => {
  it("coalesces slow reads beyond the TTL and starts freshness at completion", async () => {
    const cache = new ReadCache<number>(5_000, 2);
    let resolve!: (n: number) => void;
    const produce = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const first = cache.get("CR", produce);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cache.get("CR", produce)).toBe(first);
    resolve(42);
    await first;
    expect(await cache.get("CR", produce)).toBe(42);
    expect(produce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await cache.get("CR", async () => 43)).toBe(43);
  });
  it("evicts failures and refuses excess work without evicting pending reads", async () => {
    const cache = new ReadCache<number>(5_000, 1);
    let reject!: (error: Error) => void;
    const first = cache.get("CR", () => new Promise<number>((_, fail) => { reject = fail; }));
    const failure = expect(first).rejects.toThrow("failed");
    await expect(cache.get("CN", async () => 2)).rejects.toThrow("busy");
    reject(new Error("failed"));
    await failure;
    expect(await cache.get("CR", async () => 3)).toBe(3);
  });
});
