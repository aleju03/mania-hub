// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "#/lib/i18n";
import { afterEach, expect, it, vi } from "vitest";
import type { LivePackShowcaseWallCard } from "#/lib/live-backend";
import { ShowcaseWallGrid } from "./ShowcaseWall";
vi.mock("#/lib/analytics", () => ({ track: () => {} }));
vi.mock("../CardTile", () => ({ CollectionCardTile: ({ card }: { card: { username: string } }) => <div>{card.username}</div>, CollectionCardPlaceholder: () => <div>placeholder</div> }));
vi.mock("../cardThumbnailCache", () => ({ cardThumbnailKeyForCollectionCard: () => "key", getMemoryCardThumbnail: () => null }));
vi.mock("../useCardThumbnails", () => ({ useCardThumbnails: () => ({ onThumbnailError: () => {} }) }));
vi.mock("../CardSpotlight", () => ({ CardSpotlight: ({ target }: { target: { showcasedBy: { username: string }; card: { username: string } } | null }) => target ? <div role="dialog">{target.showcasedBy.username}: {target.card.username}</div> : null }));
const card = (id: number) => ({ userId: id, cardKey: String(id), username: `Player ${id}`, avatarUrl: "https://a.ppy.sh/1", countryCode: "CR", tier: "common" as const, tierLabel: "Common", skills: null, pp: 1, globalRank: 1, copies: 1, recycledCopies: 0, firstPulledAt: 1, lastPulledAt: 1 });
const collector = { userId: 123, username: "Secret curator", avatarUrl: "https://a.ppy.sh/123", countryCode: "CR", cards: 10, goats: 0, tracked: true };
const entries: LivePackShowcaseWallCard[] = [
  { collector, showcasedAt: 10, card: card(1) },
  { collector, showcasedAt: 9, card: card(3), set: { id: 1, name: "Matching avatars", cards: [card(3), card(2)] } },
  { collector, showcasedAt: 8, card: card(4) },
];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("places a set among individual cards in the same grid, preserving order", () => {
  const { container } = render(<I18nProvider i18n={getI18n("en")}><ShowcaseWallGrid entries={entries} /></I18nProvider>);
  const group = screen.getByRole("group", { name: "Matching avatars" });
  expect(group.parentElement).toBe(container.firstElementChild);
  expect([...group.parentElement!.children].map((node) => node.textContent)).toEqual(["Player 1", "Player 3Player 2Matching avatars", "Player 4"]);
  expect(screen.queryByText("Secret curator")).toBeNull();
});
it("reveals the creator only in the spotlight for the selected set card", () => {
  render(<I18nProvider i18n={getI18n("en")}><ShowcaseWallGrid entries={entries} /></I18nProvider>);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(within(screen.getByRole("group")).getByRole("button", { name: "Inspect Player 2's maniacard" }));
  expect(screen.getByRole("dialog").textContent).toBe("Secret curator: Player 2");
});


it("can return to the first card after a fractional end snap and rechecks arrows on resize", () => {
  let resize!: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const setEntry = { ...entries[1], set: { id: 2, name: "GodGamers", cards: [card(5), card(6), card(7)] } };
  render(<I18nProvider i18n={getI18n("en")}><ShowcaseWallGrid entries={[setEntry]} /></I18nProvider>);
  const group = screen.getByRole("group", { name: "GodGamers" });
  const strip = group.firstElementChild as HTMLDivElement;
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 293 },
    scrollWidth: { configurable: true, value: 444.5 },
  });
  vi.spyOn(strip.firstElementChild!, "getBoundingClientRect").mockReturnValue({ width: 140 } as DOMRect);
  strip.scrollBy = vi.fn((options?: ScrollToOptions | number) => {
    const left = typeof options === "number" ? options : options?.left ?? 0;
    strip.scrollLeft = Math.max(0, Math.min(151.5, strip.scrollLeft + left));
    fireEvent.scroll(strip);
  });
  act(() => resize([], {} as ResizeObserver));
  const previous = within(group).getByRole("button", { name: "Previous cards in GodGamers" }) as HTMLButtonElement;
  const next = within(group).getByRole("button", { name: "Next cards in GodGamers" }) as HTMLButtonElement;
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);
  fireEvent.click(next);
  expect(strip.scrollLeft).toBe(151.5);
  expect(previous.disabled).toBe(false);
  expect(next.disabled).toBe(true);
  fireEvent.click(previous);
  expect(strip.scrollLeft).toBe(0);
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(false);

  // A swipe also enables the back arrow before a whole card has passed.
  strip.scrollLeft = 75;
  fireEvent.scroll(strip);
  expect(previous.disabled).toBe(false);
  expect(next.disabled).toBe(false);

  strip.scrollLeft = 0;
  Object.defineProperty(strip, "clientWidth", { value: 445 });
  act(() => resize([], {} as ResizeObserver));
  expect(within(group).queryByRole("button", { name: "Previous cards in GodGamers" })).toBeNull();
  expect(within(group).queryByRole("button", { name: "Next cards in GodGamers" })).toBeNull();
});
