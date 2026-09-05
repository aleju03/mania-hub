// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LivePackBinder } from "#/lib/live-backend";
import { BINDER_MAX_CARDS, BINDER_MAX_PER_COLLECTOR } from "#/lib/pack-binders";
import { BinderMenuItems, packBinderActions, SetsView, type PackBinderActions } from "./SetsView";

const api = vi.hoisted(() => ({ list: vi.fn(), mutate: vi.fn() }));
vi.mock("#/lib/auth-context", () => ({ useAuth: () => ({ viewer: { id: 7 } }) }));
vi.mock("#/lib/live-backend", () => ({ isLiveBackendConfigured: () => true }));
vi.mock("#/lib/pack-binders", async (importOriginal) => ({
  ...await importOriginal<typeof import("#/lib/pack-binders")>(),
  fetchOwnPackBinders: api.list,
  mutateOwnPackBinders: api.mutate,
}));
vi.mock("./collections/ShowcaseCards", () => ({ ShowcaseCards: ({ cards }: { cards: LivePackBinder["cards"] }) => <div data-testid="cards">{cards.map((card) => <span key={card.cardKey}>{card.username}</span>)}</div> }));
vi.mock("./collections/ShowcasePicker", () => ({ ShowcasePickerHost: () => null }));

const card = (id: number): LivePackBinder["cards"][number] => ({ userId: id, cardKey: String(id), username: `Player ${id}`, avatarUrl: "", countryCode: "CR", tier: "rare", tierLabel: "Rare", skills: null, pp: 1, globalRank: 1, copies: 1, recycledCopies: 0, firstPulledAt: 1, lastPulledAt: 1 });
const binder = (id: number, count = 1): LivePackBinder => ({ id, name: `Set ${id}`, position: id, showcased: false, createdAt: 1, updatedAt: 1, cards: Array.from({ length: count }, (_, index) => card(id * 100 + index)) });
const wrap = (ui: React.ReactNode) => render(<I18nProvider i18n={getI18n("en")}>{ui}</I18nProvider>);
const menu = (binders: LivePackBinder[], cardKeys = ["9999"], cardCount = cardKeys.length) => {
  const actions: PackBinderActions = { list: vi.fn().mockResolvedValue(binders), addCards: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue(undefined) };
  const onDone = vi.fn();
  wrap(<BinderMenuItems cardKeys={cardKeys} cardCount={cardCount} actions={actions} onDone={onDone} />);
  fireEvent.click(screen.getByRole("menuitem", { name: cardCount > 1 ? `Add ${cardCount} cards to set...` : "Add to set..." }));
  return { actions, onDone };
};
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it("shows one set at a time, pages its cards, and resets the page when switching sets", async () => {
  api.list.mockResolvedValue([binder(1, BINDER_MAX_CARDS), binder(2)]);
  await act(async () => { wrap(<SetsView syncStatus="synced" />); });
  await screen.findByRole("region", { name: "Set 1" });
  expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(screen.getByTestId("cards").children).toHaveLength(6);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByTestId("cards").textContent).toContain("Player 106");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Your sets" })).getByRole("button", { name: /Set 2/ }));
  expect(screen.getByRole("region", { name: "Set 2" })).toBeTruthy();
  expect(screen.getByTestId("cards").textContent).toBe("Player 200");
});

it("shows the limits and prevents creating a thirteenth set with either Enter or the button", async () => {
  api.list.mockResolvedValue(Array.from({ length: BINDER_MAX_PER_COLLECTOR }, (_, index) => binder(index)));
  wrap(<SetsView syncStatus="synced" />);
  await screen.findByRole("navigation", { name: "Your sets" });
  expect(screen.getByText(`12 / 12 sets · Up to ${BINDER_MAX_CARDS} cards per set`)).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Name a new set" });
  expect((input as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "New set" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Extra" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(api.mutate).not.toHaveBeenCalled();
});

it("bounds and searches the menu list, labels full sets, and prevents duplicate additions", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => binder(index + 1));
  entries[0] = binder(1, BINDER_MAX_CARDS);
  entries[1].cards = [card(9999)];
  const { actions } = menu(entries);
  const group = await screen.findByRole("group", { name: "Your sets" });
  await screen.findByRole("menuitem", { name: /Set 1\s*Full/ });
  expect(group.className).toContain("max-h-40");
  expect(group.className).toContain("overflow-y-auto");
  expect((screen.getByRole("menuitem", { name: /Set 1\s*Full/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("menuitem", { name: /Set 2/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("menuitem", { name: "Set limit reached" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Find a set" }), { target: { value: "Set 12" } });
  expect(within(group).getAllByRole("menuitem")).toHaveLength(1);
  fireEvent.click(within(group).getByRole("menuitem"));
  await waitFor(() => expect(actions.addCards).toHaveBeenCalledWith(12, ["9999"]));
});

it("keeps the menu open on a failed addition and closes it only after a successful retry", async () => {
  const { actions, onDone } = menu([binder(1)]);
  vi.mocked(actions.addCards).mockRejectedValueOnce(new Error("binder_full"));
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Set 1/ }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", `A set can hold up to ${BINDER_MAX_CARDS} cards.`);
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: /^Set 1/ }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});

it("supports creating a set without needing a physical Enter key", async () => {
  const { actions, onDone } = menu([]);
  const create = await screen.findByRole("menuitem", { name: "New set" });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create);
  fireEvent.change(screen.getByRole("textbox", { name: "Set name" }), { target: { value: "Friends" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(actions.create).toHaveBeenCalledWith("Friends", ["9999"]));
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("sends the whole selection to the append action instead of replacing a stale set", async () => {
  api.mutate.mockResolvedValue([]);
  await act(() => packBinderActions.addCards(3, ["99", "100"]));
  expect(api.mutate).toHaveBeenCalledWith({ data: { action: "add_cards", binderId: 3, cardKeys: ["99", "100"] } });
});


it("counts only new members when deciding whether a selection fits", async () => {
  const entries = [binder(1, 9), binder(2, 9)];
  const { actions } = menu(entries, ["100", "9999"]);
  const fitting = await screen.findByRole("menuitem", { name: /^Set 1/ });
  const blocked = screen.getByRole("menuitem", { name: /^Set 2/ });
  expect((fitting as HTMLButtonElement).disabled).toBe(false);
  expect((blocked as HTMLButtonElement).disabled).toBe(true);
  expect(blocked.textContent).toContain("Not enough room");
  fireEvent.click(fitting);
  await waitFor(() => expect(actions.addCards).toHaveBeenCalledWith(1, ["100", "9999"]));
});

it("blocks an oversized select-all even when only the current page's keys are available", async () => {
  const { actions } = menu([binder(1)], ["9999"], 100);
  const entry = await screen.findByRole("menuitem", { name: /^Set 1/ });
  expect((entry as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe(`Select at most ${BINDER_MAX_CARDS} cards to add to a set.`);
  expect((screen.getByRole("menuitem", { name: "New set" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(entry);
  expect(actions.addCards).not.toHaveBeenCalled();
});

it("creates a new set with the whole selection and checks capacity before creating anything", async () => {
  const { actions } = menu([], ["100", "101"]);
  const create = await screen.findByRole("menuitem", { name: "New set" });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create);
  fireEvent.change(screen.getByRole("textbox", { name: "Set name" }), { target: { value: "Friends" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(actions.create).toHaveBeenCalledWith("Friends", ["100", "101"]));
  await expect(packBinderActions.create("Too large", Array.from({ length: 11 }, (_, index) => String(index + 1)))).rejects.toThrow("binder_full");
  expect(api.mutate).not.toHaveBeenCalled();
});
