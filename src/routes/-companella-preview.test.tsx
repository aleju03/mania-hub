// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { AuthContext } from "../lib/auth-context";
import { ANONYMOUS_AUTH_STATE, type AuthState } from "../lib/auth-shared";
import { getI18n, loadLocaleCatalog } from "../lib/i18n";
import type { AppLocale } from "../lib/locale";
import { Route as settingsRoute } from "./settings";
import { Route as announcementRoute } from "./news_.companella";

const api = vi.hoisted(() => ({
  fetchCompanellaAccess: vi.fn(),
  fetchCompanellaInstallations: vi.fn(),
  revokeCompanellaInstallation: vi.fn(),
}));
vi.mock("../lib/companella-integration/manage-server", () => api);
vi.mock("../lib/osu", () => ({ searchUsers: vi.fn() }));
vi.mock("../components/replay/LazyReplaySkinSettingsModal", () => ({
  ReplaySkinSettingsModal: () => null,
  loadReplaySkinSettingsModal: vi.fn(),
  preloadReplaySkinSettingsModal: vi.fn(),
}));
vi.mock("../components/player/ScoreRows", () => ({ ScoreRow: () => null }));

beforeAll(async () => { await loadLocaleCatalog("en"); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEV", false); // Ninja serves a production build, too.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  api.fetchCompanellaAccess.mockResolvedValue({ backendReachable: true, enabled: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function openPage(path: string, auth: AuthState) {
  const root = createRootRouteWithContext<{ auth: AuthState; locale: AppLocale; origin: string }>()({
    component: () => (
      <I18nProvider i18n={getI18n("en")}>
        <AuthContext.Provider value={auth}><Outlet /></AuthContext.Provider>
      </I18nProvider>
    ),
    notFoundComponent: () => <p>Not found</p>,
  });
  const routes = [settingsRoute, announcementRoute].map((route, index) => route.update({
    id: ["/settings", "/news/companella"][index],
    path: ["/settings", "/news/companella"][index],
    getParentRoute: () => root,
  } as never));
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { auth, locale: "en", origin: "https://ninja.mania-tracker.com" },
    defaultPendingMinMs: 0,
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

it("lets an admin see Companella in preferences and open About in a production build", async () => {
  await openPage("/settings?tab=preferences", {
    ...ANONYMOUS_AUTH_STATE, canUseAdminFeatures: true, isAdmin: true,
    viewer: { id: 1, username: "Admin", avatarUrl: "", countryCode: "CR" },
  });
  await screen.findByText("Not available yet.");
  expect(screen.getByText("Integrations")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "About" }));
  await screen.findByRole("heading", { name: "You can now submit plays through Companella" });
});

it.each([
  ["signed out", ANONYMOUS_AUTH_STATE],
  ["a developer without admin access", {
    ...ANONYMOUS_AUTH_STATE, canUseDevFeatures: true,
    viewer: { id: 2, username: "Developer", avatarUrl: "", countryCode: "CR" },
  }],
] as const)("hides the preview and blocks its announcement when %s", async (_label, auth) => {
  await openPage("/settings?tab=preferences", auth);
  await screen.findByText("Hide players");
  expect(screen.queryByText("Companella")).toBeNull();
  expect(api.fetchCompanellaAccess).not.toHaveBeenCalled();
  cleanup();
  await openPage("/news/companella", auth);
  await screen.findByText("Not found");
});
