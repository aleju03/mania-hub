import type { LivePlayerSkillHistoryEntry } from "../../lib/live-backend";

/**
 * Rating-system changes worth explaining inside a player's skill history.
 *
 * Static data on purpose, like the site changelog: a note lands in the same
 * commit as the work it describes, and no projection has to remember it.
 *
 * House rules:
 * - One line, written for the player whose number just moved. Say what the
 *   site now measures differently, not how it is implemented.
 * - Only changes that can move a rating or a dan on their own. Everything
 *   else belongs in the footer changelog.
 * - Newest first. `date` is the day it went live on the site clock (UTC-6).
 * - `keyCounts` limits a note to the keymodes it can touch; leave it out for
 *   a change every keymode feels.
 */
export interface SkillHistoryNote {
  /** Day it went live on the site clock (UTC-6), as YYYY-MM-DD. */
  date: string;
  text: string;
  keyCounts?: readonly number[];
}

export const SKILL_HISTORY_NOTES: readonly SkillHistoryNote[] = [
  {
    date: "2026-09-06",
    text: "Reduced the rice dan penalty for scores just below the accuracy requirement. A 95.9% on a chart requiring 96% now gives almost full dan credit.",
  },
  {
    date: "2026-09-06",
    text: "Adjusted 4K vibro detection to exclude more fast rolls and repeated chords from skill and dan ratings, including DT scores on ranked maps.",
    keyCounts: [4],
  },
  {
    date: "2026-09-06",
    text: "Fixed some 4K stamina maps incorrectly counting toward speed dan.",
    keyCounts: [4],
  },
  {
    date: "2026-09-06",
    text: "Clears at different rates of the same chart now carry less weight in your dan average: 100% for the best clear, 90% for the next, then 81%, and so on. Matching reuploads count as the same chart.",
  },
];

export type SkillHistoryRow =
  | { kind: "entry"; entry: LivePlayerSkillHistoryEntry & { day: string } }
  | { kind: "note"; note: SkillHistoryNote };

/**
 * Merge the notes into a newest-first day list, above the day they landed on.
 *
 * A note older than the oldest loaded day is left out: it belongs to a page
 * the reader has not asked for yet, and once they load it the note comes with
 * it. A note newer than every entry still shows, since a player whose rating
 * has not been recomputed yet is exactly who the note is for.
 */
export function mergeSkillHistoryNotes(
  days: (LivePlayerSkillHistoryEntry & { day: string })[],
  keyCount: number,
  notes: readonly SkillHistoryNote[] = SKILL_HISTORY_NOTES,
): SkillHistoryRow[] {
  const oldest = days.at(-1)?.day;
  if (!oldest) return days.map((entry) => ({ kind: "entry", entry }));
  const visible = notes.filter((note) =>
    note.date >= oldest && (!note.keyCounts || note.keyCounts.includes(keyCount)));
  const rows: SkillHistoryRow[] = [];
  let index = 0;
  for (const entry of days) {
    while (index < visible.length && visible[index].date >= entry.day) {
      rows.push({ kind: "note", note: visible[index++] });
    }
    rows.push({ kind: "entry", entry });
  }
  for (; index < visible.length; index++) rows.push({ kind: "note", note: visible[index] });
  return rows;
}
