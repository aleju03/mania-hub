import { ArrowUpRight, ChevronDown, LayoutGrid, List } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import {
  ANALYTICS_ACTIVITY_KINDS,
  analyticsEventHref,
  describeAnalyticsEvent,
  formatAnalyticsActivityText,
  formatAnalyticsAgo,
  formatAnalyticsDuration,
  formatReferrerLabel,
  type AnalyticsActivityKind,
  type AnalyticsRecentEventRow,
  type AnalyticsReplayMapIndex,
  type AnalyticsSession,
} from "../../../lib/analytics-feed";
import {
  ANALYTICS_RECENT_EVENTS_LIMIT,
  readStoredAnalyticsStreamMode,
  storeAnalyticsStreamMode,
  type AnalyticsCountryRow,
  type AnalyticsStreamMode,
} from "../../../lib/analytics-monitor";
import { ACTIVITY_KIND_STYLES, AnalyticsCountryFilter, AnalyticsEmptyMessage, VisitorChip, visitorColor } from "./shared";

/* The feed, read two ways. "Stream" interleaves every visitor so the page reads
   like a running commentary of the site; "Sessions" folds it back per visitor
   so a single journey can be followed end to end. */

const PAGE_SIZE = 150;
// Rows younger than this get a highlight so new arrivals catch the eye.
const FRESH_MS = 4_000;
// How long a finger has to stay on a chip before it means "hide this kind".
const LONG_PRESS_MS = 400;

function withToggled<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

function without<T>(set: Set<T>, value: T) {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

export function AnalyticsStream({
  rows,
  sessions,
  replayMaps,
  countries,
  country,
  loading,
  now,
  onCountryChange,
}: {
  rows: AnalyticsRecentEventRow[];
  sessions: AnalyticsSession[];
  replayMaps: AnalyticsReplayMapIndex;
  countries: AnalyticsCountryRow[];
  country: string | null;
  loading?: boolean;
  now: number;
  onCountryChange: (country: string | null) => void;
}) {
  // Safe to read storage during init: this panel only ever mounts on the client,
  // after the first snapshot lands, so there is no server render to mismatch.
  const [mode, setMode] = useState<AnalyticsStreamMode>(() => readStoredAnalyticsStreamMode() ?? "stream");
  // Two ways to narrow the feed: pick the kinds you want (tap), or drop the ones
  // you don't (long press / right click). Picking wins when both are in play.
  const [kinds, setKinds] = useState<Set<AnalyticsActivityKind>>(new Set());
  const [hidden, setHidden] = useState<Set<AnalyticsActivityKind>>(new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);

  const selectMode = (next: AnalyticsStreamMode) => {
    setMode(next);
    storeAnalyticsStreamMode(next);
  };

  const slotByVisitor = useMemo(() => {
    const slots = new Map<string, number>();
    sessions.forEach((session) => slots.set(session.distinctId, session.slot));
    return slots;
  }, [sessions]);

  const kindCounts = useMemo(() => {
    const counts = new Map<AnalyticsActivityKind, number>();
    rows.forEach((row) => {
      const kind = describeAnalyticsEvent(row, replayMaps).kind;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    });
    return counts;
  }, [rows, replayMaps]);

  const filtered = kinds.size > 0 || hidden.size > 0;
  const showsKind = useCallback(
    (kind: AnalyticsActivityKind) => (kinds.size > 0 ? kinds.has(kind) : !hidden.has(kind)),
    [kinds, hidden],
  );

  const filteredRows = useMemo(() => {
    if (!filtered) return rows;
    return rows.filter((row) => showsKind(describeAnalyticsEvent(row, replayMaps).kind));
  }, [rows, filtered, showsKind, replayMaps]);

  const filteredSessions = useMemo(() => {
    if (!filtered) return sessions;
    return sessions
      .map((session) => ({
        ...session,
        events: session.events.filter((row) => showsKind(describeAnalyticsEvent(row, replayMaps).kind)),
      }))
      .filter((session) => session.events.length > 0);
  }, [sessions, filtered, showsKind, replayMaps]);

  // A narrowed view starts from the top again rather than deep in a long list.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [kinds, hidden, country, mode]);

  // Picking and hiding are opposites, so a kind never sits in both sets.
  const toggleKind = (kind: AnalyticsActivityKind) => {
    setKinds((prev) => withToggled(prev, kind));
    setHidden((prev) => without(prev, kind));
  };

  const toggleHidden = (kind: AnalyticsActivityKind) => {
    setHidden((prev) => withToggled(prev, kind));
    setKinds((prev) => without(prev, kind));
  };

  const clearFilters = () => {
    setKinds(new Set());
    setHidden(new Set());
  };

  const countryLabel = country ? ` in ${getCountryName(country) || country}` : "";
  const truncated = rows.length >= ANALYTICS_RECENT_EVENTS_LIMIT;
  const shownSessions = filtered ? filteredSessions : sessions;
  const countText = filtered
    ? `${formatNumber(filteredRows.length)} of ${formatNumber(rows.length)} event${rows.length === 1 ? "" : "s"}`
    : `${truncated ? "last " : ""}${formatNumber(rows.length)} event${rows.length === 1 ? "" : "s"}`;
  const subtitle = loading
    ? `loading${countryLabel || " all countries"}...`
    : `${countText}${countryLabel} from ${formatNumber(shownSessions.length)} visitor${shownSessions.length === 1 ? "" : "s"}`;

  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30">
      <div className="flex flex-col gap-2 border-b border-osu-b3/20 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-c2">Activity</div>
            <div className="text-[10px] text-osu-f1">{subtitle}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center rounded-md border border-osu-b3/30 bg-osu-b5/70 p-0.5">
              <ModeButton active={mode === "stream"} onClick={() => selectMode("stream")} icon={<List className="h-3 w-3" />} label="Stream" />
              <ModeButton active={mode === "sessions"} onClick={() => selectMode("sessions")} icon={<LayoutGrid className="h-3 w-3" />} label="Sessions" />
            </div>
            <AnalyticsCountryFilter country={country} options={countries} onChange={onCountryChange} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <FilterChip state={filtered ? "idle" : "picked"} onClick={clearFilters} label="Everything" count={rows.length} />
          {ANALYTICS_ACTIVITY_KINDS.map((kind) => {
            const count = kindCounts.get(kind) ?? 0;
            if (count === 0) return null;
            const style = ACTIVITY_KIND_STYLES[kind];
            const Icon = style.icon;
            const state = kinds.has(kind) ? "picked" : hidden.has(kind) ? "hidden" : "idle";
            return (
              <FilterChip
                key={kind}
                state={state}
                onClick={() => toggleKind(kind)}
                onHide={() => toggleHidden(kind)}
                label={style.label}
                count={count}
                icon={<Icon className={`h-3 w-3 ${state === "hidden" ? "text-osu-f1/50" : style.text}`} />}
              />
            );
          })}
        </div>
      </div>

      <div className="p-2">
        {loading ? (
          <div className="space-y-1">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="skeleton-pulse h-[28px] rounded-md" />
            ))}
          </div>
        ) : mode === "stream" ? (
          <StreamRows
            rows={filteredRows}
            replayMaps={replayMaps}
            slotByVisitor={slotByVisitor}
            now={now}
            limit={limit}
            onMore={() => setLimit((value) => value + PAGE_SIZE)}
            country={country}
          />
        ) : (
          <SessionRows
            sessions={filteredSessions}
            replayMaps={replayMaps}
            now={now}
            limit={limit}
            onMore={() => setLimit((value) => value + PAGE_SIZE)}
            country={country}
          />
        )}
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-6 items-center gap-1.5 rounded px-2 text-[10px] font-semibold transition-colors duration-[120ms] cursor-pointer ${
        active ? "bg-osu-pink/20 text-white" : "text-osu-l2 hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/* Tap picks a kind, holding it (or right clicking on a desktop) drops it from
   the feed instead - the quickest way to say "everything except packs". */
function FilterChip({
  state,
  onClick,
  onHide,
  label,
  count,
  icon,
}: {
  state: "picked" | "hidden" | "idle";
  onClick: () => void;
  onHide?: () => void;
  label: string;
  count: number;
  icon?: React.ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);

  const cancelHold = useCallback(() => {
    if (timer.current == null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  const startHold = () => {
    if (!onHide) return;
    held.current = false;
    cancelHold();
    timer.current = setTimeout(() => {
      timer.current = null;
      held.current = true;
      navigator.vibrate?.(12);
      onHide();
    }, LONG_PRESS_MS);
  };

  const hide = (event: React.MouseEvent) => {
    if (!onHide) return;
    // Android raises this at the end of a long press too, and the hold already
    // did the work - keep it from toggling straight back.
    event.preventDefault();
    if (held.current) return;
    cancelHold();
    onHide();
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        cancelHold();
        // The press already hid the kind; the click that follows it is noise.
        if (held.current) {
          held.current = false;
          return;
        }
        if (onHide && (event.altKey || event.metaKey)) {
          onHide();
          return;
        }
        onClick();
      }}
      onPointerDown={startHold}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onContextMenu={hide}
      aria-pressed={state === "picked"}
      title={onHide ? `${label} - hold or right click to hide` : undefined}
      style={{ WebkitTouchCallout: "none" }}
      className={`flex h-6 select-none items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium transition-colors duration-[120ms] cursor-pointer ${
        state === "picked"
          ? "border-osu-pink/40 bg-osu-pink/15 text-white"
          : state === "hidden"
            ? "border-osu-b3/20 bg-osu-b5/30 text-osu-f1/60 hover:text-osu-l2"
            : "border-osu-b3/25 bg-osu-b5/50 text-osu-l2 hover:border-osu-b3/50 hover:text-white"
      }`}
    >
      {icon}
      <span className={state === "hidden" ? "line-through" : undefined}>{label}</span>
      <span className={`font-mono ${state === "hidden" ? "text-osu-f1/50" : "text-osu-f1"}`}>{formatNumber(count)}</span>
    </button>
  );
}

function EmptyForFilter({ country }: { country: string | null }) {
  return (
    <AnalyticsEmptyMessage
      text={country ? "No matching events for this country in the selected range." : "No matching events in the selected range."}
    />
  );
}

function ShowMore({ remaining, onMore }: { remaining: number; onMore: () => void }) {
  if (remaining <= 0) return null;
  return (
    <button
      type="button"
      onClick={onMore}
      className="mt-1 w-full rounded-md border border-osu-b3/25 bg-osu-b5/40 py-1.5 text-[10px] font-semibold text-osu-l2 transition-colors duration-[120ms] hover:border-osu-b3/50 hover:text-white cursor-pointer"
    >
      Show {formatNumber(Math.min(remaining, PAGE_SIZE))} more · {formatNumber(remaining)} hidden
    </button>
  );
}

function StreamRows({
  rows,
  replayMaps,
  slotByVisitor,
  now,
  limit,
  onMore,
  country,
}: {
  rows: AnalyticsRecentEventRow[];
  replayMaps: AnalyticsReplayMapIndex;
  slotByVisitor: Map<string, number>;
  now: number;
  limit: number;
  onMore: () => void;
  country: string | null;
}) {
  if (rows.length === 0) return <EmptyForFilter country={country} />;
  const shown = rows.slice(0, limit);
  return (
    <>
      <div className="max-h-[560px] space-y-px overflow-y-auto pr-1">
        {shown.map((row, index) => (
          <StreamRow
            key={row.eventId ?? `${row.ts}-${row.distinctId}-${index}`}
            row={row}
            replayMaps={replayMaps}
            slot={slotByVisitor.get(row.distinctId) ?? 0}
            now={now}
          />
        ))}
      </div>
      <ShowMore remaining={rows.length - shown.length} onMore={onMore} />
    </>
  );
}

function StreamRow({
  row,
  replayMaps,
  slot,
  now,
}: {
  row: AnalyticsRecentEventRow;
  replayMaps: AnalyticsReplayMapIndex;
  slot: number;
  now: number;
}) {
  const activity = describeAnalyticsEvent(row, replayMaps);
  const style = ACTIVITY_KIND_STYLES[activity.kind];
  const Icon = style.icon;
  const color = visitorColor(slot);
  const href = analyticsEventHref(row);
  const fresh = now - row.ts < FRESH_MS;
  const sentence = (
    <>
      <span className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded ${style.bg}`}>
        <Icon className={`h-2.5 w-2.5 ${style.text}`} aria-hidden="true" />
      </span>
      <span className={`flex-shrink-0 text-[11px] font-semibold ${style.text}`}>{activity.verb}</span>
      <span className="truncate text-[11px] font-medium text-white group-hover:underline">{activity.subject}</span>
      {activity.detail ? <span className="truncate text-[10px] text-osu-f1">{activity.detail}</span> : null}
      {href ? (
        <ArrowUpRight className="h-3 w-3 flex-shrink-0 text-osu-f1 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" />
      ) : null}
    </>
  );

  const ago = formatAnalyticsAgo(now - row.ts);
  // One line on a real screen; on a phone the sentence drops below the visitor
  // so the subject keeps the full width instead of truncating to nothing.
  const body = (
    <>
      <span className={`h-3 w-[2px] flex-shrink-0 rounded-full ${color.dot}`} aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
        <span
          className="flex items-center gap-1.5 overflow-hidden sm:w-[142px] sm:flex-shrink-0"
          title={`visitor id: ${row.distinctId}`}
        >
          <VisitorChip
            label={`V${slot + 1}`}
            slot={slot}
            country={row.country}
            deviceKind={row.deviceKind}
            viewerUsername={row.viewerUsername}
          />
          <span className="ml-auto flex-shrink-0 font-mono text-[10px] text-osu-f1 sm:hidden">{ago}</span>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{sentence}</span>
      </span>
      <span className="hidden w-11 flex-shrink-0 text-right font-mono text-[10px] text-osu-f1 sm:block" title={row.timestamp}>
        {ago}
      </span>
    </>
  );

  const className = `group flex items-center gap-2 rounded-md px-2 py-1 transition-colors duration-[150ms] ${
    fresh ? "bg-osu-pink/10" : "hover:bg-osu-b3/25"
  }`;

  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${className} cursor-pointer`} title={formatAnalyticsActivityText(activity)}>
      {body}
    </a>
  ) : (
    <div className={className} title={formatAnalyticsActivityText(activity)}>
      {body}
    </div>
  );
}

function SessionRows({
  sessions,
  replayMaps,
  now,
  limit,
  onMore,
  country,
}: {
  sessions: AnalyticsSession[];
  replayMaps: AnalyticsReplayMapIndex;
  now: number;
  limit: number;
  onMore: () => void;
  country: string | null;
}) {
  // A lone visitor starts expanded (toggling still collapses it); with several
  // visitors everything starts collapsed.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const defaultOpen = sessions.length === 1;
  if (sessions.length === 0) return <EmptyForFilter country={country} />;
  const shown = sessions.slice(0, limit);

  const toggle = (id: string) => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="max-h-[560px] space-y-1 overflow-y-auto pr-1">
        {shown.map((session) => {
          const open = toggled.has(session.distinctId) !== defaultOpen;
          const color = visitorColor(session.slot);
          const latest = session.events[0];
          const activity = describeAnalyticsEvent(latest, replayMaps);
          const style = ACTIVITY_KIND_STYLES[activity.kind];
          const Icon = style.icon;
          return (
            <div key={session.distinctId} className="overflow-hidden rounded-md border border-osu-b3/20 bg-osu-b5/40">
              <button
                type="button"
                onClick={() => toggle(session.distinctId)}
                title={`visitor id: ${session.distinctId}`}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-[100ms] hover:bg-osu-b3/30 cursor-pointer"
              >
                <span className={`h-4 w-[2px] flex-shrink-0 rounded-full ${color.dot}`} aria-hidden="true" />
                <span className="flex w-[92px] flex-shrink-0 items-center gap-1.5 overflow-hidden sm:w-[142px]">
                  <VisitorChip
                    label={session.label}
                    slot={session.slot}
                    country={session.country}
                    deviceKind={session.deviceKind}
                    viewerUsername={session.viewerUsername}
                  />
                </span>
                {session.online ? (
                  <span className="flex flex-shrink-0 items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-osu-green-light">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-osu-green-light" />
                    live
                  </span>
                ) : null}
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Icon className={`h-3 w-3 flex-shrink-0 ${style.text}`} aria-hidden="true" />
                  <span className={`flex-shrink-0 text-[11px] font-semibold ${style.text}`}>{activity.verb}</span>
                  <span className="truncate text-[11px] text-white">{activity.subject}</span>
                </span>
                <span className="hidden flex-shrink-0 text-[10px] text-osu-f1 sm:inline">
                  {formatNumber(session.events.length)} step{session.events.length === 1 ? "" : "s"}
                </span>
                <span className="w-10 flex-shrink-0 text-right font-mono text-[10px] text-osu-f1 sm:w-12" title="session length">
                  {formatAnalyticsDuration(session.durationMs)}
                </span>
                <ChevronDown className={`h-3 w-3 flex-shrink-0 text-osu-f1 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
              </button>
              {open ? (
                <div className="border-t border-osu-b3/20 py-0.5">
                  {session.referrer ? (
                    <div className="px-2 py-1 pl-7 text-[10px] text-osu-f1">
                      arrived via <span className="text-osu-c2">{formatReferrerLabel(session.referrer)}</span>
                    </div>
                  ) : null}
                  {session.events.map((row, index) => (
                    <SessionStep
                      key={row.eventId ?? `${row.ts}-${index}`}
                      row={row}
                      replayMaps={replayMaps}
                      now={now}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <ShowMore remaining={sessions.length - shown.length} onMore={onMore} />
    </>
  );
}

function SessionStep({
  row,
  replayMaps,
  now,
}: {
  row: AnalyticsRecentEventRow;
  replayMaps: AnalyticsReplayMapIndex;
  now: number;
}) {
  const activity = describeAnalyticsEvent(row, replayMaps);
  const style = ACTIVITY_KIND_STYLES[activity.kind];
  const href = analyticsEventHref(row);
  const className = "group flex items-center gap-2 py-1 pl-7 pr-2 transition-colors duration-[100ms] hover:bg-osu-b3/30";
  const content = (
    <>
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.bar}`} aria-hidden="true" />
      <span className={`flex-shrink-0 text-[10px] font-semibold ${style.text}`}>{activity.verb}</span>
      <span className="truncate text-[10px] text-osu-c2 group-hover:underline">{activity.subject}</span>
      {activity.detail ? <span className="truncate text-[10px] text-osu-f1">{activity.detail}</span> : null}
      <span className="ml-auto flex-shrink-0 font-mono text-[10px] text-osu-f1" title={row.timestamp}>
        {formatAnalyticsAgo(now - row.ts)}
      </span>
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${className} cursor-pointer`} title={`open ${activity.subject}`}>
      {content}
    </a>
  ) : (
    <div className={className} title={formatAnalyticsActivityText(activity)}>
      {content}
    </div>
  );
}
