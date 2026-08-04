import { Search } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { Avatar } from "../../ui/Avatar";
import { SectionCard } from "../SectionCard";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import { analyticsInspectionHref, formatAnalyticsAgo } from "../../../lib/analytics-feed";
import { getAnalyticsViewers } from "../../../lib/analytics-monitor-data";
import type { AnalyticsViewerRow, AnalyticsViewerSort } from "../../../lib/analytics-monitor";
import { AnalyticsEmptyMessage, InlineCountryFlag, useTickingNow } from "./shared";

/* Every osu! account that has signed in and browsed the site. The backend keeps
   this as a durable projection, so it is not bounded by the event retention
   window the rest of the tab reads from. */

/* The whole roster is fetched so search can reach a player who last visited
   months ago, but only a page of it is ever in the DOM: each row costs an
   avatar and a flag image, and a few hundred of those is a visible hitch on
   mount plus a lot of work on every re-render. */
const PAGE_SIZE = 100;

/* Ordering is the backend's call, not this component's: it sorts the whole
   roster before cutting it to a page, so "top by pp" is the best player who
   has ever signed in rather than the best of the most recent page. */
const SORTS: Array<{ id: AnalyticsViewerSort; label: string; title: string }> = [
  { id: "recent", label: "Recent", title: "Newest visit first" },
  { id: "pp", label: "PP", title: "Highest pp first" },
  { id: "rank", label: "Rank", title: "Best global rank first" },
];

export function AnalyticsViewersCard() {
  const [result, setResult] = useState<{ total: number; viewers: AnalyticsViewerRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AnalyticsViewerSort>("recent");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [pending, setPending] = useState(true);
  // The roster changes slowly; a minute of drift on "last seen" is invisible.
  const now = useTickingNow(30_000);

  useEffect(() => {
    // Per-run rather than a shared mounted ref: switching sort twice in a row
    // must not let the first answer land on top of the second.
    let active = true;
    setPending(true);
    // Re-fetches per sort rather than reordering what is already here: the page
    // in hand is only the top of one ordering, so sorting it locally would rank
    // the wrong set of players.
    getAnalyticsViewers({ data: { sort } })
      .then((data) => {
        if (!active) return;
        setResult(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load signed-in players.");
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [sort]);

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
  // Says which end of the list was kept, since sorting happens over the whole
  // roster: "the 2,000 most recent" is a lie once the order is by pp.
  const shownEnd = sort === "recent" ? "most recent" : sort === "pp" ? "highest by pp" : "best ranked";
  const subtitle = result == null
    ? "loading..."
    : `${formatNumber(total)} osu! account${total === 1 ? "" : "s"} have signed in${truncated ? `, showing the ${formatNumber(result.viewers.length)} ${shownEnd}` : ""}`;

  return (
    <SectionCard
      title="Signed-in players"
      subtitle={error ? "could not load" : subtitle}
      actions={result && result.viewers.length > 8 ? (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Sort signed-in players">
            {SORTS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setSort(option.id)}
                title={option.title}
                aria-pressed={sort === option.id}
                className={`cursor-pointer rounded-md px-1.5 py-1 text-[10px] font-semibold transition-colors duration-[120ms] ${
                  sort === option.id ? "text-white" : "text-osu-f1 hover:text-osu-l2"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
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
        </div>
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
          <div
            className={`max-h-[420px] space-y-1 overflow-y-auto pr-1 transition-opacity duration-[120ms] ${pending ? "opacity-50" : ""}`}
          >
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

/* Where a player stands in osu!, as the backend last saw them. Only players it
   has ingested have these at all: a visitor from a country nobody tracks reads
   "unranked", which is a gap in what the site knows rather than a statement
   about the player. */
function ViewerRank({ pp, globalRank }: { pp: number | null; globalRank: number | null }) {
  if (pp == null && globalRank == null) {
    return (
      <span className="w-24 flex-shrink-0 text-right text-[10px] text-osu-f1/60" title="not in the backend's player table">
        unranked
      </span>
    );
  }
  return (
    <span
      className="w-24 flex-shrink-0 text-right text-[11px] text-osu-l2"
      title={globalRank == null ? "no global rank on record" : `global rank #${formatNumber(globalRank)}`}
    >
      {globalRank != null ? <span className="text-osu-f1">#{formatNumber(globalRank)}</span> : null}
      {globalRank != null && pp != null ? " " : null}
      {pp != null ? <span className="font-semibold text-white">{formatNumber(Math.round(pp))}pp</span> : null}
    </span>
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
      <ViewerRank pp={row.pp ?? null} globalRank={row.globalRank ?? null} />
      <span className="w-16 flex-shrink-0 text-right text-[10px] text-osu-f1" title={`${formatNumber(row.events)} captured events`}>
        {formatNumber(row.events)} events
      </span>
      <span className="w-14 flex-shrink-0 text-right font-mono text-[10px] text-osu-l2" title={new Date(row.lastSeen).toLocaleString()}>
        {formatAnalyticsAgo(now - row.lastSeen)}
      </span>
    </a>
  );
});
