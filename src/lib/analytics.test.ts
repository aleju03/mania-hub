// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/* The module keeps its queue in module scope, so each test imports a fresh
   copy rather than inheriting the previous test's pending events. */
async function loadAnalytics() {
  vi.resetModules();
  return import("./analytics");
}

function beaconBodies(beacon: ReturnType<typeof vi.fn>): Promise<string[]> {
  return Promise.all(beacon.mock.calls.map(([, blob]) => (blob as Blob).text()));
}

let beacon: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  beacon = vi.fn(() => true);
  // Defined on the real navigator rather than swapped for a stand-in: jsdom
  // brand-checks its own accessors, so a substitute object throws on
  // navigator.language the moment an event is built.
  Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "sendBeacon");
  // Listeners from earlier module instances persist on the shared jsdom
  // window, so a leftover "hidden" would make later tests flush unexpectedly.
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  window.localStorage.clear();
});

describe("analytics batching", () => {
  test("coalesces events fired in the same window into one request", async () => {
    const { track } = await loadAnalytics();

    track("$pageview");
    track("map_opened", { beatmap_id: 42 });
    expect(beacon).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(beacon).toHaveBeenCalledTimes(1);
    const [body] = await beaconBodies(beacon);
    const parsed = JSON.parse(body) as { events: Array<{ event: string }> };
    expect(parsed.events.map((entry) => entry.event)).toEqual(["$pageview", "map_opened"]);
  });

  test("sends the batch to /api/sync", async () => {
    const { track } = await loadAnalytics();

    track("$pageview");
    await vi.advanceTimersByTimeAsync(500);

    expect(beacon.mock.calls[0]?.[0]).toBe("/api/sync");
  });

  // Batching may never cost an event: a visitor who navigates away mid-window
  // has to take the queue with them.
  test("flushes pending events when the page is hidden", async () => {
    const { track } = await loadAnalytics();

    track("$pageview");
    window.dispatchEvent(new Event("pagehide"));

    expect(beacon).toHaveBeenCalledTimes(1);
    const [body] = await beaconBodies(beacon);
    expect(JSON.parse(body).events).toHaveLength(1);

    // The queue is drained, so the timer that follows must not re-send it.
    await vi.advanceTimersByTimeAsync(500);
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  /* The path that matters on mobile: backgrounding a tab usually ends the
     session without ever firing pagehide. */
  test("flushes pending events when the tab is backgrounded", async () => {
    const { track } = await loadAnalytics();

    track("$pageview");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(beacon).toHaveBeenCalledTimes(1);
    const [body] = await beaconBodies(beacon);
    expect(JSON.parse(body).events).toHaveLength(1);
  });

  test("keeps events queued while the tab stays visible", async () => {
    const { track } = await loadAnalytics();

    track("$pageview");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(beacon).not.toHaveBeenCalled();

    // Still queued, not dropped: the normal timer carries it.
    await vi.advanceTimersByTimeAsync(500);
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  test("does not fire an empty request when nothing is queued", async () => {
    await loadAnalytics();

    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(500);

    expect(beacon).not.toHaveBeenCalled();
  });

  test("cuts a long burst into bounded batches", async () => {
    const { track } = await loadAnalytics();

    for (let index = 0; index < 12; index += 1) track(`event_${index}`);
    // Ten events fill a batch and send it immediately; the rest wait.
    expect(beacon).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(beacon).toHaveBeenCalledTimes(2);

    const bodies = await beaconBodies(beacon);
    const counts = bodies.map((body) => JSON.parse(body).events.length);
    expect(counts).toEqual([10, 2]);
  });
});
