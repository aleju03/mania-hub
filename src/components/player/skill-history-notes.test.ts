import { describe, expect, it } from "vitest";
import type { LivePlayerSkillHistoryEntry } from "../../lib/live-backend";
import { SKILL_HISTORY_NOTES, mergeSkillHistoryNotes, type SkillHistoryNote } from "./skill-history-notes";

function day(date: string): LivePlayerSkillHistoryEntry & { day: string } {
  return {
    id: Number(date.replaceAll("-", "")),
    recordedAt: `${date}T12:00:00.000Z`,
    snapshot: { ratings: { Overall: 20 }, dan: { rc: null, ln: null } },
    previous: null,
    day: date,
  } as unknown as LivePlayerSkillHistoryEntry & { day: string };
}

const notes: SkillHistoryNote[] = [
  { date: "2026-09-06", text: "newer", keyCounts: [4] },
  { date: "2026-09-03", text: "older" },
];

describe("mergeSkillHistoryNotes", () => {
  it("puts a note above the day it landed on", () => {
    const rows = mergeSkillHistoryNotes([day("2026-09-06"), day("2026-09-03")], 4, notes);
    expect(rows.map((row) => row.kind === "note" ? row.note.text : row.entry.day))
      .toEqual(["newer", "2026-09-06", "older", "2026-09-03"]);
  });

  it("keeps a note newer than every recorded day", () => {
    const rows = mergeSkillHistoryNotes([day("2026-09-04")], 4, notes);
    expect(rows.map((row) => row.kind === "note" ? row.note.text : row.entry.day))
      .toEqual(["newer", "2026-09-04"]);
  });

  it("leaves out notes older than the oldest loaded day", () => {
    const rows = mergeSkillHistoryNotes([day("2026-09-05")], 4, notes);
    expect(rows.filter((row) => row.kind === "note")).toHaveLength(1);
  });

  it("skips a note scoped to another keymode", () => {
    const rows = mergeSkillHistoryNotes([day("2026-09-06")], 7, notes);
    expect(rows.map((row) => row.kind === "note" ? row.note.text : row.entry.day))
      .toEqual(["2026-09-06"]);
  });

  it("shows nothing when there is no history at all", () => {
    expect(mergeSkillHistoryNotes([], 4, notes)).toEqual([]);
  });

  it("keeps the shipped notes newest first", () => {
    const dates = SKILL_HISTORY_NOTES.map((note) => note.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
