// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const { track, initializeAnalyticsEntry } = vi.hoisted(() => ({ track: vi.fn(), initializeAnalyticsEntry: vi.fn() }));
vi.mock("./analytics", () => ({ track, initializeAnalyticsEntry }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.clearAllMocks(); });

it("records successful document timings and bounded browser errors without installing twice", async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const listeners = new Map<string, (event: unknown) => void>();
  vi.spyOn(window, "addEventListener").mockImplementation((type, handler) => {
    listeners.set(type, handler as (event: unknown) => void);
  });
  Object.defineProperty(performance, "getEntriesByType", {
    value: vi.fn(() => [{ startTime: 0, loadEventEnd: 1250 }]), configurable: true,
  });
  const { installAnalyticsReliability } = await import("./analytics-reliability");
  installAnalyticsReliability();
  installAnalyticsReliability();
  expect(initializeAnalyticsEntry).toHaveBeenCalledTimes(1);
  listeners.get("load")?.({});
  await vi.advanceTimersByTimeAsync(1);
  expect(track).toHaveBeenCalledWith("page_load_result", expect.objectContaining({ success: true, duration_ms: 1250 }));
  track.mockClear();
  for (let n = 0; n < 10; n++) listeners.get("error")?.({ message: "same", error: new Error("same") });
  expect(track).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 10; n++) listeners.get("unhandledrejection")?.({ reason: new Error(`failure ${n}`) });
  expect(track).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(60_000);
  listeners.get("error")?.({ message: "same", error: new Error("same") });
  expect(track).toHaveBeenCalledTimes(6);
});
