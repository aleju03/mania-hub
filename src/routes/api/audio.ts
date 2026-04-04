import JSZip from "jszip";
import { createFileRoute } from "@tanstack/react-router";

const audioCache = new Map<string, Promise<{ buffer: Buffer; mimeType: string }>>();

function getMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  return "application/octet-stream";
}

function parseRangeHeader(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return null;

  if (startRaw === "") {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startRaw);
  const end = endRaw === "" ? size - 1 : Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

async function extractAudioFromArchive(beatmapsetId: string, filename: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const cacheKey = `${beatmapsetId}:${filename}`;
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;

  const request = (async () => {
    const archiveUrl = `https://catboy.best/d/${encodeURIComponent(beatmapsetId)}`;
    const archiveResponse = await fetch(archiveUrl);
    if (!archiveResponse.ok) {
      throw new Error(`Archive fetch failed (${archiveResponse.status})`);
    }

    const archiveBuffer = await archiveResponse.arrayBuffer();
    const zip = await JSZip.loadAsync(archiveBuffer);
    const file = zip.file(filename);
    if (!file) {
      throw new Error(`Audio file "${filename}" not found in archive`);
    }

    const extracted = Buffer.from(await file.async("arraybuffer"));
    return { buffer: extracted, mimeType: getMimeType(filename) };
  })();

  audioCache.set(cacheKey, request);
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

        if (!beatmapsetId) {
          return new Response("Missing beatmapsetId", { status: 400 });
        }

        if (!filename) {
          return new Response("Missing filename", { status: 400 });
        }

        try {
          const { buffer, mimeType } = await extractAudioFromArchive(beatmapsetId, filename);
          const range = parseRangeHeader(request.headers.get("range"), buffer.length);
          const headers = new Headers({
            "Content-Type": mimeType,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
          });

          if (!range) {
            headers.set("Content-Length", String(buffer.length));
            return new Response(buffer, { status: 200, headers });
          }

          const chunk = buffer.subarray(range.start, range.end + 1);
          headers.set("Content-Length", String(chunk.length));
          headers.set("Content-Range", `bytes ${range.start}-${range.end}/${buffer.length}`);
          return new Response(chunk, { status: 206, headers });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown audio extraction error";
          return new Response(message, { status: 404 });
        }
      },
    },
  },
});
