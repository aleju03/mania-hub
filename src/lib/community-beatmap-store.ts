import crypto from "node:crypto";

import { getPersistentCacheEntry, setPersistentCache } from "./api";

// When an uploaded replay's beatmap can't be downloaded from osu! (unsubmitted,
// deleted, or every mirror failed), the viewer asks whoever opened it to supply
// the .osu themselves. That copy used to live only in that one browser, so every
// other viewer got asked again. Stashing the verified .osu here, keyed by its MD5
// checksum, lets the first person who has the map cover everyone who opens the
// same replay afterwards.

// The map's .osu never changes for a given checksum, so keep it around for a long
// time; this is contributed content, not a fetch-cache we expect to churn.
const COMMUNITY_BEATMAP_CACHE_TTL = 365 * 24 * 60 * 60 * 1000;
// A single .osu difficulty is tiny (well under a MB); this is a sanity bound so a
// bad payload can't wedge a huge blob into the cache table.
const MAX_COMMUNITY_BEATMAP_BYTES = 8 * 1024 * 1024;

type CommunityBeatmapCacheValue = {
  content: string;
  storedAt: number;
};

function communityBeatmapCacheKey(checksum: string): string {
  return `community-beatmap:v1:${checksum}`;
}

// Same shape guard used elsewhere for fetched .osu files: it must look like a
// real beatmap, not an error page or an unrelated text file.
function isLikelyBeatmapFile(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("osu file format") && content.includes("[HitObjects]");
}

function md5Hex(content: string): string {
  return crypto.createHash("md5").update(content, "utf8").digest("hex");
}

/** Returns a community-supplied .osu whose MD5 matches `checksum`, or null. */
export async function getCommunityBeatmapFile(checksum: string): Promise<string | null> {
  const normalized = checksum.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;

  const cached = await getPersistentCacheEntry<CommunityBeatmapCacheValue>(communityBeatmapCacheKey(normalized));
  if (!cached.hit) return null;

  const content = cached.value?.content;
  // Re-verify the checksum on read so a corrupted or mis-keyed entry can't serve
  // the wrong chart into the replay viewer.
  if (!content || !isLikelyBeatmapFile(content) || md5Hex(content) !== normalized) return null;
  return content;
}

export type CommunityBeatmapSubmitResult =
  | { stored: true }
  | { stored: false; reason: "checksum-mismatch" | "invalid-file" | "too-large" };

/** Persists a user-supplied .osu after verifying it hashes to `checksum`. */
export async function putCommunityBeatmap(checksum: string, content: string): Promise<CommunityBeatmapSubmitResult> {
  const normalized = checksum.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return { stored: false, reason: "checksum-mismatch" };
  if (Buffer.byteLength(content, "utf8") > MAX_COMMUNITY_BEATMAP_BYTES) return { stored: false, reason: "too-large" };
  if (!isLikelyBeatmapFile(content)) return { stored: false, reason: "invalid-file" };
  if (md5Hex(content) !== normalized) return { stored: false, reason: "checksum-mismatch" };

  const value: CommunityBeatmapCacheValue = { content, storedAt: Date.now() };
  await setPersistentCache(communityBeatmapCacheKey(normalized), value, COMMUNITY_BEATMAP_CACHE_TTL);
  return { stored: true };
}
