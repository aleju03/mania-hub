// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LiveMapSearchEntry } from "#/lib/live-backend";
import { MsdBlock } from "./MapDetailModal";

// The 4K LN number shows with the 4K LN model on; these read it on unless a
// test turns it off.
let showLn = true;
vi.mock("../../store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../store")>()),
  useExperimentalLn: () => showLn,
}));

afterEach(() => {
  cleanup();
  showLn = true;
});

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

it("headlines native Overall and leaves LN out with the 4K LN model off", () => {
  showLn = false;
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={LN_ENTRY} /></I18nProvider>);
  expect(headline()).toBe("21.40");
  expect(screen.queryByText("22.29")).toBeNull();
});

it("shows only one LN MSD even when cached values contain Dan family ratings", () => {
  const entry = { ...LN_ENTRY, msd: { ...LN_ENTRY.msd, LNHybrid: 11, LNTechnical: 18, LNWalls: 9, LNSpeed: 6 } };
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={entry} /></I18nProvider>);
  for (const [label, value] of [["LN All-round", "11.00"], ["LN Technical", "18.00"], ["LN Walls", "9.00"], ["LN Speed", "6.00"]]) {
    expect(screen.queryByText(label)).toBeNull();
    expect(screen.queryByText(value)).toBeNull();
  }
  expect(headline()).toBe("22.29");
});

it("keeps Overall as the headline on a rice chart", () => {
  const entry = { ...LN_ENTRY, lnCount: 0, primaryPattern: "jack", patterns: { jack: 1 }, dan: null, msd: { Overall: 21.4, Stream: 20, LN: 0 } };
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={entry} /></I18nProvider>);
  expect(headline()).toBe("21.40");
});

it("prefers fresh analysis over a cached map entry, including its LN identity", () => {
  const stale = { ...LN_ENTRY, primaryPattern: "tech", dan: null, msd: { Overall: 20, LN: 10 }, msdLn: { Overall: 21, LN: 11 } };
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={stale} analysisMsd={{ Overall: 22, LN: 25 }}
    analysisLnIdentity={true} analysisDan={{ label: "9", family: "ln", rawDan: 9 }} /></I18nProvider>);
  expect(headline()).toBe("25.00");
  expect(screen.getByText("LN").previousElementSibling?.textContent).toBe("25.00");
  expect(screen.getByText("LN dan est.")).toBeTruthy();
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

it("keeps one badge under a rate mod unless the chart is a hybrid at 1.0x and at that rate", () => {
  const { unmount } = render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={LN_ENTRY} rate={1.5} rateMsd={{ Overall: 27.1, LN: 25.2 }} rateDan={{ label: "11", family: "ln", rawDan: 11.1 }} secondaryDan={{ label: "theta", family: "dan", rawDan: 18 }} /></I18nProvider>);
  expect(screen.getByText("LN dan est.")).toBeTruthy();
  expect(screen.queryByText("hybrid")).toBeNull();
  unmount();
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={LN_ENTRY} rate={1.5} rateMsd={{ Overall: 27.1, LN: 25.2 }} rateDan={{ label: "11", family: "ln", rawDan: 11.1 }} secondaryDan={{ label: "theta", family: "dan", rawDan: 18 }} rateSecondaryDan={{ label: "zeta", family: "dan", rawDan: 16 }} /></I18nProvider>);
  expect(screen.getByTitle("Hybrid chart: LN 11, regular zeta")).toBeTruthy();
  cleanup();
  render(<I18nProvider i18n={getI18n("en")}><MsdBlock entry={LN_ENTRY} rate={1.5} rateMsd={{ Overall: 27.1, LN: 25.2 }} rateDan={{ label: "11", family: "ln", rawDan: 11.1 }} rateSecondaryDan={{ label: "zeta", family: "dan", rawDan: 16 }} /></I18nProvider>);
  expect(screen.queryByText("hybrid")).toBeNull();
});
