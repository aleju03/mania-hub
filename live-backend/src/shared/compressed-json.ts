// Transparent gzip for large JSON columns. SQLite stores whatever type it is
// handed, so a TEXT-declared column can hold a gzipped BLOB alongside legacy
// plain-text rows — packJson writes the compressed form, unpackJson reads
// either (the gzip magic bytes identify compressed cells). The osu! score
// JSON these columns hold is extremely repetitive (the same long key names
// hundreds of times per row), so this compresses ~6-10x with zero information
// loss. Sync zlib is deliberate: the payloads are hundreds of KB at most, a
// few ms on the event loop, in paths that already did an osu! API roundtrip.
import { gunzipSync, gzipSync } from "node:zlib";
import { parseJson } from "../db.js";

export function packJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value ?? null), "utf8"));
}

export function unpackJson<T>(cell: unknown, fallback: T): T {
  if (typeof cell === "string") return parseJson(cell, fallback);
  const buffer = toBuffer(cell);
  if (!buffer) return fallback;
  try {
    const text = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
      ? gunzipSync(buffer).toString("utf8")
      : buffer.toString("utf8");
    return parseJson(text, fallback);
  } catch {
    return fallback;
  }
}

function toBuffer(cell: unknown): Buffer | null {
  if (cell instanceof Uint8Array) return Buffer.from(cell.buffer, cell.byteOffset, cell.byteLength);
  if (cell instanceof ArrayBuffer) return Buffer.from(cell);
  return null;
}
