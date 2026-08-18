import { describe, expect, it } from "vitest";

import { goalAgeLabel, goalDurationLabel, goalSpanLabel, nf } from "./goal-format";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* The grouping is the point: this number is rendered on /goals during SSR and
   again on hydration, so it has to read the same on both. That it cannot pick
   the separator up from the ambient locale is enforced structurally in
   src/locale-formatting.test.ts; this pins the output itself. */
describe("nf", () => {
  it("groups thousands with commas", () => {
    expect(nf(12345)).toBe("12,345");
    expect(nf(1234567)).toBe("1,234,567");
    expect(nf(999)).toBe("999");
  });

  it("rounds to whole units", () => {
    expect(nf(12345.6)).toBe("12,346");
    expect(nf(0.4)).toBe("0");
  });
});

describe("goalSpanLabel", () => {
  it("steps up through minutes, hours, days, months and years", () => {
    expect(goalSpanLabel(0, 45 * MIN)).toBe("45m");
    expect(goalSpanLabel(0, 6 * HOUR)).toBe("6h");
    expect(goalSpanLabel(0, 12 * DAY)).toBe("12d");
    expect(goalSpanLabel(0, 100 * DAY)).toBe("3mo");
    expect(goalSpanLabel(0, 400 * DAY)).toBe("1y");
  });

  it("floors a clock skew to zero instead of going negative", () => {
    expect(goalSpanLabel(5 * MIN, 0)).toBe("0m");
  });
});

describe("goalAgeLabel", () => {
  it("reads as just set inside the first minute", () => {
    expect(goalAgeLabel(1_000, 30_000)).toBe("set just now");
  });

  it("otherwise states the span", () => {
    expect(goalAgeLabel(0, 3 * DAY)).toBe("set 3d ago");
  });
});

describe("goalDurationLabel", () => {
  it("reports how long a cleared goal stood", () => {
    expect(goalDurationLabel({ createdAt: 0, completedAt: 20 * DAY })).toBe("took 20d");
  });

  it("stays quiet for an open goal or an instant clear", () => {
    expect(goalDurationLabel({ createdAt: 0, completedAt: null })).toBeNull();
    expect(goalDurationLabel({ createdAt: 0, completedAt: 30_000 })).toBeNull();
  });
});
