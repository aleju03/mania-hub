// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LivePlayerSkillPlay } from "#/lib/live-backend";
import type { MyDataSkillMode } from "#/lib/my-data";

const fetchSkillPlays = vi.fn();

vi.mock("#/lib/live-backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/live-backend")>();
  return {
    ...actual,
    fetchLivePlayerSkillPlaysDirect: fetchSkillPlays,
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
vi.mock("#/components/maps/MapDetailModal", () => ({ MapDetailModal: () => null }));

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
});

describe("SkillPlaysExplorer bounded cohorts", () => {
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
