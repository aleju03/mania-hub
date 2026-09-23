// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LiveMapSearchEntry } from "#/lib/live-backend";
import { MsdBlock } from "./MapDetailModal";

afterEach(cleanup);

const LN_ENTRY: LiveMapSearchEntry = {
  beatmapId: 101, beatmapsetId: 10, title: "Chart", artist: "Artist", creator: "Mapper", version: "4K",
  status: "graveyard", keyCount: 4, stars: 8, bpm: 180, length: 120, playCount: 10,
  lnCount: 900, primaryPattern: "ln", patterns: { ln: 1 }, covers: null,
  msd: { Overall: 21.4, Stamina: 21.01, Jumpstream: 20.92, LN: 22.29 },
  dan: { rawDan: 9.2, label: "9", family: "ln" }, vibro: false,
};

function headline(): string {
  return screen.getByText("Overall").previousElementSibling?.textContent ?? "";
}

it("headlines the LN value on a 4K LN chart when it is the hardest axis", () => {
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={LN_ENTRY} /></I18nProvider>);
  expect(headline()).toBe("22.29");
  expect(screen.getByTitle("Mania Tracker LN estimate: release timing, held-finger coordination and recovery. An independent model alongside MinaCalc.")).toBeTruthy();
});

it("keeps Overall as the headline on a rice chart", () => {
  const entry = { ...LN_ENTRY, lnCount: 0, primaryPattern: "jack", patterns: { jack: 1 }, dan: null, msd: { Overall: 21.4, Stream: 20, LN: 0 } };
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={entry} /></I18nProvider>);
  expect(headline()).toBe("21.40");
});

it("follows the rate-adjusted values when a play used a rate mod", () => {
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={LN_ENTRY} rate={1.5} rateMsd={{ Overall: 27.1, LN: 25.2 }} rateDan={{ label: "11", family: "ln", rawDan: 11.1 }} /></I18nProvider>);
  expect(headline()).toBe("27.10");
});

it("shows the other side's dan beside the primary on a rice-and-LN hybrid", () => {
  const entry = { ...LN_ENTRY, primaryPattern: "tech", patterns: { tech: 1, ln: 0.9 }, dan: { rawDan: 18.1, label: "delta-", family: "dan" } };
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={entry} secondaryDan={{ label: "15--", family: "ln", rawDan: 14.6 }} /></I18nProvider>);
  // One badge: the primary at full size with the other side's chip on its
  // corner, labelled as a hybrid rather than as two estimates.
  expect(screen.getByAltText("delta-")).toBeTruthy();
  expect(screen.getByAltText("15--")).toBeTruthy();
  expect(screen.getByText("hybrid")).toBeTruthy();
  expect(screen.queryByText("dan est.")).toBeNull();
  expect(screen.queryByText("LN dan est.")).toBeNull();
  expect(screen.getByTitle("Hybrid chart: regular delta-, LN 15--")).toBeTruthy();
});

it("keeps one badge under a rate mod, whose analysis carries only its own primary", () => {
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={LN_ENTRY} rate={1.5} rateMsd={{ Overall: 27.1, LN: 25.2 }} rateDan={{ label: "11", family: "ln", rawDan: 11.1 }} secondaryDan={{ label: "theta", family: "dan", rawDan: 18 }} /></I18nProvider>);
  expect(screen.getByText("LN dan est.")).toBeTruthy();
  expect(screen.queryByText("hybrid")).toBeNull();
});
