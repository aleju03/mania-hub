import { readFile } from "node:fs/promises";
import { ImageResponse } from "@vercel/og";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { loadRenderModBadges, renderModBadge } from "./og-mod-badge";

afterEach(() => vi.unstubAllGlobals());

it("preserves a custom speed when the badge assets fail to load", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  const [badge] = await loadRenderModBadges(new Request("http://localhost:3000/replay"), [{ acronym: "DC", rate: 0.9 }]);
  const element = h("div", { style: { display: "flex", background: "#120d15", width: "100%", height: "100%" } }, renderModBadge(badge, 0, 44));
  expect(renderToStaticMarkup(element)).toContain("0.90x");
  // Exercise the actual Satori renderer as well as the text fallback.
  const response = new ImageResponse(element, { width: 240, height: 80 });
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
});

it("renders the shipped badge masks and custom speed extender together", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const file = new URL(`../../public${new URL(input).pathname}`, import.meta.url);
    return new Response(await readFile(file, "utf8"), { headers: { "content-type": "image/svg+xml" } });
  }));
  const badges = await loadRenderModBadges(new Request("http://localhost:3000/replay"), ["HD", { acronym: "DT", rate: 1.2 }]);
  expect(badges[0].tail).toBeNull();
  expect(badges[1].extender).toMatch(/^data:image\/svg\+xml;base64,/);
  const element = h("div", { style: { display: "flex", background: "#120d15", width: "100%", height: "100%" } }, badges.map((badge, i) => renderModBadge(badge, i, 44)));
  expect(renderToStaticMarkup(element)).toContain("1.20x");
  expect((await new ImageResponse(element, { width: 320, height: 80 }).arrayBuffer()).byteLength).toBeGreaterThan(100);
});
