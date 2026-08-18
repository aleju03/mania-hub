// @vitest-environment jsdom
/* The picker is the only way a collector chooses what the whole site sees of
   their collection, and it is behind a login, so it is the one part of the
   collections page that cannot be clicked through in a browser without a real
   osu! session. These cover what a click does: the cap, taking one back off,
   and what actually gets saved. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function card(userId: number, username: string) {
  return {
    userId,
    cardKey: String(userId),
    username,
    avatarUrl: "",
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
