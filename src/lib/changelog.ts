import { type ChangelogUpdate } from "../data/changelog";

const DAY_MS = 86_400_000;

/** Midnight UTC of a YYYY-MM-DD day, or NaN when the input is not a date. */
function utcDayStart(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Coarse age label for a release day: "today", "yesterday", "4 days ago",
 * "3 weeks ago", "2 months ago".
 *
 * Days run all the way to 13 before switching to weeks: a burst of releases
 * eight to thirteen days apart would otherwise all read "last week" and the
 * column would stop telling the reader anything.
 *
 * Counted in whole UTC days so the same day always produces the same string in
 * every timezone. The exact date renders next to it, so the vagueness at the
 * top of each bucket never costs the reader anything.
 */
export function formatReleaseAge(date: string, now: number = Date.now()): string {
  const day = utcDayStart(date);
  if (Number.isNaN(day)) return "";
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const days = Math.round((today - day) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "last year" : `${years} years ago`;
}

export interface ChangelogDay {
  date: string;
  updates: ChangelogUpdate[];
}

/**
 * Collapses the flat newest-first list into one entry per release day, so the
 * modal prints the age label once instead of repeating "yesterday" down a
 * column of rows that all shipped together.
 *
 * Only merges neighbours, which keeps the input order: the list is already
 * sorted newest first (a content test enforces it), and a stray out-of-order
 * date is better shown twice than silently hoisted somewhere the author did
 * not put it.
 */
export function groupUpdatesByDay(updates: readonly ChangelogUpdate[]): ChangelogDay[] {
  const days: ChangelogDay[] = [];
  for (const update of updates) {
    const current = days[days.length - 1];
    if (current && current.date === update.date) current.updates.push(update);
    else days.push({ date: update.date, updates: [update] });
  }
  return days;
}
