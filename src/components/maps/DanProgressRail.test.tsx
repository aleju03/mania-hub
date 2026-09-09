// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { getI18n } from "#/lib/i18n";
import { DanProgressRail, danRailWindow } from "./DanProgressRail";

afterEach(cleanup);

it("frames a verdict with one course of context on each side", () => {
  expect(danRailWindow("reform", [12.23, 12.38])).toEqual({ lo: 10.5, hi: 13.5 });
});

it("keeps three bands at the ends of a ladder", () => {
  expect(danRailWindow("reform", [1.1])).toEqual({ lo: 0.5, hi: 3.5 });
  expect(danRailWindow("7k", [14.4])).toEqual({ lo: 11.5, hi: 14.5 });
});

it("never runs past the ladder's own ends", () => {
  expect(danRailWindow("ln", [17.9])).toEqual({ lo: 14.5, hi: 17.5 });
  expect(danRailWindow("6k", [0.2])).toEqual({ lo: -0.5, hi: 2.5 });
});

it("spans both marks when the credit sits a level above the chart", () => {
  expect(danRailWindow("reform", [9.8, 11.2])).toEqual({ lo: 8.5, hi: 12.5 });
});

it("names the credited level and the chart estimate", () => {
  render(<I18nProvider i18n={getI18n("en")}>
    <DanProgressRail context="reform" chart={12.23} chartLabel="beta+" landed={12.38} landedLabel="beta++" />
  </I18nProvider>);
  expect(screen.getByText("Beta++")).toBeTruthy();
  expect(screen.getByText("12.38")).toBeTruthy();
  expect(screen.getByText("Your credit")).toBeTruthy();
  expect(screen.getByText("Beta+")).toBeTruthy();
  expect(screen.getByText("12.23")).toBeTruthy();
  expect(screen.getByText("Chart estimate")).toBeTruthy();
});

it("says a rejected clear credits nothing and draws no landed mark", () => {
  render(<I18nProvider i18n={getI18n("en")}>
    <DanProgressRail context="reform" chart={12.23} chartLabel="beta+" landed={12.38} landedLabel="beta++" rejected />
  </I18nProvider>);
  expect(screen.getByText("No dan credit")).toBeTruthy();
  expect(screen.queryByText("12.38")).toBeNull();
  expect(screen.queryByTestId("dan-credit-connector")).toBeNull();
});

it("puts Beta-- above the Alpha/Beta boundary", () => {
  render(<I18nProvider i18n={getI18n("en")}>
    <DanProgressRail context="reform" chart={11.41} chartLabel="alpha++" landed={11.53} landedLabel="beta--" />
  </I18nProvider>);
  const range = danRailWindow("reform", [11.41, 11.53]);
  const boundary = (11.5 - range.lo) / (range.hi - range.lo) * 100;
  expect(parseFloat(screen.getByTestId("dan-credit-marker").style.bottom)).toBeGreaterThan(boundary);
  expect(parseFloat(screen.getByTestId("dan-chart-marker").style.bottom)).toBeLessThan(boundary);
  expect(screen.getByText("11.5–12.5")).toBeTruthy();
  expect(screen.getByText("Beta--")).toBeTruthy();
});

it.each([[9.57, 9.76], [10.1, 9.7], [10, 10]])("colors only the change from %s to %s", (chart, landed) => {
  render(<I18nProvider i18n={getI18n("en")}>
    <DanProgressRail context="reform" chart={chart} landed={landed} />
  </I18nProvider>);
  const connector = screen.getByTestId("dan-credit-connector");
  const range = danRailWindow("reform", [chart, landed]);
  expect(parseFloat(connector.style.bottom)).toBeCloseTo((Math.min(chart, landed) - range.lo) / (range.hi - range.lo) * 100);
  expect(parseFloat(connector.style.height)).toBeCloseTo(Math.abs(landed - chart) / (range.hi - range.lo) * 100);
});
