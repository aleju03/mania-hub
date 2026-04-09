import JSZip from "jszip";

const ARCHIVE_CACHE_TTL = 15 * 60 * 1000;
const ARCHIVE_CACHE_MAX_ENTRIES = 6;

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
    const archiveUrl = `https://catboy.best/d/${encodeURIComponent(beatmapsetId)}`;
    const archiveResponse = await fetch(archiveUrl);
    if (!archiveResponse.ok) {
      throw new Error(`Archive fetch failed (${archiveResponse.status})`);
    }

    const archiveBuffer = await archiveResponse.arrayBuffer();
    return JSZip.loadAsync(archiveBuffer);
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

  return Buffer.from(await file.async("arraybuffer"));
}
