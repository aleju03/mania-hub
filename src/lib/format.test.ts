import { describe, expect, it, vi } from "vitest";

import { formatDate, formatDetailedTimeAgo, formatPreciseTimeAgo, formatTimeAgo } from "./format";

describe("formatDate", () => {
  // SSR (UTC server) and client (any viewer timezone) must render identical
  // text or profile pages hydration-fail (React #418). A timestamp minutes
  // before UTC midnight is the trap: local timezones east of UTC would roll
  // it to the next day without the pinned timeZone.
  it("formats near-midnight UTC timestamps as the UTC day in every timezone", () => {
    expect(formatDate("2022-03-20T23:52:23+00:00")).toBe("March 20, 2022");
  });
});

describe("formatTimeAgo", () => {
  it("keeps hour labels compact", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000-06:00"));

    expect(formatTimeAgo("2026-06-11T18:45:00.000-06:00")).toBe("3h ago");
  });
});

describe("formatPreciseTimeAgo", () => {
  const now = 1_750_000_000_000;

  it("labels the freshest pulls as just now", () => {
    expect(formatPreciseTimeAgo(now - 3_000, now)).toBe("just now");
  });

  it("counts seconds under a minute", () => {
    expect(formatPreciseTimeAgo(now - 42_000, now)).toBe("42s ago");
  });

  it("rolls over to minutes, hours, and days", () => {
    expect(formatPreciseTimeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatPreciseTimeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatPreciseTimeAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("treats clock skew into the future as just now", () => {
    expect(formatPreciseTimeAgo(now + 10_000, now)).toBe("just now");
  });
});

describe("formatDetailedTimeAgo", () => {
  it("includes remaining minutes for times under a day", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000-06:00"));

    expect(formatDetailedTimeAgo("2026-06-11T18:45:00.000-06:00")).toBe("3h 53m ago");
  });

  it("keeps exact-hour labels compact", () => {
    vi.setSystemTime(new Date("2026-06-11T22:45:00.000-06:00"));

    expect(formatDetailedTimeAgo("2026-06-11T18:45:00.000-06:00")).toBe("4h ago");
  });
});
