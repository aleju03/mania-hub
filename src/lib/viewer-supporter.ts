import { useSyncExternalStore } from "react";

/* Whether the signed-in viewer is a supporter, remembered in this browser so
   the nav can word its menu entry without a request on every page. Written
   whenever the site learns the viewer's status anyway (the welcome check,
   the /supporter page, a claimed gift); read as the supporter's expiry, so a
   run that ran out reads as over without anyone writing. The server render
   never knows, so it draws the non-supporter wording. */

const KEY = "mania-hub-viewer-supporter";
const listeners = new Set<() => void>();

function read(viewerId: number): number | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { id?: unknown; until?: unknown } | null;
    return raw && raw.id === viewerId && typeof raw.until === "number" ? raw.until : null;
  } catch {
    return null;
  }
}

export function rememberViewerSupporter(viewerId: number, expiresAt: number | null) {
  try {
    if (expiresAt && expiresAt > Date.now()) localStorage.setItem(KEY, JSON.stringify({ id: viewerId, until: expiresAt }));
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the menu keeps its default wording
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useViewerIsSupporter(viewerId: number | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!viewerId) return false;
      const until = read(viewerId);
      return until != null && until > Date.now();
    },
    () => false,
  );
}
