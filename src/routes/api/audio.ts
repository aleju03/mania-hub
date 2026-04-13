import { createFileRoute } from "@tanstack/react-router";
import { extractBeatmapArchiveFile } from "#/lib/beatmap-archive";

const AUDIO_CACHE_TTL = 15 * 60 * 1000;
const AUDIO_CACHE_MAX_ENTRIES = 12;

type AudioCacheValue = { buffer: Buffer; mimeType: string };
type AudioCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  promise: Promise<AudioCacheValue>;
};

const audioCache = new Map<string, AudioCacheEntry>();

const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav", ".flac"] as const;

function isAllowedAudioFilename(filename: string): boolean {
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
    promise: request,
  });
  pruneAudioCache(now);
  request.catch(() => {
    audioCache.delete(cacheKey);
  });
  return request;
}

export const Route = createFileRoute("/api/audio")({
  server: {
    handlers: {
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

        try {
          const { buffer, mimeType } = await extractAudioFromArchive(beatmapsetId, filename);
          return new Response(buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": mimeType,
              "Content-Length": String(buffer.length),
              "Cache-Control": "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown audio extraction error";
          return new Response(message, { status: 404 });
        }
      },
    },
  },
});
