import { ArrowUpRight } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
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
import { ACTIVITY_KIND_STYLES, VisitorChip, visitorColor } from "./shared";

/* Everyone who is on the site right now, one card each: what they are doing at
   this second, how long they have been around, and the last few steps that got
   them there. The point is peripheral awareness - no clicking required.

   The board sits above a long feed, so its geometry is deliberately frozen:
   every card reserves room for the most it can say, so it is the same height
   whether the visitor has one step or four. Cards resizing under every event
   used to drag a phone reading the feed up the page a few times a minute. */

const MAX_CARDS = 12;
const TRAIL_LENGTH = 3;

export function AnalyticsLiveBoard({
  sessions,
  replayMaps,
  now,
}: {
  sessions: AnalyticsSession[];
  replayMaps: AnalyticsReplayMapIndex;
  now: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useSteadyScrollBelow(rootRef);

  const online = sessions.filter((session) => session.online);
  const shown = online.slice(0, MAX_CARDS);
  const overflow = online.length - shown.length;

  if (online.length === 0) {
    const lastSeen = sessions[0];
    const lastSeenAgo = lastSeen && Number.isFinite(lastSeen.lastTs) ? formatAnalyticsAgo(now - lastSeen.lastTs) : null;
    return (
      <div ref={rootRef} className="rounded-lg border border-dashed border-osu-b3/40 bg-osu-b4/20 px-4 py-8 text-center">
        <div className="text-[12px] text-osu-l2">Nobody on the site right now.</div>
        {lastSeenAgo ? (
          <div className="mt-1 text-[11px] text-osu-f1">Last visitor was here {lastSeenAgo} ago.</div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((session) => (
          <LiveVisitorCard key={session.distinctId} session={session} replayMaps={replayMaps} now={now} />
        ))}
      </div>
      {overflow > 0 ? (
        <div className="mt-2 text-center text-[10px] text-osu-f1">
          + {overflow} more visitor{overflow === 1 ? "" : "s"} online
        </div>
      ) : null}
    </div>
  );
}

/* Cards are a fixed size now, but a visitor arriving or leaving still resizes
   the board, and the board is metres of page above the feed on a phone.
   Chromium's scroll anchoring absorbs that; Safari has none. So when the whole
   board sits above the fold - everything that moved is behind the reader - hand
   the scroll position the difference back and they never feel it. */
function useSteadyScrollBelow(ref: React.RefObject<HTMLDivElement | null>) {
  const bottomRef = useRef<number | null>(null);
  useLayoutEffect(() => {
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
