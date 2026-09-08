import { useEffect, useState } from "react";

import { getBugReportAlert, type BugReportAlert } from "./bug-reports";

/* The unread state behind the red dot on the Admin nav button.
 *
 * One module-level value with subscribers rather than a per-component fetch:
 * the nav renders twice (desktop bar and phone drawer), and the board wants to
 * push the new count the moment it marks reports read instead of leaving a dot
 * up for the rest of the poll window.
 *
 * Only admins ever ask: the server function answers zero for anyone else, and
 * the hook is passed `enabled` so a signed-out visitor never even opens the
 * request. Polling stops while the tab is hidden and catches up on focus,
 * because the interesting case is coming back to the tab an hour later. */

const EMPTY: BugReportAlert = {
  count: 0,
  latestAt: null,
  byStatus: { new: 0, investigating: 0, pending: 0, fixed: 0, wontfix: 0, duplicate: 0, notabug: 0 },
};
const POLL_MS = 90_000;

let current: BugReportAlert = EMPTY;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(alert: BugReportAlert) => void>();

function publish(next: BugReportAlert): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/** Hand the store a count somebody else already learned (the board, after it
 *  marks a page of reports read), so the dot clears on the click. */
export function publishBugReportAlert(alert: BugReportAlert): void {
  publish(alert);
}

export function refreshBugReportAlert(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = getBugReportAlert()
    .then((alert) => publish(alert))
    .catch(() => {})
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useBugReportAlert(enabled: boolean): BugReportAlert {
  const [alert, setAlert] = useState<BugReportAlert>(current);

  useEffect(() => {
    if (!enabled) {
      setAlert(EMPTY);
      return;
    }
    setAlert(current);
    listeners.add(setAlert);
    void refreshBugReportAlert();

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshBugReportAlert();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshBugReportAlert();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      listeners.delete(setAlert);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled]);

  return enabled ? alert : EMPTY;
}
