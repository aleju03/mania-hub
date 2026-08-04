// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/one" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: mocks.pathname } }),
}));
vi.mock("#/lib/auth-context", () => ({ useAuth: () => ({ viewer: null }) }));
vi.mock("#/lib/ghost", () => ({ getGhostViewerTicket: vi.fn() }));
vi.mock("#/lib/live-backend", () => ({ getLiveBackendUrl: () => "http://localhost:7227" }));
vi.mock("#/lib/window-activity", () => ({ useDocumentVisible: () => true }));
vi.mock("./GhostSprite", () => ({ GhostSprite: () => <div>Ralsei sprite</div> }));

import { GhostLayer } from "./GhostLayer";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, EventListener[]>();
  readyState = FakeEventSource.OPEN;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.pathname = "/one";
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GhostLayer navigation", () => {
  test("hides the old route immediately while the next stream settles", async () => {
    const view = render(<GhostLayer />);
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      FakeEventSource.instances[0].emit("hello", { id: "one" });
      FakeEventSource.instances[0].emit("ghost", {
        present: true,
        visual: {
          x: 0.5,
          y: 0.5,
          clip: "idle",
          facing: "down",
          moving: false,
          scale: 3,
          speech: null,
          action: null,
        },
      });
      await Promise.resolve();
    });
    expect(screen.getByText("Ralsei sprite")).toBeTruthy();

    mocks.pathname = "/two";
    view.rerender(<GhostLayer />);
    expect(screen.queryByText("Ralsei sprite")).toBeNull();
    expect(FakeEventSource.instances[0].readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(250));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("route=%2Ftwo");
  });
});
