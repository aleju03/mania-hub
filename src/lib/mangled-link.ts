/* Links get mangled on their way through a group chat. An @mention gets glued
   onto the href, the chat app's own "unable to verify this page" banner comes
   along for the ride when someone copies the address, the link's own title
   ends up welded to the end of it. What arrives is always the same shape: a
   real route with junk stapled to the back of the first segment, and a
   visitor who wanted the route.

   Percent-encoding needs no special handling here. Every route name is ASCII
   and sits at the front, so "/packs%0A%E6%97%A0..." and its decoded form both
   still start with "packs". */

/* Only routes that stand on their own. "/player" and "/pull" are deliberately
   absent: both need a parameter, so a first segment of "player" says nothing
   about where the visitor was headed and we would be guessing. */
export const SALVAGEABLE_ROUTES = [
  "bbcode",
  "communities",
  "discord",
  "dynamic-renders",
  "farm-helper",
  "goals",
  "legal",
  "maps",
  "my-data",
  "my-stats",
  "packs",
  "privacy",
  "rankings",
  "replay",
  "report",
  "settings",
  "skins",
  "snipes",
  "streak",
  "terms",
  "top-plays",
  "tracker",
  "valley",
] as const;

/**
 * Given a pathname no route claimed, return the route the visitor probably
 * meant, or null when there is nothing worth guessing at.
 */
export function salvageMangledPath(pathname: string): string | null {
  const firstSegment = pathname.replace(/^\/+/, "").split("/", 1)[0]?.toLowerCase() ?? "";
  if (!firstSegment) return null;

  /* Longest match wins, so adding a "/maps-beta" later cannot be swallowed by
     the "maps" entry that sorts before it. */
  let best: string | null = null;
  for (const route of SALVAGEABLE_ROUTES) {
    if (!firstSegment.startsWith(route)) continue;
    if (!best || route.length > best.length) best = route;
  }
  if (!best) return null;

  /* Handing back the path we were given would be a redirect loop. Reaching
     here with an exact match means the route only failed on case. */
  const target = `/${best}`;
  return target === pathname ? null : target;
}
