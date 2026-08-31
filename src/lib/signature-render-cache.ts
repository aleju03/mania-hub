// Server-only: the finished bytes of a signature render, held in the process
// that served them.
//
// The cost ladder for a dynamic render is browser cache, edge cache, 304, R2
// read, satori. This sits between the edge and R2, and it exists because the
// two steps above it both have a floor: the edge only holds a copy for its TTL
// and there are many edges, so a URL that is being looked at steadily produces
// a slow trickle of origin requests, and each one pays a backend token resolve
// followed by an R2 GetObject before the first byte leaves the box. Neither of
// those can answer anything different from what the last one answered, for as
// long as the player's data has not moved.
//
// Deliberately NOT merged into the resolve memo in signature-resolve.ts. That
// one caches who a token belongs to; this caches a picture. They expire on
// different clocks and, more importantly, they are dropped by the same callers
// at the same moments, so keeping them apart costs one extra call at four sites
// and keeps each one honest about what it holds.
//
// The staleness this can introduce is bounded by TTL_MS and nothing else: a
// second frontend instance did not serve the mutation and cannot be told about
// it. That is why the TTL is 30 seconds rather than the several minutes the
// hit rate would prefer - a moderator blocking a picture should not have to
// wait out a cache they cannot see. Within one instance the invalidation below
// is exact.

import type { Buffer } from "node:buffer";

interface CachedRender {
  buffer: Buffer;
  etag: string;
  expiresAt: number;
}

const TTL_MS = 30_000;
/* Bounds are on bytes as well as entries because the two are only loosely
   related: a flat-background layout encodes to a couple of KB and a photo-
   backed one to twenty times that. */
const MAX_ENTRIES = 512;
const MAX_BYTES = 16 * 1024 * 1024;

const renders = new Map<string, CachedRender>();
let heldBytes = 0;

/** Token first, so invalidating one player is a prefix scan. */
export function signatureRenderKey(token: string, type: string, design: number): string {
  return `${token}:${type}:${design}`;
}

function drop(key: string): void {
  const entry = renders.get(key);
  if (!entry) return;
  heldBytes -= entry.buffer.length;
  renders.delete(key);
}

/** Evicts expired entries first, then the oldest inserted, until both bounds
    hold. Map iteration is insertion order, and every entry gets the same TTL,
    so oldest-inserted is also nearest-expiry. */
function trim(now: number): void {
  for (const [key, entry] of renders) {
    if (entry.expiresAt <= now) drop(key);
  }
  for (const key of renders.keys()) {
    if (renders.size <= MAX_ENTRIES && heldBytes <= MAX_BYTES) break;
    drop(key);
  }
}

export function readSignatureRender(key: string): CachedRender | null {
  const entry = renders.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    drop(key);
    return null;
  }
  return entry;
}

export function storeSignatureRender(key: string, buffer: Buffer, etag: string): void {
  if (buffer.length === 0 || buffer.length > MAX_BYTES) return;
  const now = Date.now();
  drop(key);
  renders.set(key, { buffer, etag, expiresAt: now + TTL_MS });
  heldBytes += buffer.length;
  trim(now);
}

/** Every layout belonging to one token. Used where a player's own write moved
    their data: publishing types, saving a style, reporting a time zone. */
export function forgetSignatureRenders(token: string): void {
  if (!token) return;
  const prefix = `${token}:`;
  for (const key of [...renders.keys()]) {
    if (key.startsWith(prefix)) drop(key);
  }
}

/* The revokes - disable, rotate, block - do not always have the old token to
   name, and a revoked signature that keeps answering for another half minute is
   exactly the case this must not produce. The map is small and these are rare,
   so they take all of it. */
export function clearSignatureRenderCache(): void {
  renders.clear();
  heldBytes = 0;
}

/** Test seam. */
export function signatureRenderCacheStats(): { entries: number; bytes: number } {
  return { entries: renders.size, bytes: heldBytes };
}
