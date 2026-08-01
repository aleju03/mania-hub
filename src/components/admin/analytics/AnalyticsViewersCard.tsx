import { Search } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "../../ui/Avatar";
import { SectionCard } from "../SectionCard";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import { analyticsInspectionHref, formatAnalyticsAgo } from "../../../lib/analytics-feed";
import { getAnalyticsViewers } from "../../../lib/analytics-monitor-data";
import type { AnalyticsViewerRow } from "../../../lib/analytics-monitor";
import { AnalyticsEmptyMessage, InlineCountryFlag, useTickingNow } from "./shared";

/* Every osu! account that has signed in and browsed the site. The backend keeps
   this as a durable projection, so it is not bounded by the event retention
   window the rest of the tab reads from. */

/* The whole roster is fetched so search can reach a player who last visited
   months ago, but only a page of it is ever in the DOM: each row costs an
   avatar and a flag image, and a few hundred of those is a visible hitch on
   mount plus a lot of work on every re-render. */
const PAGE_SIZE = 100;

export function AnalyticsViewersCard() {
  const [result, setResult] = useState<{ total: number; viewers: AnalyticsViewerRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const mountedRef = useRef(true);
  // The roster changes slowly; a minute of drift on "last seen" is invisible.
  const now = useTickingNow(30_000);

  useEffect(() => {
    mountedRef.current = true;
    getAnalyticsViewers()
      .then((data) => {
        if (mountedRef.current) setResult(data);
      })
      .catch((err: unknown) => {
        if (mountedRef.current) setError(err instanceof Error ? err.message : "Could not load signed-in players.");
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const rows = result?.viewers ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.username.toLowerCase().includes(needle) || String(row.viewerId).includes(needle));
  }, [result, query]);

  // A narrowed search starts from the top again rather than deep in a long list.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query]);

  const shown = filtered.slice(0, limit);
  const hidden = filtered.length - shown.length;

  const total = result?.total ?? 0;
  const truncated = result != null && total > result.viewers.length;
  const subtitle = result == null
    ? "loading..."
    : `${formatNumber(total)} osu! account${total === 1 ? "" : "s"} have signed in${truncated ? `, showing the ${formatNumber(result.viewers.length)} most recent` : ""}`;

  return (
    <SectionCard
      title="Signed-in players"
      subtitle={error ? "could not load" : subtitle}
      actions={result && result.viewers.length > 8 ? (
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-osu-b3/30 bg-osu-b5/70 px-2">
          <Search className="h-3 w-3 flex-shrink-0 text-osu-f1" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Find a player"
            aria-label="Find a signed-in player"
            className="w-[120px] bg-transparent text-[11px] text-white placeholder:text-osu-f1 focus:outline-none"
          />
        </label>
      ) : null}
    >
      {error ? (
        <AnalyticsEmptyMessage text={error} />
      ) : result == null ? (
        <div className="space-y-1">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="skeleton-pulse h-[38px] rounded-md" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <AnalyticsEmptyMessage
          text={query ? `No signed-in player matches "${query}".` : "Nobody has signed in yet."}
        />
      ) : (
        <>
          <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
            {shown.map((row) => (
              <ViewerRow key={row.viewerId} row={row} now={now} />
            ))}
          </div>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setLimit((value) => value + PAGE_SIZE)}
              className="mt-1 w-full cursor-pointer rounded-md border border-osu-b3/25 bg-osu-b5/40 py-1.5 text-[10px] font-semibold text-osu-l2 transition-colors duration-[120ms] hover:border-osu-b3/50 hover:text-white"
            >
              Show {formatNumber(Math.min(hidden, PAGE_SIZE))} more · {formatNumber(hidden)} hidden
            </button>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

/* Memoised: the card re-renders on every 5s monitor poll, and re-reconciling a
   few hundred avatar rows each time is pure waste. */
const ViewerRow = memo(function ViewerRow({ row, now }: { row: AnalyticsViewerRow; now: number }) {
  const seenFor = row.lastSeen - row.firstSeen;
  return (
    <a
      href={analyticsInspectionHref(`/player/${encodeURIComponent(row.username)}`)}
      target="_blank"
      rel="noreferrer"
      className="group flex cursor-pointer items-center gap-2.5 rounded-md border border-osu-b3/20 bg-osu-b5/50 px-2.5 py-1.5 transition-colors duration-[100ms] hover:border-osu-pink/35 hover:bg-osu-b3/25"
      title={`osu! user id ${row.viewerId}`}
    >
      <Avatar userId={row.viewerId} size={26} shape="circle" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-[12px] font-medium text-white group-hover:underline">{row.username}</span>
        {row.country ? (
          <span title={getCountryName(row.country) || row.country} className="flex-shrink-0">
            <InlineCountryFlag country={row.country} />
          </span>
        ) : null}
      </span>
      <span className="hidden flex-shrink-0 text-[10px] text-osu-f1 sm:inline" title="time between their first and most recent visit">
        {seenFor >= 60_000 ? `around for ${formatAnalyticsAgo(seenFor)}` : "first visit"}
      </span>
      <span className="w-16 flex-shrink-0 text-right text-[10px] text-osu-f1" title={`${formatNumber(row.events)} captured events`}>
        {formatNumber(row.events)} events
      </span>
      <span className="w-14 flex-shrink-0 text-right font-mono text-[10px] text-osu-l2" title={new Date(row.lastSeen).toLocaleString()}>
        {formatAnalyticsAgo(now - row.lastSeen)}
      </span>
    </a>
  );
});
