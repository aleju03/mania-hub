import type { LivePlayerSkillHistoryEntry, LivePlayerSkillHistoryPage } from "../../lib/live-backend";

function localDay(recordedAt: string): string {
  const date = new Date(recordedAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Newest-first events become one closing snapshot and opening reference per day. */
export function groupSkillHistoryByDay(items: LivePlayerSkillHistoryEntry[]) {
  const days = new Map<string, LivePlayerSkillHistoryEntry & { day: string }>();
  for (const entry of items) {
    const day = localDay(entry.recordedAt);
    const existing = days.get(day);
    if (existing) {
      // The first recorded snapshot is a baseline, not a gain from zero.
      existing.previous = entry.previous ?? entry.snapshot;
    } else {
      days.set(day, { ...entry, day });
    }
  }
  return [...days.values()];
}

/** Finish the last local day before showing it, even across API page boundaries. */
export async function loadSkillHistoryDays(
  fetchPage: (before?: number) => Promise<LivePlayerSkillHistoryPage>,
  before?: number,
): Promise<LivePlayerSkillHistoryPage> {
  const page = await fetchPage(before);
  const items = [...page.items];
  let nextBefore = page.nextBefore;
  const last = items.at(-1);
  if (!last) return page;
  const lastDay = localDay(last.recordedAt);
  while (nextBefore != null) {
    const older = await fetchPage(nextBefore);
    const boundary = older.items.findIndex((entry) => localDay(entry.recordedAt) !== lastDay);
    if (boundary !== -1) {
      items.push(...older.items.slice(0, boundary));
      // Leave the older day's entries for the next request.
      nextBefore = items.at(-1)!.id;
      break;
    }
    items.push(...older.items);
    nextBefore = older.nextBefore;
  }
  return { items, nextBefore };
}
