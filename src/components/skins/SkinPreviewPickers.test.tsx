// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";
import type { SkinBackdropCandidate } from "../../lib/skin-preview-backdrops";
import type { SkinPreviewChartSnippet } from "../../lib/skin-preview-patterns";
import { SkinPreviewPickers } from "./SkinPreviewPickers";

const searchSkinPreviewBackdrops = vi.hoisted(() => vi.fn(async (_query: string): Promise<SkinBackdropCandidate[]> => []));
vi.mock("../../lib/skin-preview-backdrops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/skin-preview-backdrops")>()),
  searchSkinPreviewBackdrops,
}));

const COVER: SkinBackdropCandidate = { setId: 1234, label: "Camellia - Ghost" };
const SNIPPET: SkinPreviewChartSnippet = {
  beatmapId: 99,
  keys: 4,
  label: "void - Sudden Romance [[4K] Koi]",
  stars: 6.2,
  notes: [
    { column: 0, time: 0, endTime: 0 },
    { column: 2, time: 300, endTime: 900 },
  ],
};

function renderPickers(overrides: {
  backdropShuffle?: () => void;
  patternShuffle?: () => Promise<SkinPreviewChartSnippet[]>;
} = {}) {
  // The pickers use <Trans>, which throws without a provider; en resolves to
  // the source strings these tests match on.
  render(
    <I18nProvider i18n={getI18n("en")}>
      <SkinPreviewPickers
        disabled={false}
        backdrop={{
          pool: {
            candidates: [COVER],
            drawing: false,
            shuffle: overrides.backdropShuffle ?? (() => {}),
            drop: () => {},
            prefetch: () => {},
          },
          selected: "flat",
          onPick: () => {},
          scope: "all",
          onScopeChange: () => {},
          keymodeLabel: "4K",
        }}
        pattern={{
          pool: {
            candidates: [SNIPPET],
            keys: 4,
            drawing: false,
            shuffle: overrides.patternShuffle ?? (async () => []),
            ensure: async () => [],
          },
          selected: null,
          onPick: () => {},
        }}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  searchSkinPreviewBackdrops.mockReset();
  searchSkinPreviewBackdrops.mockResolvedValue([]);
  vi.useRealTimers();
});

describe("SkinPreviewPickers", () => {
  it("shows one row at a time, backdrops first", () => {
    renderPickers();

    expect(screen.getByRole("button", { name: "flat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Camellia - Ghost/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Built-in layout/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "pattern" }));

    expect(screen.getByRole("button", { name: /Built-in layout/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sudden Romance/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "flat" })).toBeNull();
  });

  it("keeps the scope toggle on the backdrop tab, where a pick can apply to every keymode", () => {
    renderPickers();

    expect(screen.getByRole("button", { name: "all keymodes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "pattern" }));

    // A snippet is cut from one keymode's chart, so there is nothing to apply
    // to the others.
    expect(screen.queryByRole("button", { name: "all keymodes" })).toBeNull();
  });

  it("shuffles whichever row is on screen", () => {
    const backdropShuffle = vi.fn();
    const patternShuffle = vi.fn(async () => []);
    renderPickers({ backdropShuffle, patternShuffle });

    fireEvent.click(screen.getByRole("button", { name: /shuffle/ }));
    expect(backdropShuffle).toHaveBeenCalledTimes(1);
    expect(patternShuffle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "pattern" }));
    fireEvent.click(screen.getByRole("button", { name: /shuffle/ }));
    expect(patternShuffle).toHaveBeenCalledTimes(1);
    expect(backdropShuffle).toHaveBeenCalledTimes(1);
  });

  it("swaps the drawn covers for the maps a typed name matches, and back on clear", async () => {
    vi.useFakeTimers();
    searchSkinPreviewBackdrops.mockResolvedValue([{ setId: 555, label: "xi - Blue Zenith" }]);
    const backdropShuffle = vi.fn();
    renderPickers({ backdropShuffle });

    fireEvent.change(screen.getByRole("searchbox", { name: /Search maps/ }), { target: { value: "zenith" } });
    // Debounced: nothing is asked of the catalog per keystroke.
    expect(searchSkinPreviewBackdrops).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(searchSkinPreviewBackdrops).toHaveBeenCalledWith("zenith");
    expect(screen.getByRole("button", { name: /Blue Zenith/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Camellia - Ghost/ })).toBeNull();
    // Flat stays on offer either way.
    expect(screen.getByRole("button", { name: "flat" })).toBeTruthy();

    // Shuffling while searching drops the query and draws fresh covers.
    fireEvent.click(screen.getByRole("button", { name: /shuffle/ }));
    expect(backdropShuffle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Camellia - Ghost/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Blue Zenith/ })).toBeNull();
  });

  it("says when a search matches nothing", async () => {
    vi.useFakeTimers();
    renderPickers();

    fireEvent.change(screen.getByRole("searchbox", { name: /Search maps/ }), { target: { value: "nope" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByText("no maps match")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Camellia - Ghost/ })).toBeNull();
  });
});
