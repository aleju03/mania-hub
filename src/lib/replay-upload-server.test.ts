import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import lzma from "lzma-purejs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthCookieHeader } from "./auth-server";
import {
  handleReplayUploadGet,
  handleReplayUploadPost,
  MAX_UPLOAD_REPLAY_BYTES,
  readOsrStructure,
  ReplayValidationError,
  validateUploadedReplayOsr,
} from "./replay-upload-server";

const ORIGIN = "https://mania-tracker.com";

// Rate-limit windows are module state keyed by viewer id, so every test uses
// its own viewer to stay independent.
let nextViewerId = 7000;

async function authCookie(id: number): Promise<string> {
  const header = await createAuthCookieHeader(
    { id, username: `tester${id}`, avatarUrl: "", countryCode: "CR" },
    new Request(`${ORIGIN}/`),
  );
  return header.split(";")[0];
}

// --- synthetic .osr builder (stable osu!mania layout) ---

function osuString(value: string): Buffer {
  if (!value) return Buffer.from([0x00]);
  const utf8 = Buffer.from(value, "utf8");
  const parts: number[] = [0x0b];
  let length = utf8.length;
  do {
    let byte = length & 0x7f;
    length >>= 7;
    if (length > 0) byte |= 0x80;
    parts.push(byte);
  } while (length > 0);
  return Buffer.concat([Buffer.from(parts), utf8]);
}

const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };

function compressFrames(frames: string): Buffer {
  return Buffer.from(lzma.compressFile(Buffer.from(frames, "utf8")) as Uint8Array);
}

interface OsrOptions {
  gameMode?: number;
  frames?: string;
  lzmaBlob?: Buffer;
}

function buildOsr(options: OsrOptions = {}): Buffer {
  const frames = options.frames ?? [
    "0|256|-500|0",
    "-1|256|-500|0",
    "1000|1|0|0",
    "50|0|0|0",
    "2000|2|0|0",
    "50|0|0|0",
    "-12345|0|0|10186156",
  ].join(",");
  const lzmaBlob = options.lzmaBlob ?? compressFrames(frames);
  return Buffer.concat([
    Buffer.from([options.gameMode ?? 3]),
    i32(20240101),
    osuString("a".repeat(32)),
    osuString("TestPlayer"),
    osuString("b".repeat(32)),
    u16(2), u16(0), u16(0), u16(0), u16(0), u16(0),
    i32(600030),
    u16(2),
    Buffer.from([1]),
    i32(0),
    osuString(""),
    i64(637134317285583740n),
    i32(lzmaBlob.length),
    lzmaBlob,
    i64(0n),
  ]);
}

interface PostOptions {
  cookie?: string;
  filenameHeader?: string;
  contentLength?: string;
}

function postRequest(body: Buffer, { cookie, filenameHeader, contentLength }: PostOptions = {}): Request {
  return new Request(`${ORIGIN}/api/replay-upload`, {
    method: "POST",
    body: body as unknown as BodyInit,
    headers: {
      "content-type": "application/octet-stream",
      ...(contentLength ? { "content-length": contentLength } : {}),
      ...(filenameHeader ? { "x-replay-filename": filenameHeader } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
}

let uploadDir = "";

beforeAll(() => {
  process.env.AUTH_SESSION_SECRET = "vitest-replay-secret-vitest-replay-secret";
  delete process.env.ENABLE_LOCAL_DEV_ADMIN;
});

beforeEach(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "replay-uploads-"));
  process.env.REPLAY_UPLOAD_DIR = uploadDir;
});

afterEach(async () => {
  delete process.env.REPLAY_UPLOAD_DIR;
  delete process.env.ENABLE_LOCAL_DEV_ADMIN;
  await rm(uploadDir, { recursive: true, force: true });
});

describe("replay upload validation", () => {
  it("accepts a valid stable mania replay", async () => {
    const result = await validateUploadedReplayOsr(buildOsr());
    expect(result.beatmapHash).toBe("a".repeat(32));
    expect(result.playerName).toBe("TestPlayer");
    expect(result.frameCount).toBeGreaterThan(0);
  });

  it("rejects non-mania replays", async () => {
    await expect(validateUploadedReplayOsr(buildOsr({ gameMode: 0 })))
      .rejects.toThrowError("This is not an osu!mania replay.");
  });

  it("rejects random bytes", async () => {
    await expect(validateUploadedReplayOsr(Buffer.from("not a replay at all, just some text padding".repeat(4))))
      .rejects.toThrowError(ReplayValidationError);
  });

  it("rejects a replay whose LZMA blob declares an oversized decompressed payload", async () => {
    // Real compressed frames, but the declared decompressed size claims 10 GiB.
    const lzmaBlob = compressFrames("0|256|-500|0,1000|1|0|0");
    lzmaBlob.writeBigUInt64LE(10n * 1024n * 1024n * 1024n, 5);
    const error = await validateUploadedReplayOsr(buildOsr({ lzmaBlob })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReplayValidationError);
    expect((error as ReplayValidationError).status).toBe(413);
    expect((error as Error).message).toContain("too large");
  });

  it("rejects a replay that hides its decompressed size", async () => {
    const lzmaBlob = compressFrames("0|256|-500|0,1000|1|0|0");
    lzmaBlob.writeBigUInt64LE(0xffffffffffffffffn, 5);
    await expect(validateUploadedReplayOsr(buildOsr({ lzmaBlob })))
      .rejects.toThrowError("does not declare its decompressed size");
  });

  it("caps the decoded frame count", async () => {
    const error = await validateUploadedReplayOsr(buildOsr(), { maxFrames: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReplayValidationError);
    expect((error as ReplayValidationError).status).toBe(413);
    expect((error as Error).message).toContain("too many input frames");
  });

  it("reads the osr structure without decompressing", () => {
    const structure = readOsrStructure(buildOsr());
    expect(structure.gameMode).toBe(3);
    expect(structure.playerName).toBe("TestPlayer");
    expect(structure.declaredDecompressedBytes).toBeGreaterThan(0n);
  });
});

describe("replay upload POST", () => {
  it("rejects anonymous uploads", async () => {
    const response = await handleReplayUploadPost(postRequest(buildOsr()));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "Sign in to upload replays." });
  });

  it("saves a valid replay for a signed-in user with uploader metadata", async () => {
    const viewerId = nextViewerId++;
    const response = await handleReplayUploadPost(postRequest(buildOsr(), {
      cookie: await authCookie(viewerId),
      filenameHeader: encodeURIComponent("my replay.osr"),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; url: string; storage: string };
    expect(body.storage).toBe("local");
    expect(body.url).toContain(`uploadId=${body.id}`);

    const files = await readdir(uploadDir);
    expect(files).toContain(`${body.id}.osr`);
    expect(files).toContain(`${body.id}.json`);
    const { readFile } = await import("node:fs/promises");
    const meta = JSON.parse(await readFile(path.join(uploadDir, `${body.id}.json`), "utf8")) as Record<string, unknown>;
    expect(meta.uploaderId).toBe(viewerId);
    expect(meta.originalFilename).toBe("my replay.osr");
    expect(typeof meta.uploadedAt).toBe("string");
  });

  it("keeps share links publicly readable with download-safe headers", async () => {
    const response = await handleReplayUploadPost(postRequest(buildOsr(), {
      cookie: await authCookie(nextViewerId++),
      filenameHeader: encodeURIComponent("shared.osr"),
    }));
    const { id } = await response.json() as { id: string };

    // No cookie: the GET side stays public by policy.
    const read = await handleReplayUploadGet(new Request(`${ORIGIN}/api/replay-upload?id=${id}`));
    expect(read.status).toBe(200);
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect(read.headers.get("content-disposition")).toContain("attachment;");
    expect(read.headers.get("content-disposition")).toContain("shared.osr");
    expect(Buffer.from(await read.arrayBuffer()).equals(buildOsr())).toBe(true);
  });

  it("rejects empty and oversized uploads", async () => {
    const cookie = await authCookie(nextViewerId++);
    const empty = await handleReplayUploadPost(postRequest(Buffer.alloc(0), { cookie }));
    expect(empty.status).toBe(400);

    // Oversized declared Content-Length is rejected before reading the body.
    const declared = await handleReplayUploadPost(postRequest(buildOsr(), {
      cookie,
      contentLength: String(MAX_UPLOAD_REPLAY_BYTES + 1),
    }));
    expect(declared.status).toBe(413);

    // A dishonest/missing header still hits the streaming cap.
    const oversized = await handleReplayUploadPost(postRequest(Buffer.alloc(MAX_UPLOAD_REPLAY_BYTES + 1), { cookie }));
    expect(oversized.status).toBe(413);
  });

  it("rejects invalid replays with a clear reason", async () => {
    const cookie = await authCookie(nextViewerId++);
    const nonMania = await handleReplayUploadPost(postRequest(buildOsr({ gameMode: 1 }), { cookie }));
    expect(nonMania.status).toBe(422);
    expect(await nonMania.json()).toMatchObject({ error: "This is not an osu!mania replay." });

    const garbage = await handleReplayUploadPost(postRequest(Buffer.from("garbage".repeat(64)), { cookie }));
    expect(garbage.status).toBe(422);
  });

  it("treats malformed filename encoding as no filename", async () => {
    const response = await handleReplayUploadPost(postRequest(buildOsr(), {
      cookie: await authCookie(nextViewerId++),
      filenameHeader: "%zz-broken",
    }));
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: string };
    const read = await handleReplayUploadGet(new Request(`${ORIGIN}/api/replay-upload?id=${id}`));
    expect(read.headers.get("x-replay-filename")).toBeNull();
    expect(read.headers.get("content-disposition")).toContain(`${id}.osr`);
  });

  it("rate limits repeated uploads per user", async () => {
    const cookie = await authCookie(nextViewerId++);
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const response = await handleReplayUploadPost(postRequest(buildOsr(), { cookie }));
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("fails closed in production when R2 storage is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const response = await handleReplayUploadPost(postRequest(buildOsr(), {
        cookie: await authCookie(nextViewerId++),
      }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "Replay storage is temporarily unavailable." });
      // Nothing silently fell back to local disk.
      expect(await readdir(uploadDir)).toEqual([]);
    } finally {
      vi.stubEnv("NODE_ENV", "test");
    }
  });
});

describe("replay upload GET", () => {
  it("validates ids and 404s missing uploads", async () => {
    const invalid = await handleReplayUploadGet(new Request(`${ORIGIN}/api/replay-upload?id=..%2Fetc`));
    expect(invalid.status).toBe(400);
    const missing = await handleReplayUploadGet(new Request(`${ORIGIN}/api/replay-upload?id=${"A".repeat(20)}`));
    expect(missing.status).toBe(404);
  });
});
