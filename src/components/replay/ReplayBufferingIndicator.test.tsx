// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";
import { ReplayBufferingIndicator } from "./ReplayBufferingIndicator";

beforeAll(async () => { await loadLocaleCatalog("en"); });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const indicator = (loading: boolean) => (
  <I18nProvider i18n={getI18n("en")}>
    <ReplayBufferingIndicator loading={loading} />
  </I18nProvider>
);

describe("replay buffering indicator", () => {
  it("shows a delayed accessible status and immediately disappears when playback resumes", () => {
    const view = render(indicator(false));
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(indicator(true));
    act(() => { vi.advanceTimersByTime(249); });
    expect(screen.queryByRole("status")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading...");
    expect(status.classList.contains("pointer-events-none")).toBe(true);
    view.rerender(indicator(false));
    expect(screen.queryByRole("status")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not flash for short waits and restarts the delay for a later stall", () => {
    const view = render(indicator(true));
    act(() => { vi.advanceTimersByTime(200); });
    view.rerender(indicator(false));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(indicator(true));
    act(() => { vi.advanceTimersByTime(249); });
    expect(screen.queryByRole("status")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("cancels the delayed display when the viewer unmounts", () => {
    const view = render(indicator(true));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
