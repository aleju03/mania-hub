import { describe, expect, it } from "vitest";

import { idsInMarquee, marqueeRect, mergeSelection, nextGroupColor, rectsOverlap, type SelectRect } from "./admin/todos";

// Dragging a box over the todo board picks notes the way a file manager does: any note the box
// touches is taken, dragging back up gives it away again, and a modifier adds to what was already
// picked instead of replacing it. All of that is geometry, so it is worth pinning down here rather
// than in the pointer handlers.

const rect = (left: number, top: number, right: number, bottom: number): SelectRect => ({ left, top, right, bottom });

describe("marqueeRect", () => {
  it("normalizes a box dragged up and to the left", () => {
    expect(marqueeRect(120, 90, 20, 10)).toEqual(rect(20, 10, 120, 90));
  });

  it("keeps a box dragged down and to the right as-is", () => {
    expect(marqueeRect(20, 10, 120, 90)).toEqual(rect(20, 10, 120, 90));
  });
});

describe("rectsOverlap", () => {
  it("counts a grazing edge as a touch", () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 10, 20, 20))).toBe(true);
  });

  it("is false for boxes that miss each other", () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(11, 0, 20, 10))).toBe(false);
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(0, 11, 10, 20))).toBe(false);
  });
});

describe("idsInMarquee", () => {
  const notes = [
    { id: "a", rect: rect(0, 0, 100, 40) },
    { id: "b", rect: rect(0, 50, 100, 90) },
    { id: "c", rect: rect(0, 100, 100, 140) },
  ];

  it("takes every note the box touches, not only the ones it swallows", () => {
    expect(idsInMarquee(notes, rect(10, 30, 60, 60))).toEqual(["a", "b"]);
  });

  it("takes nothing when the box is over empty board", () => {
    expect(idsInMarquee(notes, rect(0, 145, 100, 200))).toEqual([]);
  });
});

describe("mergeSelection", () => {
  it("replaces the selection on a plain drag", () => {
    expect(mergeSelection(["a", "b"], ["c"], false)).toEqual(["c"]);
  });

  it("adds to the selection the drag started with when a modifier is held", () => {
    expect(mergeSelection(["a"], ["b", "a"], true)).toEqual(["a", "b"]);
  });

  it("gives up a note again when the box shrinks back off it", () => {
    // The base is frozen at drag start, so only what the box currently holds is added.
    expect(mergeSelection(["a"], ["b"], true)).toEqual(["a", "b"]);
    expect(mergeSelection(["a"], [], true)).toEqual(["a"]);
  });
});

describe("nextGroupColor", () => {
  // Naming a group from the selection bar never asks for a colour, so the palette has to pick one
  // that is not already on the board.
  it("takes the first colour no group is using", () => {
    expect(nextGroupColor([])).toBe("pink");
    expect(nextGroupColor(["pink", "blue"])).toBe("green");
  });

  it("starts reusing colours once the palette is spent", () => {
    const all = ["pink", "blue", "green", "yellow", "purple", "red", "orange"] as const;
    expect(nextGroupColor(all)).toBe("pink");
  });
});
