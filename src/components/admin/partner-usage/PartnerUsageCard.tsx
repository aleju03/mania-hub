import { useEffect, useState } from "react";
import { formatNumber } from "../../../lib/format";
import {
  fetchLiveBackendPartnerUsage,
  type LiveBackendPartnerUsage,
  type LiveBackendPartnerUsageReport,
} from "../../../lib/live-backend";
import { SectionCard } from "../SectionCard";

/*
 * Who is using a partner API key (PARTNER_API_KEYS), and how much: requests
 * per UTC day from the backend's per-partner counter. A configured key with
 * no row has never been used.
 */

const REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;
const SPARK_DAYS = 30;

function formatAgo(atMs: number, now: number): string {
  const mins = Math.max(0, Math.round((now - atMs) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Spark({ usage, now }: { usage: LiveBackendPartnerUsage; now: number }) {
  const byDay = new Map(usage.days.map((day) => [day.day, day.requests]));
  const days = Array.from({ length: SPARK_DAYS }, (_, index) => {
    const key = new Date(now - (SPARK_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    return { key, requests: byDay.get(key) ?? 0 };
  });
  const peak = Math.max(1, ...days.map((day) => day.requests));
  return (
    <div className="flex h-8 items-end gap-px" aria-hidden>
      {days.map((day) => (
        <div
          key={day.key}
          title={`${day.key}: ${formatNumber(day.requests)}`}
          className={`w-1.5 rounded-sm ${day.requests ? "bg-osu-pink" : "bg-osu-b3/40"}`}
          style={{ height: day.requests ? `${Math.max(12, (day.requests / peak) * 100)}%` : "8%" }}
        />
      ))}
    </div>
  );
}

function PartnerRow({ usage, now }: { usage: LiveBackendPartnerUsage; now: number }) {
  const rateLimited = usage.days.reduce((sum, day) => sum + day.rateLimited, 0);
  const notFound = usage.days.reduce((sum, day) => sum + day.notFound, 0);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.07] py-2.5 first:border-t-0">
      <div className="min-w-[9rem]">
        <div className="font-mono text-[13px] font-semibold text-osu-l1">{usage.partner}</div>
        <div className="text-[11px] text-osu-f1">
          {usage.lastSeenAt ? `Last request ${formatAgo(usage.lastSeenAt, now)}` : "Never used"}
          {usage.configured ? "" : " (key removed)"}
        </div>
      </div>
      <div className="flex gap-5">
        <Stat label="Today" value={usage.today} />
        <Stat label="7 days" value={usage.last7Days} />
        <Stat label="30 days" value={usage.last30Days} />
      </div>
      <Spark usage={usage} now={now} />
      {rateLimited || notFound ? (
        <div className="text-[11px] text-osu-f1">
          {rateLimited ? <span className="text-osu-yellow">{formatNumber(rateLimited)} rate limited</span> : null}
          {rateLimited && notFound ? <span className="mx-1.5 text-osu-f1/50">|</span> : null}
          {notFound ? <span>{formatNumber(notFound)} not found</span> : null}
          <span className="ml-1">in 30 days</span>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-bold leading-none text-osu-l1 tabular-nums">{formatNumber(value)}</div>
      <div className="mt-1 text-[11px] text-osu-f1">{label}</div>
    </div>
  );
}

export function PartnerUsageCard() {
  const [report, setReport] = useState<LiveBackendPartnerUsageReport | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchLiveBackendPartnerUsage();
        if (cancelled) return;
        if (result === null) setUnsupported(true);
        else setReport(result);
        setError(null);
        setNow(Date.now());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <SectionCard title="Partner API">
      {unsupported ? (
        <div className="text-[11px] text-osu-f1">The live backend does not serve this report yet.</div>
      ) : (
        <>
          {error ? <div className="mb-2 text-[11px] text-osu-red">{error}</div> : null}
          {!report ? (
            <div className="text-[11px] text-osu-f1">Loading…</div>
          ) : !report.partners.length ? (
            <div className="text-[11px] text-osu-f1">No partner keys are configured.</div>
          ) : (
            <div className="px-1">
              {report.partners.map((usage) => <PartnerRow key={usage.partner} usage={usage} now={now} />)}
              <div className="mt-1 text-[11px] text-osu-f1">
                Each key is capped at {formatNumber(report.ratePerMinute)} requests a minute. Days are UTC.
              </div>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}
