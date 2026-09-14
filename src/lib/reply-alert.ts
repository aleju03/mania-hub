import { useEffect, useState } from "react";

import { getMyReplyAlert, type ReporterReplyAlert } from "./bug-reports";

/* The unread state behind the red bubble on the viewer's own avatar.
 *
 * The reporter-side twin of bug-report-alert.ts, and built the same way: one
 * module-level value with subscribers rather than a per-component fetch,
 * because the nav renders the avatar twice (desktop bar and phone drawer) and
 * /report wants to push the new count the moment it opens a thread instead of
 * leaving a bubble up until the next time the tab is focused.
 *
 * Only a signed-in viewer ever asks: the server function answers zero for
 * anyone else, and the hook is passed `enabled` so a signed-out visitor never
 * opens the request. Unlike the admin dot this one is not on a timer, because
 * it would be on a timer for every signed-in visitor rather than for one
 * person: it asks on mount and whenever the tab comes back, throttled so a
 * flurry of alt-tabs is one request. Coming back to the tab is the case that
 * matters, and a reply to a bug report is not worth a heartbeat.
 *
 * A reply raises this only when the owner sent it with notify on, so the
 * ordinary answer to a report stays where the reporter will find it rather
 * than arriving as an interruption. */

const EMPTY: ReporterReplyAlert = { count: 0, reports: 0, latestAt: null };
const MIN_GAP_MS = 60_000;

let current: ReporterReplyAlert = EMPTY;
let inFlight: Promise<void> | null = null;
let lastAt = 0;
const listeners = new Set<(alert: ReporterReplyAlert) => void>();

function publish(next: ReporterReplyAlert): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/** Hand the store a count somebody else already learned (/report, after it
 *  marks a thread read), so the bubble clears on the click. */
export function publishReplyAlert(alert: ReporterReplyAlert): void {
  lastAt = Date.now();
  publish(alert);
}

/** `force` is for a caller that knows the answer changed (/report loading the
 *  list); the throttle is for the focus events nobody asked for. */
export function refreshReplyAlert(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastAt < MIN_GAP_MS) return Promise.resolve();
  lastAt = Date.now();
  inFlight = getMyReplyAlert()
    .then((alert) => publish(alert))
    .catch(() => {})
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useReplyAlert(enabled: boolean): ReporterReplyAlert {
  const [alert, setAlert] = useState<ReporterReplyAlert>(current);

  useEffect(() => {
    if (!enabled) {
      setAlert(EMPTY);
      return;
    }
    setAlert(current);
    listeners.add(setAlert);
    void refreshReplyAlert();

    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshReplyAlert();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      listeners.delete(setAlert);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled]);

  return enabled ? alert : EMPTY;
}
