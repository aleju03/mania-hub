import JSZip from "jszip";

const ARCHIVE_CACHE_TTL = 15 * 60 * 1000;
const ARCHIVE_CACHE_MAX_ENTRIES = 6;
const ARCHIVE_FETCH_TIMEOUT_MS = 15_000;
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES = 60 * 1024 * 1024;

const ARCHIVE_SOURCES = [
  {
    name: "catboy",
    url: (beatmapsetId: string) => `https://catboy.best/d/${encodeURIComponent(beatmapsetId)}`,
  },
  {
    name: "nerinyan",
    url: (beatmapsetId: string) => `https://api.nerinyan.moe/d/${encodeURIComponent(beatmapsetId)}`,
  },
  {
    name: "osu.direct",
    url: (beatmapsetId: string) => `https://osu.direct/api/d/${encodeURIComponent(beatmapsetId)}`,
  },
] as const;

type ArchiveCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  promise: Promise<JSZip>;
};

const archiveCache = new Map<string, ArchiveCacheEntry>();

function pruneArchiveCache(now = Date.now()): void {
  for (const [key, entry] of archiveCache.entries()) {
    if (entry.expiresAt <= now) {
      archiveCache.delete(key);
    }
  }

  if (archiveCache.size <= ARCHIVE_CACHE_MAX_ENTRIES) return;

  const entriesToRemove = [...archiveCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
    .slice(0, archiveCache.size - ARCHIVE_CACHE_MAX_ENTRIES);

  entriesToRemove.forEach(([key]) => {
    archiveCache.delete(key);
  });
}

async function readResponseBufferWithLimit(response: Response, limitBytes: number): Promise<ArrayBuffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0 || length > limitBytes) {
      throw new Error(`Archive is too large (${contentLength} bytes)`);
    }
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limitBytes) {
      throw new Error(`Archive is too large (${buffer.byteLength} bytes)`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Archive is too large (>${limitBytes} bytes)`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export async function getBeatmapArchive(beatmapsetId: string): Promise<JSZip> {
  const now = Date.now();
  const cached = archiveCache.get(beatmapsetId);
  if (cached && cached.expiresAt > now) {
    cached.lastAccessedAt = now;
    return cached.promise;
  }
  if (cached) {
    archiveCache.delete(beatmapsetId);
  }

  const request = (async () => {
    const errors: string[] = [];
    for (const source of ARCHIVE_SOURCES) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
      try {
        const archiveResponse = await fetch(source.url(beatmapsetId), {
          signal: controller.signal,
          headers: { "User-Agent": "mania-hub/beatmap-archive" },
        });
        if (!archiveResponse.ok) {
          throw new Error(`${source.name} returned ${archiveResponse.status}`);
        }

        const archiveBuffer = await readResponseBufferWithLimit(archiveResponse, MAX_ARCHIVE_BYTES);
        return JSZip.loadAsync(archiveBuffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source.name}: ${message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`Archive fetch failed for beatmapset ${beatmapsetId} (${errors.join("; ")})`);
  })();

  archiveCache.set(beatmapsetId, {
    expiresAt: now + ARCHIVE_CACHE_TTL,
    lastAccessedAt: now,
    promise: request,
  });
  pruneArchiveCache(now);
  request.catch(() => {
    archiveCache.delete(beatmapsetId);
  });
  return request;
}

export function findBeatmapArchiveFile(zip: JSZip, filename: string): JSZip.JSZipObject | null {
  const normalized = filename.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const baseName = normalized.split("/").pop()?.toLowerCase() ?? lower;

  const zipFiles = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, file) => {
    zipFiles.set(path.replace(/\\/g, "/").toLowerCase(), file);
  });

  const exact = zipFiles.get(lower);
  if (exact) return exact;

  for (const [path, file] of zipFiles) {
    if (path.endsWith(`/${lower}`)) return file;
  }

  for (const [path, file] of zipFiles) {
    if (path.split("/").pop() === baseName) return file;
  }

  return null;
}

export async function extractBeatmapArchiveFile(beatmapsetId: string, filename: string): Promise<Buffer> {
  const zip = await getBeatmapArchive(beatmapsetId);
  const file = findBeatmapArchiveFile(zip, filename);
  if (!file) {
    throw new Error(`File "${filename}" not found in archive`);
  }

  const metadata = file as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } };
  const uncompressedSize = metadata._data?.uncompressedSize;
  if (
    typeof uncompressedSize === "number" &&
    Number.isFinite(uncompressedSize) &&
    uncompressedSize > MAX_EXTRACTED_FILE_BYTES
  ) {
    throw new Error(`File "${filename}" is too large`);
  }

  const buffer = Buffer.from(await file.async("arraybuffer"));
  if (buffer.length > MAX_EXTRACTED_FILE_BYTES) {
    throw new Error(`File "${filename}" is too large`);
  }
  return buffer;
}
