import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyBackdropPick,
  backdropForKeymode,
  BackdropDealer,
  type BackdropSelection,
  drawSkinPreviewBackdrops,
  replaceBackdrop,
  SKIN_BACKDROP_POOL_SIZE,
} from "./skin-preview-backdrops";
import { fetchLiveMapSearch, type LiveMapSearchEntry } from "./live-backend";
import { SKIN_PREVIEW_BACKGROUND_SETS } from "./skin-preview-render";

vi.mock("./live-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live-backend")>()),
  fetchLiveMapSearch: vi.fn(),
}));

const search = vi.mocked(fetchLiveMapSearch);

function catalogPage(setIds: number[]): { items: LiveMapSearchEntry[]; total: number; page: number; pageSize: number } {
  const items = setIds.map((setId) => ({
    beatmapsetId: setId,
    beatmapId: setId * 10,
    title: `title ${setId}`,
    artist: `artist ${setId}`,
  })) as unknown as LiveMapSearchEntry[];
  return { items, total: items.length, page: 0, pageSize: items.length };
}

beforeEach(() => {
  search.mockReset();
});

describe("drawSkinPreviewBackdrops", () => {
  it("draws the pool from the map catalog, not the baked list", async () => {
    const catalogIds = Array.from({ length: 48 }, (_, index) => 900_000 + index);
    search.mockResolvedValue(catalogPage(catalogIds));

    const pool = await drawSkinPreviewBackdrops();

    expect(pool).toHaveLength(SKIN_BACKDROP_POOL_SIZE);
    expect(pool.every((candidate) => catalogIds.includes(candidate.setId))).toBe(true);
    expect(pool[0].label).toMatch(/^artist \d+ - title \d+$/);
  });

  it("varies between draws instead of always serving the same covers", async () => {
    search.mockResolvedValue(catalogPage(Array.from({ length: 48 }, (_, index) => 900_000 + index)));

    const first = await drawSkinPreviewBackdrops();
    const second = await drawSkinPreviewBackdrops({ exclude: first.map((candidate) => candidate.setId) });

    const overlap = second.filter((candidate) => first.some((other) => other.setId === candidate.setId));
    expect(overlap).toHaveLength(0);
  });

  it("asks for a different catalog page each time", async () => {
    search.mockResolvedValue(catalogPage(Array.from({ length: 48 }, (_, index) => 900_000 + index)));

    for (let draw = 0; draw < 12; draw += 1) await drawSkinPreviewBackdrops();

    const pages = new Set(search.mock.calls.map(([params]) => params.page));
    expect(pages.size).toBeGreaterThan(1);
    expect([...pages].every((page) => Number.isInteger(page) && page >= 0)).toBe(true);
  });

  it("deduplicates sets within a draw", async () => {
    search.mockResolvedValue(catalogPage([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]));

    const pool = await drawSkinPreviewBackdrops();

    expect(new Set(pool.map((candidate) => candidate.setId)).size).toBe(pool.length);
  });

  it("falls back to the baked covers when the catalog is unreachable", async () => {
    search.mockRejectedValue(new Error("live backend down"));

    const pool = await drawSkinPreviewBackdrops();

    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((candidate) => SKIN_PREVIEW_BACKGROUND_SETS.includes(candidate.setId))).toBe(true);
  });

  it("falls back when the catalog page is too thin to fill a picker", async () => {
    search.mockResolvedValue(catalogPage([777]));

    const pool = await drawSkinPreviewBackdrops();

    expect(pool.every((candidate) => SKIN_PREVIEW_BACKGROUND_SETS.includes(candidate.setId))).toBe(true);
  });
});

describe("per-keymode backdrop selection", () => {
  const selection = (shared: number | "flat", overrides: Array<[number, number | "flat"]> = []): BackdropSelection =>
    ({ shared, overrides: new Map(overrides) });

  it("keeps every keymode on the shared backdrop until one is retargeted", () => {
    const base = selection(100);
    expect(backdropForKeymode(base, 4)).toBe(100);
    expect(backdropForKeymode(base, 7)).toBe(100);

    const next = applyBackdropPick(base, { scope: "keymode", keymode: 7, choice: 200 });

    expect(backdropForKeymode(next, 7)).toBe(200);
    expect(backdropForKeymode(next, 4)).toBe(100);
    expect(backdropForKeymode(next, 10)).toBe(100);
  });

  it("does not record an override when the pick matches the shared backdrop", () => {
    const base = selection(100, [[7, 200]]);

    const next = applyBackdropPick(base, { scope: "keymode", keymode: 7, choice: 100 });

    expect(next.overrides.size).toBe(0);
    expect(backdropForKeymode(next, 7)).toBe(100);
  });

  it("puts every keymode back together on an all-scoped pick", () => {
    const base = selection(100, [[5, 200], [7, "flat"]]);

    const next = applyBackdropPick(base, { scope: "all", keymode: 4, choice: 300 });

    expect(next.overrides.size).toBe(0);
    expect([4, 5, 7].map((keys) => backdropForKeymode(next, keys))).toEqual([300, 300, 300]);
  });

  it("scopes the flat backdrop to one keymode too", () => {
    const next = applyBackdropPick(selection(100), { scope: "keymode", keymode: 4, choice: "flat" });

    expect(backdropForKeymode(next, 4)).toBe("flat");
    expect(backdropForKeymode(next, 7)).toBe(100);
  });

  it("leaves the inputs untouched", () => {
    const base = selection(100, [[7, 200]]);

    applyBackdropPick(base, { scope: "keymode", keymode: 4, choice: 300 });
    applyBackdropPick(base, { scope: "all", keymode: 4, choice: 300 });

    expect(base.shared).toBe(100);
    expect([...base.overrides]).toEqual([[7, 200]]);
  });

  it("moves only what pointed at a dead cover", () => {
    const base = selection(100, [[5, 200], [7, 100]]);

    const next = replaceBackdrop(base, 100, 400);

    expect(next.shared).toBe(400);
    expect(backdropForKeymode(next, 7)).toBe(400);
    expect(backdropForKeymode(next, 5)).toBe(200);
  });

  it("leaves the selection alone when the dead cover is unused", () => {
    const base = selection(100, [[5, 200]]);

    const next = replaceBackdrop(base, 999, 400);

    expect(next.shared).toBe(100);
    expect([...next.overrides]).toEqual([[5, 200]]);
  });
});

describe("BackdropDealer", () => {
  const pool = Array.from({ length: 5 }, (_, index) => ({ setId: 100 + index, label: "" }));

  it("gives every cover out once before repeating any", () => {
    const dealer = new BackdropDealer(pool);
    const dealt = pool.map(() => dealer.next()?.setId);

    expect(new Set(dealt).size).toBe(pool.length);
    expect([...dealt].sort()).toEqual(pool.map((candidate) => candidate.setId));
  });

  it("starts a fresh pass once the pool runs dry", () => {
    const dealer = new BackdropDealer(pool);
    for (let index = 0; index < pool.length; index += 1) dealer.next();

    // A queue longer than the pool has to repeat, but only after everything
    // has been used once.
    const second = pool.map(() => dealer.next()?.setId);
    expect(new Set(second).size).toBe(pool.length);
  });

  it("has nothing to deal when the draw came back empty", () => {
    const dealer = new BackdropDealer([]);
    expect(dealer.next()).toBeNull();
    expect(dealer.next()).toBeNull();
  });
});
