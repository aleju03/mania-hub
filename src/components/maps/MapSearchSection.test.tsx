// @vitest-environment jsdom
//
// Regression tests for the cold-load fetch sequence: with a saved non-default
// sort the first fetch must wait for the post-hydration restore instead of
// firing with the SSR default and being superseded (the local-ui mirror used
// to adopt the restored prop one commit after the fetch effect saw it).
import { StrictMode } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapSearchSection, type MapSearchUiState } from "./MapSearchSection";
import { fetchLiveMapSearch } from "../../lib/live-backend";
import { writeSearchSortPreference } from "./searchSortPreference";

vi.mock("../../lib/live-backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/live-backend")>();
  return { ...actual, fetchLiveMapSearch: vi.fn(() => new Promise(() => {})) };
});
// The detail modal drags in the chart preview stack; it stays closed here.
vi.mock("./MapDetailModal", () => ({ MapDetailModal: () => null }));

const fetchMock = vi.mocked(fetchLiveMapSearch);

// jsdom lacks ResizeObserver (StarRangePill measures its track with one).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const DEFAULT_STATE: MapSearchUiState = {
  q: "",
  keys: [],
  statuses: [],
  patterns: [],
  starMin: 0,
  starMax: 0,
  bpmMin: 0,
  bpmMax: 0,
  lenMin: 0,
  lenMax: 0,
  danMin: null,
  danMax: null,
  sort: "playcount",
  dir: "desc",
  page: 0,
};

function renderSection(state: MapSearchUiState) {
  return render(
    <MapSearchSection state={state} onChange={() => {}} liveBackendEnabled={true} />,
  );
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
});

describe("MapSearchSection cold-load fetch", () => {
  it("fetches immediately with no saved sort preference", () => {
    renderSection(DEFAULT_STATE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatchObject({ sort: "playcount", dir: "desc" });
  });

  it("holds the first fetch until a saved sort restores, then fetches once with it", () => {
    writeSearchSortPreference({ sort: "stars", dir: "asc" });
    const { rerender } = renderSection(DEFAULT_STATE);
    expect(fetchMock).not.toHaveBeenCalled();

    // The parent's post-hydration restore lands as a new state prop.
    rerender(
      <MapSearchSection
        state={{ ...DEFAULT_STATE, sort: "stars", dir: "asc" }}
        onChange={() => {}}
        liveBackendEnabled={true}
      />,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatchObject({ sort: "stars", dir: "asc" });
  });

  it("fetches an explicit URL sort immediately even with a differing saved preference", () => {
    writeSearchSortPreference({ sort: "stars", dir: "asc" });
    renderSection({ ...DEFAULT_STATE, sort: "bpm" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatchObject({ sort: "bpm" });
  });

  it("never fetches the default sort under StrictMode's double render", () => {
    // The app mounts in StrictMode (src/client.tsx); the render-phase adoption
    // must stay idempotent when React re-invokes the render.
    writeSearchSortPreference({ sort: "stars", dir: "asc" });
    const { rerender } = render(
      <StrictMode>
        <MapSearchSection state={DEFAULT_STATE} onChange={() => {}} liveBackendEnabled={true} />
      </StrictMode>,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(
      <StrictMode>
        <MapSearchSection
          state={{ ...DEFAULT_STATE, sort: "stars", dir: "asc" }}
          onChange={() => {}}
          liveBackendEnabled={true}
        />
      </StrictMode>,
    );
    // StrictMode double-mounts effects, so the call count can exceed one; the
    // invariant is that every request already carries the restored sort.
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toMatchObject({ sort: "stars", dir: "asc" });
    }
  });

  it("falls back to the default sort if the restore never lands", () => {
    vi.useFakeTimers();
    try {
      writeSearchSortPreference({ sort: "stars", dir: "asc" });
      renderSection(DEFAULT_STATE);
      expect(fetchMock).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toMatchObject({ sort: "playcount", dir: "desc" });
    } finally {
      vi.useRealTimers();
    }
  });
});
