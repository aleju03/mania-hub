// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LiveMapSearchEntry } from "#/lib/live-backend";
import type { OsuScore } from "#/lib/types";
import { ScorePlayDetailModal } from "./ScorePlayDetailModal";

const { loadLiveMapSearchEntry } = vi.hoisted(() => ({ loadLiveMapSearchEntry: vi.fn() }));
vi.mock("../../lib/osu", () => ({ getScore: vi.fn(), getBeatmapFile: vi.fn().mockRejectedValue(new Error("offline")) }));
vi.mock("../maps/ChartPreviewPanel", () => ({ ChartPreviewPanel: () => null }));
vi.mock("../../lib/live-backend", async (original) => ({
  ...await original<typeof import("../../lib/live-backend")>(),
  loadLiveMapSearchEntry,
  peekLiveMapSearchEntry: () => undefined,
  fetchLiveChartAnalysis: async () => null,
  fetchLiveRateChartAnalysis: async () => null,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const wrap = (element: React.ReactNode) => <I18nProvider i18n={getI18n("en")}>{element}</I18nProvider>;

function importScore(companella: OsuScore["companella"]): OsuScore {
  return {
    id: -12345, user_id: 7, accuracy: 0.97, mods: [], score: 900000, max_combo: 500, passed: true, rank: "S",
    statistics: { perfect: 900, great: 50, good: 5, ok: 1, meh: 0, miss: 2 },
    pp: null, created_at: "2026-10-01T00:00:00Z", has_replay: false,
    beatmap: { id: 0, beatmapset_id: 0, mode: "mania", cs: 7, version: "Own", url: "" },
    beatmapset: { id: 0, title: "Own Chart", artist: "Artist", covers: {} },
    user: { id: 7, username: "player" },
    companella,
  } as unknown as OsuScore;
}

const localEntry: LiveMapSearchEntry = {
  beatmapId: -7001, beatmapsetId: 0, title: "Own Chart", artist: "Artist", creator: "Me", version: "Own",
  status: "local", keyCount: 7, stars: 5, bpm: 170, length: 100, playCount: 0, lnCount: 10,
  primaryPattern: "stream", patterns: {}, covers: null, msd: { Overall: 30 }, dan: null, danDt: null, msdDt: null,
};

it("opens a local chart import's Map info from the local chart entry", async () => {
  loadLiveMapSearchEntry.mockResolvedValue(localEntry);
  render(wrap(<ScorePlayDetailModal score={importScore({ importId: "abc", replay: false, localBeatmapId: -7001 })} username="player" onClose={() => {}} />));
  expect(loadLiveMapSearchEntry).toHaveBeenCalledWith(-7001);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Map info" })).toBeTruthy());
});

it("prefers a matched official chart over the local id", () => {
  loadLiveMapSearchEntry.mockResolvedValue(null);
  render(wrap(<ScorePlayDetailModal score={importScore({ importId: "abc", replay: false, reference: { beatmapId: 101, rate: 1.1 }, localBeatmapId: -7001 })} username="player" onClose={() => {}} />));
  expect(loadLiveMapSearchEntry).toHaveBeenCalledWith(101);
});

it("ignores a local id that is not negative", () => {
  loadLiveMapSearchEntry.mockResolvedValue(null);
  render(wrap(<ScorePlayDetailModal score={importScore({ importId: "abc", replay: false, localBeatmapId: 55 })} username="player" onClose={() => {}} />));
  expect(loadLiveMapSearchEntry).toHaveBeenCalledWith(0);
  expect(screen.queryByRole("tab", { name: "Map info" })).toBeNull();
});
