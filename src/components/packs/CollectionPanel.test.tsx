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

describe("CollectionPanel recycle-all hold", () => {
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
