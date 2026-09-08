// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getI18n } from "../../lib/i18n";
import type { LeanTrackerScore } from "../../lib/types";

const { fetchEstimates } = vi.hoisted(() => ({ fetchEstimates: vi.fn() }));
vi.mock("#/lib/live-backend", () => ({ isLiveBackendConfigured: () => true, fetchLiveDanEstimates: fetchEstimates }));
vi.mock("#/lib/osu", () => ({ getDanEstimates: vi.fn() }));
vi.mock("#/store", () => ({ useAppStore: () => true, useNoDans: () => false }));
vi.mock("#/lib/auth-context", () => ({ useAuth: () => ({ canUseDevFeatures: true }) }));
import { DanBadge } from "./DanBadge";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  fetchEstimates.mockReset();
});

function mountBadge(id: number) {
  const score = { beatmap: { id, cs: 4, difficulty_rating: 4 }, mods: [] } as unknown as LeanTrackerScore;
  render(<I18nProvider i18n={getI18n("en")}><DanBadge score={score} /></I18nProvider>);
}

describe("DanBadge refresh", () => {
  const estimate = { label: "8", variant: null, displayName: "8", rawDan: 8, family: "dan", confidence: 0.9, estimatorVersion: 15 };

  it("shows the old result while pending and replaces it when the retry finishes", async () => {
    vi.useFakeTimers();
    fetchEstimates.mockResolvedValueOnce({ results: { "901": estimate }, pending: ["901"] });
    fetchEstimates.mockResolvedValueOnce({ results: { "901": { ...estimate, label: "9", displayName: "9", rawDan: 9, estimatorVersion: 16 } }, pending: [] });
    mountBadge(901);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.getByAltText("8")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1550); });
    expect(screen.getByAltText("9")).toBeTruthy();
    expect(screen.queryByAltText("8")).toBeNull();
    expect(fetchEstimates).toHaveBeenCalledTimes(2);
  });

  it("keeps the last result visible when the bounded retries are exhausted", async () => {
    vi.useFakeTimers();
    fetchEstimates.mockResolvedValue({ results: { "902": estimate }, pending: ["902"] });
    mountBadge(902);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(screen.getByAltText("8")).toBeTruthy();
    expect(fetchEstimates).toHaveBeenCalledTimes(9);
  });
});
