// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "#/lib/i18n";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { MissingPlayerTile } from "./MissingPlayerTile";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, params: _params, ...props }: ComponentProps<"a"> & { to: string; params: unknown; children?: ReactNode }) => <a href="/card" {...props}>{children}</a>,
}));
vi.mock("../ui/CountryFlag", () => ({ CountryFlag: () => null }));
const player = { userId: 17, username: "Friend", avatarUrl: "https://a.ppy.sh/17", countryCode: "CR", globalRank: 1, poolRank: 1, pp: 1000 };
afterEach(cleanup);
function show(wished = false, full = false, enabled = true) {
  const toggle = vi.fn(async () => {});
  render(<I18nProvider i18n={getI18n("en")}><MissingPlayerTile player={player} wishlist={enabled ? { userIds: new Set(wished ? [17] : []), full, toggle } : undefined} /></I18nProvider>);
  return toggle;
}
it("opens Wish from right click without following the card link", () => {
  const toggle = show();
  expect(fireEvent.contextMenu(screen.getByRole("link"), { clientX: 200, clientY: 150 })).toBe(false);
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Wish" }));
  expect(toggle).toHaveBeenCalledExactlyOnceWith(17);
  expect(screen.queryByRole("menu")).toBeNull();
});
it("lets an existing wish be removed even when the list is full", () => {
  const toggle = show(true, true);
  fireEvent.contextMenu(screen.getByRole("link"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove wish" }));
  expect(toggle).toHaveBeenCalledExactlyOnceWith(17);
});
it("disables adding when full while keeping the profile action available", () => {
  const toggle = show(false, true);
  fireEvent.contextMenu(screen.getByRole("link"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Wishlist is full (5)" }));
  expect(toggle).not.toHaveBeenCalled();
  expect(screen.getByRole("menuitem", { name: "Open profile" })).toBeTruthy();
});
it("supports the keyboard context-menu shortcut and Escape", () => {
  show();
  const link = screen.getByRole("link");
  fireEvent.keyDown(link, { key: "F10", shiftKey: true });
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(link);
});
it("keeps the native link menu for accounts without wishlist access", () => {
  show(false, false, false);
  expect(fireEvent.contextMenu(screen.getByRole("link"))).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
});
