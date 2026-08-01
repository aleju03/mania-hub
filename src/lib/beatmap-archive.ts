import JSZip from "jszip";
import { BEATMAP_MIRRORS, type BeatmapMirrorName } from "./beatmap-mirrors";

const ARCHIVE_CACHE_TTL = 15 * 60 * 1000;
const ARCHIVE_CACHE_MAX_ENTRIES = 6;
const ARCHIVE_FETCH_TIMEOUT_MS = 15_000;
const ARCHIVE_SOURCE_MIN_INTERVAL_MS = 2_500;
const ARCHIVE_SOURCE_COOLDOWN_MS = 15 * 60 * 1000;
const ZIP_TAIL_BYTES = 128 * 1024;
const MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES = 60 * 1024 * 1024;

const ARCHIVE_SOURCES = BEATMAP_MIRRORS;

type ArchiveSourceName = BeatmapMirrorName;

type ArchiveCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  promise: Promise<JSZip>;
};

type RangeBuffer = {
  buffer: ArrayBuffer;
  totalBytes: number;
};

type ZipDirectoryEntry = {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  flags: number;
  localHeaderOffset: number;
};

type ZlibSync = {
  inflateRawSync: (buffer: Buffer) => Buffer;
};

const archiveCache = new Map<string, ArchiveCacheEntry>();
const archiveSourceState = new Map<ArchiveSourceName, { nextAvailableAt: number; cooldownUntil: number; tail: Promise<void> }>();
let zlibSyncPromise: Promise<ZlibSync> | null = null;

function getZlibSync(): Promise<ZlibSync> {
  if (!zlibSyncPromise) {
    zlibSyncPromise = (async () => {
      // This helper is server-only in practice, but it is reachable from mixed
      // TanStack Start modules. Hide the Node builtin from Vite's client graph.
      const importNodeModule = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<typeof import("node:zlib")>;
      const zlib = await importNodeModule("node:zlib");
      return { inflateRawSync: zlib.inflateRawSync as (buffer: Buffer) => Buffer };
    })().catch((error) => {
      zlibSyncPromise = null;
      throw error;
    });
  }
  return zlibSyncPromise;
}

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

function parseContentRange(header: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return null;
  if (start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

async function fetchRangeBuffer(url: string, range: string, limitBytes: number, signal: AbortSignal): Promise<RangeBuffer> {
  const response = await fetch(url, {
    signal,
    headers: { Range: range },
  });

  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`range request returned ${response.status}`);
  }

  const contentRange = parseContentRange(response.headers.get("content-range"));
  if (!contentRange) {
    await response.body?.cancel().catch(() => {});
    throw new Error("range response omitted Content-Range");
  }

  const expectedBytes = contentRange.end - contentRange.start + 1;
  if (expectedBytes > limitBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`range response is too large (${expectedBytes} bytes)`);
  }

  const buffer = await readResponseBufferWithLimit(response, limitBytes);
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`range response length mismatch (${buffer.byteLength} !== ${expectedBytes})`);
  }
  return { buffer, totalBytes: contentRange.total };
}

function findEndOfCentralDirectory(tail: Uint8Array): number {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

function decodeZipPath(bytes: Uint8Array, flags: number): string {
  const encoding = flags & 0x800 ? "utf-8" : "latin1";
  return new TextDecoder(encoding).decode(bytes).replace(/\\/g, "/");
}

function parseZipDirectoryEntries(buffer: ArrayBuffer): ZipDirectoryEntry[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entries: ZipDirectoryEntry[] = [];
  let offset = 0;

  while (offset + 46 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + filenameLength + extraLength + commentLength;
    if (nextOffset > bytes.length) break;
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error("zip64 archive entries are not supported by range extraction");
    }

    const pathBytes = bytes.subarray(offset + 46, offset + 46 + filenameLength);
    const path = decodeZipPath(pathBytes, flags);
    entries.push({ path, compressedSize, uncompressedSize, compressionMethod, flags, localHeaderOffset });
    offset = nextOffset;
  }

  return entries;
}

function pickZipDirectoryEntry(entries: ZipDirectoryEntry[], filename: string): ZipDirectoryEntry | null {
  const normalized = filename.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const baseName = normalized.split("/").pop()?.toLowerCase() ?? lower;

  const files = entries.filter((entry) => !entry.path.endsWith("/"));
  const exact = files.find((entry) => entry.path.toLowerCase() === lower);
  if (exact) return exact;

  const suffix = files.find((entry) => entry.path.toLowerCase().endsWith(`/${lower}`));
  if (suffix) return suffix;

  return files.find((entry) => entry.path.split("/").pop()?.toLowerCase() === baseName) ?? null;
}

async function extractArchiveFileByRangeFromUrl(url: string, filename: string, signal: AbortSignal): Promise<Buffer> {
  const tail = await fetchRangeBuffer(url, `bytes=-${ZIP_TAIL_BYTES}`, ZIP_TAIL_BYTES, signal);
  const tailBytes = new Uint8Array(tail.buffer);
  const eocdOffset = findEndOfCentralDirectory(tailBytes);
  if (eocdOffset < 0) throw new Error("zip central directory was not found");

  const eocdView = new DataView(tail.buffer, eocdOffset);
  const centralDirectorySize = eocdView.getUint32(12, true);
  const centralDirectoryOffset = eocdView.getUint32(16, true);
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported by range extraction");
  }
  if (centralDirectorySize <= 0 || centralDirectorySize > MAX_ZIP_CENTRAL_DIRECTORY_BYTES) {
    throw new Error(`zip central directory is too large (${centralDirectorySize} bytes)`);
  }
  if (centralDirectoryOffset + centralDirectorySize > tail.totalBytes) {
    throw new Error("zip central directory points outside the archive");
  }

  const directory = await fetchRangeBuffer(
    url,
    `bytes=${centralDirectoryOffset}-${centralDirectoryOffset + centralDirectorySize - 1}`,
    MAX_ZIP_CENTRAL_DIRECTORY_BYTES,
    signal,
  );
  const entry = pickZipDirectoryEntry(parseZipDirectoryEntries(directory.buffer), filename);
  if (!entry) throw new Error(`File "${filename}" not found in archive`);
  if (entry.flags & 0x1) throw new Error(`File "${filename}" is encrypted`);
  if (entry.uncompressedSize > MAX_EXTRACTED_FILE_BYTES || entry.compressedSize > MAX_EXTRACTED_FILE_BYTES) {
    throw new Error(`File "${filename}" is too large`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`File "${filename}" uses unsupported zip compression method ${entry.compressionMethod}`);
  }

  const header = await fetchRangeBuffer(
    url,
    `bytes=${entry.localHeaderOffset}-${entry.localHeaderOffset + 29}`,
    30,
    signal,
  );
  const headerView = new DataView(header.buffer);
  if (headerView.getUint32(0, true) !== 0x04034b50) {
    throw new Error(`File "${filename}" local header is invalid`);
  }

  const filenameLength = headerView.getUint16(26, true);
  const extraLength = headerView.getUint16(28, true);
  const dataOffset = entry.localHeaderOffset + 30 + filenameLength + extraLength;
  const data = await fetchRangeBuffer(
    url,
    `bytes=${dataOffset}-${dataOffset + entry.compressedSize - 1}`,
    MAX_EXTRACTED_FILE_BYTES,
    signal,
  );
  const compressed = Buffer.from(data.buffer);
  const output = entry.compressionMethod === 0
    ? compressed
    : (await getZlibSync()).inflateRawSync(compressed);
  if (output.length > MAX_EXTRACTED_FILE_BYTES) {
    throw new Error(`File "${filename}" is too large`);
  }
  return output;
}

async function extractArchiveFileByRange(beatmapsetId: string, filename: string): Promise<Buffer> {
  const errors: string[] = [];
  for (const source of ARCHIVE_SOURCES) {
    if (isArchiveSourceCoolingDown(source.name)) {
      errors.push(`${source.name}: cooling down`);
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
    try {
      return await withArchiveSourceSlot(source.name, () => (
        extractArchiveFileByRangeFromUrl(source.url(beatmapsetId), filename, controller.signal)
      ));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        cooldownArchiveSource(source.name);
      }
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Archive range extraction failed for beatmapset ${beatmapsetId} (${errors.join("; ")})`);
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
  try {
    return await extractArchiveFileByRange(beatmapsetId, filename);
  } catch {
    // Mirrors do not all support HTTP range requests. Fall back to the older
    // full-archive path so uncached assets still load when partial extraction
    // is unavailable.
  }

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
