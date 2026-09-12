// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getI18n } from "../../lib/i18n";
import type { MyDataSkillBreakdown, MyDataSkillMode, MyDataSummary } from "../../lib/my-data";

const mocks = vi.hoisted(() => ({
  viewer: { id: 123, username: "player", countryCode: "CR", avatarUrl: null } as { id: number; username: string; countryCode: string; avatarUrl: null } | null,
  noDans: false,
  dashboard: vi.fn(),
  insights: vi.fn(),
  skills: vi.fn(),
  feed: vi.fn(),
  top: vi.fn(),
  explorer: vi.fn(),
}));

vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ viewer: mocks.viewer }) }));
vi.mock("../../store", () => ({ useNoDans: () => mocks.noDans }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/my-stats", searchStr: "" }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../lib/my-data", () => ({
  fetchMyDataDashboard: mocks.dashboard,
  fetchMyDataInsights: mocks.insights,
  fetchMyDataSkills: mocks.skills,
  fetchMyDataFeed: mocks.feed,
  fetchMyDataTopPlays: mocks.top,
  MY_DATA_PAGE_SIZE: 50,
}));
vi.mock("../../lib/live-backend", () => ({ openLiveEventSource: () => null }));
vi.mock("../layout/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../ui/Avatar", () => ({ Avatar: () => null }));
vi.mock("../ui/CountryFlag", () => ({ CountryFlag: () => null }));
vi.mock("./RosterOptInCard", () => ({ RosterOptInCard: () => <div>Opt in</div> }));
vi.mock("./MeScoreRow", () => ({ MeScoreRow: () => null }));
vi.mock("./MyStatsInsights", () => ({
  compact: (value: number) => String(value),
  formatDay: (value: string) => value,
  InsightCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KEY_LABEL: {},
  PlayDietCard: () => null,
  SessionShapeCard: () => null,
  JudgementCard: () => null,
}));
vi.mock("../player/SkillBreakdown", () => ({ SkillBreakdownBody: () => <div>Skill rating</div> }));
vi.mock("../player/DanEvidenceModal", () => ({ DanEvidenceModal: () => null }));
vi.mock("../player/SkillPlaysExplorer", () => ({
  SkillPlaysExplorer: (props: { userId: number; username: string; modes: MyDataSkillMode[]; view: string }) => {
    mocks.explorer(props);
    return <div data-testid="skills-explorer">{props.view}<input aria-label="Explorer selection" defaultValue="" /></div>;
  },
}));

const { MyDataPanel } = await import("./MyDataPanel");

const mode: MyDataSkillMode = { keyCount: 4, analyzedPlays: 60, ratings: { Overall: 30 }, patterns: [] };
const readySkills: MyDataSkillBreakdown = {
  status: "ready", version: 1, computedAt: "2026-09-12T00:00:00Z",
  totalPlays: 60, analyzedPlays: 60, pendingPlays: 0, unsupportedPlays: 0, modes: [mode],
};
const summary: MyDataSummary = {
  userId: 123, username: "player", avatarUrl: null, coverUrl: null, countryCode: "CR",
  pp: null, globalRank: null, countryRank: null, tracked: true, rankedMember: true,
  trackedCountries: ["CR"], totalScores: 0, passedScores: 0, activeDays: 0, sessions: 0,
  firstTrackedDay: null, lastTrackedDay: null, topPlayCount: 0,
  highlights: { topPlay: null, biggestDay: null, longestStreak: 0, longestStreakRange: null, ppGainedTracked: 0 },
  rhythm: { timezone: "UTC", sampleSize: 0, byHour: [], byDay: [], peakHour: null, peakDay: null },
  mods: { sample: 0, noModPct: 0, top: [] }, keyStats: [], goalsOpen: 0, goalsCompleted: 0,
  generatedAt: "2026-09-12T00:00:00Z",
};
const emptyPage = { items: [], total: 0, limit: 50, offset: 0 };
const dashboard = { summary, skills: readySkills, trackedPage: emptyPage, topPlayPage: emptyPage };
const panel = () => <I18nProvider i18n={getI18n("en")}><MyDataPanel /></I18nProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewer = { id: 123, username: "player", countryCode: "CR", avatarUrl: null };
  mocks.noDans = false;
  mocks.dashboard.mockResolvedValue(dashboard);
  mocks.insights.mockResolvedValue(null);
  mocks.feed.mockResolvedValue(emptyPage);
  mocks.top.mockResolvedValue(emptyPage);
});
afterEach(cleanup);

it("opens the shared explorer only on selection and preserves it between MSD and Dan", async () => {
  render(panel());
  const msd = await screen.findByRole("button", { name: "MSD plays" });
  expect(mocks.explorer).not.toHaveBeenCalled();
  fireEvent.click(msd);
  expect(mocks.explorer).toHaveBeenLastCalledWith({ userId: 123, username: "player", modes: [mode], view: "msd" });
  expect(screen.queryByRole("textbox", { name: "Search maps" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Explorer selection" }), { target: { value: "keep" } });
  fireEvent.click(screen.getByRole("button", { name: "Dan plays" }));
  expect(mocks.explorer).toHaveBeenLastCalledWith({ userId: 123, username: "player", modes: [mode], view: "dan" });
  expect((screen.getByRole("textbox", { name: "Explorer selection" }) as HTMLInputElement).value).toBe("keep");
  expect(mocks.feed).not.toHaveBeenCalled();
  expect(mocks.top).not.toHaveBeenCalled();
});

it("preserves tracked filters across skills views without refetching the feed", async () => {
  render(panel());
  await screen.findByRole("button", { name: "MSD plays" });
  fireEvent.change(screen.getByRole("textbox", { name: "Search maps" }), { target: { value: "query" } });
  await waitFor(() => expect(mocks.feed).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "MSD plays" }));
  fireEvent.click(screen.getByRole("button", { name: "Tracked" }));
  expect((screen.getByRole("textbox", { name: "Search maps" }) as HTMLInputElement).value).toBe("query");
  expect(mocks.feed).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("skills-explorer")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Top plays" }));
  await waitFor(() => expect(mocks.top).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Dan plays" }));
  fireEvent.click(screen.getByRole("button", { name: "Top plays" }));
  expect(mocks.top).toHaveBeenCalledTimes(1);
});

it.each([
  null,
  { ...readySkills, status: "pending" as const },
  { ...readySkills, status: "failed" as const },
  { ...readySkills, modes: [] },
])("does not offer skill play lists without ready qualifying modes: %j", async (skills) => {
  mocks.dashboard.mockResolvedValue({ ...dashboard, skills });
  render(panel());
  await screen.findByRole("button", { name: "Tracked" });
  expect(screen.queryByRole("button", { name: "MSD plays" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dan plays" })).toBeNull();
  expect(mocks.explorer).not.toHaveBeenCalled();
});

it("hides Dan and returns to the feed when the no-dans preference changes", async () => {
  const { rerender } = render(panel());
  fireEvent.click(await screen.findByRole("button", { name: "Dan plays" }));
  mocks.noDans = true;
  rerender(panel());
  expect(screen.queryByRole("button", { name: "Dan plays" })).toBeNull();
  expect(screen.queryByTestId("skills-explorer")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Search maps" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "MSD plays" }));
  expect(screen.getByTestId("skills-explorer").textContent).toBe("msd");
});

it("resets the selected skills view when the signed-in viewer changes", async () => {
  const { rerender } = render(panel());
  fireEvent.click(await screen.findByRole("button", { name: "MSD plays" }));
  mocks.viewer = { id: 456, username: "another-player", countryCode: "CR", avatarUrl: null };
  mocks.dashboard.mockResolvedValue({ ...dashboard, summary: { ...summary, userId: 456, username: "another-player" } });
  rerender(panel());
  await screen.findByRole("button", { name: "MSD plays" });
  expect(screen.queryByTestId("skills-explorer")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "MSD plays" }));
  expect(mocks.explorer).toHaveBeenLastCalledWith({ userId: 456, username: "another-player", modes: [mode], view: "msd" });
});

it("keeps the signed-out and untracked entry states unchanged", async () => {
  mocks.viewer = null;
  const { unmount } = render(panel());
  expect(screen.getByText("Log in to see your data")).toBeTruthy();
  expect(mocks.dashboard).not.toHaveBeenCalled();
  unmount();
  mocks.viewer = { id: 123, username: "player", countryCode: "CR", avatarUrl: null };
  mocks.dashboard.mockResolvedValue({ ...dashboard, summary: { ...summary, tracked: false } });
  render(panel());
  await screen.findByText("Opt in");
  expect(screen.queryByRole("button", { name: "MSD plays" })).toBeNull();
  expect(mocks.explorer).not.toHaveBeenCalled();
});
