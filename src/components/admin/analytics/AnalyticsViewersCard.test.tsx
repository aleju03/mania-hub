// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../../lib/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsRecentEventRow } from "../../../lib/analytics-feed";
import type { AnalyticsViewersResult } from "../../../lib/analytics-monitor";

// The flag chips these cards draw read their copy through Lingui, so renders
// need the provider; en resolves to the source strings.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });


const getAnalyticsViewers = vi.hoisted(() => vi.fn());
const getAnalyticsViewerEvents = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/analytics-monitor-data", () => ({ getAnalyticsViewers, getAnalyticsViewerEvents }));

const { AnalyticsViewersCard } = await import("./AnalyticsViewersCard");

const NOW = Date.now();

const RESULT: AnalyticsViewersResult = {
  total: 3,
  viewers: [
    { viewerId: 111, username: "juan", firstSeen: NOW - 30 * 86_400_000, lastSeen: NOW - 60_000, events: 412, country: "CR", pp: 16_712.3, globalRank: 409 },
    { viewerId: 222, username: "kanaria", firstSeen: NOW - 2 * 86_400_000, lastSeen: NOW - 3 * 3_600_000, events: 87, country: "JP", pp: 9_001.5, globalRank: 2_048 },
    { viewerId: 333, username: "Ranshii", firstSeen: NOW - 900_000, lastSeen: NOW - 900_000, events: 4, country: null, pp: null, globalRank: null },
  ],
};

/* Enough rows to bring out the header controls, which stay hidden for a roster
   small enough to read at a glance. */
function manyViewers(count = 12): AnalyticsViewersResult {
  return {
    total: count,
    viewers: Array.from({ length: count }, (_, index) => ({
      viewerId: 100 + index,
      username: `player${index}`,
      firstSeen: NOW - 86_400_000,
      lastSeen: NOW - 60_000 * (index + 1),
      events: 5,
      country: null,
      pp: 10_000 - index,
      globalRank: 100 + index,
    })),
  };
}

/* One row of a player's trail. Only the fields the description reads are worth
   spelling out; the rest of the shape is noise here. */
function activityEvent(overrides: Partial<AnalyticsRecentEventRow>): AnalyticsRecentEventRow {
  return {
    eventId: null,
    timestamp: "",
    ts: NOW,
    event: "$pageview",
    path: "/tracker",
    deviceKind: "desktop",
    distinctId: "d111",
    ...overrides,
  } as AnalyticsRecentEventRow;
}

afterEach(() => {
  cleanup();
  getAnalyticsViewers.mockReset();
  getAnalyticsViewerEvents.mockReset();
});

describe("AnalyticsViewersCard", () => {
  it("lists every signed-in account with how long they have been around", async () => {
    getAnalyticsViewers.mockResolvedValue(RESULT);
    render(<AnalyticsViewersCard />);

    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());
    expect(screen.getByText("3 osu! accounts have signed in")).toBeTruthy();
    expect(screen.getByText("kanaria")).toBeTruthy();
    expect(screen.getByText("Ranshii")).toBeTruthy();
    expect(screen.getByText("412 events")).toBeTruthy();
    // A single-visit account has no span to report.
    expect(screen.getByText("first visit")).toBeTruthy();
    // Rows link into the player's profile page.
    expect(screen.getByText("juan").closest("a")!.getAttribute("href")).toContain("/player/juan");
  });

  it("says the roster is truncated rather than implying it is complete", async () => {
    getAnalyticsViewers.mockResolvedValue({ total: 900, viewers: RESULT.viewers });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText(/900 osu! accounts have signed in/)).toBeTruthy());
    expect(screen.getByText(/showing the 3 most recent/)).toBeTruthy();
  });

  it("filters by username", async () => {
    getAnalyticsViewers.mockResolvedValue({
      total: 12,
      viewers: Array.from({ length: 12 }, (_, index) => ({
        viewerId: 100 + index,
        username: index === 0 ? "kanaria" : `player${index}`,
        firstSeen: NOW - 86_400_000,
        lastSeen: NOW - 60_000,
        events: 5,
        country: null,
      })),
    });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("kanaria")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Find a signed-in player"), { target: { value: "kana" } });
    expect(screen.getByText("kanaria")).toBeTruthy();
    expect(screen.queryByText("player3")).toBeNull();

    fireEvent.change(screen.getByLabelText("Find a signed-in player"), { target: { value: "nobody" } });
    expect(screen.getByText('No signed-in player matches "nobody".')).toBeTruthy();
  });

  it("reports a failed load instead of showing an empty roster", async () => {
    getAnalyticsViewers.mockRejectedValue(new Error("Analytics viewers failed (503)."));
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("Analytics viewers failed (503).")).toBeTruthy());
    expect(screen.getByText("could not load")).toBeTruthy();
  });

  it("shows where each player stands, and admits when it does not know", async () => {
    getAnalyticsViewers.mockResolvedValue(RESULT);
    render(<AnalyticsViewersCard />);

    await waitFor(() => expect(screen.getByText("16,712pp")).toBeTruthy());
    expect(screen.getByText("#409")).toBeTruthy();
    expect(screen.getByText("9,002pp")).toBeTruthy();
    // A player the backend has never ingested has no pp to show, which is a gap
    // in what the site knows rather than a zero.
    expect(screen.getByText("unranked")).toBeTruthy();
  });

  it("asks the backend to re-sort rather than reordering the page in hand", async () => {
    getAnalyticsViewers.mockResolvedValue(manyViewers());
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("player0")).toBeTruthy());
    expect(getAnalyticsViewers).toHaveBeenCalledWith({ data: { sort: "recent", country: null } });

    fireEvent.click(screen.getByRole("button", { name: "PP" }));
    await waitFor(() => expect(getAnalyticsViewers).toHaveBeenCalledWith({ data: { sort: "pp", country: null } }));

    fireEvent.click(screen.getByRole("button", { name: "Rank" }));
    await waitFor(() => expect(getAnalyticsViewers).toHaveBeenCalledWith({ data: { sort: "rank", country: null } }));
    expect(screen.getByRole("button", { name: "Rank" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "PP" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("says which end of the roster a truncated list kept", async () => {
    getAnalyticsViewers.mockResolvedValue({ ...manyViewers(), total: 900 });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText(/showing the 12 most recent/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "PP" }));
    await waitFor(() => expect(screen.getByText(/showing the 12 highest by pp/)).toBeTruthy());
  });

  it("opens one player's own trail on demand", async () => {
    getAnalyticsViewers.mockResolvedValue(RESULT);
    getAnalyticsViewerEvents.mockResolvedValue({
      viewerId: 111,
      events: [
        activityEvent({ ts: NOW - 60_000, path: "/player/kanaria" }),
        activityEvent({
          ts: NOW - 300_000,
          event: "replay_view",
          path: "/replay",
          replayTitle: "Blue Zenith",
          replayArtist: "xi",
          replayPlayer: "cookiezi",
        }),
      ],
    });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());
    // Nothing is fetched until a row is actually opened.
    expect(getAnalyticsViewerEvents).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show what juan has been doing" }));
    await waitFor(() => expect(screen.getByText("kanaria's profile")).toBeTruthy());
    expect(getAnalyticsViewerEvents).toHaveBeenCalledWith({ data: { viewerId: 111 } });
    expect(screen.getByText("xi - Blue Zenith")).toBeTruthy();
    // Only the row that was asked for.
    expect(getAnalyticsViewerEvents).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Hide what juan has been doing" }));
    expect(screen.queryByText("kanaria's profile")).toBeNull();
  });

  it("distinguishes a pruned trail from a broken one", async () => {
    getAnalyticsViewers.mockResolvedValue(RESULT);
    getAnalyticsViewerEvents.mockResolvedValue({ viewerId: 111, events: [] });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Show what juan has been doing" }));
    await waitFor(() => expect(screen.getByText("Nothing left in the retention window for this player.")).toBeTruthy());
  });

  it("reports a failed trail load on the row that asked for it", async () => {
    getAnalyticsViewers.mockResolvedValue(RESULT);
    getAnalyticsViewerEvents.mockRejectedValue(new Error("Analytics viewer events failed (500)."));
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Show what juan has been doing" }));
    await waitFor(() => expect(screen.getByText("Analytics viewer events failed (500).")).toBeTruthy());
  });

  it("asks the backend for one country rather than filtering the page in hand", async () => {
    const roster = { ...manyViewers(), countries: [{ country: "CR", count: 40 }, { country: "JP", count: 9 }] };
    getAnalyticsViewers.mockResolvedValue(roster);
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("player0")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Filter signed-in players by country"));
    // The countries on offer are counted over the whole roster, not the page.
    expect(screen.getByRole("option", { name: /Costa Rica/ }).textContent).toContain("40");
    fireEvent.mouseDown(screen.getByRole("option", { name: /Costa Rica/ }));

    await waitFor(() => expect(getAnalyticsViewers).toHaveBeenCalledWith({ data: { sort: "recent", country: "CR" } }));
  });

  it("says how much of the roster the chosen country is", async () => {
    getAnalyticsViewers.mockResolvedValue({
      total: 900,
      matched: 2,
      country: "CR",
      countries: [{ country: "CR", count: 2 }, { country: "JP", count: 1 }],
      viewers: RESULT.viewers,
    });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());
    // Nothing is picked yet, so the country the backend echoes back means nothing.
    expect(screen.getByText(/900 osu! accounts have signed in/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Filter signed-in players by country"));
    fireEvent.mouseDown(screen.getByRole("option", { name: /Costa Rica/ }));
    await waitFor(() => expect(screen.getByText(/2 of 900 signed-in accounts browse from Costa Rica/)).toBeTruthy());
    // This mock answers every call with the whole roster; the card shows only CR
    // anyway, so a backend that ignored the filter cannot mislead the reader.
    expect(screen.queryByText("kanaria")).toBeNull();
  });

  it("keeps its controls reachable once a country narrows the roster", async () => {
    getAnalyticsViewers.mockResolvedValue({
      total: 900,
      matched: 1,
      country: null,
      countries: [{ country: "JP", count: 1 }],
      viewers: [RESULT.viewers[1]!],
    });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("kanaria")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Filter signed-in players by country"));
    fireEvent.mouseDown(screen.getByRole("option", { name: /Japan/ }));
    // One row left, and the filter is still there to undo it with.
    await waitFor(() => expect(getAnalyticsViewers).toHaveBeenCalledWith({ data: { sort: "recent", country: "JP" } }));
    expect(screen.getByLabelText("Filter signed-in players by country")).toBeTruthy();
  });

  it("says so plainly when nobody has signed in yet", async () => {
    getAnalyticsViewers.mockResolvedValue({ total: 0, viewers: [] });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("Nobody has signed in yet.")).toBeTruthy());
  });
});
