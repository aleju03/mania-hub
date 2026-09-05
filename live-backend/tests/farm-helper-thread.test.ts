import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { createModuleWorker } from "../src/module-worker.js";
import type { FarmHelperBuildInput, FarmHelperBuildResult } from "../src/features/farm-helper.js";
import { FarmHelperBuildError, FarmHelperBuildThread, type FarmHelperThreadRequest } from "../src/features/farm-helper-thread.js";

vi.mock("../src/module-worker.js", () => ({ createModuleWorker: vi.fn() }));

class FakeWorker extends EventEmitter {
  postMessage = vi.fn<(request: FarmHelperThreadRequest) => void>();
  ref = vi.fn();
  unref = vi.fn();
  terminate = vi.fn(async () => 0);
}

let thread: FarmHelperBuildThread;
let worker: FakeWorker;
const input = {} as FarmHelperBuildInput;
const db = {} as Db;
const result = { snapshot: { recs: [] } } as unknown as FarmHelperBuildResult;

beforeEach(() => {
  vi.useFakeTimers();
  worker = new FakeWorker();
  vi.mocked(createModuleWorker).mockReset().mockReturnValue(worker as unknown as Worker);
  thread = new FarmHelperBuildThread({ databaseUrl: "file:/tmp/unused-farm-thread-test.db" });
});

afterEach(async () => {
  await thread.close();
  vi.useRealTimers();
});

function finish(id: number): void {
  worker.emit("message", { kind: "result", id, result, timings: { durations: [], counters: [] } });
}

describe("farm helper thread admission and recovery", () => {
  it("bounds pending builds and posts only one at a time", async () => {
    const requests = Array.from({ length: 8 }, () => thread.build(input, db));
    await expect(thread.build(input, db)).rejects.toBeInstanceOf(FarmHelperBuildError);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(thread.status()).toMatchObject({ inFlight: 1, queued: 7, rejected: 1 });
    for (let id = 1; id <= 8; id++) {
      finish(id);
      expect(worker.postMessage).toHaveBeenCalledTimes(Math.min(8, id + 1));
    }
    await expect(Promise.all(requests)).resolves.toHaveLength(8);
    expect(thread.status()).toMatchObject({ inFlight: 0, queued: 0, completed: 8 });
  });

  it("rejects active and queued builds on a timeout and waits through cooldown before respawning", async () => {
    const requests = [thread.build(input, db), thread.build(input, db)];
    const settled = Promise.allSettled(requests);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await settled).every((entry) => entry.status === "rejected" && entry.reason instanceof FarmHelperBuildError)).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(thread.build(input, db)).rejects.toBeInstanceOf(FarmHelperBuildError);
    await vi.advanceTimersByTimeAsync(30_000);
    worker = new FakeWorker();
    vi.mocked(createModuleWorker).mockReturnValue(worker as unknown as Worker);
    const retry = thread.build(input, db);
    finish(3);
    await expect(retry).resolves.toEqual(result);
  });

  it.each(["error", "exit"])("turns worker %s into a retryable error for every waiter", async (event) => {
    const settled = Promise.allSettled([thread.build(input, db), thread.build(input, db)]);
    worker.emit(event, event === "exit" ? 1 : new Error("crash"));
    expect((await settled).every((entry) => entry.status === "rejected" && entry.reason instanceof FarmHelperBuildError)).toBe(true);
    expect(thread.status()).toMatchObject({ spawned: false, failed: 2 });
  });

  it("treats spawn failures as retryable too", async () => {
    vi.mocked(createModuleWorker).mockImplementation(() => { throw new Error("cannot spawn"); });
    await expect(thread.build(input, db)).rejects.toBeInstanceOf(FarmHelperBuildError);
    expect(thread.status().spawned).toBe(false);
  });

  it("rejects a failed build without poisoning the next queued build", async () => {
    const first = thread.build(input, db);
    const rejection = expect(first).rejects.toBeInstanceOf(FarmHelperBuildError);
    const second = thread.build(input, db);
    worker.emit("message", { kind: "error", id: 1, error: "read failed" });
    await rejection;
    finish(2);
    await expect(second).resolves.toEqual(result);
  });

  it("acknowledges detached derived writes even after their snapshot completed", async () => {
    let finishWrite!: () => void;
    const writer = { execute: () => new Promise<void>((resolve) => { finishWrite = resolve; }) } as unknown as Db;
    const build = thread.build(input, writer);
    worker.emit("message", { kind: "write", id: 1, writeId: 99, statement: { sql: "insert into live_meta values (?, ?, ?)", args: [] } });
    finish(1);
    await build;
    finishWrite();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ kind: "write-result", id: 1, writeId: 99 });
  });

  it("passes cache invalidation to the next build, including already queued work", async () => {
    const first = thread.build(input, db);
    const second = thread.build(input, db);
    thread.invalidateCaches();
    finish(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2, generation: 1 }));
    finish(2);
    await Promise.all([first, second]);
  });
});
