import { createHash } from "node:crypto";
import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { SCORE_DICTIONARY_V1 } from "./score-dict-v1.js";

export const SCORE_DICTIONARY_VERSION = 1;
export const SCORE_DICTIONARY_SHA256 = "ad50b21f1fca86eb99c200e16dc4d81ca6e8f4b8b20db4fb499341bc428ddfe8";
const dictionary = Buffer.from(SCORE_DICTIONARY_V1, "utf8");
if (createHash("sha256").update(dictionary).digest("hex") !== SCORE_DICTIONARY_SHA256) {
  throw new Error("Frozen score dictionary checksum mismatch");
}
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function scoreDictionaryBytes(): Buffer {
  return Buffer.from(dictionary);
}

export function jsonCellBuffer(cell: unknown): Buffer | null {
  if (cell instanceof Uint8Array) return Buffer.from(cell.buffer, cell.byteOffset, cell.byteLength);
  if (cell instanceof ArrayBuffer) return Buffer.from(cell);
  return null;
}

/** Keep the original UTF-8 bytes, including whitespace and numeric spelling. */
export function packDictJsonText(text: string): Buffer {
  JSON.parse(text);
  return Buffer.concat([Buffer.from([0, SCORE_DICTIONARY_VERSION]), deflateSync(Buffer.from(text, "utf8"), { dictionary })]);
}

export function packDictJson(value: unknown): Buffer {
  return packDictJsonText(JSON.stringify(value ?? null));
}

export function unpackDictJsonText(cell: Uint8Array): string {
  if (cell[0] !== 0 || cell[1] !== SCORE_DICTIONARY_VERSION) {
    throw new Error(`Unknown score JSON format/version: ${cell[0]}/${cell[1]}`);
  }
  const input = cell.subarray(2);
  // zlib checks the dictionary identifier and uncompressed Adler-32 checksum.
  // bytesWritten is input consumed: reject trailing garbage/concatenated streams.
  const result = inflateSync(input, { dictionary, info: true } as Parameters<typeof inflateSync>[1]) as unknown as {
    buffer: Buffer; engine: { bytesWritten: number };
  };
  if (result.engine.bytesWritten !== input.length) throw new Error("Trailing bytes in score JSON stream");
  const text = utf8.decode(result.buffer);
  JSON.parse(text);
  return text;
}

/** Strict maintenance reader: never turn corrupt data into a persisted fallback. */
export function readJsonTextStrict(cell: unknown): string {
  let text: string;
  if (typeof cell === "string") text = cell;
  else {
    const bytes = jsonCellBuffer(cell);
    if (!bytes) throw new Error("Expected a JSON text or blob cell");
    if (bytes[0] === 0) return unpackDictJsonText(bytes);
    text = utf8.decode(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
  }
  JSON.parse(text);
  return text;
}
