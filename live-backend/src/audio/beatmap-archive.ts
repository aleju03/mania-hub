import { inflateRawSync } from "node:zlib";

const ARCHIVE_FETCH_TIMEOUT_MS = 15_000;
const ARCHIVE_SOURCE_MIN_INTERVAL_MS = 2_500;
const ARCHIVE_SOURCE_COOLDOWN_MS = 15 * 60 * 1000;
const ZIP_TAIL_BYTES = 128 * 1024;
const MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES = 60 * 1024 * 1024;
const MAX_OSU_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_OSU_CANDIDATES = 128;

type ArchiveSource = {
  name: string;
  url: (beatmapsetId: string) => string;
  resolveRedirectBeforeRange?: boolean;
};

const ARCHIVE_SOURCES = [
  {
    name: "osudl",
    url: (beatmapsetId: string) => `https://osudl.org/s/${encodeURIComponent(beatmapsetId)}?video=false`,
    resolveRedirectBeforeRange: true,
  },
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
  {
    name: "sayobot",
    url: (beatmapsetId: string) => `https://txy1.sayobot.cn/beatmaps/download/full/${encodeURIComponent(beatmapsetId)}`,
  },
] as const satisfies readonly ArchiveSource[];

type ArchiveSourceName = (typeof ARCHIVE_SOURCES)[number]["name"];
type ArchiveSourceEntry = (typeof ARCHIVE_SOURCES)[number];

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

export interface BeatmapArchiveOsuFile {
  path: string;
  text: string;
}

const archiveSourceState = new Map<ArchiveSourceName, { nextAvailableAt: number; cooldownUntil: number; tail: Promise<void> }>();
let archiveSourceCursor = 0;

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
  await wait(Math.max(0, state.nextAvailableAt - Date.now()));
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

function getArchiveSourceOrder(now = Date.now()): ArchiveSourceEntry[] {
  const startIndex = archiveSourceCursor % ARCHIVE_SOURCES.length;
  archiveSourceCursor = (archiveSourceCursor + 1) % ARCHIVE_SOURCES.length;
  return [...ARCHIVE_SOURCES]
    .map((source, index) => {
      const state = getArchiveSourceState(source.name);
      return {
        source,
        rotationRank: (index - startIndex + ARCHIVE_SOURCES.length) % ARCHIVE_SOURCES.length,
        cooldownWaitMs: Math.max(0, state.cooldownUntil - now),
        slotWaitMs: Math.max(0, state.nextAvailableAt - now),
      };
    })
    .sort((left, right) =>
      Number(left.cooldownWaitMs > 0) - Number(right.cooldownWaitMs > 0)
      || left.slotWaitMs - right.slotWaitMs
      || left.rotationRank - right.rotationRank)
    .map((entry) => entry.source);
}

export function __resetArchiveSourceOrderForTest(): void {
  archiveSourceCursor = 0;
  archiveSourceState.clear();
}

export function __setArchiveSourceStateForTest(
  source: ArchiveSourceName,
  state: Partial<{ nextAvailableAt: number; cooldownUntil: number }>,
): void {
  const existing = getArchiveSourceState(source);
  existing.nextAvailableAt = state.nextAvailableAt ?? existing.nextAvailableAt;
  existing.cooldownUntil = state.cooldownUntil ?? existing.cooldownUntil;
}

export function __getArchiveSourceOrderForTest(now: number): ArchiveSourceName[] {
  return getArchiveSourceOrder(now).map((source) => source.name);
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

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
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
      throw new Error("zip64 archive entries are not supported by audio extraction");
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

function readZipDirectoryEntriesFromBuffer(buffer: ArrayBuffer): ZipDirectoryEntry[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) throw new Error("zip central directory was not found");

  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported by audio extraction");
  }
  if (centralDirectorySize <= 0 || centralDirectorySize > MAX_ZIP_CENTRAL_DIRECTORY_BYTES) {
    throw new Error(`zip central directory is too large (${centralDirectorySize} bytes)`);
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw new Error("zip central directory points outside the archive");
  }

  const directory = buffer.slice(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize);
  return parseZipDirectoryEntries(directory);
}

function validateZipEntry(entry: ZipDirectoryEntry, label: string, maxBytes = MAX_EXTRACTED_FILE_BYTES): void {
  if (entry.flags & 0x1) throw new Error(`File "${label}" is encrypted`);
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    throw new Error(`File "${label}" is too large`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`File "${label}" uses unsupported zip compression method ${entry.compressionMethod}`);
  }
}

function extractZipEntryFromBuffer(
  buffer: ArrayBuffer,
  entry: ZipDirectoryEntry,
  label = entry.path,
  maxBytes = MAX_EXTRACTED_FILE_BYTES,
): Buffer {
  validateZipEntry(entry, label, maxBytes);

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (entry.localHeaderOffset + 30 > bytes.length || view.getUint32(entry.localHeaderOffset, true) !== 0x04034b50) {
    throw new Error(`File "${label}" local header is invalid`);
  }
  const filenameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataOffset = entry.localHeaderOffset + 30 + filenameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error(`File "${label}" data points outside the archive`);

  const compressed = Buffer.from(buffer.slice(dataOffset, dataEnd));
  const output = entry.compressionMethod === 0 ? compressed : inflateRawSync(compressed);
  if (output.length > maxBytes) {
    throw new Error(`File "${label}" is too large`);
  }
  return output;
}

function extractEntryFromZipBuffer(buffer: ArrayBuffer, filename: string): Buffer {
  const entry = pickZipDirectoryEntry(readZipDirectoryEntriesFromBuffer(buffer), filename);
  if (!entry) throw new Error(`File "${filename}" not found in archive`);
  return extractZipEntryFromBuffer(buffer, entry, filename);
}

async function readZipDirectoryEntriesByRangeFromUrl(url: string, signal: AbortSignal): Promise<ZipDirectoryEntry[]> {
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
  return parseZipDirectoryEntries(directory.buffer);
}

async function extractZipEntryByRangeFromUrl(
  url: string,
  entry: ZipDirectoryEntry,
  signal: AbortSignal,
  label = entry.path,
  maxBytes = MAX_EXTRACTED_FILE_BYTES,
): Promise<Buffer> {
  validateZipEntry(entry, label, maxBytes);

  const header = await fetchRangeBuffer(
    url,
    `bytes=${entry.localHeaderOffset}-${entry.localHeaderOffset + 29}`,
    30,
    signal,
  );
  const headerView = new DataView(header.buffer);
  if (headerView.getUint32(0, true) !== 0x04034b50) {
    throw new Error(`File "${label}" local header is invalid`);
  }

  const filenameLength = headerView.getUint16(26, true);
  const extraLength = headerView.getUint16(28, true);
  const dataOffset = entry.localHeaderOffset + 30 + filenameLength + extraLength;
  const data = await fetchRangeBuffer(
    url,
    `bytes=${dataOffset}-${dataOffset + entry.compressedSize - 1}`,
    maxBytes,
    signal,
  );
  const compressed = Buffer.from(data.buffer);
  const output = entry.compressionMethod === 0 ? compressed : inflateRawSync(compressed);
  if (output.length > maxBytes) {
    throw new Error(`File "${label}" is too large`);
  }
  return output;
}

async function extractArchiveFileByRangeFromUrl(url: string, filename: string, signal: AbortSignal): Promise<Buffer> {
  const entry = pickZipDirectoryEntry(await readZipDirectoryEntriesByRangeFromUrl(url, signal), filename);
  if (!entry) throw new Error(`File "${filename}" not found in archive`);
  return extractZipEntryByRangeFromUrl(url, entry, signal, filename);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function resolveArchiveRangeUrl(source: (typeof ARCHIVE_SOURCES)[number], beatmapsetId: string, signal: AbortSignal): Promise<string> {
  const url = source.url(beatmapsetId);
  if (!("resolveRedirectBeforeRange" in source) || !source.resolveRedirectBeforeRange) return url;

  const response = await fetch(url, {
    signal,
    redirect: "manual",
    headers: { Range: "bytes=0-0" },
  });
  await response.body?.cancel().catch(() => {});

  if (isRedirectStatus(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect omitted Location");
    return new URL(location, url).toString();
  }
  if (response.status === 206) return url;
  if (!response.ok) throw new Error(`redirect probe returned ${response.status}`);
  throw new Error(`redirect probe returned ${response.status}`);
}

function isArchiveOsuEntry(entry: ZipDirectoryEntry): boolean {
  return !entry.path.endsWith("/")
    && entry.path.toLowerCase().endsWith(".osu")
    && entry.uncompressedSize > 0
    && entry.uncompressedSize <= MAX_OSU_FILE_BYTES
    && entry.compressedSize <= MAX_OSU_FILE_BYTES;
}

function normalizeArchiveLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getOsuCandidateScore(entry: ZipDirectoryEntry, hints?: { version?: string | null }): number {
  const version = normalizeArchiveLookupText(hints?.version ?? "");
  if (!version) return 0;

  const path = normalizeArchiveLookupText(entry.path);
  return path.includes(version) ? 1 : 0;
}

function getArchiveOsuCandidates(entries: ZipDirectoryEntry[], hints?: { version?: string | null }): ZipDirectoryEntry[] {
  return entries
    .filter(isArchiveOsuEntry)
    .sort((left, right) =>
      getOsuCandidateScore(right, hints) - getOsuCandidateScore(left, hints)
      || left.uncompressedSize - right.uncompressedSize
      || left.path.localeCompare(right.path));
}

function decodeOsuFile(buffer: Buffer): string {
  return new TextDecoder("utf-8").decode(buffer);
}

function readBeatmapIdFromOsuFile(text: string): number | null {
  const match = /^BeatmapID\s*:\s*(\d+)\s*$/im.exec(text);
  if (!match) return null;
  const beatmapId = Number(match[1]);
  return Number.isSafeInteger(beatmapId) && beatmapId > 0 ? beatmapId : null;
}

function summarizeArchiveCandidateErrors(errors: string[]): string {
  if (errors.length <= 5) return errors.join("; ");
  return `${errors.slice(0, 5).join("; ")}; ${errors.length - 5} more`;
}

function findBeatmapOsuFileInArchiveBuffer(
  buffer: ArrayBuffer,
  beatmapId: number,
  hints?: { version?: string | null },
): BeatmapArchiveOsuFile {
  const candidates = getArchiveOsuCandidates(readZipDirectoryEntriesFromBuffer(buffer), hints);
  if (candidates.length === 0) throw new Error("archive does not contain .osu files");

  const errors: string[] = [];
  for (const entry of candidates.slice(0, MAX_ARCHIVE_OSU_CANDIDATES)) {
    try {
      const text = decodeOsuFile(extractZipEntryFromBuffer(buffer, entry, entry.path, MAX_OSU_FILE_BYTES));
      if (readBeatmapIdFromOsuFile(text) === beatmapId) return { path: entry.path, text };
    } catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const suffix = errors.length > 0 ? ` (${summarizeArchiveCandidateErrors(errors)})` : "";
  throw new Error(`BeatmapID ${beatmapId} not found in archive .osu files${suffix}`);
}

async function findBeatmapOsuFileByRangeFromUrl(
  url: string,
  beatmapId: number,
  hints: { version?: string | null } | undefined,
  signal: AbortSignal,
): Promise<BeatmapArchiveOsuFile> {
  const candidates = getArchiveOsuCandidates(await readZipDirectoryEntriesByRangeFromUrl(url, signal), hints);
  if (candidates.length === 0) throw new Error("archive does not contain .osu files");

  const errors: string[] = [];
  for (const entry of candidates.slice(0, MAX_ARCHIVE_OSU_CANDIDATES)) {
    try {
      const text = decodeOsuFile(await extractZipEntryByRangeFromUrl(url, entry, signal, entry.path, MAX_OSU_FILE_BYTES));
      if (readBeatmapIdFromOsuFile(text) === beatmapId) return { path: entry.path, text };
    } catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const suffix = errors.length > 0 ? ` (${summarizeArchiveCandidateErrors(errors)})` : "";
  throw new Error(`BeatmapID ${beatmapId} not found in archive .osu files${suffix}`);
}

async function extractArchiveFileByRange(beatmapsetId: string, filename: string): Promise<Buffer> {
  const errors: string[] = [];
  for (const source of getArchiveSourceOrder()) {
    if (isArchiveSourceCoolingDown(source.name)) {
      errors.push(`${source.name}: cooling down`);
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
    try {
      return await withArchiveSourceSlot(source.name, async () => {
        const rangeUrl = await resolveArchiveRangeUrl(source, beatmapsetId, controller.signal);
        return extractArchiveFileByRangeFromUrl(rangeUrl, filename, controller.signal);
      });
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

async function extractBeatmapOsuFileByRange(
  beatmapsetId: string,
  beatmapId: number,
  hints?: { version?: string | null },
): Promise<BeatmapArchiveOsuFile> {
  const errors: string[] = [];
  for (const source of getArchiveSourceOrder()) {
    if (isArchiveSourceCoolingDown(source.name)) {
      errors.push(`${source.name}: cooling down`);
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
    try {
      return await withArchiveSourceSlot(source.name, async () => {
        const rangeUrl = await resolveArchiveRangeUrl(source, beatmapsetId, controller.signal);
        return findBeatmapOsuFileByRangeFromUrl(rangeUrl, beatmapId, hints, controller.signal);
      });
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
  throw new Error(`Archive .osu range extraction failed for beatmapset ${beatmapsetId} (${errors.join("; ")})`);
}

function isLikelyZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function extractArchiveFileByFullArchive(beatmapsetId: string, filename: string): Promise<Buffer> {
  const errors: string[] = [];
  for (const source of getArchiveSourceOrder()) {
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
      return extractEntryFromZipBuffer(archiveBuffer, filename);
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
}

async function extractBeatmapOsuFileByFullArchive(
  beatmapsetId: string,
  beatmapId: number,
  hints?: { version?: string | null },
): Promise<BeatmapArchiveOsuFile> {
  const errors: string[] = [];
  for (const source of getArchiveSourceOrder()) {
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
      return findBeatmapOsuFileInArchiveBuffer(archiveBuffer, beatmapId, hints);
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
  throw new Error(`Archive .osu fetch failed for beatmapset ${beatmapsetId} (${errors.join("; ")})`);
}

export async function extractBeatmapArchiveFile(beatmapsetId: string, filename: string): Promise<Buffer> {
  try {
    return await extractArchiveFileByRange(beatmapsetId, filename);
  } catch {
    // Mirrors do not all support HTTP range requests. Fall back to a full
    // archive fetch, but still extract only the requested audio file.
  }

  return extractArchiveFileByFullArchive(beatmapsetId, filename);
}

export async function extractBeatmapOsuFileFromArchive(
  beatmapsetId: string,
  beatmapId: number,
  hints?: { version?: string | null },
): Promise<BeatmapArchiveOsuFile> {
  try {
    return await extractBeatmapOsuFileByRange(beatmapsetId, beatmapId, hints);
  } catch {
    // Some mirrors do not support range reads, and some redirect routes need a
    // plain archive request. Fall back to a guarded full-archive fetch.
  }

  return extractBeatmapOsuFileByFullArchive(beatmapsetId, beatmapId, hints);
}
