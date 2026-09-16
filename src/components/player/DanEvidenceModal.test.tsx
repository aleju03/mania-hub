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
