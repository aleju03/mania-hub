import { inflateRawSync } from "node:zlib";

const ARCHIVE_FETCH_TIMEOUT_MS = 15_000;
const ARCHIVE_SOURCE_MIN_INTERVAL_MS = 2_500;
const ARCHIVE_SOURCE_COOLDOWN_MS = 15 * 60 * 1000;
const ZIP_TAIL_BYTES = 128 * 1024;
const MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;
// Real mania sets get this big: beatmapset 2136400 (Vietnamese Chordjack Pack 5,
// 27 diffs) is 84,661,083 bytes = 80.7 MiB, i.e. 67% of this cap, and multi-diff
// practice packs in the 30-85 MB range are routine. Anything under ~96 MiB stops
// legitimate downloads, so lower BEATMAP_ARCHIVE_MAX_BYTES only with new evidence.
const DEFAULT_MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_EXTRACTED_FILE_BYTES = 60 * 1024 * 1024;
// Only 2 of the 121,369 charts cached in production are above this (largest
// 36.6 MB) and both fall back to the osu! API, while a 14.9 MB one does come
// through the archive path: the limit sits at the edge, not comfortably above.
const MAX_OSU_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_OSU_CANDIDATES = 128;
const ARCHIVE_FETCH_HEADERS = {
  "user-agent": "mania-hub/1.0 (+https://mania-tracker.com)",
  accept: "application/zip,application/octet-stream,*/*;q=0.8",
} as const;

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

export type ZipDirectoryEntry = {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  flags: number;
  localHeaderOffset: number;
};

class ArchiveHttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveHttpStatusError";
  }
}

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

function archiveAbortError(): Error {
  const error = new Error("archive request timed out");
  error.name = "AbortError";
  return error;
}

// Settles when the task settles or the signal aborts, whichever comes first.
// A fetch promise that outlives its abort signal must not keep the per-source
// queue slot claimed.
function raceWithAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    task.catch(() => {});
    return Promise.reject(archiveAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      task.catch(() => {});
      reject(archiveAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function withArchiveSourceSlot<T>(source: ArchiveSourceName, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  const state = getArchiveSourceState(source);
  const previous = state.tail.catch(() => {});
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    if (signal.aborted) throw archiveAbortError();
    await wait(Math.max(0, state.nextAvailableAt - Date.now()));
    if (signal.aborted) throw archiveAbortError();
    state.nextAvailableAt = Date.now() + ARCHIVE_SOURCE_MIN_INTERVAL_MS;
    return await raceWithAbort(task(), signal);
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

export function __withArchiveSourceSlotForTest<T>(
  source: ArchiveSourceName,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  return withArchiveSourceSlot(source, signal, task);
}

// ArrayBuffer.prototype.transfer landed in Node 21; prod runs v22.
type TransferableArrayBuffer = ArrayBuffer & { transfer?: (newByteLength?: number) => ArrayBuffer };

// Content-Length only promises the size of the body we are about to read when
// that body is not encoded: undici decodes gzip/br transparently but leaves the
// *compressed* Content-Length on the response headers.
function trustedBodyLength(response: Response, limitBytes: number, expectedBytes?: number): number | null {
  const declared = expectedBytes ?? readContentLengthHeader(response);
  if (declared == null) return null;
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > limitBytes) return null;
  if (expectedBytes == null) {
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.trim().toLowerCase() !== "identity") return null;
  }
  return declared;
}

function readContentLengthHeader(response: Response): number | null {
  const raw = response.headers.get("content-length");
  return raw ? Number(raw) : null;
}

// `expectedBytes` is the length the caller already validated against the
// response metadata (Content-Range on the range path).
async function readResponseBufferWithLimit(
  response: Response,
  limitBytes: number,
  expectedBytes?: number,
): Promise<ArrayBuffer> {
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
  const expected = trustedBodyLength(response, limitBytes, expectedBytes);
  if (expected != null) return readExactResponseBuffer(reader, expected);

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

// Fills one allocation of the announced size instead of accumulating chunks and
// concatenating them: an 85 MB archive peaks at ~85 MB resident here versus
// ~220 MB through the growth path.
async function readExactResponseBuffer(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: number,
): Promise<ArrayBuffer> {
  const out = new Uint8Array(expected);
  let offset = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (offset + value.byteLength > expected) {
      await reader.cancel().catch(() => {});
      throw new Error(`Archive body exceeded its declared length (${expected} bytes)`);
    }
    out.set(value, offset);
    offset += value.byteLength;
  }

  if (offset === expected) return out.buffer;
  // A short body must not leave trailing zeros behind: the zip EOCD scan walks
  // backwards from the end of the buffer and would never find the signature.
  const buffer = out.buffer as TransferableArrayBuffer;
  return typeof buffer.transfer === "function" ? buffer.transfer(offset) : buffer.slice(0, offset);
}

export function __readResponseBufferWithLimitForTest(
  response: Response,
  limitBytes: number,
  expectedBytes?: number,
): Promise<ArrayBuffer> {
  return readResponseBufferWithLimit(response, limitBytes, expectedBytes);
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
    headers: { ...ARCHIVE_FETCH_HEADERS, Range: range },
  });

  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new ArchiveHttpStatusError(response.status, `range request returned ${response.status}`);
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

  const buffer = await readResponseBufferWithLimit(response, limitBytes, expectedBytes);
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
    headers: { ...ARCHIVE_FETCH_HEADERS, Range: "bytes=0-0" },
  });
  await response.body?.cancel().catch(() => {});

  if (isRedirectStatus(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect omitted Location");
    return new URL(location, url).toString();
  }
  if (response.status === 206) return url;
  if (!response.ok) throw new ArchiveHttpStatusError(response.status, `redirect probe returned ${response.status}`);
  throw new Error(`redirect probe returned ${response.status}`);
}

function shouldCooldownArchiveError(error: unknown): boolean {
  if (error instanceof ArchiveHttpStatusError) return shouldCooldownArchiveSource(error.status);
  return error instanceof Error && error.name === "AbortError";
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
      return await withArchiveSourceSlot(source.name, controller.signal, async () => {
        const rangeUrl = await resolveArchiveRangeUrl(source, beatmapsetId, controller.signal);
        return extractArchiveFileByRangeFromUrl(rangeUrl, filename, controller.signal);
      });
    } catch (error) {
      if (shouldCooldownArchiveError(error)) cooldownArchiveSource(source.name);
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
      return await withArchiveSourceSlot(source.name, controller.signal, async () => {
        const rangeUrl = await resolveArchiveRangeUrl(source, beatmapsetId, controller.signal);
        return findBeatmapOsuFileByRangeFromUrl(rangeUrl, beatmapId, hints, controller.signal);
      });
    } catch (error) {
      if (shouldCooldownArchiveError(error)) cooldownArchiveSource(source.name);
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

// The full-archive branch is the memory-heavy one: a download holds up to the
// archive cap in memory. Per-mirror slots alone would still allow one download
// per mirror at a time, so the branch as a whole is gated, and concurrent
// extractions of the same set (audio, hitsounds, a .osu) share a single
// download instead of each pulling its own copy.
const MAX_CONCURRENT_FULL_ARCHIVES = 2;
const MAX_FULL_ARCHIVE_ATTEMPTS = 2;
// The queue in front of those two slots is the part a public endpoint can abuse:
// /api/audio and /api/hitsounds admit far more requests per minute than two
// slots can drain (one sweep costs up to a mirror timeout per mirror, and the
// per-mirror spacing serializes it further), and a waiter that has been queued
// for a whole sweep has no client left listening. So the queue gets a hard
// ceiling and sheds on arrival — the same shape as the total SSE connection cap
// — and every waiter it does accept expires on its own.
const MAX_FULL_ARCHIVE_WAITERS = 8;
const FULL_ARCHIVE_QUEUE_TIMEOUT_MS = ARCHIVE_SOURCES.length * ARCHIVE_FETCH_TIMEOUT_MS;

type FullArchive = {
  buffer: ArrayBuffer;
  source: ArchiveSourceName;
};

// A waiter needs an identity so the queue can drop it again: a bare resolve
// cannot be found in the array once its deadline passes.
type FullArchiveWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let activeFullArchives = 0;
const fullArchiveWaiters: FullArchiveWaiter[] = [];
const fullArchiveDownloads = new Map<string, Promise<FullArchive>>();

function removeFullArchiveWaiter(waiter: FullArchiveWaiter): boolean {
  const index = fullArchiveWaiters.indexOf(waiter);
  if (index < 0) return false;
  fullArchiveWaiters.splice(index, 1);
  clearTimeout(waiter.timer);
  return true;
}

function acquireFullArchiveSlot(): Promise<void> {
  if (activeFullArchives < MAX_CONCURRENT_FULL_ARCHIVES) {
    activeFullArchives++;
    return Promise.resolve();
  }
  if (fullArchiveWaiters.length >= MAX_FULL_ARCHIVE_WAITERS) {
    return Promise.reject(new Error("too many archive downloads are queued"));
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: FullArchiveWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        if (removeFullArchiveWaiter(waiter)) reject(new Error("timed out waiting for an archive download slot"));
      }, FULL_ARCHIVE_QUEUE_TIMEOUT_MS),
    };
    // The deadline alone must not hold the process open.
    waiter.timer.unref?.();
    fullArchiveWaiters.push(waiter);
  });
}

function releaseFullArchiveSlot(): void {
  const next = fullArchiveWaiters.shift();
  if (!next) {
    activeFullArchives--;
    return;
  }
  // The slot is handed straight to the next waiter, so the counter never drops
  // below the number of downloads actually running.
  clearTimeout(next.timer);
  next.resolve();
}

async function withFullArchiveSlot<T>(task: () => Promise<T>): Promise<T> {
  // A rejected acquire never held a slot, so it must not release one either.
  await acquireFullArchiveSlot();
  try {
    return await task();
  } finally {
    releaseFullArchiveSlot();
  }
}

async function fetchFullArchive(
  beatmapsetId: string,
  maxArchiveBytes: number,
  skipSources: ReadonlySet<ArchiveSourceName>,
): Promise<FullArchive> {
  const errors: string[] = [];
  for (const source of getArchiveSourceOrder()) {
    if (skipSources.has(source.name)) continue;
    if (isArchiveSourceCoolingDown(source.name)) {
      errors.push(`${source.name}: cooling down`);
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
    let shouldCooldown = false;
    try {
      const archiveResponse = await withArchiveSourceSlot(source.name, controller.signal, () => fetch(source.url(beatmapsetId), {
        signal: controller.signal,
        headers: ARCHIVE_FETCH_HEADERS,
      }));
      if (!archiveResponse.ok) {
        shouldCooldown = shouldCooldownArchiveSource(archiveResponse.status);
        throw new Error(`${source.name} returned ${archiveResponse.status}`);
      }

      const buffer = await readResponseBufferWithLimit(archiveResponse, maxArchiveBytes);
      if (!isLikelyZip(buffer)) {
        throw new Error(`${source.name} returned a non-zip response`);
      }
      return { buffer, source: source.name };
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
  throw new Error(`no mirror served the archive (${errors.join("; ")})`);
}

function getFullArchive(
  beatmapsetId: string,
  maxArchiveBytes: number,
  skipSources: ReadonlySet<ArchiveSourceName>,
): Promise<FullArchive> {
  const key = `${beatmapsetId}:${maxArchiveBytes}:${[...skipSources].sort().join(",")}`;
  const inFlight = fullArchiveDownloads.get(key);
  if (inFlight) return inFlight;

  const download = withFullArchiveSlot(() => fetchFullArchive(beatmapsetId, maxArchiveBytes, skipSources))
    .finally(() => {
      fullArchiveDownloads.delete(key);
    });
  fullArchiveDownloads.set(key, download);
  return download;
}

export function __getFullArchiveForTest(beatmapsetId: string, maxArchiveBytes: number): Promise<{ buffer: ArrayBuffer }> {
  return getFullArchive(beatmapsetId, maxArchiveBytes, new Set());
}

export function __getFullArchiveStateForTest(): { inFlight: number; active: number; waiting: number } {
  return { inFlight: fullArchiveDownloads.size, active: activeFullArchives, waiting: fullArchiveWaiters.length };
}

export function __withFullArchiveSlotForTest<T>(task: () => Promise<T>): Promise<T> {
  return withFullArchiveSlot(task);
}

export function __resetFullArchiveQueueForTest(): void {
  for (const waiter of fullArchiveWaiters.splice(0)) clearTimeout(waiter.timer);
  activeFullArchives = 0;
  fullArchiveDownloads.clear();
}

export const __fullArchiveQueueLimitsForTest = {
  maxConcurrent: MAX_CONCURRENT_FULL_ARCHIVES,
  maxWaiters: MAX_FULL_ARCHIVE_WAITERS,
  queueTimeoutMs: FULL_ARCHIVE_QUEUE_TIMEOUT_MS,
} as const;

async function extractFromFullArchive<T>(
  beatmapsetId: string,
  maxArchiveBytes: number,
  label: string,
  extract: (archive: ArrayBuffer) => T,
): Promise<T> {
  const skipSources = new Set<ArchiveSourceName>();
  const errors: string[] = [];

  for (let attempt = 0; attempt < MAX_FULL_ARCHIVE_ATTEMPTS; attempt++) {
    let archive: FullArchive;
    try {
      archive = await getFullArchive(beatmapsetId, maxArchiveBytes, skipSources);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      break;
    }

    try {
      return extract(archive.buffer);
    } catch (error) {
      // The download itself was fine, so a stale mirror missing a recent diff
      // can still be worked around by pulling another copy.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${archive.source}: ${message}`);
      skipSources.add(archive.source);
    }
  }

  throw new Error(`${label} for beatmapset ${beatmapsetId} (${errors.join("; ")})`);
}

export async function extractBeatmapArchiveFile(
  beatmapsetId: string,
  filename: string,
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
): Promise<Buffer> {
  try {
    return await extractArchiveFileByRange(beatmapsetId, filename);
  } catch {
    // Mirrors do not all support HTTP range requests. Fall back to a full
    // archive fetch, but still extract only the requested audio file.
  }

  return extractFromFullArchive(
    beatmapsetId,
    maxArchiveBytes,
    "Archive fetch failed",
    (archive) => extractEntryFromZipBuffer(archive, filename),
  );
}

export async function extractBeatmapOsuFileFromArchive(
  beatmapsetId: string,
  beatmapId: number,
  hints?: { version?: string | null },
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
): Promise<BeatmapArchiveOsuFile> {
  try {
    return await extractBeatmapOsuFileByRange(beatmapsetId, beatmapId, hints);
  } catch {
    // Some mirrors do not support range reads, and some redirect routes need a
    // plain archive request. Fall back to a guarded full-archive fetch.
  }

  return extractFromFullArchive(
    beatmapsetId,
    maxArchiveBytes,
    "Archive .osu fetch failed",
    (archive) => findBeatmapOsuFileInArchiveBuffer(archive, beatmapId, hints),
  );
}

// Hitsound extraction: every hitsound-sized audio file in the archive, for
// the replay viewer's keysound/custom-sample playback.

export interface BeatmapArchiveHitsoundFile {
  path: string;
  data: Buffer;
}

const HITSOUND_FILE_EXTENSIONS = [".wav", ".ogg", ".mp3"] as const;
const MAX_HITSOUND_FILE_BYTES = Math.round(1.5 * 1024 * 1024);
const DEFAULT_MAX_HITSOUND_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_HITSOUND_FILES = 400;
// Above this many files, per-entry range requests cost more than one full
// archive download.
const MAX_HITSOUND_RANGE_EXTRACTIONS = 16;

function getFilenameStem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

// Selects the archive entries worth bundling. `excludeBasename` is the set's
// music filename; it is skipped by stem so `audio.mp3` also excludes
// `audio.ogg`. Smaller files sort first so keysounds survive the caps.
export function selectHitsoundArchiveEntries(
  entries: ZipDirectoryEntry[],
  excludeBasename?: string | null,
  limits: { maxTotalBytes?: number } = {},
): { selected: ZipDirectoryEntry[]; dropped: number } {
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_HITSOUND_TOTAL_BYTES;
  const excludedStem = excludeBasename ? getFilenameStem(excludeBasename) : null;
  const matching = entries.filter((entry) => {
    if (entry.path.endsWith("/") || entry.path.includes("..")) return false;
    const lower = entry.path.toLowerCase();
    if (!HITSOUND_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
    if (entry.uncompressedSize <= 0 || entry.uncompressedSize > MAX_HITSOUND_FILE_BYTES) return false;
    if (entry.compressedSize > MAX_HITSOUND_FILE_BYTES) return false;
    if ((entry.flags & 0x1) !== 0) return false;
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) return false;
    if (excludedStem && getFilenameStem(entry.path) === excludedStem) return false;
    return true;
  });

  matching.sort((left, right) => left.uncompressedSize - right.uncompressedSize || left.path.localeCompare(right.path));

  const selected: ZipDirectoryEntry[] = [];
  let totalBytes = 0;
  for (const entry of matching) {
    if (selected.length >= MAX_HITSOUND_FILES) break;
    if (totalBytes + entry.uncompressedSize > maxTotalBytes) break;
    selected.push(entry);
    totalBytes += entry.uncompressedSize;
  }
  return { selected, dropped: matching.length - selected.length };
}

async function extractHitsoundsByRange(
  beatmapsetId: string,
  excludeBasename: string | null,
  maxTotalBytes: number,
): Promise<{ files: BeatmapArchiveHitsoundFile[]; dropped: number }> {
  const errors: string[] = [];
  for (const source of getArchiveSourceOrder()) {
    if (isArchiveSourceCoolingDown(source.name)) {
      errors.push(`${source.name}: cooling down`);
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
    try {
      return await withArchiveSourceSlot(source.name, controller.signal, async () => {
        const rangeUrl = await resolveArchiveRangeUrl(source, beatmapsetId, controller.signal);
        const entries = await readZipDirectoryEntriesByRangeFromUrl(rangeUrl, controller.signal);
        const { selected, dropped } = selectHitsoundArchiveEntries(entries, excludeBasename, { maxTotalBytes });
        if (selected.length === 0) return { files: [], dropped };
        if (selected.length > MAX_HITSOUND_RANGE_EXTRACTIONS) {
          throw new Error(`too many hitsound files for range extraction (${selected.length})`);
        }
        const files: BeatmapArchiveHitsoundFile[] = [];
        for (const entry of selected) {
          files.push({
            path: entry.path.replace(/\\/g, "/"),
            data: await extractZipEntryByRangeFromUrl(rangeUrl, entry, controller.signal, entry.path, MAX_HITSOUND_FILE_BYTES),
          });
        }
        return { files, dropped };
      });
    } catch (error) {
      if (shouldCooldownArchiveError(error)) cooldownArchiveSource(source.name);
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Archive hitsound range extraction failed for beatmapset ${beatmapsetId} (${errors.join("; ")})`);
}

function extractHitsoundsFromArchiveBuffer(
  archiveBuffer: ArrayBuffer,
  excludeBasename: string | null,
  maxTotalBytes: number,
): { files: BeatmapArchiveHitsoundFile[]; dropped: number } {
  const { selected, dropped } = selectHitsoundArchiveEntries(
    readZipDirectoryEntriesFromBuffer(archiveBuffer),
    excludeBasename,
    { maxTotalBytes },
  );
  const files: BeatmapArchiveHitsoundFile[] = [];
  let failed = 0;
  for (const entry of selected) {
    try {
      files.push({
        path: entry.path.replace(/\\/g, "/"),
        data: extractZipEntryFromBuffer(archiveBuffer, entry, entry.path, MAX_HITSOUND_FILE_BYTES),
      });
    } catch {
      failed++;
    }
  }
  return { files, dropped: dropped + failed };
}

export async function extractBeatmapArchiveHitsounds(
  beatmapsetId: string,
  options: { excludeBasename?: string | null; maxTotalBytes?: number; maxArchiveBytes?: number } = {},
): Promise<{ files: BeatmapArchiveHitsoundFile[]; dropped: number }> {
  const excludeBasename = options.excludeBasename ?? null;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_HITSOUND_TOTAL_BYTES;
  try {
    return await extractHitsoundsByRange(beatmapsetId, excludeBasename, maxTotalBytes);
  } catch {
    // Mirrors without range support (or keysounded maps with many files) go
    // through a single guarded full-archive fetch instead.
  }

  return extractFromFullArchive(
    beatmapsetId,
    options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    "Archive hitsound fetch failed",
    (archive) => extractHitsoundsFromArchiveBuffer(archive, excludeBasename, maxTotalBytes),
  );
}
