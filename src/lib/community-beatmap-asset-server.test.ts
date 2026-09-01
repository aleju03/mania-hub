import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthCookieHeader } from "./auth-server";

// In-memory stand-ins for the R2 objects so the route's auth, multipart
// parsing, validation and Range serving are what gets exercised.
const objectStore = new Map<string, string>();
const assetStore = new Map<string, { mimeType: string; buffer: Buffer }>();
vi.mock("./r2-cache", () => ({
  isR2ReplayCacheConfigured: () => true,
  getCommunityBeatmapObject: vi.fn(async (checksum: string) => objectStore.get(checksum) ?? null),
  putCommunityBeatmapObject: vi.fn(async (checksum: string, content: string) => {
    objectStore.set(checksum, content);
    return true;
  }),
  headCommunityBeatmapAsset: vi.fn(async (checksum: string, kind: string) => {
    const entry = assetStore.get(`${checksum}/${kind}`);
    return entry ? { mimeType: entry.mimeType, sizeBytes: entry.buffer.length } : null;
  }),
  putCommunityBeatmapAsset: vi.fn(async (checksum: string, kind: string, mimeType: string, buffer: Buffer) => {
    const key = `${checksum}/${kind}`;
    if (assetStore.has(key)) return false;
    assetStore.set(key, { mimeType, buffer });
    return true;
  }),
  getCommunityBeatmapAssetBody: vi.fn(async (checksum: string, kind: string, range?: string | null) => {
    const entry = assetStore.get(`${checksum}/${kind}`);
    if (!entry) return null;
    let slice = entry.buffer;
    let contentRange: string | undefined;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return null;
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : entry.buffer.length - 1;
      if (start >= entry.buffer.length) return null;
      slice = entry.buffer.subarray(start, end + 1);
      contentRange = `bytes ${start}-${end}/${entry.buffer.length}`;
    }
    return {
      status: contentRange ? 206 : 200,
      mimeType: entry.mimeType,
      contentLength: slice.length,
      contentRange,
      body: new Blob([new Uint8Array(slice)]).stream(),
    };
  }),
  signCommunityBeatmapAssetUrl: vi.fn(async (checksum: string, kind: string) => `https://storage.example/${checksum}/${kind}?signed`),
}));

import {
  handleCommunityBeatmapAssetGet,
  handleCommunityBeatmapAssetHead,
  handleCommunityBeatmapAssetPost,
} from "./community-beatmap-asset-server";
import { putCommunityBeatmap } from "./community-beatmap-store";

const ORIGIN = "https://mania-tracker.com";
let nextViewerId = 9000;

async function authCookie(id: number): Promise<string> {
  const header = await createAuthCookieHeader(
    { id, username: `tester${id}`, avatarUrl: "", countryCode: "CR" },
    new Request(`${ORIGIN}/`),
  );
  return header.split(";")[0];
}

const OSU = [
  "osu file format v14",
  "",
  "[General]",
  "AudioFilename: song.mp3",
  "",
  "[Events]",
  '0,0,"bg.png",0,0',
  "",
  "[HitObjects]",
  "256,192,1000,1,0,0:0:0:0:",
  "",
].join("\n");
const CHECKSUM = createHash("md5").update(OSU, "utf8").digest("hex");
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.from("x".repeat(200))]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

async function post(form: FormData, cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return handleCommunityBeatmapAssetPost(new Request(`${ORIGIN}/api/community-beatmap-asset`, { method: "POST", body: form, headers }));
}

function assetForm(fields: { audio?: Buffer; background?: Buffer; checksum?: string }): FormData {
  const form = new FormData();
  form.set("checksum", fields.checksum ?? CHECKSUM);
  if (fields.audio) form.set("audio", new File([new Uint8Array(fields.audio)], "song.mp3"));
  if (fields.background) form.set("background", new File([new Uint8Array(fields.background)], "bg.png"));
  return form;
}

describe("community beatmap asset route", () => {
  beforeAll(() => {
    process.env.AUTH_SESSION_SECRET = "vitest-replay-secret-vitest-replay-secret";
  });

  beforeEach(async () => {
    objectStore.clear();
    assetStore.clear();
    await putCommunityBeatmap(CHECKSUM, OSU);
  });

  it("requires a signed-in contributor", async () => {
    const response = await post(assetForm({ audio: MP3 }), null);
    expect(response.status).toBe(401);
    expect(assetStore.size).toBe(0);
  });

  it("stores both files from one multipart post and serves them back", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await post(assetForm({ audio: MP3, background: PNG }), cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ audio: { stored: true }, background: { stored: true } });

    const head = await handleCommunityBeatmapAssetHead(new Request(`${ORIGIN}/api/community-beatmap-asset?checksum=${CHECKSUM}&kind=audio`));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("audio/mpeg");
    expect(head.headers.get("accept-ranges")).toBe("bytes");

    // The background redirects to storage like /api/background; inline=1 streams the bytes.
    const bg = await handleCommunityBeatmapAssetGet(new Request(`${ORIGIN}/api/community-beatmap-asset?checksum=${CHECKSUM}&kind=background`));
    expect(bg.status).toBe(302);
    expect(bg.headers.get("location")).toContain(`/${CHECKSUM}/background`);
    const inline = await handleCommunityBeatmapAssetGet(new Request(`${ORIGIN}/api/community-beatmap-asset?checksum=${CHECKSUM}&kind=background&inline=1`));
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await inline.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("serves audio byte ranges so the player can seek", async () => {
    const cookie = await authCookie(nextViewerId++);
    await post(assetForm({ audio: MP3 }), cookie);

    const partial = await handleCommunityBeatmapAssetGet(new Request(`${ORIGIN}/api/community-beatmap-asset?checksum=${CHECKSUM}&kind=audio`, {
      headers: { range: "bytes=3-12" },
    }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 3-12/${MP3.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).toString()).toBe("x".repeat(10));

    const bad = await handleCommunityBeatmapAssetGet(new Request(`${ORIGIN}/api/community-beatmap-asset?checksum=${CHECKSUM}&kind=audio`, {
      headers: { range: `bytes=${MP3.length + 5}-` },
    }));
    expect(bad.status).toBe(416);
  });

  it("reports a per-file verdict and never caches a miss", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await post(assetForm({ audio: PNG, background: PNG }), cookie);
    expect(await response.json()).toEqual({
      audio: { stored: false, reason: "invalid-file" },
      background: { stored: true },
    });

    const miss = await handleCommunityBeatmapAssetGet(new Request(`${ORIGIN}/api/community-beatmap-asset?checksum=${CHECKSUM}&kind=audio`));
    expect(miss.status).toBe(404);
    expect(miss.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a post with no files, a bad checksum, or a map that was never contributed", async () => {
    const cookie = await authCookie(nextViewerId++);
    expect((await post(assetForm({}), cookie)).status).toBe(400);
    expect((await post(assetForm({ audio: MP3, checksum: "nope" }), cookie)).status).toBe(400);
    const unknown = await post(assetForm({ audio: MP3, checksum: "a".repeat(32) }), cookie);
    expect(await unknown.json()).toEqual({ audio: { stored: false, reason: "no-beatmap" } });
  });
});
