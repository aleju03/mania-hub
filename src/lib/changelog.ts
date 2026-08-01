import { useEffect, useState } from "react";
import { LATEST_UPDATE_DATE, type ChangelogUpdate } from "../data/changelog";

// Own tiny localStorage key rather than the main `mania-hub-cache-v5` blob: a
// quota eviction there would resurrect the footer dot for every entry the
// reader has already seen.
export const CHANGELOG_SEEN_STORAGE_KEY = "mania-hub-changelog-seen-v1";
/** Fired after markChangelogSeen so an already-mounted footer drops its dot. */
export const CHANGELOG_SEEN_EVENT = "mania-hub:changelog-seen";

const DAY_MS = 86_400_000;

function warnStorageIssue(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[changelog] ${action} failed: ${message}`);
}

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

export function readChangelogSeenDate(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(CHANGELOG_SEEN_STORAGE_KEY);
  } catch (error) {
    warnStorageIssue(`read "${CHANGELOG_SEEN_STORAGE_KEY}"`, error);
    return null;
  }
}

export function markChangelogSeen(date: string = LATEST_UPDATE_DATE): void {
  if (typeof window === "undefined" || !date) return;
  try {
    localStorage.setItem(CHANGELOG_SEEN_STORAGE_KEY, date);
  } catch (error) {
    warnStorageIssue(`write "${CHANGELOG_SEEN_STORAGE_KEY}"`, error);
  }
  window.dispatchEvent(new Event(CHANGELOG_SEEN_EVENT));
}

export function hasUnseenChangelog(seenDate: string | null, latestDate = LATEST_UPDATE_DATE): boolean {
  if (!latestDate) return false;
  // A reader who has never opened it gets no dot: the changelog is not news to
  // someone who has never been told it exists, and a permanent dot in the
  // footer reads as a bug.
  if (!seenDate) return false;
  return seenDate < latestDate;
}

/**
 * Whether to mark the footer link as having updates the reader has not opened.
 *
 * Always false on the first render: the footer is server-rendered and the
 * answer lives in localStorage, so deciding before mount would mismatch
 * hydration (which resets <html> and strips the theme vars, see
 * reapplyThemeToDom).
 */
export function useHasUnseenChangelog(): boolean {
  const [unseen, setUnseen] = useState(false);

  useEffect(() => {
    const sync = () => setUnseen(hasUnseenChangelog(readChangelogSeenDate()));
    sync();
    window.addEventListener(CHANGELOG_SEEN_EVENT, sync);
    return () => window.removeEventListener(CHANGELOG_SEEN_EVENT, sync);
  }, []);

  return unseen;
}
