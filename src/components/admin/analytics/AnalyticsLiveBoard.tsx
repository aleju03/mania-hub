import { ArrowUpRight, Search, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  analyticsEventHref,
  describeAnalyticsEvent,
  formatAnalyticsActivityText,
  formatAnalyticsAgo,
  formatAnalyticsDuration,
  formatReferrerLabel,
  type AnalyticsReplayMapIndex,
  type AnalyticsSession,
} from "../../../lib/analytics-feed";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import { ACTIVITY_KIND_STYLES, VisitorChip, visitorColor } from "./shared";

/* Everyone who is on the site right now, one card each: what they are doing at
   this second, how long they have been around, and the last few steps that got
   them there. The point is peripheral awareness - no clicking required.

   The board sits above a long feed, so its geometry is deliberately frozen:
   every card reserves room for the most it can say, so it is the same height
   whether the visitor has one step or four. Cards resizing under every event
   used to drag a phone reading the feed up the page a few times a minute.

   Positions are frozen the same way - see useStableCells. */

const MAX_CARDS = 12;
const TRAIL_LENGTH = 3;
// Searching an activity trail is the expensive half of a match, so only the
// steps a card could plausibly be recognised by get formatted.
const SEARCHED_STEPS = 40;

export function AnalyticsLiveBoard({
  sessions,
  replayMaps,
  now,
}: {
  sessions: AnalyticsSession[];
  replayMaps: AnalyticsReplayMapIndex;
  now: number;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const [search, setSearch] = useState("");
  useSteadyScrollBelow(rootRef);

  const query = search.trim().toLowerCase();
  const online = sessions.filter((session) => session.online);
  const cells = useStableCells(online);

  /* Matched against every session in range, not just the online ones: a name
     typed in and found nowhere reads as broken, so a visitor who has just gone
     quiet still gets accounted for below the board. Keyed off `sessions`
     rather than `online` so the per-second clock doesn't re-run the trail
     search. */
  const matches = useMemo(() => (query ? rankSessions(sessions, query, replayMaps) : null), [sessions, query, replayMaps]);
  const onlineMatches = matches?.filter((session) => session.online) ?? null;
  const offlineMatches = matches ? matches.length - (onlineMatches?.length ?? 0) : 0;

  const pool = onlineMatches ?? cells;
  const shown = onlineMatches ? onlineMatches.slice(0, MAX_CARDS) : cells;
  const overflow = (onlineMatches ? onlineMatches.length : online.length) - shown.length;

  const lastSeen = sessions[0];
  const lastSeenAgo = lastSeen && Number.isFinite(lastSeen.lastTs) ? formatAnalyticsAgo(now - lastSeen.lastTs) : null;
  const subtitle = query
    ? `${formatNumber(pool.length)} of ${formatNumber(online.length)} online visitor${online.length === 1 ? "" : "s"} match`
    : online.length > 0
      ? `${formatNumber(online.length)} visitor${online.length === 1 ? "" : "s"} active in the last 5 minutes`
      : "nobody active in the last 5 minutes";

  return (
    <section ref={rootRef} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-osu-c2">Right now</h3>
        <span className="text-[10px] text-osu-f1">{subtitle}</span>
        {sessions.length > 0 ? <VisitorSearch value={search} onChange={setSearch} /> : null}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-osu-b3/40 bg-osu-b4/20 px-4 py-8 text-center">
          {query ? (
            <>
              <div className="text-[12px] text-osu-l2">Nobody online matches "{search.trim()}".</div>
              {offlineMatches > 0 ? (
                <div className="mt-1 text-[11px] text-osu-f1">
                  {formatNumber(offlineMatches)} visitor{offlineMatches === 1 ? "" : "s"} matched earlier in this range - they are in
                  the activity feed below.
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="text-[12px] text-osu-l2">Nobody on the site right now.</div>
              {lastSeenAgo ? <div className="mt-1 text-[11px] text-osu-f1">Last visitor was here {lastSeenAgo} ago.</div> : null}
            </>
          )}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((session) => (
              <LiveVisitorCard key={session.distinctId} session={session} replayMaps={replayMaps} now={now} />
            ))}
          </div>
          {overflow > 0 ? (
            <div className="mt-2 text-center text-[10px] text-osu-f1">
              {query
                ? `+ ${formatNumber(overflow)} more match${overflow === 1 ? "" : "es"} hidden`
                : `+ ${formatNumber(overflow)} more visitor${overflow === 1 ? "" : "s"} online`}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* Type a name and the board narrows to that visitor. Identity is what the box
   is for - a username, the V-number, a country - but the same query also
   catches the trail, so "Yunarkm" finds the person and, failing that, whoever
   is reading their profile. */
function VisitorSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="relative ml-auto">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("");
        }}
        placeholder="Find a visitor"
        aria-label="Find a visitor by name, country or activity"
        className="h-7 w-[150px] rounded-md border border-osu-b3/30 bg-osu-b5/70 pl-7 pr-6 text-[11px] text-white placeholder:text-osu-f1 focus:border-osu-pink/40 focus:outline-none sm:w-[190px] [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear visitor search"
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-osu-f1 transition-colors duration-[120ms] hover:text-white"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

/* Who the visitor is beats what they were doing, so identity hits sort above
   trail hits; within a tier the feed's own recency order is kept. */
function rankSessions(
  sessions: AnalyticsSession[],
  query: string,
  replayMaps: AnalyticsReplayMapIndex,
): AnalyticsSession[] {
  const identity: AnalyticsSession[] = [];
  const activity: AnalyticsSession[] = [];
  for (const session of sessions) {
    if (identityText(session).includes(query)) identity.push(session);
    else if (activityText(session, replayMaps).includes(query)) activity.push(session);
  }
  return identity.concat(activity);
}

function identityText(session: AnalyticsSession): string {
  const country = session.country ? `${session.country} ${getCountryName(session.country) || ""}` : "";
  return `${session.viewerUsername ?? "guest"} ${session.label} ${country} ${session.distinctId}`.toLowerCase();
}

function activityText(session: AnalyticsSession, replayMaps: AnalyticsReplayMapIndex): string {
  return session.events
    .slice(0, SEARCHED_STEPS)
    .map((row) => formatAnalyticsActivityText(describeAnalyticsEvent(row, replayMaps)))
    .join(" ")
    .toLowerCase();
}

/* The board is a wall of cells, not a leaderboard. Sessions arrive ordered by
   most recent event, so rendering them in that order re-sorted the whole board
   every time anybody clicked anything - and a browser that scroll-anchors will
   follow the card it anchored to as it moves, which throws the page around
   under whoever is reading. So a visitor keeps the cell they were given for as
   long as they are on the board, a leaver's cell goes to the next arrival, and
   nothing under the reader moves: cells only ever swap their contents. */
function useStableCells(online: AnalyticsSession[]): AnalyticsSession[] {
  const cellsRef = useRef(new Map<string, number>());
  const cells = cellsRef.current;

  const present = new Set(online.map((session) => session.distinctId));
  for (const id of Array.from(cells.keys())) {
    if (!present.has(id)) cells.delete(id);
  }

  // Visitors already on the board keep their place; free cells go to the most
  // recently active newcomers, so a busy board does not churn its occupants.
  const held = online.filter((session) => cells.has(session.distinctId));
  const arriving = online.filter((session) => !cells.has(session.distinctId));
  const shown = held.concat(arriving).slice(0, MAX_CARDS);

  const taken = new Set(cells.values());
  for (const session of shown) {
    if (cells.has(session.distinctId)) continue;
    let cell = 0;
    while (taken.has(cell)) cell += 1;
    taken.add(cell);
    cells.set(session.distinctId, cell);
  }

  return shown.sort((a, b) => (cells.get(a.distinctId) ?? 0) - (cells.get(b.distinctId) ?? 0));
}

/* Cards are a fixed size now, but a visitor arriving or leaving still resizes
   the board, and the board is metres of page above the feed on a phone.
   Chromium and Firefox absorb that with scroll anchoring; Safari has none. So
   when the whole board sits above the fold - everything that moved is behind
   the reader - hand the scroll position the difference back and they never
   feel it. Only where the browser is not already doing it: correcting on top
   of scroll anchoring moved the page by the full difference instead of
   holding it still. */
function useSteadyScrollBelow(ref: React.RefObject<HTMLElement | null>) {
  const bottomRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (browserAnchorsScroll()) return;
    const root = ref.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    // Document-relative, so the reader scrolling between renders is not
    // mistaken for the board resizing.
    const bottom = rect.bottom + window.scrollY;
    const previous = bottomRef.current;
    bottomRef.current = bottom;
    if (previous == null || bottom === previous) return;
    if (rect.bottom > 0) return;
    window.scrollBy(0, bottom - previous);
  });
}

/* WebKit ships neither the property nor the behaviour, so supporting
   `overflow-anchor` is the same question as "does this browser hold the scroll
   position for me". */
function browserAnchorsScroll(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");
}

function LiveVisitorCard({
  session,
  replayMaps,
  now,
}: {
  session: AnalyticsSession;
  replayMaps: AnalyticsReplayMapIndex;
  now: number;
}) {
  const color = visitorColor(session.slot);
  const [current, ...rest] = session.events;
  if (!current) return null;
  const activity = describeAnalyticsEvent(current, replayMaps);
  const style = ACTIVITY_KIND_STYLES[activity.kind];
  const Icon = style.icon;
  const href = analyticsEventHref(current);
  const trail = rest.slice(0, TRAIL_LENGTH);
  const hiddenSteps = Math.max(0, session.events.length - 1 - trail.length);

  return (
    <div className="relative overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b5/50">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${color.dot}`} aria-hidden="true" />
      <div className="pl-3">
        <div
          className="flex items-center gap-1.5 overflow-hidden border-b border-osu-b3/20 px-2.5 py-1.5"
          title={`visitor id: ${session.distinctId}`}
        >
          <VisitorChip
            label={session.label}
            slot={session.slot}
            country={session.country}
            deviceKind={session.deviceKind}
            viewerUsername={session.viewerUsername}
          />
          <span className="ml-auto flex-shrink-0 font-mono text-[10px] text-osu-f1" title="time between their first and last event in range">
            {formatAnalyticsDuration(session.durationMs)}
          </span>
        </div>

        <div className="px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <span className={`inline-flex h-4 w-4 items-center justify-center rounded ${style.bg}`}>
              <Icon className={`h-2.5 w-2.5 ${style.text}`} aria-hidden="true" />
            </span>
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${style.text}`}>{activity.verb}</span>
            <span className="ml-auto flex-shrink-0 font-mono text-[10px] text-osu-f1">
              {formatAnalyticsAgo(now - current.ts)}
            </span>
          </div>
          {/* Two lines of room whether or not the subject needs them. */}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="group mt-1 flex min-h-[33px] items-start gap-1 text-[12px] font-medium leading-snug text-white hover:text-osu-pink-light"
              title={`open what they are looking at`}
            >
              <span className="line-clamp-2 group-hover:underline">{activity.subject}</span>
              <ArrowUpRight className="mt-0.5 h-3 w-3 flex-shrink-0 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" />
            </a>
          ) : (
            <div className="mt-1 line-clamp-2 min-h-[33px] text-[12px] font-medium leading-snug text-white">{activity.subject}</div>
          )}
          <div className="mt-0.5 h-[15px] truncate text-[10px] text-osu-f1">{activity.detail ?? ""}</div>
        </div>

        <div className="border-t border-osu-b3/20 px-2.5 py-1.5">
          {Array.from({ length: TRAIL_LENGTH }).map((_, index) => {
            const row = trail[index];
            if (!row) {
              return (
                <div key={`slot-${index}`} className="flex h-[17px] items-center text-[10px] text-osu-f1/50">
                  {index === 0 && trail.length === 0 ? "no earlier steps" : null}
                </div>
              );
            }
            const step = describeAnalyticsEvent(row, replayMaps);
            const stepStyle = ACTIVITY_KIND_STYLES[step.kind];
            return (
              <div key={row.eventId ?? `${row.ts}-${index}`} className="flex h-[17px] items-center gap-1.5 text-[10px]">
                <span className={`h-1 w-1 flex-shrink-0 rounded-full ${stepStyle.bar}`} aria-hidden="true" />
                <span className="truncate text-osu-l2/70" title={formatAnalyticsActivityText(step)}>
                  {step.verb} <span className="text-osu-c2">{step.subject}</span>
                </span>
                <span className="ml-auto flex-shrink-0 font-mono text-osu-f1/70">{formatAnalyticsAgo(now - row.ts)}</span>
              </div>
            );
          })}
          <div className="mt-0.5 flex h-[14px] items-center gap-2 text-[9px] text-osu-f1/70">
            {hiddenSteps > 0 ? <span>+ {hiddenSteps} earlier</span> : null}
            {session.referrer ? <span className="truncate">via {formatReferrerLabel(session.referrer)}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
