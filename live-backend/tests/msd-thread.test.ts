import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { MsdThread, MsdThreadUnavailableError } from "../src/dan/msd-thread.js";
import { msdChartErrorFallback, type MsdOptions } from "../src/dan/msd.js";
import { calculateMsd } from "../src/dan/msd-calc.js";
import * as workerModule from "../src/module-worker.js";

const threads: MsdThread[] = [];
function makeThread(): MsdThread {
  const thread = new MsdThread();
  threads.push(thread);
  return thread;
}

afterEach(() => {
  for (const thread of threads.splice(0)) thread.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function chart(keys: number): string {
  const notes = Array.from({ length: 3000 }, (_, i) => {
    const x = Math.floor(((i % keys + 0.5) * 512) / keys);
    const time = 1000 + i * 60;
    return i % 3 === 0
      ? `${x},192,${time},128,0,${time + 100}:0:0:0:0:`
      : `${x},192,${time},1,0,0:0:0:0:`;
  });
  return ["osu file format v14", "[General]", "Mode: 3", "[Difficulty]", `CircleSize:${keys}`,
    "OverallDifficulty:8", "[TimingPoints]", "0,400,4,2,0,100,1,0", "[HitObjects]", ...notes].join("\n");
}

describe("MSD calculator thread", () => {
  it("preserves WASM results across concurrent keymodes, rates, goals and LN passes while timers run", async () => {
    const thread = makeThread();
    const options: MsdOptions[] = [
      { keyCount: 4 },
      { keyCount: 7, rate: 1.5, scoreGoal: 0.965 },
      { keyCount: 4, rate: 0.75, scoreGoal: 0.8, lnTailTaps: true },
      { keyCount: 7, lnTailTaps: true },
    ];
    const expected = [];
    for (const option of options) expected.push(await calculateMsd(chart(option.keyCount!), option));
    // Warm the worker so lazy loading cannot be the only source of a yield.
    for (const option of options) await thread.compute(chart(option.keyCount!), option);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const actual = await Promise.all(options.map((option) => thread.compute(chart(option.keyCount!), option)));
      expect(actual).toEqual(expected);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  }, 30_000);

  it("rejects active and queued calculations on a crash, then recovers after cooldown", async () => {
    vi.useFakeTimers();
    const worker = Object.assign(new EventEmitter(), {
      ref: vi.fn(), unref: vi.fn(), postMessage: vi.fn(), terminate: vi.fn().mockResolvedValue(1),
    });
    const spawn = vi.spyOn(workerModule, "createModuleWorker").mockReturnValue(worker as unknown as Worker);
    const thread = makeThread();
    const first = expect(thread.compute("first", {})).rejects.toBeInstanceOf(MsdThreadUnavailableError);
    const queued = expect(thread.compute("queued", {})).rejects.toBeInstanceOf(MsdThreadUnavailableError);
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.emit("error", new Error("worker crashed"));
    await Promise.all([first, queued]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    const resumed = thread.compute("resumed", {});
    await Promise.resolve();
    const request = worker.postMessage.mock.lastCall![0];
    worker.emit("message", { id: request.id, ok: true, result: { etternaVersion: "test", values: { Overall: 1 } } });
    await expect(resumed).resolves.toMatchObject({ values: { Overall: 1 } });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("times out a wedged calculation without replacing it with inline WASM", async () => {
    vi.useFakeTimers();
    const worker = Object.assign(new EventEmitter(), {
      ref: vi.fn(), unref: vi.fn(), postMessage: vi.fn(), terminate: vi.fn().mockResolvedValue(1),
    });
    vi.spyOn(workerModule, "createModuleWorker").mockReturnValue(worker as unknown as Worker);
    const thread = makeThread();
    const rejected = expect(thread.compute("wedged", {})).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps infrastructure failures retryable while retaining chart-error fallbacks", () => {
    expect(msdChartErrorFallback(new Error("invalid chart"))).toBeNull();
    expect(() => msdChartErrorFallback(new MsdThreadUnavailableError("worker crashed"))).toThrow("worker crashed");
  });
});
