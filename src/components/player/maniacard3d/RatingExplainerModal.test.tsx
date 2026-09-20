// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "#/lib/i18n";
import { LocaleContext } from "#/lib/locale-context";
import { intlLocaleTag } from "#/lib/format";
import type { AppLocale } from "#/lib/locale";
import { getNextManiaCardTier } from "#/lib/maniacard";
import type { LiveManiacardHistoryEntry } from "#/lib/live-backend";
import { RatingExplainerModal } from "./RatingExplainerModal";

const fetchHistory = vi.hoisted(() => vi.fn());
vi.mock("#/lib/live-backend", () => ({ fetchLiveManiacardHistoryDirect: fetchHistory }));

beforeAll(async () => {
  await Promise.all((["en", "es", "zh-CN"] as const).map(loadLocaleCatalog));
  window.scrollTo = vi.fn();
});
beforeEach(() => { fetchHistory.mockReset(); });
afterEach(cleanup);

function entry(id = 2): LiveManiacardHistoryEntry {
  return {
    id, recordedAt: "2026-09-19T12:30:00Z", reason: "session", version: 1,
    snapshot: { rating: 475, tier: "legendary", control: 160, speed: 165, precision: 150, keyCount: 4 },
    previous: { rating: 465, tier: "ultraRare", control: 157, speed: 163, precision: 145, keyCount: 4 },
    maps: [{ beatmapId: 123, beatmapsetId: 456, title: "A new top play", difficulty: "4K Challenge", mods: ["DT"], playedAt: "2026-09-19T12:00:00Z", ratingChange: 8 }],
    otherRatingChange: 2,
  };
}

function open(onClose = vi.fn(), rating = 475, locale: AppLocale = "en") {
  return render(<LocaleContext.Provider value={locale}><I18nProvider i18n={getI18n(locale)}><RatingExplainerModal userId={99} cardRating={rating} nextTier={getNextManiaCardTier(rating)} isOwnProfile onClose={onClose} /></I18nProvider></LocaleContext.Provider>);
}

describe("Maniacard progression tab", () => {
  it.each([
    { locale: "es", tab: "Progreso", chart: "Gráfica del historial de rating", promotion: "Ascenso a Legendary", plays: "1 mejor jugada", speed: "Velocidad", impact: "Aporte estimado", pb: "récords personales", difference: "Diferencia: +2" },
    { locale: "zh-CN", tab: "成长记录", chart: "评分历史图表", promotion: "晋升至 Legendary", plays: "1 条最佳成绩", speed: "速度", impact: "预估贡献", pb: "个人最佳（PB）", difference: "差额：+2" },
  ] as const)("translates progression and formats chart/session dates in $locale", async (copy) => {
    const latest = entry();
    const baseline: LiveManiacardHistoryEntry = {
      ...entry(1), recordedAt: "2026-09-18T12:30:00Z", reason: "baseline",
      snapshot: latest.previous!, previous: null, maps: [], otherRatingChange: 0,
    };
    fetchHistory.mockResolvedValue({ items: [latest, baseline], nextBefore: null });
    const view = open(vi.fn(), 475, copy.locale);
    fireEvent.click(view.getByRole("tab", { name: copy.tab }));
    const chart = await view.findByRole("group", { name: copy.chart });
    expect(view.getByText(copy.promotion)).toBeTruthy();
    expect(view.getByText(copy.plays)).toBeTruthy();
    const date = new Date(latest.recordedAt);
    const locale = intlLocaleTag(copy.locale);
    expect(view.baseElement.querySelector(`time[datetime="${latest.recordedAt}"]`)?.textContent)
      .toContain(date.toLocaleDateString(locale, { month: "short", day: "numeric" }));
    fireEvent.click(view.getAllByRole("button", { expanded: false })[0]);
    expect(view.getByText(copy.speed)).toBeTruthy();
    expect(view.getByRole("button", { name: copy.difference })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: copy.impact }));
    expect(view.getByRole("tooltip").textContent).toContain(copy.pb);
    fireEvent.blur(view.getByRole("button", { name: copy.impact }));
    fireEvent.pointerEnter(within(chart).getAllByRole("button").at(-1)!);
    expect(view.getByRole("tooltip").querySelector("time")?.textContent).toBe(date.toLocaleString(locale, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }));
  });

  it("inspects chart points with hover, touch and keyboard, including the starting rating", async () => {
    const latest = entry();
    const baseline: LiveManiacardHistoryEntry = {
      ...entry(1), recordedAt: "2026-09-18T12:30:00Z", reason: "baseline",
      snapshot: latest.previous!, previous: null, maps: [], otherRatingChange: 0,
    };
    fetchHistory.mockResolvedValue({ items: [latest, baseline], nextBefore: null });
    const view = open();
    fireEvent.click(view.getByRole("tab", { name: "Progression" }));
    const chart = await view.findByRole("group", { name: "Rating history chart" });
    const points = within(chart).getAllByRole("button");
    expect(view.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(points[1]);
    let tooltip = view.getByRole("tooltip");
    expect(within(tooltip).getByText("475")).toBeTruthy();
    expect(within(tooltip).getByText("+10 pts")).toBeTruthy();
    expect(within(tooltip).getByText("Legendary")).toBeTruthy();
    expect(tooltip.querySelector("time")?.dateTime).toBe(latest.recordedAt);
    fireEvent.pointerLeave(chart);
    expect(view.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerDown(points[0], { pointerType: "touch" });
    fireEvent.click(points[0]);
    fireEvent.pointerLeave(chart);
    tooltip = view.getByRole("tooltip");
    expect(within(tooltip).getByText("465")).toBeTruthy();
    expect(within(tooltip).getByText("Starting rating")).toBeTruthy();
    expect(within(tooltip).queryByText("+0 pts")).toBeNull();

    fireEvent.keyDown(points[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(points[1]);
    expect(within(view.getByRole("tooltip")).getByText("475")).toBeTruthy();
    fireEvent.keyDown(points[1], { key: "Home" });
    expect(document.activeElement).toBe(points[0]);
    expect(within(view.getByRole("tooltip")).getByText("465")).toBeTruthy();
    fireEvent.blur(points[0]);
    expect(view.queryByRole("tooltip")).toBeNull();
    expect(fetchHistory).toHaveBeenCalledOnce();
  });

  it("loads on demand, shows tier changes and expands map estimates without refetching on tab switches", async () => {
    fetchHistory.mockResolvedValue({ items: [entry()], nextBefore: null });
    const view = open();
    expect(view.getByRole("tab", { name: "Card rank", selected: true })).toBeTruthy();
    expect(fetchHistory).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("tab", { name: "Progression" }));
    await waitFor(() => expect(view.getByText("+10 pts")).toBeTruthy());
    expect(fetchHistory).toHaveBeenCalledWith(99, { before: undefined, signal: expect.any(AbortSignal) });
    expect(view.getByText("Promoted to Legendary")).toBeTruthy();
    expect(view.queryByText("A new top play")).toBeNull();
    fireEvent.click(view.getByRole("button", { expanded: false }));
    expect(view.queryByRole("link", { name: /A new top play/ })).toBeNull();
    fireEvent.click(view.getByText("A new top play"));
    expect(view.getByRole("dialog", { name: "Maniacard" })).toBeTruthy();
    expect(view.getByText("+8")).toBeTruthy();
    expect(view.getByText("A new top play").closest("li")?.querySelector("img")?.getAttribute("src")).toBe("https://assets.ppy.sh/beatmaps/456/covers/card.jpg");
    expect(view.getByTitle("DT")).toBeTruthy();
    expect(view.getByRole("button", { name: "Difference: +2" })).toBeTruthy();
    expect(view.queryByRole("tooltip")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Estimated impact" }));
    expect(view.getByRole("tooltip").textContent).toContain("Includes new top plays and PBs on existing maps.");
    expect(view.getByRole("tooltip").textContent).toContain("The session total is the recorded rating change.");
    fireEvent.blur(view.getByRole("button", { name: "Estimated impact" }));
    fireEvent.click(view.getByRole("button", { name: "Difference: +2" }));
    expect(view.getByRole("tooltip").textContent).toContain("The session changed by +10 points; the map estimates add up to +8.");
    fireEvent.blur(view.getByRole("button", { name: "Difference: +2" }));
    fireEvent.click(view.getByRole("tab", { name: "Card rank" }));
    fireEvent.click(view.getByRole("tab", { name: "Progression" }));
    expect(fetchHistory).toHaveBeenCalledOnce();
    expect(view.getByText("A new top play")).toBeTruthy();
  });

  it("preserves existing rows and retries the same older cursor after a failure", async () => {
    fetchHistory.mockResolvedValueOnce({ items: [entry()], nextBefore: 2 })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [{ ...entry(1), previous: null, maps: [], otherRatingChange: 0 }], nextBefore: null });
    const view = open();
    fireEvent.click(view.getByRole("tab", { name: "Progression" }));
    await waitFor(() => expect(view.getByText("+10 pts")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Load older changes" }));
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(view.getByText("+10 pts")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(view.getByText("Starting rating")).toBeTruthy());
    expect(fetchHistory).toHaveBeenLastCalledWith(99, { before: 2, signal: expect.any(AbortSignal) });
  });

  it("shows a loading state at the maximum tier and cancels a pending fetch when closed", () => {
    fetchHistory.mockReturnValue(new Promise(() => {}));
    const view = open(vi.fn(), 700);
    fireEvent.click(view.getByRole("tab", { name: "Progression" }));
    expect(view.getByRole("status", { name: "Loading history…" })).toBeTruthy();
    const signal = fetchHistory.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("supports keyboard tabs and Escape, and restores focus and page scrolling", async () => {
    fetchHistory.mockResolvedValue({ items: [], nextBefore: null });
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = open(onClose);
    expect(view.getByRole("dialog", { name: "Maniacard" })).toBeTruthy();
    fireEvent.keyDown(view.getByRole("tab", { name: "Card rank" }), { key: "ArrowRight" });
    await waitFor(() => expect(view.getByText("No Maniacard history has been recorded yet.")).toBeTruthy());
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Progression", selected: true }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
    opener.remove();
  });
});
