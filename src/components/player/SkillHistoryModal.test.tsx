// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";
import type { LivePlayerSkillHistorySnapshot } from "../../lib/live-backend";
import { SkillHistoryButton } from "./SkillHistoryButton";
import { SkillHistoryModal } from "./SkillHistoryModal";

const fetchHistory = vi.hoisted(() => vi.fn());
const authFlags = vi.hoisted(() => ({ canUseAdminFeatures: true, canUseDevFeatures: false }));
vi.mock("../../lib/live-backend", () => ({ fetchLivePlayerSkillHistoryDirect: fetchHistory }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => authFlags }));
vi.mock("../../store", () => ({ useNoDans: () => false }));

beforeAll(async () => {
  await loadLocaleCatalog("en");
  window.scrollTo = vi.fn();
});
beforeEach(() => {
  fetchHistory.mockReset();
  authFlags.canUseAdminFeatures = true;
  authFlags.canUseDevFeatures = false;
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function snapshot(overall: number, ln: number): LivePlayerSkillHistorySnapshot {
  return { ratings: { Overall: overall, "pattern:ln": ln }, dan: { rc: null, ln: null } };
}

/** Day rows only, leaving out the rating-system notes between them. */
function ratingRows(container: HTMLElement) {
  return [...container.querySelectorAll("li")].filter((row) => row.querySelector("time"));
}

describe("skill history", () => {
  it("shows compact changes and only reveals skill details when a row is opened", async () => {
    fetchHistory.mockResolvedValue({ items: [{ id: 2, recordedAt: "2026-09-04T12:30:00Z", version: 24,
      snapshot: snapshot(25.7, 25.42), previous: snapshot(25.5, 25.2) }], nextBefore: null });
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryButton userId={99} keyCount={7} /></I18nProvider>);
    expect(fetchHistory).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "View 7K skill history" }));
    await waitFor(() => expect(view.getByText("+0.20")).toBeTruthy());
    expect(view.getByRole("dialog", { name: "7K skill history" })).toBeTruthy();
    expect(fetchHistory).toHaveBeenCalledWith(99, 7, { before: undefined, signal: expect.any(AbortSignal) });
    expect(view.queryByText("25.50 →")).toBeNull();
    expect(view.queryByText("LN")).toBeNull();
    fireEvent.click(view.getByRole("button", { expanded: false }));
    expect(view.getByText("LN")).toBeTruthy();
    expect(view.getByText("+0.22")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(view.getByRole("button", { name: "View 7K skill history" }));
    expect(document.body.style.overflow).toBe("");
  });

  it("retains the loaded history when an older page fails and retries that cursor", async () => {
    fetchHistory.mockResolvedValueOnce({ items: [{ id: 2, recordedAt: "2026-09-04T12:30:00Z", version: 24,
      snapshot: snapshot(25, 24), previous: snapshot(26, 24) }], nextBefore: 2 })
      // The initial load peeks at the next page to finish its last day.
      .mockResolvedValueOnce({ items: [{ id: 1, recordedAt: "2026-09-03T12:00:00Z", version: 24,
        snapshot: snapshot(26, 24), previous: null }], nextBefore: null })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [{ id: 1, recordedAt: "2026-09-03T12:00:00Z", version: 24,
        snapshot: snapshot(26, 24), previous: null }], nextBefore: null });
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryModal userId={99} keyCount={7} onClose={() => {}} /></I18nProvider>);
    await waitFor(() => expect(view.getByText("-1.00")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Load older changes" }));
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(view.getByText("25.00")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(view.getByText("Starting rating")).toBeTruthy());
    expect(fetchHistory).toHaveBeenLastCalledWith(99, 7, { before: 2, signal: expect.any(AbortSignal) });
    expect(view.queryByRole("button", { name: "Load older changes" })).toBeNull();
  });

  it("handles the empty state and dismisses through Escape", async () => {
    fetchHistory.mockResolvedValue({ items: [], nextBefore: null });
    const onClose = vi.fn();
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryModal userId={99} keyCount={4} onClose={onClose} /></I18nProvider>);
    await waitFor(() => expect(view.getByText("No skill ratings have been recorded yet.")).toBeTruthy());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens the actual window immediately with skeleton rows while the request is pending", () => {
    fetchHistory.mockReturnValue(new Promise(() => {}));
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryButton userId={99} keyCount={7} /></I18nProvider>);
    fireEvent.click(view.getByRole("button", { name: "View 7K skill history" }));
    expect(view.getByRole("dialog", { name: "7K skill history" })).toBeTruthy();
    expect(view.getByRole("status", { name: "Loading history…" }).querySelectorAll(".skeleton-pulse")).toHaveLength(18);
    expect(view.getByText("Rating")).toBeTruthy();
    expect(view.queryByText("Loading…")).toBeNull();
  });

  it("previews realistic gains and drops locally and restores the real history", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 8, 6, 12).getTime());
    fetchHistory.mockResolvedValue({ items: [{ id: 1, recordedAt: "2026-09-04T12:30:00Z", version: 24,
      snapshot: snapshot(25.7, 25.42), previous: null }], nextBefore: null });
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryModal userId={99} keyCount={7} onClose={() => {}} /></I18nProvider>);
    await waitFor(() => expect(ratingRows(view.baseElement as HTMLElement)).toHaveLength(1));
    fireEvent.click(view.getByRole("button", { name: "DEV · Simulate history" }));
    expect(ratingRows(view.baseElement as HTMLElement)).toHaveLength(12);
    expect(view.getAllByText("+0.07").length).toBeGreaterThan(0);
    expect(view.getByText("-0.03")).toBeTruthy();
    expect(view.getByText("25.70")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Show real history" }));
    expect(ratingRows(view.baseElement as HTMLElement)).toHaveLength(1);
    expect(view.getByText("25.70")).toBeTruthy();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("does not expose the simulation button outside development", async () => {
    vi.stubEnv("DEV", false);
    fetchHistory.mockResolvedValue({ items: [], nextBefore: null });
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryModal userId={99} keyCount={7} onClose={() => {}} /></I18nProvider>);
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
    expect(view.queryByRole("button", { name: /Simulate history/ })).toBeNull();
  });

  it("defaults to ratings and shows system changes separately, per keymode", async () => {
    fetchHistory.mockResolvedValue({ items: [{ id: 2, recordedAt: "2026-09-06T12:30:00Z", version: 26,
      snapshot: snapshot(25.7, 25.42), previous: snapshot(25.5, 25.2) }], nextBefore: null });
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryModal userId={99} keyCount={7} onClose={() => {}} /></I18nProvider>);
    await waitFor(() => expect(view.getByText("25.70")).toBeTruthy());
    expect(view.getByRole("button", { name: "History", pressed: true })).toBeTruthy();
    expect(view.queryByText(/Reduced the rice dan penalty/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Changes" }));
    expect(view.getByText(/Reduced the rice dan penalty/)).toBeTruthy();
    expect(view.queryByText("25.70")).toBeNull();
    expect(view.queryByText(/Adjusted 4K vibro detection/)).toBeNull();
    const rows = [...view.baseElement.querySelectorAll("li")];
    expect(rows[0].textContent).toContain("Reduced the rice dan penalty");
    expect(view.getByText("2026-09-06")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "History" }));
    expect(view.getByText("25.70")).toBeTruthy();
    expect(view.queryByText(/Reduced the rice dan penalty/)).toBeNull();
    expect(fetchHistory).toHaveBeenCalledTimes(1);

    cleanup();
    const fourKey = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryModal userId={99} keyCount={4} onClose={() => {}} /></I18nProvider>);
    fireEvent.click(fourKey.getByRole("button", { name: "Changes" }));
    expect(fourKey.getByText(/Adjusted 4K vibro detection/)).toBeTruthy();
  });

  it("shows system changes even when the player has no recorded history", async () => {
    fetchHistory.mockResolvedValue({ items: [], nextBefore: null });
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryModal userId={99} keyCount={4} onClose={() => {}} /></I18nProvider>);
    await waitFor(() => expect(view.getByText("No skill ratings have been recorded yet.")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Changes" }));
    expect(view.getByText(/Adjusted 4K vibro detection/)).toBeTruthy();
    expect(view.queryByText("No skill ratings have been recorded yet.")).toBeNull();
    expect(view.queryByRole("button", { name: "DEV · Simulate history" })).toBeNull();
  });

  it("opens history for non-admin viewers", async () => {
    fetchHistory.mockResolvedValue({ items: [], nextBefore: null });
    authFlags.canUseAdminFeatures = false;
    authFlags.canUseDevFeatures = false;
    const view = render(<I18nProvider i18n={getI18n("en")}><SkillHistoryButton userId={99} keyCount={7} /></I18nProvider>);
    fireEvent.click(view.getByRole("button", { name: "View 7K skill history" }));
    await waitFor(() => expect(view.getByText("No skill ratings have been recorded yet.")).toBeTruthy());
  });

  it("keeps history open when admin access is lost", async () => {
    fetchHistory.mockResolvedValue({ items: [], nextBefore: null });
    const content = () => <I18nProvider i18n={getI18n("en")}><SkillHistoryButton userId={99} keyCount={7} /></I18nProvider>;
    const view = render(content());
    fireEvent.click(view.getByRole("button", { name: "View 7K skill history" }));
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
    authFlags.canUseAdminFeatures = false;
    view.rerender(content());
    expect(view.getByRole("dialog", { name: "7K skill history" })).toBeTruthy();
    expect(view.getByRole("button", { name: "View 7K skill history" })).toBeTruthy();
  });
});
