export interface AnalyticsRecentEventIdentity {
  eventId: string | null;
  country: string | null;
}

export interface PendingAnalyticsRecentEvent<T extends AnalyticsRecentEventIdentity> {
  row: T;
  receivedAt: number;
}

export const ANALYTICS_PENDING_EVENT_TTL_MS = 5 * 60_000;

function normalizedEventId(row: AnalyticsRecentEventIdentity): string | null {
  const eventId = row.eventId?.trim();
  return eventId || null;
}

export function prependPendingAnalyticsEvent<T extends AnalyticsRecentEventIdentity>(
  pending: PendingAnalyticsRecentEvent<T>[],
  row: T,
  receivedAt: number,
  limit: number,
): PendingAnalyticsRecentEvent<T>[] {
  const eventId = normalizedEventId(row);
  if (eventId && pending.some((entry) => normalizedEventId(entry.row) === eventId)) {
    return pending;
  }
  return [{ row, receivedAt }, ...pending].slice(0, limit);
}

export function reconcileAnalyticsRecentEvents<T extends AnalyticsRecentEventIdentity>({
  snapshot,
  pending,
  country,
  now,
  limit,
}: {
  snapshot: T[];
  pending: PendingAnalyticsRecentEvent<T>[];
  country: string | null;
  now: number;
  limit: number;
}): { rows: T[]; pending: PendingAnalyticsRecentEvent<T>[] } {
  const snapshotIds = new Set(
    snapshot
      .map(normalizedEventId)
      .filter((eventId): eventId is string => eventId != null),
  );
  const nextPending = pending.filter((entry) => {
    if (now - entry.receivedAt > ANALYTICS_PENDING_EVENT_TTL_MS) return false;
    const eventId = normalizedEventId(entry.row);
    const snapshotCoversCountry = country == null || entry.row.country === country;
    return !eventId || !snapshotCoversCountry || !snapshotIds.has(eventId);
  });

  const rows: T[] = [];
  const seenIds = new Set<string>();
  const append = (row: T) => {
    const eventId = normalizedEventId(row);
    if (eventId && seenIds.has(eventId)) return;
    if (eventId) seenIds.add(eventId);
    rows.push(row);
  };

  nextPending.forEach((entry) => {
    if (country == null || entry.row.country === country) append(entry.row);
  });
  snapshot.forEach(append);

  return {
    rows: rows.slice(0, limit),
    pending: nextPending,
  };
}
