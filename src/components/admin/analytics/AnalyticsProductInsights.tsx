import { CircleHelp, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  ANALYTICS_DAY_MS,
  ANALYTICS_FEATURES,
  type AnalyticsFeatureUsage,
  type AnalyticsProductInsights as ProductData,
  type AnalyticsProductResponse,
} from "../../../../live-backend/src/shared/analytics-insights";
import { formatReferrerLabel, type AnalyticsActivityKind } from "../../../lib/analytics-feed";
import { getAnalyticsProductInsights } from "../../../lib/analytics-monitor-data";
import { formatNumber } from "../../../lib/format";
import { SelectMenu } from "../../ui/SelectMenu";
import { SectionCard } from "../SectionCard";
import {
  ACTIVITY_KIND_STYLES,
  AnalyticsBarRow,
  AnalyticsEmptyMessage,
  AnalyticsErrorBanner,
  DeviceIcon,
  analyticsBarPercent,
} from "./shared";

const date = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function percent(n: number, total: number): string {
  if (!total) return "—";
  const value = n / total * 100;
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: value > 0 && value < 1 ? 1 : 0 })}%`;
}
const ratio = (n: number, total: number) => `${formatNumber(n)} of ${formatNumber(total)}`;
const delta = (current: number, previous: number) => previous ? `${current >= previous ? "+" : ""}${Math.round((current - previous) / previous * 100)}%` : current ? "New" : "—";
const duration = (ms: number | null) => ms == null ? "—" : `${(ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })}s`;
const period = (data: ProductData) => `${date(data.weekStart)}–${date(data.weekEnd - 1)} UTC`;
const iconButton = "inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-osu-b3/30 bg-osu-b4/60 text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50";

const FEATURE_KINDS: Record<string, AnalyticsActivityKind> = {
  player: "profile", replay: "replay", maps: "search", rankings: "ranking", teams: "team", team: "team", snipes: "snipe", "farm-helper": "farm",
  packs: "pack", collections: "pack", skins: "skin", communities: "community",
};

// Keep the existing Insights card and row treatment; definitions are available
// beside each metric without making every card read like documentation.
function InsightCard({ title, subtitle, help, actions, compactActions, children }: {
  title: string;
  subtitle: string;
  help: ReactNode;
  actions?: ReactNode;
  compactActions?: boolean;
  children: ReactNode;
}) {
  const [explaining, setExplaining] = useState(false);
  const helpId = useId();
  return (
    <SectionCard title={title} subtitle={subtitle} compactActions={compactActions ?? !actions} actions={
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <button type="button" className={iconButton} title={`About ${title.toLowerCase()}`}
          aria-label={`About ${title.toLowerCase()}`} aria-expanded={explaining} aria-controls={helpId}
          onClick={() => setExplaining((value) => !value)}>
          <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    }>
      <div id={helpId} hidden={!explaining} className="mb-3 space-y-1.5 border-b border-osu-b3/25 px-1 pb-3 text-[11px] leading-relaxed text-osu-f1">{help}</div>
      {children}
    </SectionCard>
  );
}

export function AnalyticsProductInsights() {
  const [result, setResult] = useState<AnalyticsProductResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let wait = 60_000;
      setPending(true);
      try {
        const next = await getAnalyticsProductInsights();
        if (stopped) return;
        setResult(next);
        setError(next.state === "error" ? "Could not refresh audience analytics." : null);
        if (next.state === "warming" || next.state === "refreshing") wait = 5_000;
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : "Could not load audience analytics.");
      } finally {
        if (!stopped) setPending(false);
      }
      if (!stopped) timer = setTimeout(() => { void load(); }, wait);
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [retry]);
  const data = result?.data;
  const refreshing = pending || result?.state === "refreshing";
  const refresh = (
    <button type="button" onClick={() => setRetry((n) => n + 1)} className={iconButton}
      disabled={pending} aria-label="Refresh audience analytics" title={data ? `Updated ${new Date(data.generatedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC` : "Refresh audience analytics"}>
      <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
    </button>
  );
  return (
    <div className="space-y-4" data-analytics-product>
      {error ? <AnalyticsErrorBanner message={error} /> : null}
      {data ? <>
        <Audience data={data} actions={refresh} />
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-3"><Features data={data} /></div>
          <div className="min-w-0 lg:col-span-2"><Retention data={data} /></div>
        </div>
        <Sources data={data} />
        <Health data={data} />
      </> : (
        <SectionCard title="Weekly audience" subtitle={error ? "could not load" : "preparing visit history…"} actions={refresh}>
          {!error ? <div className="skeleton-pulse h-32 rounded-md" /> : <AnalyticsEmptyMessage text="Audience data is unavailable." />}
        </SectionCard>
      )}
    </div>
  );
}

function Audience({ data, actions }: { data: ProductData; actions: ReactNode }) {
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);
  const peak = Math.max(1, ...data.daily.map((d) => d.visitors));
  const hovered = data.daily.find((d) => d.day === hoveredDay);
  const fullComparison = data.coverageSince <= data.weekStart - 7 * ANALYTICS_DAY_MS;
  const observed = data.historySince != null && data.coverageSince < data.weekEnd;
  return (
    <InsightCard title="Weekly audience" subtitle={`${period(data)} · 7 complete days`} actions={actions} compactActions help={<>
      <p>Visitors are unique browsers, including signed-out visits. Separate devices are counted separately. Bots, admin pages and configured owner/test traffic are excluded.</p>
      <p>First seen means first observed in the available history; returning visitors were seen before this week. {data.historySince != null ? `History starts ${date(data.historySince)}.` : "No history yet."}</p>
      <p>These cards use the periods in their headings, independently of the live-feed range.</p>
    </>}>
      <div className="grid grid-cols-3 divide-x divide-osu-b3/25 py-1">
        <AudienceStat label="Visitors" value={observed ? formatNumber(data.weeklyVisitors) : "—"}
          detail={fullComparison ? `${delta(data.weeklyVisitors, data.previousWeeklyVisitors)} · ${formatNumber(data.previousWeeklyVisitors)} previous` : "partial history"} />
        <AudienceStat label="First seen" value={observed ? formatNumber(data.newVisitors) : "—"} detail="this week" accent="text-osu-pink-light" />
        <AudienceStat label="Returning" value={observed ? formatNumber(data.returningVisitors) : "—"}
          detail={observed ? `${percent(data.returningVisitors, data.weeklyVisitors)} of visitors` : "no complete days"} />
      </div>
      {!observed ? <AnalyticsEmptyMessage text="Daily history will appear after the first complete UTC day." /> : <>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-osu-b3/20 pt-2 text-[10px] text-osu-f1">
          <span className="font-semibold uppercase tracking-wider">Daily visitors</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[1px] bg-osu-pink" />first seen</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[1px] bg-osu-pink/35" />returning</span>
          <span className="ml-auto tabular-nums">{hovered ? `${date(hovered.day)} · ${formatNumber(hovered.visitors)} visitors` : "last 28 days"}</span>
        </div>
        <div className="mt-2 flex h-16 items-end gap-px" onMouseLeave={() => setHoveredDay(null)}>
          {data.daily.map((d) => {
            const incomplete = d.day < data.coverageSince;
            const description = incomplete ? `${date(d.day)}: incomplete history` : `${date(d.day)}: ${formatNumber(d.visitors)} visitors, ${formatNumber(d.newVisitors)} first seen`;
            return (
              <button key={d.day} type="button" aria-label={description} title={description}
                onMouseEnter={() => setHoveredDay(d.day)} onFocus={() => setHoveredDay(d.day)} onClick={() => setHoveredDay(d.day)} onBlur={() => setHoveredDay(null)}
                className={`relative h-full min-w-0 flex-1 cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-osu-pink ${hoveredDay === d.day ? "bg-osu-b3/50" : "bg-osu-b3/25"}`}>
                <span className="absolute inset-x-0 bottom-0 rounded-sm bg-osu-pink/35" style={{ height: `${d.visitors ? Math.max(4, d.visitors / peak * 100) : 0}%` }}>
                  <span className="absolute inset-x-0 bottom-0 rounded-sm bg-osu-pink" style={{ height: `${d.visitors ? d.newVisitors / d.visitors * 100 : 0}%` }} />
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-osu-f1"><span>{date(data.acquisitionStart)}</span><span>{date(data.weekEnd - 1)}</span></div>
      </>}
      {observed && !fullComparison ? <p className="mt-2 text-[10px] text-osu-f1">History starts {date(data.coverageSince)} · week-over-week comparison pending.</p> : null}
    </InsightCard>
  );
}

function AudienceStat({ label, value, detail, accent = "text-white" }: { label: string; value: string; detail: string; accent?: string }) {
  return <div className="min-w-0 px-2 sm:px-3">
    <div className={`text-2xl font-bold leading-none tabular-nums ${accent}`}>{value}</div>
    <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{label}</div>
    <div className="mt-0.5 truncate text-[10px] text-osu-l2/60" title={detail}>{detail}</div>
  </div>;
}

type FeatureMetric = "visitors" | "repeat" | "actions" | "returns";
const FEATURE_METRICS: Array<{ id: FeatureMetric; label: string }> = [
  { id: "visitors", label: "Visitors" }, { id: "repeat", label: "Repeat" },
  { id: "actions", label: "Actions" }, { id: "returns", label: "Returns" },
];

function featureValue(row: AnalyticsFeatureUsage, metric: FeatureMetric): number {
  if (metric === "repeat") return row.repeatVisitors;
  if (metric === "actions") return row.actionVisitors;
  if (metric === "returns") return row.retentionEligible ? row.retained / row.retentionEligible : 0;
  return row.visitors;
}

function Features({ data }: { data: ProductData }) {
  const [metric, setMetric] = useState<FeatureMetric>("visitors");
  const [limit, setLimit] = useState(8);
  const rows = [...data.features].sort((a, b) => featureValue(b, metric) - featureValue(a, metric));
  const max = Math.max(0.01, ...rows.map((r) => featureValue(r, metric)));
  const fullComparison = data.coverageSince <= data.weekStart - 7 * ANALYTICS_DAY_MS;
  return (
    <InsightCard title="What they use" subtitle={metric === "returns" ? "first-week use → came back the following week" : `unique visitors · ${period(data)}`} help={<>
      <p>Visitors counts page visits and tracked actions. Repeat means using the feature on two or more different days that week.</p>
      <p>Actions counts visitors who took a tracked action, such as opening a pack, downloading a skin or loading replay data. A page can still be useful without a tracked action.</p>
      <p>Returns uses completed newcomer cohorts: visitors who used this feature in their first-observed week and returned anywhere the following week. The counts show the sample size; this is an association, not a cause.</p>
    </>} actions={
      <div role="group" aria-label="Feature metric" className="flex shrink-0 items-center gap-0.5 rounded-md border border-osu-b3/30 bg-osu-b5/50 p-0.5">
        {FEATURE_METRICS.map((m) => <button key={m.id} type="button" aria-pressed={metric === m.id} onClick={() => setMetric(m.id)}
          className={`cursor-pointer rounded px-2 py-1 text-[11px] font-semibold transition-colors duration-[120ms] ${metric === m.id ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:text-white"}`}>{m.label}</button>)}
      </div>
    }>
      {!rows.length ? <AnalyticsEmptyMessage text="No feature usage in this period." /> : <div className="space-y-1">
        {rows.slice(0, limit).map((r) => {
          const style = ACTIVITY_KIND_STYLES[FEATURE_KINDS[r.feature] ?? "visit"];
          const Icon = style.icon;
          const count = featureValue(r, metric);
          const value = metric === "returns" ? percent(r.retained, r.retentionEligible) : formatNumber(count);
          const detail = metric === "visitors"
            ? `${formatNumber(r.repeatVisitors)} repeat · ${formatNumber(r.actionVisitors)} acted`
            : metric === "returns" ? `${ratio(r.retained, r.retentionEligible)} eligible visitors`
              : `${ratio(count, r.visitors)} visitors · ${percent(count, r.visitors)}`;
          return <AnalyticsBarRow key={r.feature} pct={analyticsBarPercent(count, max)} gradient="bg-gradient-to-r from-osu-pink/20 to-transparent">
            <div className="flex items-center gap-2.5 px-3 py-2">
              <Icon className={`h-3.5 w-3.5 shrink-0 ${style.text}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-osu-c2">{ANALYTICS_FEATURES[r.feature] ?? r.feature}</div>
                <div className="mt-0.5 text-[10px] text-osu-f1">{detail}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[13px] font-bold tabular-nums text-white">{value}</div>
                {metric === "visitors" && fullComparison ? <div className="mt-0.5 text-[10px] tabular-nums text-osu-f1" title={`${formatNumber(r.previousVisitors)} visitors in the previous 7 days`}>{delta(r.visitors, r.previousVisitors)} vs previous</div> : null}
              </div>
            </div>
          </AnalyticsBarRow>;
        })}
      </div>}
      <MoreRows total={rows.length} limit={limit} onMore={() => setLimit((n) => n + 8)} />
    </InsightCard>
  );
}

function Retention({ data }: { data: ProductData }) {
  return (
    <InsightCard title="Who comes back" subtitle="first-seen week → returned the next week" help={<>
      <p>Weeks run Monday–Sunday in UTC. Each row groups browsers by their first-observed week and counts those who returned the following week.</p>
      <p>Incomplete historical weeks are excluded. A return rate stays pending until the entire following week is complete.</p>
    </>}>
      {!data.cohorts.length ? <AnalyticsEmptyMessage text="Waiting for the first complete week." /> : <div className="space-y-1">
        {[...data.cohorts].reverse().map((c) => <AnalyticsBarRow key={c.week} pct={c.returned == null || !c.newcomers ? 0 : c.returned / c.newcomers * 100} gradient="bg-gradient-to-r from-osu-purple/25 to-transparent">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <div className="text-[12px] text-osu-c2">{date(c.week)}–{date(c.week + 7 * ANALYTICS_DAY_MS - 1)}</div>
              <div className="mt-0.5 text-[10px] text-osu-f1">{c.returned == null ? `${formatNumber(c.newcomers)} first seen` : `${ratio(c.returned, c.newcomers)} came back`}</div>
            </div>
            {c.returned == null ? <span className="text-[10px] text-osu-f1">Still observing</span> : <span className="text-[13px] font-bold tabular-nums text-osu-purple-light">{percent(c.returned, c.newcomers)}</span>}
          </div>
        </AnalyticsBarRow>)}
      </div>}
    </InsightCard>
  );
}

function Sources({ data }: { data: ProductData }) {
  const [limit, setLimit] = useState(6);
  const max = Math.max(1, ...data.acquisition.map((r) => r.visitors));
  return (
    <InsightCard title="Which sources bring them back" subtitle={`first-seen visitors · ${date(data.acquisitionStart)}–${date(data.weekEnd - 1)} UTC`} help={<>
      <p>Original source and landing page, for browsers first observed in these 28 days. Actions counts visitors who took a tracked action by the end of the period; returns includes only completed acquisition weeks and following weeks.</p>
      <p>Direct / unknown includes links whose app or browser withheld a referrer. Tagged links keep their source, medium and campaign through navigation. Up to 50 combinations are available.</p>
      <p className="break-all font-mono text-[10px]">?utm_source=discord&amp;utm_medium=community&amp;utm_campaign=replay-launch</p>
    </>}>
      {!data.acquisition.length ? <AnalyticsEmptyMessage text="No first-seen traffic sources in this period." /> : <>
        <div className="mb-1 hidden items-center gap-4 px-3 text-[9px] font-semibold uppercase tracking-wider text-osu-f1 sm:flex">
          <span className="flex-1">Source / landing page</span><span className="w-16 text-right">Visitors</span><span className="w-24 text-right">Took action</span><span className="w-24 text-right">Came back</span>
        </div>
        <div className="space-y-1">
          {data.acquisition.slice(0, limit).map((r) => <AnalyticsBarRow key={JSON.stringify([r.source, r.medium, r.campaign, r.landing])} pct={analyticsBarPercent(r.visitors, max)} gradient="bg-gradient-to-r from-osu-green-light/15 to-transparent">
            <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2"><span className="truncate text-[12px] text-osu-c2">{formatReferrerLabel(r.source)}</span><span className="truncate text-[10px] text-osu-f1" title={`${r.medium}${r.campaign ? ` · ${r.campaign}` : ""}`}>{r.medium}{r.campaign ? ` · ${r.campaign}` : ""}</span></div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-osu-f1" title={r.landing}>{r.landing}</div>
              </div>
              <div className="grid grid-cols-3 gap-4 sm:flex sm:items-center">
                <SourceStat label="visitors" value={formatNumber(r.visitors)} className="sm:w-16" />
                <SourceStat label="took action" value={percent(r.actionVisitors, r.visitors)} detail={ratio(r.actionVisitors, r.visitors)} className="sm:w-24" />
                <SourceStat label="came back" value={percent(r.retained, r.retentionEligible)} detail={r.retentionEligible ? ratio(r.retained, r.retentionEligible) : "awaiting a full week"} className="sm:w-24" />
              </div>
            </div>
          </AnalyticsBarRow>)}
        </div>
        <MoreRows total={data.acquisition.length} limit={limit} onMore={() => setLimit((n) => n + 6)} />
      </>}
    </InsightCard>
  );
}

function SourceStat({ label, value, detail, className }: { label: string; value: string; detail?: string; className: string }) {
  return <div className={`shrink-0 sm:text-right ${className}`}>
    <div className="text-[12px] font-bold tabular-nums text-white">{value}<span className="ml-1 text-[9px] font-normal text-osu-f1 sm:hidden">{label}</span></div>
    {detail ? <div className="mt-0.5 text-[10px] tabular-nums text-osu-f1">{detail}</div> : null}
  </div>;
}

function Health({ data }: { data: ProductData }) {
  const [device, setDevice] = useState("all");
  const [release, setRelease] = useState("all");
  const [limit, setLimit] = useState(6);
  const releases = [...new Set([...data.reliability, ...data.loads].map((r) => r.release))].sort();
  const matches = (r: { device: string; release: string }) => (device === "all" || r.device === device) && (release === "all" || r.release === release);
  const rows = data.reliability.filter(matches);
  const loads = data.loads.filter(matches);
  const hidden = Math.max(0, rows.length - limit) + Math.max(0, loads.length - limit);
  return (
    <InsightCard title="Browser health" subtitle="last 7 UTC dates, including today" actions={<>
      <SelectMenu value={device} onChange={(value) => { setDevice(value); setLimit(6); }} ariaLabel="Device" options={[
        { value: "all", label: "All devices" }, { value: "mobile", label: "Mobile", icon: Smartphone },
        { value: "desktop", label: "Desktop", icon: Monitor }, { value: "unknown", label: "Unknown" },
      ]} />
      <SelectMenu value={release} onChange={(value) => { setRelease(value); setLimit(6); }} ariaLabel="Release" align="right"
        options={[{ value: "all", label: "All releases" }, ...releases.map((r) => ({ value: r, label: r }))]} />
    </>} help={<>
      <p>Affected visitors are browsers reporting an error, counted once per feature/device/release group. Unknown releases are older events without a version tag.</p>
      <p>Replay failure rates cover completed score-replay data loads. Success means replay and chart data loaded, not playback or audio readiness. Abandoned loads, uploads and comparison replays are outside this sample.</p>
      <p>Document timings cover completed full page loads only; they cannot measure load failures or SPA navigation. Timing percentiles use successful loads: p75 means 75% loaded within that time. Up to 100 groups are available per list.</p>
    </>}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0" role="region" aria-label="Affected visitors">
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-osu-f1">Affected visitors</div>
          {!rows.length ? <AnalyticsEmptyMessage text="No browser health data for these filters." /> : <div className="space-y-1">
            {rows.slice(0, limit).map((r) => <AnalyticsBarRow key={`${r.feature}:${r.device}:${r.release}`} pct={r.visitors ? r.affectedVisitors / r.visitors * 100 : 0} gradient="bg-gradient-to-r from-osu-red/20 to-transparent">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[12px] text-osu-c2">{ANALYTICS_FEATURES[r.feature] ?? r.feature}</div>
                  <DeviceRelease device={r.device} release={r.release} />
                </div>
                <div className="shrink-0 text-right">
                  <div className={`text-[13px] font-bold tabular-nums ${r.affectedVisitors ? "text-osu-red-light" : "text-osu-c2"}`}>{percent(r.affectedVisitors, r.visitors)}</div>
                  <div className="mt-0.5 text-[10px] tabular-nums text-osu-f1">{ratio(r.affectedVisitors, r.visitors)} · {formatNumber(r.errors)} errors</div>
                </div>
              </div>
            </AnalyticsBarRow>)}
          </div>}
        </div>
        <div className="min-w-0" role="region" aria-label="Load times">
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-osu-f1">Load times</div>
          {!loads.length ? <AnalyticsEmptyMessage text="No load measurements for these filters yet." /> : <div className="space-y-1">
            {loads.slice(0, limit).map((r) => <div key={`${r.operation}:${r.device}:${r.release}`} className="rounded-lg bg-osu-b5/50 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[12px] text-osu-c2">{r.operation}</div><DeviceRelease device={r.device} release={r.release} /></div>
                <div className="shrink-0 text-right text-[10px] tabular-nums text-osu-f1">
                  <div>{formatNumber(r.attempts)} samples</div>
                  {r.operation !== "Document load" ? <>
                    <div className={`mt-0.5 ${r.failures ? "text-osu-red-light" : "text-osu-c2"}`}>{percent(r.failures, r.attempts)} failed · {ratio(r.failures, r.attempts)}</div>
                    <div className="mt-0.5">{formatNumber(r.affectedVisitors)} affected</div>
                  </> : <div className="mt-0.5">completed loads only</div>}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-3 border-t border-osu-b3/20 pt-1.5" title={`${formatNumber(r.successfulSamples)} successful timing samples`}>
                {([["p50", r.p50Ms], ["p75", r.p75Ms], ["p95", r.p95Ms]] as const).map(([label, ms]) => <div key={label} className="flex items-baseline gap-1.5"><span className="text-[9px] text-osu-f1">{label}</span><span className="text-[12px] font-semibold tabular-nums text-osu-c2">{duration(ms)}</span></div>)}
              </div>
            </div>)}
          </div>}
        </div>
      </div>
      <MoreRows total={limit + hidden} limit={limit} onMore={() => setLimit((n) => n + 6)} />
    </InsightCard>
  );
}

function DeviceRelease({ device, release }: { device: string; release: string }) {
  return <div className="mt-0.5 flex items-center gap-1 text-[10px] text-osu-f1">
    <DeviceIcon deviceKind={device === "mobile" || device === "desktop" ? device : "unknown"} /><span>{device} · {release}</span>
  </div>;
}

function MoreRows({ total, limit, onMore }: { total: number; limit: number; onMore: () => void }) {
  if (total <= limit) return null;
  return <button type="button" onClick={onMore} className="mt-1.5 w-full cursor-pointer rounded-md border border-osu-b3/25 bg-osu-b5/40 py-2 text-[11px] font-semibold text-osu-l2 transition-colors duration-[120ms] hover:border-osu-b3/50 hover:text-white">
    Show more · {formatNumber(total - limit)} hidden
  </button>;
}
