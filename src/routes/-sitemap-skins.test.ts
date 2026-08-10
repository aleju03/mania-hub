import { describe, expect, it } from "vitest";

import { buildSitemap } from "./sitemap[.]xml";
import { isDefaultSkinsView } from "./skins";

const ORIGIN = "https://mania-tracker.com";

describe("sitemap", () => {
  it("keeps the static paths when there are no skins", () => {
    const xml = buildSitemap(ORIGIN, []);
    expect(xml).toContain("<loc>https://mania-tracker.com/</loc>");
    expect(xml).toContain("<loc>https://mania-tracker.com/skins</loc>");
    expect(xml.match(/<url>/g)).toHaveLength(9);
  });

  it("adds a url per skin, with the lastmod at date precision", () => {
    const xml = buildSitemap(ORIGIN, [
      { path: "/skins/r-skin-v1-2-bars", lastmod: "2026-08-10T14:03:11.000Z" },
      { path: "/skins/gray-malevich-edited", lastmod: null },
    ]);
    expect(xml).toContain("<loc>https://mania-tracker.com/skins/r-skin-v1-2-bars</loc>");
    expect(xml).toContain("<lastmod>2026-08-10</lastmod>");
    expect(xml).toContain("<loc>https://mania-tracker.com/skins/gray-malevich-edited</loc>");
    expect(xml.match(/<url>/g)).toHaveLength(11);
    // The undated skin carries no lastmod rather than an empty or invalid one.
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  it("drops a lastmod it cannot parse instead of emitting it", () => {
    const xml = buildSitemap(ORIGIN, [{ path: "/skins/x", lastmod: "not a date" }]);
    expect(xml).not.toContain("<lastmod>");
    expect(xml).toContain("<loc>https://mania-tracker.com/skins/x</loc>");
  });

  it("escapes a slug that would otherwise break the document", () => {
    const xml = buildSitemap(ORIGIN, [{ path: "/skins/a&b<c", lastmod: null }]);
    expect(xml).toContain("<loc>https://mania-tracker.com/skins/a&amp;b&lt;c</loc>");
  });
});

describe("skins default view", () => {
  it("is the plain browse URL", () => {
    expect(isDefaultSkinsView({})).toBe(true);
    expect(isDefaultSkinsView({ q: "", page: 0, sort: "newest", k: 0, mine: false })).toBe(true);
  });

  it("is not any filtered, paged or sorted URL", () => {
    expect(isDefaultSkinsView({ q: "rainbow" })).toBe(false);
    expect(isDefaultSkinsView({ page: 1 })).toBe(false);
    expect(isDefaultSkinsView({ sort: "downloads" })).toBe(false);
    expect(isDefaultSkinsView({ k: 4 })).toBe(false);
    // "uploader: you" is viewer-scoped, so it must never be server-rendered
    // into a page a crawler or another visitor could be handed.
    expect(isDefaultSkinsView({ mine: true })).toBe(false);
  });
});
