import { describe, expect, it } from "vitest";

import type { AdminTodo } from "../lib/admin-todos";
import { findLaneAtPoint, laneDropPosition, laneInsertionIndex, positionBetween, queueDropPosition } from "./admin/todos";

// The todo board persists manual order as a sparse `position` key, so every drag has to work out a
// number that lands the note between its two new neighbours. Lanes render bottom-up (next-up sits on
// the judgement line) while the queue reads top-down, which flips which neighbour holds the larger
// position -- easy to get backwards, and invisible until an order silently inverts.

const todo = (id: string, position: number): AdminTodo => ({
  id,
  title: id,
  notes: null,
  category: "task",
  priority: "normal",
  status: "open",
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  position,
  seq: 1,
});

describe("laneDropPosition", () => {
  // Visual order is top -> bottom, so positions descend down the list.
  const lane = [todo("a", 3000), todo("b", 2000), todo("c", 1000)];

  it("drops between two neighbours at their midpoint", () => {
    expect(laneDropPosition(lane, 1, [])).toBe(2000);
  });

  it("promotes above the top note by a full step", () => {
    expect(laneDropPosition(lane, 0, [])).toBe(3000);
  });

  it("sends below the bottom note toward the judgement line", () => {
    expect(laneDropPosition(lane, 2, [])).toBe(1000);
  });

  it("leaves a lone note alone", () => {
    expect(laneDropPosition([todo("only", 500)], 0, [])).toBeNull();
  });

  it("dodges a position owned by a note in another lane", () => {
    // The lane sees only a and c, but b sits at the midpoint in a different lane. Landing on 2000
    // would tie the two, and a tie is ordered by createdAt instead - the slot then can't be
    // re-reached, because re-dropping computes the same value and is treated as "no move".
    const sparse = [todo("a", 3000), todo("moved", 0), todo("c", 1000)];
    const position = laneDropPosition(sparse, 1, [3000, 2000, 1000]);
    expect(position).not.toBe(2000);
    expect(position).toBeGreaterThan(1000);
    expect(position).toBeLessThan(3000);
  });

  it("dodges an occupied slot one full step above the top note", () => {
    // New todos are created on an exact 1000 grid, so a plain +1000 lands on a neighbour's slot.
    expect(laneDropPosition([todo("moved", 0), todo("c", 1000)], 0, [1000, 2000])).toBe(1500);
  });

  it("dodges an occupied slot one full step below the bottom note", () => {
    expect(laneDropPosition([todo("a", 3000), todo("moved", 0)], 1, [3000, 2000])).toBe(2500);
  });
});

describe("positionBetween", () => {
  it("takes the plain midpoint when nothing sits in the gap", () => {
    expect(positionBetween([0, 4000], 0, 4000)).toBe(2000);
  });

  it("anchors on the nearest occupied position rather than the far bound", () => {
    // 0 and 4000 are the bounds, but 1000 is taken, so the result must land inside (0, 1000).
    expect(positionBetween([0, 1000, 4000], 0, 4000)).toBe(500);
  });

  it("steps a full slot past an unbounded side", () => {
    expect(positionBetween([1000], null, 1000)).toBe(0);
    expect(positionBetween([1000], 1000, null)).toBe(2000);
  });

  it("halves toward the neighbour instead of stepping onto it", () => {
    expect(positionBetween([1000, 2000], 1000, null)).toBe(1500);
    expect(positionBetween([1000, 2000], null, 2000)).toBe(1500);
  });

  it("has nothing to say with no bounds at all", () => {
    expect(positionBetween([1, 2, 3], null, null)).toBeNull();
  });

  it("gives up rather than return a colliding value when floats run out of room", () => {
    // Repeated halving into the same gap eventually leaves no representable value between the two.
    const lo = 1;
    const hi = lo + Number.EPSILON;
    expect(positionBetween([lo, hi], lo, hi)).toBeNull();
  });

  it("never returns a position that is already taken", () => {
    const occupied = [0, 1000, 2000, 3000, 4000];
    for (const [lo, hi] of [[0, 2000], [1000, 4000], [0, 4000], [2000, 3000]] as const) {
      const position = positionBetween(occupied, lo, hi);
      expect(position).not.toBeNull();
      expect(occupied).not.toContain(position);
      expect(position!).toBeGreaterThan(lo);
      expect(position!).toBeLessThan(hi);
    }
  });
});

describe("queueDropPosition", () => {
  // The queue reads top -> bottom as do-this-first, so positions ascend down the list.
  const queue = [todo("a", 1000), todo("b", 2000), todo("c", 3000)];

  it("drops between two rows at their midpoint", () => {
    expect(queueDropPosition(queue, 1, [])).toBe(2000);
  });

  it("moving to the top jumps ahead of the current first row", () => {
    expect(queueDropPosition(queue, 0, [])).toBe(1000);
  });

  it("moving to the bottom falls behind the current last row", () => {
    expect(queueDropPosition(queue, 2, [])).toBe(3000);
  });

  it("leaves a lone row alone", () => {
    expect(queueDropPosition([todo("only", 500)], 0, [])).toBeNull();
  });

  it("dodges a position held by a row the search is hiding", () => {
    // The queue only renders search matches, but every open todo owns a position.
    const visible = [todo("a", 1000), todo("moved", 5000), todo("c", 3000)];
    const position = queueDropPosition(visible, 1, [1000, 2000, 3000]);
    expect(position).not.toBe(2000);
    expect(position).toBeGreaterThan(1000);
    expect(position).toBeLessThan(3000);
  });

  it("orders the queue the opposite way round from a lane", () => {
    // One gesture, two meanings: "c" dragged to the head of the list is the lowest position in a
    // queue (do it first) but the highest in a lane (top of the stack, furthest from the line).
    const dropped = [todo("c", 3000), todo("a", 1000), todo("b", 2000)];
    expect(queueDropPosition(dropped, 0, [])).toBeLessThan(1000);
    expect(laneDropPosition(dropped, 0, [])).toBeGreaterThan(1000);
  });
});

describe("laneInsertionIndex", () => {
  // Three notes whose vertical centres sit at 100, 200 and 300.
  const middles = [100, 200, 300];

  it("slots above every note when released over the top of the lane", () => {
    expect(laneInsertionIndex(middles, 40)).toBe(0);
  });

  it("slots between the notes it was released between", () => {
    expect(laneInsertionIndex(middles, 150)).toBe(1);
    expect(laneInsertionIndex(middles, 250)).toBe(2);
  });

  it("slots below every note when released past the last one", () => {
    expect(laneInsertionIndex(middles, 999)).toBe(3);
  });

  it("counts a release exactly on a note's centre as landing above it", () => {
    expect(laneInsertionIndex(middles, 200)).toBe(1);
  });

  it("puts the first note in an empty lane at index 0", () => {
    expect(laneInsertionIndex([], 250)).toBe(0);
  });
});

describe("findLaneAtPoint", () => {
  // Five 100px-wide lanes side by side, 400px tall, in the order the board renders them.
  const laneAt = (left: number) =>
    ({
      getBoundingClientRect: () => ({ left, right: left + 100, top: 100, bottom: 500 }),
    }) as HTMLDivElement;
  const lanes = {
    task: laneAt(0),
    bug: laneAt(100),
    feature: laneAt(200),
    idea: laneAt(300),
    chore: laneAt(400),
  };

  it("names the lane the pointer is inside", () => {
    expect(findLaneAtPoint(lanes, 50, 300)).toBe("task");
    expect(findLaneAtPoint(lanes, 150, 300)).toBe("bug");
    expect(findLaneAtPoint(lanes, 450, 300)).toBe("chore");
  });

  it("forgives a throw that overshoots a lane vertically", () => {
    expect(findLaneAtPoint(lanes, 150, 70)).toBe("bug");
    expect(findLaneAtPoint(lanes, 150, 530)).toBe("bug");
  });

  it("rejects a drop flung well clear of the board", () => {
    expect(findLaneAtPoint(lanes, 150, -200)).toBeNull();
    expect(findLaneAtPoint(lanes, 150, 900)).toBeNull();
    expect(findLaneAtPoint(lanes, 700, 300)).toBeNull();
  });

  it("ignores lanes that have not mounted", () => {
    expect(findLaneAtPoint({ task: null, bug: lanes.bug }, 150, 300)).toBe("bug");
    expect(findLaneAtPoint({}, 150, 300)).toBeNull();
  });
});
