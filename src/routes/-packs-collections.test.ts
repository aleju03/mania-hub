import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergePulls, Route, withLivePulls } from "./packs_.collections";

const validateSearch = Route.options.validateSearch as (
  search: Record<string, unknown>,
) => { collector?: string; tab?: string };

describe("collections search params", () => {
  it("keeps a collector name and drops everything that is not one", () => {
    expect(validateSearch({ collector: "Fullerene-" })).toEqual({ collector: "Fullerene-" });
    // An id is a name here too: the boards link by name, but a collector with
    // no users row is reachable by id.
    expect(validateSearch({ collector: "2531335" })).toEqual({ collector: "2531335" });
    expect(validateSearch({ collector: "  spaced  " })).toEqual({ collector: "spaced" });
    expect(validateSearch({})).toEqual({});
    expect(validateSearch({ collector: "" })).toEqual({});
    expect(validateSearch({ collector: "   " })).toEqual({});
    expect(validateSearch({ collector: 42 })).toEqual({});
    expect(validateSearch({ collector: ["a"] })).toEqual({});
  });

  it("caps a name at a name's length, since the backend looks it up in two tables", () => {
    const search = validateSearch({ collector: "x".repeat(500) });
    expect(search.collector).toHaveLength(60);
  });
});

describe("collections access", () => {
  // Only the auth in context matters here; the rest of the router's
  // BeforeLoadContextOptions is not what beforeLoad reads.
  const beforeLoad = Route.options.beforeLoad as unknown as (opts: { context: { auth: unknown } }) => unknown;

  it("is open to everyone, signed in or not", () => {
    /* Released: the page was admin-gated while it was being built and is not
       any more, so nothing here may put a 404 back in front of a visitor. The
       reads behind it were always public - everything they serve was already
       readable one card at a time through the pull ticker. */
    expect(() => beforeLoad({ context: { auth: { canUseAdminFeatures: false } } })).not.toThrow();
    expect(() => beforeLoad({ context: { auth: null } })).not.toThrow();
    expect(() => beforeLoad({ context: {} as { auth: unknown } })).not.toThrow();
  });

  it("holds shelf space only for a signed-in viewer", () => {
    // The cookie the slot count comes from is written per user id, so a signed
    // out visitor has no row of their own to reserve height for.
    expect(beforeLoad({ context: { auth: null } })).toEqual({ showcaseSlots: 0 });
  });
});

describe("collections tab param", () => {
  it("keeps a real tab and drops anything else", () => {
    expect(validateSearch({ tab: "stats" })).toEqual({ tab: "stats" });
    expect(validateSearch({ tab: "collectors" })).toEqual({ tab: "collectors" });
    expect(validateSearch({ tab: "nonsense" })).toEqual({});
    expect(validateSearch({ tab: 3 })).toEqual({});
  });

  it("leaves the default tab out of the URL, so the plain path is the shared link", () => {
    expect(validateSearch({ tab: "showcase" })).toEqual({});
    expect(validateSearch({})).toEqual({});
  });

  it("carries a collector alongside a tab", () => {
    expect(validateSearch({ collector: "Aleju03", tab: "stats" })).toEqual({ collector: "Aleju03", tab: "stats" });
  });
});

describe("leaving a collector's shelf", () => {
  /* Opening someone from a board or the list and coming back should land on
     the tab you left, not on the default one. The tab rides in the link both
     ways, so these check the two ends of that. */
  const shelf = readFileSync(join(process.cwd(), "src/components/packs/collections/CollectorShelf.tsx"), "utf8");
  const directory = readFileSync(join(process.cwd(), "src/components/packs/collections/CollectorDirectory.tsx"), "utf8");
  const boards = readFileSync(join(process.cwd(), "src/components/packs/collections/RecordBoards.tsx"), "utf8");

  it("carries the tab into the collector link", () => {
    expect(directory).toContain('tab: "collectors" as const');
    expect(boards).toContain('tab: "stats" as const');
  });

  it("sends the back link to that tab, and to the plain path for the default one", () => {
    expect(shelf).toContain('search={tab && tab !== "showcase" ? { tab } : {}}');
  });

  it("keeps a collector and a tab together through validateSearch", () => {
    expect(validateSearch({ collector: "JVRed", tab: "collectors" })).toEqual({
      collector: "JVRed",
      tab: "collectors",
    });
    // The default tab still stays out of the URL, even beside a collector.
    expect(validateSearch({ collector: "JVRed", tab: "showcase" })).toEqual({ collector: "JVRed" });
  });
});

describe("public collection activity privacy", () => {
  const shelf = readFileSync(join(process.cwd(), "src/components/packs/collections/CollectorShelf.tsx"), "utf8");
  const directory = readFileSync(join(process.cwd(), "src/components/packs/collections/CollectorDirectory.tsx"), "utf8");

  it("does not offer a recent collector ordering", () => {
    expect(directory).not.toContain('{ id: "recent"');
    expect(directory).not.toContain('label: "Recent"');
  });

  it("does not offer newest-first ordering on somebody else's shelf", () => {
    expect(shelf).not.toContain('"newest"');
    expect(shelf).not.toContain("setSort");
  });
});

describe("collections nav entry", () => {
  const nav = readFileSync(join(process.cwd(), "src/components/layout/Nav.tsx"), "utf8");

  it("puts the collections leaf ahead of the packs leaf", () => {
    /* The active-leaf lookup is a startsWith scan in NAV_LEAVES order, and
       /packs/collections also starts with /packs. If packs came first, the
       dropdown would highlight the wrong item on this page. */
    const collectionsAt = nav.indexOf('to: "/packs/collections"');
    const packsAt = nav.indexOf('to: "/packs"');
    expect(collectionsAt).toBeGreaterThan(-1);
    expect(collectionsAt).toBeLessThan(packsAt);
  });

  it("shows the collections leaf to everyone, like the route lets everyone in", () => {
    // Released: the leaf used to be hidden behind canUseAdminFeatures while the
    // page was being built. The tab and the page have to agree about who gets
    // in, and now that is everyone.
    expect(nav).not.toContain('leaf.id === "pack-collections"');
  });

  it("groups both pages under one Packs dropdown", () => {
    expect(nav).toContain('{ kind: "group", id: "packs", label: "packs", items: ["packs", "pack-collections"] }');
  });
});

describe("live pack totals", () => {
  const stats = {
    computedAt: 1000,
    totals: { packsOpened: 10, cardsMinted: 50, distinctHoldings: 40, collectors: 3, playersCarded: 20 },
    boards: {},
  } as unknown as Parameters<typeof withLivePulls>[0];

  const pull = (id: number, ownerUserId: number, pulledAt: number, isNew = false) =>
    ({ id, ownerUserId, pulledAt, isNew });

  it("counts a hand as one pack, however many cards it dealt", () => {
    /* Every card of a pack is its own event sharing an owner and a pull stamp,
       so counting events would call a five-card pack five packs. */
    const live = withLivePulls(stats, [
      pull(1, 7, 2000, true),
      pull(2, 7, 2000, true),
      pull(3, 7, 2000),
      pull(4, 7, 2000),
      pull(5, 7, 2000),
    ]);
    expect(live.totals.packsOpened).toBe(11);
    // A copy per card, but a holding only where the card was new to them.
    expect(live.totals.cardsMinted).toBe(55);
    expect(live.totals.distinctHoldings).toBe(42);
  });

  it("separates two collectors pulling at the same instant", () => {
    const live = withLivePulls(stats, [pull(1, 7, 2000), pull(2, 8, 2000)]);
    expect(live.totals.packsOpened).toBe(12);
  });

  it("ignores pulls the snapshot already counted, so a refresh cannot double count", () => {
    const live = withLivePulls(stats, [pull(1, 7, 900), pull(2, 7, 1000), pull(3, 7, 1001)]);
    expect(live.totals.packsOpened).toBe(11);
    expect(live.totals.cardsMinted).toBe(51);
  });

  it("hands back the snapshot untouched when nothing has happened since", () => {
    expect(withLivePulls(stats, [])).toBe(stats);
    expect(withLivePulls(stats, [pull(1, 7, 500)])).toBe(stats);
  });

  it("leaves the totals a pull cannot move exactly to the snapshot", () => {
    const live = withLivePulls(stats, [pull(1, 7, 2000, true)]);
    expect(live.totals.collectors).toBe(3);
    expect(live.totals.playersCarded).toBe(20);
  });
});

describe("catching up on a fresh load", () => {
  const entry = (id: number, ownerUserId: number, pulledAt: number, isNew = false) =>
    ({ id, ownerUserId, pulledAt, isNew }) as unknown as Parameters<typeof mergePulls>[1][number];

  it("picks up the pulls that landed after the totals were computed", () => {
    // A reload has no stream history, so without this the page drops back to
    // whatever the totals said and the number somebody watched go up goes down.
    const merged = mergePulls([], [entry(1, 7, 1500), entry(2, 8, 1600)], 1000);
    expect(merged.map((pull) => pull.id)).toEqual([1, 2]);
  });

  it("drops what the totals already counted", () => {
    expect(mergePulls([], [entry(1, 7, 900), entry(2, 7, 1000)], 1000)).toEqual([]);
  });

  it("does not count a pull twice when the feed and the stream overlap", () => {
    const live = [{ id: 1, ownerUserId: 7, pulledAt: 1500, isNew: false }];
    const merged = mergePulls(live, [entry(1, 7, 1500), entry(2, 7, 1500)], 1000);
    expect(merged.map((pull) => pull.id)).toEqual([1, 2]);
  });

  it("hands back the same list when the feed adds nothing", () => {
    const live = [{ id: 1, ownerUserId: 7, pulledAt: 1500, isNew: false }];
    expect(mergePulls(live, [entry(1, 7, 1500)], 1000)).toBe(live);
  });

  it("skips a malformed entry rather than counting a pull with no stamp", () => {
    const broken = { id: null, ownerUserId: 7, pulledAt: null } as unknown as Parameters<typeof mergePulls>[1][number];
    expect(mergePulls([], [broken, entry(2, 7, 1500)], 1000).map((pull) => pull.id)).toEqual([2]);
  });
});
