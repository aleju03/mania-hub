// Server-only: drops specific URLs out of Cloudflare's edge cache.
//
// This exists because removal has to mean removal. A dynamic render is served
// with `max-age=300, stale-while-revalidate=86400`, which is right for an
// image that only changes when a player's data does - and wrong the moment a
// picture has to come down now. Without a purge, an edge that already holds a
// copy keeps handing it out for minutes after the origin has started refusing
// (a full day of it, once stale-while-revalidate is actually in effect), which
// is a poor answer to "take that down".
//
// Deliberately best-effort and silent about it: a purge that fails must not
// turn a block into an error, because the block itself already worked. The
// caller's action is authoritative; this only makes it visible sooner.

const PURGE_ENDPOINT = "https://api.cloudflare.com/client/v4/zones";

/* Cloudflare caps purge-by-URL at 30 per call on the non-enterprise plans.
   Twelve variants per player fits in one, but batching keeps that a fact about
   Cloudflare rather than an assumption about our layouts. */
const MAX_URLS_PER_CALL = 30;

const PURGE_TIMEOUT_MS = 8_000;

export interface CloudflarePurgeResult {
  /** False when the credentials are absent, which is the normal local case. */
  configured: boolean;
  purged: number;
  failed: number;
}

function credentials(): { token: string; zoneId: string } | null {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
  if (!token || !zoneId) return null;
  return { token, zoneId };
}

export function isCloudflarePurgeConfigured(): boolean {
  return credentials() !== null;
}

function chunk(urls: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += size) {
    batches.push(urls.slice(index, index + size));
  }
  return batches;
}

/** Purges exact URLs. Unconfigured is not an error - it is what running
    without Cloudflare in front looks like, and the caller carries on. */
export async function purgeCloudflareUrls(urls: string[]): Promise<CloudflarePurgeResult> {
  const unique = [...new Set(urls.filter((url) => /^https:\/\//i.test(url)))];
  if (unique.length === 0) return { configured: true, purged: 0, failed: 0 };

  const auth = credentials();
  if (!auth) return { configured: false, purged: 0, failed: unique.length };

  let purged = 0;
  let failed = 0;
  for (const batch of chunk(unique, MAX_URLS_PER_CALL)) {
    try {
      const response = await fetch(`${PURGE_ENDPOINT}/${auth.zoneId}/purge_cache`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ files: batch }),
        signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
      });
      if (response.ok) purged += batch.length;
      else failed += batch.length;
    } catch {
      failed += batch.length;
    }
  }
  return { configured: true, purged, failed };
}
