import { describe, expect, it, vi } from "vitest";
import type { LivePlayerSkillHistoryEntry, LivePlayerSkillHistorySnapshot } from "../../lib/live-backend";
import { groupSkillHistoryByDay, loadSkillHistoryDays } from "./skill-history-days";

function snapshot(overall: number, stream = overall): LivePlayerSkillHistorySnapshot {
  return { ratings: { Overall: overall, Stream: stream }, dan: { rc: null, ln: null } };
}

function entry(id: number, day: number, hour: number, rating: number, previous: number | null): LivePlayerSkillHistoryEntry {
  return {
    id, recordedAt: new Date(2026, 8, day, hour).toISOString(), version: 1,
    snapshot: snapshot(rating), previous: previous === null ? null : snapshot(previous),
  };
}

describe("daily skill history", () => {
  it("combines gains and drops into one latest rating and opening reference per day", () => {
    const items = [entry(4, 4, 22, 32.49, 32.55), entry(3, 4, 12, 32.55, 32.35), entry(2, 3, 18, 32.35, 32.3)];
    items[0].snapshot = snapshot(32.49, 30.5);
    items[1].previous = snapshot(32.35, 30.1);
    items[0].snapshot.dan.rc = { label: "gamma", beyondTable: false };
    const days = groupSkillHistoryByDay(items);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ day: "2026-09-04", snapshot: items[0].snapshot, previous: items[1].previous });
    expect(days[0].snapshot.ratings.Overall - days[0].previous!.ratings.Overall).toBeCloseTo(0.14);
    expect(days[1].day).toBe("2026-09-03");
    expect(items[0].previous!.ratings.Overall).toBe(32.55);
  });

  it("uses the first recorded baseline for gains made on the starting day", () => {
    const days = groupSkillHistoryByDay([entry(2, 4, 22, 32.49, 32.35), entry(1, 4, 0, 32.35, null)]);
    expect(days).toHaveLength(1);
    expect(days[0].previous!.ratings.Overall).toBe(32.35);
    expect(groupSkillHistoryByDay([entry(1, 4, 0, 32.35, null)])[0].previous).toBeNull();
    expect(groupSkillHistoryByDay([])).toEqual([]);
  });

  it("groups at local midnight and keeps dates in different years separate", () => {
    const items = [entry(3, 4, 0, 3, 2), entry(2, 3, 23, 2, 1), entry(1, 3, 22, 1, null)];
    items[2].recordedAt = new Date(2025, 8, 4, 22).toISOString();
    expect(groupSkillHistoryByDay(items).map((day) => day.day)).toEqual(["2026-09-04", "2026-09-03", "2025-09-04"]);
  });

  it("finishes a busy day across pages and leaves the next day behind the returned cursor", async () => {
    const items = [entry(5, 4, 22, 5, 4), entry(4, 4, 20, 4, 3), entry(3, 4, 18, 3, 2), entry(2, 3, 20, 2, 1), entry(1, 3, 18, 1, null)];
    const fetchPage = vi.fn(async (before?: number) => {
      const remaining = items.filter((item) => before == null || item.id < before);
      return { items: remaining.slice(0, 1), nextBefore: remaining.length > 1 ? remaining[0].id : null };
    });
    const first = await loadSkillHistoryDays(fetchPage);
    expect(first).toEqual({ items: items.slice(0, 3), nextBefore: 3 });
    const second = await loadSkillHistoryDays(fetchPage, first.nextBefore!);
    expect(second).toEqual({ items: items.slice(3), nextBefore: null });
    expect(groupSkillHistoryByDay([...first.items, ...second.items])).toHaveLength(2);
  });

  it("does not fetch beyond a complete final page", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [entry(1, 4, 0, 32.35, null)], nextBefore: null });
    expect((await loadSkillHistoryDays(fetchPage)).nextBefore).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("does not return a partial daily total if a continuation fails", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [entry(2, 4, 22, 32.49, 32.35)], nextBefore: 2 })
      .mockRejectedValueOnce(new Error("Request aborted"));
    await expect(loadSkillHistoryDays(fetchPage)).rejects.toThrow("Request aborted");
  });
});
