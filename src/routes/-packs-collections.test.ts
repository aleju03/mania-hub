import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Route } from "./packs_.collections";

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

describe("collections admin gate", () => {
  // Only the auth in context matters here; the rest of the router's
  // BeforeLoadContextOptions is not what this gate reads.
  const beforeLoad = Route.options.beforeLoad as unknown as (opts: { context: { auth: unknown } }) => unknown;

  it("404s the page for anyone without admin access", () => {
    /* A 404 rather than a refusal, so an unreleased page is indistinguishable
       from one that does not exist. Same flag and same shape /valley and the
       admin pages use. */
    expect(() => beforeLoad({ context: { auth: { canUseAdminFeatures: false } } })).toThrow();
    expect(() => beforeLoad({ context: { auth: null } })).toThrow();
    expect(() => beforeLoad({ context: {} as { auth: unknown } })).toThrow();
  });

  it("lets an admin through", () => {
    expect(() => beforeLoad({ context: { auth: { canUseAdminFeatures: true } } })).not.toThrow();
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

  it("hides the collections leaf behind the same flag the route checks", () => {
    expect(nav).toContain('if (leaf.id === "pack-collections") return adminMode;');
    expect(nav).toContain("const adminMode = auth.canUseAdminFeatures;");
  });

  it("groups both pages under one Packs dropdown", () => {
    expect(nav).toContain('{ kind: "group", id: "packs", label: "packs", items: ["packs", "pack-collections"] }');
  });
});
