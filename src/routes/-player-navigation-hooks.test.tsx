// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "../lib/i18n";
import type { LivePlayerProfileSnapshot } from "../lib/live-backend";
import { fetchLivePlayerProfileSnapshotDirect } from "../lib/live-backend";
import { buildPlayerLoaderData, PlayerProfilePage, resetPlayerSnapshotCachesForTests } from "./player/$username";

vi.mock("../lib/live-backend", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/live-backend")>(),
  fetchLivePlayerProfileSnapshotDirect: vi.fn(),
  isLiveBackendConfigured: () => false,
}));
vi.mock("../lib/osu", () => ({
  getUser: vi.fn(),
  getUserScoresBestWindow: vi.fn(async () => []),
}));

beforeEach(async () => {
  await loadLocaleCatalog("en");
  resetPlayerSnapshotCachesForTests();
  vi.mocked(fetchLivePlayerProfileSnapshotDirect).mockReset();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["/", "/rankings"])("opens a profile from %s while its player data is still loading", async (entry) => {
  let resolveSnapshot!: (snapshot: LivePlayerProfileSnapshot) => void;
  vi.mocked(fetchLivePlayerProfileSnapshotDirect).mockReturnValue(new Promise((resolve) => {
    resolveSnapshot = resolve;
  }));
  const emptyLoaderData = buildPlayerLoaderData(null);
  const root = createRootRoute({
    errorComponent: ({ error }) => <div role="alert">{error.message}</div>,
  });
  const listing = createRoute({
    getParentRoute: () => root,
    path: entry,
    component: () => <Link to="/player/$username" params={{ username: "hook-tester" }}>Open profile</Link>,
  });
  const profile = createRoute({
    getParentRoute: () => root,
    path: "/player/$username",
    component: () => <PlayerProfilePage username="hook-tester" loaderData={emptyLoaderData} initialTab="best" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([listing, profile]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  render(<I18nProvider i18n={getI18n("en")}><RouterProvider router={router} /></I18nProvider>);
  fireEvent.click(await screen.findByRole("link", { name: "Open profile" }));
  await waitFor(() => expect(fetchLivePlayerProfileSnapshotDirect).toHaveBeenCalledWith("hook-tester"));
  expect(screen.queryByRole("heading", { name: "hook-tester" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  await act(async () => {
    resolveSnapshot({
      user: {
        id: 4242,
        username: "hook-tester",
        avatar_url: "",
        country_code: "CR",
        statistics: { pp: 4500, global_rank: 1000, country_rank: 10 },
      },
      bestScores: [],
      keymodeKeyCounts: [],
      fetchedAt: new Date().toISOString(),
      userFetchedAt: new Date().toISOString(),
      isStale: false,
    } as unknown as LivePlayerProfileSnapshot);
  });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(await screen.findByRole("heading", { name: "hook-tester" })).toBeTruthy();
});
