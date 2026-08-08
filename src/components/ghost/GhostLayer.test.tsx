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
vi.mock("./GhostSprite", () => ({
  GhostSprite: ({ speech }: { speech: { text: string } | null }) => (
    <div>Ralsei sprite{speech ? `: ${speech.text}` : ""}</div>
  ),
}));

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
      FakeEventSource.instances[0].emit("update", {
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

/* A line stays on the session until the owner replaces it, so someone arriving
   late still reads it. The stream also closes with a hidden tab, and the frame
   that reseeds it on return carries that same line: without the guard in the
   layer, a bubble already read and gone types itself out again. */
describe("GhostLayer speech replay", () => {
  const visual = (speech: { id: number; text: string } | null) => ({
    present: true,
    visual: {
      x: 0.5,
      y: 0.5,
      anchor: "page",
      character: "ralsei",
      clip: "idle",
      facing: "down",
      moving: false,
      scale: 3,
      speech,
      action: null,
    },
  });

  /* Everything a hidden tab does: the stream is torn down and a fresh one is
     seeded with the session as it stands. */
  const rejoin = async (view: ReturnType<typeof render>, speech: { id: number; text: string } | null) => {
    const before = FakeEventSource.instances.length;
    mocks.pathname = mocks.pathname === "/one" ? "/two" : "/one";
    view.rerender(<GhostLayer />);
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    const source = FakeEventSource.instances[before];
    await act(async () => {
      source.emit("hello", { id: "again" });
      source.emit("update", visual(speech));
      await Promise.resolve();
    });
  };

  test("does not re-say a line the visitor already sat through", async () => {
    const view = render(<GhostLayer />);
    await act(async () => {
      FakeEventSource.instances[0].emit("hello", { id: "one" });
      FakeEventSource.instances[0].emit("update", visual({ id: 1, text: "hello" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Ralsei sprite: hello")).toBeTruthy();

    // Long enough for the bubble to have come and gone on its own clock.
    act(() => vi.advanceTimersByTime(30_000));
    await rejoin(view, { id: 1, text: "hello" });
    expect(screen.getByText("Ralsei sprite")).toBeTruthy();

    // A new line still arrives, and so does the same text said again as a new
    // one: the panel gives every press its own id.
    await rejoin(view, { id: 2, text: "hello" });
    expect(screen.getByText("Ralsei sprite: hello")).toBeTruthy();
  });

  test("finishes a line the visitor was part way through", async () => {
    const view = render(<GhostLayer />);
    await act(async () => {
      FakeEventSource.instances[0].emit("hello", { id: "one" });
      FakeEventSource.instances[0].emit("update", visual({ id: 7, text: "still talking" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Ralsei sprite: still talking")).toBeTruthy();

    // Back before the bubble would have timed out, so it is still his line.
    act(() => vi.advanceTimersByTime(500));
    await rejoin(view, { id: 7, text: "still talking" });
    expect(screen.getByText("Ralsei sprite: still talking")).toBeTruthy();
  });
});
