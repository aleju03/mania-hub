import { useEffect, useState } from "react";

import { getBannedUsersAlert } from "./banned-users";

/* The count behind the banned-users badge on the admin menu. Same shape as
   bug-report-alert.ts: one shared value for both renders of the nav, polled
   only for admins and only while the tab is visible, and publishable by the
   page the moment it marks accounts seen. */

const POLL_MS = 5 * 60_000;

let current = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(count: number) => void>();

function publish(next: number): void {
  current = next;
  for (const listener of listeners) listener(next);
}

export function publishBannedUsersAlert(count: number): void {
  publish(count);
}

export function refreshBannedUsersAlert(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = getBannedUsersAlert()
    .then((count) => publish(count))
    .catch(() => {})
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function useBannedUsersAlert(enabled: boolean): number {
  const [count, setCount] = useState(current);

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    setCount(current);
    listeners.add(setCount);
    void refreshBannedUsersAlert();

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshBannedUsersAlert();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshBannedUsersAlert();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      listeners.delete(setCount);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return enabled ? count : 0;
}
