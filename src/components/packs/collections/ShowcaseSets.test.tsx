// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LivePackBinder } from "#/lib/live-backend";
import { notifyPackBindersChanged } from "../SetsView";
import { ShowcaseTab } from "./ShowcaseTab";

const api = vi.hoisted(() => ({ viewer: { id: 7 }, list: vi.fn(), mutate: vi.fn(), wall: vi.fn(), collection: vi.fn() }));
vi.mock("#/lib/auth-context", () => ({ useAuth: () => ({ viewer: api.viewer }) }));
vi.mock("#/lib/analytics", () => ({ track: () => {} }));
vi.mock("#/lib/live-backend", () => ({
  isLiveBackendConfigured: () => true,
  fetchLivePackShowcaseCards: async () => [],
  fetchLivePackShowcaseWall: api.wall,
  fetchLivePackCollectorCards: api.collection,
}));
vi.mock("#/lib/pack-binders", async (importOriginal) => ({
  ...await importOriginal<typeof import("#/lib/pack-binders")>(),
  fetchOwnPackBinders: api.list,
  mutateOwnPackBinders: api.mutate,
}));
vi.mock("#/lib/pack-wallet-sync", () => ({ saveOwnPackShowcase: async () => {} }));
vi.mock("../CardTile", () => ({
  CollectionCardTile: ({ card }: { card: { username: string } }) => <span>{card.username}</span>,
  CollectionCardPlaceholder: () => <span />,
}));
vi.mock("../cardThumbnailCache", () => ({ cardThumbnailKeyForCollectionCard: () => "key", getMemoryCardThumbnail: () => null }));
vi.mock("../useCardThumbnails", () => ({ useCardThumbnails: () => ({ onThumbnailError: () => {} }) }));
vi.mock("../CardSpotlight", () => ({ CardSpotlight: () => null }));

const card = (id: number): LivePackBinder["cards"][number] => ({ userId: id, cardKey: String(id), username: `Player ${id}`, avatarUrl: "https://a.ppy.sh/1", countryCode: "CR", tier: "rare", tierLabel: "Rare", skills: null, pp: 1, globalRank: 1, copies: 1, recycledCopies: 0, firstPulledAt: 1, lastPulledAt: 1 });
let sets: LivePackBinder[];
beforeEach(() => {
  vi.clearAllMocks();
  sets = [{ id: 1, name: "Friends", position: 0, showcased: false, createdAt: 1, updatedAt: 1, cards: [card(1)] }];
  api.list.mockImplementation(async () => sets);
  api.wall.mockResolvedValue({ cards: [], total: 0, cardTotal: 0 });
  api.collection.mockResolvedValue({ cards: [card(1), card(2)], total: 2 });
  api.mutate.mockImplementation(async ({ data }) => {
    if (data.action === "create") sets = [...sets, { ...sets[0], id: 2, name: data.name, cards: [] }];
    if (data.action === "rename") sets = sets.map((set) => set.id === data.binderId ? { ...set, name: data.name } : set);
    if (data.action === "showcase") sets = sets.map((set) => set.id === data.binderId ? { ...set, showcased: data.showcased } : set);
    if (data.action === "set_cards") sets = sets.map((set) => set.id === data.binderId ? { ...set, cards: data.cardKeys.map((key: string) => card(Number(key))) } : set);
    if (data.action === "delete") sets = sets.filter((set) => set.id !== data.binderId);
    return sets;
  });
});
afterEach(cleanup);
const renderTab = async () => {
  await act(async () => { render(<I18nProvider i18n={getI18n("en")}><ShowcaseTab shelfSlots={0} /></I18nProvider>); });
};

it("manages sets in a bounded dialog without navigating and returns from the card picker", async () => {
  await renderTab();
  const initialUrl = window.location.href;
  const opener = screen.getByRole("button", { name: "Your sets" });
  expect(screen.queryByRole("link", { name: "Your sets" })).toBeNull();
  opener.focus();
  fireEvent.click(opener);
  const manager = await screen.findByRole("dialog", { name: "Your sets" });
  await within(manager).findByRole("region", { name: "Friends" });
  expect(manager.className).toContain("max-h-[88dvh]");
  expect(manager.parentElement?.className).toContain("z-[80]");
  expect(document.body.style.overflow).toBe("hidden");

  fireEvent.click(within(manager).getByRole("button", { name: "Edit cards" }));
  let picker = await screen.findByRole("dialog", { name: "Cards in Friends" });
  expect(picker.parentElement?.className).toContain("z-[90]");
  expect(document.activeElement).toBe(picker);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cards in Friends" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "Your sets" })).toBe(manager);
  expect(document.body.style.overflow).toBe("hidden");

  fireEvent.click(within(manager).getByRole("button", { name: "Edit cards" }));
  picker = await screen.findByRole("dialog", { name: "Cards in Friends" });
  fireEvent.click(await within(picker).findByRole("button", { name: /^Player 2/ }));
  fireEvent.click(within(picker).getByRole("button", { name: "Save set" }));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({ data: { action: "set_cards", binderId: 1, cardKeys: ["1", "2"] } }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cards in Friends" })).toBeNull());

  fireEvent.click(within(manager).getByRole("button", { name: "Show on Showcase" }));
  await waitFor(() => expect(within(manager).getByRole("button", { name: "Show on Showcase" }).getAttribute("aria-pressed")).toBe("true"));
  expect(api.wall).toHaveBeenCalledWith({ page: 0, pageSize: 40, fresh: true });

  fireEvent.change(within(manager).getByRole("textbox", { name: "Name a new set" }), { target: { value: "New friends" } });
  fireEvent.click(within(manager).getByRole("button", { name: "New set" }));
  await within(manager).findByRole("region", { name: "New friends" });
  fireEvent.click(within(manager).getByRole("button", { name: "Rename" }));
  const rename = within(manager).getByDisplayValue("New friends");
  fireEvent.change(rename, { target: { value: "Best friends" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  await within(manager).findByRole("region", { name: "Best friends" });
  fireEvent.click(within(manager).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(manager).getByRole("button", { name: "Sure?" }));
  await waitFor(() => expect(within(manager).queryByRole("region", { name: "Best friends" })).toBeNull());

  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.body.style.overflow).not.toBe("hidden");
  expect(document.activeElement).toBe(opener);
  expect(window.location.href).toBe(initialUrl);
});

it("refreshes after a set change even when an older gallery request is still running", async () => {
  await renderTab();
  let resolveOld!: (page: { cards: []; total: number; cardTotal: number }) => void;
  api.wall.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  act(() => notifyPackBindersChanged());
  await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  api.wall.mockResolvedValueOnce({ cards: [], total: 0, cardTotal: 3 });
  act(() => notifyPackBindersChanged());
  await screen.findByText("3 cards");
  await act(async () => { resolveOld({ cards: [], total: 0, cardTotal: 99 }); });
  expect(screen.queryByText("99 cards")).toBeNull();
  expect(screen.getByText("3 cards")).toBeTruthy();
});

const gallery = (...ids: number[]) => ({
  cards: ids.map((id) => ({
    card: card(id), showcasedAt: id,
    collector: { userId: 123, username: "Collector", avatarUrl: "", countryCode: "CR", cards: 100, goats: 0, tracked: true },
  })),
  total: ids.length,
  cardTotal: ids.length,
});
const populateGallery = async (...ids: number[]) => {
  api.wall.mockResolvedValue(gallery(...ids));
  await renderTab();
  // Discard the module cache left by another test, just as a public edit does.
  await act(async () => notifyPackBindersChanged());
  return screen.findByRole("button", { name: `Inspect Player ${ids[0]}'s maniacard` });
};

it.each([false, true])("does not refresh the gallery for a %s-public set when its public content stays unchanged", async (showcased) => {
  sets[0].showcased = showcased;
  const existingCard = await populateGallery(55);
  fireEvent.click(screen.getByRole("button", { name: "Your sets" }));
  const manager = await screen.findByRole("dialog", { name: "Your sets" });
  fireEvent.click(await within(manager).findByRole("button", { name: "Edit cards" }));
  const picker = await screen.findByRole("dialog", { name: "Cards in Friends" });
  // Private changes are irrelevant to the wall; a public set's unchanged save
  // is also irrelevant. Both still persist through the normal set save path.
  if (!showcased) fireEvent.click(await within(picker).findByRole("button", { name: /^Player 2/ }));
  api.wall.mockClear();
  fireEvent.click(within(picker).getByRole("button", { name: "Save set" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cards in Friends" })).toBeNull());
  expect(api.mutate).toHaveBeenCalledWith({ data: { action: "set_cards", binderId: 1, cardKeys: showcased ? ["1"] : ["1", "2"] } });
  expect(api.wall).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Inspect Player 55's maniacard" })).toBe(existingCard);
});

it("keeps existing card nodes throughout a public refresh and updates only changed entries", async () => {
  const existingCard = await populateGallery(65, 66);
  const removedCard = screen.getByRole("button", { name: "Inspect Player 66's maniacard" });
  fireEvent.click(screen.getByRole("button", { name: "Your sets" }));
  const manager = await screen.findByRole("dialog", { name: "Your sets" });
  const toggle = await within(manager).findByRole("button", { name: "Show on Showcase" });
  let resolveRefresh!: (result: ReturnType<typeof gallery>) => void;
  api.wall.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
  api.wall.mockClear();
  fireEvent.click(toggle);
  await waitFor(() => expect(api.wall).toHaveBeenCalledWith({ page: 0, pageSize: 40, fresh: true }));
  expect(existingCard.isConnected).toBe(true);
  expect(removedCard.isConnected).toBe(true);
  expect(screen.getByText("2 cards")).toBeTruthy();
  expect(document.querySelectorAll(".skeleton-pulse")).toHaveLength(0);
  await act(async () => resolveRefresh(gallery(65, 67)));
  expect(screen.getByRole("button", { name: "Inspect Player 65's maniacard" })).toBe(existingCard);
  expect(removedCard.isConnected).toBe(false);
  expect(screen.getByRole("button", { name: "Inspect Player 67's maniacard" })).toBeTruthy();

  api.wall.mockRejectedValueOnce(new Error("offline"));
  await act(async () => notifyPackBindersChanged());
  expect(screen.getByRole("button", { name: "Inspect Player 65's maniacard" })).toBe(existingCard);
});
