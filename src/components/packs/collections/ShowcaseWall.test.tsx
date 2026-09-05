// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
afterEach(cleanup);
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
