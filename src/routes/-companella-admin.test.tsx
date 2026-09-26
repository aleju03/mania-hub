// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANONYMOUS_AUTH_STATE, type AuthState } from "../lib/auth-shared";
import type { CompanellaAccount, CompanellaAccountPlay } from "../lib/companella-accounts";
import type { RateFlag } from "../lib/companella-rate-flags";
import { getI18n, loadLocaleCatalog } from "../lib/i18n";

const api = vi.hoisted(() => ({
  listCompanellaAccounts: vi.fn(),
  listCompanellaAccountPlays: vi.fn(),
  listRateFlags: vi.fn(),
  setRateFlagHeld: vi.fn(),
  setCompanellaAccountBlocked: vi.fn(),
}));
vi.mock("../lib/companella-accounts", () => api);
vi.mock("../lib/companella-rate-flags", () => api);
vi.mock("../lib/banned-users", () => api);

const { Route } = await import("./admin/companella");
const { Route: oldPlayers } = await import("./admin/companella-players");
const { Route: oldFlags } = await import("./admin/companella-flags");
await loadLocaleCatalog("en");

const USER_ID = 12345;
const SCORE_ID = "test_score_12345";
let account: CompanellaAccount;
let play: CompanellaAccountPlay;
let flag: RateFlag;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  account = {
    userId: USER_ID, username: "TestPlayer", avatarUrl: null, countryCode: null,
    plays: 1, heldPlays: 0, flaggedPlays: 1, activeConnections: 1,
    lastPlayAt: "2026-09-24T12:00:00Z", blockedAt: null,
  };
  play = {
    scoreId: SCORE_ID, mods: [], accuracy: 98.5, totalScore: 900000,
    reviewState: "clear", rateSuspicious: true,
    chart: { title: "Test chart", artist: "Artist", version: "Hard", keyCount: 4 },
    playedAt: "2026-09-24T12:00:00Z", receivedAt: "2026-09-24T12:01:00Z",
  };
  flag = {
    ...play, reviewState: "clear", userId: USER_ID, username: account.username,
    rateCheck: { verdict: "claimed_rate_too_high", claimedRate: 1.5, measuredRate: 1, windows: 10 },
  };
  api.listCompanellaAccounts.mockImplementation(async () => ({ total: 1, entries: [{ ...account }] }));
  api.listCompanellaAccountPlays.mockImplementation(async () => ({ total: 1, entries: [{ ...play }] }));
  api.listRateFlags.mockImplementation(async () => ({ total: 1, entries: [{ ...flag }] }));
  api.setRateFlagHeld.mockImplementation(async ({ data }: { data: { held: boolean } }) => {
    play.reviewState = data.held ? "quarantined" : "clear";
    flag.reviewState = data.held ? "quarantined" : "clear";
    account.heldPlays = data.held ? 1 : 0;
  });
  api.setCompanellaAccountBlocked.mockImplementation(async ({ data }: { data: { blocked: boolean } }) => {
    account.blockedAt = data.blocked ? "2026-09-25T12:00:00Z" : null;
    account.activeConnections = 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPage(path: string, admin = true) {
  const root = createRootRouteWithContext<{ auth: AuthState }>()({
    component: () => <I18nProvider i18n={getI18n("en")}><Outlet /></I18nProvider>,
    notFoundComponent: () => <p>Not found</p>,
  });
  const routes = [Route, oldPlayers, oldFlags].map((route, index) => route.update({
    id: ["/admin/companella", "/admin/companella-players", "/admin/companella-flags"][index],
    path: ["/admin/companella", "/admin/companella-players", "/admin/companella-flags"][index],
    getParentRoute: () => root,
  } as never));
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { auth: { ...ANONYMOUS_AUTH_STATE, canUseAdminFeatures: admin } },
    defaultPendingMinMs: 0,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

describe("Companella admin moderation", () => {
  it("opens a flagged player's details and returns to the same flag filter and page", async () => {
    api.listRateFlags.mockImplementation(async () => ({ total: 150, entries: [{ ...flag }] }));
    const router = await openPage("/admin/companella?tab=flags&flag=all&flagPage=3");
    const playerLink = await screen.findByRole("link", { name: "TestPlayer" });
    expect(screen.getByText("1.00x")).toBeTruthy();
    expect(screen.getByText("claims 1.50x")).toBeTruthy();
    expect(api.listRateFlags).toHaveBeenLastCalledWith({ data: { filter: "all", offset: 100, limit: 50 } });

    fireEvent.click(playerLink);
    await screen.findByRole("button", { name: "Block Companella" });
    await screen.findByRole("button", { name: "Exclude" });
    expect(api.listCompanellaAccounts).toHaveBeenLastCalledWith({ data: { filter: "recent", query: "#12345", offset: 0, limit: 50 } });
    expect(api.listCompanellaAccountPlays).toHaveBeenLastCalledWith({ data: { userId: USER_ID, offset: 0, limit: 20 } });

    await act(async () => { router.history.back(); });
    await screen.findByText("claims 1.50x");
    expect(api.listRateFlags).toHaveBeenLastCalledWith({ data: { filter: "all", offset: 100, limit: 50 } });
    expect(screen.getByRole("button", { name: /All/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("uses Exclude and Restore consistently across the two views", async () => {
    await openPage("/admin/companella?tab=flags");
    fireEvent.click(await screen.findByRole("button", { name: "Exclude" }));
    await screen.findByRole("button", { name: "Restore" });
    expect(api.setRateFlagHeld).toHaveBeenLastCalledWith({ data: { scoreId: SCORE_ID, held: true } });

    fireEvent.click(screen.getByRole("link", { name: "TestPlayer" }));
    await screen.findByRole("button", { name: "Block Companella" });
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByRole("button", { name: "Exclude" });
    expect(api.setRateFlagHeld).toHaveBeenLastCalledWith({ data: { scoreId: SCORE_ID, held: false } });

    fireEvent.click(screen.getByRole("button", { name: "Flagged plays" }));
    await screen.findByRole("button", { name: "Exclude" });
    expect(screen.queryByText("Excluded")).toBeNull();
  });

  it("keeps account blocks separate from excluding existing plays", async () => {
    await openPage("/admin/companella?user=12345&q=%2312345");
    fireEvent.click(await screen.findByRole("button", { name: "Block Companella" }));
    expect(api.setCompanellaAccountBlocked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    await screen.findByRole("button", { name: "Unblock Companella" });
    expect(api.setCompanellaAccountBlocked).toHaveBeenLastCalledWith({ data: { userId: USER_ID, blocked: true } });
    expect(api.setRateFlagHeld).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Exclude" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unblock Companella" }));
    await screen.findByRole("button", { name: "Block Companella" });
    expect(api.setCompanellaAccountBlocked).toHaveBeenLastCalledWith({ data: { userId: USER_ID, blocked: false } });
  });

  it("resets pagination on search and keeps the blocked filter through a tab switch", async () => {
    const router = await openPage("/admin/companella?filter=blocked&page=3");
    await screen.findByRole("link", { name: "TestPlayer" });
    expect(api.listCompanellaAccounts).toHaveBeenLastCalledWith({ data: { filter: "blocked", query: "", offset: 100, limit: 50 } });
    fireEvent.change(screen.getByRole("textbox", { name: "Find a Companella player" }), { target: { value: "Test" } });
    await waitFor(() => expect(api.listCompanellaAccounts).toHaveBeenLastCalledWith({ data: { filter: "blocked", query: "Test", offset: 0, limit: 50 } }));
    expect(router.state.location.search).toMatchObject({ filter: "blocked", q: "Test" });

    fireEvent.click(screen.getByRole("button", { name: "Flagged plays" }));
    await screen.findByText("claims 1.50x");
    fireEvent.click(screen.getByRole("button", { name: "Players" }));
    await screen.findByRole("link", { name: "TestPlayer" });
    expect(screen.getByRole("button", { name: "Blocked" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("textbox", { name: "Find a Companella player" }) as HTMLInputElement).value).toBe("Test");
  });

  it.each([
    ["/admin/companella-players", "All players"],
    ["/admin/companella-flags", "Read slower"],
  ])("redirects the old %s link into the matching tab", async (path, filterLabel) => {
    const router = await openPage(path);
    await screen.findByRole("button", { name: new RegExp(filterLabel) });
    expect(router.state.location.pathname).toBe("/admin/companella");
    expect(screen.getByRole("heading", { name: "Companella" })).toBeTruthy();
  });

  it.each(["/admin/companella", "/admin/companella-players", "/admin/companella-flags"])("keeps %s admin-only", async (path) => {
    await openPage(path, false);
    await screen.findByText("Not found");
    expect(api.listCompanellaAccounts).not.toHaveBeenCalled();
    expect(api.listRateFlags).not.toHaveBeenCalled();
  });
});
