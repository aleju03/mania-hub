// Transparent gzip for large JSON columns. SQLite stores whatever type it is
// handed, so a TEXT-declared column can hold a gzipped BLOB alongside legacy
// plain-text rows — packJson writes gzip, unpackJson also accepts the frozen
// dictionary format used by individual scores. Dictionary errors are strict;
// legacy text/gzip retains its existing fallback behavior. The osu! score
// JSON these columns hold is extremely repetitive (the same long key names
// hundreds of times per row), so this compresses ~6-10x with zero information
// loss. Sync zlib is deliberate: the payloads are hundreds of KB at most, a
// few ms on the event loop, in paths that already did an osu! API roundtrip.
import { gunzipSync, gzipSync } from "node:zlib";
import { jsonCellBuffer, unpackDictJsonText } from "./dict-json.js";
import { parseJson } from "../db.js";

export function packJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value ?? null), "utf8"));
}

export function unpackJson<T>(cell: unknown, fallback: T): T {
  if (typeof cell === "string") return parseJson(cell, fallback);
  const buffer = jsonCellBuffer(cell);
  if (!buffer) return fallback;
  // Dictionary cells are durable score evidence; corruption must propagate.
  if (buffer[0] === 0) return JSON.parse(unpackDictJsonText(buffer)) as T;
  const gzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  // A damaged dictionary marker must not turn its binary cell into a legacy
  // fallback. JSON text cannot contain these unescaped control bytes.
  if (!gzip && buffer.some((byte) => byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13)) {
    throw new Error("Unknown binary JSON format");
  }
  try {
    const text = gzip
      ? gunzipSync(buffer).toString("utf8")
      : buffer.toString("utf8");
    return parseJson(text, fallback);
  } catch {
    return fallback;
  }
}
