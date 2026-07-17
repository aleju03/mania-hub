import crypto from "node:crypto";

import { getCommunityBeatmapObject, putCommunityBeatmapObject } from "./r2-cache";

// When an uploaded replay's beatmap can't be downloaded from osu! (unsubmitted,
// deleted, or every mirror failed), the viewer asks whoever opened it to supply
// the .osu themselves. That copy used to live only in that one browser, so every
// other viewer got asked again. Stashing the verified .osu in R2, keyed by its
// MD5 checksum, lets the first person who has the map cover everyone who opens
// the same replay afterwards.
//
// R2 (not the live backend) on purpose: this is durable contributed content, not
// a fetch-cache, and it must survive independently of the VPS. Objects are
// content-addressed and immutable; nothing evicts the community-beatmaps/ prefix.

// A single .osu difficulty is tiny (well under a MB); this is a sanity bound so a
// bad payload can't wedge a huge blob into the store.
const MAX_COMMUNITY_BEATMAP_BYTES = 8 * 1024 * 1024;

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

  const content = await getCommunityBeatmapObject(normalized);
  // Re-verify the checksum on read so a corrupted or mis-keyed object can't
  // serve the wrong chart into the replay viewer.
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

  // When R2 isn't configured (local dev without creds) the put is a silent no-op,
  // matching the old persistent-cache behavior: the uploader still gets to watch
  // their replay this session; the copy just isn't shared.
  await putCommunityBeatmapObject(normalized, content);
  return { stored: true };
}
