import { describe, expect, it } from "vitest";
import { readProcessMemory, startPeakMemorySampler } from "../src/shared/process-memory.js";

describe("readProcessMemory", () => {
  it("reports this process's counters", () => {
    const sample = readProcessMemory("all");

    expect(sample.pid).toBe(process.pid);
    expect(sample.role).toBe("all");
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.heapUsedBytes).toBeGreaterThan(0);
    expect(sample.heapTotalBytes).toBeGreaterThanOrEqual(sample.heapUsedBytes);
    expect(sample.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(Date.parse(sample.at)).not.toBeNaN();
    // Lifetime high-water mark, so it can never sit under the current RSS.
    expect(sample.peakRssBytes).not.toBeNull();
    expect(sample.peakRssBytes ?? 0).toBeGreaterThanOrEqual(sample.rssBytes);
    // The heap/rss distinction has to travel with the numbers or they mislead.
    expect(sample.hint).toContain("per-isolate");
  });
});

describe("startPeakMemorySampler", () => {
  it("records a peak that covers an allocation made while it ran", async () => {
    const sampler = startPeakMemorySampler();
    // Tens of MB, held alive past stop() so no GC can retire it before the
    // final read: the peak must reflect it however the collector behaves.
    const ballast = Array.from({ length: 2_000_000 }, (_, index) => index);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const observedHeapUsed = process.memoryUsage().heapUsed;

    const metric = sampler.stop(true);
    expect(ballast.length).toBe(2_000_000);

    expect(metric.ok).toBe(true);
    expect(metric.error).toBeNull();
    expect(metric.pid).toBe(process.pid);
    expect(metric.durationMs).toBeGreaterThanOrEqual(700);
    // start + at least one interval tick + the final read.
    expect(metric.samples).toBeGreaterThanOrEqual(3);
    expect(metric.peakHeapUsedBytes).toBeGreaterThanOrEqual(observedHeapUsed);
    expect(metric.peakRssBytes).toBeGreaterThanOrEqual(metric.startRssBytes);
    expect(metric.processPeakRssBytes ?? 0).toBeGreaterThanOrEqual(metric.peakRssBytes);
  });

  it("captures the failure and stays stoppable more than once", () => {
    const sampler = startPeakMemorySampler();
    const metric = sampler.stop(false, new Error("refresh blew up"));

    expect(metric.ok).toBe(false);
    expect(metric.error).toBe("refresh blew up");
    // Stopping twice must not throw or restart anything: the timer is already
    // cleared, and a caller in a catch block after a finally is a real shape.
    expect(sampler.stop(false).ok).toBe(false);
  });
});
