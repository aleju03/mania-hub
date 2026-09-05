// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "#/lib/i18n";
import { afterEach, expect, it, vi } from "vitest";
import type { LivePackShowcaseWallCard } from "#/lib/live-backend";

const fetchWall = vi.hoisted(() => vi.fn());
const setChanges = vi.hoisted(() => ({ listener: null as ((change: { showcaseChanged: boolean }) => void) | null }));
vi.mock("#/lib/live-backend", () => ({
  isLiveBackendConfigured: () => true,
  fetchLivePackShowcaseCards: () => Promise.resolve([]),
  fetchLivePackShowcaseWall: fetchWall,
}));
vi.mock("#/lib/auth-context", () => ({ useAuth: () => ({ viewer: null }) }));
vi.mock("#/lib/analytics", () => ({ track: () => {} }));
vi.mock("#/lib/pack-wallet-sync", () => ({ saveOwnPackShowcase: vi.fn() }));
vi.mock("./ShowcasePicker", () => ({ ShowcasePickerHost: () => null }));
vi.mock("../SetsView", () => ({ subscribePackSetsChanged: (listener: (change: { showcaseChanged: boolean }) => void) => {
  setChanges.listener = listener;
  return () => { setChanges.listener = null; };
} }));
vi.mock("../useCardThumbnails", () => ({ useCardThumbnails: () => ({}) }));
vi.mock("./ShowcaseWall", () => ({
  ShowcaseWallGrid: ({ entries }: { entries: LivePackShowcaseWallCard[] }) => (
    <div data-testid="wall-cards">{entries.map((entry) => entry.card.username).join(", ")}</div>
  ),
}));

import { ShowcaseTab } from "./ShowcaseTab";

type WallPage = { cards: LivePackShowcaseWallCard[]; total: number };
function pendingPage() {
  let resolve!: (page: WallPage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WallPage>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pageResult(page: number): WallPage {
  return {
    cards: [{ card: { username: `Page ${page + 1} card` } } as LivePackShowcaseWallCard],
    total: 200,
  };
}

afterEach(cleanup);

it("keeps rapid page turns on the requested page through cached, delayed, and failed reads", async () => {
  const pages = Array.from({ length: 5 }, pendingPage);
  fetchWall.mockImplementation(({ page }: { page: number }) => pages[page].promise);
  const { container } = render(<I18nProvider i18n={getI18n("en")}><ShowcaseTab shelfSlots={0} /></I18nProvider>);
  await act(async () => pages[0].resolve(pageResult(0)));
  await act(async () => pages[1].resolve(pageResult(1)));

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByTestId("wall-cards").textContent).toBe("Page 2 card");
  expect(fetchWall.mock.calls.filter(([options]) => options.page === 1)).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("3 / 5")).toBeTruthy();
  expect(screen.queryByTestId("wall-cards")).toBeNull();
  expect(container.querySelectorAll(".skeleton-pulse")).toHaveLength(40);
  expect(fetchWall.mock.calls.filter(([options]) => options.page === 2)).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await act(async () => pages[2].resolve(pageResult(2)));
  expect(screen.getByText("4 / 5")).toBeTruthy();
  expect(screen.queryByTestId("wall-cards")).toBeNull();
  await act(async () => pages[3].resolve(pageResult(3)));
  expect(screen.getByTestId("wall-cards").textContent).toBe("Page 4 card");

  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByTestId("wall-cards").textContent).toBe("Page 3 card");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await act(async () => pages[4].reject(new Error("offline")));
  expect(screen.getByText("5 / 5")).toBeTruthy();
  expect(screen.getByText("Could not load the showcases.")).toBeTruthy();
  expect(screen.queryByTestId("wall-cards")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(screen.getByTestId("wall-cards").textContent).toBe("Page 4 card");

  const refresh = pendingPage();
  fetchWall.mockImplementation(({ page, fresh }: { page: number; fresh: boolean }) => fresh && page === 3 ? refresh.promise : pages[page].promise);
  act(() => setChanges.listener?.({ showcaseChanged: true }));
  expect(screen.getByText("4 / 5")).toBeTruthy();
  expect(screen.getByTestId("wall-cards").textContent).toBe("Page 4 card");
  expect(fetchWall).toHaveBeenCalledWith({ page: 3, pageSize: 40, fresh: true });
  await act(async () => refresh.resolve({ ...pageResult(3), cards: [{ card: { username: "Updated page 4 card" } } as LivePackShowcaseWallCard] }));
  expect(screen.getByTestId("wall-cards").textContent).toBe("Updated page 4 card");

});
