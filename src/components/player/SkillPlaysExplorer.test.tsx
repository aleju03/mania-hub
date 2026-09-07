// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LivePlayerSkillPlay } from "#/lib/live-backend";
import type { MyDataSkillMode } from "#/lib/my-data";

const fetchSkillPlays = vi.fn();
const fetchDanEvidence = vi.fn();

vi.mock("#/lib/live-backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/live-backend")>();
  return {
    ...actual,
    fetchLivePlayerSkillPlaysDirect: fetchSkillPlays,
    fetchLivePlayerDanEvidenceDirect: fetchDanEvidence,
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
vi.mock("#/components/maps/MapDetailModal", () => ({
  MapDetailModal: ({ play }: { play: { ratingExcluded?: boolean } }) => (
    <div data-testid="map-rating-state">{play.ratingExcluded ? "excluded" : "rated"}</div>
  ),
}));

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
    fireEvent.click(await screen.findByText("does not count"));
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByText("Best 101"));
    await waitFor(() => expect(screen.getByTestId("map-rating-state").textContent).toBe(excluded ? "excluded" : "rated"));
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
  }, 10_000);
});
