// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LiveMapSearchEntry } from "#/lib/live-backend";
import { MapDetailModal, PlayContextBlock, type MapDetailPlayContext } from "./MapDetailModal";

const { getScore, getBeatmapFile, writeText } = vi.hoisted(() => ({
  getScore: vi.fn(),
  getBeatmapFile: vi.fn().mockRejectedValue(new Error("offline")),
  writeText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/osu", () => ({ getScore, getBeatmapFile }));
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
  sharePath: "/player/player/skills?play=4k-123",
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

it("drops the Map info tab for a play on a chart with no osu! id, so the play is the whole card", () => {
  const localEntry = { ...entry, beatmapId: 0, beatmapsetId: 0, msd: undefined, dan: undefined };
  render(wrap(<MapDetailModal entry={localEntry} play={{ ...play, beatmapId: 0 }} status="missing" onClose={() => {}} />));
  expect(screen.queryByRole("tab", { name: "Map info" })).toBeNull();
  expect(screen.getByText("3,228")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /osu! web/ })).toBeNull();
});

it("rates a matched rate edit's chart at the copy's rate without inventing a speed-mod badge", () => {
  render(wrap(<MapDetailModal entry={entry} play={{ ...play, mods: [], chartRate: 1.05 }} onClose={() => {}} />));
  expect(screen.queryByText("DT")).toBeNull();
  expect(screen.getByRole("link", { name: /osu! web/ }).getAttribute("href")).toBe("https://osu.ppy.sh/beatmapsets/10#mania/101");
});

const localEntry: LiveMapSearchEntry = {
  ...entry, beatmapId: -7001, beatmapsetId: 0, status: "local", playCount: 0, rankedDate: null,
  covers: null, diffCount: 1, diffs: undefined, danDt: null, msdDt: null,
};
const localPlay: MapDetailPlayContext = { ...play, beatmapId: -7001, scoreId: null, sharePath: "/player/player/recent?import=abc", score: { ...play.score!, scoreUrl: null } };

it("gives a local chart's play a Map info tab without anything osu! supplies", () => {
  render(wrap(<MapDetailModal entry={localEntry} play={localPlay} onClose={() => {}} />));
  fireEvent.click(screen.getByRole("tab", { name: "Map info" }));
  expect(screen.getByText("BPM")).toBeTruthy();
  expect(screen.getByText("LN notes")).toBeTruthy();
  expect(screen.getByText("40.00")).toBeTruthy();
  expect(screen.queryByText("Plays")).toBeNull();
  expect(screen.queryByText(/local/i)).toBeNull();
  expect(screen.queryByRole("link", { name: /osu! web/ })).toBeNull();
  expect(screen.queryByText("Download .osz")).toBeNull();
  expect(screen.queryByText("Open in osu!")).toBeNull();
  expect(screen.queryByTitle("Share map")).toBeNull();
  expect(document.querySelector('a[href*="osu.ppy.sh"], a[href*="/maps?map="]')).toBeNull();
});

it("shares a local chart's score link from the Map info tab, never a map link", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(wrap(<MapDetailModal entry={localEntry} play={localPlay} onClose={() => {}} />));
  fireEvent.click(screen.getByRole("tab", { name: "Map info" }));
  fireEvent.click(screen.getByTitle("Share score"));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}${localPlay.sharePath}`));
});

it("keeps a local chart's stub out of osu! links even when its row names a declared set", () => {
  render(wrap(<MapDetailModal entry={{ ...localEntry, beatmapsetId: 55, status: "" }} play={localPlay} status="pending" onClose={() => {}} />));
  fireEvent.click(screen.getByRole("tab", { name: "Map info" }));
  expect(screen.queryByText("Plays")).toBeNull();
  expect(screen.queryByRole("link", { name: /osu! web/ })).toBeNull();
  expect(screen.queryByText("Download .osz")).toBeNull();
});

it("leaves a local chart with no analysis yet as the play alone", () => {
  render(wrap(<MapDetailModal entry={{ ...localEntry, msd: undefined, dan: undefined }} play={localPlay} status="missing" onClose={() => {}} />));
  expect(screen.queryByRole("tab", { name: "Map info" })).toBeNull();
  expect(screen.getByText("3,228")).toBeTruthy();
});

it("does not fetch a local chart's .osu for a rate star rating", () => {
  render(wrap(<MapDetailModal entry={localEntry} play={{ ...localPlay, rateMod: { acronym: "DT", rate: 1.5, pitched: false } }} onClose={() => {}} />));
  fireEvent.click(screen.getByRole("tab", { name: "Map info" }));
  expect(getBeatmapFile).not.toHaveBeenCalled();
});
