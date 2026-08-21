import { describe, expect, it, vi } from "vitest";

import {
  formatCompactCount,
  formatDate,
  formatDetailedTimeAgo,
  formatPreciseTimeAgo,
  formatTimeAgo,
  formatTimeAgoTooltip,
} from "./format";

describe("formatDate", () => {
  // SSR (UTC server) and client (any viewer timezone) must render identical
  // text or profile pages hydration-fail (React #418). A timestamp minutes
  // before UTC midnight is the trap: local timezones east of UTC would roll
  // it to the next day without the pinned timeZone.
  it("formats near-midnight UTC timestamps as the UTC day in every timezone", () => {
    expect(formatDate("2022-03-20T23:52:23+00:00")).toBe("March 20, 2022");
  });

  /* The reported bug: a play set at 20:28 in Costa Rica is 02:28 UTC the next
     morning, so the UTC day named a day osu! itself never showed the player. */
  it("names the viewer's day, not UTC's, when given a zone", () => {
    expect(formatDate("2026-08-19T02:28:28Z", "America/Costa_Rica")).toBe("August 18, 2026");
    expect(formatDate("2026-08-19T02:28:28Z", "Asia/Tokyo")).toBe("August 19, 2026");
  });

  /* A value with no instant behind it has no zone to be converted from: parsed
     as UTC midnight, any zone west of Greenwich would print the day before. */
  it("ignores both the viewer and machine zone for a date that names a day rather than a moment", () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      expect(formatDate("2026-08-19", "America/Costa_Rica")).toBe("August 19, 2026");
      expect(formatDate("2026-08-19 02:28:28", "America/Costa_Rica")).toBe("August 19, 2026");
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
  });

  it("still defaults to UTC, which is what keeps SSR and hydration identical", () => {
    expect(formatDate("2026-08-19T02:28:28Z")).toBe("August 19, 2026");
  });

  it("uses neutral Latin American date formatting for Spanish", () => {
    expect(formatDate("2026-08-19", "UTC", "es")).toBe("19 de agosto de 2026");
  });
});

describe("formatTimeAgo", () => {
  it("keeps hour labels compact", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000-06:00"));

    expect(formatTimeAgo("2026-06-11T18:45:00.000-06:00")).toBe("3h ago");
  });

  it("rolls months over to years instead of counting past 12", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000Z"));

    expect(formatTimeAgo("2025-09-11T22:38:00.000Z")).toBe("9mo ago");
    // 360-364 days counts as 12 30-day months but is not yet a year, so the
    // label stays in months rather than rounding down to "0y ago".
    expect(formatTimeAgo("2025-06-14T22:38:00.000Z")).toBe("12mo ago");
    expect(formatTimeAgo("2025-06-10T22:38:00.000Z")).toBe("1y ago");
    expect(formatTimeAgo("2014-06-04T22:38:00.000Z")).toBe("12y ago");
  });

  it("uses the requested catalog for compact relative dates", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000Z"));

    expect(formatTimeAgo("2025-06-10T22:38:00.000Z", "es")).toBe("hace 1y");
    expect(formatTimeAgo("2025-06-10T22:38:00.000Z", "zh-CN")).toBe("1 年前");
  });
});

describe("formatTimeAgoTooltip", () => {
  it("spells out the month count only once the label is in years", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000Z"));

    expect(formatTimeAgoTooltip("2025-09-11T22:38:00.000Z")).toBeUndefined();
    expect(formatTimeAgoTooltip("2014-06-04T22:38:00.000Z")).toBe("146 months ago");
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

  it("localizes both units and word order", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000-06:00"));

    expect(formatDetailedTimeAgo("2026-06-11T18:45:00.000-06:00", "es")).toBe("hace 3h 53m");
    expect(formatDetailedTimeAgo("2026-06-11T18:45:00.000-06:00", "zh-CN")).toBe("3 小时 53 分前");
  });
});

describe("formatCompactCount", () => {
  it("keeps counts below a thousand exact", () => {
    expect(formatCompactCount(0)).toBe("0");
    expect(formatCompactCount(1)).toBe("1");
    expect(formatCompactCount(999)).toBe("999");
  });

  it("shortens thousands, dropping a trailing zero decimal", () => {
    expect(formatCompactCount(1000)).toBe("1k");
    expect(formatCompactCount(1203)).toBe("1.2k");
    expect(formatCompactCount(9999)).toBe("10k");
  });

  it("drops the decimal entirely past ten thousand, where it buys nothing", () => {
    expect(formatCompactCount(10_000)).toBe("10k");
    expect(formatCompactCount(45_600)).toBe("46k");
    expect(formatCompactCount(1_250_000)).toBe("1250k");
  });

  it("delegates Spanish compact counts to CLDR locale data", () => {
    const withoutNbsp = (value: number) => formatCompactCount(value, "es").replace(/\u00a0/g, " ");
    expect(withoutNbsp(999)).toBe("999");
    expect(withoutNbsp(1_200)).toBe("1.2 K");
    expect(withoutNbsp(12_000)).toBe("12 k");
    expect(withoutNbsp(1_200_000)).toBe("1.2 M");
  });

  it("floors fractions and never renders a negative count", () => {
    expect(formatCompactCount(12.7)).toBe("12");
    expect(formatCompactCount(-5)).toBe("0");
  });
});
