// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LivePlayerDanCourseEvidence } from "#/lib/live-backend";

const { fetchEvidence } = vi.hoisted(() => ({ fetchEvidence: vi.fn() }));
vi.mock("#/lib/live-backend", () => ({
  fetchLivePlayerDanEvidenceDirect: fetchEvidence,
  loadLiveMapSearchEntry: vi.fn(), peekLiveMapSearchEntry: vi.fn(), prefetchLiveMapSearchEntry: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("../maps/MapDetailModal", () => ({ MapDetailModal: () => null }));
vi.mock("./SkillPlaysModal", () => ({ rateModFor: () => null, stubEntry: () => null }));
vi.mock("../../lib/locale-context", () => ({ useLocale: () => "en" }));

afterEach(cleanup);

it("shows and opens a certified skillset when there are no algorithmic clears", async () => {
  const credential: LivePlayerDanCourseEvidence = {
    beatmapId: 999, beatmapsetId: null, courseName: "Aquaris ~ Delta ~", title: "Aquaris", artist: "CROOVE", version: "1.3x",
    level: "delta", rawDan: 14, label: "delta", accuracy: 0.96, currency: "stable", bar: 0.96, displayedAccuracy: null,
    beatmapStatus: "graveyard", scoreId: 900, soloScoreId: 900, legacyScoreId: null, mods: [], statistics: null,
    maxCombo: null, totalScore: null, rank: "S", playedAt: null, hasReplay: false, isLazer: false,
  };
  fetchEvidence.mockResolvedValue({ side: "rc", keyCount: 4, quorum: 4, minAccuracy: 0.91, barAccuracy: 0.96,
    averageWindow: 20, dan: null, totalClears: 0, weightedClears: 0, pendingPlays: 0, clears: [], courseClear: null,
    anchorSkillset: null, skillsets: [{ id: "jack", clears: 0, weightedClears: 0, dan: { rawDan: 14, label: "delta" }, plays: [], skillsetClear: credential }] });
  const onOpenCourseScore = vi.fn();
  const { DanEvidenceModal } = await import("./DanEvidenceModal");
  render(<I18nProvider i18n={getI18n("en")}><DanEvidenceModal userId={42} username="Player" keyCount={4} side="rc"
    onClose={() => {}} onOpenCourseScore={onOpenCourseScore} /></I18nProvider>);
  const button = await screen.findByRole("button", { name: /Jack.*delta.*Verified clear/i });
  expect(screen.queryByText("No qualifying clears yet")).toBeNull();
  fireEvent.click(button);
  // The credential is one row in the clears list, not a panel above it: the
  // chart, what it granted, and a click through to the score.
  const row = await screen.findByRole("button", { name: /Aquaris.*1\.3x.*96.*delta/i });
  fireEvent.click(row);
  expect(onOpenCourseScore).toHaveBeenCalledWith(credential);
});

it("unfolds the plays still analyzing from the count line, with why each waits", async () => {
  const play = (beatmapId: number, title: string, playedAt: string) => ({
    beatmapId, beatmapsetId: null, title, artist: "Artist", creator: null, version: "Hard", coverUrl: null, beatmapStatus: "ranked",
    keyCount: 4, rating: 0, overallRating: 0, ratingExcluded: true, ratingExclusionReason: "pending_calibration" as const,
    pp: 50, accuracy: 0.97, rate: 1, mods: [], source: "top" as const, playedAt, scoreId: beatmapId, soloScoreId: null,
    legacyScoreId: null, isLazer: false, hasReplay: false, patterns: [],
  });
  fetchEvidence.mockResolvedValue({ side: "rc", keyCount: 4, quorum: 4, minAccuracy: 0.91, barAccuracy: 0.96,
    averageWindow: 20, dan: null, totalClears: 0, weightedClears: 0, pendingPlays: 3, clears: [], courseClear: null,
    anchorSkillset: null, skillsets: [],
    pending: [
      { play: play(11, "Fresh Check", "2026-09-17T10:00:00Z"), reason: "revision" },
      { play: play(12, "Next Pass", "2026-09-17T09:00:00Z"), reason: "calc_budget" },
    ] });
  const { DanEvidenceModal } = await import("./DanEvidenceModal");
  render(<I18nProvider i18n={getI18n("en")}><DanEvidenceModal userId={42} username="Player" keyCount={4} side="rc"
    onClose={() => {}} onOpenCourseScore={() => {}} /></I18nProvider>);
  // Only the count is the link, not the whole sentence.
  const link = await screen.findByRole("button", { name: "3 plays" });
  expect(screen.queryByText("Fresh Check")).toBeNull();
  fireEvent.click(link);
  const fresh = await screen.findByRole("button", { name: /Fresh Check.*chart changed on osu!, waiting for a fresh check/i });
  expect(fresh).toBeTruthy();
  expect(screen.getByRole("button", { name: /Next Pass.*waiting for the next rating pass/i })).toBeTruthy();
  // Two of three listed: the cap is said out loud.
  expect(screen.getByText("Showing the newest 2.")).toBeTruthy();
  // The list took the breakdown's place; Back restores it.
  expect(screen.queryByText("No qualifying clears yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Back/ }));
  expect(await screen.findByText("No qualifying clears yet")).toBeTruthy();
  expect(screen.queryByText("Fresh Check")).toBeNull();
});
