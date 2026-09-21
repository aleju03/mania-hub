import { exec, execBatch, parseJson, type Db, type DbStatement } from "../db.js";
import {
  ANALYTICS_DAY_MS as DAY, ANALYTICS_WEEK_MS as WEEK, analyticsFeature, analyticsWeekStart,
  type AnalyticsProductInsights,
} from "../shared/analytics-insights.js";

export interface ProductAnalyticsOptions {
  feedHosts: string[] | null;
  feedExcludedViewer: string | null;
  retentionDays: number;
}

// Deliberate actions, rather than every custom event (errors and automatic
// diagnostics must not make an acquisition source look more successful).
const ACTIONS = new Set([
  "pack_open", "pack_cut", "streak_run", "skin_download", "skin_upload_published", "skin_file_updated",
  "skin_previews_edited", "community_join", "community_post_submitted", "packs_showcase_saved",
  "packs_collections_card", "add_score_submitted", "skill_plays_view", "dan_estimates_read",
  "replay_upload_view", "replay_upload_shared_view", "replay_upload_community_beatmap", "replay_upload_local_beatmap",
]);
const ERRORS = new Set([
  "route_error", "react_recoverable_error", "replay_renderer_error", "replay_watch_crash",
  "skin_upload_failed", "client_error", "client_unhandled_rejection",
]);

export async function ensureProductAnalyticsSchema(db: Db): Promise<void> {
  await execBatch(db, [
    { sql: `create table if not exists analytics_product_state (key text primary key, value text not null)` },
    { sql: `create table if not exists analytics_product_visitors (
      visitor text primary key, first_ts integer not null, last_ts integer not null,
      source text not null, medium text not null, campaign text not null, landing text not null
    ) without rowid` },
    { sql: `create table if not exists analytics_product_activity (
      day integer not null, visitor text not null, feature text not null, device text not null, release text not null,
      views integer not null, actions integer not null, errors integer not null,
      primary key (day, visitor, feature, device, release)
    ) without rowid` },
    { sql: `create table if not exists analytics_product_loads (
      event_id integer primary key, ts integer not null, visitor text not null,
      operation text not null, device text not null, release text not null, success integer not null, duration_ms integer not null
    )` },
    { sql: "create index if not exists idx_analytics_product_loads_ts on analytics_product_loads(ts)" },
  ]);
}

const string = (value: unknown, limit = 120): string => typeof value === "string" ? value.trim().slice(0, limit) : "";

function acquisition(row: Record<string, unknown>, props: Record<string, unknown>) {
  // New clients preserve the document's entry before SPA navigation; legacy
  // events can still recover campaign tags from their captured URL.
  let url: URL | null = null;
  try { url = new URL(string(props.entry_url ?? props.$current_url, 2048)); } catch { /* absent on old events */ }
  const capturedEntry = typeof props.entry_path === "string";
  const source = string(capturedEntry ? props.utm_source : url?.searchParams.get("utm_source"));
  const referrer = string(props.entry_referrer || row.referring_domain);
  const internal = !referrer || referrer === "$direct" || referrer === row.host
    || referrer === "mania-tracker.com" || referrer.endsWith(".mania-tracker.com");
  return {
    source: source || (internal ? "Direct / unknown" : referrer),
    medium: string(capturedEntry ? props.utm_medium : url?.searchParams.get("utm_medium")) || (source ? "unspecified" : internal ? "direct" : "referral"),
    campaign: string(capturedEntry ? props.utm_campaign : url?.searchParams.get("utm_campaign")),
    landing: string(props.entry_path || url?.pathname || row.path, 300) || "/",
  };
}

function projectionStatements(rows: Record<string, unknown>[], options: ProductAnalyticsOptions): DbStatement[] {
  const statements: DbStatement[] = [];
  let firstTs = Infinity;
  for (const row of rows) {
    const visitor = string(row.distinct_id, 64);
    const path = string(row.path, 300);
    if (Number(row.is_bot) || !visitor || visitor === "server" || visitor === "unknown" || visitor === "ssr"
      || path === "/admin" || path.startsWith("/admin/")
      || (options.feedHosts && !options.feedHosts.includes(String(row.host)))
      || (options.feedExcludedViewer && String(row.viewer_username).toLowerCase() === options.feedExcludedViewer.toLowerCase())) continue;
    const ts = Number(row.ts);
    const day = Math.floor(ts / DAY) * DAY;
    const props = parseJson<Record<string, unknown>>(String(row.props), {});
    const event = String(row.event);
    const width = Number(row.screen_width || row.viewport_width);
    const device = width > 0 ? width < 768 ? "mobile" : "desktop" : "unknown";
    const release = string(props.app_version, 64) || "unknown";
    const isLoad = event === "replay_load_result" || event === "page_load_result";
    if (isLoad) {
      const duration = Number(props.duration_ms);
      if (typeof props.success === "boolean" && typeof props.duration_ms === "number" && Number.isFinite(duration) && duration >= 0 && duration <= 3_600_000) {
        statements.push({
          sql: `insert or ignore into analytics_product_loads
            (event_id, ts, visitor, operation, device, release, success, duration_ms) values (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [Number(row.id), ts, visitor, event === "replay_load_result" ? "Replay data load" : "Document load", device, release, props.success ? 1 : 0, Math.round(duration)],
        });
      } else continue;
    }
    const views = event === "$pageview" ? 1 : 0;
    const actions = ACTIONS.has(event) || (event === "replay_load_result" && props.success === true) ? 1 : 0;
    const errors = ERRORS.has(event) || (isLoad && props.success === false) ? 1 : 0;
    // Passive diagnostics alone don't establish a visitor or inflate usage.
    if (!views && !actions && !errors) continue;
    firstTs = Math.min(firstTs, ts);
    const entry = acquisition(row, props);
    statements.push({
      sql: `insert into analytics_product_visitors (visitor, first_ts, last_ts, source, medium, campaign, landing)
        values (?, ?, ?, ?, ?, ?, ?) on conflict(visitor) do update set
        source = case when excluded.first_ts < first_ts then excluded.source else source end,
        medium = case when excluded.first_ts < first_ts then excluded.medium else medium end,
        campaign = case when excluded.first_ts < first_ts then excluded.campaign else campaign end,
        landing = case when excluded.first_ts < first_ts then excluded.landing else landing end,
        first_ts = min(first_ts, excluded.first_ts), last_ts = max(last_ts, excluded.last_ts)`,
      args: [visitor, ts, ts, entry.source, entry.medium, entry.campaign, entry.landing],
    });
    statements.push({
      sql: `insert into analytics_product_activity (day, visitor, feature, device, release, views, actions, errors)
        values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(day, visitor, feature, device, release) do update set
        views = views + excluded.views, actions = actions + excluded.actions, errors = errors + excluded.errors`,
      args: [day, visitor, analyticsFeature(path), device, release, views, actions, errors],
    });
  }
  if (Number.isFinite(firstTs)) statements.push({
    sql: `insert into analytics_product_state (key, value) values ('history_since', ?)
      on conflict(key) do update set value = cast(min(cast(value as integer), cast(excluded.value as integer)) as text)`,
    args: [String(firstTs)],
  });
  return statements;
}

// The cursor advances in the same transaction as its facts: a crash/restart
// cannot double counts. It follows insertion id, not event time, so late
// beacons update their original day and first attribution correctly.
export async function advanceProductAnalytics(db: Db, options: ProductAnalyticsOptions, now = Date.now()): Promise<void> {
  const maxId = Number((await exec(db, "select max(id) as id from analytics_events")).rows[0]?.id ?? 0);
  let cursor = Number((await exec(db, "select value from analytics_product_state where key = 'cursor'")).rows[0]?.value ?? 0);
  while (cursor < maxId) {
    const rows = (await exec(db, "select * from analytics_events where id > ? and id <= ? order by id limit 250", [cursor, maxId])).rows;
    if (!rows.length) break;
    cursor = Number(rows[rows.length - 1].id);
    await execBatch(db, [
      ...projectionStatements(rows, options),
      { sql: "insert or replace into analytics_product_state (key, value) values ('cursor', ?)", args: [String(cursor)] },
    ]);
    if (cursor < maxId) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Visitor first-observed dates survive pruning. Detailed activity and load
  // samples respect the raw store's retention, including custom short windows.
  const cutoff = Math.floor((now - options.retentionDays * DAY) / DAY) * DAY;
  await exec(db, "delete from analytics_product_activity where day < ?", [cutoff]);
  await exec(db, "delete from analytics_product_loads where ts < ?", [cutoff]);
}

export async function computeProductInsights(db: Db, options: ProductAnalyticsOptions, now = Date.now()): Promise<AnalyticsProductInsights> {
  const end = Math.floor(now / DAY) * DAY;
  const start = end - WEEK;
  const acquisitionStart = end - 28 * DAY;
  const healthStart = end - 6 * DAY;
  const history = (await exec(db, "select value from analytics_product_state where key = 'history_since'")).rows[0]?.value;
  const historySince = history == null ? null : Number(history);
  const coverage = Math.max(historySince ?? now, now - options.retentionDays * DAY);
  const firstCohort = analyticsWeekStart(end) - 8 * WEEK;
  // One compact row per active visitor/day/feature; repeated actions and device
  // changes collapse here. The worker handles the whole computation off the
  // HTTP loop and returns only the small display-ready result.
  const activity = (await exec(db, `select a.day, a.visitor, a.feature, sum(a.views) as views, sum(a.actions) as actions,
    v.first_ts, v.source, v.medium, v.campaign, v.landing from analytics_product_activity a
    join analytics_product_visitors v on v.visitor = a.visitor
    where a.day >= ? and a.day < ? and (a.views > 0 or a.actions > 0)
    group by a.day, a.visitor, a.feature`, [firstCohort, end])).rows;
  type Visitor = { first: number; source: string; medium: string; campaign: string; landing: string; days: Set<number>; actions: Set<number>; features: Map<string, Set<number>> };
  const visitors = new Map<string, Visitor>();
  const features = new Map<string, { current: Map<string, Set<number>>; previous: Set<string>; actions: Set<string>; eligible: Set<string>; retained: Set<string> }>();
  const daily = new Map<number, { visitors: Set<string>; newcomers: Set<string> }>();
  for (const row of activity) {
    const id = String(row.visitor), day = Number(row.day), feature = String(row.feature);
    let visitor = visitors.get(id);
    if (!visitor) {
      visitor = { first: Number(row.first_ts), source: String(row.source), medium: String(row.medium), campaign: String(row.campaign), landing: String(row.landing), days: new Set(), actions: new Set(), features: new Map() };
      visitors.set(id, visitor);
    }
    visitor.days.add(day);
    if (Number(row.actions) > 0) visitor.actions.add(day);
    if (!visitor.features.has(feature)) visitor.features.set(feature, new Set());
    visitor.features.get(feature)!.add(day);
    if (!features.has(feature)) features.set(feature, { current: new Map(), previous: new Set(), actions: new Set(), eligible: new Set(), retained: new Set() });
    const f = features.get(feature)!;
    if (day >= start) {
      if (!f.current.has(id)) f.current.set(id, new Set());
      f.current.get(id)!.add(day);
      if (Number(row.actions) > 0) f.actions.add(id);
    } else if (day >= start - WEEK) f.previous.add(id);
    if (day >= acquisitionStart) {
      if (!daily.has(day)) daily.set(day, { visitors: new Set(), newcomers: new Set() });
      daily.get(day)!.visitors.add(id);
      if (Math.floor(visitor.first / DAY) * DAY === day) daily.get(day)!.newcomers.add(id);
    }
  }
  const hasDay = (days: Set<number>, from: number, to: number) => [...days].some((day) => day >= from && day < to);
  let weeklyVisitors = 0, previousWeeklyVisitors = 0, newVisitors = 0;
  const cohorts = Array.from({ length: 8 }, (_, i) => ({ week: firstCohort + i * WEEK, newcomers: 0, returned: null as number | null }))
    // Don't present a partial historical week as a complete newcomer cohort.
    .filter((cohort) => cohort.week >= coverage);
  for (const cohort of cohorts) if (cohort.week + 2 * WEEK <= end) cohort.returned = 0;
  const acquisitionGroups = new Map<string, AnalyticsProductInsights["acquisition"][number]>();
  for (const [id, visitor] of visitors) {
    if (hasDay(visitor.days, start, end)) { weeklyVisitors++; if (visitor.first >= start) newVisitors++; }
    if (hasDay(visitor.days, start - WEEK, start)) previousWeeklyVisitors++;
    const week = analyticsWeekStart(visitor.first);
    const cohort = cohorts.find((c) => c.week === week);
    const returned = hasDay(visitor.days, week + WEEK, week + 2 * WEEK);
    if (cohort) {
      cohort.newcomers++;
      if (cohort.returned != null && returned) cohort.returned++;
      if (cohort.returned != null) for (const [feature, days] of visitor.features) {
        if (!hasDay(days, week, week + WEEK)) continue;
        features.get(feature)!.eligible.add(id);
        if (returned) features.get(feature)!.retained.add(id);
      }
    }
    if (visitor.first < Math.max(acquisitionStart, coverage) || visitor.first >= end) continue;
    const key = JSON.stringify([visitor.source, visitor.medium, visitor.campaign, visitor.landing]);
    let group = acquisitionGroups.get(key);
    if (!group) {
      group = { source: visitor.source, medium: visitor.medium, campaign: visitor.campaign, landing: visitor.landing, visitors: 0, actionVisitors: 0, retentionEligible: 0, retained: 0 };
      acquisitionGroups.set(key, group);
    }
    group.visitors++;
    if (hasDay(visitor.actions, Math.floor(visitor.first / DAY) * DAY, end)) group.actionVisitors++;
    // Source quality uses the same completed acquisition-week + following-week
    // definition as the retention table, with no penalty for immature cohorts.
    if (week >= coverage && week + 2 * WEEK <= end) {
      group.retentionEligible++;
      if (returned) group.retained++;
    }
  }
  const reliability = (await exec(db, `select feature, device, release, count(distinct visitor) as visitors,
    count(distinct case when errors > 0 then visitor end) as affected, sum(errors) as errors
    from analytics_product_activity where day >= ? and day < ? group by feature, device, release
    order by affected desc, visitors desc limit 100`, [healthStart, now])).rows.map((r) => ({
    feature: String(r.feature), device: String(r.device), release: String(r.release), visitors: Number(r.visitors), affectedVisitors: Number(r.affected), errors: Number(r.errors),
  }));
  const loads = (await exec(db, `with ranked as (
    select *, row_number() over (partition by operation, device, release, success order by duration_ms) as rank,
      count(*) over (partition by operation, device, release, success) as samples
    from analytics_product_loads where ts >= ? and ts < ?
  ) select operation, device, release, count(*) as attempts, sum(1 - success) as failures,
    count(distinct case when success = 0 then visitor end) as affected,
    sum(success) as successful,
    max(case when success = 1 and rank = cast((samples * 50 + 99) / 100 as integer) then duration_ms end) as p50,
    max(case when success = 1 and rank = cast((samples * 75 + 99) / 100 as integer) then duration_ms end) as p75,
    max(case when success = 1 and rank = cast((samples * 95 + 99) / 100 as integer) then duration_ms end) as p95
    from ranked group by operation, device, release order by attempts desc limit 100`, [healthStart, now])).rows.map((r) => ({
    operation: String(r.operation), device: String(r.device), release: String(r.release), attempts: Number(r.attempts), failures: Number(r.failures), affectedVisitors: Number(r.affected), successfulSamples: Number(r.successful),
    p50Ms: r.p50 == null ? null : Number(r.p50), p75Ms: r.p75 == null ? null : Number(r.p75), p95Ms: r.p95 == null ? null : Number(r.p95),
  }));
  return {
    generatedAt: now, historySince, coverageSince: coverage, weekStart: start, weekEnd: end, acquisitionStart,
    weeklyVisitors, previousWeeklyVisitors, newVisitors, returningVisitors: weeklyVisitors - newVisitors,
    daily: Array.from({ length: 28 }, (_, i) => { const day = acquisitionStart + i * DAY; return { day, visitors: daily.get(day)?.visitors.size ?? 0, newVisitors: daily.get(day)?.newcomers.size ?? 0 }; }),
    cohorts,
    features: [...features].map(([feature, f]) => ({ feature, visitors: f.current.size, previousVisitors: f.previous.size, repeatVisitors: [...f.current.values()].filter((days) => days.size >= 2).length, actionVisitors: f.actions.size, retentionEligible: f.eligible.size, retained: f.retained.size })).filter((f) => f.visitors || f.previousVisitors || f.retentionEligible).sort((a, b) => b.visitors - a.visitors),
    acquisition: [...acquisitionGroups.values()].sort((a, b) => b.visitors - a.visitors).slice(0, 50), reliability, loads,
  };
}
