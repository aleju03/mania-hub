import { describe, expect, it, vi } from "vitest";

import { formatDetailedTimeAgo, formatTimeAgo } from "./format";

describe("formatTimeAgo", () => {
  it("keeps hour labels compact", () => {
    vi.setSystemTime(new Date("2026-06-11T22:38:00.000-06:00"));

    expect(formatTimeAgo("2026-06-11T18:45:00.000-06:00")).toBe("3h ago");
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
