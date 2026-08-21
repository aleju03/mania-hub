// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../../lib/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsRecentEventRow } from "../../../lib/analytics-feed";
import type { AnalyticsEventCatalogEntry, AnalyticsEventLookupResult } from "../../../lib/analytics-monitor";

// The flag chips these cards draw read their copy through Lingui, so renders
// need the provider; en resolves to the source strings.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });


const getAnalyticsEventCatalog = vi.hoisted(() => vi.fn());
const getAnalyticsEventLookup = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/analytics-monitor-data", () => ({ getAnalyticsEventCatalog, getAnalyticsEventLookup }));

const { AnalyticsEventLookup } = await import("./AnalyticsEventLookup");

const NOW = Date.now();

const CATALOG: AnalyticsEventCatalogEntry[] = [
  { event: "$pageview", count: 287_701, lastTs: NOW - 30_000 },
  { event: "pack_open", count: 608_560, lastTs: NOW - 60_000 },
  { event: "changelog_open", count: 25, lastTs: NOW - 3_600_000 },
];

const LOOKUP: AnalyticsEventLookupResult = {
  event: "changelog_open",
  sinceTs: 0,
  people: [
    { actorKey: "u111", viewerId: 111, username: "juan", distinctId: "d111", country: "CR", path: "/skins", lastTs: NOW - 3_600_000, count: 4 },
    { actorKey: "danon", viewerId: null, username: null, distinctId: "anon-1", country: "JP", path: "/", lastTs: NOW - 7_200_000, count: 1 },
  ],
  occurrences: [
    firing({ ts: NOW - 3_600_000, viewerUsername: "juan", country: "CR" }),
    firing({ ts: NOW - 7_200_000, distinctId: "anon-1", country: "JP" }),
  ],
};

/* One firing. Only the fields the feed's description reads are worth spelling
   out; the rest of the row shape is noise here. */
function firing(overrides: Partial<AnalyticsRecentEventRow>): AnalyticsRecentEventRow {
  return {
    eventId: null,
    timestamp: "",
    ts: NOW,
    event: "changelog_open",
    path: "/",
    country: null,
    deviceKind: "desktop",
    distinctId: "d111",
    viewerUsername: null,
    ...overrides,
  } as AnalyticsRecentEventRow;
}

afterEach(() => {
  cleanup();
  getAnalyticsEventCatalog.mockReset();
  getAnalyticsEventLookup.mockReset();
  window.localStorage.clear();
});

describe("AnalyticsEventLookup", () => {
  it("lists the store's events and looks up who fired the one picked", async () => {
    getAnalyticsEventCatalog.mockResolvedValue(CATALOG);
    getAnalyticsEventLookup.mockResolvedValue(LOOKUP);
    render(<AnalyticsEventLookup range={24} now={NOW} />);

    await waitFor(() => expect(screen.getByText("Changelog opened")).toBeTruthy());
    // Nothing is fetched until an event is picked.
    expect(getAnalyticsEventLookup).not.toHaveBeenCalled();
    expect(screen.getByText("Pick an event on the left.")).toBeTruthy();

    fireEvent.click(screen.getByText("Changelog opened"));
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());
    expect(getAnalyticsEventLookup).toHaveBeenCalledWith({ data: { event: "changelog_open", sinceTs: 0 } });
    // One row per person, the signed-out one named for what it is.
    expect(screen.getByText("Guest")).toBeTruthy();
    expect(screen.getByText("Changelog opened · 2 people, everything still stored")).toBeTruthy();
    expect(screen.getByText("juan").closest("a")!.getAttribute("href")).toContain("/player/juan");
  });

  it("narrows the lookup to the selected range on request", async () => {
    getAnalyticsEventCatalog.mockResolvedValue(CATALOG);
    getAnalyticsEventLookup.mockResolvedValue({ ...LOOKUP, people: [], occurrences: [] });
    render(<AnalyticsEventLookup range={24} now={NOW} />);

    await waitFor(() => expect(screen.getByText("Changelog opened")).toBeTruthy());
    fireEvent.click(screen.getByText("Changelog opened"));
    await waitFor(() => expect(getAnalyticsEventLookup).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("Last 24h"));
    await waitFor(() => expect(getAnalyticsEventLookup).toHaveBeenCalledTimes(2));
    const [{ data }] = getAnalyticsEventLookup.mock.calls[1]!;
    expect(data.sinceTs).toBeGreaterThan(NOW - 25 * 3_600_000);
    expect(data.sinceTs).toBeLessThanOrEqual(NOW - 23 * 3_600_000);
    // An empty range is a real answer, and says which window it is empty for.
    expect(screen.getByText("Nobody fired Changelog opened in this range.")).toBeTruthy();
  });

  it("unrolls the same window into every firing", async () => {
    getAnalyticsEventCatalog.mockResolvedValue(CATALOG);
    getAnalyticsEventLookup.mockResolvedValue(LOOKUP);
    render(<AnalyticsEventLookup range={24} now={NOW} />);

    await waitFor(() => expect(screen.getByText("Changelog opened")).toBeTruthy());
    fireEvent.click(screen.getByText("Changelog opened"));
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());

    fireEvent.click(screen.getByText("Firings"));
    // The feed's own sentence for the event, once per firing.
    await waitFor(() => expect(screen.getAllByText("the changelog")).toHaveLength(2));
    expect(screen.getByText("Changelog opened · 2 firings, everything still stored")).toBeTruthy();
    // Switching readings re-reads what is already in hand.
    expect(getAnalyticsEventLookup).toHaveBeenCalledTimes(1);
  });

  it("filters the event list and comes back to the last event looked at", async () => {
    getAnalyticsEventCatalog.mockResolvedValue(CATALOG);
    getAnalyticsEventLookup.mockResolvedValue(LOOKUP);
    const first = render(<AnalyticsEventLookup range={24} now={NOW} />);

    await waitFor(() => expect(screen.getByText("Changelog opened")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Find an event"), { target: { value: "pack" } });
    expect(screen.queryByText("Changelog opened")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Find an event"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Changelog opened"));
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());
    first.unmount();

    render(<AnalyticsEventLookup range={24} now={NOW} />);
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());
  });

  it("puts the most recently fired event at the top, however rare it is", async () => {
    getAnalyticsEventCatalog.mockResolvedValue([...CATALOG, { event: "pack_cut", count: 2, lastTs: NOW - 5_000 }]);
    render(<AnalyticsEventLookup range={24} now={NOW} />);

    await waitFor(() => expect(screen.getByText("Pack cut open")).toBeTruthy());
    const names = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    const cut = names.findIndex((text) => text.startsWith("Pack cut open"));
    const opened = names.findIndex((text) => text.startsWith("Pack opened"));
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThan(opened);
  });

  it("names an event the feed has no sentence for instead of describing its page", async () => {
    getAnalyticsEventCatalog.mockResolvedValue([{ event: "streak_run", count: 33_321, lastTs: NOW - 60_000 }]);
    getAnalyticsEventLookup.mockResolvedValue({
      event: "streak_run",
      sinceTs: 0,
      people: [],
      occurrences: [firing({ event: "streak_run", path: "/packs", viewerUsername: "juan" })],
    });
    render(<AnalyticsEventLookup range={24} now={NOW} />);

    await waitFor(() => expect(screen.getByText("Streak run")).toBeTruthy());
    fireEvent.click(screen.getByText("Streak run"));
    fireEvent.click(screen.getByText("Firings"));
    // The event, not the page it happened on ("visited card packs").
    await waitFor(() => expect(screen.getAllByText("Streak run").length).toBeGreaterThan(1));
    expect(screen.queryByText("card packs")).toBeNull();
    expect(screen.getByText("/packs")).toBeTruthy();
  });

  it("drops a remembered event the store no longer has", async () => {
    window.localStorage.setItem("mh_monitor_lookup_event", "retired_event");
    getAnalyticsEventCatalog.mockResolvedValue(CATALOG);
    render(<AnalyticsEventLookup range={24} now={NOW} />);

    await waitFor(() => expect(screen.getByText("Changelog opened")).toBeTruthy());
    expect(getAnalyticsEventLookup).not.toHaveBeenCalled();
    expect(screen.getByText("Pick an event on the left.")).toBeTruthy();
  });
});
