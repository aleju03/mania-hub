import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { CountryFlag } from "../../ui/CountryFlag";
import {
  fetchLiveBackendVps,
  fetchLiveBackendVpsMetrics,
  type LiveBackendVpsMetrics,
  type LiveBackendVpsMetricsRange,
  type LiveBackendVpsServer,
  type LiveBackendVpsUsage,
} from "../../../lib/live-backend";

const SUMMARY_REFRESH_MS = 60_000;
const METRICS_REFRESH_MS = 60_000;
// Hetzner's "20 TB" is 20 TiB, so traffic reads in powers of 1024 to match.
const TB = 1024 ** 4;
// Validated pair on the panel surface (dataviz validator, dark mode).
const OUT_COLOR = "#2f9bd0";
const IN_COLOR = "#dc6a3a";

type Usage = Extract<LiveBackendVpsUsage, { configured: true }>;
type Metrics = Extract<LiveBackendVpsMetrics, { configured: true }>;

interface LoadState<T> {
  data: T | null;
  unsupported: boolean;
  error: string | null;
}

function usePolled<T>(load: () => Promise<T | null>, refreshMs: number, deps: React.DependencyList): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ data: null, unsupported: false, error: null });
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const result = await load();
        if (cancelled) return;
        setState(result === null
          ? { data: null, unsupported: true, error: null }
          : { data: result, unsupported: false, error: null });
      } catch (err) {
        if (!cancelled) setState((current) => ({ ...current, error: err instanceof Error ? err.message : String(err) }));
      }
    };
    void run();
    const id = window.setInterval(() => void run(), refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function formatMoney(value: number, currency: string, digits = 2): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function formatTb(bytes: number): string {
  const tb = bytes / TB;
  if (tb >= 10) return `${tb.toFixed(1)} TB`;
  // Hetzner's console reads in TB down to fractions ("0.75 TB"), so match it.
  if (tb >= 0.1) return `${tb.toFixed(2)} TB`;
  const gb = bytes / 1024 ** 3;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

function formatBits(bytesPerSec: number): string {
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(bits >= 1e10 ? 0 : 1)} Gbit/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(bits >= 1e8 ? 0 : 1)} Mbit/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kbit/s`;
  return `${bits.toFixed(0)} bit/s`;
}

function formatBytesRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(bytesPerSec >= 100 * 1024 ** 2 ? 0 : 1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function formatPercent(value: number): string {
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
}

function monthName(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function MetaLine({ items }: { items: Array<React.ReactNode | null | false> }) {
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-osu-f1 tabular-nums">
      {shown.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span aria-hidden className="h-3 w-px bg-white/[0.12]" /> : null}
          <span>{item}</span>
        </Fragment>
      ))}
    </div>
  );
}

function Panel({ title, actions, children, className = "" }: { title: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-osu-b3/30 bg-osu-b4/30 flex flex-col ${className}`}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
        <h3 className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</h3>
        {actions}
      </div>
      <div className="flex-1 px-4 pb-4 pt-3">{children}</div>
    </section>
  );
}

export function VpsMonitorPanel() {
  const usage = usePolled(() => fetchLiveBackendVps(), SUMMARY_REFRESH_MS, []);
  const [serverId, setServerId] = useState<number | null>(null);
  const data = usage.data;

  if (usage.unsupported) {
    return <Notice>The backend does not have the VPS endpoint yet. Deploy it to see usage here.</Notice>;
  }
  if (data && !data.configured) {
    return (
      <Notice>
        Add a read-only Hetzner Cloud API token as <code className="font-mono text-osu-c2">HETZNER_API_TOKEN</code> in{" "}
        <code className="font-mono text-osu-c2">backend/.env</code> and restart the backend. Create one under the project's
        Security tab in the Hetzner Console.
      </Notice>
    );
  }
  if (!data) {
    return usage.error ? <Notice tone="bad">{usage.error}</Notice> : <PanelSkeleton />;
  }

  const server = data.servers.find((entry) => entry.id === serverId) ?? data.servers[0] ?? null;
  return (
    <div className="space-y-4">
      {usage.error ? <Notice tone="bad">Last refresh failed: {usage.error}</Notice> : null}
      {data.servers.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {data.servers.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setServerId(entry.id)}
              aria-pressed={entry.id === server?.id}
              className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors duration-[120ms] cursor-pointer ${
                entry.id === server?.id ? "bg-osu-pink/15 text-white" : "text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
              }`}
            >
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
      <CostPanel usage={data} />
      {server ? (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <TrafficPanel usage={data} server={server} className="lg:col-span-3" />
            <ServerPanel server={server} currency={data.currency} className="lg:col-span-2" />
          </div>
          <LoadPanel server={server} />
        </>
      ) : (
        <Notice>No servers in this Hetzner project.</Notice>
      )}
    </div>
  );
}

function Notice({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "bad" }) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-[12px] ${tone === "bad" ? "border-osu-red-light/25 bg-osu-red/10 text-osu-red-light" : "border-osu-b3/30 bg-osu-b4/30 text-osu-l2"}`}>
      {children}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-[220px] rounded-lg bg-osu-b4/30 animate-pulse" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-[200px] rounded-lg bg-osu-b4/30 animate-pulse lg:col-span-3" />
        <div className="h-[200px] rounded-lg bg-osu-b4/30 animate-pulse lg:col-span-2" />
      </div>
    </div>
  );
}

function CostPanel({ usage }: { usage: Usage }) {
  const { currency, period } = usage;
  const now = Date.parse(usage.fetchedAt);
  const daysInMonth = Math.round((Date.parse(period.end) - Date.parse(period.start)) / 86_400_000);
  const day = Math.min(daysInMonth, Math.floor((now - Date.parse(period.start)) / 86_400_000) + 1);
  const spentShare = usage.projected > 0 ? Math.min(1, usage.monthToDate / usage.projected) : 0;
  const costs = [...usage.costs].sort((a, b) => b.projected - a.projected);
  return (
    <Panel title={`${monthName(period.start)} bill`}>
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] text-osu-f1">Spent so far</div>
          <div className="mt-1 text-[44px] leading-none font-semibold tracking-tight text-white tabular-nums">
            {formatMoney(usage.monthToDate, currency)}
          </div>
        </div>
        <div className="md:text-right">
          <div className="text-[11px] text-osu-f1">Month end</div>
          <div className="mt-1 text-[24px] leading-none font-semibold text-osu-c2 tabular-nums">
            {formatMoney(usage.projected, currency)}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <div className="relative h-2 rounded-full bg-white/[0.07] overflow-hidden">
          <div className="absolute inset-y-0 left-0 rounded-full bg-osu-pink" style={{ width: `${Math.max(spentShare * 100, 0.8)}%` }} />
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-osu-f1 tabular-nums">
          <span>Day {day} of {daysInMonth}</span>
          <span>{Math.round(period.elapsed * 100)}% of the month</span>
        </div>
      </div>

      {costs.length > 0 ? (
        <div className="mt-4 border-t border-white/[0.07] pt-2">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 text-[11px] text-osu-f1 pb-1">
            <span />
            <span className="text-right">So far</span>
            <span className="text-right w-[72px]">Month end</span>
          </div>
          {costs.map((item) => (
            <div key={`${item.kind}-${item.label}`} className="grid grid-cols-[1fr_auto_auto] gap-x-6 items-baseline py-1.5 border-t border-white/[0.04] first:border-t-0">
              <span className="text-[13px] text-osu-l1 truncate">{item.label}</span>
              <span className="text-[13px] text-white tabular-nums text-right">{formatMoney(item.monthToDate, currency)}</span>
              <span className={`text-[13px] tabular-nums text-right w-[72px] ${item.kind === "traffic" ? "text-osu-yellow" : "text-osu-l2"}`}>
                {formatMoney(item.projected, currency)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        <MetaLine items={[
          usage.vatRate > 0 ? "Excludes VAT" : null,
          "Rebuilt from Hetzner's price list",
          `Updated ${new Date(usage.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
        ]} />
      </div>
    </Panel>
  );
}

function TrafficPanel({ usage, server, className }: { usage: Usage; server: LiveBackendVpsServer; className?: string }) {
  const { outgoingBytes, ingoingBytes, includedBytes, projectedOutgoingBytes, pricePerTb } = server.traffic;
  const out = outgoingBytes ?? 0;
  const included = includedBytes ?? 0;
  const projected = projectedOutgoingBytes;
  // The bar's right edge is the included amount, unless the month is heading past it.
  const scale = Math.max(included, projected ?? 0, out) || 1;
  const usedPct = (out / scale) * 100;
  const projectedPct = projected != null ? (Math.min(projected, scale) / scale) * 100 : null;
  const includedPct = included > 0 ? (included / scale) * 100 : null;
  const over = projected != null && included > 0 && projected > included;
  const share = included > 0 ? out / included : null;
  return (
    <Panel title="Traffic" className={className}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[34px] leading-none font-semibold text-white tabular-nums">{outgoingBytes == null ? "—" : formatTb(out)}</span>
        {included > 0 ? <span className="text-[14px] text-osu-l2 tabular-nums">of {formatTb(included)} out</span> : null}
        {share != null ? <span className="ml-auto text-[14px] font-medium text-osu-c2 tabular-nums">{formatPercent(share * 100)}</span> : null}
      </div>

      <div className="relative mt-4 h-3">
        <div className="absolute inset-0 rounded-full bg-white/[0.07]" />
        {projectedPct != null ? (
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${over ? "bg-osu-yellow/30" : "bg-white/[0.10]"}`}
            style={{ width: `${projectedPct}%` }}
          />
        ) : null}
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(usedPct, 0.6)}%`, background: OUT_COLOR }} />
        {includedPct != null && includedPct < 100 ? (
          <div className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-osu-c2" style={{ left: `calc(${includedPct}% - 1px)` }} title="Included traffic" />
        ) : null}
      </div>

      <DailyTrafficBars server={server} usage={usage} />

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
        <Stat
          label="Month end"
          value={projected == null ? "—" : formatTb(projected)}
          tone={over ? "warn" : undefined}
        />
        <Stat label="Incoming" value={ingoingBytes == null ? "—" : formatTb(ingoingBytes)} />
        <Stat label="Past included" value={pricePerTb == null ? "—" : `${formatMoney(pricePerTb, usage.currency)}/TB`} />
      </div>
      <div className="mt-3">
        <MetaLine items={[
          "Only outgoing counts",
          over ? <span className="text-osu-yellow">Heading over the included amount</span> : null,
        ]} />
      </div>
    </Panel>
  );
}

const DAILY_REFRESH_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/* Outgoing bytes per UTC day this month, summed from the 30-day bandwidth series. */
function DailyTrafficBars({ server, usage }: { server: LiveBackendVpsServer; usage: Usage }) {
  const metrics = usePolled(
    () => fetchLiveBackendVpsMetrics({ data: { serverId: server.id, range: "30d" } }),
    DAILY_REFRESH_MS,
    [server.id],
  );
  const [hover, setHover] = useState<number | null>(null);
  const data = metrics.data?.configured && metrics.data.serverId === server.id ? metrics.data as Metrics : null;
  const start = Date.parse(usage.period.start);
  const days = Math.round((Date.parse(usage.period.end) - start) / DAY_MS);
  const today = Math.floor((Date.parse(usage.fetchedAt) - start) / DAY_MS);
  const totals = useMemo(() => {
    const sums = new Array<number>(days).fill(0);
    if (!data) return null;
    for (const [at, bytesPerSec] of data.series.netOut) {
      const index = Math.floor((at - start) / DAY_MS);
      if (index >= 0 && index < days) sums[index] += bytesPerSec * data.stepSec;
    }
    return sums;
  }, [data, days, start]);
  const peak = totals ? Math.max(...totals, 1) : 1;
  const hovered = hover != null && totals ? { day: hover, bytes: totals[hover] } : null;
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between text-[11px] text-osu-f1 tabular-nums">
        <span>Outgoing per day</span>
        <span className="text-osu-l1">
          {hovered
            ? `${new Date(start + hovered.day * DAY_MS).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}: ${formatTb(hovered.bytes)}`
            : totals && today > 0 ? `avg ${formatTb(totals.slice(0, Math.min(today, days)).reduce((sum, value) => sum + value, 0) / Math.min(today, days))}` : null}
        </span>
      </div>
      <div className="mt-2 flex h-[64px] items-end gap-[2px]" onPointerLeave={() => setHover(null)}>
        {Array.from({ length: days }, (_, index) => {
          const bytes = totals?.[index] ?? 0;
          const future = index > today;
          const height = totals && !future ? Math.max(2, (bytes / peak) * 64) : 2;
          return (
            <div
              key={index}
              className="flex h-full flex-1 items-end"
              onPointerEnter={() => setHover(future || !totals ? null : index)}
            >
              <div
                className={`w-full rounded-t-[3px] rounded-b-[1px] transition-opacity duration-[120ms] ${future || !totals ? "bg-white/[0.06]" : ""} ${totals && !future && index === today ? "opacity-60" : ""} ${hover != null && hover !== index ? "opacity-50" : ""}`}
                style={{ height, background: totals && !future ? OUT_COLOR : undefined }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-osu-f1 tabular-nums">
        <span>1</span>
        <span>{Math.ceil(days / 2)}</span>
        <span>{days}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, swatch }: { label: string; value: string; tone?: "warn"; swatch?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-osu-f1">
        {swatch ? <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: swatch }} /> : null}
        {label}
      </div>
      <div className={`mt-0.5 text-[16px] font-medium tabular-nums truncate ${tone === "warn" ? "text-osu-yellow" : "text-white"}`}>{value}</div>
    </div>
  );
}

function ServerPanel({ server, currency, className }: { server: LiveBackendVpsServer; currency: string; className?: string }) {
  const running = server.status === "running";
  const rows: Array<[string, React.ReactNode]> = [
    ["Location", (
      <span className="inline-flex items-center gap-1.5">
        {server.location.country ? <CountryFlag code={server.location.country} size="xs" /> : null}
        {server.location.city ?? server.location.name}
        <span className="text-osu-f1">{server.location.name}</span>
      </span>
    )],
    ["IPv4", server.ipv4 ? <span className="font-mono">{server.ipv4}</span> : "—"],
    ["IPv6", server.ipv6 ? <span className="font-mono truncate">{server.ipv6}</span> : "—"],
    ["OS", server.os ?? "—"],
    ["Backups", server.backups ? "On" : "Off"],
    ["Created", formatDate(server.created)],
  ];
  return (
    <Panel
      title="Server"
      className={className}
      actions={(
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${running ? "text-osu-green-light" : "text-osu-yellow"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-osu-green-light" : "bg-osu-yellow"}`} />
          {server.status}
        </span>
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[26px] leading-none font-semibold text-white">{server.type.toUpperCase()}</span>
        <span className="text-[13px] text-osu-l2 tabular-nums">{formatMoney(server.priceMonthly, currency)}/mo</span>
      </div>
      <div className="mt-2 text-[13px] text-osu-l1 tabular-nums">
        {server.cores} {server.cpuType === "dedicated" ? "dedicated" : ""} vCPU, {server.memoryGb} GB RAM, {server.diskGb} GB disk
        {server.architecture ? <span className="text-osu-f1"> ({server.architecture})</span> : null}
      </div>
      <dl className="mt-3 border-t border-white/[0.07]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 py-1.5 border-b border-white/[0.04] last:border-b-0">
            <dt className="text-[11px] text-osu-f1 flex-shrink-0">{label}</dt>
            <dd className="text-[12px] text-osu-l1 min-w-0 truncate text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

const RANGES: Array<{ value: LiveBackendVpsMetricsRange; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

function LoadPanel({ server }: { server: LiveBackendVpsServer }) {
  const [range, setRange] = useState<LiveBackendVpsMetricsRange>("24h");
  const metrics = usePolled(
    () => fetchLiveBackendVpsMetrics({ data: { serverId: server.id, range } }),
    METRICS_REFRESH_MS,
    [server.id, range],
  );
  const data = metrics.data?.configured && metrics.data.serverId === server.id && metrics.data.range === range ? metrics.data as Metrics : null;
  // Hetzner reports CPU per core (a 4 vCPU box tops out at 400%); read it as a share of the whole machine.
  const cpu = useMemo(
    () => data ? data.series.cpu.map(([at, value]): [number, number] => [at, value / Math.max(1, server.cores)]) : [],
    [data, server.cores],
  );
  return (
    <Panel
      title="Load"
      actions={(
        <div className="flex rounded-md bg-osu-b5/60 p-0.5">
          {RANGES.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => setRange(entry.value)}
              aria-pressed={range === entry.value}
              className={`px-2.5 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors duration-[120ms] cursor-pointer ${
                range === entry.value ? "bg-osu-b3 text-white" : "text-osu-f1 hover:text-white"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
    >
      {metrics.error && !data ? <div className="text-[12px] text-osu-red-light">{metrics.error}</div> : null}
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 lg:grid-cols-2">
        <ChartBlock
          title={`CPU (${server.cores} vCPU)`}
          data={data}
          range={range}
          series={data ? [{ key: "cpu", label: "CPU", color: OUT_COLOR, points: cpu }] : []}
          format={formatPercent}
          minMax={100}
          area
        />
        <ChartBlock
          title="Network"
          data={data}
          range={range}
          series={data ? [
            { key: "out", label: "Out", color: OUT_COLOR, points: data.series.netOut },
            { key: "in", label: "In", color: IN_COLOR, points: data.series.netIn },
          ] : []}
          format={formatBits}
          unit={BITS_UNIT}
        />
        <ChartBlock
          title="Disk"
          data={data}
          range={range}
          series={data ? [
            { key: "write", label: "Write", color: OUT_COLOR, points: data.series.diskWrite },
            { key: "read", label: "Read", color: IN_COLOR, points: data.series.diskRead },
          ] : []}
          format={formatBytesRate}
          unit={BYTES_UNIT}
          className="lg:col-span-2"
        />
      </div>
    </Panel>
  );
}

interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: Array<[number, number]>;
}

function ChartBlock({
  title,
  data,
  range,
  series,
  format,
  minMax,
  unit,
  area = false,
  className = "",
}: {
  title: string;
  data: Metrics | null;
  range: LiveBackendVpsMetricsRange;
  series: ChartSeries[];
  format: (value: number) => string;
  minMax?: number;
  unit?: ChartUnit;
  area?: boolean;
  className?: string;
}) {
  const stats = series.map((entry) => {
    const values = entry.points.map(([, value]) => value);
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const peak = values.length ? Math.max(...values) : null;
    return { ...entry, avg, peak };
  });
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-[13px] font-medium text-osu-c2">{title}</span>
          {series.length > 1 ? (
            <span className="flex items-center gap-3">
              {series.map((entry) => (
                <span key={entry.key} className="inline-flex items-center gap-1.5 text-[11px] text-osu-f1">
                  <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: entry.color }} />
                  {entry.label}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-1">
        <MetaLine items={stats.flatMap((entry) => entry.avg == null ? [] : [
          <span key={`${entry.key}-avg`}>{series.length > 1 ? `${entry.label} ` : ""}avg <span className="text-osu-l1">{format(entry.avg)}</span></span>,
          <span key={`${entry.key}-peak`}>peak <span className="text-osu-l1">{format(entry.peak ?? 0)}</span></span>,
        ])} />
      </div>
      <div className="mt-2">
        {data ? (
          <TimeSeriesChart series={series} format={format} range={range} minMax={minMax} unit={unit} area={area} />
        ) : (
          <div className="h-[150px] rounded bg-white/[0.03] animate-pulse" />
        )}
      </div>
    </div>
  );
}

const CHART_HEIGHT = 150;
const PAD = { top: 8, right: 4, bottom: 20, left: 64 };

/* Rounds a chart ceiling to a clean number in the unit its labels read in. */
interface ChartUnit {
  factor: number;
  base: number;
}

const BITS_UNIT: ChartUnit = { factor: 8, base: 1000 };
const BYTES_UNIT: ChartUnit = { factor: 1, base: 1024 };

function niceCeilIn(value: number, unit: ChartUnit | undefined): number {
  if (!unit) return niceCeil(value);
  const display = value * unit.factor;
  if (display <= 0) return 1;
  const power = unit.base ** Math.max(0, Math.floor(Math.log(display) / Math.log(unit.base)));
  return (niceCeil(display / power) * power) / unit.factor;
}

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exp;
  const nice = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((step) => fraction <= step) ?? 10;
  return nice * exp;
}

function formatTick(at: number, range: LiveBackendVpsMetricsRange): string {
  const date = new Date(at);
  return range === "24h"
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatHoverTime(at: number, range: LiveBackendVpsMetricsRange): string {
  const date = new Date(at);
  return range === "24h"
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function TimeSeriesChart({
  series,
  format,
  range,
  minMax,
  unit,
  area,
}: {
  series: ChartSeries[];
  format: (value: number) => string;
  range: LiveBackendVpsMetricsRange;
  minMax?: number;
  unit?: ChartUnit;
  area: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const all = series.flatMap((entry) => entry.points);
    if (all.length === 0 || width <= 0) return null;
    const t0 = Math.min(...all.map(([at]) => at));
    const t1 = Math.max(...all.map(([at]) => at));
    const peak = Math.max(...all.map(([, value]) => value), 0);
    const yMax = Math.max(niceCeilIn(peak * 1.1, unit), minMax ?? 0);
    const innerW = Math.max(1, width - PAD.left - PAD.right);
    const innerH = CHART_HEIGHT - PAD.top - PAD.bottom;
    const x = (at: number) => PAD.left + (t1 === t0 ? innerW / 2 : ((at - t0) / (t1 - t0)) * innerW);
    const y = (value: number) => PAD.top + innerH - (Math.min(value, yMax) / yMax) * innerH;
    const paths = series.map((entry) => {
      const line = entry.points.map(([at, value], index) => `${index ? "L" : "M"}${x(at).toFixed(1)},${y(value).toFixed(1)}`).join("");
      const fill = entry.points.length
        ? `${line}L${x(entry.points[entry.points.length - 1][0]).toFixed(1)},${y(0)}L${x(entry.points[0][0]).toFixed(1)},${y(0)}Z`
        : "";
      return { ...entry, line, fill };
    });
    const ticksY = [0, yMax / 2, yMax];
    const tickCount = Math.max(2, Math.min(6, Math.floor(innerW / 110)));
    const ticksX = Array.from({ length: tickCount }, (_, index) => t0 + ((t1 - t0) * index) / (tickCount - 1));
    // Hover snaps to the longest series' timestamps.
    const base = series.reduce((longest, entry) => entry.points.length > longest.length ? entry.points : longest, [] as Array<[number, number]>);
    return { t0, t1, x, y, paths, ticksY, ticksX, innerW, base };
  }, [series, width, minMax, unit]);

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!geometry || geometry.base.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const at = geometry.t0 + ((px - PAD.left) / geometry.innerW) * (geometry.t1 - geometry.t0);
    let best = 0;
    for (let index = 1; index < geometry.base.length; index++) {
      if (Math.abs(geometry.base[index][0] - at) < Math.abs(geometry.base[best][0] - at)) best = index;
    }
    setHover(best);
  };

  const hoverAt = geometry && hover != null ? geometry.base[hover]?.[0] ?? null : null;
  const hoverValues = hoverAt != null
    ? series.map((entry) => ({ ...entry, value: entry.points.find(([at]) => at === hoverAt)?.[1] ?? null }))
    : [];
  const hoverX = geometry && hoverAt != null ? geometry.x(hoverAt) : null;
  const tooltipLeft = hoverX != null ? Math.min(Math.max(hoverX + 10, 0), Math.max(0, width - 150)) : 0;
  const flip = hoverX != null && hoverX > width - 170;

  return (
    <div ref={ref} className="relative w-full" style={{ height: CHART_HEIGHT }}>
      {geometry ? (
        <svg
          width={width}
          height={CHART_HEIGHT}
          className="block touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={series.map((entry) => entry.label).join(", ")}
        >
          {geometry.ticksY.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geometry.y(tick)} y2={geometry.y(tick)} stroke="rgba(255,255,255,0.06)" />
              <text x={PAD.left - 8} y={geometry.y(tick)} dy="0.32em" textAnchor="end" className="fill-osu-f1 text-[10.5px] tabular-nums">
                {format(tick).replace(/\.0(?=\D|$)/, "")}
              </text>
            </g>
          ))}
          {geometry.ticksX.map((tick, index) => (
            <text
              key={tick}
              x={geometry.x(tick)}
              y={CHART_HEIGHT - 4}
              textAnchor={index === 0 ? "start" : index === geometry.ticksX.length - 1 ? "end" : "middle"}
              className="fill-osu-f1 text-[10.5px] tabular-nums"
            >
              {formatTick(tick, range)}
            </text>
          ))}
          {area ? geometry.paths.map((entry) => (
            <path key={`${entry.key}-fill`} d={entry.fill} fill={entry.color} fillOpacity={0.14} />
          )) : null}
          {geometry.paths.map((entry) => (
            <path key={entry.key} d={entry.line} fill="none" stroke={entry.color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hoverX != null ? (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={CHART_HEIGHT - PAD.bottom} stroke="rgba(255,255,255,0.25)" />
              {hoverValues.map((entry) => entry.value == null ? null : (
                <circle key={entry.key} cx={hoverX} cy={geometry.y(entry.value)} r={4} fill={entry.color} stroke="var(--color-osu-b5)" strokeWidth={2} />
              ))}
            </g>
          ) : null}
        </svg>
      ) : null}
      {geometry && hoverAt != null && hoverX != null ? (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-[130px] rounded-md bg-osu-b6/95 px-2.5 py-2 shadow-lg"
          style={flip ? { right: Math.max(0, width - hoverX + 10) } : { left: tooltipLeft }}
        >
          <div className="text-[11px] text-osu-f1 tabular-nums">{formatHoverTime(hoverAt, range)}</div>
          {hoverValues.map((entry) => (
            <div key={entry.key} className="mt-1 flex items-center justify-between gap-3 text-[12px]">
              <span className="inline-flex items-center gap-1.5 text-osu-l2">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
                {entry.label}
              </span>
              <span className="text-white tabular-nums">{entry.value == null ? "—" : format(entry.value)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {geometry === null && width > 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-osu-f1">No data for this range</div>
      ) : null}
    </div>
  );
}
