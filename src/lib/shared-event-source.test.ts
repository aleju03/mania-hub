// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SharedEventSourcePool } from "./shared-event-source";

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.OPEN;
  closeCalls = 0;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function createPool(): SharedEventSourcePool {
  return new SharedEventSourcePool((url) => new FakeEventSource(url) as unknown as EventSource);
}

beforeEach(() => {
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "EventSource");
});

describe("SharedEventSourcePool", () => {
  test("opens one underlying connection for consumers of the same URL", () => {
    const pool = createPool();
    const first = pool.open("http://localhost:7227/api/live?country=CR");
    const second = pool.open("http://localhost:7227/api/live?country=CR");

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(pool.activeConnectionCount()).toBe(1);

    first.close();
    expect(FakeEventSource.instances[0].closeCalls).toBe(0);
    expect(pool.activeConnectionCount()).toBe(1);

    second.close();
    expect(FakeEventSource.instances[0].closeCalls).toBe(1);
    expect(pool.activeConnectionCount()).toBe(0);
  });

  test("keeps each handle's listeners isolated when another consumer closes", () => {
    const pool = createPool();
    const first = pool.open("http://localhost:7227/api/live?country=CR");
    const second = pool.open("http://localhost:7227/api/live?country=CR");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.addEventListener("tracker_score", firstListener);
    second.addEventListener("tracker_score", secondListener);

    FakeEventSource.instances[0].dispatchEvent(new MessageEvent("tracker_score", { data: "{}" }));
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    first.close();
    FakeEventSource.instances[0].dispatchEvent(new MessageEvent("tracker_score", { data: "{}" }));
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(2);

    second.close();
  });

  test("keeps onopen and onerror handlers scoped to their own handle", () => {
    const pool = createPool();
    const first = pool.open("http://localhost:7227/api/live?country=CR");
    const second = pool.open("http://localhost:7227/api/live?country=CR");
    const firstOpen = vi.fn();
    const secondOpen = vi.fn();
    const secondError = vi.fn();
    first.onopen = firstOpen;
    second.onopen = secondOpen;
    second.onerror = secondError;

    FakeEventSource.instances[0].dispatchEvent(new Event("open"));
    FakeEventSource.instances[0].dispatchEvent(new Event("error"));
    expect(firstOpen).toHaveBeenCalledTimes(1);
    expect(secondOpen).toHaveBeenCalledTimes(1);
    expect(secondError).toHaveBeenCalledTimes(1);

    first.close();
    FakeEventSource.instances[0].dispatchEvent(new Event("open"));
    expect(firstOpen).toHaveBeenCalledTimes(1);
    expect(secondOpen).toHaveBeenCalledTimes(2);

    second.close();
  });

  test("does not merge streams whose query semantics differ", () => {
    const pool = createPool();
    const regular = pool.open("http://localhost:7227/api/live?country=CR");
    const observer = pool.open("http://localhost:7227/api/live?country=CR&observe=1");

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(pool.activeConnectionCount()).toBe(2);

    regular.close();
    observer.close();
  });
});
