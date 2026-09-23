import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPlayerSitemapEntries } from "#/lib/player-sitemap";
import { buildSitemap } from "./sitemap[.]xml";
import { TEAMS_OPEN } from "#/lib/auth-shared";

// /teams joins the static paths once teams leave the owner's preview.
const TEAMS_PATHS = TEAMS_OPEN ? 1 : 0;

const ORIGIN = "https://mania-tracker.com";

describe("sitemap players", () => {
  it("adds a url per player after the skins, with the lastmod at date precision", () => {
    const xml = buildSitemap(ORIGIN, [{ path: "/skins/x", lastmod: null }], [
      { path: "/player/Some%20Player", lastmod: "2026-09-12T08:30:00.000Z" },
      { path: "/player/Undated", lastmod: null },
    ]);
    expect(xml).toContain("<loc>https://mania-tracker.com/player/Some%20Player</loc>");
    expect(xml).toContain("<lastmod>2026-09-12</lastmod>");
    expect(xml).toContain("<loc>https://mania-tracker.com/player/Undated</loc>");
    expect(xml.match(/<url>/g)).toHaveLength(15 + TEAMS_PATHS);
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
    expect(xml.indexOf("/skins/x")).toBeLessThan(xml.indexOf("/player/"));
  });
});

describe("fetchPlayerSitemapEntries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("encodes each username the way the profile page's canonical URL does", async () => {
    vi.stubEnv("LIVE_BACKEND_URL", "http://backend.test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      players: [
        { username: "Some Player", lastmod: "2026-09-12T08:30:00.000Z" },
        { username: "[Bracket]_x", lastmod: null },
        { username: "  ", lastmod: null },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const entries = await fetchPlayerSitemapEntries();
    expect(fetchMock).toHaveBeenCalledWith("http://backend.test/api/sitemap/players", expect.anything());
    expect(entries).toEqual([
      { path: "/player/Some%20Player", lastmod: "2026-09-12T08:30:00.000Z" },
      { path: "/player/%5BBracket%5D_x", lastmod: null },
    ]);
  });

  it("throws on a backend error, so the sitemap tries again sooner", async () => {
    vi.stubEnv("LIVE_BACKEND_URL", "http://backend.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(fetchPlayerSitemapEntries()).rejects.toThrow();
  });
});
