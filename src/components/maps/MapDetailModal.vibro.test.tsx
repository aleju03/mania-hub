// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LiveMapSearchEntry } from "#/lib/live-backend";
import type { VibroAnalysis } from "#dan/vibro-sections";
import { MsdBlock, PlayContextBlock } from "./MapDetailModal";

afterEach(cleanup);

const MAP_ENTRY: LiveMapSearchEntry = {
  beatmapId: 101, beatmapsetId: 10, title: "Chart", artist: "Artist", creator: "Mapper", version: "4K",
  status: "graveyard", keyCount: 4, stars: 8, bpm: 180, length: 120, playCount: 10,
  lnCount: 0, primaryPattern: "jack", patterns: { jack: 1 }, covers: null,
  msd: { Overall: 20 }, dan: null, vibro: false,
};

it.each(["adjusted", "excluded"] as const)("shows readable sections without player-policy copy on a %s chart", (status) => {
  const entry = { ...MAP_ENTRY, vibro: status === "excluded" };
  const analysis: VibroAnalysis = {
    version: 1, status, excludedDurationMs: 3000, activeDurationMs: 120_000,
    timeShare: 0.025, noteShare: 0.05, judgementShare: 0.05, remainingNotes: 1000,
    sections: [
      { startTime: 39_430, endTime: 42_886, reasons: ["rapid_jack_burst"] },
      { startTime: 88_488, endTime: 111_001.00000000005, reasons: ["repeated_chord"] },
      { startTime: 59_999.999, endTime: 61_005, reasons: ["repeated_wall"] },
    ],
  };
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={entry} vibroAnalysis={analysis} /></I18nProvider>);
  expect(screen.getByText("Detected sections")).toBeTruthy();
  expect(screen.getByText(status === "adjusted" ? "localized vibro detected" : "vibro chart, estimates unreliable")).toBeTruthy();
  expect(screen.getByText("0:39.43–0:42.89")).toBeTruthy();
  expect(screen.getByText("1:28.49–1:51.00")).toBeTruthy();
  expect(screen.getByText("1:00.00–1:01.01")).toBeTruthy();
  expect(screen.queryByText(/High accuracy never overrides/)).toBeNull();
  expect(screen.queryByText(/Adjusted rating:/)).toBeNull();
});

it("scales section timestamps to the displayed rate", () => {
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={MAP_ENTRY} rate={1.5} rateMsd={{ Overall: 25 }} vibroAnalysis={{
    version: 1, status: "adjusted", sections: [{ startTime: 60_000, endTime: 64_329, reasons: ["repeated_chord"] }],
    excludedDurationMs: 3000, activeDurationMs: 100_000, timeShare: 0.03, noteShare: 0.05, judgementShare: 0.05, remainingNotes: 1000,
  }} /></I18nProvider>);
  expect(screen.getByText("0:40.00–0:42.89")).toBeTruthy();
});

it("shows continuous passages as unified ranges without changing the source exclusions", () => {
  const analysis: VibroAnalysis = {
    version: 1, status: "excluded", excludedDurationMs: 40_000, activeDurationMs: 180_000,
    timeShare: 0.22, noteShare: 0.3, judgementShare: 0.3, remainingNotes: 1000,
    sections: [
      [53_210, 54_420], [54_510, 55_720], [55_800, 57_020], [57_100, 58_320],
      [58_400, 59_610], [59_700, 60_910], [60_990, 62_210], [62_290, 63_510],
      [76_560, 97_230], [101_210, 102_500],
      [114_180, 115_400], [115_480, 116_690], [116_780, 117_990], [118_070, 119_290],
      [119_370, 120_590], [120_670, 121_880], [121_960, 123_180], [123_260, 124_480],
    ].map(([startTime, endTime]) => ({ startTime, endTime, reasons: ["repeated_wall"] })),
  };
  const original = structuredClone(analysis);
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={MAP_ENTRY} vibroAnalysis={analysis} /></I18nProvider>);
  expect(screen.getAllByRole("listitem", { hidden: true }).map((item) => item.textContent)).toEqual([
    "0:53.21–1:03.51", "1:16.56–1:37.23", "1:41.21–1:42.50", "1:54.18–2:04.48",
  ]);
  expect(analysis).toEqual(original);
});

it.each([0.75, 1, 1.5])("measures the display gap at the displayed %sx speed", (rate) => {
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={MAP_ENTRY} rate={rate} rateMsd={{ Overall: 25 }} vibroAnalysis={{
    version: 1, status: "adjusted", excludedDurationMs: 2000, activeDurationMs: 100_000,
    timeShare: 0.02, noteShare: 0.03, judgementShare: 0.03, remainingNotes: 1000,
    sections: [
      { startTime: 60_000, endTime: 61_000, reasons: ["repeated_wall"] },
      { startTime: 61_300, endTime: 62_000, reasons: ["repeated_wall"] },
    ],
  }} /></I18nProvider>);
  expect(screen.getAllByRole("listitem", { hidden: true })).toHaveLength(rate === 1.5 ? 1 : 2);
  if (rate === 1.5) expect(screen.getByText("0:40.00–0:41.33")).toBeTruthy();
});

it("explains an accepted individual clear while retaining the chart's vibro warning", () => {
  render(<I18nProvider i18n={getI18n("en")}>
    <PlayContextBlock play={{
      beatmapId: 101, username: "player", accuracy: 0.95761536938, pp: 100,
      rateMod: null, playedAt: null, source: "top", rating: 40.82,
      ratingLabel: "Overall", ratingColor: "#ffffff",
      vibroClearEvidence: {
        version: 1, stableAccuracy: 0.95761536938, max300Ratio: 1072 / 418,
        ratioIsLowerBound: false, od: 9,
      },
    }} />
  </I18nProvider>);
  expect(screen.getByText("Accepted clear on a vibro chart: 95.76% accuracy, 2.56:1 MAX:300, OD9.")).toBeTruthy();
  expect(screen.queryByText("does not count")).toBeNull();
});
