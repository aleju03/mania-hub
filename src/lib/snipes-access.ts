/* Snipes outside the osu!-seeded countries (every other live country, and
   Global) are admin-only while they're checked on prod. Flip this to open them
   to everyone, together with TRACKED_SNIPES_PUBLIC in the live backend. */
export const TRACKED_SNIPES_PUBLIC = false;

export function canSeeTrackedSnipes(isAdmin: boolean): boolean {
  return TRACKED_SNIPES_PUBLIC || isAdmin;
}
