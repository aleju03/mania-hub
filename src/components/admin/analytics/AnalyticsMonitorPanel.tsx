import { BarChart3, RefreshCw, Radio } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLiveBackendUrl } from "../../../lib/live-backend";
import { formatTimeAgo } from "../../../lib/format";
import {
  prependPendingAnalyticsEvent,
  reconcileAnalyticsRecentEvents,
  type PendingAnalyticsRecentEvent,
} from "../../../lib/analytics-recent";
import {
  buildAnalyticsReplayMapIndex,
  buildAnalyticsSessions,
  type AnalyticsRecentEventRow,
} from "../../../lib/analytics-feed";
import {
  ANALYTICS_COLD_RESPONSE_BUDGET_MS,
  ANALYTICS_DEFAULT_RANGE_HOURS,
  ANALYTICS_RANGE_STORAGE_KEY,
  ANALYTICS_RECENT_EVENTS_LIMIT,
  ANALYTICS_REFRESH_MS,
  clampAnalyticsRangeHours,
  parseAnalyticsRangeHours,
  type AnalyticsCountryRow,
  type AnalyticsMonitorData,
  type AnalyticsRange,
} from "../../../lib/analytics-monitor";
import { getAnalyticsLiveTicket, getAnalyticsMonitorData } from "../../../lib/analytics-monitor-data";
import { AnalyticsInsights } from "./AnalyticsInsights";
import { AnalyticsLiveBoard } from "./AnalyticsLiveBoard";
import { AnalyticsPulse } from "./AnalyticsPulse";
import { AnalyticsRangeSelector } from "./AnalyticsRangeSelector";
import { AnalyticsStream } from "./AnalyticsStream";
import { AnalyticsErrorBanner, AnalyticsInfoBanner, useTickingNow } from "./shared";

const ANALYTICS_VIEW_STORAGE_KEY = "mh_monitor_view";
type AnalyticsView = "live" | "insights";

export function AnalyticsMonitorPanel() {
  const [range, setRangeState] = useState<AnalyticsRange>(ANALYTICS_DEFAULT_RANGE_HOURS);
  const [view, setView] = useState<AnalyticsView>("live");
  const [recentCountry, setRecentCountry] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [data, setData] = useState<AnalyticsMonitorData | null>(null);
  const [dataRange, setDataRange] = useState<AnalyticsRange | null>(null);
  const [dataRecentCountry, setDataRecentCountry] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [liveFeedConnected, setLiveFeedConnected] = useState(false);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const pendingRecentEventsRef = useRef<Array<PendingAnalyticsRecentEvent<AnalyticsRecentEventRow>>>([]);
  // Read by the SSE handler so a country-filter change doesn't tear down the
  // stream just to change which events get prepended.
  const recentCountryRef = useRef(recentCountry);
  recentCountryRef.current = recentCountry;
  const now = useTickingNow(1_000);

  const setRange = useCallback((next: AnalyticsRange) => {
    const normalized = clampAnalyticsRangeHours(next);
    setRangeState(normalized);
    setRecentCountry(null);
    try {
      window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, String(normalized));
    } catch {
      // ignore
    }
  }, []);

  const selectView = useCallback((next: AnalyticsView) => {
    setView(next);
    try {
      window.localStorage.setItem(ANALYTICS_VIEW_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const load = useCallback(
    async (targetRange: AnalyticsRange, targetRecentCountry: string | null, isInitial: boolean) => {
      const requestId = ++requestIdRef.current;
      if (!isInitial) setRefreshing(true);
      try {
        const result = await getAnalyticsMonitorData({ data: { rangeHours: targetRange, recentCountry: targetRecentCountry } });
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        // Live SSE rows stay overlaid on the snapshot until it returns the
        // same event ID, so a just-captured event never blinks out.
        const reconciled = reconcileAnalyticsRecentEvents({
          snapshot: result.recentEvents,
          pending: pendingRecentEventsRef.current,
          country: targetRecentCountry,
          now: Date.now(),
          limit: ANALYTICS_RECENT_EVENTS_LIMIT,
        });
        pendingRecentEventsRef.current = reconciled.pending;
        setData({ ...result, recentEvents: reconciled.rows });
        setDataRange(targetRange);
        setDataRecentCountry(targetRecentCountry);
        setError(null);
        hasLoadedRef.current = true;
        if (result.cacheState !== "fresh") {
          window.setTimeout(() => {
            if (!mountedRef.current) return;
            if (requestId !== requestIdRef.current) return;
            void load(targetRange, targetRecentCountry, false);
          }, ANALYTICS_COLD_RESPONSE_BUDGET_MS);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Could not load analytics monitoring.");
      } finally {
        if (!mountedRef.current) return;
        if (requestId !== requestIdRef.current) return;
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    try {
      const storedRange = parseAnalyticsRangeHours(window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY));
      if (storedRange) setRangeState(storedRange);
      const storedView = window.localStorage.getItem(ANALYTICS_VIEW_STORAGE_KEY);
      if (storedView === "live" || storedView === "insights") setView(storedView);
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const delay = hasLoadedRef.current ? 250 : 0;
    const id = window.setTimeout(() => {
      void load(range, recentCountry, true);
    }, delay);
    return () => window.clearTimeout(id);
  }, [hydrated, range, recentCountry, load]);

  useEffect(() => {
    if (!hydrated) return;
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      void load(range, recentCountry, false);
    }, ANALYTICS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [hydrated, autoRefresh, range, recentCountry, load]);

  // Realtime feed: stream every accepted event into the activity feed the
  // moment it's captured. Polling still refreshes the aggregates.
  const liveFeedWanted = hydrated && autoRefresh;
  useEffect(() => {
    if (!liveFeedWanted) return;
    const base = getLiveBackendUrl();
    if (!base) return;
    let stopped = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;

    const scheduleReconnect = () => {
      if (stopped || retryTimer != null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, 5_000);
    };

    const connect = async () => {
      let ticket: string | null = null;
      try {
        ticket = (await getAnalyticsLiveTicket())?.ticket ?? null;
      } catch {
        ticket = null;
      }
      if (stopped) return;
      if (!ticket) {
        scheduleReconnect();
        return;
      }
      source = new EventSource(`${base}/api/admin/analytics/live?ticket=${encodeURIComponent(ticket)}`);
      source.addEventListener("open", () => {
        if (!stopped) setLiveFeedConnected(true);
      });
      source.addEventListener("analytics_event", (event) => {
        if (stopped) return;
        let row: AnalyticsRecentEventRow;
        try {
          row = JSON.parse((event as MessageEvent).data) as AnalyticsRecentEventRow;
        } catch {
          return;
        }
        pendingRecentEventsRef.current = prependPendingAnalyticsEvent(
          pendingRecentEventsRef.current,
          row,
          Date.now(),
          ANALYTICS_RECENT_EVENTS_LIMIT,
        );
        const countryFilter = recentCountryRef.current;
        if (countryFilter && row.country !== countryFilter) return;
        setData((prev) => {
          if (!prev) return prev;
          if (row.eventId && prev.recentEvents.some((entry) => entry.eventId === row.eventId)) return prev;
          return {
            ...prev,
            recentEvents: [row, ...prev.recentEvents].slice(0, ANALYTICS_RECENT_EVENTS_LIMIT),
          };
        });
      });
      source.onerror = () => {
        // EventSource's built-in retry would replay the same (soon-expired)
        // ticket; close and reconnect through a fresh one instead.
        source?.close();
        source = null;
        if (stopped) return;
        setLiveFeedConnected(false);
        scheduleReconnect();
      };
    };

    void connect();
    return () => {
      stopped = true;
      setLiveFeedConnected(false);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [liveFeedWanted]);

  const currentData = data && dataRange === range ? data : null;
  const isRecentCountryPending = Boolean(currentData && dataRecentCountry !== recentCountry);
  const statusData = currentData ?? data;
  const statusText = statusData?.fetchedAt
    ? statusData.cacheState === "warming"
      ? "warming..."
      : refreshing
        ? "refreshing..."
        : statusData.cacheState === "stale"
          ? `cached ${formatTimeAgo(new Date(statusData.fetchedAt).toISOString())}`
          : `updated ${formatTimeAgo(new Date(statusData.fetchedAt).toISOString())}`
    : null;
  const statusColorClass = statusData?.cacheState === "warming" || refreshing
    ? "text-osu-pink-light"
    : statusData?.cacheState === "stale"
      ? "text-osu-yellow"
      : "text-osu-f1";

  const recentEvents = currentData?.recentEvents;
  const replayMaps = useMemo(() => buildAnalyticsReplayMapIndex(recentEvents ?? []), [recentEvents]);
  // Sessions are rebuilt against a coarse clock so a per-second tick doesn't
  // rebuild the whole list; only the online flag depends on `now` at all.
  const sessionClock = Math.floor(now / 15_000);
  const sessions = useMemo(
    () => buildAnalyticsSessions(recentEvents ?? [], sessionClock * 15_000),
    [recentEvents, sessionClock],
  );
  const onlineCountries = useMemo(() => {
    const codes = new Set<string>();
    sessions.forEach((session) => {
      if (session.online && session.country) codes.add(session.country);
    });
    return codes.size;
  }, [sessions]);
  const onlineCount = useMemo(() => sessions.filter((session) => session.online).length, [sessions]);

  const countryOptions = useMemo<AnalyticsCountryRow[]>(() => {
    const byCountry = new Map<string, AnalyticsCountryRow>();
    (currentData?.topPhysicalCountries ?? []).forEach((entry) => {
      const code = entry.country.trim().toUpperCase();
      if (code) byCountry.set(code, { ...entry, country: code });
    });
    if (recentCountry && !byCountry.has(recentCountry)) {
      byCountry.set(recentCountry, { country: recentCountry, count: 0 });
    }
    return Array.from(byCountry.values());
  }, [currentData?.topPhysicalCountries, recentCountry]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center rounded-lg border border-osu-b3/30 bg-osu-b4/40 p-1">
          <ViewButton
            active={view === "live"}
            onClick={() => selectView("live")}
            icon={<Radio className="h-3.5 w-3.5" />}
            label="Live"
            hint="who is here and what they are doing"
          />
          <ViewButton
            active={view === "insights"}
            onClick={() => selectView("insights")}
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Insights"
            hint="totals, sources and errors"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {liveFeedConnected ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-osu-green" title="Streaming events from the in-house analytics store">
              <span className="h-2 w-2 animate-pulse rounded-full bg-osu-green" />
              live
            </span>
          ) : null}
          {statusText ? <span className={`text-[11px] ${statusColorClass}`}>{statusText}</span> : null}
          <button
            type="button"
            onClick={() => void load(range, recentCountry, false)}
            disabled={refreshing}
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-osu-b3/30 bg-osu-b4/60 text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            title="Refresh analytics"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh((value) => !value)}
            className={`cursor-pointer rounded-md border px-2.5 py-1 text-[11px] transition-colors duration-[120ms] ${
              autoRefresh
                ? "border-osu-pink/30 bg-osu-pink/15 text-white"
                : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
            }`}
          >
            Auto {autoRefresh ? "on" : "off"}
          </button>
        </div>
      </div>

      <AnalyticsRangeSelector range={range} onChange={setRange} />
      {error ? <AnalyticsErrorBanner message={error} /> : null}
      {currentData?.cacheState === "warming" ? (
        <AnalyticsInfoBanner message="The analytics store is still preparing this range; the view will fill in automatically." />
      ) : null}

      {currentData ? (
        <>
          <AnalyticsPulse data={currentData} range={range} onlineCountries={onlineCountries} />
          {view === "live" ? (
            <>
              <section className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-osu-c2">Right now</h3>
                  <span className="text-[10px] text-osu-f1">
                    {onlineCount > 0
                      ? `${onlineCount} visitor${onlineCount === 1 ? "" : "s"} active in the last 5 minutes`
                      : "nobody active in the last 5 minutes"}
                  </span>
                </div>
                <AnalyticsLiveBoard sessions={sessions} replayMaps={replayMaps} now={now} />
              </section>
              <AnalyticsStream
                rows={currentData.recentEvents}
                sessions={sessions}
                replayMaps={replayMaps}
                countries={countryOptions}
                country={recentCountry}
                loading={isRecentCountryPending}
                now={now}
                onCountryChange={setRecentCountry}
              />
            </>
          ) : (
            <AnalyticsInsights data={currentData} range={range} />
          )}
        </>
      ) : (
        <AnalyticsLoadingGrid />
      )}
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors duration-[120ms] ${
        active ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function AnalyticsLoadingGrid() {
  return (
    <div className="space-y-4">
      <div className="skeleton-pulse h-[150px] rounded-xl" />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="skeleton-pulse h-[130px] rounded-lg" />
        ))}
      </div>
      <div className="skeleton-pulse h-[420px] rounded-lg" />
    </div>
  );
}
