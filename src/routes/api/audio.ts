import { createFileRoute } from "@tanstack/react-router";
import { extractBeatmapArchiveFile } from "#/lib/beatmap-archive";

const AUDIO_CACHE_TTL = 15 * 60 * 1000;
const AUDIO_CACHE_MAX_ENTRIES = 12;
const AUDIO_CACHE_MAX_BYTES = 180 * 1024 * 1024;
const MAX_AUDIO_FILENAME_LENGTH = 260;
const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav", ".flac", ".m4a"] as const;

type AudioCacheValue = { buffer: Buffer; mimeType: string };
type AudioCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  promise: Promise<AudioCacheValue>;
};

const audioCache = new Map<string, AudioCacheEntry>();

function getServerLiveBackendUrl(): string | null {
  const value = process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL;
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.replace(/\/+$/, "");
}

function getLiveAudioUrl(requestUrl: string): string | null {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const request = new URL(requestUrl);
  const target = new URL("/api/audio", base);
  const beatmapsetId = request.searchParams.get("beatmapsetId");
  const filename = request.searchParams.get("filename");
  if (beatmapsetId) target.searchParams.set("beatmapsetId", beatmapsetId);
  if (filename) target.searchParams.set("filename", filename);
  return target.toString();
}

function isAllowedAudioFilename(filename: string): boolean {
  if (filename.length > MAX_AUDIO_FILENAME_LENGTH || filename.includes("\0")) {
    return false;
  }
  const lower = filename.toLowerCase();
  return ALLOWED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function pruneAudioCache(now = Date.now()): void {
  for (const [key, entry] of audioCache.entries()) {
    if (entry.expiresAt <= now) {
      audioCache.delete(key);
    }
  }

  if (audioCache.size <= AUDIO_CACHE_MAX_ENTRIES) return;

  const entriesToRemove = [...audioCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, audioCache.size - AUDIO_CACHE_MAX_ENTRIES);

  entriesToRemove.forEach(([key]) => {
    audioCache.delete(key);
  });
}

function pruneAudioCacheByBytes(): void {
  let totalBytes = [...audioCache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (totalBytes <= AUDIO_CACHE_MAX_BYTES) return;

  const entriesByAge = [...audioCache.entries()]
    .filter(([, entry]) => entry.sizeBytes > 0)
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt);

  for (const [key, entry] of entriesByAge) {
    if (totalBytes <= AUDIO_CACHE_MAX_BYTES) break;
    audioCache.delete(key);
    totalBytes -= entry.sizeBytes;
  }
}

function getMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  return "application/octet-stream";
}

async function extractAudioFromArchive(beatmapsetId: string, filename: string): Promise<AudioCacheValue> {
  const cacheKey = `${beatmapsetId}:${filename}`;
  const now = Date.now();
  const cached = audioCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    cached.lastAccessedAt = now;
    return cached.promise;
  }
  if (cached) {
    audioCache.delete(cacheKey);
  }

  const request = (async () => {
    const extracted = await extractBeatmapArchiveFile(beatmapsetId, filename);
    return { buffer: extracted, mimeType: getMimeType(filename) };
  })();

  audioCache.set(cacheKey, {
    expiresAt: now + AUDIO_CACHE_TTL,
    lastAccessedAt: now,
    sizeBytes: 0,
    promise: request,
  });
  pruneAudioCache(now);
  request.then((value) => {
    const entry = audioCache.get(cacheKey);
    if (!entry) return;
    entry.sizeBytes = value.buffer.length;
    pruneAudioCacheByBytes();
  }).catch(() => {});
  request.catch(() => {
    audioCache.delete(cacheKey);
  });
  return request;
}

function copyAudioProxyHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const key of [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "x-audio-mp3-in-mp4",
    "x-audio-size-bytes",
  ]) {
    const value = headers.get(key);
    if (value) out.set(key, value);
  }
  return out;
}

// Accepts: bytes=start-end | bytes=start- | bytes=-suffix
function parseRangeHeader(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size) return null;
  return { start, end };
}

function validateAudioRequest(request: Request): { beatmapsetId: string; filename: string } | Response {
  const url = new URL(request.url);
  const beatmapsetId = url.searchParams.get("beatmapsetId");
  const filename = url.searchParams.get("filename");

  if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
    return new Response("Invalid beatmapsetId", { status: 400 });
  }
  if (!filename || !isAllowedAudioFilename(filename)) {
    return new Response("Invalid filename", { status: 400 });
  }
  return { beatmapsetId, filename };
}

export const Route = createFileRoute("/api/audio")({
  server: {
    handlers: {
      HEAD: async ({ request }) => {
        const validation = validateAudioRequest(request);
        if (validation instanceof Response) return validation;

        const liveUrl = getLiveAudioUrl(request.url);
        if (liveUrl) {
          try {
            const response = await fetch(liveUrl, { method: "HEAD" });
            return new Response(null, {
              status: response.status,
              headers: copyAudioProxyHeaders(response.headers),
            });
          } catch {
            return new Response(null, { status: 503 });
          }
        }

        return new Response(null, {
          status: 404,
          headers: {
            "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
          },
        });
      },
      GET: async ({ request }) => {
        const validation = validateAudioRequest(request);
        if (validation instanceof Response) return validation;

        const liveUrl = getLiveAudioUrl(request.url);
        if (liveUrl) {
          return new Response(null, {
            status: 302,
            headers: {
              "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
              Location: liveUrl,
            },
          });
        }

        let buffer: Buffer;
        let mimeType: string;
        try {
          const extracted = await extractAudioFromArchive(validation.beatmapsetId, validation.filename);
          buffer = extracted.buffer;
          mimeType = extracted.mimeType;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown audio extraction error";
          return new Response(message, { status: 404 });
        }

        const size = buffer.length;
        const baseHeaders: Record<string, string> = {
          "Content-Type": mimeType,
          "Accept-Ranges": "bytes",
          "Cache-Control":
            "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
        };

        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          const parsed = parseRangeHeader(rangeHeader, size);
          if (!parsed) {
            return new Response("Invalid Range", {
              status: 416,
              headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
            });
          }
          const { start, end } = parsed;
          const slice = buffer.subarray(start, end + 1);
          return new Response(slice as unknown as BodyInit, {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Length": String(slice.length),
              "Content-Range": `bytes ${start}-${end}/${size}`,
            },
          });
        }

        return new Response(buffer as unknown as BodyInit, {
          status: 200,
          headers: { ...baseHeaders, "Content-Length": String(size) },
        });
      },
    },
  },
});
