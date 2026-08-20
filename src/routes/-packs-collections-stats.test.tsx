// @vitest-environment jsdom
/* The three tabs are one route, so the tab you switch away from used to be
   unmounted: coming back to the stats meant its skeletons again and two more
   requests for numbers it had just been told. What this covers is the second
   click, which should cost nothing. */
import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const collector = {
  userId: 2531335,
  username: "Readable",
  countryCode: "RU",
  avatarUrl: "https://a.ppy.sh/2531335",
  tracked: true,
  cards: 12855,
  players: 12591,
  copies: 40000,
  goats: 24,
  duplicates: 0,
  recycled: 0,
  firstFinds: 3,
  packsOpened: 4164,
  joinedAt: 1,
  lastPulledAt: 2,
  completion: { poolTotal: 12591, poolOwnedCount: 12591, goatsOwned: 24, goatsTotal: 24 },
};

const card = {
  userId: 7095193,
  username: "Aleju03",
  avatarUrl: "https://a.ppy.sh/7095193",
  countryCode: "CR",
  owners: 1,
  copies: 1,
  mintedTotal: 1,
};

const communityStats = {
  computedAt: 1_000,
  totals: {
    collectors: 1948,
    packsOpened: 644204,
    cardsMinted: 2792655,
    distinctHoldings: 2000000,
    playersCarded: 14057,
    goatCardsMinted: 7773,
    cardsRecycled: 1241435,
    poolTotal: 12591,
    goatRosterSize: 24,
    firstPullAt: 1,
    tierCopies: { goat: 7773, common: 690308 },
    oneOfAKind: 1027,
  },
  boards: {
    packsOpened: [collector],
    biggestCollections: [collector],
    goatHolders: [collector],
    firstFinds: [collector],
    longestStanding: [collector],
    completion: [collector],
    rarestCards: [card],
    mostOwnedCards: [card],
  },
};

const fetchStats = vi.fn(async () => communityStats);
const fetchPulls = vi.fn(async () => []);

vi.mock("../lib/live-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/live-backend")>()),
  fetchLivePackCommunityStats: () => fetchStats(),
  fetchLivePackRecentPulls: () => fetchPulls(),
  // The stream is the other half of this panel, and not what is under test.
  openLiveEventSource: () => null,
}));
vi.mock("../lib/analytics", () => ({ track: () => {} }));
/* The boards link every name they print, and a Link outside a router asks the
   router it is not inside where it is. Nothing here is about navigation. */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

const { StatsTab } = await import("./packs_.collections");

const settle = () => act(async () => {});

beforeEach(() => {
  fetchStats.mockClear();
  fetchPulls.mockClear();
});

it("keeps its numbers through a tab switch, and asks for nothing on the way back", async () => {
  const view = render(<StatsTab active />);
  await settle();
  expect(fetchStats).toHaveBeenCalledTimes(1);
  expect(fetchPulls).toHaveBeenCalledTimes(1);
  expect(view.container.innerHTML).not.toContain("skeleton-pulse");
  expect(view.container.textContent).toContain("Readable");

  // Away to another tab and straight back, twice, the way somebody comparing
  // two tabs actually clicks.
  for (let visit = 0; visit < 2; visit += 1) {
    view.rerender(<StatsTab active={false} />);
    await settle();
    view.rerender(<StatsTab active />);
    await settle();
  }

  expect(fetchStats).toHaveBeenCalledTimes(1);
  expect(fetchPulls).toHaveBeenCalledTimes(1);
  // And what it comes back to is the panel, not the skeleton of one.
  expect(view.container.innerHTML).not.toContain("skeleton-pulse");
  expect(view.container.textContent).toContain("Readable");
});

it("re-reads the snapshot once it has gone stale", async () => {
  vi.useFakeTimers();
  try {
    const view = render(<StatsTab active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchStats).toHaveBeenCalledTimes(1);

    view.rerender(<StatsTab active={false} />);
    await act(async () => {
      // Past the refresh interval while the tab is away: the timer is not
      // running, so the read is due the moment it comes back.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(fetchStats).toHaveBeenCalledTimes(1);

    view.rerender(<StatsTab active />);
    // Stale is still an answer: the panel it comes back to is the one it left,
    // and the re-read happens under it.
    expect(view.container.innerHTML).not.toContain("skeleton-pulse");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchStats).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
