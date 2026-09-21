import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSkinsListSsr, type SkinsListResult } from "../lib/skins";
import { parseSkinsSearch, Route } from "./skins";

vi.mock("../lib/skins", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/skins")>(),
  fetchSkinsListSsr: vi.fn(),
}));

const fetchList = vi.mocked(fetchSkinsListSsr);
const list: SkinsListResult = { skins: [], total: 49, page: 1, pageSize: 24 };

async function load(search: Record<string, unknown>) {
  const deps = Route.options.loaderDeps!({ search: parseSkinsSearch(search) } as never);
  const loader = Route.options.loader;
  if (typeof loader !== "function") throw new Error("Expected a route loader");
  return loader({ deps } as never);
}

async function head(search: Record<string, unknown>) {
  return Route.options.head!({
    match: { search: parseSkinsSearch(search), context: { origin: "https://mania-tracker.com", locale: "en" } },
  } as never);
}

beforeEach(() => {
  fetchList.mockReset();
  fetchList.mockResolvedValue(list);
});

describe("skins pagination", () => {
  it("server-loads later catalogue pages and retains the last partial page", async () => {
    expect(await load({ page: "1" })).toBe(list);
    expect(fetchList).toHaveBeenCalledWith(1);
    fetchList.mockResolvedValue({ ...list, page: 2 });
    expect(await load({ page: 2 })).toMatchObject({ page: 2 });
  });

  it("returns a real not-found result beyond the end of the catalogue", async () => {
    await expect(load({ page: 3 })).rejects.toMatchObject({ isNotFound: true });
    fetchList.mockResolvedValue({ ...list, total: 48 });
    await expect(load({ page: 2 })).rejects.toMatchObject({ isNotFound: true });
  });

  it("keeps backend outages distinct from missing pages", async () => {
    fetchList.mockResolvedValue(null);
    expect(await load({ page: 1 })).toBeNull();
  });

  it.each([{ q: "bars" }, { sort: "downloads" }, { mine: true }, { k: 4 }, { shape: "circle" }])(
    "does not server-fetch filtered views: %j", async (search) => {
      expect(await load({ ...search, page: 1 })).toBeNull();
      expect(fetchList).not.toHaveBeenCalled();
      expect((await head(search))?.meta).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    },
  );

  it("gives each browse page its own canonical, with a clean first-page URL", async () => {
    expect((await head({}))?.links).toContainEqual({ rel: "canonical", href: "https://mania-tracker.com/skins" });
    expect((await head({ page: 0 }))?.links).toContainEqual({ rel: "canonical", href: "https://mania-tracker.com/skins" });
    const later = await head({ page: 2 });
    expect(later?.links).toContainEqual({ rel: "canonical", href: "https://mania-tracker.com/skins?page=2" });
    expect(later?.meta?.some((entry) => entry && "name" in entry && entry.name === "robots" && entry.content?.includes("noindex"))).toBe(false);
  });
});
