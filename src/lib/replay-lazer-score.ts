import type { OsuMod } from "./types";

// osu!lazer appends a second, richer copy of the score to the end of a .osr: an
// LZMA-compressed `LegacyReplaySoloScoreInfo` JSON blob sitting after the online
// score id. Everything lazer-only lives there, because the legacy header can
// only carry stable's 32-bit mod bitfield - which has no room for mod settings
// (a custom rate "DT at 1.1x" reads back as plain DT, so the viewer runs the
// chart at 1.5x) and no bit at all for mods stable never had, like DA. Uploads
// decode through osu-parsers, which stops reading at the online score id, so
// this walks the header itself to reach the block.

/** Replay version from which lazer writes the trailing score info block. */
const LAZER_SCORE_INFO_VERSION = 30000001;
// The blob is a fixed handful of fields - mods, per-judgement counts, a client
// version string - so it is kilobytes even for a marathon. These caps only
// exist so a crafted tail can't expand without limit: upload validation budgets
// the frame blob's declared size, and nothing there covers this one.
const MAX_SCORE_INFO_COMPRESSED_BYTES = 512 * 1024;
const MAX_SCORE_INFO_DECOMPRESSED_BYTES = 4 * 1024 * 1024;

class OsrTailReader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private take(length: number): number {
    if (length < 0 || this.pos + length > this.bytes.length) {
      throw new Error("Replay ended early.");
    }
    const offset = this.pos;
    this.pos += length;
    return offset;
  }

  skip(length: number): void {
    this.take(length);
  }

  byte(): number {
    return this.view.getUint8(this.take(1));
  }

  int32(): number {
    return this.view.getInt32(this.take(4), true);
  }

  /** osu! string: 0x00 (absent) or 0x0b + ULEB128 byte length + utf8 bytes. */
  skipString(): void {
    const marker = this.byte();
    if (marker === 0x00) return;
    if (marker !== 0x0b) throw new Error("Malformed replay string.");
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = this.byte();
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error("Malformed replay string.");
    }
    this.take(length);
  }

  slice(length: number): Uint8Array {
    const offset = this.take(length);
    return this.bytes.subarray(offset, offset + length);
  }
}

/** The compressed score info blob, or null when this replay carries none. */
function findScoreInfoBlock(bytes: Uint8Array): Uint8Array | null {
  const reader = new OsrTailReader(bytes);
  reader.skip(1); // ruleset id
  if (reader.int32() < LAZER_SCORE_INFO_VERSION) return null; // stable replay
  reader.skipString(); // beatmap hash
  reader.skipString(); // player name
  reader.skipString(); // replay hash
  // 300/100/50/geki/katu/miss, total score, max combo, perfect, mod bitfield.
  reader.skip(2 * 6 + 4 + 2 + 1 + 4);
  reader.skipString(); // life bar graph
  reader.skip(8); // timestamp
  reader.skip(reader.int32()); // LZMA-compressed input frames
  // Always a long at this version; the int32 form predates 2014.
  reader.skip(8); // legacy online score id
  const length = reader.int32();
  if (length <= 0 || length > MAX_SCORE_INFO_COMPRESSED_BYTES) return null;
  return reader.slice(length);
}

/** Declared decompressed size from an LZMA-alone header (5 property bytes then
 *  a uint64 size), or null when the encoder wrote the unknown-size marker. */
function readDeclaredSize(compressed: Uint8Array): bigint | null {
  if (compressed.length < 13) return null;
  const view = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  const declared = view.getBigUint64(5, true);
  return declared === 0xffffffffffffffffn ? null : declared;
}

async function decompressLzma(compressed: Uint8Array): Promise<string> {
  const { decompress } = await import("lzma-js-simple-v2");
  return new Promise<string>((resolve, reject) => {
    decompress(compressed, (result, error) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } else if (typeof result === "string") {
        resolve(result);
      } else {
        // Bytes come back signed when the decoder can't read them as text.
        resolve(new TextDecoder().decode(Uint8Array.from(result, (byte) => byte & 0xff)));
      }
    });
  });
}

function toOsuMods(raw: unknown): OsuMod[] | null {
  if (!Array.isArray(raw)) return null;
  const mods: OsuMod[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const acronym = (entry as { acronym?: unknown }).acronym;
    if (typeof acronym !== "string" || !acronym.trim()) continue;
    const settings = (entry as { settings?: unknown }).settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      mods.push({ acronym: acronym.trim() });
      continue;
    }
    const kept: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        kept[key] = value;
      }
    }
    mods.push(Object.keys(kept).length > 0 ? { acronym: acronym.trim(), settings: kept } : { acronym: acronym.trim() });
  }
  return mods;
}

/**
 * The mods a lazer replay recorded, with their settings, or null for a stable
 * replay (or any tail we can't read). An empty array is a real answer: a lazer
 * no-mod play, which the legacy bitfield cannot distinguish from a mod it has
 * no bit for.
 */
export async function readLazerReplayMods(source: ArrayBuffer | Uint8Array): Promise<OsuMod[] | null> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);

  let compressed: Uint8Array | null;
  try {
    compressed = findScoreInfoBlock(bytes);
  } catch {
    // A header we can't walk is not our problem to report: the caller already
    // decoded this replay through osu-parsers and has the bitfield to fall
    // back on.
    return null;
  }
  if (!compressed) return null;

  const declaredSize = readDeclaredSize(compressed);
  if (declaredSize == null || declaredSize > BigInt(MAX_SCORE_INFO_DECOMPRESSED_BYTES)) return null;

  try {
    const parsed = JSON.parse(await decompressLzma(compressed)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return toOsuMods((parsed as { mods?: unknown }).mods);
  } catch {
    return null;
  }
}
