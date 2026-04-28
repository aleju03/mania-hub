import { createFileRoute } from "@tanstack/react-router";
import { extractBeatmapArchiveFile } from "#/lib/beatmap-archive";
import { getCachedBeatmapAssetUrl, isR2ReplayCacheConfigured, putBeatmapAssetAndGetUrl } from "#/lib/r2-cache";

const AUDIO_CACHE_TTL = 15 * 60 * 1000;
const AUDIO_CACHE_MAX_ENTRIES = 12;
const AUDIO_CACHE_MAX_BYTES = 180 * 1024 * 1024;
const MAX_AUDIO_FILENAME_LENGTH = 260;

type AudioCacheValue = { buffer: Buffer; mimeType: string };
type AudioCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  promise: Promise<AudioCacheValue>;
};

const audioCache = new Map<string, AudioCacheEntry>();

const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav", ".flac"] as const;

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

export const Route = createFileRoute("/api/audio")({
  server: {
    handlers: {
      HEAD: async ({ request }) => {
        const url = new URL(request.url);
        const beatmapsetId = url.searchParams.get("beatmapsetId");
        const filename = url.searchParams.get("filename");

        if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
          return new Response(null, { status: 400 });
        }

        if (!filename || !isAllowedAudioFilename(filename)) {
          return new Response(null, { status: 400 });
        }

        const cacheHeaders = {
          "Cache-Control":
            "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
        };

        if (isR2ReplayCacheConfigured()) {
          const cached = await getCachedBeatmapAssetUrl("audio", beatmapsetId, filename);
          if (cached) {
            return new Response(null, {
              status: 200,
              headers: {
                ...cacheHeaders,
                "Accept-Ranges": "bytes",
                "Content-Length": String(cached.sizeBytes),
                "Content-Type": cached.mimeType,
                "X-Audio-Size-Bytes": String(cached.sizeBytes),
              },
            });
          }
        }

        return new Response(null, {
          status: 404,
          headers: cacheHeaders,
        });
      },
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const beatmapsetId = url.searchParams.get("beatmapsetId");
        const filename = url.searchParams.get("filename");

        if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
          return new Response("Invalid beatmapsetId", { status: 400 });
        }

        if (!filename || !isAllowedAudioFilename(filename)) {
          return new Response("Invalid filename", { status: 400 });
        }

        const cacheHeaders = {
          "Cache-Control":
            "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
        };

        if (isR2ReplayCacheConfigured()) {
          const cached = await getCachedBeatmapAssetUrl("audio", beatmapsetId, filename);
          if (cached) {
            return new Response(null, {
              status: 302,
              headers: {
                ...cacheHeaders,
                Location: cached.signedUrl,
              },
            });
          }
        }

        let buffer: Buffer;
        let mimeType: string;
        try {
          const extracted = await extractAudioFromArchive(beatmapsetId, filename);
          buffer = extracted.buffer;
          mimeType = extracted.mimeType;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown audio extraction error";
          return new Response(message, { status: 404 });
        }

        if (isR2ReplayCacheConfigured()) {
          try {
            const cached = await putBeatmapAssetAndGetUrl("audio", beatmapsetId, filename, mimeType, buffer);
            if (cached) {
              return new Response(null, {
                status: 302,
                headers: {
                  ...cacheHeaders,
                  Location: cached.signedUrl,
                },
              });
            }
          } catch {
            // Fall through to the legacy in-process response so playback still works.
          }
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
