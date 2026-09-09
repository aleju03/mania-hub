// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LiveMapSearchEntry } from "#/lib/live-backend";
import { MapDetailModal, PlayContextBlock, type MapDetailPlayContext } from "./MapDetailModal";

const { getScore, writeText } = vi.hoisted(() => ({ getScore: vi.fn(), writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/osu", () => ({ getScore }));
vi.mock("./ChartPreviewPanel", () => ({ ChartPreviewPanel: () => null }));
vi.mock("../../lib/live-backend", async (original) => ({
  ...await original<typeof import("../../lib/live-backend")>(),
  fetchLiveChartAnalysis: async () => null,
  fetchLiveRateChartAnalysis: async () => null,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const entry: LiveMapSearchEntry = {
  beatmapId: 101, beatmapsetId: 10, title: "Chart", artist: "Artist", creator: "Mapper", version: "4K",
  status: "loved", keyCount: 4, stars: 6, bpm: 180, length: 120, playCount: 10,
  lnCount: 0, primaryPattern: "jack", patterns: {}, covers: null,
  msd: { Overall: 40, Stream: 39 }, dan: { rawDan: 11.41, label: "alpha++", family: "rc" }, vibro: false,
};
const play: MapDetailPlayContext = {
  beatmapId: 101, username: "player", accuracy: 0.9748, pp: null, scoreId: 123,
  rateMod: null, playedAt: "2026-09-01T00:00:00Z", source: "tracked",
  rating: 29.44, ratingLabel: "Overall", ratingColor: "white",
  skillRatings: { Overall: 29.44, Stream: 23.62, Stamina: 28.54 },
  sharePath: "/player/player/skills?score=123&keys=4&map=101&rating=Overall",
  score: {
    statistics: { perfect: 3228, great: 1501, good: 196, ok: 13, meh: 6, miss: 19 },
    maxCombo: 1173, totalScore: 895710, rank: "S", scoreUrl: "https://osu.ppy.sh/scores/9876543210",
  },
};
const wrap = (element: React.ReactNode) => <I18nProvider i18n={getI18n("en")}>{element}</I18nProvider>;

it("opens with stored judgments and the play's own MSD vector, without a dan rail or score fetch", () => {
  render(wrap(<PlayContextBlock play={play} entry={entry} />));
  expect(screen.getByText("3,228")).toBeTruthy();
  expect(screen.getByText("1,173x")).toBeTruthy();
  expect(screen.getByText("895,710")).toBeTruthy();
  expect(screen.getByText("MSD skill rating")).toBeTruthy();
  expect(screen.getByText("23.62")).toBeTruthy();
  expect(screen.queryByText("39.00")).toBeNull();
  expect(screen.queryByText("Dan credit")).toBeNull();
  expect(getScore).not.toHaveBeenCalled();
});

it("leaves unknown judgments and score values absent instead of inventing zero counts", () => {
  render(wrap(<PlayContextBlock play={{ ...play, score: null }} entry={entry} />));
  expect(screen.getByLabelText("Judgments unavailable")).toBeTruthy();
  expect(screen.getAllByText("—")).toHaveLength(8);
  expect(getScore).not.toHaveBeenCalled();
});

it("shares the score or selected map according to the active tab, preserving the tab during catalog hydration", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { rerender } = render(wrap(<MapDetailModal entry={entry} play={play} onClose={() => {}} />));
  fireEvent.click(screen.getByTitle("Share score"));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}${play.sharePath}`));
  fireEvent.click(screen.getByRole("tab", { name: "Map info" }));
  rerender(wrap(<MapDetailModal entry={{ ...entry, stars: 6.2 }} play={play} onClose={() => {}} />));
  expect(screen.getByRole("tab", { name: "Map info" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByTitle("Share map"));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/maps?map=101`));
  fireEvent.click(screen.getByRole("tab", { name: "Score" }));
  expect(screen.getByText("3,228")).toBeTruthy();
  expect(getScore).not.toHaveBeenCalled();
});
