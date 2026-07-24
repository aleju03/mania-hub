import { describe, expect, it } from "vitest";

import { MapsRandomDrawController } from "./maps-random-draw-state";
import type { RandomDrawEvent, RandomDrawRequest } from "./maps-random-draw-state";

interface TestPick {
  player: { id: number };
  beatmapset: { id: number };
}

interface TestSnapshot {
  value: { picks: TestPick[] } | null;
  generatedAt: string | null;
  isStale: boolean;
  refreshQueued: boolean;
}

type TestEvent = RandomDrawEvent<TestPick, TestSnapshot>;

const KEY = '{"weight":"favourites"}';
const OTHER_KEY = '{"weight":"players"}';
const BATCH_SIZE = 8;
const DEBOUNCE_MS = 250;
const REPOLL_MS = 5_000;

function pick(id: number): TestPick {
  return { player: { id }, beatmapset: { id: id * 10 } };
}

function picks(count: number, offset = 0): TestPick[] {
  return Array.from({ length: count }, (_, i) => pick(offset + i + 1));
}

function drawn(list: TestPick[]): TestSnapshot {
  return { value: { picks: list }, generatedAt: "2026-01-01T00:00:00Z", isStale: false, refreshQueued: false };
}

// Cold country: no value yet and a build queued, so the machine should repoll.
const BUILDING: TestSnapshot = { value: null, generatedAt: null, isStale: true, refreshQueued: true };
// No value and nothing running: there is nothing to wait for.
const EMPTY: TestSnapshot = { value: null, generatedAt: "2026-01-01T00:00:00Z", isStale: false, refreshQueued: false };

interface InFlight {
  request: RandomDrawRequest;
  signal: AbortSignal;
  resolve: (snapshot: TestSnapshot) => void;
  reject: () => void;
}

interface Timer {
  ms: number;
  run: () => void;
  cancelled: boolean;
}

class Harness {
  readonly events: TestEvent[] = [];
  readonly requests: InFlight[] = [];
  readonly timers: Timer[] = [];
  avoidRepeats = false;
  hidden = new Set<number>();
  readonly controller: MapsRandomDrawController<TestPick, TestSnapshot>;

  constructor() {
    this.controller = new MapsRandomDrawController<TestPick, TestSnapshot>({
      batchSize: BATCH_SIZE,
      filterDebounceMs: DEBOUNCE_MS,
      host: {
        draw: (request, signal) =>
          new Promise<TestSnapshot>((resolve, reject) => {
            this.requests.push({ request, signal, resolve, reject: () => reject(new Error("draw failed")) });
          }),
        avoidRepeats: () => this.avoidRepeats,
        isPickVisible: (entry) => !this.hidden.has(entry.player.id),
        emit: (event) => {
          this.events.push(event);
        },
        schedule: (run, ms) => {
          const timer: Timer = { ms, run, cancelled: false };
          this.timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      },
    });
  }

  get lastRequest(): InFlight {
    const request = this.requests.at(-1);
    if (!request) throw new Error("no draw was requested");
    return request;
  }

  get liveTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  runTimer(): void {
    const timer = this.liveTimers.at(-1);
    if (!timer) throw new Error("no timer is armed");
    timer.cancelled = true;
    timer.run();
  }

  of<T extends TestEvent["type"]>(type: T): Extract<TestEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<TestEvent, { type: T }> => event.type === type);
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  // The controller settles through promise callbacks, so let the microtask
  // queue drain before asserting.
  flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function enteredWithPick(): Promise<Harness> {
  const harness = new Harness();
  harness.controller.enterTab(KEY);
  harness.lastRequest.resolve(drawn(picks(2)));
  await harness.flush();
  harness.clearEvents();
  return harness;
}

describe("MapsRandomDrawController entry", () => {
  it("draws and commits on first entry", async () => {
    const harness = new Harness();
    harness.controller.enterTab(KEY);

    expect(harness.of("loading")).toEqual([{ type: "loading", loading: true }]);
    expect(harness.requests).toHaveLength(1);
    expect(harness.lastRequest.request.count).toBe(BATCH_SIZE);

    harness.lastRequest.resolve(drawn(picks(3)));
    await harness.flush();

    expect(harness.of("value")).toHaveLength(1);
    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([1]);
    // The committed pick leaves the buffer; the rest stay queued for rerolls.
    expect(harness.controller.queuedCount).toBe(2);
  });

  it("does not re-request when re-entering with a value already drawn", async () => {
    const harness = await enteredWithPick();

    harness.controller.stop();
    harness.controller.enterTab(KEY);

    expect(harness.requests).toHaveLength(1);
    // A browse fetch can leave the shared loading flag set while the Random tab
    // has something to show, which renders as a blank body unless cleared.
    expect(harness.of("loading")).toEqual([{ type: "loading", loading: false }]);
  });

  it("re-requests when re-entering with nothing drawn", async () => {
    const harness = new Harness();
    harness.controller.enterTab(KEY);
    // The first draw failed, then a browse tab cleared the error.
    harness.lastRequest.reject();
    await harness.flush();
    expect(harness.of("failed")).toEqual([{ type: "failed", hasValue: false }]);

    harness.controller.stop();
    harness.clearEvents();
    harness.controller.enterTab(KEY);

    expect(harness.requests).toHaveLength(2);
    // Loading again clears the error the failed attempt left behind.
    expect(harness.of("loading")).toEqual([{ type: "loading", loading: true }]);

    harness.lastRequest.resolve(drawn(picks(1)));
    await harness.flush();
    expect(harness.of("pick")).toHaveLength(1);
  });

  it("re-requests when re-entering with a reroll still spinning", async () => {
    const harness = await enteredWithPick();
    // Drain the queue, then reroll into an empty buffer.
    harness.controller.reroll();
    harness.controller.reroll();
    expect(harness.controller.isRerollPending).toBe(true);

    // Leaving the tab strands the in-flight refill.
    harness.controller.stop();
    harness.clearEvents();
    harness.controller.enterTab(KEY);

    expect(harness.lastRequest.request.count).toBe(BATCH_SIZE);
    harness.lastRequest.resolve(drawn(picks(2, 100)));
    await harness.flush();

    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([101]);
    expect(harness.controller.isRerollPending).toBe(false);
  });

  it("starts over after a country reset", async () => {
    const harness = await enteredWithPick();
    harness.controller.reset();
    expect(harness.controller.queuedCount).toBe(0);

    harness.controller.enterTab(KEY);
    // A fresh first entry: immediate and committing, not debounced.
    expect(harness.liveTimers).toHaveLength(0);
    expect(harness.requests).toHaveLength(2);
    harness.lastRequest.resolve(drawn(picks(1, 50)));
    await harness.flush();
    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([51]);
  });
});

describe("MapsRandomDrawController filter changes", () => {
  it("debounces a filter change and keeps the visible pick", async () => {
    const harness = await enteredWithPick();
    harness.controller.enterTab(OTHER_KEY);

    // Nothing goes out until the debounce fires, and the queue drawn under the
    // old filters is gone.
    expect(harness.requests).toHaveLength(1);
    expect(harness.controller.queuedCount).toBe(0);
    expect(harness.liveTimers.at(-1)?.ms).toBe(DEBOUNCE_MS);

    harness.runTimer();
    expect(harness.requests).toHaveLength(2);
    harness.lastRequest.resolve(drawn(picks(2, 200)));
    await harness.flush();

    // Counts refresh, but a chip toggle never auto-rerolls the card.
    expect(harness.of("value")).toHaveLength(1);
    expect(harness.of("pick")).toHaveLength(0);
    expect(harness.controller.queuedCount).toBe(2);
  });

  it("discards a draw that was already in flight when the filters changed", async () => {
    const harness = await enteredWithPick();
    // Drain the queue so the next reroll has to go out to the network.
    harness.controller.reroll();
    harness.controller.reroll();
    const stale = harness.lastRequest;

    harness.controller.stop();
    harness.controller.enterTab(OTHER_KEY);
    expect(stale.signal.aborted).toBe(true);
    harness.clearEvents();

    // A response that beats the debounce must not refill the cleared queue with
    // picks drawn under the old filters.
    stale.resolve(drawn(picks(4, 300)));
    await harness.flush();
    expect(harness.of("value")).toHaveLength(0);
    expect(harness.controller.queuedCount).toBe(0);

    harness.runTimer();
    harness.lastRequest.resolve(drawn(picks(1, 400)));
    await harness.flush();
    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([401]);
  });

  it("ignores a stale response that lands after a newer one", async () => {
    const harness = await enteredWithPick();
    harness.controller.reroll();
    harness.controller.reroll();
    const first = harness.lastRequest;

    harness.controller.redraw();
    const second = harness.lastRequest;
    expect(second).not.toBe(first);
    harness.clearEvents();

    second.resolve(drawn(picks(2, 500)));
    await harness.flush();
    first.resolve(drawn(picks(2, 600)));
    await harness.flush();

    expect(harness.of("value")).toHaveLength(1);
    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([501]);
    expect(harness.controller.queuedCount).toBe(1);
  });
});

describe("MapsRandomDrawController reroll", () => {
  it("serves rerolls from the buffer and refills below the threshold", async () => {
    const harness = new Harness();
    harness.controller.enterTab(KEY);
    harness.lastRequest.resolve(drawn(picks(BATCH_SIZE)));
    await harness.flush();
    harness.clearEvents();

    // 7 queued after the committed pick: above the refill mark, so no request.
    harness.controller.reroll();
    harness.controller.reroll();
    harness.controller.reroll();
    expect(harness.requests).toHaveLength(1);
    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([2, 3, 4]);
    expect(harness.controller.queuedCount).toBe(4);

    harness.controller.reroll();
    expect(harness.requests).toHaveLength(2);
    // The refill excludes what is already queued, so it can't hand back a pick
    // the user is about to see anyway.
    expect(harness.lastRequest.request.excludeSets).toEqual([60, 70, 80]);
  });

  it("settles a reroll from a batch that was drawn for something else", async () => {
    const harness = await enteredWithPick();
    harness.controller.reroll();
    harness.controller.reroll();
    expect(harness.controller.isRerollPending).toBe(true);
    expect(harness.of("pending")).toEqual([{ type: "pending", pending: true }]);

    // A filter toggle while the reroll is in flight: the replacement draw is
    // non-committing because a card is on screen.
    harness.controller.stop();
    harness.controller.enterTab(OTHER_KEY);
    harness.runTimer();
    harness.clearEvents();
    harness.lastRequest.resolve(drawn(picks(2, 700)));
    await harness.flush();

    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([701]);
    expect(harness.of("pending")).toEqual([{ type: "pending", pending: false }]);
    expect(harness.controller.isRerollPending).toBe(false);
  });

  it("settles a pending reroll when the draw fails", async () => {
    const harness = await enteredWithPick();
    harness.controller.reroll();
    harness.controller.reroll();
    harness.clearEvents();

    harness.lastRequest.reject();
    await harness.flush();

    // The visible pick survives a failed refill, so this is not an error state.
    expect(harness.of("failed")).toEqual([{ type: "failed", hasValue: true }]);
    expect(harness.controller.isRerollPending).toBe(false);
  });

  it("settles a pending reroll when the pool comes back empty", async () => {
    const harness = await enteredWithPick();
    harness.controller.reroll();
    harness.controller.reroll();
    harness.clearEvents();

    harness.lastRequest.resolve(EMPTY);
    await harness.flush();

    expect(harness.liveTimers).toHaveLength(0);
    expect(harness.controller.isRerollPending).toBe(false);
  });
});

describe("MapsRandomDrawController cold countries", () => {
  it("repolls while the country is still building", async () => {
    const harness = new Harness();
    harness.controller.enterTab(KEY);
    harness.lastRequest.resolve(BUILDING);
    await harness.flush();

    expect(harness.of("building")).toEqual([{ type: "building", firstBuild: true }]);
    expect(harness.liveTimers.at(-1)?.ms).toBe(REPOLL_MS);

    harness.runTimer();
    expect(harness.requests).toHaveLength(2);
    harness.lastRequest.resolve(drawn(picks(1)));
    await harness.flush();
    expect(harness.of("pick")).toHaveLength(1);
  });

  it("tears the repoll down on the way out and re-arms it on re-entry", async () => {
    const harness = new Harness();
    harness.controller.enterTab(KEY);
    const cold = harness.lastRequest;
    cold.resolve(BUILDING);
    await harness.flush();
    expect(harness.liveTimers).toHaveLength(1);

    // Leaving the tab: nothing keeps polling behind the user's back.
    harness.controller.stop();
    expect(harness.liveTimers).toHaveLength(0);

    // Coming back has to re-arm it, or the skeleton spins forever.
    harness.controller.enterTab(KEY);
    expect(harness.requests).toHaveLength(2);
    harness.lastRequest.resolve(BUILDING);
    await harness.flush();
    expect(harness.liveTimers).toHaveLength(1);

    harness.controller.stop();
    expect(harness.liveTimers).toHaveLength(0);
  });

  it("keeps the reroll spinning across a repoll", async () => {
    const harness = await enteredWithPick();
    harness.controller.reroll();
    harness.controller.reroll();
    harness.clearEvents();

    harness.lastRequest.resolve(BUILDING);
    await harness.flush();
    expect(harness.controller.isRerollPending).toBe(true);

    harness.runTimer();
    harness.lastRequest.resolve(drawn(picks(1, 800)));
    await harness.flush();
    expect(harness.controller.isRerollPending).toBe(false);
    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([801]);
  });
});

describe("MapsRandomDrawController exclusions", () => {
  it("sends the recency windows only while avoid-repeats is on", async () => {
    const harness = new Harness();
    harness.avoidRepeats = true;
    harness.controller.enterTab(KEY);
    harness.lastRequest.resolve(drawn(picks(BATCH_SIZE)));
    await harness.flush();

    for (let i = 0; i < 4; i += 1) harness.controller.reroll();
    const { request } = harness.lastRequest;
    // Player history is the shorter window; the set window is longer and also
    // carries whatever is still queued.
    expect(request.excludeUsers).toEqual([4, 5]);
    expect(request.excludeSets).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);

    harness.avoidRepeats = false;
    harness.controller.redraw();
    expect(harness.lastRequest.request.excludeUsers).toEqual([]);
    expect(harness.lastRequest.request.excludeSets).toEqual([]);
  });

  it("drops picks from hidden users as they arrive", async () => {
    const harness = new Harness();
    harness.hidden = new Set([1, 2]);
    harness.controller.enterTab(KEY);
    harness.lastRequest.resolve(drawn(picks(4)));
    await harness.flush();

    expect(harness.of("pick").map((event) => event.pick.player.id)).toEqual([3]);
    expect(harness.controller.queuedCount).toBe(1);
  });
});
