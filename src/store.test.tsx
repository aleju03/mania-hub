// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { HIDDEN_USERS_STORAGE_KEY } from "./store";

/* The hidden-players list is a browser-only pref, read straight out of localStorage before the
   store is even created, so it is already populated during the hydration render. Filtering with it
   there drops a row out of a board the server painted unfiltered, every name below it shifts up,
   and React throws the whole panel away over the text mismatch (#418) - which also costs a theme
   repaint, since it re-acquires <html>. The filter has to join one render later. */
// react-dom asks for this before it will let act() drive a root.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useHiddenUserIds", () => {
  it("hides nobody in the hydration render, then hides them in the next one", async () => {
    localStorage.setItem(
      HIDDEN_USERS_STORAGE_KEY,
      JSON.stringify({
        123: { id: 123, username: "Player 123", avatarUrl: "https://a.ppy.sh/123", countryCode: "CR" },
      }),
    );
    // The store reads localStorage at module init - which is the whole reason the list is there in
    // time to poison the hydration render - so it has to be built again after the seed.
    vi.resetModules();
    const { useHiddenUserIds } = await import("./store");

    const renders: number[][] = [];
    function Probe() {
      renders.push([...useHiddenUserIds()]);
      // Renders nothing, so hydration itself cannot mismatch and the captured values are the only
      // thing under test.
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      hydrateRoot(container, <Probe />);
    });

    expect(renders[0]).toEqual([]);
    expect(renders[renders.length - 1]).toEqual([123]);
  });
});

describe("useNoDans", () => {
  it("keeps the hydration render unchanged, then applies the persisted filter", async () => {
    localStorage.clear();
    localStorage.setItem(
      "mania-hub-cache-v5",
      JSON.stringify({ state: { noDans: true }, version: 0 }),
    );
    vi.resetModules();
    const { useNoDans } = await import("./store");

    const renders: boolean[] = [];
    function Probe() {
      renders.push(useNoDans());
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      hydrateRoot(container, <Probe />);
    });

    expect(renders[0]).toBe(false);
    expect(renders[renders.length - 1]).toBe(true);
  });
});
