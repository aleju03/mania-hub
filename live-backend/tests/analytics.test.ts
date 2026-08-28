import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, type Db } from "../src/db.js";
import { AnalyticsStore, computeMonitorSnapshot, deviceKindFor, monitorCacheTtlMs, normalizeAnalyticsEvent, type MonitorComputeOptions } from "../src/features/analytics.js";

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

  it("counts skin page opens and download clicks per visitor per 6h for the view-count seed", async () => {
    // Rows go in directly rather than through capture(): the bucketing is the
    // thing under test, so the timestamps have to sit at known offsets from a
    // bucket boundary instead of wherever the wall clock happens to be.
    const BUCKET_MS = 6 * 60 * 60_000;
    const bucketStart = Math.floor(NOW / BUCKET_MS) * BUCKET_MS;
    const row = async (opts: {
      distinctId: string;
      ref: string | null;
      ts: number;
      event?: string;
      path?: string;
      isBot?: boolean;
    }) => {
      await exec(
        db,
        "insert into analytics_events (ts, event, distinct_id, host, path, is_bot, props) values (?, ?, ?, ?, ?, ?, ?)",
        [
          opts.ts,
          opts.event ?? "$pageview",
          opts.distinctId,
          LIVE_HOST,
          opts.path ?? `/skins/${opts.ref}`,
          opts.isBot ? 1 : 0,
          JSON.stringify(opts.ref ? { skin_ref: opts.ref } : {}),
        ],
      );
    };

    // Same visitor twice inside one bucket is one view; the same visitor in
    // the next bucket is a second. Another visitor always counts.
    await row({ distinctId: "a", ref: "cool-skin", ts: bucketStart + 1_000 });
    await row({ distinctId: "a", ref: "cool-skin", ts: bucketStart + BUCKET_MS - 1_000 });
    await row({ distinctId: "a", ref: "cool-skin", ts: bucketStart + BUCKET_MS + 1_000 });
    await row({ distinctId: "b", ref: "cool-skin", ts: bucketStart + 1_000 });
    await row({ distinctId: "b", ref: "other-skin", ts: bucketStart + 1_000 });
    // A download is a view under the live counter's meaning, wherever it was
    // clicked - the grid's own button most of all, whose downloads never
    // opened a page. A visitor who read the page and downloaded in the same
    // bucket still counts once: b's download below adds nothing.
    await row({ distinctId: "c", ref: "cool-skin", ts: bucketStart + 1_000, event: "skin_download", path: "/skins" });
    await row({ distinctId: "b", ref: "cool-skin", ts: bucketStart + 2_000, event: "skin_download" });
    // Excluded: a bot, the server's own events, and the browse page's own
    // pageview, which names no skin.
    await row({ distinctId: "bot", ref: "cool-skin", ts: bucketStart + 1_000, isBot: true });
    await row({ distinctId: "server", ref: "cool-skin", ts: bucketStart + 1_000 });
    await row({ distinctId: "d", ref: null, ts: bucketStart + 1_000, path: "/skins" });

    const counts = await store.getSkinViewCounts();
    expect(counts.get("cool-skin")).toBe(4);
    expect(counts.get("other-skin")).toBe(1);
    expect(counts.size).toBe(2);
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

  it("narrows the roster to one country, and says which countries there are", async () => {
    const signedIn = (username: string, viewerId: number, minutesAgo: number, country?: string) =>
      pageview({ distinctId: `d${viewerId}`, minutesAgo, properties: { viewer_username: username, viewer_id: viewerId, ...(country ? { $geoip_country_code: country } : {}) } });

    store.capture(signedIn("juan", 111, 60, "cr"), {});
    store.capture(signedIn("kanaria", 222, 30, "jp"), {});
    store.capture(signedIn("ranshii", 333, 10, "cr"), {});
    // Nobody knows where this one browses from; it belongs to no country's list.
    store.capture(signedIn("nowhere", 444, 5), {});
    await store.flush();

    const costaRica = await store.getViewers(500, "CR");
    expect(costaRica.map((v) => v.username)).toEqual(["ranshii", "juan"]);
    expect(await store.countViewers("CR")).toBe(2);
    expect(await store.countViewers()).toBe(4);
    // The filter narrows in SQL, so the page limit is a limit on the matches.
    expect((await store.getViewers(1, "CR")).map((v) => v.username)).toEqual(["ranshii"]);
    expect(await store.getViewerCountries()).toEqual([{ country: "CR", count: 2 }, { country: "JP", count: 1 }]);
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

  it("answers one signed-in player's own trail, newest first", async () => {
    const visit = (viewerId: number, path: string, minutesAgo: number, event?: string) =>
      pageview({ distinctId: `d${viewerId}`, path, minutesAgo, event, properties: { viewer_username: `p${viewerId}`, viewer_id: viewerId } });

    store.capture(visit(111, "/tracker", 60), {});
    store.capture(visit(111, "/replay", 10, "replay_view"), {});
    // Their own admin browsing, another player, an anonymous visitor and a bot
    // all stay out of this player's trail.
    store.capture(visit(111, "/admin/live-backend", 5), {});
    store.capture(visit(222, "/maps", 2), {});
    store.capture(pageview({ distinctId: "anon", path: "/maps", minutesAgo: 3 }), {});
    store.capture(visit(111, "/skins", 1), { isBot: true });
    await store.flush();

    const events = await store.getViewerEvents(111);
    expect(events.map((row) => row.event)).toEqual(["replay_view", "$pageview"]);
    expect(events.map((row) => row.path)).toEqual(["/replay", "/tracker"]);
    expect(events[0]!.ts).toBeGreaterThan(events[1]!.ts);
    expect(await store.getViewerEvents(111, 1)).toHaveLength(1);
    // The roster outlives the events behind it, so an unknown player is empty
    // rather than an error.
    expect(await store.getViewerEvents(999)).toEqual([]);
  });

  it("lists every event name it has recorded, most frequent first", async () => {
    store.capture(pageview({ minutesAgo: 30 }), {});
    store.capture(pageview({ minutesAgo: 20 }), {});
    store.capture(pageview({ minutesAgo: 10, event: "changelog_open" }), {});
    await store.flush();

    const catalog = await store.getEventCatalog();
    expect(catalog.map((entry) => entry.event)).toEqual(["$pageview", "changelog_open"]);
    expect(catalog[0]).toMatchObject({ count: 2 });
    expect(catalog[1]!.lastTs).toBeGreaterThan(catalog[0]!.lastTs);
  });

  it("answers who fired one event, one row per person, newest first", async () => {
    const fired = (options: { distinctId: string; minutesAgo: number; viewerId?: number; username?: string; country?: string; path?: string }) =>
      pageview({
        event: "changelog_open",
        distinctId: options.distinctId,
        minutesAgo: options.minutesAgo,
        path: options.path ?? "/",
        properties: {
          ...(options.viewerId ? { viewer_id: options.viewerId, viewer_username: options.username } : {}),
          ...(options.country ? { $geoip_country_code: options.country } : {}),
        },
      });

    // One signed-in player on two devices is one person; a signed-out visitor
    // is only ever their device.
    store.capture(fired({ distinctId: "phone", viewerId: 111, username: "juan", minutesAgo: 40, country: "cr" }), {});
    store.capture(fired({ distinctId: "desktop", viewerId: 111, username: "juan", minutesAgo: 5, country: "cr" }), {});
    store.capture(fired({ distinctId: "anon", minutesAgo: 20 }), {});
    // Another event, a bot, and admin browsing all stay out of this lookup.
    store.capture(pageview({ distinctId: "anon", minutesAgo: 1 }), {});
    store.capture(fired({ distinctId: "crawler", minutesAgo: 2 }), { isBot: true });
    store.capture(fired({ distinctId: "desktop", viewerId: 111, username: "juan", minutesAgo: 1, path: "/admin/live-backend" }), {});
    await store.flush();

    const people = await store.getEventActors("changelog_open");
    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({ viewerId: 111, username: "juan", count: 2, country: "CR" });
    expect(people[1]).toMatchObject({ viewerId: null, distinctId: "anon", count: 1 });
    expect(people[0]!.lastTs).toBeGreaterThan(people[1]!.lastTs);

    // The same window unrolled, in the feed's row shape.
    const occurrences = await store.getEventOccurrences("changelog_open");
    expect(occurrences.map((row) => row.distinctId)).toEqual(["desktop", "anon", "phone"]);
    expect(occurrences.every((row) => row.event === "changelog_open")).toBe(true);

    // A cutoff narrows both readings, and an event nobody fired is empty.
    expect(await store.getEventActors("changelog_open", { sinceTs: NOW - 10 * 60_000 })).toHaveLength(1);
    expect(await store.getEventOccurrences("changelog_open", { sinceTs: NOW - 10 * 60_000 })).toHaveLength(1);
    expect(await store.getEventActors("never_fired")).toEqual([]);
    expect(await store.getEventOccurrences("  ")).toEqual([]);
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

  /* One crawl of the site on 2026-08-01 arrived as eight "visitors": a client
     that keeps no storage mints a fresh id on every page load, and the board
     groups strictly by that id. The proxy's client key exists to recognise
     those loads as one client - and, just as importantly, to leave every other
     visitor exactly where they were.

     Paths avoid "/" throughout: the recent feed drops home-page views on
     purpose, so a crawl of the home page would prove nothing here. */
  describe("visitor stitching", () => {
    const CRAWLER_KEY = "abc123def456";

    async function feedIds(): Promise<string[]> {
      const data = await store.getMonitorData({ rangeHours: 24, now: NOW });
      return data.recentEvents.map((row) => row.distinctId);
    }

    it("folds a storage-less client's page loads into one visitor", async () => {
      for (const [index, path] of ["/packs", "/skins", "/rankings", "/terms"].entries()) {
        store.capture(pageview({ distinctId: `fresh-uuid-${index}`, path }), { clientKey: CRAWLER_KEY });
      }
      const ids = await feedIds();
      expect(ids).toHaveLength(4);
      expect(new Set(ids)).toEqual(new Set(["fresh-uuid-0"]));
    });

    it("never reassigns an id that has been seen before", async () => {
      // Two people behind one address: the second is new to us, so it stitches
      // - but once each has a history, neither is ever moved again.
      store.capture(pageview({ distinctId: "known-visitor", path: "/maps" }), { clientKey: CRAWLER_KEY });
      store.capture(pageview({ distinctId: "known-visitor", path: "/skins" }), { clientKey: CRAWLER_KEY });
      store.capture(pageview({ distinctId: "other-visitor", path: "/packs" }), { clientKey: "different-key" });
      store.capture(pageview({ distinctId: "other-visitor", path: "/rankings" }), { clientKey: CRAWLER_KEY });
      expect(new Set(await feedIds())).toEqual(new Set(["known-visitor", "other-visitor"]));
    });

    it("leaves signed-in visitors alone and never lets a bot claim the key", async () => {
      store.capture(pageview({ distinctId: "guest-first", path: "/maps" }), { clientKey: CRAWLER_KEY });
      store.capture(
        pageview({ distinctId: "signed-in-id", path: "/my-stats", properties: { viewer_username: "Mxethical" } }),
        { clientKey: CRAWLER_KEY },
      );
      store.capture(pageview({ distinctId: "bot-id", path: "/terms" }), { clientKey: CRAWLER_KEY, isBot: true });
      const ids = await feedIds();
      // The signed-in visitor keeps their own id; the bot never reaches the feed.
      expect(new Set(ids)).toEqual(new Set(["guest-first", "signed-in-id"]));
    });

    it("does nothing at all without a client key", async () => {
      store.capture(pageview({ distinctId: "no-key-1", path: "/maps" }), {});
      store.capture(pageview({ distinctId: "no-key-2", path: "/skins" }), {});
      expect(new Set(await feedIds())).toEqual(new Set(["no-key-1", "no-key-2"]));
    });
  });

  describe("hourly rollups", () => {
    const HOUR = 60 * 60_000;
    const options: MonitorComputeOptions = { feedHosts: null, feedExcludedViewer: null, displayTimeZone: "America/Costa_Rica" };

    const insertEvent = async (opts: {
      ts: number;
      event?: string;
      distinctId?: string;
      path?: string | null;
      country?: string | null;
      referringDomain?: string | null;
      isBot?: boolean;
      props?: Record<string, unknown>;
    }) => {
      await exec(db, `insert into analytics_events
        (ts, event, distinct_id, host, path, country, selected_country, viewer_username, referring_domain, screen_width, viewport_width, is_bot, props)
        values (?, ?, ?, ?, ?, ?, null, null, ?, 1920, 1920, ?, ?)`, [
        opts.ts,
        opts.event ?? "$pageview",
        opts.distinctId ?? "v1",
        LIVE_HOST,
        opts.path === undefined ? "/tracker" : opts.path,
        opts.country ?? null,
        opts.referringDomain ?? null,
        opts.isBot ? 1 : 0,
        JSON.stringify(opts.props ?? {}),
      ]);
    };

    /* Traffic on both sides of the rolled-up boundary (25h back), including a
       visitor that spans it, so every distinct count has to dedupe across it. */
    const seedAcrossBoundary = async () => {
      const OLD = NOW - 30 * HOUR;
      const RECENT = NOW - 2 * HOUR;
      await insertEvent({ ts: OLD, distinctId: "both", path: "/", country: "CR" });
      await insertEvent({ ts: OLD + 5 * 60_000, distinctId: "both", path: "/tracker", country: "CR", referringDomain: "osu.ppy.sh" });
      await insertEvent({ ts: OLD + 6 * 60_000, distinctId: "both", path: "/admin/live-backend" });
      await insertEvent({ ts: OLD + 10 * 60_000, distinctId: "old-only", path: "/", country: "DE" });
      await insertEvent({ ts: OLD + 15 * 60_000, distinctId: "old-profile", path: "/player/alice", country: "US", props: { profile_username: "Alice" } });
      await insertEvent({ ts: OLD + 20 * 60_000, distinctId: "old-only", event: "replay_view", path: "/replay", country: "DE", props: { replay_score_id: "111", replay_title: "Song", replay_player: "Alice" } });
      await insertEvent({ ts: OLD + 25 * 60_000, distinctId: "server", event: "page_shared", path: null, props: { crawler: "twitter", pathname: "/replay/1", subject: "Song", subject_type: "replay" } });
      await insertEvent({ ts: OLD + 30 * 60_000, distinctId: "bot", isBot: true });
      // Lands in one rolled hour, browses on in another: the bounce merge must
      // sum landings across the visitor's hour rows, not read one of them.
      await insertEvent({ ts: OLD - 3 * HOUR, distinctId: "multi-hour", path: "/", country: "FR" });
      await insertEvent({ ts: OLD - 2 * HOUR, distinctId: "multi-hour", path: "/skins", country: "FR" });
      // Geo flips inside one rolled hour: the country projection must keep the
      // visitor in both countries, the way the raw query counts them.
      await insertEvent({ ts: OLD + 40 * 60_000, distinctId: "geo-flip", path: "/tracker", country: "CN" });
      await insertEvent({ ts: OLD + 45 * 60_000, distinctId: "geo-flip", path: "/rankings", country: "HK" });
      await insertEvent({ ts: RECENT, distinctId: "both", path: "/maps", country: "CR" });
      await insertEvent({ ts: RECENT + 30_000, distinctId: "multi-hour", path: "/rankings", country: "FR" });
      await insertEvent({ ts: RECENT + 60_000, distinctId: "new-only", path: "/", country: "CR", referringDomain: "osu.ppy.sh" });
      await insertEvent({ ts: RECENT + 2 * 60_000, distinctId: "server", event: "osu_api_error", path: null, props: { caller: "rankings", path: "/x", status: 500 } });
    };

    it("advances the rolled-up boundary and answers long ranges from the rollups", async () => {
      await seedAcrossBoundary();
      await store.advanceRollups(NOW);

      const bound = Number((await exec(db, "select value from analytics_rollup_state where key = 'rolled_until'")).rows[0]?.value);
      expect(bound).toBe(Math.floor((NOW - 25 * HOUR) / HOUR) * HOUR);
      const rolledHours = Number((await exec(db, "select count(*) as n from analytics_hourly_totals")).rows[0]?.n);
      expect(rolledHours).toBeGreaterThan(0);

      const raw = await computeMonitorSnapshot(db, options, { rangeHours: 720, now: NOW, rollupBound: null });
      const hybrid = await computeMonitorSnapshot(db, options, { rangeHours: 720, now: NOW });

      expect(hybrid.eventsInRange).toBe(raw.eventsInRange);
      expect(hybrid.pageviewsInRange).toBe(raw.pageviewsInRange);
      expect(hybrid.uniqueVisitorsInRange).toBe(raw.uniqueVisitorsInRange);
      expect(hybrid.uniqueVisitorsInRange).toBe(6);
      expect(hybrid.shareEvents).toBe(raw.shareEvents);
      expect(hybrid.bounce).toEqual(raw.bounce);
      // "both" landed on the old side and browsed on again the new side, so
      // only the two single-page visitors bounce; the grouping crossed the seam.
      expect(hybrid.bounce).toEqual({ bounced: 2, landers: 4 });
      expect(hybrid.topRoutes).toEqual(raw.topRoutes);
      expect(hybrid.topPhysicalCountries).toEqual(raw.topPhysicalCountries);
      expect(hybrid.topPhysicalCountries).toEqual(expect.arrayContaining([
        { country: "CN", count: 1 },
        { country: "HK", count: 1 },
      ]));
      expect(hybrid.topProfiles).toEqual(raw.topProfiles);
      expect(hybrid.topReplays).toEqual(raw.topReplays);
      expect(hybrid.topReferrers).toEqual(raw.topReferrers);
      expect(hybrid.topReferrers).toEqual([{ domain: "osu.ppy.sh", count: 2 }]);
      expect(hybrid.sharesByPlatform).toEqual(raw.sharesByPlatform);
      expect(hybrid.topSharedPages).toEqual(raw.topSharedPages);
      expect(hybrid.serverErrors).toEqual(raw.serverErrors);
      const timelineTotal = (timeline: Array<{ events: number; visitors: number }>) => timeline.reduce((sum, bucket) => sum + bucket.events, 0);
      expect(timelineTotal(hybrid.timeline)).toBe(timelineTotal(raw.timeline));
    });

    it("really reads the rolled side from the rollups, and re-rolling replaces instead of double counting", async () => {
      await seedAcrossBoundary();
      await store.advanceRollups(NOW);
      const before = await computeMonitorSnapshot(db, options, { rangeHours: 720, now: NOW });

      // Re-rolling the populated hours must be a replace, not an accumulation:
      // rewind the boundary past every seeded rolled event (the oldest sits at
      // NOW - 33h) and advance again over real data.
      const bound = Number((await exec(db, "select value from analytics_rollup_state where key = 'rolled_until'")).rows[0]?.value);
      const rollupTables = ["analytics_hourly_totals", "analytics_hourly_visitors", "analytics_hourly_countries", "analytics_hourly_routes", "analytics_hourly_profiles", "analytics_hourly_replays", "analytics_hourly_referrers"];
      const tableCounts = async () => {
        const counts: Record<string, number> = {};
        for (const table of rollupTables) {
          counts[table] = Number((await exec(db, `select count(*) as n from ${table}`)).rows[0]?.n);
        }
        return counts;
      };
      const countsBefore = await tableCounts();
      expect(countsBefore.analytics_hourly_visitors).toBeGreaterThan(0);
      await exec(db, "update analytics_rollup_state set value = ? where key = 'rolled_until'", [String(Math.floor((NOW - 35 * HOUR) / HOUR) * HOUR)]);
      await store.advanceRollups(NOW);
      expect(Number((await exec(db, "select value from analytics_rollup_state where key = 'rolled_until'")).rows[0]?.value)).toBe(bound);
      expect(await tableCounts()).toEqual(countsBefore);
      const rerolled = await computeMonitorSnapshot(db, options, { rangeHours: 720, now: NOW });
      expect(rerolled.eventsInRange).toBe(before.eventsInRange);
      expect(rerolled.uniqueVisitorsInRange).toBe(before.uniqueVisitorsInRange);
      expect(rerolled.topPhysicalCountries).toEqual(before.topPhysicalCountries);
      expect(rerolled.bounce).toEqual(before.bounce);

      // Deleting the rolled raw rows changes nothing: the hybrid read was
      // never touching them. (Retention will really do this eventually.)
      await exec(db, "delete from analytics_events where ts < ?", [bound]);
      const after = await computeMonitorSnapshot(db, options, { rangeHours: 720, now: NOW });
      expect(after.eventsInRange).toBe(before.eventsInRange);
      expect(after.uniqueVisitorsInRange).toBe(before.uniqueVisitorsInRange);
      expect(after.bounce).toEqual(before.bounce);
      expect(after.topRoutes).toEqual(before.topRoutes);
      expect(after.topProfiles).toEqual(before.topProfiles);

      // The store path takes the same hybrid read inline.
      const viaStore = await store.getMonitorData({ rangeHours: 720, now: NOW });
      expect(viaStore.eventsInRange).toBe(before.eventsInRange);
    });

    it("short ranges ignore the rollups and prune drops expired rollup rows", async () => {
      await seedAcrossBoundary();
      await store.advanceRollups(NOW);
      // 24h stays a pure raw read: its window is entirely inside the tail.
      const day = await computeMonitorSnapshot(db, options, { rangeHours: 24, now: NOW });
      expect(day.uniqueVisitorsInRange).toBe(3);

      const staleHour = Math.floor((NOW - 91 * 24 * HOUR) / HOUR) * HOUR;
      await exec(db, "insert into analytics_hourly_totals (hour_ts, events_total, events, pageviews, shares) values (?, 5, 5, 5, 0)", [staleHour]);
      await store.prune(NOW);
      const left = Number((await exec(db, "select count(*) as n from analytics_hourly_totals where hour_ts = ?", [staleHour])).rows[0]?.n);
      expect(left).toBe(0);
    });
  });

  describe("monitor cache", () => {
    it("scales the TTL with the range and caps it", () => {
      expect(monitorCacheTtlMs(1)).toBe(4_000);
      expect(monitorCacheTtlMs(24)).toBe(4_000);
      expect(monitorCacheTtlMs(168)).toBe(15_120);
      expect(monitorCacheTtlMs(720)).toBe(60_000);
    });

    it("serves an expired entry stale while recomputing in the background", async () => {
      store.capture(pageview({ distinctId: "swr-1" }), {});
      const first = await store.getMonitorData({ rangeHours: 24 });
      expect(first.uniqueVisitorsInRange).toBe(1);

      store.capture(pageview({ distinctId: "swr-2" }), {});
      const cache = (store as unknown as { monitorCache: Map<string, { at: number }> }).monitorCache;
      for (const entry of cache.values()) entry.at -= 10 * 60_000;

      // The expired entry answers this poll instantly, byte-for-byte.
      const stale = await store.getMonitorData({ rangeHours: 24 });
      expect(stale).toBe(first);

      // The refresh it kicked off lands, and the next poll sees the new event.
      const inflight = (store as unknown as { monitorInFlight: Map<string, Promise<unknown>> }).monitorInFlight;
      await Promise.all([...inflight.values()]);
      const fresh = await store.getMonitorData({ rangeHours: 24 });
      expect(fresh).not.toBe(first);
      expect(fresh.uniqueVisitorsInRange).toBe(2);
    });
  });

});
