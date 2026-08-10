import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchSkinSitemapEntries,
  fetchSkinsListSsr,
  SKIN_LIST_MAX_PAGE_SIZE,
  SKINS_PAGE_SIZE,
  type SkinSummary,
} from "./skins";

// Only the fields the sitemap walk reads; the rest of a summary is irrelevant.
function skin(n: number, extra: Partial<SkinSummary> = {}): SkinSummary {
  return {
    id: `id-${n}`,
    slug: `skin-${n}`,
    visibility: "public",
    publishedAt: "2026-08-01T00:00:00.000Z",
    oskUpdatedAt: null,
    ...extra,
  } as SkinSummary;
}

function respondWithPages(pages: Array<{ skins: SkinSummary[]; total: number }>) {
  return vi.fn(async (input: string | URL) => {
    const page = Number(new URL(String(input)).searchParams.get("page") ?? 0);
    const body = pages[page] ?? { skins: [], total: 0 };
    return {
      ok: true,
      json: async () => ({ ...body, page, pageSize: SKIN_LIST_MAX_PAGE_SIZE }),
    } as Response;
  });
}

const originalFetch = globalThis.fetch;
const originalEnv = {
  LIVE_BACKEND_URL: process.env.LIVE_BACKEND_URL,
  VITE_LIVE_BACKEND_URL: process.env.VITE_LIVE_BACKEND_URL,
};

beforeEach(() => {
  process.env.LIVE_BACKEND_URL = "http://localhost:7227";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("server-rendered skins list", () => {
  it("asks for one unfiltered page of the browse view", async () => {
    const fetchMock = respondWithPages([{ skins: [skin(1)], total: 1 }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchSkinsListSsr();

    expect(result?.skins).toHaveLength(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("pageSize")).toBe(String(SKINS_PAGE_SIZE));
    // A viewer-scoped or filtered server render would leak one person's view
    // into a page every visitor and every crawler is handed.
    for (const param of ["q", "owner", "k", "sort", "page", "visibility", "allPrivate"]) {
      expect(url.searchParams.get(param)).toBeNull();
    }
  });

  // Each of these is the fallback the SSR timeout leans on: a null here means
  // the page renders exactly as it did before, skeletons until the browser
  // fetches the list itself. It must never throw into the loader.
  it("returns null when the backend answers with an error", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    expect(await fetchSkinsListSsr()).toBeNull();
  });

  it("returns null when the request times out or the connection fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await fetchSkinsListSsr()).toBeNull();
  });

  it("returns null on a body that is not a list", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: "unavailable" }),
    }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchSkinsListSsr()).toBeNull();
  });

  it("returns null when no backend is configured", async () => {
    delete process.env.LIVE_BACKEND_URL;
    delete process.env.VITE_LIVE_BACKEND_URL;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await fetchSkinsListSsr()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("skin sitemap entries", () => {
  it("walks past the backend's page cap to reach every skin", async () => {
    const first = Array.from({ length: SKIN_LIST_MAX_PAGE_SIZE }, (_, i) => skin(i));
    const second = Array.from({ length: 14 }, (_, i) => skin(SKIN_LIST_MAX_PAGE_SIZE + i));
    const fetchMock = respondWithPages([
      { skins: first, total: 64 },
      { skins: second, total: 64 },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const entries = await fetchSkinSitemapEntries();

    expect(entries).toHaveLength(64);
    expect(entries[0].path).toBe("/skins/skin-0");
    expect(entries[63].path).toBe("/skins/skin-63");
    // Two pages, then it stops: a short page means the walk is done.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(`pageSize=${SKIN_LIST_MAX_PAGE_SIZE}`);
  });

  it("stops once the reported total is covered", async () => {
    const fetchMock = respondWithPages([
      { skins: Array.from({ length: SKIN_LIST_MAX_PAGE_SIZE }, (_, i) => skin(i)), total: SKIN_LIST_MAX_PAGE_SIZE },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await fetchSkinSitemapEntries()).toHaveLength(SKIN_LIST_MAX_PAGE_SIZE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never lets a private skin into the sitemap", async () => {
    globalThis.fetch = respondWithPages([{
      skins: [skin(1), skin(2, { visibility: "private" }), skin(3)],
      total: 3,
    }]) as unknown as typeof fetch;

    const entries = await fetchSkinSitemapEntries();

    expect(entries.map((e) => e.path)).toEqual(["/skins/skin-1", "/skins/skin-3"]);
  });

  it("falls back to the row id when a skin predates slugs", async () => {
    globalThis.fetch = respondWithPages([{ skins: [skin(1, { slug: null })], total: 1 }]) as unknown as typeof fetch;

    expect((await fetchSkinSitemapEntries())[0].path).toBe("/skins/id-1");
  });

  it("prefers the .osk update over the publish date for lastmod", async () => {
    globalThis.fetch = respondWithPages([{
      skins: [skin(1, { oskUpdatedAt: "2026-08-09T10:00:00.000Z" })],
      total: 1,
    }]) as unknown as typeof fetch;

    expect((await fetchSkinSitemapEntries())[0].lastmod).toBe("2026-08-09T10:00:00.000Z");
  });

  it("keeps the pages it already walked when one fails mid-walk", async () => {
    const first = Array.from({ length: SKIN_LIST_MAX_PAGE_SIZE }, (_, i) => skin(i));
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const page = Number(new URL(String(input)).searchParams.get("page") ?? 0);
      if (page > 0) return { ok: false, status: 503 } as Response;
      return { ok: true, json: async () => ({ skins: first, total: 200, page, pageSize: SKIN_LIST_MAX_PAGE_SIZE }) } as Response;
    }) as unknown as typeof fetch;

    expect(await fetchSkinSitemapEntries()).toHaveLength(SKIN_LIST_MAX_PAGE_SIZE);
  });

  it("returns nothing when no backend is configured", async () => {
    delete process.env.LIVE_BACKEND_URL;
    delete process.env.VITE_LIVE_BACKEND_URL;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await fetchSkinSitemapEntries()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
