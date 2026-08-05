import { ChevronDown, Search } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { Avatar } from "../../ui/Avatar";
import { SectionCard } from "../SectionCard";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import {
  analyticsEventHref,
  analyticsInspectionHref,
  buildAnalyticsReplayMapIndex,
  describeAnalyticsEvent,
  formatAnalyticsActivityText,
  formatAnalyticsAgo,
  type AnalyticsRecentEventRow,
} from "../../../lib/analytics-feed";
import { getAnalyticsViewerEvents, getAnalyticsViewers } from "../../../lib/analytics-monitor-data";
import type { AnalyticsCountryRow, AnalyticsViewersResult, AnalyticsViewerRow, AnalyticsViewerSort } from "../../../lib/analytics-monitor";
import {
  ACTIVITY_KIND_STYLES,
  AnalyticsCountryFilter,
  AnalyticsEmptyMessage,
  InlineCountryFlag,
  useTickingNow,
} from "./shared";

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
  const [result, setResult] = useState<AnalyticsViewersResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AnalyticsViewerSort>("recent");
  const [country, setCountry] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [pending, setPending] = useState(true);
  // The roster changes slowly; a minute of drift on "last seen" is invisible.
  const now = useTickingNow(30_000);

  useEffect(() => {
    // Per-run rather than a shared mounted ref: switching sort twice in a row
    // must not let the first answer land on top of the second.
    let active = true;
    setPending(true);
    // Re-fetches per sort and country rather than reworking what is already
    // here: the page in hand is only the top of one ordering of one filter, so
    // doing either locally would answer for the wrong set of players.
    getAnalyticsViewers({ data: { sort, country } })
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
  }, [sort, country]);

  /* Every country the roster has players in. From the backend, which counts the
     whole table; the rows in hand are the fallback for a backend deployed
     behind this build. */
  const countryOptions = useMemo<AnalyticsCountryRow[]>(() => {
    if (result?.countries?.length) return result.countries;
    const counts = new Map<string, number>();
    (result?.viewers ?? []).forEach((row) => {
      if (row.country) counts.set(row.country, (counts.get(row.country) ?? 0) + 1);
    });
    return Array.from(counts, ([code, count]) => ({ country: code, count })).sort((a, b) => b.count - a.count);
  }, [result]);

  /* The country is the backend's filter, applied again here so that an older
     backend that ignored it still narrows the list rather than pretending to. */
  const inCountry = useMemo(() => {
    const rows = result?.viewers ?? [];
    return country ? rows.filter((row) => row.country === country) : rows;
  }, [result, country]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return inCountry;
    return inCountry.filter((row) => row.username.toLowerCase().includes(needle) || String(row.viewerId).includes(needle));
  }, [inCountry, query]);

  // A narrowed list starts from the top again rather than deep in a long page.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query, country]);

  const shown = filtered.slice(0, limit);
  const hidden = filtered.length - shown.length;

  const total = result?.total ?? 0;
  // What the country filter matches across the whole roster, not just the page.
  const matched = country ? result?.matched ?? inCountry.length : total;
  const truncated = result != null && matched > inCountry.length;
  // Says which end of the list was kept, since sorting happens over the whole
  // roster: "the 2,000 most recent" is a lie once the order is by pp.
  const shownEnd = sort === "recent" ? "most recent" : sort === "pp" ? "highest by pp" : "best ranked";
  const keptClause = truncated ? `, showing the ${formatNumber(inCountry.length)} ${shownEnd}` : "";
  const countryName = country ? getCountryName(country) || country : null;
  /* Keyed off the whole roster rather than the rows on screen: a country that
     narrows the list down to two players must not take the controls with it and
     strand whoever picked it. */
  const showControls = result != null && (result.total > 8 || country != null);
  const subtitle = result == null
    ? "loading..."
    : countryName
      ? `${formatNumber(matched)} of ${formatNumber(total)} signed-in accounts browse from ${countryName}${keptClause}`
      : `${formatNumber(total)} osu! account${total === 1 ? "" : "s"} have signed in${keptClause}`;

  return (
    <SectionCard
      title="Signed-in players"
      subtitle={error ? "could not load" : subtitle}
      actions={showControls ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div
            className="flex flex-shrink-0 items-center gap-0.5 rounded-md border border-osu-b3/30 bg-osu-b5/50 p-0.5"
            role="group"
            aria-label="Sort signed-in players"
          >
            {SORTS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setSort(option.id)}
                title={option.title}
                aria-pressed={sort === option.id}
                className={`cursor-pointer rounded px-2 py-1 text-[11px] font-semibold transition-colors duration-[120ms] ${
                  sort === option.id ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:text-white"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <AnalyticsCountryFilter
            country={country}
            options={countryOptions}
            onChange={setCountry}
            label="Filter signed-in players by country"
          />
          {/* Takes the rest of the row on a phone, where the controls have the
              width to themselves. */}
          <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-osu-b3/30 bg-osu-b5/70 px-2 sm:w-[150px] sm:flex-none">
            <Search className="h-3 w-3 flex-shrink-0 text-osu-f1" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Find a player"
              aria-label="Find a signed-in player"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-white placeholder:text-osu-f1 focus:outline-none"
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
            <div key={index} className="skeleton-pulse h-[46px] rounded-md" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <AnalyticsEmptyMessage
          text={
            query
              ? `No signed-in player matches "${query}"${countryName ? ` in ${countryName}` : ""}.`
              : countryName
                ? `Nobody has signed in from ${countryName}.`
                : "Nobody has signed in yet."
          }
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
              className="mt-1.5 w-full cursor-pointer rounded-md border border-osu-b3/25 bg-osu-b5/40 py-2 text-[11px] font-semibold text-osu-l2 transition-colors duration-[120ms] hover:border-osu-b3/50 hover:text-white"
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
      <span className="flex-shrink-0 text-[11px] text-osu-f1 sm:w-24 sm:text-right" title="not in the backend's player table">
        unranked
      </span>
    );
  }
  return (
    <span
      className="flex-shrink-0 text-[12px] text-osu-l2 sm:w-24 sm:text-right"
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
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`overflow-hidden rounded-md border bg-osu-b5/50 transition-colors duration-[100ms] ${
        open ? "border-osu-pink/35" : "border-osu-b3/20"
      }`}
    >
      <div className="flex items-center gap-1 pr-1 transition-colors duration-[100ms] hover:bg-osu-b3/25">
        <a
          href={analyticsInspectionHref(`/player/${encodeURIComponent(row.username)}`)}
          target="_blank"
          rel="noreferrer"
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2 pl-2.5"
          title={`osu! user id ${row.viewerId}`}
        >
          <Avatar userId={row.viewerId} size={30} shape="circle" />
          {/* A phone reads this as a name over its numbers; from sm the same spans
              become the columns of a single line. Fixed-width columns on a narrow
              screen left the name about four characters wide. */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="flex min-w-0 items-center gap-1.5 sm:flex-1">
              <span className="truncate text-[13px] font-medium text-white group-hover:underline">{row.username}</span>
              {row.country ? (
                <span title={getCountryName(row.country) || row.country} className="flex-shrink-0">
                  <InlineCountryFlag country={row.country} />
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 items-center gap-2.5 sm:contents">
              <span className="hidden flex-shrink-0 text-[11px] text-osu-f1 lg:inline" title="time between their first and most recent visit">
                {seenFor >= 60_000 ? `around for ${formatAnalyticsAgo(seenFor)}` : "first visit"}
              </span>
              <ViewerRank pp={row.pp ?? null} globalRank={row.globalRank ?? null} />
              <span className="flex-shrink-0 text-[11px] text-osu-f1 sm:w-[86px] sm:text-right" title={`${formatNumber(row.events)} captured events`}>
                {formatNumber(row.events)} events
              </span>
            </span>
          </div>
          <span className="w-10 flex-shrink-0 text-right font-mono text-[11px] text-osu-l2 sm:w-14" title={new Date(row.lastSeen).toLocaleString()}>
            {formatAnalyticsAgo(now - row.lastSeen)}
          </span>
        </a>
        {/* Its own control rather than the row itself: the row already means
            "open their profile", and both wants are real. */}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} what ${row.username} has been doing`}
          title={`${open ? "Hide" : "Show"} what ${row.username} has been doing`}
          className="flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-osu-f1 transition-colors duration-[120ms] hover:bg-osu-b3/50 hover:text-white"
        >
          <ChevronDown className={`h-4 w-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </div>
      {open ? <ViewerActivity viewerId={row.viewerId} now={now} /> : null}
    </div>
  );
});

// How much of a trail is unfolded at a time. The request brings back more; a
// few hundred rows dropped into the roster at once buries everything under it.
const ACTIVITY_PAGE_SIZE = 20;

/* What this player has actually been doing, fetched the first time their row is
   opened. The roster's event count is lifetime and the events behind it are
   pruned at the store's retention, so an old account answering with nothing is
   a true answer rather than a failure. */
function ViewerActivity({ viewerId, now }: { viewerId: number; now: number }) {
  const [events, setEvents] = useState<AnalyticsRecentEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(ACTIVITY_PAGE_SIZE);

  useEffect(() => {
    let active = true;
    getAnalyticsViewerEvents({ data: { viewerId } })
      .then((result) => {
        if (active) setEvents(result.events);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load this player's activity.");
      });
    return () => {
      active = false;
    };
  }, [viewerId]);

  // Replay titles live on the events themselves, so the map a bare /replay
  // pageview was about is recovered from the player's own trail.
  const replayMaps = useMemo(() => buildAnalyticsReplayMapIndex(events ?? []), [events]);

  if (error) {
    return <div className="border-t border-osu-b3/20 px-3 py-3 text-[11px] text-osu-red-light">{error}</div>;
  }
  if (events == null) {
    return (
      <div className="space-y-1 border-t border-osu-b3/20 p-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="skeleton-pulse h-[26px] rounded" />
        ))}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="border-t border-osu-b3/20 px-3 py-3 text-[11px] text-osu-f1">
        Nothing left in the retention window for this player.
      </div>
    );
  }

  const shown = events.slice(0, limit);
  const hidden = events.length - shown.length;

  return (
    <div className="border-t border-osu-b3/20 p-1.5">
      {shown.map((event, index) => (
        <ActivityLine key={event.eventId ?? `${event.ts}-${index}`} event={event} replayMaps={replayMaps} now={now} />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setLimit((value) => value + ACTIVITY_PAGE_SIZE)}
          className="mt-1 w-full cursor-pointer rounded py-1.5 text-[11px] font-semibold text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/40 hover:text-white"
        >
          {formatNumber(hidden)} earlier
        </button>
      ) : null}
    </div>
  );
}

function ActivityLine({
  event,
  replayMaps,
  now,
}: {
  event: AnalyticsRecentEventRow;
  replayMaps: ReturnType<typeof buildAnalyticsReplayMapIndex>;
  now: number;
}) {
  const activity = describeAnalyticsEvent(event, replayMaps);
  const style = ACTIVITY_KIND_STYLES[activity.kind];
  const href = analyticsEventHref(event);
  const body = (
    <>
      <span className={`mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.bar}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-osu-f1">
        {activity.verb} <span className={`text-white ${href ? "group-hover:underline" : ""}`}>{activity.subject}</span>
        {activity.detail ? <span className="text-osu-f1"> {activity.detail}</span> : null}
      </span>
      <span className="mt-[3px] flex-shrink-0 font-mono text-[11px] text-osu-f1" title={new Date(event.ts).toLocaleString()}>
        {formatAnalyticsAgo(now - event.ts)}
      </span>
    </>
  );
  const className = "flex items-start gap-2 rounded px-2 py-1.5";
  if (!href) return <div className={className}>{body}</div>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={formatAnalyticsActivityText(activity)}
      className={`group cursor-pointer transition-colors duration-[100ms] hover:bg-osu-b3/40 ${className}`}
    >
      {body}
    </a>
  );
}
