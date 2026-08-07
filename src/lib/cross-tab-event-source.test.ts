// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CrossTabEventSource, type CrossTabChannel, type CrossTabLocks } from "./cross-tab-event-source";

const URL = "http://localhost:7227/api/live?country=CR";
const EVENT_NAMES = ["hello", "heartbeat", "tracker_score"] as const;

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readyState = 0;
  closeCalls = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.readyState = 0;
    this.onerror?.(new Event("error"));
  }

  emit(type: string, data: string, lastEventId = ""): void {
    this.dispatchEvent(new MessageEvent(type, { data, lastEventId }));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 2;
  }
}

/** Grants exclusive locks in request order, like the Web Locks API: a lock
 *  frees when its callback's returned promise resolves, then the next
 *  non-aborted request in line is granted. */
class FakeLockManager implements CrossTabLocks {
  private held = new Set<string>();
  private queues = new Map<string, Array<{ signal: AbortSignal; callback: () => Promise<void> }>>();

  request(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown> {
    const queue = this.queues.get(name) ?? [];
    this.queues.set(name, queue);
    queue.push({ signal: options.signal, callback });
    this.pump(name);
    return Promise.resolve();
  }

  private pump(name: string): void {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name) ?? [];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next.signal.aborted) continue;
      this.held.add(name);
      void next.callback().then(() => {
        this.held.delete(name);
        this.pump(name);
      });
      return;
    }
  }
}

class FakeChannelHub {
  private readonly channels = new Map<string, Set<FakeChannel>>();

  create(name: string): FakeChannel {
    const channel = new FakeChannel(this, name);
    const set = this.channels.get(name) ?? new Set();
    set.add(channel);
    this.channels.set(name, set);
    return channel;
  }

  broadcast(from: FakeChannel, name: string, data: unknown): void {
    for (const channel of this.channels.get(name) ?? []) {
      if (channel === from) continue;
      channel.onmessage?.({ data } as MessageEvent);
    }
  }

  remove(name: string, channel: FakeChannel): void {
    this.channels.get(name)?.delete(channel);
  }
}

class FakeChannel implements CrossTabChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(private readonly hub: FakeChannelHub, private readonly name: string) {}

  postMessage(message: unknown): void {
    this.hub.broadcast(this, this.name, message);
  }

  close(): void {
    this.hub.remove(this.name, this);
  }
}

let hub: FakeChannelHub;
let locks: FakeLockManager;

function createTab(url = URL): CrossTabEventSource {
  return new CrossTabEventSource(url, EVENT_NAMES, {
    locks,
    createChannel: (name) => hub.create(name),
    createEventSource: (target) => new FakeEventSource(target) as unknown as EventSource,
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  hub = new FakeChannelHub();
  locks = new FakeLockManager();
});

describe("CrossTabEventSource", () => {
  test("the first tab becomes leader, opens the real stream, and delivers locally", async () => {
    const tab = createTab();
    await flush();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(URL);

    const seen = vi.fn<(event: MessageEvent) => void>();
    tab.addEventListener("tracker_score", seen as unknown as EventListener);
    FakeEventSource.instances[0].open();
    FakeEventSource.instances[0].emit("tracker_score", "{\"a\":1}", "41");

    expect(tab.readyState).toBe(CrossTabEventSource.OPEN);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].data).toBe("{\"a\":1}");
    expect(seen.mock.calls[0][0].lastEventId).toBe("41");
    tab.close();
  });

  test("a second tab follows the same URL without opening a second stream", async () => {
    const leaderTab = createTab();
    const followerTab = createTab();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);

    const seen = vi.fn<(event: MessageEvent) => void>();
    followerTab.addEventListener("tracker_score", seen as unknown as EventListener);
    FakeEventSource.instances[0].emit("tracker_score", "{\"b\":2}", "7");

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].data).toBe("{\"b\":2}");
    expect(seen.mock.calls[0][0].lastEventId).toBe("7");
    leaderTab.close();
    followerTab.close();
  });

  test("a follower joining an already-open stream syncs its readyState", async () => {
    const leaderTab = createTab();
    await flush();
    FakeEventSource.instances[0].open();

    const followerTab = createTab();
    await flush();
    expect(followerTab.readyState).toBe(CrossTabEventSource.OPEN);
    leaderTab.close();
    followerTab.close();
  });

  test("closing the leader hands leadership over and resumes from the cursor", async () => {
    const leaderTab = createTab();
    const followerTab = createTab();
    await flush();
    FakeEventSource.instances[0].open();
    FakeEventSource.instances[0].emit("tracker_score", "{}", "41");

    const seen = vi.fn<(event: MessageEvent) => void>();
    followerTab.addEventListener("tracker_score", seen as unknown as EventListener);
    leaderTab.close();
    await flush();

    expect(FakeEventSource.instances[0].closeCalls).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe(`${URL}&lastEventId=41`);

    FakeEventSource.instances[1].emit("tracker_score", "{\"c\":3}", "42");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].data).toBe("{\"c\":3}");
    followerTab.close();
  });

  test("leader connection errors relay to followers", async () => {
    const leaderTab = createTab();
    const followerTab = createTab();
    await flush();
    FakeEventSource.instances[0].open();
    expect(followerTab.readyState).toBe(CrossTabEventSource.OPEN);

    const opens = vi.fn();
    const errors = vi.fn();
    followerTab.addEventListener("open", opens);
    followerTab.addEventListener("error", errors);
    FakeEventSource.instances[0].fail();

    expect(errors).toHaveBeenCalledTimes(1);
    expect(followerTab.readyState).toBe(CrossTabEventSource.CONNECTING);

    FakeEventSource.instances[0].open();
    expect(opens).toHaveBeenCalledTimes(1);
    expect(followerTab.readyState).toBe(CrossTabEventSource.OPEN);
    leaderTab.close();
    followerTab.close();
  });

  test("a closed follower never takes leadership", async () => {
    const leaderTab = createTab();
    const followerTab = createTab();
    await flush();
    followerTab.close();
    leaderTab.close();
    await flush();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closeCalls).toBe(1);
  });

  test("close stops local delivery and reports CLOSED", async () => {
    const leaderTab = createTab();
    const followerTab = createTab();
    await flush();

    const seen = vi.fn();
    followerTab.addEventListener("tracker_score", seen);
    followerTab.close();
    FakeEventSource.instances[0].emit("tracker_score", "{}", "9");

    expect(seen).not.toHaveBeenCalled();
    expect(followerTab.readyState).toBe(CrossTabEventSource.CLOSED);
    leaderTab.close();
  });

  test("different URLs elect independent leaders", async () => {
    const first = createTab(URL);
    const second = createTab("http://localhost:7227/api/live?country=CR&observe=1");
    await flush();

    expect(FakeEventSource.instances).toHaveLength(2);
    first.close();
    second.close();
  });

  describe("starvation fallback", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(document, "visibilityState");
    });

    test("a visible follower starved of relay traffic opens a direct connection from the cursor", async () => {
      const leaderTab = createTab();
      const followerTab = createTab();
      await vi.advanceTimersByTimeAsync(1);
      FakeEventSource.instances[0].open();
      FakeEventSource.instances[0].emit("tracker_score", "{}", "41");

      const seen = vi.fn<(event: MessageEvent) => void>();
      followerTab.addEventListener("tracker_score", seen as unknown as EventListener);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(FakeEventSource.instances).toHaveLength(2);
      expect(FakeEventSource.instances[1].url).toBe(`${URL}&lastEventId=41`);

      FakeEventSource.instances[1].open();
      expect(followerTab.readyState).toBe(CrossTabEventSource.OPEN);
      FakeEventSource.instances[1].emit("tracker_score", "{\"d\":4}", "42");
      expect(seen).toHaveBeenCalledTimes(1);
      expect(seen.mock.calls[0][0].data).toBe("{\"d\":4}");
      leaderTab.close();
      followerTab.close();
    });

    test("the fallback closes as soon as the relay resumes, without double delivery", async () => {
      const leaderTab = createTab();
      const followerTab = createTab();
      await vi.advanceTimersByTimeAsync(1);
      FakeEventSource.instances[0].open();
      FakeEventSource.instances[0].emit("tracker_score", "{}", "41");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeEventSource.instances).toHaveLength(2);

      const seen = vi.fn();
      followerTab.addEventListener("tracker_score", seen);
      FakeEventSource.instances[0].emit("tracker_score", "{}", "43");

      expect(FakeEventSource.instances[1].closeCalls).toBe(1);
      expect(seen).toHaveBeenCalledTimes(1);
      leaderTab.close();
      followerTab.close();
    });

    test("a hidden follower never opens a fallback", async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      const leaderTab = createTab();
      const followerTab = createTab();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(FakeEventSource.instances).toHaveLength(1);
      leaderTab.close();
      followerTab.close();
    });

    test("taking over leadership closes the fallback and reuses its cursor", async () => {
      const leaderTab = createTab();
      const followerTab = createTab();
      await vi.advanceTimersByTimeAsync(1);
      FakeEventSource.instances[0].open();
      FakeEventSource.instances[0].emit("tracker_score", "{}", "41");
      await vi.advanceTimersByTimeAsync(60_000);
      FakeEventSource.instances[1].emit("tracker_score", "{}", "44");

      leaderTab.close();
      await vi.advanceTimersByTimeAsync(1);

      expect(FakeEventSource.instances[1].closeCalls).toBe(1);
      expect(FakeEventSource.instances).toHaveLength(3);
      expect(FakeEventSource.instances[2].url).toBe(`${URL}&lastEventId=44`);
      followerTab.close();
    });
  });
});
