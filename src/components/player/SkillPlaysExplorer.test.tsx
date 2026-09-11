// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LivePlayerSkillPlay } from "#/lib/live-backend";
import type { MyDataSkillMode } from "#/lib/my-data";

const fetchSkillPlays = vi.fn();
const fetchDanEvidence = vi.fn();
const fetchUnratedPlays = vi.fn();

vi.mock("#/lib/live-backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/live-backend")>();
  return {
    ...actual,
    fetchLivePlayerSkillPlaysDirect: fetchSkillPlays,
    fetchLivePlayerDanEvidenceDirect: fetchDanEvidence,
    fetchLivePlayerUnratedPlaysDirect: fetchUnratedPlays,
    loadLiveMapSearchEntry: async () => null,
    peekLiveMapSearchEntry: () => null,
    prefetchLiveMapSearchEntry: async () => null,
  };
});

vi.mock("./SkillPlaysModal", () => ({
  rateModFor: () => null,
  stubEntry: (play: LivePlayerSkillPlay) => ({
    beatmapId: play.beatmapId,
    beatmapsetId: play.beatmapsetId ?? 0,
    title: play.title,
    artist: play.artist,
    creator: play.creator ?? "",
    version: play.version,
    status: "",
    keyCount: play.keyCount,
    stars: 0,
    bpm: 0,
    length: 0,
    playCount: 0,
    lnCount: 0,
    primaryPattern: "",
    patterns: {},
    covers: null,
  }),
}));
vi.mock("#/components/maps/MapDetailModal", async (importOriginal) => {
  const { PlayContextBlock } = await importOriginal<typeof import("#/components/maps/MapDetailModal")>();
  return {
    MapDetailModal: ({ play }: { play: import("#/components/maps/MapDetailModal").MapDetailPlayContext }) => (
      <div data-testid="map-rating-state"><PlayContextBlock play={play} /></div>
    ),
  };
});

const { SkillPlaysExplorer } = await import("./SkillPlaysExplorer");

const mode: MyDataSkillMode = {
  keyCount: 4,
  analyzedPlays: 60,
  ratings: { Overall: 30, Stream: 28 },
  patterns: [],
};

function play(index: number, order: "Best" | "Recent"): LivePlayerSkillPlay {
  return {
    beatmapId: index,
    beatmapsetId: index,
    title: `${order} ${index}`,
    artist: "Artist",
    creator: "Mapper",
    version: "4K",
    coverUrl: null,
    beatmapStatus: index % 2 === 0 ? "ranked" : "graveyard",
    keyCount: 4,
    rating: 30 - index / 100,
    overallRating: 30 - index / 100,
    pp: 100,
    accuracy: 0.97,
    rate: 1,
    playedAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
    source: "top",
    scoreId: index,
    rateMod: null,
    topSkillset: "Stream",
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  fetchSkillPlays.mockReset();
  fetchDanEvidence.mockReset();
});

describe("SkillPlaysExplorer bounded cohorts", () => {
  it.each([
    [41001, "rate_vibro", "Vibro detected. This play does not count toward skill or dan ratings."],
    [41002, "chart_vibro", "Vibro detected in this chart. This play does not count toward skill or dan ratings."],
    [41003, "chart_ineligible", "This chart is not built in a way a dan level can be read off a clear of it."],
  ] as const)("explains %s / %s without conflating vibro and structural ineligibility", async (userId, reason, text) => {
    const excluded = reason !== "chart_ineligible";
    fetchDanEvidence.mockResolvedValue({
      clears: [],
      rejected: [{
        play: { ...play(101, "Best"), rate: 1.5, ratingExcluded: excluded },
        reason, side: "rc", chartDan: 18.38, chartDanLabel: "theta++",
        clearAccuracy: null, bar: null, minAccuracy: null, od: null,
      }],
    });
    render(<I18nProvider i18n={getI18n("en")}>
      <SkillPlaysExplorer userId={userId} username="player" modes={[mode]} view="dan" />
    </I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    fireEvent.click(await screen.findByText("does not count"));
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByText("Best 101"));
    expect(within(screen.getByTestId("map-rating-state")).getByText(text)).toBeTruthy();
    expect(screen.queryByText("No MSD rating")).toBeNull();
  });

  it("lists a sub-floor play in the MSD Recent order with its reason, and hides it behind the toggle", async () => {
    fetchSkillPlays.mockImplementation(async (_userId: number, _keys: number, _axis: string, options: { sort?: string; includeRejected?: boolean }) => ({
      items: [play(101, options.sort === "recent" ? "Recent" : "Best")],
      total: 1,
      limit: 200,
      offset: 0,
      ...(options.includeRejected ? {
        rejected: [{ ...play(103, "Recent"), rating: 0, overallRating: 0, pp: null, accuracy: 0.9099,
          playedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(), source: "tracked",
          ratingExcluded: true, ratingExclusionReason: "msd_floor" }],
      } : {}),
    }));
    render(<I18nProvider i18n={getI18n("en")}>
      <SkillPlaysExplorer userId={41006} username="player" modes={[mode]} view="msd" />
    </I18nProvider>);
    await screen.findByText("Best 101");
    // Best has no number to place it by, so it is not there.
    expect(screen.queryByText("Recent 103")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    await screen.findByText("Recent 103");
    // Newest first, ahead of the rated play set a day earlier.
    const titles = screen.getAllByText(/^Recent 10\d$/).map((node) => node.textContent);
    expect(titles).toEqual(["Recent 103", "Recent 101"]);
    fireEvent.click(screen.getByText("not rated"));
    expect(screen.getByText("Accuracy below skill rating range, so this play has no MSD rating on any skillset.")).toBeTruthy();
    fireEvent.click(screen.getByText("Recent 103"));
    expect(within(screen.getByTestId("map-rating-state")).getByText("Accuracy below skill rating range")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "not counted" }));
    await waitFor(() => expect(screen.queryByText("Recent 103")).toBeNull());
    expect(screen.getByText("Recent 101")).toBeTruthy();
  });

  it("keeps rejected low-accuracy passes in Recent and explains Dan rejection in the popup", async () => {
    fetchDanEvidence.mockResolvedValue({
      clears: [],
      rejected: [{
        play: { ...play(101, "Best"), rating: 0, overallRating: 0,
          ratingExcluded: true, ratingExclusionReason: "msd_floor" },
        reason: "below_bar", side: "rc", chartDan: 5, chartDanLabel: "5",
        clearAccuracy: 0.8, bar: 0.96, minAccuracy: 0.91, od: null,
      }],
    });
    render(<I18nProvider i18n={getI18n("en")}>
      <SkillPlaysExplorer userId={41004} username="player" modes={[mode]} view="dan" />
    </I18nProvider>);
    await waitFor(() => expect(fetchDanEvidence).toHaveBeenCalled());
    expect(screen.queryByText("Best 101")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    fireEvent.click(await screen.findByText("Best 101"));
    const popup = within(screen.getByTestId("map-rating-state"));
    expect(popup.getByText("Minimum required for dan credit is 91.00%. This play got 80.00%.")).toBeTruthy();
    expect(popup.getByText("Chart estimate")).toBeTruthy();
    expect(screen.queryByText("No MSD rating")).toBeNull();
    expect(screen.queryByText("Accuracy below skill rating range")).toBeNull();
  });

  it("keeps eligible Dan-only clears in Best and shows their Dan credit", async () => {
    fetchDanEvidence.mockResolvedValue({
      clears: [{
        play: { ...play(102, "Best"), rating: 0, overallRating: 0,
          ratingExcluded: true, ratingExclusionReason: "msd_floor" },
        chartDan: 5, chartDanLabel: "5", creditedDan: 3.68, creditedDanLabel: "4-",
        clearAccuracy: 0.9172, skillsets: ["jack"], countsTowardDan: false,
      }],
      rejected: [],
    });
    render(<I18nProvider i18n={getI18n("en")}>
      <SkillPlaysExplorer userId={41005} username="player" modes={[mode]} view="dan" />
    </I18nProvider>);
    fireEvent.click(await screen.findByText("Best 102"));
    const popup = within(screen.getByTestId("map-rating-state"));
    expect(popup.getByText("4-")).toBeTruthy();
    expect(popup.getByText("3.68")).toBeTruthy();
    expect(popup.getByText("Your credit")).toBeTruthy();
    expect(screen.queryByText("No MSD rating")).toBeNull();
    expect(popup.queryByText("does not count")).toBeNull();
  });

  it("shows and filters every recorded mod, not only the rate mod", async () => {
    fetchSkillPlays.mockImplementation((_: number, __: number, ___: string, options: { sort?: "rating" | "recent" }) => {
      const order = options.sort === "recent" ? "Recent" : "Best";
      return Promise.resolve({
        items: [
          { ...play(1, order), mods: ["MR", "DA"] },
          { ...play(2, order), mods: [] },
        ],
        total: 2,
        unfilteredTotal: 2,
        limit: 200,
        offset: 0,
      });
    });

    render(
      <I18nProvider i18n={getI18n("en")}>
        <SkillPlaysExplorer userId={123456} username="mod-player" modes={[mode]} view="msd" />
      </I18nProvider>,
    );

    const title = await screen.findByText("Best 1");
    const row = title.closest("button");
    expect(row).not.toBeNull();
    expect(within(row!).getByTitle("MR")).toBeTruthy();
    expect(within(row!).getByTitle("DA")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Click to require MR" }));
    await waitFor(() => expect(screen.queryByText("Best 2")).toBeNull());
  });

  // Rendering and querying 60 rich rows can exceed 10s on a CPU-capped VPS.
  it("reveals 50 at a time and filters or swaps a prefetched order without another request", async () => {
    fetchSkillPlays.mockImplementation((_: number, __: number, ___: string, options: { sort?: "rating" | "recent" }) => {
      const recent = options.sort === "recent";
      const items = Array.from({ length: 60 }, (_, offset) => play(recent ? 60 - offset : offset + 1, recent ? "Recent" : "Best"));
      return Promise.resolve({ items, total: 60, unfilteredTotal: 60, limit: 200, offset: 0 });
    });

    render(
      <I18nProvider i18n={getI18n("en")}>
        <SkillPlaysExplorer userId={987654} username="player" modes={[mode]} view="msd" />
      </I18nProvider>,
    );

    await screen.findByText("Best 1");
    expect(screen.getByText("Showing 50 of 60")).toBeTruthy();
    await waitFor(() => expect(fetchSkillPlays.mock.calls.length).toBeGreaterThanOrEqual(2));
    const warmedRequestCount = fetchSkillPlays.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Showing 60 of 60")).toBeTruthy();
    expect(fetchSkillPlays).toHaveBeenCalledTimes(warmedRequestCount);

    fireEvent.click(screen.getByRole("button", { name: "ranked" }));
    await waitFor(() => expect(screen.getByText("Showing 30 of 30, 30 hidden by filters")).toBeTruthy());
    expect(fetchSkillPlays).toHaveBeenCalledTimes(warmedRequestCount);

    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    await waitFor(() => expect(screen.queryAllByText("Recent 59").length).toBeGreaterThan(0));
    expect(fetchSkillPlays).toHaveBeenCalledTimes(warmedRequestCount);
  }, 30_000);

  it("lists the unrated plays with their reason and the number the list is ranked by", async () => {
    fetchUnratedPlays.mockImplementation((_: number, __: number, options: { sort?: string }) => Promise.resolve({
      keyCount: 4,
      sort: options.sort ?? "msd",
      keyCounts: [4],
      total: 2,
      items: [
        { play: { ...play(1, "Best"), title: "Wall 1", pp: 412.5, beatmapStatus: "graveyard" }, reason: "chart_vibro", pp: 412.5, msd: 31.2, dan: { rawDan: 8, side: "rc", label: "8" } },
        { play: { ...play(2, "Best"), title: "Stacked 2", rate: 1.5, pp: null, beatmapStatus: "graveyard" }, reason: "chart_ineligible", pp: null, msd: 27.8, dan: null },
      ],
    }));

    render(
      <I18nProvider i18n={getI18n("en")}>
        <SkillPlaysExplorer userId={555} username="player" modes={[mode]} view="unrated" />
      </I18nProvider>,
    );

    await screen.findByText("Wall 1");
    expect(screen.getByText("Stacked 2")).toBeTruthy();
    expect(screen.getByText("vibro")).toBeTruthy();
    expect(screen.getByText("cannot be rated")).toBeTruthy();
    expect(screen.getByText("31.20")).toBeTruthy();
    expect(fetchUnratedPlays.mock.calls[0][2]).toMatchObject({ sort: "msd" });

    fireEvent.click(screen.getByRole("button", { name: "PP" }));
    await waitFor(() => expect(fetchUnratedPlays.mock.calls.some((call) => call[2]?.sort === "pp")).toBe(true));
  });
});
