// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKER_FEED_PERSIST_LIMIT, useAppStore } from "./store";
import type { LeanTrackerScore } from "./lib/types";

const CACHE_KEY = "mania-hub-cache-v5";

function readCache() {
  return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
}

describe("app cache persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.dispatchEvent(new Event("pagehide"));
    useAppStore.setState(useAppStore.getInitialState(), true);
    window.dispatchEvent(new Event("pagehide"));
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.dispatchEvent(new Event("pagehide"));
    vi.useRealTimers();
  });

  it("serializes only the latest snapshot once per write window", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    useAppStore.getState().setShowDanEstimates(true);
    vi.advanceTimersByTime(100);
    useAppStore.getState().setNoDans(true);
    vi.advanceTimersByTime(149);
    expect(stringify).not.toHaveBeenCalled();
    expect(readCache()).toBeNull();

    vi.advanceTimersByTime(1);
    expect(stringify).toHaveBeenCalledTimes(1);
    expect(readCache()).toMatchObject({ state: { showDanEstimates: true, noDans: true }, version: 0 });
  });

  it("does not serialize the cache for changes to excluded preferences", () => {
    useAppStore.getState().setShowDanEstimates(true);
    vi.advanceTimersByTime(250);
    const before = localStorage.getItem(CACHE_KEY);
    const stringify = vi.spyOn(JSON, "stringify");
    for (let hue = 100; hue < 120; hue++) useAppStore.getState().setThemeHue(hue);
    useAppStore.getState().setThemeSaturation(80);
    vi.advanceTimersByTime(500);
    expect(stringify).not.toHaveBeenCalled();
    expect(localStorage.getItem(CACHE_KEY)).toBe(before);
  });

  it("preserves the wire format and feed limit without trimming the live state", async () => {
    const scores = Array.from({ length: 90 }, (_, id) => ({ id }) as LeanTrackerScore);
    useAppStore.setState({ feedScoresByCountry: { CR: scores } });
    const storage = useAppStore.persist.getOptions().storage!;
    // A read during the pending window must see what a reload will receive.
    const pending = await storage.getItem(CACHE_KEY);
    expect(pending?.state.feedScoresByCountry?.CR).toHaveLength(TRACKER_FEED_PERSIST_LIMIT);
    expect(useAppStore.getState().feedScoresByCountry.CR).toBe(scores);
    expect(scores).toHaveLength(90);

    vi.advanceTimersByTime(250);
    expect(readCache().state.feedScoresByCountry.CR).toEqual(scores.slice(0, TRACKER_FEED_PERSIST_LIMIT));
    expect(readCache().state).not.toHaveProperty("themeHue");
    expect(readCache().state).not.toHaveProperty("avatarAccents");
  });

  it.each(["pagehide", "visibilitychange"])("flushes the latest state on %s before the timer", (event) => {
    useAppStore.getState().setNoDans(true);
    if (event === "visibilitychange") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event(event));
    } else {
      window.dispatchEvent(new Event(event));
    }
    expect(readCache().state.noDans).toBe(true);
    const write = vi.spyOn(Storage.prototype, "setItem");
    vi.advanceTimersByTime(250);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not resurrect a pending write after clearing storage", async () => {
    useAppStore.getState().setNoDans(true);
    useAppStore.persist.clearStorage();
    const storage = useAppStore.persist.getOptions().storage!;
    expect(await storage.getItem(CACHE_KEY)).toBeNull();
    vi.advanceTimersByTime(250);
    expect(readCache()).toBeNull();
    // Clearing must also forget the comparison snapshot, so equal data can be saved again.
    useAppStore.getState().setNoDans(true);
    vi.advanceTimersByTime(250);
    expect(readCache().state.noDans).toBe(true);
  });

  it("evicts an old cache on quota failure and allows a later retry", () => {
    localStorage.setItem(CACHE_KEY, "old cache");
    const setItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
      if (name === CACHE_KEY) throw new DOMException("full", "QuotaExceededError");
      return setItem.call(this, name, value);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useAppStore.getState().setNoDans(true);
    vi.advanceTimersByTime(250);
    expect(readCache()).toBeNull();
    write.mockRestore();
    useAppStore.getState().setNoDans(true);
    vi.advanceTimersByTime(250);
    expect(readCache().state.noDans).toBe(true);
  });
});
