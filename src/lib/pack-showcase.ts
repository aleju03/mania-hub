// The showcase's own rules on this side of the wire: how many cards a shelf
// holds, and how much room to leave for one while it loads.
//
// The module imports nothing, which is the point of it. Both things here are
// wanted somewhere thin: the picker only counts against the cap, and the hint
// is parsed while the server renders the page, before anything else on it
// exists. Neither should have to pull in a file full of server functions to
// get a number.

/* How many cards a collector may put in their showcase. The backend holds its
   own copy (live-backend/src/features/pack-wallets.ts) and that one is what
   actually decides; this is what the page counts against while you pick. */
export const PACK_SHOWCASE_MAX_CARDS = 5;

/* How many cards a browser last saw on its own viewer's shelf.
 *
 * The shelf is read from the live backend after the page mounts, and until it
 * answers the row has two possible heights: a row of cards, or nothing at all
 * (an empty shelf deliberately draws no card-shaped holes). Reserving the
 * wrong one moves the whole wall underneath it, so the loading row goes on
 * what this browser saw the last time it looked, and a browser that has never
 * looked reserves nothing.
 *
 * A cookie rather than localStorage, which is what this was first: the frame
 * that needs the answer is the server-rendered one, a hydration earlier than
 * any script that could read localStorage back. The server renders the page
 * every browser is about to hydrate, so the hint has to travel with the
 * request.
 *
 * One viewer per cookie, not a map by id. Only your own shelf is ever drawn
 * this way, and a browser that has switched accounts should reserve nothing
 * rather than the shape of the account before it. */
export const PACK_SHOWCASE_SLOTS_COOKIE_NAME = "mania-hub-showcase-slots";

// A year: the hint is rewritten on every visit that reads a shelf, and a stale
// one costs a single row of movement once.
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function clampSlots(value: unknown): number {
  const cards = Math.floor(Number(value));
  if (!Number.isFinite(cards)) return 0;
  return Math.min(PACK_SHOWCASE_MAX_CARDS, Math.max(0, cards));
}

/* Parsed out of a raw `Cookie:` header (the server) or `document.cookie` (the
   browser), which are the same format. `<userId>.<cards>`, so a cookie left by
   another account reserves nothing rather than that account's row. */
export function parsePackShowcaseSlots(cookieHeader: string | null | undefined, userId: number): number {
  if (!cookieHeader || !Number.isInteger(userId) || userId <= 0) return 0;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${PACK_SHOWCASE_SLOTS_COOKIE_NAME}=(\\d+)\\.(\\d+)(?:;|$)`),
  );
  if (!match) return 0;
  return Number(match[1]) === userId ? clampSlots(match[2]) : 0;
}

export function readPackShowcaseSlotsClient(userId: number): number {
  if (typeof document === "undefined") return 0;
  return parsePackShowcaseSlots(document.cookie, userId);
}

export function writePackShowcaseSlotsClient(userId: number, cards: number): void {
  if (typeof document === "undefined" || !Number.isInteger(userId) || userId <= 0) return;
  const value = `${userId}.${clampSlots(cards)}`;
  document.cookie = `${PACK_SHOWCASE_SLOTS_COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
