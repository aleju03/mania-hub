/* IANA zone names, on both sides of the wire.
 *
 * A zone reaches the app from exactly one place - the browser, since nothing
 * server-side can know where a person is sitting - and ends up inside a
 * toLocaleDateString call. Intl throws a RangeError on a name it does not
 * recognise, so an unchecked string does not produce a wrong date, it produces
 * a failed render. Hence the validator, and hence the fallback. */

/** The zone the browser reports, or UTC if it will not say. resolvedOptions()
    is required to return an IANA name, but a locked-down runtime can hand back
    an empty string, which Intl does not accept as a zone. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/* Asking Intl whether it will take the name IS the allowlist: the tz database
   ships with the runtime, and a hand-written list of zones would be a second
   copy going stale every time a country changes its mind about DST.

   Returns null rather than throwing or defaulting, so a caller can tell "not
   told" from "told something useless" and leave a stored value alone. */
export function normalizeTimeZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  // Long enough for "America/Argentina/Buenos_Aires", short of anything that
  // is not a zone name.
  if (!value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
