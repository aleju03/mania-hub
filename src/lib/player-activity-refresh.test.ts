// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshPlayerActivitySnapshot } from "./player-activity-refresh";
import type { LivePlayerActivitySnapshot } from "./live-backend";

const snapshot = (refreshPending?: boolean) => ({ refreshPending, days: [] }) as unknown as LivePlayerActivitySnapshot;

describe("activity repair refresh", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => {
    stop?.();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function start(load: () => Promise<LivePlayerActivitySnapshot>) {
    const callbacks = { load, onSnapshot: vi.fn(), onInitialError: vi.fn(), onInitialSettled: vi.fn() };
    stop = refreshPlayerActivitySnapshot(callbacks);
    return callbacks;
  }

  it("does not poll a ready snapshot, including older backend responses without the flag", async () => {
    const load = vi.fn().mockResolvedValue(snapshot());
    const callbacks = start(load);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(callbacks.onInitialSettled).toHaveBeenCalledTimes(1);
  });

  it("refreshes a pending calendar until repaired, preserving it through a transient failure", async () => {
    const load = vi.fn().mockResolvedValueOnce(snapshot(true))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot(false));
    const callbacks = start(load);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(callbacks.onInitialError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(callbacks.onSnapshot).toHaveBeenCalledTimes(2);
    expect(callbacks.onInitialSettled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("pauses in hidden tabs and resumes pending repair when visible", async () => {
    const load = vi.fn().mockResolvedValue(snapshot(true));
    start(load);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds retries when the repair cannot finish", async () => {
    const load = vi.fn().mockResolvedValue(snapshot(true));
    start(load);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(load).toHaveBeenCalledTimes(11);
  });

  it("ignores late responses after unmount or changing player/year", async () => {
    let resolve!: (value: LivePlayerActivitySnapshot) => void;
    const load = vi.fn(() => new Promise<LivePlayerActivitySnapshot>((done) => { resolve = done; }));
    const callbacks = start(load);
    stop?.();
    resolve(snapshot(true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.onSnapshot).not.toHaveBeenCalled();
    expect(callbacks.onInitialSettled).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
