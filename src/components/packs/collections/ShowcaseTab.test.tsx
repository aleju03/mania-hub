// @vitest-environment jsdom
/* The frame this covers is the server-rendered one. Both halves of the page
   are read browser-direct after mount, so what the server ships is the two
   skeletons, and if the shelf's is missing from it the wall below jumps down a
   card's height the moment the shelf lands. That is invisible to a test that
   only asserts on the settled page, so this one renders the tab the way the
   server does and counts what it reserved. */
import { renderToString as reactRenderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "#/lib/i18n";
import { expect, it, vi } from "vitest";

const viewer = { id: 7095193, username: "Aleju03", avatarUrl: "", countryCode: "CR" };

vi.mock("#/lib/auth-context", () => ({
  useAuth: () => ({ viewer, isAdmin: true, canUseDevFeatures: true, canUseAdminFeatures: true }),
}));
/* Neither read ever settles here, which is exactly the state under test. */
vi.mock("#/lib/live-backend", () => ({
  isLiveBackendConfigured: () => true,
  fetchLivePackShowcaseCards: () => new Promise(() => {}),
  fetchLivePackShowcaseWall: () => new Promise(() => {}),
}));
vi.mock("#/lib/pack-wallet-sync", () => ({ saveOwnPackShowcase: () => Promise.resolve() }));
vi.mock("./ShowcasePicker", () => ({ ShowcasePickerHost: () => null }));

const { ShowcaseTab } = await import("./ShowcaseTab");

// The tab reads its copy through Lingui; en resolves to the source strings.
const renderToString = (ui: ReactElement) =>
  reactRenderToString(<I18nProvider i18n={getI18n("en")}>{ui}</I18nProvider>);

const WALL_TILES = 40;
const slots = (html: string) => html.split("skeleton-pulse").length - 1;

it("reserves the shelf the browser last saw, in the frame the server renders", () => {
  const html = renderToString(<ShowcaseTab shelfSlots={3} />);
  expect(slots(html)).toBe(WALL_TILES + 3);
  // At the size the real cards render, not a bar standing in for them.
  expect(html).toContain("w-[92px]");
  expect(html).toContain("aspect-ratio:5 / 7");
});

it("reserves nothing for a browser that has not seen the shelf", () => {
  expect(slots(renderToString(<ShowcaseTab shelfSlots={0} />))).toBe(WALL_TILES);
});

it("holds a page of the wall either way", () => {
  expect(slots(renderToString(<ShowcaseTab shelfSlots={0} />))).toBe(WALL_TILES);
  expect(renderToString(<ShowcaseTab shelfSlots={0} />)).toContain("repeat(auto-fill,minmax(96px,1fr))");
});
