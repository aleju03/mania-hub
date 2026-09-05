// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { PackWallet } from "#/lib/pack-collection";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

/* Card drawing is unrelated to the collection controls and requires canvas,
   which jsdom does not provide. */
vi.mock("./CardTile", () => ({
  CollectionCardPlaceholder: () => <div />,
  CollectionCardTile: ({ card }: { card: { username: string } }) => <div>{card.username}</div>,
}));
vi.mock("./CardSpotlight", () => ({ CardSpotlight: () => null }));
vi.mock("./cardThumbnailCache", () => ({
  cardThumbnailKeyForCollectionCard: () => "card",
  getMemoryCardThumbnail: () => null,
}));
vi.mock("./useCardThumbnails", () => ({
  useCardThumbnails: () => ({ onThumbnailError: () => {} }),
}));
vi.mock("./packSfx", () => ({ playRecycleClink: vi.fn() }));

const { CollectionPanel } = await import("./CollectionPanel");

const wallet: PackWallet = {
  cards: {
    "7": {
      userId: 7,
      username: "player7",
      avatarUrl: "",
      countryCode: "CR",
      tier: "rare",
      tierLabel: "Rare",
      skills: null,
      pp: 12_000,
      globalRank: 7,
      copies: 2,
      recycledCopies: 0,
      firstPulledAt: 1,
      lastPulledAt: 2,
    },
  },
  shards: 0,
  shardsSpent: 0,
  charges: 5,
  lastRefillAt: 0,
  openedPacks: 0,
  poolTotal: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each(["iPhone", "Android"])("keeps card actions open after a %s hold", (platform) => {
  render(
    <I18nProvider i18n={getI18n("en")}>
      <CollectionPanel wallet={wallet} showLoginNudge={false} syncStatus="local"
        onRecycleCard={() => 0} onRecycleWhole={() => 0} onRecycleWholeMany={() => 0}
        onRecycleWholeMatching={() => 0} onRecycleAll={() => 0} onApplyMint={() => true} />
    </I18nProvider>,
  );
  const card = screen.getByRole("button", { name: "View player7's card" });
  fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 80, clientY: 120 }] });
  act(() => { vi.advanceTimersByTime(500); });
  expect(screen.getByRole("menuitem", { name: "Select cards..." })).toBeTruthy();
  if (platform === "Android") {
    // The overlay now covers the card. Android can target its delayed native
    // contextmenu at that overlay instead of the original touch target.
    fireEvent.contextMenu(screen.getByRole("menu").previousElementSibling!, { clientX: 80, clientY: 120 });
    expect(screen.getByRole("menuitem", { name: "Select cards..." })).toBeTruthy();
  }
  fireEvent.touchEnd(card, { touches: [] });
  const select = screen.getByRole("menuitem", { name: "Select cards..." });
  // A compatibility click from lifting the original hold must not choose an
  // action under the finger. A fresh tap on that action must still work.
  fireEvent.click(select, { detail: 1 });
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.pointerDown(select, { pointerType: "touch" });
  fireEvent.click(select, { detail: 1 });
  expect(screen.getByRole("button", { name: "Deselect player7" })).toBeTruthy();
});

describe("CollectionPanel recycle-all hold", () => {
  it("omits recycling controls for the exclusive card", () => {
    const protectedWallet = { ...wallet, cards: { "7:v1": {
      ...wallet.cards["7"], cardKey: "7:v1", recyclable: false,
    } } };
    render(
      <I18nProvider i18n={getI18n("en")}>
        <CollectionPanel wallet={protectedWallet} showLoginNudge={false} syncStatus="local"
          onRecycleCard={() => 0} onRecycleWhole={() => 0} onRecycleWholeMany={() => 0}
          onRecycleWholeMatching={() => 0} onRecycleAll={() => 0} onApplyMint={() => true} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: /recycle/i })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "View player7's card" }));
    expect(screen.queryByRole("menuitem", { name: /recycle/i })).toBeNull();
  });

  it("claims the native context gesture and lets the hold finish", () => {
    const onRecycleAll = vi.fn(() => 0);
    render(
      <I18nProvider i18n={getI18n("en")}>
        <CollectionPanel
          wallet={wallet}
          showLoginNudge={false}
          syncStatus="local"
          onRecycleCard={() => 0}
          onRecycleWhole={() => 0}
          onRecycleWholeMany={() => 0}
          onRecycleWholeMatching={() => 0}
          onRecycleAll={onRecycleAll}
          onApplyMint={() => true}
        />
      </I18nProvider>,
    );

    const button = screen.getByRole("button", { name: /Hold to recycle every duplicate/ });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, pointerType: "touch" });

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(button.dispatchEvent(contextMenu)).toBe(false);
    expect(contextMenu.defaultPrevented).toBe(true);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onRecycleAll).toHaveBeenCalledTimes(1);
  });
});

const renderSelection = (count = 3) => {
  vi.useRealTimers();
  const cards = Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = index + 7;
    return [String(id), { ...wallet.cards["7"], userId: id, username: `player${id}`, pp: 10000 - index, avatarUrl: "https://a.ppy.sh/7" }];
  }));
  const binders = {
    list: vi.fn().mockResolvedValue([{ id: 1, name: "Friends", position: 0, showcased: false, createdAt: 1, updatedAt: 1, cards: [] }]),
    addCards: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
  };
  render(<I18nProvider i18n={getI18n("en")}>
    <CollectionPanel wallet={{ ...wallet, cards }} showLoginNudge={false} syncStatus="local" binders={binders}
      onRecycleCard={() => 0} onRecycleWhole={() => 0} onRecycleWholeMany={() => 0}
      onRecycleWholeMatching={() => 0} onRecycleAll={() => 0} onApplyMint={() => true} />
  </I18nProvider>);
  fireEvent.contextMenu(screen.getByRole("button", { name: "View player7's card" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Select cards..." }));
  return binders;
};

it("adds every selected card when right-clicking within the selection", async () => {
  const binders = renderSelection();
  fireEvent.click(screen.getByRole("button", { name: "Select player8" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Deselect player7" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add 2 cards to set..." }));
  const destination = await screen.findByRole("menuitem", { name: /^Friends/ });
  await act(async () => fireEvent.click(destination));
  expect(binders.addCards).toHaveBeenCalledWith(1, ["7", "8"]);
});

it("targets only the right-clicked card when it is outside the selection", async () => {
  const binders = renderSelection();
  fireEvent.click(screen.getByRole("button", { name: "Select player8" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Select player9" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to set..." }));
  const destination = await screen.findByRole("menuitem", { name: /^Friends/ });
  await act(async () => fireEvent.click(destination));
  expect(binders.addCards).toHaveBeenCalledWith(1, ["9"]);
});

it("blocks an oversized select-all instead of quietly adding only the visible page", async () => {
  const binders = renderSelection(20);
  fireEvent.click(screen.getByRole("button", { name: "select all" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Deselect player7" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add 20 cards to set..." }));
  const destination = await screen.findByRole("menuitem", { name: /^Friends/ });
  expect((destination as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe("Select at most 10 cards to add to a set.");
  fireEvent.click(destination);
  expect(binders.addCards).not.toHaveBeenCalled();
});

it("does not reuse a manual selection cleared by changing collection pages", async () => {
  const binders = renderSelection(20);
  fireEvent.click(screen.getAllByRole("button", { name: "Next collection page" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Select player22" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Deselect player22" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to set..." }));
  const destination = await screen.findByRole("menuitem", { name: /^Friends/ });
  await act(async () => fireEvent.click(destination));
  expect(binders.addCards).toHaveBeenCalledWith(1, ["22"]);
});

it("filters the grid to the cards held more than once, and carries that into a bulk recycle", () => {
  vi.useRealTimers();
  const onRecycleWholeMatching = vi.fn(() => 0);
  /* One page's worth of duplicates plus one, so "select all" (the scope that
     recycles by filter rather than by key) is on screen at all. */
  const cards = Object.fromEntries([
    ...Array.from({ length: 16 }, (_, index) => {
      const id = index + 7;
      return [String(id), { ...wallet.cards["7"], userId: id, username: `player${id}`, pp: 12_000 - index }];
    }),
    ["99", { ...wallet.cards["7"], userId: 99, username: "player99", copies: 1, pp: 9_000 }],
  ]);
  render(
    <I18nProvider i18n={getI18n("en")}>
      <CollectionPanel wallet={{ ...wallet, cards }} showLoginNudge={false} syncStatus="local"
        onRecycleCard={() => 0} onRecycleWhole={() => 0} onRecycleWholeMany={() => 0}
        onRecycleWholeMatching={onRecycleWholeMatching} onRecycleAll={() => 0} onApplyMint={() => true} />
    </I18nProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: /Duplicates/ }));
  expect(screen.getByRole("button", { name: "View player7's card" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "View player99's card" })).toBeNull();

  fireEvent.contextMenu(screen.getByRole("button", { name: "View player7's card" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Select cards..." }));
  fireEvent.click(screen.getByRole("button", { name: "select all" }));
  fireEvent.click(screen.getByRole("button", { name: /^Recycle \+/ }));
  fireEvent.click(screen.getByRole("button", { name: /Sure\?/ }));
  expect(onRecycleWholeMatching).toHaveBeenCalledWith({ tier: "all", query: "", duplicatesOnly: true });
});
