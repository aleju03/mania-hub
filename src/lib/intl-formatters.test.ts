import { describe, expect, it } from "vitest";
import { formatDateTime, getDateTimeFormatter, getNumberFormatter } from "./intl-formatters";
import { formatBytes, formatDate, formatNumber, formatPP, formatPpGain, intlLocaleTag } from "./format";

describe("reused date formatters", () => {
  it("preserves locale and timezone output across midnight and daylight-saving changes", () => {
    for (const locale of ["en-US", "en-CA", "zh-CN", "es-419"]) {
      for (const timeZone of ["UTC", "America/Costa_Rica", "America/New_York", "Asia/Tokyo"]) {
        for (const value of ["2026-10-02T01:15:00Z", "2026-03-08T06:45:00Z", "2026-03-08T07:15:00Z"]) {
          const date = new Date(value);
          const options = { month: "long", day: "numeric", year: "numeric", timeZone } as const;
          expect(formatDateTime(date, locale, options)).toBe(date.toLocaleDateString(locale, options));
          const timeOptions = { hour: "numeric", minute: "2-digit", timeZone } as const;
          expect(formatDateTime(date, locale, timeOptions)).toBe(date.toLocaleTimeString(locale, timeOptions));
        }
      }
    }
  });

  it("preserves local calendar dates, parts, and invalid-date behavior", () => {
    const date = new Date(2026, 9, 2);
    const options = { month: "long", day: "numeric", year: "numeric" } as const;
    expect(formatDateTime(date, "en-US", options)).toBe(date.toLocaleDateString("en-US", options));
    const clock = { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Costa_Rica" } as const;
    expect(getDateTimeFormatter("en-US", clock).formatToParts(date)).toEqual(new Intl.DateTimeFormat("en-US", clock).formatToParts(date));
    expect(formatDate("invalid")).toBe("Invalid Date");
    expect(formatDate("invalidZ", "not a timezone")).toBe("Invalid Date");
    expect(() => formatDate("2026-10-02T01:15:00Z", "not a timezone")).toThrow(RangeError);
  });

  it("reuses the same option set without mixing locales or timezones", () => {
    const options = { month: "short", timeZone: "UTC" } as const;
    expect(getDateTimeFormatter("en-US", options)).toBe(getDateTimeFormatter("en-US", { ...options }));
    expect(getDateTimeFormatter("en-US", options)).not.toBe(getDateTimeFormatter("zh-CN", options));
    expect(getDateTimeFormatter("en-US", options)).not.toBe(getDateTimeFormatter("en-US", { ...options, timeZone: "Asia/Tokyo" }));
  });
});

describe("reused number formatters", () => {
  it("preserves grouping, rounding and special values in every supported locale", () => {
    for (const locale of ["en", "es", "zh-CN"] as const) {
      const tag = intlLocaleTag(locale);
      for (const value of [0, -0, 12_345.678, -12_345.678, Infinity, NaN]) {
        expect(formatNumber(value, locale)).toBe(value.toLocaleString(tag));
        expect(formatPP(value, locale)).toBe(`${Math.round(value).toLocaleString(tag)}pp`);
        expect(formatPpGain(value, locale)).toBe(Math.abs(value) < 0.05 ? "0" : value.toLocaleString(tag, { maximumFractionDigits: 1, minimumFractionDigits: 0 }));
      }
      expect(formatBytes(45.91 * 1024 ** 2, locale)).toBe(`${(45.91).toLocaleString(tag, { maximumFractionDigits: 1 })} MB`);
      expect(formatBytes(45.916 * 1024 ** 3, locale)).toBe(`${(45.916).toLocaleString(tag, { maximumFractionDigits: 2 })} GB`);
    }
    expect(getNumberFormatter("en-US")).toBe(getNumberFormatter("en-US"));
  });
});
