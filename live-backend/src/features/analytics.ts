import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { exec, execBatch, json, parseJson, type Db, type DbStatement } from "../db.js";
import { logInfo, logWarn, errorContext } from "../logger.js";

// In-house web analytics, the site's only analytics sink. The frontend capture
// proxy (/api/sync) forwards every tracked event here; rows land in a SEPARATE
// SQLite file (its own WAL) so analytics volume can never bloat the main
// serving DB, and every admin dashboard query is a local read against it.
// Commonly-filtered fields are extracted into real columns at ingest;
// everything else stays in the props JSON and is json_extract'ed at query time
// (the feed is LIMIT-bounded, so that's cheap).

const FLUSH_INTERVAL_MS = 1_000;
const MAX_BUFFERED_EVENTS = 5_000;
const MAX_PROPS_JSON_CHARS = 16 * 1024;
const MAX_EVENTS_PER_CAPTURE = 50;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const LIVE_TICKET_TTL_MS = 10 * 60_000;
const ACTIVE_VISITOR_WINDOW_MS = 5 * 60_000;
/* A wider read of the same thing: someone who opened a page ten minutes ago is
   still around in any useful sense, so the admin headline counts this window
   and keeps the 5m one beside it. The label in AnalyticsPulse names the number
   of minutes, so move both together. */
const RECENT_VISITOR_WINDOW_MS = 15 * 60_000;
/* Freshness floor for the monitor cache: just under the admin page's 5s poll,
   so a small range still refreshes once per cycle while concurrent tabs and
   the second frontend instance ride the same scan. The TTL then grows with the
   range, because a 30d aggregate over a multi-hundred-MB events file is
   seconds of scanning to answer and does not change meaningfully between two
   polls. Expired entries are served stale while one recompute runs in the
   background (getMonitorData), so an open tab never blocks on a rescan. */
const MONITOR_CACHE_TTL_MS = 4_000;
const MONITOR_CACHE_TTL_MAX_MS = 60_000;
const MONITOR_CACHE_TTL_PER_RANGE_HOUR_MS = 90;

export function monitorCacheTtlMs(rangeHours: number): number {
  return Math.min(MONITOR_CACHE_TTL_MAX_MS, Math.max(MONITOR_CACHE_TTL_MS, Math.round(rangeHours * MONITOR_CACHE_TTL_PER_RANGE_HOUR_MS)));
}

/* Ranges at and above this run the scan set in a worker thread: local libsql
   executes synchronously on the calling thread, so a multi-second scan on the
   serving loop stalls every request and SSE write in the process. Short ranges
   stay inline — their scans are milliseconds, cheaper than a thread spawn. */
const MONITOR_THREAD_MIN_RANGE_HOURS = 72;
const MONITOR_THREAD_TIMEOUT_MS = 60_000;
/* Ceiling on one read of the signed-in roster. Not a display limit: the pp and
   rank sorts have to see every viewer to name the best of them. */
export const MAX_VIEWER_ROWS = 20_000;
/* One player's trail is read on demand from an admin click, so this is only a
   ceiling on how much of it a single request can pull back. */
export const MAX_VIEWER_EVENT_ROWS = 300;
const TIMELINE_BUCKETS = 48;

// Query-side display defaults.
const DEFAULT_DISPLAY_TIME_ZONE = "America/Costa_Rica";
const DEFAULT_FEED_HOSTS = ["mania-tracker.com", "www.mania-tracker.com"];
const DEFAULT_FEED_EXCLUDED_VIEWER = "aleju03";

export interface AnalyticsStoreOptions {
  retentionDays?: number;
  /* Hosts whose events count as real live-site traffic in the recent feed;
     null disables the filter (useful outside production). */
  feedHosts?: string[] | null;
  /* The site owner's signed-in username, excluded from the recent feed. */
  feedExcludedViewer?: string | null;
  displayTimeZone?: string;
  /* file: URL of the analytics database, which lets large monitor scans run on
     a worker thread's own read connection. Absent (tests, dev) = always inline. */
  databaseUrl?: string | null;
}

export interface AnalyticsEventRecord {
  ts: number;
  event: string;
  distinctId: string;
  host: string | null;
  path: string | null;
  country: string | null;
  selectedCountry: string | null;
  viewerUsername: string | null;
  referringDomain: string | null;
  screenWidth: number | null;
  viewportWidth: number | null;
  isBot: boolean;
  properties: Record<string, unknown>;
}

export interface AnalyticsFeedEvent {
  eventId: string | null;
  timestamp: string;
  /* Epoch ms alongside the display label: the admin feed needs it to age rows
     ("12s ago"), stitch sessions, and keep live SSE rows ordered against a
     snapshot. */
  ts: number;
  event: string;
  path: string;
  country: string | null;
  selectedCountry: string | null;
  deviceKind: "mobile" | "desktop" | "unknown";
  distinctId: string;
  mapsTab: string | null;
  mapsQuery: string | null;
  mapsFilters: string | null;
  mapsSort: string | null;
  mapsCollection: string | null;
  mapsPage: string | null;
  mapsBeatmapId: string | null;
  rankingsPage: string | null;
  profileUsername: string | null;
  replayPlayer: string | null;
  replayScoreId: string | null;
  replayTitle: string | null;
  replayArtist: string | null;
  replayDifficulty: string | null;
  viewUrl: string | null;
  farmHelperUser: string | null;
  farmMapTitle: string | null;
  farmMapUser: string | null;
  packType: string | null;
  packUsername: string | null;
  skinsQuery: string | null;
  skinsKeys: string | null;
  skinsSort: string | null;
  skinsPage: string | null;
  skinRef: string | null;
  skinName: string | null;
  skinKeymodes: string | null;
  skinUploadError: string | null;
  communitiesQuery: string | null;
  communitiesCountry: string | null;
  communitiesLanguage: string | null;
  communitiesTag: string | null;
  communitiesSort: string | null;
  communitiesPage: string | null;
  communityId: string | null;
  communityName: string | null;
  viewerUsername: string | null;
  referrer: string | null;
}

export interface AnalyticsTimelineBucket {
  ts: number;
  events: number;
  pageviews: number;
  visitors: number;
}

export interface AnalyticsMonitorResponse {
  rangeHours: number;
  /* Width of one timeline bucket; the series is dense (empty buckets included)
     so the admin chart can render it without gap-filling. */
  bucketMs: number;
  timeline: AnalyticsTimelineBucket[];
  activeVisitors: number;
  recentVisitors: number;
  pageviewsInRange: number;
  uniqueVisitorsInRange: number;
  eventsInRange: number;
  bounce: { bounced: number; landers: number };
  topRoutes: Array<{ path: string; count: number }>;
  recentEvents: AnalyticsFeedEvent[];
  topPhysicalCountries: Array<{ country: string; count: number }>;
  topProfiles: Array<{ username: string; views: number; lastViewedLabel: string | null; lastVisitorCountry: string | null }>;
  topReplays: Array<{
    scoreId: string;
    title: string | null;
    artist: string | null;
    difficulty: string | null;
    player: string | null;
    coverUrl: string | null;
    views: number;
    lastViewedLabel: string | null;
    lastVisitorCountry: string | null;
  }>;
  topReferrers: Array<{ domain: string; count: number }>;
  shareEvents: number;
  sharesByPlatform: Array<{ platform: string; count: number }>;
  topSharedPages: Array<{ path: string; subject: string | null; subjectType: string | null; count: number }>;
  serverErrors: Array<{ caller: string; path: string; status: number | null; count: number }>;
  recentServerErrors: Array<{
    timestamp: string;
    caller: string;
    path: string;
    status: number | null;
    bodyPreview: string | null;
    attempts: number | null;
    kind: string | null;
    context: string | null;
    ratePerMin: number | null;
    rateRemaining: number | null;
    rateLimit: number | null;
    retryAfter: string | null;
  }>;
}

export interface AnalyticsViewerRow {
  viewerId: number;
  username: string;
  firstSeen: number;
  lastSeen: number;
  events: number;
  country: string | null;
}

export interface AnalyticsValleyResponse {
  activeVisitors: number;
  recent: Array<{
    timestamp: string;
    path: string | null;
    country: string | null;
    distinctId: string;
    profileUsername: string | null;
  }>;
}

function asTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function asFiniteNumber(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}

function normalizeCountryCode(value: unknown): string | null {
  const country = asTrimmedString(value, 2)?.toUpperCase() ?? null;
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}

/* One capture payload ({event, distinct_id, timestamp, properties}) into a
   typed record. Returns null for garbage. */
export function normalizeAnalyticsEvent(
  payload: unknown,
  meta: { geoCountry?: string | null; isBot?: boolean; now?: number },
): AnalyticsEventRecord | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const event = asTrimmedString(raw.event, 120);
  if (!event) return null;
  const properties = raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties)
    ? { ...(raw.properties as Record<string, unknown>) }
    : {};
  delete properties.distinct_id;
  properties.$insert_id = asTrimmedString(properties.$insert_id, 64) ?? randomUUID();
  const distinctId = asTrimmedString(raw.distinct_id, 64)
    ?? asTrimmedString((raw.properties as Record<string, unknown> | undefined)?.distinct_id, 64)
    ?? "unknown";
  const now = meta.now ?? Date.now();
  const parsedTs = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
  // Clamp to a sane window: client clocks drift, and a far-future timestamp
  // would pin the "recent" feed forever.
  const ts = Number.isFinite(parsedTs) ? Math.min(Math.max(parsedTs, now - 24 * 60 * 60_000), now + 60_000) : now;
  return {
    ts,
    event,
    distinctId,
    host: asTrimmedString(properties.$host, 120)?.toLowerCase() ?? null,
    path: asTrimmedString(properties.$pathname, 300),
    country: normalizeCountryCode(meta.geoCountry) ?? normalizeCountryCode(properties.$geoip_country_code),
    selectedCountry: asTrimmedString(properties.selected_country, 8),
    viewerUsername: asTrimmedString(properties.viewer_username, 40),
    referringDomain: asTrimmedString(properties.$referring_domain, 160)?.toLowerCase() ?? null,
    screenWidth: asFiniteNumber(properties.$screen_width),
    viewportWidth: asFiniteNumber(properties.$viewport_width),
    isBot: meta.isBot === true,
    properties,
  };
}

function propsJsonFor(record: AnalyticsEventRecord): string {
  const serialized = json(record.properties);
  if (serialized.length <= MAX_PROPS_JSON_CHARS) return serialized;
  // Oversized property bags lose everything but the columns already extracted;
  // better a lean row than an unbounded blob in the events table.
  return json({ _truncated: true, $insert_id: record.properties.$insert_id });
}

/* How long a client key can still claim a visitor id it established. Long
   enough to cover a crawl or a browsing session of full page loads, short
   enough that an address handed to someone else starts fresh. */
export const CLIENT_STITCH_WINDOW_MS = 30 * 60_000;
// Both maps are pruned by age, but a burst could still grow them between
// prunes; these are the hard ceilings.
const MAX_STITCH_ENTRIES = 5_000;

export class AnalyticsStore {
  private readonly db: Db;
  private readonly options: Required<AnalyticsStoreOptions>;
  private buffer: AnalyticsEventRecord[] = [];
  private dropped = 0;
  /* Visitor stitching, in memory and nowhere else: client key -> the visitor
     id it first arrived with, and every visitor id seen recently. Nothing here
     is written to the store; the key exists only to answer "is this a new
     visitor, or the same one that lost its storage again?". */
  private readonly visitorByClientKey = new Map<string, { distinctId: string; ts: number }>();
  private readonly recentVisitorIds = new Map<string, number>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: AnalyticsEventRecord) => void>();
  private readonly liveTickets = new Map<string, number>();
  private readonly monitorCache = new Map<string, { at: number; data: AnalyticsMonitorResponse }>();
  private readonly monitorInFlight = new Map<string, Promise<AnalyticsMonitorResponse>>();

  constructor(db: Db, options: AnalyticsStoreOptions = {}) {
    this.db = db;
    this.options = {
      retentionDays: options.retentionDays ?? 90,
      feedHosts: options.feedHosts === undefined ? DEFAULT_FEED_HOSTS : options.feedHosts,
      feedExcludedViewer: options.feedExcludedViewer === undefined ? DEFAULT_FEED_EXCLUDED_VIEWER : options.feedExcludedViewer,
      displayTimeZone: options.displayTimeZone ?? DEFAULT_DISPLAY_TIME_ZONE,
      databaseUrl: options.databaseUrl ?? null,
    };
  }

  async ensureSchema(): Promise<void> {
    await exec(this.db, `
      create table if not exists analytics_events (
        id integer primary key autoincrement,
        ts integer not null,
        event text not null,
        distinct_id text not null,
        host text,
        path text,
        country text,
        selected_country text,
        viewer_username text,
        referring_domain text,
        screen_width integer,
        viewport_width integer,
        is_bot integer not null default 0,
        props text not null default '{}'
      )
    `);
    await exec(this.db, "create index if not exists idx_analytics_events_ts on analytics_events(ts desc)");
    await exec(this.db, "create index if not exists idx_analytics_events_event_ts on analytics_events(event, ts desc)");
    // One signed-in player's trail (see getViewerEvents). Partial, because most
    // events belong to signed-out visitors and indexing their null viewer_id
    // would double the index for nothing; the query repeats the `is not null`
    // so SQLite is allowed to use it.
    await exec(this.db, `
      create index if not exists idx_analytics_events_viewer
      on analytics_events(cast(json_extract(props, '$.viewer_id') as integer), ts desc)
      where json_extract(props, '$.viewer_id') is not null
    `);

    // Durable roster of every osu! account that has browsed while signed in.
    // Kept as its own projection because analytics_events is pruned at
    // ANALYTICS_RETENTION_DAYS, and "who has ever signed in" must outlive that.
    await exec(this.db, `
      create table if not exists analytics_viewers (
        viewer_id integer primary key,
        username text not null,
        first_seen integer not null,
        last_seen integer not null,
        events integer not null default 0,
        last_country text
      )
    `);
    await exec(this.db, "create index if not exists idx_analytics_viewers_last_seen on analytics_viewers(last_seen desc)");
    await this.backfillViewers();
  }

  /* One-shot seed so the roster isn't empty on the first boot after deploy:
     everything still inside the events retention window gets folded in. */
  private async backfillViewers(): Promise<void> {
    const existing = (await exec(this.db, "select count(*) as n from analytics_viewers")).rows[0];
    if (Number(existing?.n ?? 0) > 0) return;
    // The `latest` side uses a single max(ts), so SQLite's bare-column rule
    // makes username/country come from that newest row.
    const result = await exec(this.db, `
      insert into analytics_viewers (viewer_id, username, first_seen, last_seen, events, last_country)
      select agg.vid, latest.viewer_username, agg.first_seen, agg.last_seen, agg.events, latest.country
      from (
        select cast(json_extract(props, '$.viewer_id') as integer) as vid,
               min(ts) as first_seen, max(ts) as last_seen, count(*) as events
        from analytics_events
        where is_bot = 0 and viewer_username is not null and json_extract(props, '$.viewer_id') is not null
        group by vid
      ) agg
      join (
        select cast(json_extract(props, '$.viewer_id') as integer) as vid,
               max(ts) as t, viewer_username, country
        from analytics_events
        where is_bot = 0 and viewer_username is not null and json_extract(props, '$.viewer_id') is not null
        group by vid
      ) latest on latest.vid = agg.vid
    `);
    const seeded = result.rowsAffected ?? 0;
    if (seeded > 0) logInfo("analytics_viewers_backfilled", { viewers: seeded });
  }

  start(): void {
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => {
        void this.prune().catch((error) => logWarn("analytics_prune_failed", errorContext(error)));
      }, PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flushTimer = null;
    this.pruneTimer = null;
  }

  /* Accepts one capture body from the proxy: either a single payload or
     {batch: [...]}. Returns how many events were accepted. */
  capture(body: unknown, meta: { geoCountry?: string | null; isBot?: boolean; clientKey?: string | null } = {}): number {
    const payloads = Array.isArray((body as { batch?: unknown })?.batch)
      ? ((body as { batch: unknown[] }).batch).slice(0, MAX_EVENTS_PER_CAPTURE)
      : [body];
    let accepted = 0;
    for (const payload of payloads) {
      const record = normalizeAnalyticsEvent(payload, meta);
      if (!record) continue;
      this.stitchVisitor(record, meta.clientKey ?? null);
      if (this.buffer.length >= MAX_BUFFERED_EVENTS) {
        this.dropped += 1;
        continue;
      }
      this.buffer.push(record);
      accepted += 1;
      for (const listener of this.listeners) {
        try {
          listener(record);
        } catch {
          // A broken SSE listener must never break capture.
        }
      }
    }
    return accepted;
  }

  /* Gives an event the visitor id its client already established, when the id
     it arrived with is one nobody has ever seen.

     That last condition is what keeps this honest. A returning visitor carries
     an id we know, so it is never reassigned - two people behind one address
     stay two visitors for as long as either has been here before. Only an id
     with no history at all can be stitched, which is precisely the client that
     threw its storage away between page loads, and precisely the case where we
     had no information to lose. Signed-in events are left alone entirely:
     they are already identified by a username.

     Failure here must never cost an event, so it only ever rewrites a field. */
  private stitchVisitor(record: AnalyticsEventRecord, clientKey: string | null): void {
    const now = Date.now();
    this.pruneStitchMaps(now);
    const alreadyKnown = this.recentVisitorIds.has(record.distinctId);
    this.recentVisitorIds.set(record.distinctId, now);
    if (!clientKey || record.isBot || record.viewerUsername || record.distinctId === "server") return;

    const established = this.visitorByClientKey.get(clientKey);
    if (established && !alreadyKnown && established.distinctId !== record.distinctId) {
      // The id it arrived with is kept on the event, so a visitor that was
      // stitched can always be taken back apart if one of these looks wrong.
      record.properties.$stitched_from = record.distinctId;
      record.distinctId = established.distinctId;
    }
    this.visitorByClientKey.set(clientKey, { distinctId: record.distinctId, ts: now });
    this.recentVisitorIds.set(record.distinctId, now);
  }

  private pruneStitchMaps(now: number): void {
    const cutoff = now - CLIENT_STITCH_WINDOW_MS;
    if (this.visitorByClientKey.size > MAX_STITCH_ENTRIES) this.visitorByClientKey.clear();
    if (this.recentVisitorIds.size > MAX_STITCH_ENTRIES) this.recentVisitorIds.clear();
    for (const [key, entry] of this.visitorByClientKey) {
      if (entry.ts < cutoff) this.visitorByClientKey.delete(key);
    }
    for (const [id, ts] of this.recentVisitorIds) {
      if (ts < cutoff) this.recentVisitorIds.delete(id);
    }
  }

  subscribe(listener: (event: AnalyticsEventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* Short-lived tickets let the admin browser open the live SSE stream
     without ever holding the admin token itself. */
  issueLiveTicket(now = Date.now()): { ticket: string; expiresAt: number } {
    for (const [ticket, expiresAt] of this.liveTickets) {
      if (expiresAt <= now) this.liveTickets.delete(ticket);
    }
    const ticket = randomUUID();
    const expiresAt = now + LIVE_TICKET_TTL_MS;
    this.liveTickets.set(ticket, expiresAt);
    return { ticket, expiresAt };
  }

  consumeLiveTicket(ticket: string | null, now = Date.now()): boolean {
    if (!ticket) return false;
    const expiresAt = this.liveTickets.get(ticket);
    return expiresAt != null && expiresAt > now;
  }

  async flush(): Promise<void> {
    // Serialize flushes so two timers can't interleave inserts.
    this.flushing = this.flushing.then(() => this.flushNow());
    await this.flushing;
  }

  private async flushNow(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    if (this.dropped > 0) {
      logWarn("analytics_events_dropped", { dropped: this.dropped });
      this.dropped = 0;
    }
    const statements: DbStatement[] = batch.map((record) => ({
      sql: `insert into analytics_events
        (ts, event, distinct_id, host, path, country, selected_country, viewer_username, referring_domain, screen_width, viewport_width, is_bot, props)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.ts,
        record.event,
        record.distinctId,
        record.host,
        record.path,
        record.country,
        record.selectedCountry,
        record.viewerUsername,
        record.referringDomain,
        record.screenWidth,
        record.viewportWidth,
        record.isBot ? 1 : 0,
        propsJsonFor(record),
      ],
    }));
    statements.push(...viewerUpsertStatements(batch));
    try {
      await execBatch(this.db, statements);
    } catch (error) {
      logWarn("analytics_flush_failed", { events: batch.length, ...errorContext(error) });
    }
  }

  /* Every osu! account that has browsed while signed in, newest activity
     first. Survives event pruning, so this really is "who has signed in".

     The cap is generous because sorting the roster by pp or rank happens after
     the pp figures are read out of the other database, so that path has to ask
     for the whole roster rather than the newest page of it. Rows are small and
     this is an admin-only read.

     A country narrows the read in SQL rather than after it, so asking for one
     country reaches players far older than the cut a full-roster page ends at. */
  async getViewers(limit = 500, country: string | null = null): Promise<AnalyticsViewerRow[]> {
    await this.flush();
    const capped = Math.min(MAX_VIEWER_ROWS, Math.max(1, Math.round(limit)));
    const rows = (await exec(this.db, `
      select viewer_id, username, first_seen, last_seen, events, last_country
      from analytics_viewers ${country ? "where last_country = ?" : ""}
      order by last_seen desc limit ?
    `, country ? [country, capped] : [capped])).rows;
    return rows.map((row) => ({
      viewerId: Number(row.viewer_id),
      username: String(row.username ?? ""),
      firstSeen: Number(row.first_seen),
      lastSeen: Number(row.last_seen),
      events: Number(row.events ?? 0),
      country: row.last_country == null ? null : String(row.last_country),
    }));
  }

  async countViewers(country: string | null = null): Promise<number> {
    const row = (await exec(
      this.db,
      `select count(*) as n from analytics_viewers ${country ? "where last_country = ?" : ""}`,
      country ? [country] : [],
    )).rows[0];
    return Number(row?.n ?? 0);
  }

  /* Which countries the roster has players in, biggest first. Counted over the
     whole table rather than the page in hand, so a country whose players last
     visited months ago is still offered as a filter. */
  async getViewerCountries(): Promise<Array<{ country: string; count: number }>> {
    await this.flush();
    const rows = (await exec(this.db, `
      select last_country as country, count(*) as n from analytics_viewers
      where last_country is not null and last_country <> ''
      group by last_country order by n desc, last_country asc
    `)).rows;
    return rows.map((row) => ({ country: String(row.country), count: Number(row.n ?? 0) }));
  }

  /* What one signed-in player has been doing, newest first. Narrower than the
     feed's rules on purpose: this is asked for by name, so the only things
     dropped are bots and the player's own admin browsing. The roster is durable
     and events are not, so a long-dormant account can legitimately answer with
     nothing - that is retention, not an error. */
  async getViewerEvents(viewerId: number, limit = MAX_VIEWER_EVENT_ROWS): Promise<AnalyticsFeedEvent[]> {
    if (!Number.isFinite(viewerId)) return [];
    await this.flush();
    const capped = Math.min(MAX_VIEWER_EVENT_ROWS, Math.max(1, Math.round(limit)));
    const rows = (await exec(this.db, `
      select ts, event, path, country, selected_country, distinct_id, screen_width, viewport_width, viewer_username, referring_domain, props
      from analytics_events
      where json_extract(props, '$.viewer_id') is not null
        and cast(json_extract(props, '$.viewer_id') as integer) = ?
        and is_bot = 0
        and (path is null or path not like '/admin/%')
      order by ts desc limit ?
    `, [Math.round(viewerId), capped])).rows;
    return rows.map((row) => this.buildFeedEvent({
      ts: Number(row.ts),
      event: String(row.event ?? ""),
      distinctId: String(row.distinct_id ?? ""),
      host: null,
      path: row.path == null ? null : String(row.path),
      country: row.country == null ? null : String(row.country),
      selectedCountry: row.selected_country == null ? null : String(row.selected_country),
      viewerUsername: row.viewer_username == null ? null : String(row.viewer_username),
      referringDomain: row.referring_domain == null ? null : String(row.referring_domain),
      screenWidth: row.screen_width == null ? null : Number(row.screen_width),
      viewportWidth: row.viewport_width == null ? null : Number(row.viewport_width),
      isBot: false,
      properties: parseJson<Record<string, unknown>>(row.props, {}),
    }));
  }

  /* Usernames for a handful of osu! ids, for callers in the other database who
     have an id and no name. The viewer roster is the widest name source the
     backend has — every account that has signed in and browsed, not just the
     tracked-country rosters — and it costs no osu! API call to ask.

     Chunked because this goes into an `in (...)` list, and the answer is a map
     rather than rows because the caller is matching ids it already holds. Ids it
     has never seen simply stay absent. */
  async getViewerNames(ids: number[]): Promise<Map<number, string>> {
    const wanted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    const names = new Map<number, string>();
    if (wanted.length === 0) return names;
    await this.flush();
    for (let start = 0; start < wanted.length; start += 200) {
      const chunk = wanted.slice(start, start + 200);
      const rows = (await exec(
        this.db,
        `select viewer_id, username from analytics_viewers where viewer_id in (${chunk.map(() => "?").join(",")})`,
        chunk,
      )).rows;
      for (const row of rows) {
        const username = String(row.username ?? "").trim();
        if (username) names.set(Number(row.viewer_id), username);
      }
    }
    return names;
  }

  async prune(now = Date.now()): Promise<number> {
    const cutoff = now - this.options.retentionDays * 24 * 60 * 60_000;
    const result = await exec(this.db, "delete from analytics_events where ts < ?", [cutoff]);
    const removed = result.rowsAffected ?? 0;
    if (removed > 0) logInfo("analytics_pruned", { removed, retention_days: this.options.retentionDays });
    return removed;
  }

  // --- display helpers ---

  /* The recent-activity feed's visibility rules, shared by the monitor query
     and the live SSE stream so both always agree. */
  feedFilterAccepts(event: Pick<AnalyticsEventRecord, "distinctId" | "host" | "viewerUsername" | "path" | "event" | "isBot">, recentCountry?: string | null, country?: string | null): boolean {
    if (event.isBot) return false;
    if (event.distinctId === "server") return false;
    if (this.options.feedHosts && (!event.host || !this.options.feedHosts.includes(event.host))) return false;
    const excludedViewer = this.options.feedExcludedViewer?.toLowerCase();
    if (excludedViewer && event.viewerUsername && event.viewerUsername.toLowerCase() === excludedViewer) return false;
    if (event.path && event.path.startsWith("/admin/")) return false;
    if (event.event === "$pageview" && event.path === "/") return false;
    if (recentCountry && country !== recentCountry) return false;
    return true;
  }

  buildFeedEvent(record: AnalyticsEventRecord): AnalyticsFeedEvent {
    return buildMonitorFeedEvent(this.options.displayTimeZone, record);
  }

  // --- queries ---

  /* One scan set per cache window for everyone: concurrent tabs and both
     frontend instances share a compute via monitorInFlight, an expired entry
     answers instantly while its replacement computes in the background, and
     the TTL grows with the range (monitorCacheTtlMs). Tests pass an explicit
     `now` and bypass all of it. */
  async getMonitorData(params: { rangeHours: number; recentCountry?: string | null; recentLimit?: number; now?: number }): Promise<AnalyticsMonitorResponse> {
    if (params.now != null) return this.computeMonitorData(params);
    const rangeHours = Math.min(720, Math.max(1, Math.round(params.rangeHours || 24)));
    const key = [
      rangeHours,
      normalizeCountryCode(params.recentCountry) ?? "all",
      Math.min(1000, Math.max(1, Math.round(params.recentLimit ?? 1000))),
    ].join(":");
    const hit = this.monitorCache.get(key);
    if (hit && Date.now() - hit.at < monitorCacheTtlMs(rangeHours)) return hit.data;
    const inflight = this.monitorInFlight.get(key);
    if (inflight) return hit ? hit.data : inflight;
    const promise = this.computeMonitorData(params)
      .then((data) => {
        if (this.monitorCache.size > 32) this.monitorCache.clear();
        this.monitorCache.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => {
        this.monitorInFlight.delete(key);
      });
    this.monitorInFlight.set(key, promise);
    if (hit) {
      // Stale-while-revalidate: the recompute that just started refreshes the
      // cache for the next poll; only a cold range ever waits on a scan. A
      // failed refresh keeps serving the stale entry, so it must say so.
      promise.catch((error) => logWarn("analytics_monitor_refresh_failed", errorContext(error)));
      return hit.data;
    }
    return promise;
  }

  private async computeMonitorData(params: { rangeHours: number; recentCountry?: string | null; recentLimit?: number; now?: number }): Promise<AnalyticsMonitorResponse> {
    const resolved = {
      rangeHours: params.rangeHours,
      recentCountry: params.recentCountry,
      recentLimit: params.recentLimit,
      now: params.now ?? Date.now(),
    };
    // Flush first so "recent" really means seconds-ago. The write batch lives
    // on this thread, so it must land before any worker thread reads the file.
    await this.flush();
    const rangeHours = Math.min(720, Math.max(1, Math.round(resolved.rangeHours || 24)));
    if (rangeHours >= MONITOR_THREAD_MIN_RANGE_HOURS && this.options.databaseUrl?.startsWith("file:") && !import.meta.url.endsWith(".ts")) {
      try {
        const data = await computeMonitorInThread(this.options.databaseUrl, this.options, resolved);
        if (data) return data;
        // The thread ran but failed (query error, timeout): inline reproduces
        // the failure loudly, or answers correctly at the cost of one stutter.
        logWarn("analytics_monitor_thread_fell_back_inline", { range_hours: rangeHours });
      } catch {
        // The thread could not start (no compiled worker file: vitest, tsx dev),
        // where an inline scan of a small local database is the right substitute.
      }
    }
    return computeMonitorSnapshot(this.db, this.options, resolved);
  }

  async getValleyVisitors(now = Date.now()): Promise<AnalyticsValleyResponse> {
    await this.flush();
    const active = (await exec(this.db, `
      select count(distinct distinct_id) as n from analytics_events
      where ts > ? and is_bot = 0 and distinct_id != 'server'
    `, [now - ACTIVE_VISITOR_WINDOW_MS])).rows[0];
    const recent = (await exec(this.db, `
      select ts, path, country, distinct_id, json_extract(props, '$.profile_username') as profile_username
      from analytics_events
      where event in ('$pageview', 'replay_view') and ts > ? and is_bot = 0 and distinct_id != 'server'
        and (path is null or path not like '/admin/%')
      order by ts desc limit 30
    `, [now - 10 * 60_000])).rows;
    return {
      activeVisitors: Number(active?.n ?? 0),
      recent: recent.map((row) => ({
        timestamp: new Date(Number(row.ts)).toISOString(),
        path: row.path == null ? null : String(row.path),
        country: row.country == null ? null : String(row.country),
        distinctId: String(row.distinct_id ?? ""),
        profileUsername: row.profile_username == null ? null : String(row.profile_username),
      })),
    };
  }
}

export function buildMonitorFeedEvent(displayTimeZone: string, record: AnalyticsEventRecord): AnalyticsFeedEvent {
  const props = record.properties;
  const str = (key: string): string | null => {
    const value = props[key];
    if (value == null) return null;
    const text = String(value);
    return text ? text : null;
  };
  return {
    eventId: str("$insert_id"),
    timestamp: timeLabelFor(displayTimeZone, record.ts),
    ts: record.ts,
    event: record.event,
    path: record.path ?? "",
    country: record.country,
    selectedCountry: record.selectedCountry,
    deviceKind: deviceKindFor(record.screenWidth, record.viewportWidth),
    distinctId: record.distinctId,
    mapsTab: str("maps_tab"),
    mapsQuery: str("maps_query"),
    mapsFilters: str("maps_filters"),
    mapsSort: str("maps_sort"),
    mapsCollection: str("maps_collection"),
    mapsPage: str("maps_page"),
    mapsBeatmapId: str("maps_beatmap_id"),
    rankingsPage: str("rankings_page"),
    profileUsername: str("profile_username"),
    replayPlayer: str("replay_player"),
    replayScoreId: str("replay_score_id"),
    replayTitle: str("replay_title"),
    replayArtist: str("replay_artist"),
    replayDifficulty: str("replay_difficulty"),
    viewUrl: str("$current_url"),
    farmHelperUser: str("farm_helper_user"),
    packType: str("pack_type"),
    packUsername: str("pack_username"),
    farmMapTitle: str("farm_map_title"),
    farmMapUser: str("farm_map_user"),
    skinsQuery: str("skins_query"),
    skinsKeys: str("skins_keys"),
    skinsSort: str("skins_sort"),
    skinsPage: str("skins_page"),
    skinRef: str("skin_ref"),
    skinName: str("skin_name"),
    skinKeymodes: str("skin_keymodes"),
    skinUploadError: str("skin_upload_error"),
    communitiesQuery: str("communities_query"),
    communitiesCountry: str("communities_country"),
    communitiesLanguage: str("communities_language"),
    communitiesTag: str("communities_tag"),
    communitiesSort: str("communities_sort"),
    communitiesPage: str("communities_page"),
    communityId: str("community_id"),
    communityName: str("community_name"),
    viewerUsername: record.viewerUsername,
    referrer: record.referringDomain,
  };
}

export async function computeMonitorSnapshot(db: Db, options: MonitorComputeOptions, params: { rangeHours: number; recentCountry?: string | null; recentLimit?: number; now: number }): Promise<AnalyticsMonitorResponse> {
  const now = params.now;
  const rangeHours = Math.min(720, Math.max(1, Math.round(params.rangeHours || 24)));
  const since = now - rangeHours * 60 * 60_000;
  const activeSince = now - ACTIVE_VISITOR_WINDOW_MS;
  const recentSince = now - RECENT_VISITOR_WINDOW_MS;
  const recentCountry = normalizeCountryCode(params.recentCountry) ?? null;
  const recentLimit = Math.min(1000, Math.max(1, Math.round(params.recentLimit ?? 1000)));

  // Queries run sequentially on purpose: local libsql executes synchronously
  // on the event loop, so a Promise.all here would just serialize anyway
  // while pinning the loop; each await gives other requests a turn.
  const overview = (await exec(db, `
    select
      count(distinct case when ts > ? and distinct_id != 'server' then distinct_id end) as active,
      count(distinct case when ts > ? and distinct_id != 'server' then distinct_id end) as recent_active,
      sum(case when event = '$pageview' and (path is null or path not like '/admin/%') then 1 else 0 end) as pageviews,
      count(distinct case when distinct_id != 'server' then distinct_id end) as visitors,
      count(*) as events_total,
      sum(case when event = 'page_shared' then 1 else 0 end) as shares
    from analytics_events where ts > ? and is_bot = 0
  `, [activeSince, recentSince, since])).rows[0];

  const topRoutes = (await exec(db, `
    select path as p, count(*) as c from analytics_events
    where event = '$pageview' and ts > ? and is_bot = 0
      and path is not null and path != '/' and path not like '/admin/%'
    group by p order by c desc limit 10
  `, [since])).rows;

  const feedHostClause = options.feedHosts
    ? ` and host in (${options.feedHosts.map(() => "?").join(", ")})`
    : "";
  const feedViewerClause = options.feedExcludedViewer
    ? " and (viewer_username is null or lower(viewer_username) != ?)"
    : "";
  const recentArgs: Array<string | number> = [since];
  if (options.feedHosts) recentArgs.push(...options.feedHosts);
  if (options.feedExcludedViewer) recentArgs.push(options.feedExcludedViewer.toLowerCase());
  if (recentCountry) recentArgs.push(recentCountry);
  recentArgs.push(recentLimit);
  const recent = (await exec(db, `
    select ts, event, path, country, selected_country, distinct_id, screen_width, viewport_width, viewer_username, referring_domain, props
    from analytics_events
    where ts > ? and is_bot = 0 and distinct_id != 'server'${feedHostClause}${feedViewerClause}${recentCountry ? " and country = ?" : ""}
      and (path is null or path not like '/admin/%')
      and not (event = '$pageview' and path = '/')
    order by ts desc limit ?
  `, recentArgs)).rows;

  const topCountries = (await exec(db, `
    select country as c, count(distinct distinct_id) as n from analytics_events
    where ts > ? and is_bot = 0 and country is not null
    group by c order by n desc limit 20
  `, [since])).rows;

  // SQLite's bare-columns-with-max() rule makes `country` come from the
  // max(ts) row — the argMax(country, timestamp) these replace.
  const topProfiles = (await exec(db, `
    select json_extract(props, '$.profile_username') as u, count(*) as n, max(ts) as last_ts, country as last_country
    from analytics_events
    where event = '$pageview' and ts > ? and is_bot = 0 and json_extract(props, '$.profile_username') is not null
    group by u order by n desc, last_ts desc limit 10
  `, [since])).rows;

  const topReplays = (await exec(db, `
    select json_extract(props, '$.replay_score_id') as score_id,
      json_extract(props, '$.replay_title') as title,
      json_extract(props, '$.replay_artist') as artist,
      json_extract(props, '$.replay_difficulty') as difficulty,
      json_extract(props, '$.replay_player') as player,
      json_extract(props, '$.replay_cover_url') as cover_url,
      count(*) as n, max(ts) as last_ts, country as last_country
    from analytics_events
    where event = 'replay_view' and ts > ? and is_bot = 0 and json_extract(props, '$.replay_score_id') is not null
    group by score_id order by n desc, last_ts desc limit 10
  `, [since])).rows;

  const topReferrers = (await exec(db, `
    select referring_domain as d, count(distinct distinct_id) as n from analytics_events
    where event = '$pageview' and ts > ? and is_bot = 0 and referring_domain is not null
      and referring_domain not in ('localhost', '127.0.0.1', '::1')
      and referring_domain not like '%-aleju03s-projects.vercel.app'
    group by d order by n desc limit 10
  `, [since])).rows;

  const serverErrors = (await exec(db, `
    select json_extract(props, '$.caller') as c, json_extract(props, '$.path') as p, json_extract(props, '$.status') as s, count(*) as n
    from analytics_events
    where event = 'osu_api_error' and ts > ? and json_extract(props, '$.caller') is not null
    group by c, p, s order by n desc limit 10
  `, [since])).rows;

  const recentServerErrors = (await exec(db, `
    select ts, props from analytics_events
    where event = 'osu_api_error' and ts > ? and json_extract(props, '$.caller') is not null
    order by ts desc limit 15
  `, [since])).rows;

  const bounce = (await exec(db, `
    select sum(case when pv = 1 then 1 else 0 end) as bounced, count(*) as landers from (
      select distinct_id, count(*) as pv, sum(case when path = '/' then 1 else 0 end) as landings
      from analytics_events
      where event = '$pageview' and ts > ? and is_bot = 0
      group by distinct_id having landings > 0
    )
  `, [since])).rows[0];

  const sharePlatforms = (await exec(db, `
    select json_extract(props, '$.crawler') as c, count(*) as n from analytics_events
    where event = 'page_shared' and ts > ? and json_extract(props, '$.crawler') is not null
    group by c order by n desc limit 12
  `, [since])).rows;

  // Traffic shape over the range, bucketed so the admin chart is a fixed
  // width regardless of range. Buckets are aligned to `since` (not to wall
  // clock) so the newest bucket always ends at "now".
  const bucketMs = Math.max(60_000, Math.ceil((rangeHours * 60 * 60_000) / TIMELINE_BUCKETS));
  const timelineRows = (await exec(db, `
    select cast((ts - ?) / ? as integer) as b,
      count(*) as events,
      sum(case when event = '$pageview' and (path is null or path not like '/admin/%') then 1 else 0 end) as pageviews,
      count(distinct distinct_id) as visitors
    from analytics_events
    where ts > ? and is_bot = 0 and distinct_id != 'server'
    group by b order by b
  `, [since, bucketMs, since])).rows;
  const timelineByBucket = new Map<number, AnalyticsTimelineBucket>();
  for (const row of timelineRows) {
    const bucket = Number(row.b);
    if (!Number.isFinite(bucket) || bucket < 0 || bucket >= TIMELINE_BUCKETS) continue;
    timelineByBucket.set(bucket, {
      ts: since + bucket * bucketMs,
      events: Number(row.events ?? 0),
      pageviews: Number(row.pageviews ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
  }
  const timeline: AnalyticsTimelineBucket[] = Array.from({ length: TIMELINE_BUCKETS }, (_, index) => (
    timelineByBucket.get(index) ?? { ts: since + index * bucketMs, events: 0, pageviews: 0, visitors: 0 }
  ));

  const sharePages = (await exec(db, `
    select json_extract(props, '$.pathname') as p, json_extract(props, '$.subject') as s,
      json_extract(props, '$.subject_type') as t, count(*) as n
    from analytics_events
    where event = 'page_shared' and ts > ? and json_extract(props, '$.pathname') is not null
      and json_extract(props, '$.pathname') not like '/admin/%'
    group by p, s order by n desc limit 12
  `, [since])).rows;

  return {
    rangeHours,
    bucketMs,
    timeline,
    activeVisitors: Number(overview?.active ?? 0),
    recentVisitors: Number(overview?.recent_active ?? 0),
    pageviewsInRange: Number(overview?.pageviews ?? 0),
    uniqueVisitorsInRange: Number(overview?.visitors ?? 0),
    eventsInRange: Number(overview?.events_total ?? 0),
    bounce: {
      bounced: Number(bounce?.bounced ?? 0),
      landers: Number(bounce?.landers ?? 0),
    },
    topRoutes: topRoutes.map((row) => ({ path: String(row.p ?? ""), count: Number(row.c ?? 0) })),
    recentEvents: recent.map((row) => buildMonitorFeedEvent(options.displayTimeZone, {
      ts: Number(row.ts),
      event: String(row.event ?? ""),
      distinctId: String(row.distinct_id ?? ""),
      host: row.host == null ? null : String(row.host),
      path: row.path == null ? null : String(row.path),
      country: row.country == null ? null : String(row.country),
      selectedCountry: row.selected_country == null ? null : String(row.selected_country),
      viewerUsername: row.viewer_username == null ? null : String(row.viewer_username),
      referringDomain: row.referring_domain == null ? null : String(row.referring_domain),
      screenWidth: row.screen_width == null ? null : Number(row.screen_width),
      viewportWidth: row.viewport_width == null ? null : Number(row.viewport_width),
      isBot: false,
      properties: parseJson<Record<string, unknown>>(row.props, {}),
    })),
    topPhysicalCountries: topCountries.map((row) => ({ country: String(row.c ?? ""), count: Number(row.n ?? 0) })),
    topProfiles: topProfiles.map((row) => ({
      username: String(row.u ?? ""),
      views: Number(row.n ?? 0),
      lastViewedLabel: row.last_ts == null ? null : dateTimeLabelFor(options.displayTimeZone, Number(row.last_ts)),
      lastVisitorCountry: row.last_country == null ? null : String(row.last_country),
    })),
    topReplays: topReplays.map((row) => ({
      scoreId: String(row.score_id ?? ""),
      title: row.title == null ? null : String(row.title),
      artist: row.artist == null ? null : String(row.artist),
      difficulty: row.difficulty == null ? null : String(row.difficulty),
      player: row.player == null ? null : String(row.player),
      coverUrl: row.cover_url == null ? null : String(row.cover_url),
      views: Number(row.n ?? 0),
      lastViewedLabel: row.last_ts == null ? null : dateTimeLabelFor(options.displayTimeZone, Number(row.last_ts)),
      lastVisitorCountry: row.last_country == null ? null : String(row.last_country),
    })),
    topReferrers: topReferrers.map((row) => ({ domain: String(row.d ?? ""), count: Number(row.n ?? 0) })),
    shareEvents: Number(overview?.shares ?? 0),
    sharesByPlatform: sharePlatforms.map((row) => ({ platform: String(row.c ?? ""), count: Number(row.n ?? 0) })),
    topSharedPages: sharePages.map((row) => ({
      path: String(row.p ?? ""),
      subject: row.s == null ? null : String(row.s),
      subjectType: row.t == null ? null : String(row.t),
      count: Number(row.n ?? 0),
    })),
    serverErrors: serverErrors.map((row) => ({
      caller: row.c == null ? "unknown" : String(row.c),
      path: String(row.p ?? ""),
      status: row.s == null ? null : Number(row.s),
      count: Number(row.n ?? 0),
    })),
    recentServerErrors: recentServerErrors.map((row) => {
      const props = parseJson<Record<string, unknown>>(row.props, {});
      return {
        timestamp: timeLabelFor(options.displayTimeZone, Number(row.ts)),
        caller: props.caller == null ? "unknown" : String(props.caller),
        path: props.path == null ? "" : String(props.path),
        status: props.status == null ? null : Number(props.status),
        bodyPreview: props.body_preview == null ? null : String(props.body_preview),
        attempts: props.attempts == null ? null : Number(props.attempts),
        kind: props.kind == null ? null : String(props.kind),
        context: formatServerErrorContext(props.context),
        ratePerMin: props.rate_per_min == null ? null : Number(props.rate_per_min),
        rateRemaining: props.rate_remaining == null ? null : Number(props.rate_remaining),
        rateLimit: props.rate_limit == null ? null : Number(props.rate_limit),
        retryAfter: props.retry_after == null ? null : String(props.retry_after),
      };
    }),
  };
}

/* The slice of store options the monitor scan needs — everything in it is
   structured-clone-safe, because the worker thread receives it as workerData. */
export type MonitorComputeOptions = Pick<Required<AnalyticsStoreOptions>, "feedHosts" | "feedExcludedViewer" | "displayTimeZone">;

function timeLabelFor(timeZone: string, ts: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(ts));
}

function dateTimeLabelFor(timeZone: string, ts: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ts));
  return `${parts} ${time}`;
}

/* Runs the monitor scan set in a one-shot worker thread on its own read
   connection (WAL handles the concurrency with the main thread's writer).
   Resolves null when the thread ran but failed (query error, timeout), so the
   caller can fall back inline; rejects only when the thread itself cannot
   start — the compiled worker file is missing, i.e. vitest/dev. */
function computeMonitorInThread(
  databaseUrl: string,
  options: MonitorComputeOptions,
  params: { rangeHours: number; recentCountry?: string | null; recentLimit?: number; now: number },
): Promise<AnalyticsMonitorResponse | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL("./analytics-monitor-worker.js", import.meta.url), {
      workerData: {
        databaseUrl,
        options: {
          feedHosts: options.feedHosts,
          feedExcludedViewer: options.feedExcludedViewer,
          displayTimeZone: options.displayTimeZone,
        },
        params,
      },
    });
    // The thread must never keep an exiting process alive.
    worker.unref();
    let online = false;
    let settled = false;
    const settle = (value: AnalyticsMonitorResponse | null, spawnError?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      if (spawnError !== undefined) rejectPromise(spawnError instanceof Error ? spawnError : new Error(String(spawnError)));
      else resolvePromise(value);
    };
    const timer = setTimeout(() => settle(null), MONITOR_THREAD_TIMEOUT_MS);
    timer.unref();
    worker.on("online", () => {
      online = true;
    });
    worker.on("message", (result: { ok: boolean; data?: AnalyticsMonitorResponse; error?: string }) => {
      if (!result.ok) logWarn("analytics_monitor_worker_failed", { error: result.error });
      settle(result.ok ? result.data ?? null : null);
    });
    worker.on("error", (error) => {
      if (online) {
        logWarn("analytics_monitor_worker_error", errorContext(error));
        settle(null);
      } else {
        settle(null, error);
      }
    });
    worker.on("exit", () => settle(null));
  });
}

/* Folds a flush batch into the durable viewer roster. Collapsed per viewer
   first so a burst of pageviews is one upsert instead of twenty. */
export function viewerUpsertStatements(batch: AnalyticsEventRecord[]): DbStatement[] {
  const byViewer = new Map<number, { username: string; first: number; last: number; events: number; country: string | null }>();
  for (const record of batch) {
    if (record.isBot || !record.viewerUsername) continue;
    const viewerId = asFiniteNumber(record.properties.viewer_id);
    if (viewerId == null || !Number.isInteger(viewerId) || viewerId <= 0) continue;
    const existing = byViewer.get(viewerId);
    if (!existing) {
      byViewer.set(viewerId, {
        username: record.viewerUsername,
        first: record.ts,
        last: record.ts,
        events: 1,
        country: record.country,
      });
      continue;
    }
    existing.events += 1;
    if (record.ts < existing.first) existing.first = record.ts;
    // Usernames change on osu!, so the newest event in the batch wins.
    if (record.ts >= existing.last) {
      existing.last = record.ts;
      existing.username = record.viewerUsername;
      if (record.country) existing.country = record.country;
    }
  }
  return Array.from(byViewer.entries()).map(([viewerId, entry]) => ({
    sql: `insert into analytics_viewers (viewer_id, username, first_seen, last_seen, events, last_country)
      values (?, ?, ?, ?, ?, ?)
      on conflict(viewer_id) do update set
        username = case when excluded.last_seen >= analytics_viewers.last_seen then excluded.username else analytics_viewers.username end,
        last_country = case when excluded.last_seen >= analytics_viewers.last_seen and excluded.last_country is not null
          then excluded.last_country else analytics_viewers.last_country end,
        first_seen = min(analytics_viewers.first_seen, excluded.first_seen),
        last_seen = max(analytics_viewers.last_seen, excluded.last_seen),
        events = analytics_viewers.events + excluded.events`,
    args: [viewerId, entry.username, entry.first, entry.last, entry.events, entry.country],
  }));
}

export function deviceKindFor(screenWidth: number | null, viewportWidth: number | null): "mobile" | "desktop" | "unknown" {
  const width = screenWidth != null && screenWidth > 0 ? screenWidth : viewportWidth != null && viewportWidth > 0 ? viewportWidth : null;
  if (width == null) return "unknown";
  return width < 768 ? "mobile" : "desktop";
}

/* Mirrors the admin UI's server-error context formatter so the backend can
   ship display-ready strings. */
function formatServerErrorContext(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== "")
    .slice(0, 10)
    .map(([key, entryValue]) => `${key}=${String(entryValue)}`);
  return entries.length ? entries.join(" ") : null;
}
