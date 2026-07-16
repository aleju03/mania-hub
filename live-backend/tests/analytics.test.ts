import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, type Db } from "../src/db.js";
import { AnalyticsStore, deviceKindFor, normalizeAnalyticsEvent } from "../src/features/analytics.js";

let dir = "";
let db: Db;
let store: AnalyticsStore;

const NOW = Date.parse("2026-07-16T18:00:00Z");
const LIVE_HOST = "mania-tracker.com";

function pageview(overrides: {
  distinctId?: string;
  path?: string;
  host?: string;
  minutesAgo?: number;
  properties?: Record<string, unknown>;
  event?: string;
} = {}): unknown {
  const ts = NOW - (overrides.minutesAgo ?? 1) * 60_000;
  return {
    event: overrides.event ?? "$pageview",
    distinct_id: overrides.distinctId ?? "visitor-1",
    timestamp: new Date(ts).toISOString(),
    properties: {
      $host: overrides.host ?? LIVE_HOST,
      $pathname: overrides.path ?? "/tracker",
      $screen_width: 1920,
      ...overrides.properties,
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-analytics-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "analytics.db")}` });
  store = new AnalyticsStore(db, { retentionDays: 90 });
  await store.ensureSchema();
});

afterEach(async () => {
  store.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("normalizeAnalyticsEvent", () => {
  it("extracts columns from a PostHog-shaped payload", () => {
    const record = normalizeAnalyticsEvent(pageview({ properties: { viewer_username: "someone", selected_country: "CR" } }), { geoCountry: "de", now: NOW });
    expect(record).not.toBeNull();
    expect(record!.event).toBe("$pageview");
    expect(record!.distinctId).toBe("visitor-1");
    expect(record!.host).toBe(LIVE_HOST);
    expect(record!.path).toBe("/tracker");
    expect(record!.country).toBe("DE");
    expect(record!.selectedCountry).toBe("CR");
    expect(record!.viewerUsername).toBe("someone");
    expect(record!.screenWidth).toBe(1920);
  });

  it("rejects garbage and missing event names", () => {
    expect(normalizeAnalyticsEvent(null, {})).toBeNull();
    expect(normalizeAnalyticsEvent("nope", {})).toBeNull();
    expect(normalizeAnalyticsEvent({ properties: {} }, {})).toBeNull();
    expect(normalizeAnalyticsEvent({ event: "   " }, {})).toBeNull();
  });

  it("clamps far-future and ancient timestamps", () => {
    const future = normalizeAnalyticsEvent({ event: "x", distinct_id: "a", timestamp: new Date(NOW + 60 * 60_000).toISOString() }, { now: NOW });
    expect(future!.ts).toBeLessThanOrEqual(NOW + 60_000);
    const ancient = normalizeAnalyticsEvent({ event: "x", distinct_id: "a", timestamp: "1990-01-01T00:00:00Z" }, { now: NOW });
    expect(ancient!.ts).toBeGreaterThanOrEqual(NOW - 24 * 60 * 60_000);
  });

  it("falls back to the payload's geoip country when the proxy sent none", () => {
    const record = normalizeAnalyticsEvent(pageview({ properties: { $geoip_country_code: "cr" } }), { now: NOW });
    expect(record!.country).toBe("CR");
  });
});

describe("deviceKindFor", () => {
  it("classifies widths", () => {
    expect(deviceKindFor(390, null)).toBe("mobile");
    expect(deviceKindFor(1920, null)).toBe("desktop");
    expect(deviceKindFor(null, 800)).toBe("desktop");
    expect(deviceKindFor(null, null)).toBe("unknown");
  });
});

describe("AnalyticsStore capture + monitor", () => {
  it("persists captured events and answers the overview", async () => {
    store.capture(pageview({ distinctId: "a" }), {});
    store.capture(pageview({ distinctId: "b", path: "/maps" }), { geoCountry: "CR" });
    store.capture(pageview({ distinctId: "a", path: "/admin/live-backend" }), {});
    store.capture({ event: "osu_api_error", distinct_id: "server", timestamp: new Date(NOW - 60_000).toISOString(), properties: { caller: "rankings", path: "/x", status: 500 } }, {});
    await store.flush();

    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    // /admin pageviews are stored (events total) but never counted as pageviews.
    expect(data.eventsInRange).toBe(4);
    expect(data.pageviewsInRange).toBe(2);
    expect(data.uniqueVisitorsInRange).toBe(2);
    expect(data.activeVisitors).toBe(2);
    expect(data.serverErrors).toEqual([{ caller: "rankings", path: "/x", status: 500, count: 1 }]);
    expect(data.recentServerErrors[0]?.caller).toBe("rankings");
    expect(data.recentServerErrors[0]?.timestamp).toBeTruthy();
  });

  it("keeps bots out of every aggregate", async () => {
    store.capture(pageview({ distinctId: "bot" }), { isBot: true });
    store.capture(pageview({ distinctId: "human" }), {});
    await store.flush();
    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(data.pageviewsInRange).toBe(1);
    expect(data.uniqueVisitorsInRange).toBe(1);
    expect(data.recentEvents).toHaveLength(1);
    expect(data.recentEvents[0]?.distinctId).toBe("human");
  });

  it("filters the recent feed to real live-site visitors", async () => {
    store.capture(pageview({ distinctId: "localdev", host: "localhost:3000" }), {});
    store.capture(pageview({ distinctId: "owner", properties: { viewer_username: "Aleju03" } }), {});
    store.capture(pageview({ distinctId: "landing", path: "/" }), {});
    store.capture(pageview({ distinctId: "real", path: "/maps", properties: { maps_query: "stream", maps_tab: "farmed" } }), { geoCountry: "CR" });
    await store.flush();

    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(data.recentEvents).toHaveLength(1);
    const event = data.recentEvents[0]!;
    expect(event.path).toBe("/maps");
    expect(event.country).toBe("CR");
    expect(event.mapsQuery).toBe("stream");
    expect(event.mapsTab).toBe("farmed");
    expect(event.deviceKind).toBe("desktop");
    expect(event.timestamp).toBeTruthy();
  });

  it("applies the recent-feed country filter", async () => {
    store.capture(pageview({ distinctId: "a", path: "/maps" }), { geoCountry: "CR" });
    store.capture(pageview({ distinctId: "b", path: "/maps" }), { geoCountry: "DE" });
    await store.flush();
    const data = await store.getMonitorData({ rangeHours: 24, recentCountry: "cr", now: NOW });
    expect(data.recentEvents).toHaveLength(1);
    expect(data.recentEvents[0]?.country).toBe("CR");
  });

  it("aggregates top profiles with the latest visitor's country", async () => {
    store.capture(pageview({ distinctId: "a", path: "/player/juan", minutesAgo: 30, properties: { profile_username: "juan" } }), { geoCountry: "US" });
    store.capture(pageview({ distinctId: "b", path: "/player/juan", minutesAgo: 5, properties: { profile_username: "juan" } }), { geoCountry: "CR" });
    await store.flush();
    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(data.topProfiles).toHaveLength(1);
    expect(data.topProfiles[0]).toMatchObject({ username: "juan", views: 2, lastVisitorCountry: "CR" });
    expect(data.topProfiles[0]?.lastViewedLabel).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("aggregates top replays keyed by score id", async () => {
    const replayView = (distinctId: string, minutesAgo: number) => ({
      event: "replay_view",
      distinct_id: distinctId,
      timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
      properties: {
        $host: LIVE_HOST,
        replay_score_id: "12345",
        replay_title: "Song",
        replay_artist: "Artist",
        replay_player: "player1",
      },
    });
    store.capture(replayView("a", 20), { geoCountry: "US" });
    store.capture(replayView("b", 2), { geoCountry: "JP" });
    await store.flush();
    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(data.topReplays[0]).toMatchObject({ scoreId: "12345", views: 2, title: "Song", lastVisitorCountry: "JP" });
  });

  it("computes bounce over home-page landers only", async () => {
    // Bounced: landed on / and never viewed anything else.
    store.capture(pageview({ distinctId: "bouncer", path: "/" }), {});
    // Lander who kept browsing.
    store.capture(pageview({ distinctId: "stayer", path: "/" }), {});
    store.capture(pageview({ distinctId: "stayer", path: "/maps" }), {});
    // Deep-link visitor: not a lander, not counted.
    store.capture(pageview({ distinctId: "deep", path: "/tracker" }), {});
    await store.flush();
    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(data.bounce).toEqual({ bounced: 1, landers: 2 });
  });

  it("counts shares and share platforms", async () => {
    store.capture({ event: "page_shared", distinct_id: "server", timestamp: new Date(NOW - 60_000).toISOString(), properties: { crawler: "Discord", pathname: "/player/juan", subject: "juan", subject_type: "player" } }, {});
    await store.flush();
    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(data.shareEvents).toBe(1);
    expect(data.sharesByPlatform).toEqual([{ platform: "Discord", count: 1 }]);
    expect(data.topSharedPages).toEqual([{ path: "/player/juan", subject: "juan", subjectType: "player", count: 1 }]);
  });

  it("answers the valley slice", async () => {
    store.capture(pageview({ distinctId: "a", path: "/tracker", minutesAgo: 2 }), { geoCountry: "CR" });
    store.capture(pageview({ distinctId: "server-ish", path: "/admin/live-backend", minutesAgo: 1 }), {});
    await store.flush();
    const valley = await store.getValleyVisitors(NOW);
    expect(valley.activeVisitors).toBe(2);
    expect(valley.recent).toHaveLength(1);
    expect(valley.recent[0]).toMatchObject({ path: "/tracker", country: "CR", distinctId: "a" });
  });

  it("prunes rows past retention", async () => {
    // Insert directly: the ingest path clamps timestamps to the last 24h.
    await exec(db, "insert into analytics_events (ts, event, distinct_id, props) values (?, 'x', 'old', '{}')", [NOW - 200 * 24 * 60 * 60_000]);
    store.capture(pageview({ distinctId: "fresh" }), {});
    await store.flush();
    const removed = await store.prune(NOW);
    expect(removed).toBe(1);
    const remaining = await exec(db, "select count(*) as n from analytics_events");
    expect(Number(remaining.rows[0]?.n)).toBe(1);
  });

  it("caps oversized property bags", async () => {
    store.capture(pageview({ distinctId: "big", properties: { huge: "x".repeat(64 * 1024) } }), {});
    await store.flush();
    const row = (await exec(db, "select props from analytics_events limit 1")).rows[0];
    expect(String(row?.props).length).toBeLessThan(1024);
    expect(JSON.parse(String(row?.props))._truncated).toBe(true);
  });

  it("accepts batched capture bodies", async () => {
    const accepted = store.capture({ batch: [pageview({ distinctId: "a" }), pageview({ distinctId: "b" }), null] }, {});
    expect(accepted).toBe(2);
  });
});

describe("AnalyticsStore realtime", () => {
  it("notifies subscribers on capture and shapes feed events", () => {
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe((record) => {
      if (store.feedFilterAccepts(record)) seen.push(store.buildFeedEvent(record));
    });
    store.capture(pageview({ distinctId: "bot" }), { isBot: true });
    store.capture(pageview({ distinctId: "human", path: "/maps", properties: { maps_query: "jack" } }), { geoCountry: "CR" });
    unsubscribe();
    store.capture(pageview({ distinctId: "after" }), {});
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "$pageview", path: "/maps", country: "CR", mapsQuery: "jack" });
  });

  it("issues and validates expiring live tickets", () => {
    const { ticket, expiresAt } = store.issueLiveTicket(NOW);
    expect(expiresAt).toBeGreaterThan(NOW);
    expect(store.consumeLiveTicket(ticket, NOW)).toBe(true);
    expect(store.consumeLiveTicket(ticket, expiresAt + 1)).toBe(false);
    expect(store.consumeLiveTicket("nope", NOW)).toBe(false);
    expect(store.consumeLiveTicket(null, NOW)).toBe(false);
  });
});
