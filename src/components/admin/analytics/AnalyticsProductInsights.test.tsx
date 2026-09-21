// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../../lib/i18n";
import type { AnalyticsProductInsights as ProductData } from "../../../../live-backend/src/shared/analytics-insights";
import { AnalyticsProductInsights } from "./AnalyticsProductInsights";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../../lib/analytics-monitor-data", () => ({ getAnalyticsProductInsights: read }));

const NOW = Date.UTC(2026, 8, 21);
const DAY = 86_400_000;
const data: ProductData = {
  generatedAt: NOW, historySince: NOW - 90 * DAY, coverageSince: NOW - 90 * DAY,
  weekStart: NOW - 7 * DAY, weekEnd: NOW, acquisitionStart: NOW - 28 * DAY,
  weeklyVisitors: 10, previousWeeklyVisitors: 8, newVisitors: 3, returningVisitors: 7,
  daily: [{ day: NOW - DAY, visitors: 10, newVisitors: 3 }],
  cohorts: [{ week: NOW - 14 * DAY, newcomers: 8, returned: 4 }, { week: NOW - 7 * DAY, newcomers: 3, returned: null }],
  features: [{ feature: "packs", visitors: 10, previousVisitors: 8, repeatVisitors: 4, actionVisitors: 3, retentionEligible: 8, retained: 4 }],
  acquisition: [{ source: "discord", medium: "community", campaign: "launch", landing: "/packs", visitors: 10, actionVisitors: 3, retentionEligible: 8, retained: 4 }],
  reliability: [
    { feature: "replay", device: "mobile", release: "v2.200", visitors: 10, affectedVisitors: 1, errors: 3 },
    { feature: "packs", device: "desktop", release: "v2.201", visitors: 8, affectedVisitors: 0, errors: 0 },
  ],
  loads: [{ operation: "Replay data load", device: "mobile", release: "v2.200", attempts: 10, failures: 2, affectedVisitors: 1, successfulSamples: 8, p50Ms: 1000, p75Ms: 2000, p95Ms: 4000 }],
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows pending cohorts, acquisition quality and filterable reliability with denominators", async () => {
  read.mockResolvedValue({ state: "fresh", data });
  render(<I18nProvider i18n={getI18n("en")}><AnalyticsProductInsights /></I18nProvider>);
  expect(await screen.findByText("Still observing")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Repeat" }));
  expect(screen.getByText("4 of 10 visitors · 40%")).toBeTruthy();
  expect(screen.getByText("discord")).toBeTruthy();
  expect(screen.getByText("community · launch")).toBeTruthy();
  expect(screen.getByText("4 of 8")).toBeTruthy();
  expect(screen.getByText("1 of 10 · 3 errors")).toBeTruthy();
  expect(screen.getByText("20% failed · 2 of 10")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Device" }));
  fireEvent.click(screen.getByRole("option", { name: "Desktop" }));
  const health = within(screen.getByRole("region", { name: "Affected visitors" }));
  expect(health.queryByText("Replays")).toBeNull();
  expect(health.getByText("Packs")).toBeTruthy();
  expect(screen.getByText("No load measurements for these filters yet.")).toBeTruthy();
  const help = screen.getByRole("button", { name: "About browser health" });
  expect(help.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(help);
  expect(help.getAttribute("aria-expanded")).toBe("true");
});

it("does not display a failed refresh as zero visitors", async () => {
  read.mockResolvedValue({ state: "error", data: null });
  render(<AnalyticsProductInsights />);
  expect(await screen.findByText(/Could not refresh audience analytics/)).toBeTruthy();
  expect(screen.queryByText("First seen")).toBeNull();
});
