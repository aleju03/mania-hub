// Server-only: turns a signature token from an image URL into the player it
// addresses, plus the per-type data versions that decide whether a stored
// render is still current.
//
// This sits on the hot path of every embed that missed the CDN, so it is
// memoized. The memo TTL is the only clock in the dynamic-render design, and
// it exists to bound backend reads - not to drive re-renders, which are driven
// entirely by the versions below changing.

import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import type { SignatureType } from "./signature-shared";
import type { OsuScore } from "./types";

export interface SignatureProfileSnapshot {
  user?: {
    id?: number;
    username?: string;
    avatar_url?: string;
    cover_url?: string | null;
    statistics?: { pp?: number | null } | null;
  };
  bestScores?: OsuScore[];
}

export interface ResolvedSignature {
  userId: number;
  username: string;
  enabledTypes: SignatureType[];
  skillsKeyCount: number | null;
  /** Raw per-type style map as stored. Normalize before drawing from it. */
  styles: Record<string, unknown> | null;
  /* The OWNER's IANA zone, not the viewer's - a render has no viewer. It is
     stored once per version and served to everyone, so the only day it can
     honestly print is the day the player themselves lived. Null means their
     browser has never told us, and falls back to UTC. */
  timeZone: string | null;
  versions: Record<SignatureType, string>;
  /** The exact projected inputs hashed by the backend, avoiding a second read. */
  profile?: SignatureProfileSnapshot | null;
}

/* base64url, as minted by the backend. Checked before any network call so a
   junk path costs nothing. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function isSignatureTokenShape(token: string): boolean {
  return TOKEN_RE.test(token);
}

/* Kept short on purpose. This memo is not what makes signatures cheap - the
   edge TTL and the R2 objects are - it only stops a burst of simultaneous
   origin misses from becoming a burst of backend reads. Its cost is that a
   player who just changed their style keeps seeing the old picture until it
   expires, which is the entire feel of the customization page, so it buys far
   less than it charges at 30s. */
const RESOLVE_MEMO_MS = 10_000;
/* If the backend is unreachable, keep serving the last good resolve for a
   while. A backend blip should not turn every osu! profile carrying a
   signature into a broken image. */
const RESOLVE_STALE_MS = 15 * 60_000;

interface MemoEntry {
  value: ResolvedSignature | null;
  freshUntil: number;
  staleUntil: number;
}

const resolveMemo = new Map<string, MemoEntry>();
const inFlightResolves = new Map<string, Promise<ResolvedSignature | null>>();
let memoRevision = 0;

function pruneMemo(now: number): void {
  for (const [key, entry] of resolveMemo) {
    if (entry.staleUntil <= now) resolveMemo.delete(key);
  }
  for (const key of resolveMemo.keys()) {
    if (resolveMemo.size <= 128) break;
    resolveMemo.delete(key);
  }
}

function remember(token: string, entry: MemoEntry): void {
  resolveMemo.delete(token);
  resolveMemo.set(token, entry);
  // Also bound concurrent cold responses, which all started before insertion.
  pruneMemo(Date.now());
}

export async function resolveSignatureToken(token: string): Promise<ResolvedSignature | null> {
  if (!isSignatureTokenShape(token)) return null;

  const now = Date.now();
  pruneMemo(now);
  const cached = resolveMemo.get(token);
  if (cached && cached.freshUntil > now) return cached.value;

  const pending = inFlightResolves.get(token);
  if (pending) return pending;
  const attempt = fetchResolvedSignature(token, now, cached, memoRevision);
  inFlightResolves.set(token, attempt);
  try {
    return await attempt;
  } finally {
    if (inFlightResolves.get(token) === attempt) inFlightResolves.delete(token);
  }
}

async function fetchResolvedSignature(token: string, now: number, cached: MemoEntry | undefined, revision: number): Promise<ResolvedSignature | null> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("signature backend unavailable");

  try {
    const response = await fetch(
      `${base}/api/signature/resolve?token=${encodeURIComponent(token)}`,
      { headers: bridgeAuthHeaders(), signal: AbortSignal.timeout(5_000) },
    );
    // A 404 is a real answer (unknown or disabled token), so it is memoized
    // like any other - otherwise a scraper hammering dead tokens would reach
    // the backend on every single request.
    if (response.status === 404) {
      if (revision === memoRevision) remember(token, { value: null, freshUntil: now + RESOLVE_MEMO_MS, staleUntil: now + RESOLVE_STALE_MS });
      return null;
    }
    if (!response.ok) throw new Error(`signature resolve ${response.status}`);
    const value = (await response.json()) as ResolvedSignature;
    if (revision === memoRevision) remember(token, { value, freshUntil: now + RESOLVE_MEMO_MS, staleUntil: now + RESOLVE_STALE_MS });
    return value;
  } catch (error) {
    if (revision === memoRevision && cached && cached.staleUntil > Date.now()) return cached.value;
    throw error;
  }
}

/** Drops one token's memo entry. Called right after a player edits their own
    signature, so their next preview resolves the version they just wrote
    instead of the one cached moments earlier.

    This only clears the instance that served the write. With several frontend
    instances behind the proxy, a preview landing on a different one still
    waits out RESOLVE_MEMO_MS, which is why that value has to stay small rather
    than this being the whole fix. */
export function forgetSignatureToken(token: string): void {
  memoRevision += 1;
  resolveMemo.delete(token);
  inFlightResolves.delete(token);
}

/** Test seam: the memo is process-wide and would otherwise leak across cases. */
export function clearSignatureResolveMemo(): void {
  memoRevision += 1;
  resolveMemo.clear();
  inFlightResolves.clear();
}
