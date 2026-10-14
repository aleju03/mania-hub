import { ArrowUpRight, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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

/* Everyone who is on the site right now, one row each: who they are, what
   they are doing at this second, and the step before it.

   The board is a fixed-height panel that scrolls inside itself, and every row
   is the same height, so nothing that happens on it can move the page. Inside
   it a visitor keeps their row for as long as they are on the board - see
   useBoardRows. */

// Searching an activity trail is the expensive half of a match, so only the
// steps a row could plausibly be recognised by get formatted.
const SEARCHED_STEPS = 40;

export function AnalyticsLiveBoard({
  sessions,
  replayMaps,
  now,
  className = "",
}: {
  sessions: AnalyticsSession[];
  replayMaps: AnalyticsReplayMapIndex;
  now: number;
  className?: string;
}) {
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const online = sessions.filter((session) => session.online);
  const boardRows = useBoardRows(sessions);

  /* Matched against every session in range, not just the online ones: a name
     typed in and found nowhere reads as broken, so a visitor who has just gone
     quiet still gets accounted for. Keyed off `sessions` rather than `online`
     so the per-second clock doesn't re-run the trail search. */
  const matches = useMemo(() => (query ? rankSessions(sessions, query, replayMaps) : null), [sessions, query, replayMaps]);
  const onlineMatches = matches?.filter((session) => session.online) ?? null;
  const offlineMatches = matches ? matches.length - (onlineMatches?.length ?? 0) : 0;

  const shown: Array<AnalyticsSession | null> = onlineMatches ?? boardRows;

  const lastSeen = sessions[0];
  const lastSeenAgo = lastSeen && Number.isFinite(lastSeen.lastTs) ? formatAnalyticsAgo(now - lastSeen.lastTs) : null;
  const countText = query
    ? `${formatNumber(onlineMatches?.length ?? 0)} of ${formatNumber(online.length)} match`
    : `${formatNumber(online.length)} online`;

  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/30 ${className}`}>
      <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-white/[0.07] px-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-osu-c2">Right now</h3>
        <span className="truncate text-[11px] text-osu-f1" title="visitors active in the last 5 minutes">{countText}</span>
        <VisitorSearch value={search} onChange={setSearch} />
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
          {query ? (
            <>
              <div className="text-[12px] text-osu-l2">Nobody online matches "{search.trim()}".</div>
              {offlineMatches > 0 ? (
                <div className="mt-1 text-[11px] text-osu-f1">
                  {formatNumber(offlineMatches)} visitor{offlineMatches === 1 ? "" : "s"} matched earlier in this range - they are in
                  the activity feed.
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
        <div className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
          {shown.map((session, index) =>
            session ? (
              <LiveVisitorRow key={session.distinctId} session={session} replayMaps={replayMaps} now={now} />
            ) : (
              <div key={`empty-${index}`} className="h-[66px] border-b border-white/[0.07]" aria-hidden="true" />
            ),
          )}
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
        aria-label="Find a visitor by country or activity"
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
  return `${session.signedIn ? "signed in" : "guest"} ${session.label} ${country} ${session.distinctId}`.toLowerCase();
}

function activityText(session: AnalyticsSession, replayMaps: AnalyticsReplayMapIndex): string {
  return session.events
    .slice(0, SEARCHED_STEPS)
    .map((row) => formatAnalyticsActivityText(describeAnalyticsEvent(row, replayMaps)))
    .join(" ")
    .toLowerCase();
}

/* A visitor keeps the row they were given for as long as they are on the
   board. Sessions arrive ordered by most recent event, and rendering them in
   that order re-sorted the whole board every time anybody clicked anything.
   Someone who goes quiet stays in their row, dimmed, until the next arrival
   takes it, so a leaver never pulls the rows under them up either. Only rows
   at the very end, with nothing below them to move, are dropped. */
function useBoardRows(sessions: AnalyticsSession[]): Array<AnalyticsSession | null> {
  const rowsRef = useRef(new Map<string, number>());
  const rows = rowsRef.current;
  const byId = new Map(sessions.map((session) => [session.distinctId, session]));

  // Gone from the loaded range entirely (a range or country change).
  for (const id of Array.from(rows.keys())) {
    if (!byId.has(id)) rows.delete(id);
  }

  const occupant = new Map<number, string>();
  rows.forEach((row, id) => occupant.set(row, id));
  const isOnline = (id: string | undefined) => (id ? byId.get(id)?.online === true : false);

  // Newcomers in recency order, so on a fresh board the latest is on top.
  for (const session of sessions) {
    if (!session.online || rows.has(session.distinctId)) continue;
    let row = 0;
    while (isOnline(occupant.get(row))) row += 1;
    const evicted = occupant.get(row);
    if (evicted != null) rows.delete(evicted);
    occupant.set(row, session.distinctId);
    rows.set(session.distinctId, row);
  }

  let length = 0;
  occupant.forEach((id, row) => {
    if (isOnline(id)) length = Math.max(length, row + 1);
  });
  occupant.forEach((id, row) => {
    if (row >= length) rows.delete(id);
  });

  return Array.from({ length }, (_, row) => {
    const id = occupant.get(row);
    return id ? byId.get(id) ?? null : null;
  });
}

function LiveVisitorRow({
  session,
  replayMaps,
  now,
}: {
  session: AnalyticsSession;
  replayMaps: AnalyticsReplayMapIndex;
  now: number;
}) {
  const color = visitorColor(session.slot);
  const [current, previous] = session.events;
  if (!current) return null;
  const activity = describeAnalyticsEvent(current, replayMaps);
  const style = ACTIVITY_KIND_STYLES[activity.kind];
  const Icon = style.icon;
  const href = analyticsEventHref(current);
  const step = previous ? describeAnalyticsEvent(previous, replayMaps) : null;
  const earlier = Math.max(0, session.events.length - 2);
  const left = !session.online;

  return (
    <div
      className={`relative flex h-[66px] flex-col justify-center gap-0.5 border-b border-white/[0.07] pl-3.5 pr-3 transition-opacity duration-300 ${
        left ? "opacity-40" : ""
      }`}
      title={`visitor id: ${session.distinctId}`}
    >
      <span className={`absolute inset-y-2 left-0 w-[3px] rounded-r ${color.dot}`} aria-hidden="true" />
      <div className="flex items-center gap-1.5 overflow-hidden">
        <VisitorChip
          label={session.label}
          slot={session.slot}
          country={session.country}
          deviceKind={session.deviceKind}
          signedIn={session.signedIn}
        />
        <span className="ml-auto flex-shrink-0 font-mono text-[11px] text-osu-f1" title="time between their first and last event in range">
          {left ? `left ${formatAnalyticsAgo(now - session.lastTs)} ago` : formatAnalyticsDuration(session.durationMs)}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className={`h-3 w-3 flex-shrink-0 ${style.text}`} aria-hidden="true" />
        <span className={`flex-shrink-0 text-[11px] font-semibold ${style.text}`}>{activity.verb}</span>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="group flex min-w-0 items-center gap-1 text-[12px] font-medium text-white hover:text-osu-pink-light"
            title={formatAnalyticsActivityText(activity)}
          >
            <span className="truncate group-hover:underline">{activity.subject}</span>
            <ArrowUpRight className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" />
          </a>
        ) : (
          <span className="truncate text-[12px] font-medium text-white" title={formatAnalyticsActivityText(activity)}>
            {activity.subject}
          </span>
        )}
        <span className="ml-auto flex-shrink-0 pl-1 font-mono text-[11px] text-osu-f1">{formatAnalyticsAgo(now - current.ts)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-osu-f1">
        {step ? (
          <span className="truncate" title={formatAnalyticsActivityText(step)}>
            before: {step.verb} <span className="text-osu-c2">{step.subject}</span>
          </span>
        ) : (
          <span className="truncate">first step</span>
        )}
        {earlier > 0 ? <span className="flex-shrink-0">+{formatNumber(earlier)}</span> : null}
        {session.referrer ? (
          <span className="ml-auto max-w-[40%] flex-shrink-0 truncate">via {formatReferrerLabel(session.referrer)}</span>
        ) : null}
      </div>
    </div>
  );
}
