// Disk snapshot of the packed GLOBAL farmed board (B2). Rebuilding the board
// from global_maps_farmed_scores costs ~20-25s on prod (19k entries, 1.5M
// player rows), so every pack writes the typed-array columns to a sibling file
// of the SQLite database and a cold process patches that snapshot forward with
// projection deltas instead of repacking from scratch.
//
// This file is a cache, never a source of truth: it is safe to delete at any
// time, it is validated against the projection state (generation carries the
// seed epoch; the revision must not be ahead of the database), and any
// mismatch or corruption invalidates it (best-effort unlink) and falls back to
// a full pack.
//
// Layout (little endian, host byte order for the array sections; the file is
// only ever read back on the machine that wrote it):
//   bytes 0..3    magic "MHFB"
//   bytes 4..7    uint32 format version
//   bytes 8..11   uint32 header JSON byte length
//   header JSON   generation/stamps/revision/counts + small JSON-friendly
//                 columns (mods dictionary, score-url overrides)
//   sections      entryBeatmapIds f64[E], entryStarts u32[E], entryCounts
//                 u32[E], userIds f64[N], pps f64[N], modsIdx u32[N],
//                 playedAtMs f64[N], scoreIds f64[N], modsFlags u8[D],
//                 metadata JSON (byte length in header)
// Sections are written as views over the live typed arrays and read straight
// into freshly allocated ones, so neither direction holds a second full copy
// of the board beyond the arrays themselves.
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { threadId } from "node:worker_threads";
import type { GlobalFarmedBoardEntry, MapsFarmedPageMetadata } from "./maps.js";

export const GLOBAL_FARMED_BOARD_DISK_FORMAT_VERSION = 1;

const MAGIC = Buffer.from("MHFB", "ascii");
const PREFIX_BYTES = 12;

export interface PersistedGlobalFarmedBoard {
  generation: string;
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
  projectionRevision: number;
  entries: GlobalFarmedBoardEntry[];
  userIds: Float64Array;
  pps: Float64Array;
  modsIdx: Uint32Array;
  playedAtMs: Float64Array;
  scoreIds: Float64Array;
  scoreUrlOverrides: Map<number, string>;
  modsDict: string[][];
  modsFlags: Uint8Array;
  metadata: Map<number, MapsFarmedPageMetadata>;
}

interface DiskHeader {
  generation: string;
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
  projectionRevision: number;
  entryCount: number;
  playerCount: number;
  modsDict: string[][];
  scoreUrlOverrides: Array<[number, string]>;
  metadataBytes: number;
}

export async function saveGlobalFarmedBoardToDisk(filePath: string, board: PersistedGlobalFarmedBoard): Promise<void> {
  const header: DiskHeader = {
    generation: board.generation,
    generatedAt: board.generatedAt,
    farmedGeneratedAt: board.farmedGeneratedAt,
    favouritesGeneratedAt: board.favouritesGeneratedAt,
    projectionRevision: board.projectionRevision,
    entryCount: board.entries.length,
    playerCount: board.userIds.length,
    modsDict: board.modsDict,
    scoreUrlOverrides: [...board.scoreUrlOverrides.entries()],
    metadataBytes: 0,
  };
  const metadataBuf = Buffer.from(JSON.stringify([...board.metadata.values()]), "utf8");
  header.metadataBytes = metadataBuf.byteLength;
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");

  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(GLOBAL_FARMED_BOARD_DISK_FORMAT_VERSION, 4);
  prefix.writeUInt32LE(headerBuf.byteLength, 8);

  const entryBeatmapIds = new Float64Array(board.entries.length);
  const entryStarts = new Uint32Array(board.entries.length);
  const entryCounts = new Uint32Array(board.entries.length);
  for (let i = 0; i < board.entries.length; i++) {
    entryBeatmapIds[i] = board.entries[i].beatmapId;
    entryStarts[i] = board.entries[i].start;
    entryCounts[i] = board.entries[i].count;
  }

  const chunks: Buffer[] = [
    prefix,
    headerBuf,
    bufferView(entryBeatmapIds),
    bufferView(entryStarts),
    bufferView(entryCounts),
    bufferView(board.userIds),
    bufferView(board.pps),
    bufferView(board.modsIdx),
    bufferView(board.playedAtMs),
    bufferView(board.scoreIds),
    bufferView(board.modsFlags),
    metadataBuf,
  ];

  await mkdir(dirname(filePath), { recursive: true });
  // Write to a temp sibling and rename so a crash mid-write can never leave a
  // truncated file at the real path (loads would reject it anyway, but the
  // rename keeps the previous good snapshot serving until the new one lands).
  // The temp name carries pid + threadId: the worker process, the serving
  // process's cold-boot fallback, and the maps snapshot thread can all write
  // this file, and two writers sharing one temp path would interleave into a
  // corrupt rename. Concurrent renames are safe (last one wins atomically).
  const tmpPath = `${filePath}.tmp-${process.pid}-${threadId}`;
  try {
    const handle = await open(tmpPath, "w");
    try {
      for (const chunk of chunks) {
        if (chunk.byteLength > 0) await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    // The per-pid temp name means nothing else will ever reclaim it; a failed
    // write (disk full, I/O error) must not leak ~60MB per attempt.
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Loads and validates a persisted board. Returns null (and best-effort deletes
 * the file) whenever it cannot be trusted: unknown format version, generation
 * (seed epoch) mismatch, a revision ahead of the database (a restored backup),
 * or any structural inconsistency.
 */
export async function loadGlobalFarmedBoardFromDisk(
  filePath: string,
  expected: { generation: string; maxRevision: number },
): Promise<PersistedGlobalFarmedBoard | null> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const prefix = Buffer.alloc(PREFIX_BYTES);
    await readExact(handle, prefix, 0);
    if (!prefix.subarray(0, 4).equals(MAGIC)) return await invalidate(filePath);
    if (prefix.readUInt32LE(4) !== GLOBAL_FARMED_BOARD_DISK_FORMAT_VERSION) return await invalidate(filePath);
    const headerBytes = prefix.readUInt32LE(8);
    if (headerBytes <= 0 || headerBytes > 64 * 1024 * 1024) return await invalidate(filePath);

    const headerBuf = Buffer.alloc(headerBytes);
    await readExact(handle, headerBuf, PREFIX_BYTES);
    const header = JSON.parse(headerBuf.toString("utf8")) as Partial<DiskHeader>;
    if (
      typeof header.generation !== "string"
      || typeof header.generatedAt !== "string"
      || typeof header.farmedGeneratedAt !== "string"
      || typeof header.favouritesGeneratedAt !== "string"
      || !isCount(header.projectionRevision)
      || !isCount(header.entryCount)
      || !isCount(header.playerCount)
      || !isCount(header.metadataBytes)
      || !Array.isArray(header.modsDict)
      || !Array.isArray(header.scoreUrlOverrides)
    ) {
      return await invalidate(filePath);
    }
    if (header.generation !== expected.generation) return await invalidate(filePath);
    if (header.projectionRevision > expected.maxRevision) return await invalidate(filePath);

    const entryCount = header.entryCount;
    const playerCount = header.playerCount;
    const dictCount = header.modsDict.length;
    const entryBeatmapIds = new Float64Array(entryCount);
    const entryStarts = new Uint32Array(entryCount);
    const entryCounts = new Uint32Array(entryCount);
    const userIds = new Float64Array(playerCount);
    const pps = new Float64Array(playerCount);
    const modsIdx = new Uint32Array(playerCount);
    const playedAtMs = new Float64Array(playerCount);
    const scoreIds = new Float64Array(playerCount);
    const modsFlags = new Uint8Array(dictCount);
    const metadataBuf = Buffer.alloc(header.metadataBytes);

    let offset = PREFIX_BYTES + headerBytes;
    for (const section of [
      bufferView(entryBeatmapIds),
      bufferView(entryStarts),
      bufferView(entryCounts),
      bufferView(userIds),
      bufferView(pps),
      bufferView(modsIdx),
      bufferView(playedAtMs),
      bufferView(scoreIds),
      bufferView(modsFlags),
      metadataBuf,
    ]) {
      await readExact(handle, section, offset);
      offset += section.byteLength;
    }
    // The file must end exactly where the sections do; anything else means a
    // writer/reader disagreement this loader is not equipped to interpret.
    if ((await handle.stat()).size !== offset) return await invalidate(filePath);

    const entries: GlobalFarmedBoardEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
      const beatmapId = entryBeatmapIds[i];
      const start = entryStarts[i];
      const count = entryCounts[i];
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0 || start + count > playerCount) {
        return await invalidate(filePath);
      }
      entries.push({ beatmapId, start, count });
    }
    for (let i = 0; i < playerCount; i++) {
      if (modsIdx[i] >= dictCount) return await invalidate(filePath);
    }

    const metadataValues = JSON.parse(metadataBuf.toString("utf8")) as MapsFarmedPageMetadata[];
    if (!Array.isArray(metadataValues)) return await invalidate(filePath);
    const metadata = new Map<number, MapsFarmedPageMetadata>();
    for (const value of metadataValues) {
      if (!value || !Number.isSafeInteger(value.beatmapId)) return await invalidate(filePath);
      metadata.set(value.beatmapId, value);
    }

    const scoreUrlOverrides = new Map<number, string>();
    for (const pair of header.scoreUrlOverrides) {
      if (!Array.isArray(pair) || !Number.isSafeInteger(pair[0]) || typeof pair[1] !== "string") {
        return await invalidate(filePath);
      }
      scoreUrlOverrides.set(pair[0], pair[1]);
    }
    const modsDict = header.modsDict.map((mods) => (Array.isArray(mods) ? mods.map(String) : []));

    return {
      generation: header.generation,
      generatedAt: header.generatedAt,
      farmedGeneratedAt: header.farmedGeneratedAt,
      favouritesGeneratedAt: header.favouritesGeneratedAt,
      projectionRevision: header.projectionRevision,
      entries,
      userIds,
      pps,
      modsIdx,
      playedAtMs,
      scoreIds,
      scoreUrlOverrides,
      modsDict,
      modsFlags,
      metadata,
    };
  } catch {
    return invalidate(filePath);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface GlobalFarmedBoardDiskHeaderPeek {
  generation: string;
  projectionRevision: number;
}

/**
 * Reads only the 12-byte prefix and header JSON — cheap enough to poll — so a
 * process waiting on a worker-side repack can tell whether the snapshot on
 * disk is newer than its resident board without paying the full ~60MB load.
 * Returns null on any structural problem but never deletes the file: a peek
 * racing an in-flight writer must not destroy the snapshot the full loader
 * would happily read a moment later.
 */
export async function readGlobalFarmedBoardDiskHeader(filePath: string): Promise<GlobalFarmedBoardDiskHeaderPeek | null> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const prefix = Buffer.alloc(PREFIX_BYTES);
    await readExact(handle, prefix, 0);
    if (!prefix.subarray(0, 4).equals(MAGIC)) return null;
    if (prefix.readUInt32LE(4) !== GLOBAL_FARMED_BOARD_DISK_FORMAT_VERSION) return null;
    const headerBytes = prefix.readUInt32LE(8);
    if (headerBytes <= 0 || headerBytes > 64 * 1024 * 1024) return null;
    const headerBuf = Buffer.alloc(headerBytes);
    await readExact(handle, headerBuf, PREFIX_BYTES);
    const header = JSON.parse(headerBuf.toString("utf8")) as Partial<DiskHeader>;
    if (typeof header.generation !== "string" || !isCount(header.projectionRevision)) return null;
    return { generation: header.generation, projectionRevision: header.projectionRevision };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Zero-copy Buffer view over a typed array's bytes.
function bufferView(array: Float64Array | Uint32Array | Uint8Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

async function readExact(handle: FileHandle, target: Buffer, position: number): Promise<void> {
  let filled = 0;
  while (filled < target.byteLength) {
    const { bytesRead } = await handle.read(target, filled, target.byteLength - filled, position + filled);
    if (bytesRead <= 0) throw new Error("unexpected end of file");
    filled += bytesRead;
  }
}

async function invalidate(filePath: string): Promise<null> {
  await unlink(filePath).catch(() => undefined);
  return null;
}
