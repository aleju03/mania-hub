// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getI18n } from "../../../lib/i18n";
import { createEmptyWallet } from "../../../lib/pack-collection";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock("#/lib/live-backend", () => ({
  isLiveBackendConfigured: () => true,
  fetchLiveGlobalRankings: vi.fn(() => new Promise(() => {})),
  fetchLiveRankingsSnapshot: vi.fn(() => new Promise(() => {})),
}));

const { AlbumView } = await import("./AlbumView");

describe("linked album scrolling", () => {
  const frames: FrameRequestCallback[] = [];
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    frames.length = 0;
    scrollIntoView.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderAlbum(scrollLinkedAlbumIntoView: boolean) {
    return render(
      <I18nProvider i18n={getI18n("en")}>
        <AlbumView
          wallet={createEmptyWallet(Date.now())}
          syncStatus="local"
          trackedCountries={["CR"]}
          viewerId={null}
          openAlbumCode="CR"
          scrollLinkedAlbumIntoView={scrollLinkedAlbumIntoView}
        />
      </I18nProvider>,
    );
  }

  function flushFrames() {
    act(() => {
      while (frames.length > 0) frames.shift()?.(0);
    });
  }

  it("scrolls a genuine album link to the open book", () => {
    renderAlbum(true);
    flushFrames();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("does not scroll when the open album is restored below a pack summary", () => {
    renderAlbum(false);
    flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
