import crypto from "node:crypto";

import {
  type CommunityBeatmapAssetKind,
  getCommunityBeatmapObject,
  headCommunityBeatmapAsset,
  putCommunityBeatmapAsset,
  putCommunityBeatmapObject,
} from "./r2-cache";

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

// ── Audio and background ──
// The .osu alone plays silently over a blank stage. When the contributor
// dropped a whole .osz, the song and the background it names travel with it,
// keyed by the same checksum, so the map behaves like a submitted one for
// everyone who opens the replay later.

export const MAX_COMMUNITY_AUDIO_BYTES = 48 * 1024 * 1024;
export const MAX_COMMUNITY_BACKGROUND_BYTES = 16 * 1024 * 1024;

export type CommunityBeatmapAssets = Record<CommunityBeatmapAssetKind, boolean>;

export type CommunityBeatmapAssetSubmitResult =
  | { stored: true }
  | { stored: false; reason: "no-beatmap" | "filename-mismatch" | "invalid-file" | "too-large" | "already-stored" };

function normalizeChecksum(checksum: string): string | null {
  const normalized = checksum.trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null;
}

export function parseBeatmapAudioFilename(content: string): string | null {
  const match = content.match(/^AudioFilename\s*:\s*(.+)$/im);
  const value = match?.[1]?.trim().replace(/\\/g, "/");
  return value || null;
}

export function parseBeatmapBackgroundFilename(content: string): string | null {
  const match = content.match(/^0\s*,\s*0\s*,\s*"(.+?)"/m);
  const value = match?.[1]?.trim().replace(/\\/g, "/");
  return value || null;
}

function baseName(filename: string): string {
  return filename.replace(/\\/g, "/").split("/").pop()?.trim().toLowerCase() ?? "";
}

// The MIME comes from the bytes, never from the client's declared type or the
// filename: this is user-supplied content that gets served back to browsers.
export function sniffCommunityAssetMimeType(kind: CommunityBeatmapAssetKind, bytes: Uint8Array): string | null {
  const startsWith = (offset: number, ascii: string) => {
    if (bytes.length < offset + ascii.length) return false;
    for (let i = 0; i < ascii.length; i += 1) {
      if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
    }
    return true;
  };
  if (kind === "audio") {
    if (startsWith(0, "ID3")) return "audio/mpeg";
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
    if (startsWith(0, "OggS")) return "audio/ogg";
    if (startsWith(0, "RIFF") && startsWith(8, "WAVE")) return "audio/wav";
    if (startsWith(0, "fLaC")) return "audio/flac";
    if (startsWith(4, "ftyp")) return "audio/mp4";
    return null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && startsWith(1, "PNG")) return "image/png";
  if (startsWith(0, "RIFF") && startsWith(8, "WEBP")) return "image/webp";
  if (startsWith(0, "GIF8")) return "image/gif";
  return null;
}

/** Which of the map's assets have been contributed. */
export async function getCommunityBeatmapAssets(checksum: string): Promise<CommunityBeatmapAssets> {
  const normalized = normalizeChecksum(checksum);
  if (!normalized) return { audio: false, background: false };
  const [audio, background] = await Promise.all([
    headCommunityBeatmapAsset(normalized, "audio"),
    headCommunityBeatmapAsset(normalized, "background"),
  ]);
  return { audio: audio !== null, background: background !== null };
}

/**
 * Persists one asset for a map whose .osu is already in the store. The file
 * has to be the one the chart names (by basename, since .osz entries may sit
 * in folders) and has to look like the kind it claims to be.
 */
export async function putCommunityBeatmapAssetFile(params: {
  checksum: string;
  kind: CommunityBeatmapAssetKind;
  filename: string;
  buffer: Buffer;
}): Promise<CommunityBeatmapAssetSubmitResult> {
  const normalized = normalizeChecksum(params.checksum);
  if (!normalized) return { stored: false, reason: "no-beatmap" };
  const cap = params.kind === "audio" ? MAX_COMMUNITY_AUDIO_BYTES : MAX_COMMUNITY_BACKGROUND_BYTES;
  if (params.buffer.length === 0 || params.buffer.length > cap) return { stored: false, reason: "too-large" };

  const content = await getCommunityBeatmapFile(normalized);
  if (!content) return { stored: false, reason: "no-beatmap" };
  const expected = params.kind === "audio" ? parseBeatmapAudioFilename(content) : parseBeatmapBackgroundFilename(content);
  if (!expected || baseName(expected) !== baseName(params.filename)) return { stored: false, reason: "filename-mismatch" };

  const mimeType = sniffCommunityAssetMimeType(params.kind, params.buffer);
  if (!mimeType) return { stored: false, reason: "invalid-file" };

  const written = await putCommunityBeatmapAsset(normalized, params.kind, mimeType, params.buffer, baseName(expected));
  return written ? { stored: true } : { stored: false, reason: "already-stored" };
}
