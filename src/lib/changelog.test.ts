import { describe, expect, it } from "vitest";

import { formatReleaseAge, groupUpdatesByDay, hasUnseenChangelog } from "./changelog";
import { UPDATES, WIP } from "../data/changelog";

const NOW = Date.parse("2026-07-29T09:00:00Z");
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("formatReleaseAge", () => {
  it("labels the buckets a reader cares about", () => {
    expect(formatReleaseAge("2026-07-29", NOW)).toBe("today");
    expect(formatReleaseAge("2026-07-28", NOW)).toBe("yesterday");
    expect(formatReleaseAge("2026-07-25", NOW)).toBe("4 days ago");
    expect(formatReleaseAge("2026-07-21", NOW)).toBe("8 days ago");
    expect(formatReleaseAge("2026-07-16", NOW)).toBe("13 days ago");
    expect(formatReleaseAge("2026-07-15", NOW)).toBe("2 weeks ago");
    expect(formatReleaseAge("2026-07-08", NOW)).toBe("3 weeks ago");
    expect(formatReleaseAge("2026-05-01", NOW)).toBe("2 months ago");
    expect(formatReleaseAge("2025-06-01", NOW)).toBe("last year");
  });

  it("counts whole UTC days, so any time of day on the same day reads the same", () => {
    expect(formatReleaseAge("2026-07-29", day("2026-07-29") + 1)).toBe("today");
    expect(formatReleaseAge("2026-07-29", day("2026-07-30") - 1)).toBe("today");
  });

  it("does not go negative on an update dated ahead of the clock", () => {
    expect(formatReleaseAge("2026-08-02", NOW)).toBe("today");
  });

  it("returns an empty label instead of NaN text for a malformed date", () => {
    expect(formatReleaseAge("not-a-date", NOW)).toBe("");
  });
});

describe("groupUpdatesByDay", () => {
  it("collapses a run of same-day updates into one group, in order", () => {
    const groups = groupUpdatesByDay([
      { date: "2026-07-29", text: "a" },
      { date: "2026-07-29", text: "b" },
      { date: "2026-07-28", text: "c" },
    ]);
    expect(groups).toEqual([
      { date: "2026-07-29", updates: [{ date: "2026-07-29", text: "a" }, { date: "2026-07-29", text: "b" }] },
      { date: "2026-07-28", updates: [{ date: "2026-07-28", text: "c" }] },
    ]);
  });

  it("keeps an out-of-order date where the author put it rather than merging across", () => {
    const groups = groupUpdatesByDay([
      { date: "2026-07-29", text: "a" },
      { date: "2026-07-28", text: "b" },
      { date: "2026-07-29", text: "c" },
    ]);
    expect(groups.map((group) => group.date)).toEqual(["2026-07-29", "2026-07-28", "2026-07-29"]);
  });

  it("handles an empty list", () => {
    expect(groupUpdatesByDay([])).toEqual([]);
  });

  it("covers every update exactly once for the real content", () => {
    const flat = groupUpdatesByDay(UPDATES).flatMap((group) => group.updates);
    expect(flat).toEqual(UPDATES);
  });
});

describe("hasUnseenChangelog", () => {
  it("flags an update newer than the last one the reader opened", () => {
    expect(hasUnseenChangelog("2026-07-25", "2026-07-29")).toBe(true);
  });

  it("stays quiet once the newest update has been seen", () => {
    expect(hasUnseenChangelog("2026-07-29", "2026-07-29")).toBe(false);
    expect(hasUnseenChangelog("2026-08-01", "2026-07-29")).toBe(false);
  });

  it("stays quiet for a reader who has never opened the changelog", () => {
    expect(hasUnseenChangelog(null, "2026-07-29")).toBe(false);
  });
});

describe("changelog content", () => {
  it("is ordered newest first", () => {
    const dates = UPDATES.map((update) => update.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("uses YYYY-MM-DD dates that parse", () => {
    for (const update of UPDATES) {
      expect(update.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${update.date}T00:00:00Z`))).toBe(false);
    }
  });

  it("keeps every line short enough to read as one line", () => {
    for (const update of UPDATES) {
      expect(update.text.trim().length).toBeGreaterThan(0);
      expect(update.text.length).toBeLessThanOrEqual(90);
    }
  });

  it("links rows at in-app paths only, so the router can handle them", () => {
    for (const update of UPDATES) {
      if (update.to) expect(update.to.startsWith("/")).toBe(true);
    }
  });

  it("keeps the wip line short: it renders as one run of text", () => {
    expect(WIP.length).toBeLessThanOrEqual(4);
    expect(WIP.join(" · ").length).toBeLessThanOrEqual(140);
  });
});
