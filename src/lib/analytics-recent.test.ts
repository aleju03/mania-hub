import { describe, expect, it } from "vitest";
import {
  ANALYTICS_PENDING_EVENT_TTL_MS,
  prependPendingAnalyticsEvent,
  reconcileAnalyticsRecentEvents,
} from "./analytics-recent";

interface TestEvent {
  eventId: string | null;
  country: string | null;
  label: string;
}

const NOW = 1_000_000;

function event(eventId: string, label = eventId, country = "CR"): TestEvent {
  return { eventId, country, label };
}

describe("analytics recent-event reconciliation", () => {
  it("keeps an SSE event visible while a stale snapshot catches up", () => {
    const live = event("live-1");
    const pending = prependPendingAnalyticsEvent([], live, NOW, 1000);
    const stale = reconcileAnalyticsRecentEvents({
      snapshot: [event("old-1")],
      pending,
      country: null,
      now: NOW + 1_000,
      limit: 1000,
    });

    expect(stale.rows.map((row) => row.eventId)).toEqual(["live-1", "old-1"]);
    expect(stale.pending).toHaveLength(1);
  });

  it("deduplicates a live event once the snapshot confirms its ID", () => {
    const live = event("live-1");
    const pending = prependPendingAnalyticsEvent([], live, NOW, 1000);
    const fresh = reconcileAnalyticsRecentEvents({
      snapshot: [live, event("old-1")],
      pending,
      country: null,
      now: NOW + 5_000,
      limit: 1000,
    });

    expect(fresh.rows.map((row) => row.eventId)).toEqual(["live-1", "old-1"]);
    expect(fresh.pending).toHaveLength(0);
  });

  it("retains other-country pending events without showing them in a filtered feed", () => {
    const germanEvent = event("de-1", "German event", "DE");
    const pending = prependPendingAnalyticsEvent([], germanEvent, NOW, 1000);
    const filtered = reconcileAnalyticsRecentEvents({
      snapshot: [event("cr-1")],
      pending,
      country: "CR",
      now: NOW + 5_000,
      limit: 1000,
    });

    expect(filtered.rows.map((row) => row.eventId)).toEqual(["cr-1"]);
    expect(filtered.pending).toHaveLength(1);
  });

  it("expires live rows that never become durable", () => {
    const pending = prependPendingAnalyticsEvent([], event("lost-1"), NOW, 1000);
    const result = reconcileAnalyticsRecentEvents({
      snapshot: [],
      pending,
      country: null,
      now: NOW + ANALYTICS_PENDING_EVENT_TTL_MS + 1,
      limit: 1000,
    });

    expect(result.rows).toEqual([]);
    expect(result.pending).toEqual([]);
  });
});
