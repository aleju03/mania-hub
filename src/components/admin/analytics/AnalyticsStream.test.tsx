// @vitest-environment jsdom
/* Render smoke tests for the two live surfaces. They exist because the feed is
   fed straight from captured events: a visitor with an odd row shape (no
   timestamp, no map details, an event kind we have no phrasing for) must never
   blank the admin dashboard. */
import { act, cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../../lib/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_STREAM_MODE_STORAGE_KEY } from "../../../lib/analytics-monitor";
import {
  buildAnalyticsReplayMapIndex,
  buildAnalyticsSessions,
  type AnalyticsRecentEventRow,
} from "../../../lib/analytics-feed";
import { AnalyticsLiveBoard } from "./AnalyticsLiveBoard";
import { AnalyticsPulse } from "./AnalyticsPulse";
import { AnalyticsStream } from "./AnalyticsStream";

// The flag chips these cards draw read their copy through Lingui, so renders
// need the provider; en resolves to the source strings.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });


const NOW = 1_800_000_000_000;

function row(overrides: Partial<AnalyticsRecentEventRow> = {}): AnalyticsRecentEventRow {
  return {
    eventId: `e${Math.random()}`,
    timestamp: "02:31:45 PM",
    ts: NOW - 10_000,
    event: "$pageview",
    path: "/tracker",
    country: "CR",
    selectedCountry: null,
    deviceKind: "desktop",
    distinctId: "visitor-1",
    mapsTab: null,
    mapsQuery: null,
    mapsFilters: null,
    mapsSort: null,
    mapsCollection: null,
    mapsPage: null,
    mapsBeatmapId: null,
    rankingsPage: null,
    rankingsTab: null,
    rankingsKeys: null,
    rankingsAxis: null,
    rankingsSide: null,
    rankingsSkillset: null,
    profileUsername: null,
    replayPlayer: null,
    replayScoreId: null,
    replayTitle: null,
    replayArtist: null,
    replayDifficulty: null,
    viewUrl: null,
    farmHelperUser: null,
    farmMapTitle: null,
    farmMapUser: null,
    packType: null,
    packUsername: null,
    skinsQuery: null,
    skinsKeys: null,
    skinsFilters: null,
    skinsSort: null,
    skinsPage: null,
    skinRef: null,
    skinName: null,
    skinKeymodes: null,
    skinUploadError: null,
    communitiesQuery: null,
    communitiesCountry: null,
    communitiesLanguage: null,
    communitiesTag: null,
    communitiesSort: null,
    communitiesPage: null,
    communityId: null,
    communityName: null,
    collectionsCollector: null,
    collectionsTab: null,
    collectionsTier: null,
    collectionsSort: null,
    collectionsQuery: null,
    collectionsPage: null,
    collectionsCard: null,
    collectionsCards: null,
    addScorePlayer: null,
    addScoreMap: null,
    addScoreRepeat: null,
    addScoreReason: null,
    skillPlaysPlayer: null,
    skillPlaysView: null,
    skillPlaysOrder: null,
    skillPlaysKeys: null,
    skillPlaysAxis: null,
    skillPlaysSide: null,
    viewerUsername: null,
    referrer: null,
    ...overrides,
  };
}

const ROWS: AnalyticsRecentEventRow[] = [
  row({
    distinctId: "a",
    ts: NOW - 5_000,
    event: "replay_view",
    path: "/replay",
    replayTitle: "Ghost",
    replayArtist: "Camellia",
    replayDifficulty: "4K Insane",
    replayPlayer: "cheesecake",
  }),
  row({ distinctId: "a", ts: NOW - 60_000, path: "/maps", mapsQuery: "camellia", mapsTab: "farmed" }),
  row({ distinctId: "b", ts: NOW - 90_000, path: "/player/juan", profileUsername: "juan", country: "DE", deviceKind: "mobile" }),
  // Hostile shapes: no epoch timestamp, and an event we have no phrasing for.
  row({ distinctId: "c", ts: undefined as unknown as number, event: "brand_new_event", path: "/whatever" }),
];

function renderStream(rows = ROWS) {
  const sessions = buildAnalyticsSessions(rows, NOW);
  const replayMaps = buildAnalyticsReplayMapIndex(rows);
  return render(
    <AnalyticsStream
      rows={rows}
      sessions={sessions}
      replayMaps={replayMaps}
      countries={[{ country: "CR", count: 2 }]}
      country={null}
      now={NOW}
      onCountryChange={() => {}}
    />,
  );
}

afterEach(cleanup);
beforeEach(() => window.localStorage.removeItem(ANALYTICS_STREAM_MODE_STORAGE_KEY));

describe("AnalyticsStream", () => {
  it("reads every event as a sentence", () => {
    renderStream();
    expect(screen.getByText("watched")).toBeTruthy();
    expect(screen.getByText("Camellia - Ghost [4K Insane]")).toBeTruthy();
    expect(screen.getByText("by cheesecake")).toBeTruthy();
    expect(screen.getByText("searched")).toBeTruthy();
    expect(screen.getByText('"camellia"')).toBeTruthy();
    expect(screen.getByText("juan's profile")).toBeTruthy();
    // The unknown event still lands as a plain visit rather than vanishing.
    expect(screen.getByText("/whatever")).toBeTruthy();
  });

  it("counts the range in its header", () => {
    renderStream();
    expect(screen.getByText("4 events from 3 visitors")).toBeTruthy();
  });

  it("narrows to one kind of activity when a filter chip is pressed", () => {
    renderStream();
    fireEvent.click(screen.getByRole("button", { name: /^Replays/ }));
    expect(screen.getByText("Camellia - Ghost [4K Insane]")).toBeTruthy();
    expect(screen.queryByText('"camellia"')).toBeNull();
    expect(screen.queryByText("juan's profile")).toBeNull();
  });

  it("drops one kind of activity and keeps the rest when a chip is right clicked", () => {
    renderStream();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Replays/ }));
    expect(screen.queryByText("Camellia - Ghost [4K Insane]")).toBeNull();
    expect(screen.getByText('"camellia"')).toBeTruthy();
    expect(screen.getByText("juan's profile")).toBeTruthy();
    expect(screen.getByText("3 of 4 events from 3 visitors")).toBeTruthy();
    // "Everything" puts the hidden kind back.
    fireEvent.click(screen.getByRole("button", { name: /^Everything/ }));
    expect(screen.getByText("Camellia - Ghost [4K Insane]")).toBeTruthy();
  });

  it("hides a kind on a long press and ignores the click that ends it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderStream();
      const chip = screen.getByRole("button", { name: /^Replays/ });
      fireEvent.pointerDown(chip);
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.pointerUp(chip);
      fireEvent.click(chip);
      // Held, not tapped: the replay is gone and the other kinds stayed.
      expect(screen.queryByText("Camellia - Ghost [4K Insane]")).toBeNull();
      expect(screen.getByText('"camellia"')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds the same events back into per-visitor journeys", () => {
    renderStream();
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    // Three visitors, each collapsed to its latest step.
    expect(screen.getAllByText(/^\d+ steps?$/)).toHaveLength(3);
    const visitorRow = screen.getByText("V1").closest("button")!;
    expect(within(visitorRow).getByText("watched")).toBeTruthy();
    fireEvent.click(visitorRow);
    // Expanded, the earlier search in the same session shows up.
    expect(screen.getByText('"camellia"')).toBeTruthy();
  });

  it("names signed-out visitors instead of leaving the row blank", () => {
    renderStream([
      ROWS[0],
      row({ distinctId: "d", ts: NOW - 30_000, path: "/maps", viewerUsername: "Aleju03" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(within(screen.getByText("V1").closest("button")!).getByText("Guest")).toBeTruthy();
    expect(within(screen.getByText("V2").closest("button")!).getByText("Aleju03")).toBeTruthy();
  });

  it("comes back in the reading mode it was left in", () => {
    renderStream();
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(window.localStorage.getItem(ANALYTICS_STREAM_MODE_STORAGE_KEY)).toBe("sessions");
    cleanup();
    renderStream();
    expect(screen.getAllByText(/^\d+ steps?$/)).toHaveLength(3);
  });

  it("says so instead of emptying out when the range has nothing in it", () => {
    renderStream([]);
    expect(screen.getByText("0 events from 0 visitors")).toBeTruthy();
    expect(screen.getByText("No matching events in the selected range.")).toBeTruthy();
  });
});

describe("AnalyticsLiveBoard", () => {
  it("gives every online visitor a card with their current action", () => {
    const sessions = buildAnalyticsSessions(ROWS, NOW);
    render(<AnalyticsLiveBoard sessions={sessions} replayMaps={buildAnalyticsReplayMapIndex(ROWS)} now={NOW} />);
    expect(screen.getByText("Camellia - Ghost [4K Insane]")).toBeTruthy();
    expect(screen.getByText("juan's profile")).toBeTruthy();
    // The visitor with no epoch timestamp can't be proven online, so no card.
    expect(screen.queryByText("V3")).toBeNull();
  });

  it("keeps the trail area reserved for a visitor with a single step", () => {
    const sessions = buildAnalyticsSessions([row({ distinctId: "a", ts: NOW - 5_000 })], NOW);
    render(<AnalyticsLiveBoard sessions={sessions} replayMaps={new Map()} now={NOW} />);
    expect(screen.getByText("no earlier steps")).toBeTruthy();
  });

  it("holds each visitor's place when a new event reshuffles them", () => {
    const cardOrder = (container: HTMLElement) =>
      Array.from(container.querySelectorAll("[title^='visitor id:']")).map((node) => node.getAttribute("title"));
    const { container, rerender } = render(
      <AnalyticsLiveBoard sessions={buildAnalyticsSessions(ROWS, NOW)} replayMaps={new Map()} now={NOW} />,
    );
    expect(cardOrder(container)).toEqual(["visitor id: a", "visitor id: b"]);

    // b is now the most recently active, so the sessions arrive b-first.
    const reshuffled = [row({ distinctId: "b", ts: NOW - 1_000, path: "/maps" }), ...ROWS];
    rerender(<AnalyticsLiveBoard sessions={buildAnalyticsSessions(reshuffled, NOW)} replayMaps={new Map()} now={NOW} />);
    expect(cardOrder(container)).toEqual(["visitor id: a", "visitor id: b"]);
  });

  const searchBox = () => screen.getByLabelText("Find a visitor by name, country or activity");

  it("narrows the board to the searched visitor", () => {
    const rows = [row({ distinctId: "y", ts: NOW - 3_000, viewerUsername: "Yunarkm", path: "/maps", mapsQuery: "dt" }), ...ROWS];
    render(<AnalyticsLiveBoard sessions={buildAnalyticsSessions(rows, NOW)} replayMaps={buildAnalyticsReplayMapIndex(rows)} now={NOW} />);
    fireEvent.change(searchBox(), { target: { value: "yunar" } });
    expect(screen.getByText("Yunarkm")).toBeTruthy();
    expect(screen.getByText("1 of 3 online visitors match")).toBeTruthy();
    expect(screen.queryByText("Camellia - Ghost [4K Insane]")).toBeNull();
  });

  it("also matches what a visitor is looking at", () => {
    const sessions = buildAnalyticsSessions(ROWS, NOW);
    render(<AnalyticsLiveBoard sessions={sessions} replayMaps={buildAnalyticsReplayMapIndex(ROWS)} now={NOW} />);
    fireEvent.change(searchBox(), { target: { value: "juan" } });
    expect(screen.getByText("juan's profile")).toBeTruthy();
    expect(screen.queryByText("Camellia - Ghost [4K Insane]")).toBeNull();
  });

  it("accounts for a match who has already gone quiet", () => {
    const rows = [...ROWS, row({ distinctId: "y", ts: NOW - 60 * 60_000, viewerUsername: "Yunarkm" })];
    render(<AnalyticsLiveBoard sessions={buildAnalyticsSessions(rows, NOW)} replayMaps={new Map()} now={NOW} />);
    fireEvent.change(searchBox(), { target: { value: "yunarkm" } });
    expect(screen.getByText('Nobody online matches "yunarkm".')).toBeTruthy();
    expect(screen.getByText("1 visitor matched earlier in this range - they are in the activity feed below.")).toBeTruthy();
  });

  it("falls back to a calm empty state when the site is quiet", () => {
    const stale = [row({ distinctId: "a", ts: NOW - 60 * 60_000 })];
    const sessions = buildAnalyticsSessions(stale, NOW);
    render(<AnalyticsLiveBoard sessions={sessions} replayMaps={new Map()} now={NOW} />);
    expect(screen.getByText("Nobody on the site right now.")).toBeTruthy();
    expect(screen.getByText("Last visitor was here 1h ago.")).toBeTruthy();
  });
});

describe("AnalyticsPulse", () => {
  const base = {
    rangeHours: 24,
    cacheState: "fresh" as const,
    source: "live" as const,
    bucketMs: 30 * 60_000,
    timeline: Array.from({ length: 48 }, (_, index) => ({
      ts: NOW - (47 - index) * 30 * 60_000,
      events: index === 47 ? 40 : index % 5,
      pageviews: index === 47 ? 30 : 1,
      visitors: index === 47 ? 6 : 1,
    })),
    activeVisitors: 7,
    recentVisitors: 12,
    pageviewsInRange: 1_140,
    uniqueVisitorsInRange: 142,
    eventsInRange: 3_400,
    bounce: { bounced: 19, landers: 50 },
    topRoutes: [],
    recentEvents: [],
    topPhysicalCountries: [],
    topProfiles: [],
    topReplays: [],
    topReferrers: [],
    shareEvents: 0,
    sharesByPlatform: [],
    topSharedPages: [],
    serverErrors: [],
    recentServerErrors: [],
    fetchedAt: NOW,
  };

  it("headlines the last 15 minutes and keeps here-now underneath it", () => {
    render(<AnalyticsPulse data={base} range={24} onlineCountries={3} />);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("last 15m")).toBeTruthy();
    expect(screen.getByText("7 here now from 3 countries")).toBeTruthy();
    expect(screen.getByText("38%")).toBeTruthy();
    expect(screen.getByText("peak 40 events per 30m")).toBeTruthy();
  });

  it("falls back to the here-now count when the backend sends no 15m window", () => {
    const legacy = { ...base, recentVisitors: undefined };
    render(<AnalyticsPulse data={legacy} range={24} onlineCountries={0} />);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("7 here now")).toBeTruthy();
  });

  it("reads the hovered bucket out next to the title", () => {
    const { container } = render(<AnalyticsPulse data={base} range={24} onlineCountries={3} />);
    const bars = container.querySelectorAll('[role="img"] > div');
    fireEvent.mouseEnter(bars[bars.length - 1]);
    expect(screen.getByText(/40 events · 30 pageviews · 6 visitors/)).toBeTruthy();
    // Leaving the chart puts the peak summary back.
    fireEvent.mouseLeave(bars[bars.length - 1].parentElement!.parentElement!);
    expect(screen.getByText("peak 40 events per 30m")).toBeTruthy();
  });

  it("labels the axis with round clock times between the range edges", () => {
    const { container } = render(<AnalyticsPulse data={base} range={24} onlineCountries={3} />);
    const axis = container.querySelector(".font-mono")!;
    // Range start, "now", and the ticks in between.
    expect(axis.childElementCount).toBeGreaterThan(2);
    expect(within(axis as HTMLElement).getByText("now")).toBeTruthy();
  });

  it("survives a backend too old to send a timeline", () => {
    const legacy = { ...base, timeline: undefined as never, bucketMs: undefined as never };
    render(<AnalyticsPulse data={legacy} range={24} onlineCountries={0} />);
    expect(screen.getByText("no traffic in range")).toBeTruthy();
  });
});
