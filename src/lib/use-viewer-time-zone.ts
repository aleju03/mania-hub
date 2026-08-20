import { useHydrated } from "./use-hydrated";
import { browserTimeZone } from "./time-zone";

/* The IANA zone the person reading the page is actually in - "America/Costa_Rica",
   "Europe/Berlin" - for the dates that name a moment somebody lived through: when
   a score was set, when a card was pulled, when a replay was played. osu! prints
   those in the viewer's own clock, and a site that prints the same play a day
   later than the score page it links to reads as wrong even though both are right.
 *
 * "UTC" until hydration is over, which is what every caller must render on the
 * server anyway. Feeding the browser's zone into the hydration render is a text
 * mismatch on any date whose UTC day and local day differ - React #418, and the
 * recovery re-render wipes the <html> theme vars. So the real zone joins one
 * render later, through a normal diff. See use-hydrated.ts for that gate.
 *
 * Not for a date with no instant behind it (a changelog day, a join date):
 * formatDate ignores the zone for those rather than trusting the caller. */
export function useViewerTimeZone(): string {
  return useHydrated() ? browserTimeZone() : "UTC";
}
