import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCountryFlagUrl, getCountryName } from "../../lib/country";
import { formatNumber } from "../../lib/format";

interface TopRouteRow {
  path: string;
  count: number;
}

interface RecentEventRow {
  timestamp: string;
  event: string;
  path: string;
  country: string | null;
  selectedCountry: string | null;
  distinctId: string;
  mapsTab: string | null;
  rankingsPage: string | null;
  profileUsername: string | null;
}

interface CountryRow {
  country: string;
  count: number;
}

interface TopProfileRow {
  username: string;
  views: number;
}

interface TopReplayRow {
  scoreId: string;
  title: string | null;
  artist: string | null;
  difficulty: string | null;
  player: string | null;
  coverUrl: string | null;
  views: number;
}

interface ReferrerRow {
  domain: string;
  count: number;
}

interface ServerErrorRow {
  caller: string;
  path: string;
  status: number | null;
  count: number;
}

interface RecentServerErrorRow {
  timestamp: string;
  caller: string;
  path: string;
  status: number | null;
  bodyPreview: string | null;
  attempts: number | null;
  kind: string | null;
}

interface BounceStats {
  bounced: number;
  landers: number;
}

const RANGES = ["1h", "24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];

const RANGE_SQL: Record<Range, string> = {
  "1h": "now() - interval 1 hour",
  "24h": "now() - interval 1 day",
  "7d": "now() - interval 7 day",
  "30d": "now() - interval 30 day",
};

const RANGE_LABEL: Record<Range, string> = {
  "1h": "Last hour",
  "24h": "Last 24h",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

function isRange(value: unknown): value is Range {
  return typeof value === "string" && (RANGES as readonly string[]).includes(value);
}

interface MonitorData {
  range: Range;
  activeVisitors: number;
  pageviewsInRange: number;
  uniqueVisitorsInRange: number;
  eventsInRange: number;
  bounce: BounceStats;
  topRoutes: TopRouteRow[];
  recentEvents: RecentEventRow[];
  topPhysicalCountries: CountryRow[];
  topSelectedCountries: CountryRow[];
  topProfiles: TopProfileRow[];
  topReplays: TopReplayRow[];
  topReferrers: ReferrerRow[];
  serverErrors: ServerErrorRow[];
  recentServerErrors: RecentServerErrorRow[];
  fetchedAt: number;
}

const getMonitorData = createServerFn({ method: "GET" })
  .inputValidator((data: { range?: string }) => ({
    range: isRange(data?.range) ? data.range : ("24h" as Range),
  }))
  .handler(async ({ data }: { data: { range: Range } }): Promise<MonitorData> => {
    const isDevMode = process.env.VITE_DEV_MODE === "1" || process.env.NODE_ENV !== "production";
    if (!isDevMode) {
      throw new Error("Situation monitor is dev-only.");
    }

    const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
    const projectId = process.env.POSTHOG_PROJECT_ID;
    if (!apiKey || !projectId) {
      throw new Error("Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in .env to use the monitor.");
    }

    const endpoint = `https://us.posthog.com/api/projects/${projectId}/query/`;
    const since = RANGE_SQL[data.range];

    async function runQuery(query: string): Promise<unknown[][]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`PostHog query failed (${res.status}): ${text.slice(0, 400)}`);
      }
      const body = (await res.json()) as { results?: unknown[][] };
      return body.results ?? [];
    }

    const [
      active,
      pvRange,
      uvRange,
      eventsRange,
      topRoutes,
      recent,
      topPhysCountries,
      topSelCountries,
      topProfiles,
      topReplays,
      topReferrers,
      serverErrors,
      recentServerErrors,
      bounce,
    ] = await Promise.all([
      runQuery(`SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > now() - interval 5 minute`),
      runQuery(`SELECT count() FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$pathname NOT LIKE '/admin/%'`),
      runQuery(`SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > ${since}`),
      runQuery(`SELECT count() FROM events WHERE timestamp > ${since}`),
      runQuery(
        `SELECT properties.$pathname AS p, count() AS c FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$pathname IS NOT NULL AND properties.$pathname != '/' AND properties.$pathname NOT LIKE '/admin/%' GROUP BY p ORDER BY c DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT formatDateTime(toTimeZone(timestamp, 'America/Costa_Rica'), '%h:%i:%S %p'), event, properties.$pathname, properties.$geoip_country_code, properties.selected_country, distinct_id, properties.maps_tab, properties.rankings_page, properties.profile_username FROM events WHERE distinct_id != 'server' AND (properties.$pathname IS NULL OR properties.$pathname NOT LIKE '/admin/%') ORDER BY timestamp DESC LIMIT 30`,
      ),
      runQuery(
        `SELECT properties.$geoip_country_code AS c, count(DISTINCT distinct_id) AS n FROM events WHERE timestamp > ${since} AND properties.$geoip_country_code IS NOT NULL GROUP BY c ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.selected_country AS c, count() AS n FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.selected_country IS NOT NULL GROUP BY c ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.profile_username AS u, count() AS n FROM events WHERE event = '$pageview' AND properties.profile_username IS NOT NULL AND timestamp > ${since} GROUP BY u ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.replay_score_id AS score_id, any(properties.replay_title) AS title, any(properties.replay_artist) AS artist, any(properties.replay_difficulty) AS difficulty, any(properties.replay_player) AS player, any(properties.replay_cover_url) AS cover_url, count() AS n FROM events WHERE event = 'replay_view' AND properties.replay_score_id IS NOT NULL AND timestamp > ${since} GROUP BY score_id ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.$referring_domain AS d, count(DISTINCT distinct_id) AS n FROM events WHERE event = '$pageview' AND timestamp > ${since} AND properties.$referring_domain IS NOT NULL AND properties.$referring_domain NOT IN ('localhost', '127.0.0.1', '::1') AND properties.$referring_domain NOT LIKE '%-aleju03s-projects.vercel.app' GROUP BY d ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT properties.caller AS c, properties.path AS p, properties.status AS s, count() AS n FROM events WHERE event = 'osu_api_error' AND timestamp > ${since} AND properties.caller IS NOT NULL GROUP BY c, p, s ORDER BY n DESC LIMIT 10`,
      ),
      runQuery(
        `SELECT formatDateTime(toTimeZone(timestamp, 'America/Costa_Rica'), '%h:%i:%S %p'), properties.caller, properties.path, properties.status, properties.body_preview, properties.attempts, properties.kind FROM events WHERE event = 'osu_api_error' AND timestamp > ${since} AND properties.caller IS NOT NULL ORDER BY timestamp DESC LIMIT 15`,
      ),
      runQuery(
        `SELECT countIf(pv_count = 1) AS bounced, count() AS landers FROM (SELECT distinct_id, count() AS pv_count FROM events WHERE event = '$pageview' AND timestamp > ${since} GROUP BY distinct_id HAVING countIf(properties.$pathname = '/') > 0)`,
      ),
    ]);

    return {
      range: data.range,
      activeVisitors: Number(active[0]?.[0] ?? 0),
      pageviewsInRange: Number(pvRange[0]?.[0] ?? 0),
      uniqueVisitorsInRange: Number(uvRange[0]?.[0] ?? 0),
      eventsInRange: Number(eventsRange[0]?.[0] ?? 0),
      bounce: {
        bounced: Number(bounce[0]?.[0] ?? 0),
        landers: Number(bounce[0]?.[1] ?? 0),
      },
      topRoutes: topRoutes.map((row) => ({
        path: String(row[0] ?? ""),
        count: Number(row[1] ?? 0),
      })),
      recentEvents: recent.map((row) => ({
        timestamp: String(row[0] ?? ""),
        event: String(row[1] ?? ""),
        path: String(row[2] ?? ""),
        country: row[3] ? String(row[3]) : null,
        selectedCountry: row[4] ? String(row[4]) : null,
        distinctId: String(row[5] ?? ""),
        mapsTab: row[6] ? String(row[6]) : null,
        rankingsPage: row[7] ? String(row[7]) : null,
        profileUsername: row[8] ? String(row[8]) : null,
      })),
      topPhysicalCountries: topPhysCountries.map((row) => ({
        country: String(row[0] ?? ""),
        count: Number(row[1] ?? 0),
      })),
      topSelectedCountries: topSelCountries.map((row) => ({
        country: String(row[0] ?? ""),
        count: Number(row[1] ?? 0),
      })),
      topProfiles: topProfiles.map((row) => ({
        username: String(row[0] ?? ""),
        views: Number(row[1] ?? 0),
      })),
      topReplays: topReplays.map((row) => ({
        scoreId: String(row[0] ?? ""),
        title: row[1] ? String(row[1]) : null,
        artist: row[2] ? String(row[2]) : null,
        difficulty: row[3] ? String(row[3]) : null,
        player: row[4] ? String(row[4]) : null,
        coverUrl: row[5] ? String(row[5]) : null,
        views: Number(row[6] ?? 0),
      })),
      topReferrers: topReferrers.map((row) => ({
        domain: String(row[0] ?? ""),
        count: Number(row[1] ?? 0),
      })),
      serverErrors: serverErrors.map((row) => ({
        caller: row[0] ? String(row[0]) : "unknown",
        path: String(row[1] ?? ""),
        status: row[2] == null ? null : Number(row[2]),
        count: Number(row[3] ?? 0),
      })),
      recentServerErrors: recentServerErrors.map((row) => ({
        timestamp: String(row[0] ?? ""),
        caller: row[1] ? String(row[1]) : "unknown",
        path: String(row[2] ?? ""),
        status: row[3] == null ? null : Number(row[3]),
        bodyPreview: row[4] ? String(row[4]) : null,
        attempts: row[5] == null ? null : Number(row[5]),
        kind: row[6] ? String(row[6]) : null,
      })),
      fetchedAt: Date.now(),
    };
  });

export const Route = createFileRoute("/admin/monitor")({
  beforeLoad: () => {
    if (typeof window !== "undefined") {
      const host = window.location.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const isDevMode = import.meta.env.VITE_DEV_MODE === "1";
      if (!isLocal && !isDevMode) throw notFound();
    } else if (process.env.VITE_DEV_MODE !== "1" && process.env.NODE_ENV === "production") {
      throw notFound();
    }
  },
  component: MonitorPage,
});

const REFRESH_MS = 15_000;
const RANGE_STORAGE_KEY = "mh_monitor_range";

function MonitorPage() {
  // Start at the SSR default so the server render and the client
  // hydration agree; the stored preference is applied in an effect
  // below. This avoids a hydration mismatch where the selector
  // visually stays on "Last 24h" even though state is the stored value.
  const [range, setRangeState] = useState<Range>("24h");
  const [hydrated, setHydrated] = useState(false);
  const setRange = useCallback((next: Range) => {
    setRangeState(next);
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
      if (stored && (RANGES as readonly string[]).includes(stored)) {
        setRangeState(stored as Range);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);
  const [data, setData] = useState<MonitorData | null>(null);
  const [dataRange, setDataRange] = useState<Range | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (targetRange: Range, isInitial: boolean) => {
      const requestId = ++requestIdRef.current;
      if (!isInitial) setRefreshing(true);
      try {
        const result = await getMonitorData({ data: { range: targetRange } });
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setData(result);
        setDataRange(targetRange);
        setError(null);
      } catch (e) {
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void load(range, true);
  }, [hydrated, range, load]);

  useEffect(() => {
    if (!hydrated) return;
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void load(range, false);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [hydrated, autoRefresh, range, load]);

  return (
    <div className="flex-1">
      <MonitorHeader
        fetchedAt={data?.fetchedAt ?? null}
        refreshing={refreshing}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
        onRefresh={() => void load(range, false)}
      />
      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-5">
          <RangeSelector range={range} onChange={setRange} />
          {error ? <ErrorBanner message={error} /> : null}
          {data && dataRange === range ? (
            <>
              <KpiRow data={data} range={range} />
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                <div className="lg:col-span-3 flex">
                  <TopRoutesCard rows={data.topRoutes} range={range} />
                </div>
                <div className="lg:col-span-2 flex">
                  <RecentEventsCard rows={data.recentEvents} />
                </div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <CountriesCard
                  title="Physical country"
                  subtitle={`unique visitors, ${RANGE_LABEL[range].toLowerCase()}`}
                  rows={data.topPhysicalCountries}
                />
                <CountriesCard
                  title="Selected country"
                  subtitle={`pageviews, ${RANGE_LABEL[range].toLowerCase()}`}
                  rows={data.topSelectedCountries}
                />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <TopProfilesCard rows={data.topProfiles} range={range} />
                <TopReplaysCard rows={data.topReplays} range={range} />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ReferrersCard rows={data.topReferrers} range={range} />
                <ServerErrorsCard
                  rows={data.serverErrors}
                  recent={data.recentServerErrors}
                  range={range}
                />
              </div>
            </>
          ) : (
            <LoadingGrid />
          )}
        </div>
      </div>
    </div>
  );
}

function RangeSelector({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Range</div>
      <div className="flex items-center gap-1 rounded-lg bg-osu-b4/40 border border-osu-b3/30 p-1">
        {RANGES.map((r) => {
          const active = r === range;
          return (
            <button
              key={r}
              onClick={() => onChange(r)}
              className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors duration-[120ms] cursor-pointer ${
                active
                  ? "bg-osu-pink/20 text-white"
                  : "text-osu-l2 hover:text-white hover:bg-osu-b3/40"
              }`}
            >
              {RANGE_LABEL[r]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MonitorHeader({
  fetchedAt,
  refreshing,
  autoRefresh,
  onToggleAutoRefresh,
  onRefresh,
}: {
  fetchedAt: number | null;
  refreshing: boolean;
  autoRefresh: boolean;
  onToggleAutoRefresh: () => void;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const age = fetchedAt ? Math.max(0, Math.round((now - fetchedAt) / 1000)) : null;

  return (
    <div className="bg-osu-d5 border-b border-osu-b3/40">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
        <div className="relative flex-shrink-0">
          <span
            className={`block w-2.5 h-2.5 rounded-full ${
              autoRefresh ? "bg-osu-green-light" : "bg-osu-f1"
            }`}
          />
          {autoRefresh ? (
            <span className="absolute inset-0 rounded-full bg-osu-green-light animate-ping opacity-75" />
          ) : null}
        </div>
        <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Situation monitor</h2>
        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-osu-yellow/15 text-osu-yellow">
          dev
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
          {fetchedAt ? (
            <span className={refreshing ? "text-osu-pink-light" : ""}>
              {refreshing ? "refreshing..." : age != null ? `updated ${age}s ago` : ""}
            </span>
          ) : null}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            Refresh
          </button>
          <button
            onClick={onToggleAutoRefresh}
            className={`px-2.5 py-1 rounded-md border transition-colors duration-[120ms] cursor-pointer ${
              autoRefresh
                ? "bg-osu-pink/15 border-osu-pink/30 text-white"
                : "bg-osu-b4/60 border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
            }`}
          >
            Auto {autoRefresh ? "on" : "off"}
          </button>
        </div>
      </div>
    </div>
  );
}

function KpiRow({ data, range }: { data: MonitorData; range: Range }) {
  const hint = RANGE_LABEL[range].toLowerCase();
  const bouncePct =
    data.bounce.landers > 0
      ? Math.round((data.bounce.bounced / data.bounce.landers) * 100)
      : null;
  const bounceLabel = bouncePct == null ? "—" : `${bouncePct}%`;
  const bounceHint =
    data.bounce.landers > 0
      ? `${formatNumber(data.bounce.bounced)} / ${formatNumber(data.bounce.landers)} landers`
      : `no / landers ${hint}`;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      <KpiCard label="Active now" hint="last 5 min" value={data.activeVisitors} accent="pink" />
      <KpiCard label="Pageviews" hint={hint} value={data.pageviewsInRange} />
      <KpiCard label="Visitors" hint={hint} value={data.uniqueVisitorsInRange} />
      <KpiCard label="Events" hint={hint} value={data.eventsInRange} />
      <KpiCard label="Bounce /" hint={bounceHint} display={bounceLabel} />
    </div>
  );
}

function KpiCard({
  label,
  hint,
  value,
  display,
  accent,
}: {
  label: string;
  hint: string;
  value?: number;
  display?: string;
  accent?: "pink";
}) {
  const rendered = display ?? (value != null ? formatNumber(value) : "—");
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        accent === "pink"
          ? "bg-osu-pink/10 border-osu-pink/25"
          : "bg-osu-b4/40 border-osu-b3/30"
      }`}
    >
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
      <div
        className={`text-3xl font-bold tracking-tight leading-none mt-1 ${
          accent === "pink" ? "text-osu-pink-light" : "text-white"
        }`}
      >
        {rendered}
      </div>
      <div className="text-[10px] text-osu-f1 mt-1.5">{hint}</div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 overflow-hidden flex flex-col w-full">
      <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20">
        <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</div>
        {subtitle ? <div className="text-[10px] text-osu-f1 mt-0.5">{subtitle}</div> : null}
      </div>
      <div className="p-3 flex-1 min-h-0">{children}</div>
    </div>
  );
}

function TopRoutesCard({ rows, range }: { rows: TopRouteRow[]; range: Range }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <SectionCard title="Top routes" subtitle={`pageviews, ${RANGE_LABEL[range].toLowerCase()}`}>
      {rows.length === 0 ? (
        <EmptyMessage text="No pageviews today yet." />
      ) : (
        <div className="flex flex-col gap-1.5 h-full">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.count / max) * 100));
            return (
              <div
                key={row.path}
                className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden flex-1 min-h-[32px]"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-pink/25 to-osu-pink/10"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative px-3 h-full flex items-center justify-between gap-3">
                  <span className="text-[11px] font-mono text-osu-c2 truncate">
                    {row.path || "(unknown)"}
                  </span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">
                    {formatNumber(row.count)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function formatRecentEventLabel(row: RecentEventRow): string {
  const path = row.path || "";
  if (!path || path === "/") return "Home";
  if (path === "/maps") {
    return row.mapsTab ? `Maps · ${row.mapsTab}` : "Maps";
  }
  if (path === "/rankings") {
    return row.rankingsPage ? `Rankings · p${row.rankingsPage}` : "Rankings";
  }
  if (path.startsWith("/player/")) {
    return row.profileUsername ? `Player · ${row.profileUsername}` : "Player";
  }
  if (path === "/top-plays") return "Top plays";
  if (path === "/tracker") return "Tracker";
  if (path === "/replay") return "Replay";
  if (path === "/snipes") return "Snipes";
  return path;
}

// Distinct but readable accent colors for the visitor column. Each
// unique distinct_id in the current batch gets assigned a slot in
// first-seen order, wrapping around if there are more visitors than
// colors. Same device always renders with the same color within one
// render, so bursts from a single visitor are easy to spot.
const VISITOR_COLORS = [
  { bg: "bg-osu-pink/15", text: "text-osu-pink-light", dot: "bg-osu-pink" },
  { bg: "bg-osu-blue/15", text: "text-osu-blue", dot: "bg-osu-blue" },
  { bg: "bg-osu-green-light/15", text: "text-osu-green-light", dot: "bg-osu-green-light" },
  { bg: "bg-osu-yellow/15", text: "text-osu-yellow", dot: "bg-osu-yellow" },
  { bg: "bg-osu-c2/15", text: "text-osu-c2", dot: "bg-osu-c2" },
  { bg: "bg-osu-red-light/15", text: "text-osu-red-light", dot: "bg-osu-red-light" },
] as const;

function buildVisitorPalette(rows: RecentEventRow[]): Map<string, { slot: number; label: string }> {
  const palette = new Map<string, { slot: number; label: string }>();
  let nextSlot = 0;
  for (const row of rows) {
    const id = row.distinctId;
    if (!id || palette.has(id)) continue;
    palette.set(id, { slot: nextSlot, label: `V${nextSlot + 1}` });
    nextSlot += 1;
  }
  return palette;
}

function RecentEventsCard({ rows }: { rows: RecentEventRow[] }) {
  const visitorPalette = useMemo(() => buildVisitorPalette(rows), [rows]);
  const visitorCount = visitorPalette.size;
  return (
    <SectionCard
      title="Recent events"
      subtitle={`last 30 from ${visitorCount} visitor${visitorCount === 1 ? "" : "s"}`}
    >
      {rows.length === 0 ? (
        <EmptyMessage text="No events captured yet." />
      ) : (
        <div className="space-y-1 h-full max-h-[420px] overflow-y-auto pr-1">
          {rows.map((row, i) => {
            const when = row.timestamp || "—";
            const label = formatRecentEventLabel(row);
            const entry = row.distinctId ? visitorPalette.get(row.distinctId) : undefined;
            const color = entry ? VISITOR_COLORS[entry.slot % VISITOR_COLORS.length] : null;
            const visitorLabel = entry?.label ?? "—";
            return (
              <div
                key={`${row.timestamp}-${i}`}
                className="flex items-center gap-2 text-[10px] py-1.5 px-2 rounded-md hover:bg-osu-b3/30 transition-colors duration-[100ms]"
                title={
                  row.distinctId
                    ? `visitor id: ${row.distinctId}${row.path ? ` · ${row.path}` : ""}`
                    : row.path || ""
                }
              >
                <span className={`w-1 self-stretch rounded-full flex-shrink-0 ${color?.dot ?? "bg-osu-b3/40"}`} />
                <span className="text-osu-f1 font-mono w-20 flex-shrink-0">{when}</span>
                {row.country ? (
                  <img
                    src={getCountryFlagUrl(row.country)}
                    alt={row.country}
                    className="w-[14px] h-[10px] object-cover rounded-[1px] flex-shrink-0"
                    loading="lazy"
                  />
                ) : (
                  <span className="w-[14px] h-[10px] rounded-[1px] bg-osu-b3/40 flex-shrink-0" />
                )}
                <span className="text-osu-c2 truncate flex-1">{label}</span>
                <span
                  className={`font-mono font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${
                    color ? `${color.bg} ${color.text}` : "text-osu-f1"
                  }`}
                >
                  {visitorLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function CountriesCard({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: CountryRow[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <SectionCard title={title} subtitle={subtitle}>
      {rows.length === 0 ? (
        <EmptyMessage text="No country data yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.count / max) * 100));
            const code = row.country.toUpperCase();
            return (
              <div
                key={code}
                className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-blue/20 to-osu-blue/5"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative px-3 py-2 flex items-center gap-2.5">
                  <img
                    src={getCountryFlagUrl(code)}
                    alt={code}
                    className="w-[18px] h-[12px] object-cover rounded-[1px] flex-shrink-0"
                    loading="lazy"
                  />
                  <span className="text-[11px] text-osu-c2 flex-1 truncate">
                    {getCountryName(code) || code}
                  </span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">
                    {formatNumber(row.count)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function TopProfilesCard({ rows, range }: { rows: TopProfileRow[]; range: Range }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <SectionCard title="Top profile visits" subtitle={RANGE_LABEL[range].toLowerCase()}>
      {rows.length === 0 ? (
        <EmptyMessage text="No profile visits yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.views / max) * 100));
            return (
              <div
                key={row.username}
                className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-purple/20 to-osu-purple/5"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative px-3 py-2 flex items-center justify-between gap-3">
                  <span className="text-[11px] text-osu-c2 truncate">{row.username}</span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">
                    {formatNumber(row.views)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function TopReplaysCard({ rows, range }: { rows: TopReplayRow[]; range: Range }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <SectionCard
      title="Top replay views"
      subtitle={`each open costs origin-transfer bandwidth, ${RANGE_LABEL[range].toLowerCase()}`}
    >
      {rows.length === 0 ? (
        <EmptyMessage text="No replays opened yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.views / max) * 100));
            const primary =
              row.title && row.artist
                ? `${row.artist} - ${row.title}`
                : row.title ?? `#${row.scoreId.slice(-6)}`;
            return (
              <div
                key={row.scoreId}
                className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-yellow/20 to-osu-yellow/5"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative px-2 py-1.5 flex items-center gap-2.5 min-w-0">
                  {row.coverUrl ? (
                    <img
                      src={row.coverUrl}
                      alt=""
                      className="w-[56px] h-[34px] object-cover rounded-[2px] flex-shrink-0 border border-osu-b3/30"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-[56px] h-[34px] rounded-[2px] bg-osu-b3/30 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="text-[11px] text-white truncate font-medium">{primary}</div>
                    <div className="text-[9px] text-osu-f1 truncate mt-0.5">
                      {row.difficulty ? (
                        <span className="text-osu-c2">[{row.difficulty}]</span>
                      ) : null}
                      {row.difficulty && row.player ? " · " : null}
                      {row.player ?? null}
                    </div>
                  </div>
                  <span className="text-[12px] font-bold text-white flex-shrink-0">
                    {formatNumber(row.views)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

const FRIENDLY_REFERRER_LABELS: Record<string, string> = {
  $direct: "Direct visit (typed URL, bookmark, app)",
  "google.com": "Google Search",
  "www.google.com": "Google Search",
  "google.co.uk": "Google Search",
  "google.com.br": "Google Search",
  "duckduckgo.com": "DuckDuckGo",
  "bing.com": "Bing",
  "osu.ppy.sh": "osu! site",
  "old.reddit.com": "Reddit",
  "www.reddit.com": "Reddit",
  "reddit.com": "Reddit",
  "out.reddit.com": "Reddit (link out)",
  "t.co": "Twitter / X",
  "x.com": "Twitter / X",
  "twitter.com": "Twitter / X",
  "discord.com": "Discord",
  "discordapp.com": "Discord",
  "www.youtube.com": "YouTube",
  "youtube.com": "YouTube",
  "m.youtube.com": "YouTube (mobile)",
  "github.com": "GitHub",
};

function formatReferrerLabel(domain: string): string {
  const friendly = FRIENDLY_REFERRER_LABELS[domain];
  if (friendly) return friendly;
  if (/-aleju03s-projects\.vercel\.app$/.test(domain)) {
    return `${domain.replace(/^maniacr-tracker-/, "")} (preview)`;
  }
  if (domain.endsWith(".vercel.app")) return `${domain} (vercel)`;
  return domain.replace(/^www\./, "");
}

function ReferrersCard({ rows, range }: { rows: ReferrerRow[]; range: Range }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <SectionCard
      title="Top referrers"
      subtitle={`unique visitors by referring domain (excluding localhost), ${RANGE_LABEL[range].toLowerCase()}`}
    >
      {rows.length === 0 ? (
        <EmptyMessage text="No external referrers captured yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const pct = Math.max(3, Math.round((row.count / max) * 100));
            const label = formatReferrerLabel(row.domain);
            const isDirect = row.domain === "$direct";
            return (
              <div
                key={row.domain}
                className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden"
                title={isDirect ? "" : row.domain}
              >
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-green-light/20 to-osu-green-light/5"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative px-3 py-2 flex items-center justify-between gap-3">
                  <span
                    className={`text-[11px] truncate ${
                      isDirect ? "italic text-osu-f1" : "text-osu-c2"
                    }`}
                  >
                    {label}
                  </span>
                  <span className="text-[11px] font-bold text-white flex-shrink-0">
                    {formatNumber(row.count)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function statusColorClass(status: number | null): string {
  if (status == null || status >= 500) return "text-osu-red-light";
  if (status === 429) return "text-osu-yellow";
  if (status === 401 || status === 403) return "text-osu-pink-light";
  if (status === 404) return "text-osu-l2";
  return "text-osu-c2";
}

function ServerErrorsCard({
  rows,
  recent,
  range,
}: {
  rows: ServerErrorRow[];
  recent: RecentServerErrorRow[];
  range: Range;
}) {
  const total = rows.reduce((acc, row) => acc + row.count, 0);
  const callerCounts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.caller] = (acc[row.caller] ?? 0) + row.count;
    return acc;
  }, {});
  const callerSummary = Object.entries(callerCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([caller, count]) => `${caller}×${count}`)
    .join("  ");

  return (
    <SectionCard
      title="Server errors"
      subtitle={`osu! API failures by caller + status, ${RANGE_LABEL[range].toLowerCase()}`}
    >
      {rows.length === 0 && recent.length === 0 ? (
        <EmptyMessage text="No server errors recorded. (good)" />
      ) : (
        <div className="space-y-3">
          <div className="text-[10px] text-osu-f1 font-mono">
            {formatNumber(total)} total
            {callerSummary ? (
              <span className="ml-2 text-osu-l2/70">· {callerSummary}</span>
            ) : null}
          </div>

          {rows.length > 0 ? (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-1.5">
                Grouped
              </div>
              <div className="space-y-1.5">
                {rows.map((row, i) => {
                  const statusLabel =
                    row.status == null ? "no-resp" : String(row.status);
                  return (
                    <div
                      key={`${row.caller}-${row.path}-${row.status ?? "x"}-${i}`}
                      className="relative rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden"
                    >
                      <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-osu-red/20 to-osu-red/5 w-full" />
                      <div className="relative px-2.5 py-1.5 flex items-center gap-2 min-w-0">
                        <span
                          className={`text-[10px] font-mono font-bold ${statusColorClass(row.status)} w-12 flex-shrink-0 text-right`}
                        >
                          {statusLabel}
                        </span>
                        <span className="text-[11px] text-white font-medium truncate flex-shrink-0 max-w-[40%]">
                          {row.caller || "unknown"}
                        </span>
                        <span className="text-[10px] font-mono text-osu-f1 truncate flex-1 min-w-0">
                          {row.path || "(unknown)"}
                        </span>
                        <span className="text-[11px] font-bold text-white flex-shrink-0">
                          {formatNumber(row.count)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {recent.length > 0 ? (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold mb-1.5">
                Recent (last {recent.length})
              </div>
              <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {recent.map((row, i) => {
                  const when = row.timestamp || "—";
                  const statusLabel =
                    row.status == null ? "no-resp" : String(row.status);
                  return (
                    <div
                      key={`${row.timestamp}-${i}`}
                      className="rounded-md bg-osu-b5/60 border border-osu-b3/20 overflow-hidden"
                    >
                      <div className="px-2.5 py-1.5 flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-mono text-osu-f1 w-20 flex-shrink-0">
                          {when}
                        </span>
                        <span
                          className={`text-[10px] font-mono font-bold ${statusColorClass(row.status)} w-10 flex-shrink-0 text-right`}
                        >
                          {statusLabel}
                        </span>
                        <span className="text-[11px] text-white font-medium truncate flex-shrink-0 max-w-[35%]">
                          {row.caller || "unknown"}
                        </span>
                        <span className="text-[10px] font-mono text-osu-f1 truncate flex-1 min-w-0">
                          {row.path || "(unknown)"}
                        </span>
                        {row.attempts != null && row.attempts > 1 ? (
                          <span className="text-[9px] font-mono text-osu-yellow flex-shrink-0">
                            ×{row.attempts}
                          </span>
                        ) : null}
                      </div>
                      {row.bodyPreview ? (
                        <div className="px-2.5 pb-1.5 -mt-0.5 text-[10px] font-mono text-osu-l2/70 break-all">
                          {row.bodyPreview}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function LoadingGrid() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton-pulse rounded-lg h-[88px]" />
        ))}
      </div>
      <div className="skeleton-pulse rounded-lg h-[260px]" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="skeleton-pulse rounded-lg h-[320px]" />
        <div className="skeleton-pulse rounded-lg h-[320px]" />
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-red-light">
        Monitor error
      </div>
      <div className="text-[12px] text-osu-l2 mt-1 break-words">{message}</div>
    </div>
  );
}

function EmptyMessage({ text }: { text: string }) {
  return <div className="text-[11px] text-osu-f1 text-center py-6">{text}</div>;
}
