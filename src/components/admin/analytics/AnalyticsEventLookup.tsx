import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "../../ui/Avatar";
import { SectionCard } from "../SectionCard";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import {
  analyticsEventHasOwnDescription,
  analyticsEventHref,
  analyticsInspectionHref,
  buildAnalyticsReplayMapIndex,
  describeAnalyticsEvent,
  formatAnalyticsActivityText,
  formatAnalyticsAgo,
  type AnalyticsRecentEventRow,
} from "../../../lib/analytics-feed";
import { getAnalyticsEventCatalog, getAnalyticsEventLookup } from "../../../lib/analytics-monitor-data";
import {
  ANALYTICS_EVENT_LOOKUP_LIMIT,
  ANALYTICS_EVENT_LOOKUP_STORAGE_KEY,
  clampAnalyticsRangeHours,
  formatAnalyticsEventLabel,
  formatAnalyticsRangeLabel,
  type AnalyticsEventActorRow,
  type AnalyticsEventCatalogEntry,
  type AnalyticsEventLookupResult,
  type AnalyticsRange,
} from "../../../lib/analytics-monitor";
import { ACTIVITY_KIND_STYLES, AnalyticsEmptyMessage, InlineCountryFlag } from "./shared";

/* The feed read backwards: pick an event and see who fired it, newest first.
   The rest of the tab starts from a moment or from a player ("what happened",
   "what did this player do"); this starts from the thing that was done, which
   is the only way to answer "who opened the changelog recently".

   Two readings of the same window, because both questions get asked: people
   folds it to one row each, firings leaves every one of them. */

const PAGE_SIZE = 50;

type LookupMode = "people" | "firings";

export function AnalyticsEventLookup({ range, now }: { range: AnalyticsRange; now: number }) {
  const [catalog, setCatalog] = useState<AnalyticsEventCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [scoped, setScoped] = useState(false);
  const [mode, setMode] = useState<LookupMode>("people");
  const [result, setResult] = useState<AnalyticsEventLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Bumped by the refresh button; the lookup effect keys off it.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    getAnalyticsEventCatalog()
      .then((entries) => {
        if (!active) return;
        setCatalog(entries);
        setCatalogError(null);
        // Come back to whatever was being looked at, but only if the store
        // still has it: a name that has aged out would answer with nothing
        // forever and read as a broken card.
        try {
          const stored = window.localStorage.getItem(ANALYTICS_EVENT_LOOKUP_STORAGE_KEY);
          if (stored && entries.some((entry) => entry.event === stored)) setSelected(stored);
        } catch {
          // ignore
        }
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(error instanceof Error ? error.message : "Could not load the event list.");
      });
    return () => {
      active = false;
    };
  }, []);

  /* The window the lookup reads. Everything still inside the store's retention
     by default, since "the last few people who did this" is rarely a question
     about the last hour; the range selector above is offered as the narrower
     alternative rather than imposed. */
  const sinceTs = scoped ? Date.now() - clampAnalyticsRangeHours(range) * 60 * 60_000 : 0;

  useEffect(() => {
    if (!selected) {
      setResult(null);
      return;
    }
    let active = true;
    setPending(true);
    getAnalyticsEventLookup({ data: { event: selected, sinceTs } })
      .then((data) => {
        if (!active) return;
        setResult(data);
        setLookupError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setResult(null);
        setLookupError(error instanceof Error ? error.message : "Could not load this event.");
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
    // Keyed off the choices behind sinceTs rather than sinceTs itself, which is
    // recomputed from the clock on every render.
  }, [selected, scoped, range, reloads]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = useCallback((event: string) => {
    setSelected(event);
    setLimit(PAGE_SIZE);
    try {
      window.localStorage.setItem(ANALYTICS_EVENT_LOOKUP_STORAGE_KEY, event);
    } catch {
      // ignore
    }
  }, []);

  /* Ordered by when each event last fired rather than by how often it ever
     has: a rare event that just happened is what someone opening this card is
     usually looking for, and sorting by total buried those at the bottom. */
  const events = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const entries = [...(catalog ?? [])].sort((a, b) => b.lastTs - a.lastTs);
    if (!needle) return entries;
    return entries.filter(
      (entry) => entry.event.toLowerCase().includes(needle) || formatAnalyticsEventLabel(entry.event).toLowerCase().includes(needle),
    );
  }, [catalog, query]);

  const rows = result == null ? [] : mode === "people" ? result.people : result.occurrences;
  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  // Replay titles live on the events themselves, so a bare /replay firing
  // borrows its map from the others in the same answer.
  const replayMaps = useMemo(() => buildAnalyticsReplayMapIndex(result?.occurrences ?? []), [result]);

  const windowLabel = scoped ? formatAnalyticsRangeLabel(range).toLowerCase() : "everything still stored";
  const selectedLabel = selected ? formatAnalyticsEventLabel(selected) : null;
  const subtitle = catalogError
    ? "could not load"
    : selected
      ? result == null
        ? "loading..."
        : mode === "people"
          ? `${selectedLabel} · ${formatNumber(result.people.length)} ${result.people.length === 1 ? "person" : "people"}, ${windowLabel}`
          : `${selectedLabel} · ${formatNumber(result.occurrences.length)}${result.occurrences.length >= ANALYTICS_EVENT_LOOKUP_LIMIT ? "+" : ""} firings, ${windowLabel}`
      : "pick an event to see who fired it, most recent first";

  return (
    <SectionCard
      title="Event lookup"
      subtitle={subtitle}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex flex-shrink-0 items-center gap-0.5 rounded-md border border-osu-b3/30 bg-osu-b5/50 p-0.5" role="group" aria-label="Lookup window">
            <ModeButton active={!scoped} onClick={() => setScoped(false)} label="All time" title="Everything still inside the store's retention window" />
            <ModeButton active={scoped} onClick={() => setScoped(true)} label={formatAnalyticsRangeLabel(range)} title="Only the range selected above" />
          </div>
          <div className="flex flex-shrink-0 items-center gap-0.5 rounded-md border border-osu-b3/30 bg-osu-b5/50 p-0.5" role="group" aria-label="Lookup reading">
            <ModeButton active={mode === "people"} onClick={() => setMode("people")} label="People" title="One row per person, newest first" />
            <ModeButton active={mode === "firings"} onClick={() => setMode("firings")} label="Firings" title="Every firing, newest first" />
          </div>
          <button
            type="button"
            onClick={() => setReloads((value) => value + 1)}
            disabled={!selected || pending}
            title="Refresh this lookup"
            aria-label="Refresh this lookup"
            className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-osu-b3/30 bg-osu-b5/70 text-osu-l2 transition-colors duration-[120ms] hover:bg-osu-b3/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
          </button>
        </div>
      }
    >
      {catalogError ? (
        <AnalyticsEmptyMessage text={catalogError} />
      ) : (
        <div className="grid gap-2 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="flex h-7 items-center gap-1.5 rounded-md border border-osu-b3/30 bg-osu-b5/70 px-2">
              <Search className="h-3 w-3 flex-shrink-0 text-osu-f1" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Find an event"
                aria-label="Find an event"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-white placeholder:text-osu-f1 focus:outline-none"
              />
            </label>
            <div className="max-h-[180px] space-y-0.5 overflow-y-auto pr-1 lg:max-h-[420px]">
              {catalog == null ? (
                Array.from({ length: 6 }).map((_, index) => <div key={index} className="skeleton-pulse h-[30px] rounded-md" />)
              ) : events.length === 0 ? (
                <AnalyticsEmptyMessage text={query ? `No event matches "${query}".` : "The store has no events yet."} />
              ) : (
                events.map((entry) => (
                  <button
                    key={entry.event}
                    type="button"
                    onClick={() => select(entry.event)}
                    aria-pressed={selected === entry.event}
                    title={`${entry.event} · last fired ${new Date(entry.lastTs).toLocaleString()}`}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[100ms] ${
                      selected === entry.event ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{formatAnalyticsEventLabel(entry.event)}</span>
                    <span className="flex-shrink-0 font-mono text-[10px] text-osu-f1">{formatNumber(entry.count)}</span>
                    <span className="w-8 flex-shrink-0 text-right font-mono text-[10px] text-osu-f1">
                      {formatAnalyticsAgo(now - entry.lastTs)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="min-w-0">
            {lookupError ? (
              <AnalyticsEmptyMessage text={lookupError} />
            ) : !selected ? (
              <AnalyticsEmptyMessage text="Pick an event on the left." />
            ) : result == null ? (
              <div className="space-y-1">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="skeleton-pulse h-[34px] rounded-md" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <AnalyticsEmptyMessage
                text={
                  scoped
                    ? `Nobody fired ${selectedLabel} in this range.`
                    : `Nothing left in the retention window for ${selectedLabel}.`
                }
              />
            ) : (
              <>
                <div className={`max-h-[420px] space-y-0.5 overflow-y-auto pr-1 transition-opacity duration-[120ms] ${pending ? "opacity-50" : ""}`}>
                  {mode === "people"
                    ? (shown as AnalyticsEventActorRow[]).map((row) => <ActorRow key={row.actorKey} row={row} now={now} />)
                    : (shown as AnalyticsRecentEventRow[]).map((row, index) => (
                        <FiringRow key={row.eventId ?? `${row.ts}-${index}`} row={row} replayMaps={replayMaps} now={now} />
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
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function ModeButton({ active, onClick, label, title }: { active: boolean; onClick: () => void; label: string; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`cursor-pointer rounded px-2 py-1 text-[11px] font-semibold transition-colors duration-[120ms] ${
        active ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

/* One person who fired the event. A signed-in account is a person and links to
   their profile; a signed-out visitor is only ever the device they browsed on,
   so it says Guest and shows the id it is counted under. */
function ActorRow({ row, now }: { row: AnalyticsEventActorRow; now: number }) {
  const when = new Date(row.lastTs).toLocaleString();
  const body = (
    <>
      {row.viewerId ? (
        <Avatar userId={row.viewerId} size={22} shape="circle" />
      ) : (
        <span className="h-[22px] w-[22px] flex-shrink-0 rounded-full bg-osu-b3/40" aria-hidden="true" />
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {row.username ? (
          <span className="truncate text-[12px] font-medium text-white group-hover:underline">{row.username}</span>
        ) : (
          <span className="truncate text-[12px] font-medium text-osu-f1" title={`visitor id: ${row.distinctId}`}>
            Guest
          </span>
        )}
        {row.country ? (
          <span title={getCountryName(row.country) || row.country} className="flex-shrink-0">
            <InlineCountryFlag country={row.country} />
          </span>
        ) : null}
        {row.path ? <span className="truncate text-[10px] text-osu-f1">{row.path}</span> : null}
      </span>
      <span className="flex-shrink-0 font-mono text-[10px] text-osu-f1" title={`${formatNumber(row.count)} in this window`}>
        {formatNumber(row.count)}×
      </span>
      <span className="w-10 flex-shrink-0 text-right font-mono text-[11px] text-osu-l2" title={when}>
        {formatAnalyticsAgo(now - row.lastTs)}
      </span>
    </>
  );
  const className = "flex items-center gap-2 rounded-md px-2 py-1.5";
  if (!row.username) return <div className={className}>{body}</div>;
  return (
    <a
      href={analyticsInspectionHref(`/player/${encodeURIComponent(row.username)}`)}
      target="_blank"
      rel="noreferrer"
      title={`last fired ${when}`}
      className={`group cursor-pointer transition-colors duration-[100ms] hover:bg-osu-b3/30 ${className}`}
    >
      {body}
    </a>
  );
}

/* One firing, described the way the activity feed describes it, so a lookup of
   an event that carries detail (which skin, which pack) still reads as a
   sentence rather than as a bare timestamp. */
function FiringRow({
  row,
  replayMaps,
  now,
}: {
  row: AnalyticsRecentEventRow;
  replayMaps: ReturnType<typeof buildAnalyticsReplayMapIndex>;
  now: number;
}) {
  /* An event the feed has no sentence for falls through to the page it
     happened on, which in a lookup describes the wrong thing: every streak_run
     read as "visited card packs". Name it instead, and keep the page as the
     dim half of the line. */
  const activity = analyticsEventHasOwnDescription(row.event)
    ? describeAnalyticsEvent(row, replayMaps)
    : { kind: "visit" as const, verb: "fired", subject: formatAnalyticsEventLabel(row.event), detail: row.path || null };
  const style = ACTIVITY_KIND_STYLES[activity.kind];
  const href = analyticsEventHref(row);
  const body = (
    <>
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.bar}`} aria-hidden="true" />
      <span
        className={`w-[104px] flex-shrink-0 truncate text-[11px] font-semibold ${row.viewerUsername ? "text-osu-pink-light" : "text-osu-f1/60"}`}
        title={row.viewerUsername ? `signed in as ${row.viewerUsername}` : `visitor id: ${row.distinctId}`}
      >
        {row.viewerUsername ?? "Guest"}
      </span>
      <InlineCountryFlag country={row.country} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-osu-f1">
        {activity.verb} <span className={`text-white ${href ? "group-hover:underline" : ""}`}>{activity.subject}</span>
        {activity.detail ? <span className="text-osu-f1"> {activity.detail}</span> : null}
      </span>
      <span className="w-10 flex-shrink-0 text-right font-mono text-[11px] text-osu-l2" title={row.timestamp}>
        {formatAnalyticsAgo(now - row.ts)}
      </span>
    </>
  );
  const className = "flex items-center gap-2 rounded-md px-2 py-1.5";
  if (!href) return <div className={className} title={formatAnalyticsActivityText(activity)}>{body}</div>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={formatAnalyticsActivityText(activity)}
      className={`group cursor-pointer transition-colors duration-[100ms] hover:bg-osu-b3/30 ${className}`}
    >
      {body}
    </a>
  );
}
