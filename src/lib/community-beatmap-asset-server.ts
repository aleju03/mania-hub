import {
  type CommunityBeatmapAssetKind,
  getCommunityBeatmapAssetBody,
  headCommunityBeatmapAsset,
  isR2ReplayCacheConfigured,
  signCommunityBeatmapAssetUrl,
} from "./r2-cache";
import {
  MAX_COMMUNITY_AUDIO_BYTES,
  MAX_COMMUNITY_BACKGROUND_BYTES,
  putCommunityBeatmapAssetFile,
  type CommunityBeatmapAssetSubmitResult,
} from "./community-beatmap-store";
import { authorizeUploader } from "./replay-upload-server";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";

// /api/community-beatmap-asset: the song and background of a community-
// contributed map. POST takes both files from the .osz the contributor just
// matched (multipart: checksum, audio, background); GET serves one back.
// Handler logic lives here so it is testable with plain Request objects.

const RATE_WINDOW_MS = 60 * 1000;
const UPLOAD_RATE_LIMIT_PER_WINDOW = 6;
const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

// Both files plus multipart framing.
const MAX_UPLOAD_BODY_BYTES = MAX_COMMUNITY_AUDIO_BYTES + MAX_COMMUNITY_BACKGROUND_BYTES + 64 * 1024;

// A miss must not be cached: it flips to a hit the moment someone contributes
// the file. A hit is immutable for its checksum.
const MISS_CACHE_CONTROL = "no-store";
const HIT_CACHE_CONTROL = "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable";

function parseAssetKind(value: string | null): CommunityBeatmapAssetKind | null {
  return value === "audio" || value === "background" ? value : null;
}

function parseChecksum(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null;
}

function validateAssetRequest(request: Request): { checksum: string; kind: CommunityBeatmapAssetKind; inline: boolean } | Response {
  const url = new URL(request.url);
  const checksum = parseChecksum(url.searchParams.get("checksum"));
  const kind = parseAssetKind(url.searchParams.get("kind"));
  if (!checksum) return new Response("Invalid checksum", { status: 400 });
  if (!kind) return new Response("Invalid kind", { status: 400 });
  return { checksum, kind, inline: url.searchParams.get("inline") === "1" };
}

export async function handleCommunityBeatmapAssetHead(request: Request): Promise<Response> {
  const validation = validateAssetRequest(request);
  if (validation instanceof Response) return validation;
  const head = await headCommunityBeatmapAsset(validation.checksum, validation.kind);
  if (!head) return new Response(null, { status: 404, headers: { "Cache-Control": MISS_CACHE_CONTROL } });
  return new Response(null, {
    status: 200,
    headers: {
      "Content-Type": head.mimeType,
      "Content-Length": String(head.sizeBytes),
      "Accept-Ranges": "bytes",
      "Cache-Control": HIT_CACHE_CONTROL,
    },
  });
}

export async function handleCommunityBeatmapAssetGet(request: Request): Promise<Response> {
  const validation = validateAssetRequest(request);
  if (validation instanceof Response) return validation;
  const { checksum, kind, inline } = validation;

  // Backgrounds go straight to storage like /api/background does; only a
  // canvas/WebGL consumer needs the bytes from this origin.
  if (kind === "background" && !inline && isR2ReplayCacheConfigured()) {
    const head = await headCommunityBeatmapAsset(checksum, kind);
    if (!head) return new Response("Not found", { status: 404, headers: { "Cache-Control": MISS_CACHE_CONTROL } });
    return new Response(null, {
      status: 302,
      headers: {
        Location: await signCommunityBeatmapAssetUrl(checksum, kind, head.mimeType),
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
      },
    });
  }

  // Audio streams through this origin so the <audio> element can seek and the
  // stall-recovery fetch can read it without a CORS policy on the bucket.
  const rangeHeader = request.headers.get("range");
  const object = await getCommunityBeatmapAssetBody(checksum, kind, rangeHeader);
  if (!object) {
    // Either a miss or an unsatisfiable range; tell the two apart with a HEAD.
    const head = rangeHeader ? await headCommunityBeatmapAsset(checksum, kind) : null;
    if (head) {
      return new Response("Invalid Range", {
        status: 416,
        headers: { "Content-Range": `bytes */${head.sizeBytes}`, "Cache-Control": HIT_CACHE_CONTROL },
      });
    }
    return new Response("Not found", { status: 404, headers: { "Cache-Control": MISS_CACHE_CONTROL } });
  }

  const headers: Record<string, string> = {
    "Content-Type": object.mimeType,
    "Content-Length": String(object.contentLength),
    "Accept-Ranges": "bytes",
    "Cache-Control": HIT_CACHE_CONTROL,
  };
  if (object.contentRange) headers["Content-Range"] = object.contentRange;
  return new Response(object.body, { status: object.status, headers });
}

export type CommunityBeatmapAssetUploadResponse = Partial<Record<CommunityBeatmapAssetKind, CommunityBeatmapAssetSubmitResult>>;

export async function handleCommunityBeatmapAssetPost(request: Request): Promise<Response> {
  const uploader = await authorizeUploader(request);
  if (!uploader) {
    return Response.json({ error: "Sign in to contribute beatmap files." }, { status: 401 });
  }
  if (rateLimiter.isRateLimited(`post:${uploader.rateKey}`, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads; try again in a minute." }, { status: 429 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const body = await readCappedBody(request, MAX_UPLOAD_BODY_BYTES);
  if (!body) {
    return Response.json({ error: "Beatmap files are too large." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await new Response(body as unknown as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return Response.json({ error: "Malformed form data." }, { status: 400 });
  }

  const checksumField = form.get("checksum");
  const checksum = parseChecksum(typeof checksumField === "string" ? checksumField : null);
  if (!checksum) {
    return Response.json({ error: "Invalid beatmap checksum." }, { status: 400 });
  }

  const results: CommunityBeatmapAssetUploadResponse = {};
  for (const kind of ["audio", "background"] as const) {
    const file = form.get(kind);
    if (!(file instanceof File)) continue;
    const cap = kind === "audio" ? MAX_COMMUNITY_AUDIO_BYTES : MAX_COMMUNITY_BACKGROUND_BYTES;
    if (file.size > cap) {
      results[kind] = { stored: false, reason: "too-large" };
      continue;
    }
    results[kind] = await putCommunityBeatmapAssetFile({
      checksum,
      kind,
      filename: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
  }
  if (!results.audio && !results.background) {
    return Response.json({ error: "No beatmap files were sent." }, { status: 400 });
  }
  return Response.json(results, { headers: { "Cache-Control": "private, no-store" } });
}
