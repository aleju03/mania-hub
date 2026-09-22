// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, expect, it } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { CollectedCard } from "#/lib/pack-collection";
import { CardMarks, cardMarksFor } from "./CardMarks";

const base: CollectedCard = { userId: 7, cardKey: "7", username: "Player 7", avatarUrl: "https://a.ppy.sh/7", countryCode: "CR", tier: "common", tierLabel: "Common", skills: null, pp: 1, globalRank: 1, copies: 1, recycledCopies: 0, firstPulledAt: 1, lastPulledAt: 1 };
afterEach(cleanup);

it("marks a serial 1 as first, or as the only one when nobody else pulled it", () => {
  expect(cardMarksFor({ ...base, serial: 1, mintedTotal: 12 }, 9)).toEqual([{ kind: "first" }]);
  expect(cardMarksFor({ ...base, serial: 1, mintedTotal: 1 }, 9)).toEqual([{ kind: "only" }]);
  expect(cardMarksFor({ ...base, serial: 3, mintedTotal: 40 }, 9)).toEqual([{ kind: "early", serial: 3 }]);
  expect(cardMarksFor({ ...base, serial: 4, mintedTotal: 40 }, 9)).toEqual([]);
});

it("never reads a granted or gifted card's serial as a pull, but still calls a lone serial a 1/1", () => {
  expect(cardMarksFor({ ...base, serial: 1, mintedTotal: 12, grantedAt: 5 }, 9)).toEqual([]);
  expect(cardMarksFor({ ...base, serial: 2, mintedTotal: 12, grantedAt: 5 }, 9)).toEqual([]);
  expect(cardMarksFor({ ...base, serial: 1, grantedAt: 5, giftedBy: { userId: 2, username: "Giver" } }, 9)).toEqual([]);
  // One serial ever minted: the copy is unique whoever minted it, which is
  // what an awarded Eternal or a desk one-off is.
  expect(cardMarksFor({ ...base, serial: 1, mintedTotal: 1, grantedAt: 5 }, 9)).toEqual([{ kind: "only" }]);
});

it("marks a collector holding their own card, only when the surface knows whose shelf it is", () => {
  expect(cardMarksFor({ ...base, serial: 2, mintedTotal: 5 }, 7)).toEqual([{ kind: "early", serial: 2 }, { kind: "self" }]);
  expect(cardMarksFor(base, null)).toEqual([]);
  expect(cardMarksFor(base, undefined)).toEqual([]);
});

it("draws a medal for the serial and the player's own face for a self pull", () => {
  render(<I18nProvider i18n={getI18n("en")}><CardMarks card={{ ...base, serial: 1, mintedTotal: 3 }} collectorUserId={7} /></I18nProvider>);
  expect(screen.getByRole("img", { name: "First to pull this card" }).textContent).toContain("1");
  const face = screen.getByRole("img", { name: "Player 7 pulled their own card" }) as HTMLImageElement;
  expect(face.src).toBe("https://a.ppy.sh/7");
});

it("renders nothing for an ordinary holding", () => {
  const { container } = render(<I18nProvider i18n={getI18n("en")}><CardMarks card={{ ...base, serial: 9, mintedTotal: 30 }} collectorUserId={1} /></I18nProvider>);
  expect(container.innerHTML).toBe("");
});
