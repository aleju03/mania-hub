// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openLiveEventSource: vi.fn(),
  fetchMyGoals: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({ viewer: { id: 7095193, username: "Aleju03", countryCode: "CR" } }),
}));
vi.mock("../../lib/live-backend", () => ({ openLiveEventSource: mocks.openLiveEventSource }));
vi.mock("../../lib/goals", () => ({ fetchMyGoals: mocks.fetchMyGoals }));
vi.mock("../../lib/ui-sounds", () => ({ playGoalClearedSound: vi.fn() }));

import { GoalToasts } from "./GoalToasts";

type FakeSource = {
  readyState: number;
  addEventListener: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "EventSource", {
    value: { CONNECTING: 0, OPEN: 1, CLOSED: 2 },
    configurable: true,
  });
  setVisibility("visible");
  mocks.openLiveEventSource.mockReset();
  mocks.fetchMyGoals.mockClear();
});

afterEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  Reflect.deleteProperty(globalThis, "EventSource");
});

describe("GoalToasts live stream", () => {
  test("releases the stream in a hidden tab and reconnects when visible", async () => {
    const sources: FakeSource[] = [];
    mocks.openLiveEventSource.mockImplementation(() => {
      const source: FakeSource = {
        readyState: 0,
        addEventListener: vi.fn(),
        close: vi.fn(),
      };
      sources.push(source);
      return source;
    });

    const view = render(<GoalToasts />);
    await waitFor(() => expect(sources).toHaveLength(1));

    setVisibility("hidden");
    await waitFor(() => expect(sources[0].close).toHaveBeenCalledTimes(1));

    setVisibility("visible");
    await waitFor(() => expect(sources).toHaveLength(2));

    view.unmount();
    expect(sources[1].close).toHaveBeenCalledTimes(1);
  });
});
