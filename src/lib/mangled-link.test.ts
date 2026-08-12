// Every mangled path in here is one a real visitor actually landed on; they
// come out of the analytics pageview log, not out of imagination.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SALVAGEABLE_ROUTES, salvageMangledPath } from "./mangled-link";

describe("salvageMangledPath", () => {
  it("drops an @mention the chat client glued on", () => {
    expect(salvageMangledPath("/packs@Rush_FTK")).toBe("/packs");
    expect(salvageMangledPath("/packs@H2SO3_")).toBe("/packs");
    expect(salvageMangledPath("/packs@")).toBe("/packs");
  });

  it("drops a copied-along security banner, encoded or not", () => {
    const encoded =
      "/packs%0A%E6%97%A0%E6%B3%95%E7%A1%AE%E8%AE%A4%E8%AF%A5%E7%BD%91%E9%A1%B5%E7%9A%84%E5%AE%89%E5%85%A8%E6%80%A7%EF%BC%8C%E8%AF%B7%E8%B0%A8%E6%85%8E%E8%AE%BF%E9%97%AE%E3%80%82";
    expect(salvageMangledPath(encoded)).toBe("/packs");
    expect(salvageMangledPath("/packs\n无法确认该网页的安全性，请谨慎访问。")).toBe("/packs");
  });

  it("drops link text welded to the href", () => {
    expect(salvageMangledPath("/packsMania%20Tracker")).toBe("/packs");
  });

  it("drops a second URL pasted onto the first", () => {
    expect(salvageMangledPath("/farm-helperhttps:/mania-tracker.com/farm-helper")).toBe("/farm-helper");
  });

  it("forgives case", () => {
    expect(salvageMangledPath("/PACKS")).toBe("/packs");
    expect(salvageMangledPath("/Tracker")).toBe("/tracker");
  });

  it("forgives a trailing slash", () => {
    expect(salvageMangledPath("/packs/")).toBe("/packs");
  });

  it("never redirects a path to itself", () => {
    for (const route of SALVAGEABLE_ROUTES) {
      expect(salvageMangledPath(`/${route}`)).toBeNull();
    }
    expect(salvageMangledPath("/")).toBeNull();
    expect(salvageMangledPath("")).toBeNull();
  });

  /* The parameterised routes are the dangerous ones: "player" and "pull" look
     like a prefix match but carry no destination on their own, and hijacking
     /api would take the OG cards down with it. */
  it("leaves parameterised and non-page prefixes alone", () => {
    expect(salvageMangledPath("/player/Sol%20-/stats")).toBeNull();
    expect(salvageMangledPath("/player/The%20Smasher/stats")).toBeNull();
    expect(salvageMangledPath("/player")).toBeNull();
    expect(salvageMangledPath("/pull/34677424")).toBeNull();
    expect(salvageMangledPath("/pull")).toBeNull();
    expect(salvageMangledPath("/api/status")).toBeNull();
    expect(salvageMangledPath("/api/og")).toBeNull();
    expect(salvageMangledPath("/admin/live-backend")).toBeNull();
    expect(salvageMangledPath("/videos/1/x.mp4")).toBeNull();
  });

  /* Typos and truncations run the other direction - the visitor typed less
     than the route, not more - so there is no prefix to find and we would be
     inventing a destination. These stay 404s on purpose. */
  it("does not guess at typos, truncations or unknowns", () => {
    expect(salvageMangledPath("/pakcs")).toBeNull();
    expect(salvageMangledPath("/pack")).toBeNull();
    expect(salvageMangledPath("/my-stat")).toBeNull();
    expect(salvageMangledPath("/undefined")).toBeNull();
    expect(salvageMangledPath("/cards")).toBeNull();
    expect(salvageMangledPath("/three.js")).toBeNull();
    expect(salvageMangledPath("/%20legit")).toBeNull();
    expect(salvageMangledPath("/%D0%B7%D0%B3%D0%B4%D0%B4")).toBeNull();
    expect(salvageMangledPath("/country=DE")).toBeNull();
  });

  it("prefers the longest matching route", () => {
    // "top-plays" must not lose to a shorter entry that also prefixes it.
    expect(salvageMangledPath("/top-plays@someone")).toBe("/top-plays");
    expect(salvageMangledPath("/my-stats@someone")).toBe("/my-stats");
  });
});

/* The list is hand-written, so it can drift the moment someone adds a page.
   This is the thing that notices. */
describe("SALVAGEABLE_ROUTES", () => {
  it("matches the top-level page routes on disk", () => {
    const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
    const onDisk = readdirSync(routesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) => entry.name.slice(0, -".tsx".length))
      /* Skip the shell and the index, the "-" test files, "$" params, "."
         flat-nested children and "_" non-nested children. What is left is
         exactly the set of standalone top-level pages. */
      .filter((name) => name !== "__root" && name !== "index")
      .filter((name) => !/^[-$]|[.$_]/.test(name))
      .sort();

    expect(onDisk).toEqual([...SALVAGEABLE_ROUTES].sort());
  });
});
