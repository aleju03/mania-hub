import { describe, expect, it } from "vitest";
import {
  cutAngleDeg,
  cutHalfOffset,
  cutHalfPolygon,
  cutPathPercents,
  packDamageFromCut,
  sanitizePackDamage,
} from "./pack-damage";

/* The blade is recorded in pack-space fractions: x across the width, y down
   the height. The cards sit in a window from 0.2 to 0.94 of that height. */
function packY(cardFrac: number) {
  return 0.2 + cardFrac * 0.74;
}

function sweep(count: number, y: (x: number) => number) {
  return Array.from({ length: count }, (_, index) => {
    const x = (index + 0.5) / count;
    return { x, y: y(x) };
  });
}

describe("packDamageFromCut", () => {
  it("ignores a poke at the foil", () => {
    expect(packDamageFromCut(sweep(3, () => 0.5))).toBeNull();
    expect(packDamageFromCut([])).toBeNull();
  });

  it("keeps a level slash level across the whole card", () => {
    const damage = packDamageFromCut(sweep(24, () => packY(0.5)));
    expect(damage).not.toBeNull();
    for (const y of damage!.path) expect(y).toBeCloseTo(0.5, 3);
  });

  it("keeps the blade's own shape rather than a straight line through it", () => {
    // A zigzag: three passes up and down as the hand crosses the pack.
    const damage = packDamageFromCut(sweep(48, (x) => packY(0.5 + Math.sin(x * Math.PI * 3) * 0.25)));
    expect(damage).not.toBeNull();
    const path = damage!.path;
    // Smoothing must not iron the zigzag flat: it still turns around three
    // times, and still spans most of the amplitude it was cut with.
    let turns = 0;
    for (let index = 1; index < path.length - 1; index += 1) {
      const before = path[index] - path[index - 1];
      const after = path[index + 1] - path[index];
      if (before !== 0 && after !== 0 && before > 0 !== after > 0) turns += 1;
    }
    expect(turns).toBe(3);
    expect(Math.max(...path) - Math.min(...path)).toBeGreaterThan(0.4);
  });

  it("holds level past the ends of the cut instead of running off on a slope", () => {
    // A downhill stroke over the middle 40% of the pack only.
    const damage = packDamageFromCut(
      Array.from({ length: 12 }, (_, index) => {
        const x = 0.3 + index * 0.035;
        return { x, y: packY(0.3 + (x - 0.3) * 1.2) };
      }),
    );
    const path = damage!.path;
    // The first and last samples sit where the blade entered and left, not
    // somewhere off the card.
    expect(path[0]).toBeCloseTo(0.3, 1);
    expect(path[path.length - 1]).toBeCloseTo(path[path.length - 2], 2);
    expect(Math.min(...path)).toBeGreaterThanOrEqual(0.06);
    expect(Math.max(...path)).toBeLessThanOrEqual(0.94);
  });

  it("holds the cut off the card's edges", () => {
    const high = packDamageFromCut(sweep(24, () => 0.05));
    const low = packDamageFromCut(sweep(24, () => 0.99));
    expect(Math.min(...high!.path)).toBeGreaterThanOrEqual(0.06);
    expect(Math.max(...low!.path)).toBeLessThanOrEqual(0.94);
  });
});

describe("sanitizePackDamage", () => {
  it("takes a stored cut back, clamped", () => {
    expect(sanitizePackDamage({ path: [0.3, 0.5, 0.4] })).toEqual({ path: [0.3, 0.5, 0.4] });
    expect(sanitizePackDamage({ path: [-2, 4] })).toEqual({ path: [0.06, 0.94] });
  });

  it("refuses anything that is not a cut", () => {
    expect(sanitizePackDamage(null)).toBeNull();
    expect(sanitizePackDamage({ path: [0.5] })).toBeNull();
    expect(sanitizePackDamage({ path: [0.5, Number.NaN] })).toBeNull();
    expect(sanitizePackDamage({ path: ["half", 0.5] })).toBeNull();
    expect(sanitizePackDamage({ cutFrac: 0.5, angleDeg: 8 })).toBeNull();
  });
});

/* Every point of the card lands in exactly one of the two pieces. */
function pointInPolygon(polygon: string, x: number, y: number) {
  const points = polygon
    .slice("polygon(".length, -1)
    .split(", ")
    .map((pair) => pair.split(" ").map((value) => Number.parseFloat(value)) as [number, number]);
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("cutHalfPolygon", () => {
  it("splits the card in two along the blade's path", () => {
    const damage = packDamageFromCut(sweep(48, (x) => packY(0.5 + Math.sin(x * Math.PI * 3) * 0.2)))!;
    const top = cutHalfPolygon(damage, "top");
    const bottom = cutHalfPolygon(damage, "bottom");
    const path = cutPathPercents(damage);
    for (let x = 5; x < 100; x += 5) {
      // Where the cut runs at this x, read off the same path the clip used.
      const index = Math.min(path.length - 2, Math.floor((x / 100) * (path.length - 1)));
      const [xa, ya] = path[index];
      const [xb, yb] = path[index + 1];
      const cutY = ya + ((yb - ya) * (x - xa)) / (xb - xa);
      for (const y of [cutY - 20, cutY - 5, cutY + 5, cutY + 20]) {
        if (y < 1 || y > 99) continue;
        expect(pointInPolygon(top, x, y)).toBe(y < cutY);
        expect(pointInPolygon(bottom, x, y)).toBe(y > cutY);
      }
    }
  });
});

describe("cutAngleDeg and cutHalfOffset", () => {
  it("reads the blade end to end, through the card's proportions", () => {
    const level = { path: [0.5, 0.5, 0.5] };
    expect(cutAngleDeg(level)).toBeCloseTo(0);
    // Down a third of the card's height across its width.
    const downhill = { path: [0.3, 0.4, 0.5, 0.6, 0.63] };
    expect(cutAngleDeg(downhill)).toBeCloseTo((Math.atan(0.33 / (5 / 7)) * 180) / Math.PI, 4);
  });

  it("parts a level cut straight up and down, and a tilted one sideways too", () => {
    const level = cutHalfOffset({ path: [0.5, 0.5] }, 1.2);
    expect(level.x).toBeCloseTo(0);
    expect(level.y).toBeCloseTo(-1.2);

    // A cut running down to the right parts along its own normal, so the top
    // piece slides to the right as it lifts.
    const tilted = cutHalfOffset({ path: [0.2, 0.8] }, 1.2);
    expect(tilted.x).toBeGreaterThan(0);
    expect(tilted.y).toBeLessThan(0);
  });

  it("slides the pieces along the blade as well as across it", () => {
    // Slip runs along the cut, so a level cut slips purely sideways. In
    // percent of width, which is the shorter side, it reads longer than the
    // height it was given in.
    const level = cutHalfOffset({ path: [0.5, 0.5] }, 0, 1);
    expect(level.x).toBeCloseTo(1 / (5 / 7), 6);
    expect(level.y).toBeCloseTo(0);

    // A cut running down to the right drags its upper piece down-right, the
    // way the hand was travelling.
    const tilted = cutHalfOffset({ path: [0.2, 0.8] }, 0, 1);
    expect(tilted.x).toBeGreaterThan(0);
    expect(tilted.y).toBeGreaterThan(0);

    // Gap and slip are perpendicular, so together they are longer than either.
    const both = cutHalfOffset({ path: [0.2, 0.8] }, 1, 1);
    expect(Math.hypot(both.x, both.y)).toBeGreaterThan(Math.hypot(tilted.x, tilted.y));
  });
});
