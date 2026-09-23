// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import { RecentPlayRatingCells } from "./RecentPlayRatingCells";
import type { RecentPlayRatingView } from "./recent-play-ratings";

afterEach(cleanup);
function draw(rating?: RecentPlayRatingView, options: { hideDan?: boolean; compact?: boolean } = {}) {
  return render(<I18nProvider i18n={getI18n("en")}>
    <RecentPlayRatingCells rating={rating} keyCount={4} hideDan={options.hideDan ?? false} compact={options.compact} />
  </I18nProvider>);
}

it("distinguishes the initial lookup from queued analysis", () => {
  draw();
  expect(screen.getByLabelText("MSD: Loading…")).toBeTruthy();
  expect(screen.getByLabelText("Dan: Loading…")).toBeTruthy();
  expect(screen.queryByText("Pending")).toBeNull();
});

it("keeps an available dan beside pending MSD and explains the wait on tap", () => {
  draw({ msd: null, dan: { rawDan: 5.5, label: "5th", side: "rc" }, pending: true, missing: { msd: "pending" } });
  expect(screen.getByText("5th dan")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "MSD: Pending" }));
  expect(screen.getByRole("tooltip").textContent).toContain("update here automatically");
  fireEvent.keyDown(screen.getByRole("button", { name: "MSD: Pending" }), { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("explains unavailable repeats without promising they will be analyzed", () => {
  draw({ msd: null, dan: null, missing: { msd: "not_retained", dan: "not_analyzed" } }, { compact: true });
  fireEvent.click(screen.getByRole("button", { name: "MSD: Unavailable" }));
  expect(screen.getByRole("tooltip").textContent).toContain("weaker repeat");
  expect(screen.queryByText("Pending")).toBeNull();
});

it("retries a failed lookup without opening the score row", () => {
  const onRetry = vi.fn();
  const rowClick = vi.fn();
  render(<I18nProvider i18n={getI18n("en")}><div onClick={rowClick}>
    <RecentPlayRatingCells rating={{ msd: null, dan: null, loadError: true, onRetry }} keyCount={4} hideDan />
  </div></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "MSD: Retry" }));
  expect(onRetry).toHaveBeenCalledOnce();
  expect(rowClick).not.toHaveBeenCalled();
  expect(screen.queryByText("Dan")).toBeNull();
});

it("shows a ready MSD even while the dan is unavailable", () => {
  draw({ msd: 24.5, dan: null, missing: { dan: "unsupported" } });
  expect(screen.getByText("24.50")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Dan: Unavailable" })).toBeTruthy();
});
