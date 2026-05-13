import JSZip from "jszip";

const ARCHIVE_CACHE_TTL = 15 * 60 * 1000;
const ARCHIVE_CACHE_MAX_ENTRIES = 6;
const ARCHIVE_FETCH_TIMEOUT_MS = 15_000;
const ARCHIVE_SOURCE_MIN_INTERVAL_MS = 2_500;
const ARCHIVE_SOURCE_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES = 60 * 1024 * 1024;

const ARCHIVE_SOURCES = [
  {
    name: "osu.direct",
    url: (beatmapsetId: string) => `https://osu.direct/api/d/${encodeURIComponent(beatmapsetId)}`,
  },
  {
    name: "catboy",
    url: (beatmapsetId: string) => `https://catboy.best/d/${encodeURIComponent(beatmapsetId)}`,
  },
  {
    name: "hinai",
    url: (beatmapsetId: string) => `https://mirror.hinamizawa.ai/d/${encodeURIComponent(beatmapsetId)}?redirect=true`,
  },
  {
    name: "nerinyan",
    url: (beatmapsetId: string) => `https://api.nerinyan.moe/d/${encodeURIComponent(beatmapsetId)}`,
  },
] as const;

type ArchiveSourceName = (typeof ARCHIVE_SOURCES)[number]["name"];

type ArchiveCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  promise: Promise<JSZip>;
};

const archiveCache = new Map<string, ArchiveCacheEntry>();
const archiveSourceState = new Map<ArchiveSourceName, { nextAvailableAt: number; cooldownUntil: number; tail: Promise<void> }>();

function getArchiveSourceState(source: ArchiveSourceName) {
  let state = archiveSourceState.get(source);
  if (!state) {
    state = { nextAvailableAt: 0, cooldownUntil: 0, tail: Promise.resolve() };
    archiveSourceState.set(source, state);
  }
  return state;
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withArchiveSourceSlot<T>(source: ArchiveSourceName, task: () => Promise<T>): Promise<T> {
  const state = getArchiveSourceState(source);
  const previous = state.tail.catch(() => {});
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const now = Date.now();
  await wait(Math.max(0, state.nextAvailableAt - now));
  state.nextAvailableAt = Date.now() + ARCHIVE_SOURCE_MIN_INTERVAL_MS;
  try {
    return await task();
  } finally {
    release();
  }
}

function isArchiveSourceCoolingDown(source: ArchiveSourceName, now = Date.now()): boolean {
  return getArchiveSourceState(source).cooldownUntil > now;
}

function cooldownArchiveSource(source: ArchiveSourceName): void {
  getArchiveSourceState(source).cooldownUntil = Date.now() + ARCHIVE_SOURCE_COOLDOWN_MS;
}

function shouldCooldownArchiveSource(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

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

function isLikelyZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
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
      if (isArchiveSourceCoolingDown(source.name)) {
        errors.push(`${source.name}: cooling down`);
        continue;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
      let shouldCooldown = false;
      try {
        const archiveResponse = await withArchiveSourceSlot(source.name, () => fetch(source.url(beatmapsetId), { signal: controller.signal }));
        if (!archiveResponse.ok) {
          shouldCooldown = shouldCooldownArchiveSource(archiveResponse.status);
          throw new Error(`${source.name} returned ${archiveResponse.status}`);
        }

        const archiveBuffer = await readResponseBufferWithLimit(archiveResponse, MAX_ARCHIVE_BYTES);
        if (!isLikelyZip(archiveBuffer)) {
          throw new Error(`${source.name} returned a non-zip response`);
        }
        return JSZip.loadAsync(archiveBuffer);
      } catch (error) {
        if (shouldCooldown || (error instanceof Error && error.name === "AbortError")) {
          cooldownArchiveSource(source.name);
        }
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

export async function extractBeatmapArchiveOsuFile(beatmapsetId: string, beatmapId: number): Promise<string> {
  const zip = await getBeatmapArchive(beatmapsetId);
  const expectedId = String(beatmapId);
  let fallback: JSZip.JSZipObject | null = null;
  let matched: JSZip.JSZipObject | null = null;

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !path.toLowerCase().endsWith(".osu")) continue;
    fallback ??= file;
    const content = await file.async("string");
    if (content.match(/^BeatmapID\s*:\s*(\d+)/m)?.[1] === expectedId) {
      matched = file;
      break;
    }
  }

  const file = matched ?? fallback;
  if (!file) throw new Error(`No .osu file found in beatmapset ${beatmapsetId}`);
  const content = await file.async("string");
  if (!content.trimStart().startsWith("osu file format")) {
    throw new Error(`Archive .osu file for beatmap ${beatmapId} is invalid`);
  }
  return content;
}
