import { randomUUID } from "node:crypto";
import { exec, execBatch, json, parseJson, type Db, type DbStatement } from "../db.js";
import { logInfo, logWarn, errorContext } from "../logger.js";

// In-house analytics: the PostHog replacement. The Vercel capture proxy
// (/api/sync) forwards every tracked event here; rows land in a SEPARATE
// SQLite file (its own WAL) so analytics volume can never bloat the main
// serving DB, and every admin dashboard query is a local read instead of a
// rate-limited HogQL round trip. Commonly-filtered fields are extracted into
// real columns at ingest; everything else stays in the props JSON and is
// json_extract'ed at query time (the feed is LIMIT-bounded, so that's cheap).

const FLUSH_INTERVAL_MS = 1_000;
const MAX_BUFFERED_EVENTS = 5_000;
const MAX_PROPS_JSON_CHARS = 16 * 1024;
const MAX_EVENTS_PER_CAPTURE = 50;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const LIVE_TICKET_TTL_MS = 10 * 60_000;
const ACTIVE_VISITOR_WINDOW_MS = 5 * 60_000;

// Query-side display defaults, matching the HogQL queries this replaces.
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
  viewUrl: string | null;
  farmHelperUser: string | null;
  farmMapTitle: string | null;
  farmMapUser: string | null;
  packType: string | null;
  packUsername: string | null;
  viewerUsername: string | null;
}

export interface AnalyticsMonitorResponse {
  rangeHours: number;
  activeVisitors: number;
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

/* One PostHog-shaped capture payload ({event, distinct_id, timestamp,
   properties}) into a typed record. Returns null for garbage. */
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

export class AnalyticsStore {
  private readonly db: Db;
  private readonly options: Required<AnalyticsStoreOptions>;
  private buffer: AnalyticsEventRecord[] = [];
  private dropped = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: AnalyticsEventRecord) => void>();
  private readonly liveTickets = new Map<string, number>();

  constructor(db: Db, options: AnalyticsStoreOptions = {}) {
    this.db = db;
    this.options = {
      retentionDays: options.retentionDays ?? 90,
      feedHosts: options.feedHosts === undefined ? DEFAULT_FEED_HOSTS : options.feedHosts,
      feedExcludedViewer: options.feedExcludedViewer === undefined ? DEFAULT_FEED_EXCLUDED_VIEWER : options.feedExcludedViewer,
      displayTimeZone: options.displayTimeZone ?? DEFAULT_DISPLAY_TIME_ZONE,
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

  /* Accepts one capture body from the proxy: either a single PostHog-shaped
     payload or {batch: [...]}. Returns how many events were accepted. */
  capture(body: unknown, meta: { geoCountry?: string | null; isBot?: boolean } = {}): number {
    const payloads = Array.isArray((body as { batch?: unknown })?.batch)
      ? ((body as { batch: unknown[] }).batch).slice(0, MAX_EVENTS_PER_CAPTURE)
      : [body];
    let accepted = 0;
    for (const payload of payloads) {
      const record = normalizeAnalyticsEvent(payload, meta);
      if (!record) continue;
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
    try {
      await execBatch(this.db, statements);
    } catch (error) {
      logWarn("analytics_flush_failed", { events: batch.length, ...errorContext(error) });
    }
  }

  async prune(now = Date.now()): Promise<number> {
    const cutoff = now - this.options.retentionDays * 24 * 60 * 60_000;
    const result = await exec(this.db, "delete from analytics_events where ts < ?", [cutoff]);
    const removed = result.rowsAffected ?? 0;
    if (removed > 0) logInfo("analytics_pruned", { removed, retention_days: this.options.retentionDays });
    return removed;
  }

  // --- display helpers ---

  private timeLabel(ts: number): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: this.options.displayTimeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(new Date(ts));
  }

  private dateTimeLabel(ts: number): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.options.displayTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ts));
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: this.options.displayTimeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(ts));
    return `${parts} ${time}`;
  }

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
    const props = record.properties;
    const str = (key: string): string | null => {
      const value = props[key];
      if (value == null) return null;
      const text = String(value);
      return text ? text : null;
    };
    return {
      eventId: str("$insert_id"),
      timestamp: this.timeLabel(record.ts),
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
      viewUrl: str("$current_url"),
      farmHelperUser: str("farm_helper_user"),
      packType: str("pack_type"),
      packUsername: str("pack_username"),
      farmMapTitle: str("farm_map_title"),
      farmMapUser: str("farm_map_user"),
      viewerUsername: record.viewerUsername,
    };
  }

  // --- queries ---

  async getMonitorData(params: { rangeHours: number; recentCountry?: string | null; recentLimit?: number; now?: number }): Promise<AnalyticsMonitorResponse> {
    const now = params.now ?? Date.now();
    const rangeHours = Math.min(720, Math.max(1, Math.round(params.rangeHours || 24)));
    const since = now - rangeHours * 60 * 60_000;
    const activeSince = now - ACTIVE_VISITOR_WINDOW_MS;
    const recentCountry = normalizeCountryCode(params.recentCountry) ?? null;
    const recentLimit = Math.min(1000, Math.max(1, Math.round(params.recentLimit ?? 1000)));

    // Flush first so "recent" really means seconds-ago.
    await this.flush();

    // Queries run sequentially on purpose: local libsql executes synchronously
    // on the event loop, so a Promise.all here would just serialize anyway
    // while pinning the loop; each await gives other requests a turn.
    const overview = (await exec(this.db, `
      select
        count(distinct case when ts > ? and distinct_id != 'server' then distinct_id end) as active,
        sum(case when event = '$pageview' and (path is null or path not like '/admin/%') then 1 else 0 end) as pageviews,
        count(distinct case when distinct_id != 'server' then distinct_id end) as visitors,
        count(*) as events_total,
        sum(case when event = 'page_shared' then 1 else 0 end) as shares
      from analytics_events where ts > ? and is_bot = 0
    `, [activeSince, since])).rows[0];

    const topRoutes = (await exec(this.db, `
      select path as p, count(*) as c from analytics_events
      where event = '$pageview' and ts > ? and is_bot = 0
        and path is not null and path != '/' and path not like '/admin/%'
      group by p order by c desc limit 10
    `, [since])).rows;

    const feedHostClause = this.options.feedHosts
      ? ` and host in (${this.options.feedHosts.map(() => "?").join(", ")})`
      : "";
    const feedViewerClause = this.options.feedExcludedViewer
      ? " and (viewer_username is null or lower(viewer_username) != ?)"
      : "";
    const recentArgs: Array<string | number> = [since];
    if (this.options.feedHosts) recentArgs.push(...this.options.feedHosts);
    if (this.options.feedExcludedViewer) recentArgs.push(this.options.feedExcludedViewer.toLowerCase());
    if (recentCountry) recentArgs.push(recentCountry);
    recentArgs.push(recentLimit);
    const recent = (await exec(this.db, `
      select ts, event, path, country, selected_country, distinct_id, screen_width, viewport_width, viewer_username, props
      from analytics_events
      where ts > ? and is_bot = 0 and distinct_id != 'server'${feedHostClause}${feedViewerClause}${recentCountry ? " and country = ?" : ""}
        and (path is null or path not like '/admin/%')
        and not (event = '$pageview' and path = '/')
      order by ts desc limit ?
    `, recentArgs)).rows;

    const topCountries = (await exec(this.db, `
      select country as c, count(distinct distinct_id) as n from analytics_events
      where ts > ? and is_bot = 0 and country is not null
      group by c order by n desc limit 20
    `, [since])).rows;

    // SQLite's bare-columns-with-max() rule makes `country` come from the
    // max(ts) row — the argMax(country, timestamp) these replace.
    const topProfiles = (await exec(this.db, `
      select json_extract(props, '$.profile_username') as u, count(*) as n, max(ts) as last_ts, country as last_country
      from analytics_events
      where event = '$pageview' and ts > ? and is_bot = 0 and json_extract(props, '$.profile_username') is not null
      group by u order by n desc, last_ts desc limit 10
    `, [since])).rows;

    const topReplays = (await exec(this.db, `
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

    const topReferrers = (await exec(this.db, `
      select referring_domain as d, count(distinct distinct_id) as n from analytics_events
      where event = '$pageview' and ts > ? and is_bot = 0 and referring_domain is not null
        and referring_domain not in ('localhost', '127.0.0.1', '::1')
        and referring_domain not like '%-aleju03s-projects.vercel.app'
      group by d order by n desc limit 10
    `, [since])).rows;

    const serverErrors = (await exec(this.db, `
      select json_extract(props, '$.caller') as c, json_extract(props, '$.path') as p, json_extract(props, '$.status') as s, count(*) as n
      from analytics_events
      where event = 'osu_api_error' and ts > ? and json_extract(props, '$.caller') is not null
      group by c, p, s order by n desc limit 10
    `, [since])).rows;

    const recentServerErrors = (await exec(this.db, `
      select ts, props from analytics_events
      where event = 'osu_api_error' and ts > ? and json_extract(props, '$.caller') is not null
      order by ts desc limit 15
    `, [since])).rows;

    const bounce = (await exec(this.db, `
      select sum(case when pv = 1 then 1 else 0 end) as bounced, count(*) as landers from (
        select distinct_id, count(*) as pv, sum(case when path = '/' then 1 else 0 end) as landings
        from analytics_events
        where event = '$pageview' and ts > ? and is_bot = 0
        group by distinct_id having landings > 0
      )
    `, [since])).rows[0];

    const sharePlatforms = (await exec(this.db, `
      select json_extract(props, '$.crawler') as c, count(*) as n from analytics_events
      where event = 'page_shared' and ts > ? and json_extract(props, '$.crawler') is not null
      group by c order by n desc limit 12
    `, [since])).rows;

    const sharePages = (await exec(this.db, `
      select json_extract(props, '$.pathname') as p, json_extract(props, '$.subject') as s,
        json_extract(props, '$.subject_type') as t, count(*) as n
      from analytics_events
      where event = 'page_shared' and ts > ? and json_extract(props, '$.pathname') is not null
        and json_extract(props, '$.pathname') not like '/admin/%'
      group by p, s order by n desc limit 12
    `, [since])).rows;

    return {
      rangeHours,
      activeVisitors: Number(overview?.active ?? 0),
      pageviewsInRange: Number(overview?.pageviews ?? 0),
      uniqueVisitorsInRange: Number(overview?.visitors ?? 0),
      eventsInRange: Number(overview?.events_total ?? 0),
      bounce: {
        bounced: Number(bounce?.bounced ?? 0),
        landers: Number(bounce?.landers ?? 0),
      },
      topRoutes: topRoutes.map((row) => ({ path: String(row.p ?? ""), count: Number(row.c ?? 0) })),
      recentEvents: recent.map((row) => this.buildFeedEvent({
        ts: Number(row.ts),
        event: String(row.event ?? ""),
        distinctId: String(row.distinct_id ?? ""),
        host: row.host == null ? null : String(row.host),
        path: row.path == null ? null : String(row.path),
        country: row.country == null ? null : String(row.country),
        selectedCountry: row.selected_country == null ? null : String(row.selected_country),
        viewerUsername: row.viewer_username == null ? null : String(row.viewer_username),
        referringDomain: null,
        screenWidth: row.screen_width == null ? null : Number(row.screen_width),
        viewportWidth: row.viewport_width == null ? null : Number(row.viewport_width),
        isBot: false,
        properties: parseJson<Record<string, unknown>>(row.props, {}),
      })),
      topPhysicalCountries: topCountries.map((row) => ({ country: String(row.c ?? ""), count: Number(row.n ?? 0) })),
      topProfiles: topProfiles.map((row) => ({
        username: String(row.u ?? ""),
        views: Number(row.n ?? 0),
        lastViewedLabel: row.last_ts == null ? null : this.dateTimeLabel(Number(row.last_ts)),
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
        lastViewedLabel: row.last_ts == null ? null : this.dateTimeLabel(Number(row.last_ts)),
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
          timestamp: this.timeLabel(Number(row.ts)),
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
