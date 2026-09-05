// @vitest-environment jsdom
/* The picker is the only way a collector chooses what the whole site sees of
   their collection, and it is behind a login, so it is the one part of the
   collections page that cannot be clicked through in a browser without a real
   osu! session. These cover what a click does: the cap, taking one back off,
   and what actually gets saved. */
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "#/lib/i18n";
import { afterEach, expect, it, vi } from "vitest";
import type { LivePackCommunityCollectionPage } from "#/lib/live-backend";

const fetchLivePackCollectorCards = vi.hoisted(() => vi.fn());
vi.mock("#/lib/live-backend", () => ({ fetchLivePackCollectorCards }));

/* The tile draws a card onto a canvas, which jsdom has no answer for; the
   picker's own behaviour is the selection state around it. */
vi.mock("../CardTile", () => ({
  CollectionCardTile: ({ card }: { card: { username: string } }) => <div>{card.username} card</div>,
  CollectionCardPlaceholder: () => <div>placeholder</div>,
}));
vi.mock("../cardThumbnailCache", () => ({
  cardThumbnailKeyForCollectionCard: () => "key",
  getMemoryCardThumbnail: () => null,
}));
vi.mock("../useCardThumbnails", () => ({ useCardThumbnails: () => ({ onThumbnailError: () => {} }) }));

const { ShowcasePicker } = await import("./ShowcasePicker");

// The picker reads its copy through Lingui; en resolves to the source strings.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });

function card(userId: number, username: string) {
  return {
    userId,
    cardKey: String(userId),
    username,
    avatarUrl: "https://a.ppy.sh/1",
    countryCode: "CR",
    tier: "rare",
    tierLabel: "Rare",
    skills: null,
    pp: 1000,
    globalRank: 10,
    copies: 1,
    recycledCopies: 0,
    firstPulledAt: 1,
    lastPulledAt: 1,
  };
}

const page: LivePackCommunityCollectionPage = {
  cards: [card(1, "alpha"), card(2, "bravo"), card(3, "charlie"), card(4, "delta"), card(5, "echo"), card(6, "foxtrot")] as never,
  total: 6,
  tierCounts: { rare: 6 },
};

afterEach(() => {
  cleanup();
  fetchLivePackCollectorCards.mockReset();
});

async function renderPicker(initialKeys: string[], onSave = vi.fn().mockResolvedValue(undefined)) {
  fetchLivePackCollectorCards.mockResolvedValue(page);
  render(<ShowcasePicker userId={7} initialKeys={initialKeys} onCancel={() => {}} onSave={onSave} />);
  await waitFor(() => expect(screen.getByText("alpha card")).toBeTruthy());
  return onSave;
}

it("reads your own collection through the public paged endpoint", async () => {
  await renderPicker([]);
  expect(fetchLivePackCollectorCards).toHaveBeenCalledWith(7, expect.objectContaining({ page: 0 }));
  // The id it asks for is the viewer's own, not a hardcoded one.
  expect(fetchLivePackCollectorCards.mock.calls[0][0]).toBe(7);
});

it("fits the visible mobile viewport and only lets the card grid shrink", async () => {
  await renderPicker([]);

  const dialog = screen.getByRole("dialog", { name: "Pick your showcase" });
  expect(dialog.className).toContain("max-h-[88dvh]");
  expect(dialog.parentElement?.className).toContain("h-[100dvh]");

  const header = screen.getByText("Pick your showcase").parentElement?.parentElement;
  const searchRow = screen.getByPlaceholderText("Find a player in your collection").parentElement?.parentElement;
  const footer = screen.getByText("Save showcase").parentElement?.parentElement;
  expect(header?.className).toContain("shrink-0");
  expect(searchRow?.className).toContain("shrink-0");
  expect(footer?.className).toContain("shrink-0");
  expect(footer?.className).toContain("safe-area-inset-bottom");
});

it("saves exactly the cards that were clicked, in the order they were picked", async () => {
  const onSave = await renderPicker([]);
  fireEvent.click(screen.getByText("charlie card"));
  fireEvent.click(screen.getByText("alpha card"));
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["3", "1"]));
});

it("stops at five and leaves the rest unclickable rather than silently dropping one", async () => {
  const onSave = await renderPicker([]);
  for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    fireEvent.click(screen.getByText(`${name} card`));
  }
  expect(screen.getByText("5 of 5 chosen")).toBeTruthy();
  fireEvent.click(screen.getByText("foxtrot card"));
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["1", "2", "3", "4", "5"]));
});

it("takes a card back off, which is the only way to swap one when full", async () => {
  const onSave = await renderPicker(["1", "2"]);
  expect(screen.getByText("2 of 5 chosen")).toBeTruthy();
  fireEvent.click(screen.getByText("alpha card"));
  expect(screen.getByText("1 of 5 chosen")).toBeTruthy();
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["2"]));
});

it("opens with the showcase you already had, so saving unchanged keeps it", async () => {
  const onSave = await renderPicker(["4", "5"]);
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["4", "5"]));
});


it("lets a set arrange selected cards and saves that order", async () => {
  fetchLivePackCollectorCards.mockResolvedValue(page);
  const onSave = vi.fn(async () => {});
  render(<ShowcasePicker userId={7095193} initialKeys={["1", "2", "3"]} initialCards={page.cards} maxCards={60} allowReorder onCancel={() => {}} onSave={onSave} />);
  await screen.findByText("alpha card");
  fireEvent.click(screen.getByRole("button", { name: "Move charlie left" }));
  fireEvent.click(screen.getByRole("button", { name: "Move charlie left" }));
  fireEvent.click(screen.getByRole("button", { name: "Save showcase" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["3", "1", "2"]));
});

it("keeps the selection and shows a retryable error if saving fails", async () => {
  fetchLivePackCollectorCards.mockResolvedValue(page);
  const onSave = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  render(<ShowcasePicker userId={7095193} initialKeys={["1"]} onCancel={() => {}} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Save showcase" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Save showcase" }));
  await waitFor(() => expect(onSave).toHaveBeenNthCalledWith(2, ["1"]));
});

// jsdom's MouseEvent supplies the button fields; add the pointer identity
// explicitly so these exercise the same handlers as a real held mouse.
function pointer(target: Element | Document | Window, type: string, options: { pointerType?: string; buttons?: number; pointerId?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: options.buttons ?? 1 });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: options.pointerType ?? "mouse" },
  });
  fireEvent(target, event);
  return event;
}
const tile = (name: string) => screen.getByText(`${name} card`).closest("button")!;

it("sweeps multiple cards in order without toggling revisited cards or the release click", async () => {
  const onSave = await renderPicker([]);
  expect(pointer(tile("alpha"), "pointerdown").defaultPrevented).toBe(true);
  pointer(tile("bravo"), "pointermove");
  pointer(tile("alpha"), "pointermove");
  pointer(tile("charlie"), "pointermove");
  pointer(document, "pointerup", { buttons: 0 });
  fireEvent.click(tile("charlie"), { detail: 1 });
  expect(screen.getByText("3 of 5 chosen")).toBeTruthy();
  pointer(tile("delta"), "pointermove");
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["1", "2", "3"]));
});

it("sweeps to deselect when starting on a selected card and stops on pointer cancellation", async () => {
  const onSave = await renderPicker(["1", "2", "4"]);
  pointer(tile("alpha"), "pointerdown");
  pointer(tile("charlie"), "pointermove");
  pointer(tile("bravo"), "pointermove");
  pointer(document, "pointercancel");
  pointer(tile("delta"), "pointermove");
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["4"]));
});

it("enforces the ten-card set cap during a sweep and keeps the grid still until release", async () => {
  const cards = Array.from({ length: 12 }, (_, index) => card(index + 1, `player${index + 1}`));
  fetchLivePackCollectorCards.mockResolvedValue({ ...page, cards, total: 12 });
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<ShowcasePicker userId={7} initialKeys={[]} maxCards={10} allowReorder onCancel={() => {}} onSave={onSave} />);
  await screen.findByText("player1 card");
  pointer(tile("player1"), "pointerdown");
  for (let index = 2; index <= 12; index += 1) pointer(tile(`player${index}`), "pointermove");
  expect(screen.getByText("10 of 10 chosen")).toBeTruthy();
  expect(screen.queryByText("Arrange your cards")).toBeNull();
  pointer(document, "pointerup", { buttons: 0 });
  expect(screen.getByText("Arrange your cards")).toBeTruthy();
  expect(tile("player11").disabled).toBe(true);
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(cards.slice(0, 10).map((card) => card.cardKey)));
});

it("keeps the arrangement strip in place while dragging off the last selected card", async () => {
  fetchLivePackCollectorCards.mockResolvedValue(page);
  render(<ShowcasePicker userId={7} initialKeys={["1"]} initialCards={page.cards} maxCards={10} allowReorder onCancel={() => {}} onSave={vi.fn()} />);
  await screen.findByText("alpha card");
  pointer(tile("alpha"), "pointerdown");
  expect(screen.getByText("0 of 10 chosen")).toBeTruthy();
  expect(screen.getByText("Arrange your cards")).toBeTruthy();
  pointer(document, "pointerup", { buttons: 0 });
  expect(screen.queryByText("Arrange your cards")).toBeNull();
});

it("preserves touch scrolling, touch taps and keyboard selection after a mouse sweep", async () => {
  const onSave = await renderPicker([]);
  expect(pointer(tile("alpha"), "pointerdown", { pointerType: "touch" }).defaultPrevented).toBe(false);
  pointer(tile("bravo"), "pointermove", { pointerType: "touch" });
  pointer(document, "pointercancel", { pointerType: "touch" });
  expect(screen.getByText("0 of 5 chosen")).toBeTruthy();
  pointer(tile("alpha"), "pointerdown", { pointerType: "touch" });
  pointer(document, "pointerup", { pointerType: "touch", buttons: 0 });
  fireEvent.click(tile("alpha"), { detail: 1 });
  pointer(tile("bravo"), "pointerdown");
  fireEvent.blur(window);
  pointer(tile("delta"), "pointermove");
  fireEvent.click(tile("charlie"), { detail: 0 });
  fireEvent.click(screen.getByText("Save showcase"));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(["1", "2", "3"]));
});

it("prevents native image dragging in the selection grid", async () => {
  await renderPicker([]);
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  fireEvent(tile("alpha"), event);
  expect(event.defaultPrevented).toBe(true);
  expect(tile("alpha").parentElement?.className).toContain("select-none");
});
