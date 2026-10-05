import { msg } from "@lingui/core/macro";

import { UPDATES, type ChangelogUpdate } from "../data/changelog";
import { getI18n } from "./i18n";
import type { AppLocale } from "./locale";

const DAY_MS = 86_400_000;

/**
 * The day boundary the changelog counts from: UTC-6, the home country's clock,
 * which has no DST so a fixed offset is exact all year.
 *
 * Not UTC, and not the reader's own timezone. Release days are written by hand
 * as the author lives them, and an evening of work in UTC-6 crosses UTC
 * midnight: bucketing by UTC split one working day into "today" and
 * "yesterday". A fixed offset keeps a day whole and still renders the same
 * string for every reader.
 */
const SITE_UTC_OFFSET_MS = -6 * 3_600_000;

/** Instant of site midnight opening a YYYY-MM-DD day, NaN if not a date. */
function siteDayStart(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed - SITE_UTC_OFFSET_MS : Number.NaN;
}

/**
 * Coarse age label for a release day: "today", "yesterday", "4 days ago",
 * "3 weeks ago", "2 months ago".
 *
 * Days run all the way to 13 before switching to weeks: a burst of releases
 * eight to thirteen days apart would otherwise all read "last week" and the
 * column would stop telling the reader anything.
 *
 * Counted in whole site days (see `SITE_UTC_OFFSET_MS`) so the same day always
 * produces the same string in every timezone. The exact date renders next to
 * it, so the vagueness at the top of each bucket never costs the reader
 * anything.
 */
export function formatReleaseAge(
  date: string,
  now: number = Date.now(),
  locale: AppLocale = "en",
): string {
  const i18n = getI18n(locale);
  const day = siteDayStart(date);
  if (Number.isNaN(day)) return "";
  const today =
    Math.floor((now + SITE_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - SITE_UTC_OFFSET_MS;
  const days = Math.round((today - day) / DAY_MS);
  if (days <= 0) return i18n._(msg`today`);
  if (days === 1) return i18n._(msg`yesterday`);
  if (days < 14) return i18n._(msg`${days} days ago`);
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return i18n._(msg`${weeks} weeks ago`);
  }
  const months = Math.floor(days / 30);
  if (months < 12) return i18n._(msg`${months} months ago`);
  const years = Math.floor(days / 365);
  return years === 1 ? i18n._(msg`last year`) : i18n._(msg`${years} years ago`);
}

export type ChangelogKind = "new" | "change" | "fix";

/**
 * What an entry is, for the filter chips: read off its first words, since the
 * house style already opens a fix with "Fixed" and an addition with "Added",
 * "New" or "You can now". Anything else is a change. `kind` on the entry wins
 * when the wording misleads.
 */
export function changelogKind(update: ChangelogUpdate): ChangelogKind {
  if (update.kind) return update.kind;
  if (/^Fixed\b/.test(update.text)) return "fix";
  if (/^(Added|New|You can now)\b/.test(update.text)) return "new";
  return "change";
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

/**
 * Marker for the newest changelog entry a reader has seen: the newest day plus
 * how many entries that day has, so a second release on the same day still
 * counts as new. Folding a fix into an existing line changes neither, which is
 * intended: that is not something new to come back for.
 */
export function changelogSeenMarker(updates: readonly ChangelogUpdate[]): string | null {
  const newest = updates[0]?.date;
  if (!newest) return null;
  return `${newest}:${updates.filter((update) => update.date === newest).length}`;
}

/** Whether the changelog has entries newer than a stored marker. No marker counts as unseen. */
export function hasUnseenChangelog(updates: readonly ChangelogUpdate[], seen: string | null): boolean {
  const current = changelogSeenMarker(updates);
  if (!current) return false;
  if (!seen) return true;
  const [seenDate, seenCount] = seen.split(":");
  const [date, count] = current.split(":");
  if (date !== seenDate) return date > seenDate;
  return Number(count) > Number(seenCount);
}

export const CHANGELOG_SEEN_KEY = "mania-hub-changelog-seen-v1";

export function readChangelogSeen(): string | null {
  try {
    return window.localStorage.getItem(CHANGELOG_SEEN_KEY);
  } catch {
    return null;
  }
}

/** Records the current changelog as read, on opening it or turning on notifications. */
export function markChangelogSeen(): void {
  const marker = changelogSeenMarker(UPDATES);
  if (!marker) return;
  try {
    window.localStorage.setItem(CHANGELOG_SEEN_KEY, marker);
  } catch {
    // Private mode or a full quota: the dot just comes back next visit.
  }
}
