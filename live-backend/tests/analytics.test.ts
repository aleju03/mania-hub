import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, type Db } from "../src/db.js";
import { AnalyticsStore, deviceKindFor, normalizeAnalyticsEvent } from "../src/features/analytics.js";

let dir = "";
let db: Db;
let store: AnalyticsStore;

// Anchored to the real clock: capture() clamps event timestamps against
// Date.now() (last 24h), so a hardcoded date here silently ages out of the
// window and collapses distinct timestamps into ties (bit us 2026-07-17).
const NOW = Date.now();
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
  it("extracts columns from a capture payload", () => {
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
    expect(record!.properties.$insert_id).toEqual(expect.any(String));
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
    expect(event.eventId).toEqual(expect.any(String));
  });

  it("carries epoch ms and the referring domain on feed rows", async () => {
    store.capture(pageview({ distinctId: "real", path: "/maps", minutesAgo: 3, properties: { $referring_domain: "Google.com" } }), {});
    await store.flush();
    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    const event = data.recentEvents[0]!;
    expect(event.ts).toBeGreaterThan(NOW - 4 * 60_000);
    expect(event.ts).toBeLessThanOrEqual(NOW);
    expect(event.referrer).toBe("google.com");
  });

  it("buckets a dense traffic timeline across the range", async () => {
    store.capture(pageview({ distinctId: "a", path: "/maps", minutesAgo: 5 }), {});
    store.capture(pageview({ distinctId: "b", path: "/maps", minutesAgo: 5 }), {});
    store.capture(pageview({ distinctId: "a", path: "/admin/live-backend", minutesAgo: 5 }), {});
    store.capture(pageview({ distinctId: "c", path: "/tracker", minutesAgo: 12 * 60 }), {});
    await store.flush();

    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(data.timeline).toHaveLength(48);
    expect(data.bucketMs).toBe(30 * 60_000);
    // Dense: every bucket present, ascending, aligned to the range start.
    data.timeline.forEach((bucket, index) => {
      if (index === 0) return;
      expect(bucket.ts - data.timeline[index - 1]!.ts).toBe(data.bucketMs);
    });
    const totals = data.timeline.reduce(
      (acc, bucket) => ({ events: acc.events + bucket.events, pageviews: acc.pageviews + bucket.pageviews }),
      { events: 0, pageviews: 0 },
    );
    expect(totals.events).toBe(4);
    // /admin pageviews stay out of the pageview series, same as the KPI.
    expect(totals.pageviews).toBe(3);
    const latest = data.timeline.at(-1)!;
    expect(latest.events).toBe(3);
    expect(latest.visitors).toBe(2);
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

  it("builds a durable roster of every signed-in osu! account", async () => {
    const signedIn = (username: string, viewerId: number, minutesAgo: number, country?: string) =>
      pageview({ distinctId: `d${viewerId}`, minutesAgo, properties: { viewer_username: username, viewer_id: viewerId, ...(country ? { $geoip_country_code: country } : {}) } });

    store.capture(signedIn("juan", 111, 60), {});
    store.capture(signedIn("juan", 111, 5, "cr"), {});
    store.capture(signedIn("kanaria", 222, 30, "jp"), {});
    // Anonymous and bot traffic never joins the roster.
    store.capture(pageview({ distinctId: "anon" }), {});
    store.capture(signedIn("botlike", 333, 2), { isBot: true });
    await store.flush();

    expect(await store.countViewers()).toBe(2);
    const viewers = await store.getViewers();
    // Newest activity first.
    expect(viewers.map((v) => v.username)).toEqual(["juan", "kanaria"]);
    const juan = viewers[0]!;
    expect(juan.viewerId).toBe(111);
    expect(juan.events).toBe(2);
    expect(juan.country).toBe("CR");
    expect(juan.lastSeen - juan.firstSeen).toBeGreaterThan(50 * 60_000);
  });

  it("keeps counting a returning viewer across flushes and follows renames", async () => {
    const visit = (username: string, minutesAgo: number) =>
      pageview({ distinctId: "d1", minutesAgo, properties: { viewer_username: username, viewer_id: 111 } });

    store.capture(visit("oldname", 120), {});
    await store.flush();
    store.capture(visit("newname", 10), {});
    await store.flush();

    const viewers = await store.getViewers();
    expect(viewers).toHaveLength(1);
    expect(viewers[0]).toMatchObject({ viewerId: 111, username: "newname", events: 2 });

    // An out-of-order older event must not roll the name back.
    store.capture(visit("oldname", 240), {});
    await store.flush();
    const after = await store.getViewers();
    expect(after[0]).toMatchObject({ username: "newname", events: 3 });
    expect(after[0]!.firstSeen).toBeLessThan(NOW - 200 * 60_000);
  });

  it("seeds the roster from events already stored when the table is new", async () => {
    store.capture(pageview({ distinctId: "d1", minutesAgo: 90, properties: { viewer_username: "juan", viewer_id: 111 } }), {});
    store.capture(pageview({ distinctId: "d1", minutesAgo: 20, properties: { viewer_username: "juan", viewer_id: 111 } }), { geoCountry: "CR" });
    await store.flush();
    await exec(db, "drop table analytics_viewers");

    // A fresh store over the same file is the first-boot-after-deploy case.
    const reopened = new AnalyticsStore(db, { retentionDays: 90 });
    await reopened.ensureSchema();
    const viewers = await reopened.getViewers();
    reopened.stop();
    expect(viewers).toHaveLength(1);
    expect(viewers[0]).toMatchObject({ viewerId: 111, username: "juan", events: 2, country: "CR" });
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

  it("uses the same event ID for the immediate feed row and persisted snapshot", async () => {
    let liveEventId: string | null = null;
    const unsubscribe = store.subscribe((record) => {
      liveEventId = store.buildFeedEvent(record).eventId;
    });
    store.capture(pageview({ distinctId: "human", path: "/maps" }), { geoCountry: "CR" });
    unsubscribe();

    const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
    expect(liveEventId).toEqual(expect.any(String));
    expect(data.recentEvents[0]?.eventId).toBe(liveEventId);
  });

  it("issues and validates expiring live tickets", () => {
    const { ticket, expiresAt } = store.issueLiveTicket(NOW);
    expect(expiresAt).toBeGreaterThan(NOW);
    expect(store.consumeLiveTicket(ticket, NOW)).toBe(true);
    // Consuming must not burn the ticket: the admin EventSource reopens the stream with the
    // same one after a transient drop.
    expect(store.consumeLiveTicket(ticket, NOW + 60_000)).toBe(true);
    expect(store.consumeLiveTicket(ticket, expiresAt + 1)).toBe(false);
    expect(store.consumeLiveTicket("nope", NOW)).toBe(false);
    expect(store.consumeLiveTicket(null, NOW)).toBe(false);
  });
});
