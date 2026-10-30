import { describe, expect, it } from "vitest";

import { activityTodayKey, activityWindowStart, buildSignatureActivityMonth, buildSignatureActivityWindow } from "./signature-activity";

describe("buildSignatureActivityWindow", () => {
  // 2026-10-23 is a Friday.
  const today = "2026-10-23";

  it("ends on today's week, Sunday first, with the days after today left empty", () => {
    const window = buildSignatureActivityWindow([], today, 53);
    expect(window.weeks).toHaveLength(53);
    expect(window.weeks[0]![0]!.date).toBe(activityWindowStart(today, 53));
    expect(window.weeks[0]![0]!.date).toBe("2025-10-19");
    const last = window.weeks[52]!;
    expect(last[5]!.date).toBe(today);
    expect(last[6]).toBeNull();
  });

  it("counts plays, active days and weekly totals inside the window only", () => {
    const window = buildSignatureActivityWindow([
      { date: "2025-01-01", scoreCount: 50, sessionCount: 2 },
      { date: "2026-10-18", scoreCount: 4, sessionCount: 1 },
      { date: "2026-10-20", scoreCount: 6, sessionCount: 1 },
    ], today, 53);
    expect(window.plays).toBe(10);
    expect(window.activeDays).toBe(2);
    expect(window.weeklyPlays[52]).toBe(10);
    expect(window.fullAt).toBe(12);
  });

  it("keeps a streak alive through an empty today and ends it at the first gap", () => {
    const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]
      .map((date) => ({ date, scoreCount: 1, sessionCount: 1 }));
    expect(buildSignatureActivityWindow(days, today, 26).streak).toBe(4);
    expect(buildSignatureActivityWindow([...days, { date: today, scoreCount: 2, sessionCount: 1 }], today, 26).streak).toBe(5);
    expect(buildSignatureActivityWindow(days.slice(0, 2), today, 26).streak).toBe(0);
  });

  it("labels each month once, on the week its first day falls in", () => {
    const window = buildSignatureActivityWindow([], today, 53);
    expect(window.months.map((month) => month.label)).toEqual([
      "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
    ]);
    for (let index = 1; index < window.months.length; index++) {
      expect(window.months[index]!.week - window.months[index - 1]!.week).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("buildSignatureActivityMonth", () => {
  it("lays the month out Sunday first, counts only its days, and marks the days after today", () => {
    // October 2026 starts on a Thursday.
    const month = buildSignatureActivityMonth([
      { date: "2026-09-30", scoreCount: 9, sessionCount: 1 },
      { date: "2026-10-01", scoreCount: 3, sessionCount: 1 },
      { date: "2026-10-22", scoreCount: 5, sessionCount: 1 },
    ], "2026-10-23");
    expect(month.label).toBe("October");
    expect(month.rows).toHaveLength(5);
    expect(month.rows[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(month.rows[0]![4]).toMatchObject({ date: "2026-10-01", day: 1, plays: 3, future: false });
    expect(month.rows[4]![6]).toMatchObject({ day: 31, future: true });
    expect(month.rows[3]![6]).toMatchObject({ day: 24, future: true });
    expect(month.plays).toBe(8);
    expect(month.activeDays).toBe(2);
  });

  it("runs the streak back past the first of the month", () => {
    const month = buildSignatureActivityMonth(
      ["2026-09-30", "2026-10-01", "2026-10-02"].map((date) => ({ date, scoreCount: 1, sessionCount: 1 })),
      "2026-10-02",
    );
    expect(month.streak).toBe(3);
  });
});

describe("activityTodayKey", () => {
  it("reads the day in the given zone", () => {
    const instant = Date.parse("2026-10-23T03:00:00Z");
    expect(activityTodayKey("UTC", instant)).toBe("2026-10-23");
    expect(activityTodayKey("America/Costa_Rica", instant)).toBe("2026-10-22");
  });
});
