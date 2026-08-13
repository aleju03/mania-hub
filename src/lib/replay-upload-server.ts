// Server handlers for /api/replay-upload, kept out of the route file so they
// can be tested with plain Request objects (no TanStack server context).
//
// Policy (findings/README.md Phase 9): uploading a .osr requires a signed-in
// user; the generated share links stay publicly readable. Uploads are
// validated as real osu!mania replays before storage — a structural .osr
// header check first (game mode, bounded strings, and the LZMA blob's declared
// decompressed size, which also fixes the frame budget so a crafted replay
// cannot expand without limit), then a full decode through the same parser the
// viewer uses.

import { isLocalDevAccessGranted } from "./auth-local-dev";
import { readViewerFromRequest } from "./auth-server";
import { parseUploadedReplayBuffer, type UploadedReplayParseResult } from "./replay-upload";
import { persistUploadedReplayDescription } from "./uploaded-replay-describe";
import { recordUploadedReplayOwner } from "./uploaded-replay-index";
import {
  normalizeUploadedReplayId,
  readUploadedReplay,
  ReplayStorageUnavailableError,
  saveUploadedReplay,
} from "./uploaded-replay-store";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";

export const MAX_UPLOAD_REPLAY_BYTES = 25 * 1024 * 1024;

// Per-user fixed window; the multi-instance total is bounded by the edge/WAF
// rule tracked in the Phase 9 checklist (same setup as /api/catbox-upload).
const RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_LIMIT_PER_WINDOW = 6;
const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

// .osr structural bounds. Strings in a replay header are metadata (hashes,
// player name, life bar graph); nothing legitimate approaches these caps.
const MAX_OSR_STRING_BYTES = 4 * 1024 * 1024;
// Shortest frame the replay CSV can encode is "0|0|0|0," — 8 bytes — so the
// LZMA blob's declared decompressed size is a hard upper bound on how many
// frames a decode will materialise.
export const MIN_FRAME_CSV_BYTES = 8;
// osu! stable records a mania frame on every key change plus a ~60 Hz
// keep-alive, so an hour of play is roughly 216k frames and a dense chart adds
// two more per note; ranked marathons top out nearer 25 minutes. 400k covers
// all of that with room to spare, and caps the frame objects a single decode
// can allocate at a size the request can actually afford.
export const MAX_REPLAY_FRAMES = 400_000;
// Derived from the frame cap rather than chosen alongside it: repeated minimal
// entries compress to almost nothing, so a few KB of upload can declare a huge
// payload, and every declared byte turns into frame objects during the decode —
// long before any post-decode count can run. A genuine mania frame is ~11 bytes
// ("16|65|10|0,": delta, column bitfield, scroll-speed scale, unused key field),
// so this still admits ~290k real frames. An "unknown size" marker (all 0xff) is
// rejected outright — every real encoder (osu! stable, osu-parsers, lzma
// tooling) writes the explicit size.
export const MAX_DECOMPRESSED_REPLAY_BYTES = MAX_REPLAY_FRAMES * MIN_FRAME_CSV_BYTES;

const MANIA_RULESET_ID = 3;

export class ReplayValidationError extends Error {
  constructor(message: string, readonly status: number = 422) {
    super(message);
  }
}

class OsrReader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  byte(): number {
    if (this.offset + 1 > this.buffer.length) throw new ReplayValidationError("This is not a valid .osr replay file.");
    return this.buffer[this.offset++];
  }

  int32(): number {
    if (this.offset + 4 > this.buffer.length) throw new ReplayValidationError("This is not a valid .osr replay file.");
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  uint16(): number {
    if (this.offset + 2 > this.buffer.length) throw new ReplayValidationError("This is not a valid .osr replay file.");
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  uint64(): bigint {
    if (this.offset + 8 > this.buffer.length) throw new ReplayValidationError("This is not a valid .osr replay file.");
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  /** osu! string: 0x00 (absent) or 0x0b + ULEB128 length + utf8 bytes. */
  string(): string {
    const marker = this.byte();
    if (marker === 0x00) return "";
    if (marker !== 0x0b) throw new ReplayValidationError("This is not a valid .osr replay file.");
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28 || length > MAX_OSR_STRING_BYTES) {
        throw new ReplayValidationError("This is not a valid .osr replay file.");
      }
    }
    if (length > MAX_OSR_STRING_BYTES || this.offset + length > this.buffer.length) {
      throw new ReplayValidationError("This is not a valid .osr replay file.");
    }
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  slice(length: number): Buffer {
    if (length < 0 || this.offset + length > this.buffer.length) {
      throw new ReplayValidationError("This is not a valid .osr replay file.");
    }
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

export interface OsrStructure {
  gameMode: number;
  gameVersion: number;
  beatmapHash: string;
  playerName: string;
  declaredDecompressedBytes: bigint | null;
}

// Walks the fixed .osr layout up to the LZMA blob without decompressing
// anything, so the cheap rejections (wrong ruleset, absurd declared sizes)
// happen before the expensive decode.
export function readOsrStructure(buffer: Buffer): OsrStructure {
  const reader = new OsrReader(buffer);
  const gameMode = reader.byte();
  const gameVersion = reader.int32();
  const beatmapHash = reader.string();
  const playerName = reader.string();
  reader.string(); // replay hash
  for (let i = 0; i < 6; i++) reader.uint16(); // 300/100/50/geki/katu/miss
  reader.int32(); // total score
  reader.uint16(); // max combo
  reader.byte(); // perfect
  reader.int32(); // mods
  reader.string(); // life bar graph
  reader.uint64(); // timestamp
  const replayLength = reader.int32();
  const lzma = reader.slice(replayLength);
  // LZMA header: 5 properties bytes + uint64 declared decompressed size.
  let declaredDecompressedBytes: bigint | null = null;
  if (lzma.length >= 13) {
    const declared = lzma.readBigUInt64LE(5);
    declaredDecompressedBytes = declared === 0xffffffffffffffffn ? null : declared;
  } else if (replayLength > 0) {
    throw new ReplayValidationError("This is not a valid .osr replay file.");
  }
  return { gameMode, gameVersion, beatmapHash, playerName, declaredDecompressedBytes };
}

export interface ValidatedReplayUpload {
  beatmapHash: string;
  playerName: string;
  frameCount: number;
  // The full decode the validation already paid for, so callers can derive
  // data from the replay (upload-time description) without a second parse.
  parsed: UploadedReplayParseResult;
}

export async function validateUploadedReplayOsr(
  buffer: Buffer,
  limits: { maxDecompressedBytes?: number; maxFrames?: number } = {},
): Promise<ValidatedReplayUpload> {
  const maxDecompressedBytes = limits.maxDecompressedBytes ?? MAX_DECOMPRESSED_REPLAY_BYTES;
  const maxFrames = limits.maxFrames ?? MAX_REPLAY_FRAMES;

  const structure = readOsrStructure(buffer);
  if (structure.gameMode !== MANIA_RULESET_ID) {
    throw new ReplayValidationError("This is not an osu!mania replay.");
  }
  if (structure.declaredDecompressedBytes == null) {
    throw new ReplayValidationError("This replay does not declare its decompressed size.");
  }
  if (structure.declaredDecompressedBytes > BigInt(maxDecompressedBytes)) {
    throw new ReplayValidationError("This replay's input data is too large.", 413);
  }
  // Frame budget has to be spent here, not after the decode: the parser
  // materialises two objects per frame, so a declared size that implies more
  // frames than we allow would exhaust the heap before the count below runs.
  if (structure.declaredDecompressedBytes / BigInt(MIN_FRAME_CSV_BYTES) > BigInt(maxFrames)) {
    throw new ReplayValidationError("This replay has too many input frames.", 413);
  }

  // Full decode through the same parser the viewer uses, so anything accepted
  // here is something the viewer can actually open (and vice versa).
  let parsed: Awaited<ReturnType<typeof parseUploadedReplayBuffer>>;
  try {
    parsed = await parseUploadedReplayBuffer(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
  } catch (error) {
    throw new ReplayValidationError(
      error instanceof Error && error.message ? error.message : "This is not a valid .osr replay file.",
    );
  }
  // Belt-and-braces: the pre-decode budget rounds down (the final CSV entry
  // carries no trailing comma), so confirm against the real count as well.
  if (parsed.replay.frames.length > maxFrames) {
    throw new ReplayValidationError("This replay has too many input frames.", 413);
  }
  return {
    beatmapHash: parsed.replay.header.beatmapHash ?? "",
    playerName: parsed.replay.header.playerName,
    frameCount: parsed.replay.frames.length,
    parsed,
  };
}

interface AuthorizedUploader {
  /** Rate-limit key for this request. */
  rateKey: string;
  /** The signed-in uploader, or null on the local-dev pass. */
  viewer: { id: number; username: string } | null;
}

/** The authorized uploader, or null when unauthenticated. */
async function authorizeUploader(request: Request): Promise<AuthorizedUploader | null> {
  const viewer = await readViewerFromRequest(request);
  if (viewer) return { rateKey: `user:${viewer.id}`, viewer: { id: viewer.id, username: viewer.username } };
  let hostname = "";
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const localDev = isLocalDevAccessGranted({
    nodeEnv: process.env.NODE_ENV,
    localDevSwitch: process.env.ENABLE_LOCAL_DEV_ADMIN,
    hostname,
  });
  return localDev ? { rateKey: "local-dev", viewer: null } : null;
}

// The header is client-supplied and URI-encoded; malformed encoding is
// treated as "no filename", never as a request failure.
function readUploadFilename(request: Request): string | undefined {
  const raw = request.headers.get("x-replay-filename");
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw).trim() || undefined;
  } catch {
    return undefined;
  }
}

function getShareUrl(request: Request, id: string): string {
  const url = new URL(request.url);
  url.pathname = "/replay";
  url.search = "";
  url.searchParams.set("uploadId", id);
  return url.toString();
}

export async function handleReplayUploadPost(request: Request): Promise<Response> {
  const uploader = await authorizeUploader(request);
  if (!uploader) {
    return Response.json({ error: "Sign in to upload replays." }, { status: 401 });
  }
  const { rateKey } = uploader;
  if (rateLimiter.isRateLimited(`post:${rateKey}`, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads; try again in a minute." }, { status: 429 });
  }

  const buffer = await readCappedBody(request, MAX_UPLOAD_REPLAY_BYTES);
  if (!buffer) {
    return Response.json({ error: "Replay file is too large." }, { status: 413 });
  }
  if (buffer.length === 0) {
    return Response.json({ error: "Replay file is empty." }, { status: 400 });
  }

  let validated: ValidatedReplayUpload;
  try {
    validated = await validateUploadedReplayOsr(buffer);
  } catch (error) {
    if (error instanceof ReplayValidationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "This is not a valid .osr replay file." }, { status: 422 });
  }

  const originalFilename = readUploadFilename(request);
  const uploaderId = uploader.viewer?.id ?? null;
  const uploadedAt = new Date().toISOString();
  try {
    const saved = await saveUploadedReplay(buffer, {
      originalFilename,
      uploaderId,
      uploadedAt,
    });
    // Index the uploader so the file turns up on their own "your uploads"
    // shelf and they can delete it later. Awaited, not fired off: the viewer
    // asks whether it may delete this upload as soon as the response lands, and
    // that answer comes from this row. Never fatal - the object carries the
    // same uploader id in its metadata, so a missed row is recoverable by the
    // admin backfill and costs the upload itself nothing.
    if (uploader.viewer) {
      await recordUploadedReplayOwner({
        id: saved.id,
        userId: uploader.viewer.id,
        username: uploader.viewer.username,
        originalFilename,
        uploadedAt,
      });
    }
    // Store the derived description while the parse is in hand, so the
    // community list reads it back instead of re-downloading and re-parsing
    // the .osr. Best-effort: the upload already succeeded, and a miss just
    // means the first list rebuild derives it the slow way.
    if (saved.storage === "r2") {
      try {
        await persistUploadedReplayDescription(saved.id, validated.parsed, originalFilename);
      } catch {
        // Descriptions are derived data; never fail the upload over one.
      }
    }
    return Response.json({
      id: saved.id,
      url: getShareUrl(request, saved.id),
      storage: saved.storage,
    });
  } catch (error) {
    if (error instanceof ReplayStorageUnavailableError) {
      return Response.json({ error: "Replay storage is temporarily unavailable." }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Failed to save replay upload.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function handleReplayUploadGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = normalizeUploadedReplayId(url.searchParams.get("id"));
  if (!id) {
    return new Response("Invalid upload id", { status: 400 });
  }

  const stored = await readUploadedReplay(id);
  if (!stored) {
    return new Response("Replay upload not found", { status: 404 });
  }

  return new Response(stored.buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stored.buffer.length),
      // Direct navigation downloads the file; the viewer's fetch() path reads
      // the body and never sees the disposition.
      "Content-Disposition": `attachment; filename="${stored.originalFilename || `${id}.osr`}"`,
      "X-Content-Type-Options": "nosniff",
      ...(stored.originalFilename ? { "X-Replay-Filename": encodeURIComponent(stored.originalFilename) } : {}),
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
}
