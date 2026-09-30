import { decodeLzma } from "#replay-judge/lzma.ts";
import type { ServerReplay } from "./replay-types";
import { decodeStableManiaReplayFrames, getStableManiaReplayScrollSpeedScale, type RawReplayFrameLike } from "./replay-frames";
import type { ReplayLifeBarFrame } from "./types";

// Reads an .osr into the viewer's replay shape. It mirrors osu-parsers'
// ScoreDecoder field for field (including where a malformed file stops being
// read), but decodes the LZMA frame stream with the shared decoder, which is
// ~18x faster than the lzma-js package osu-parsers uses.

/** Replay version from which lazer writes the trailing score info block. */
const LAZER_SCORE_INFO_VERSION = 30000001;
// The score info blob is a handful of fields, so kilobytes even for a
// marathon; the caps only stop a crafted tail from expanding without limit.
const MAX_SCORE_INFO_COMPRESSED_BYTES = 512 * 1024;
const MAX_SCORE_INFO_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_DATA_BYTES = 512 * 1024 * 1024;
const MAX_COORDINATE_VALUE = 131072;
const MAX_PARSE_VALUE = 2147483647;

export interface OsrReplay {
  replay: ServerReplay;
  /** Input frames in the file before mania decoding. */
  rawFrameCount: number;
  /** The online score id, or 0 when the file carries none. */
  scoreId: number;
  /** Lazer's LZMA-compressed score info JSON, or null for a stable replay. */
  scoreInfoBlock: Uint8Array | null;
}

class OsrReader {
  pos = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  byte(): number {
    return this.view.getUint8(this.pos++);
  }

  uint16(): number {
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  int32(): number {
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  }

  int64(): number {
    const value = Number(this.view.getBigInt64(this.pos, true));
    this.pos += 8;
    return value;
  }

  /** Like osu-parsers, a run past the end reads as what is there. */
  bytesOf(length: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /** 0x0b + ULEB128 length + utf8; any other marker reads as "" with nothing after it. */
  string(): string {
    if (this.byte() !== 0x0b) return "";
    let length = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.byte();
      length |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return length > 0 ? new TextDecoder().decode(this.bytesOf(length)) : "";
  }
}

// osu-parsers' Parsing.parseFloat/parseInt: NaN or out-of-range fails the file.
function checked(value: number, limit = MAX_PARSE_VALUE): number {
  if (Number.isNaN(value) || value < -limit || value > limit) throw new Error("Malformed replay frame.");
  return value;
}

// A field of text[start, end) as parseFloat/parseInt would read it. Plain
// integers, which is nearly every field, skip the substring and the parse.
function field(text: string, start: number, end: number, int: boolean): number {
  let i = start;
  const negative = text.charCodeAt(i) === 45;
  if (negative) i++;
  if (i < end && end - i <= 15) {
    let value = 0;
    for (; i < end; i++) {
      const digit = text.charCodeAt(i) - 48;
      if (digit < 0 || digit > 9) break;
      value = value * 10 + digit;
    }
    if (i === end) return negative ? -value : value;
  }
  const raw = text.slice(start, end);
  return int ? parseInt(raw) : parseFloat(raw);
}

// Scans "interval|x|y|keys,..." in place; the same result as splitting on
// "," and "|", which costs an array per frame.
function decodeRawFrames(text: string): RawReplayFrameLike[] {
  const frames: RawReplayFrameLike[] = [];
  let lastTime = 0;
  for (let start = 0, index = 0; ; index++) {
    let end = text.indexOf(",", start);
    if (end < 0) end = text.length;
    const p1 = text.indexOf("|", start);
    const p2 = p1 < 0 || p1 >= end ? -1 : text.indexOf("|", p1 + 1);
    const p3 = p2 < 0 || p2 >= end ? -1 : text.indexOf("|", p2 + 1);
    // Fewer than four fields, or the "-12345" RNG seed entry.
    if (p3 >= 0 && p3 < end && !(p1 - start === 6 && text.startsWith("-12345", start))) {
      let p4 = text.indexOf("|", p3 + 1);
      if (p4 < 0 || p4 > end) p4 = end;
      const interval = checked(field(text, start, p1, false));
      const mouseX = checked(field(text, p1 + 1, p2, false), MAX_COORDINATE_VALUE);
      const mouseY = checked(field(text, p2 + 1, p3, false), MAX_COORDINATE_VALUE);
      const buttonState = checked(field(text, p3 + 1, p4, true));
      // Skipped frames still advance the clock.
      lastTime += interval;
      if (!(index < 2 && mouseX === 256 && mouseY === -500) && interval >= 0) {
        frames.push({ startTime: lastTime, mouseX, mouseY, buttonState });
      }
    }
    if (end === text.length) break;
    start = end + 1;
  }
  return frames;
}

function decodeLifeBar(text: string): ReplayLifeBarFrame[] {
  const frames: ReplayLifeBarFrame[] = [];
  for (const entry of text.split(",")) {
    if (!entry) continue;
    const fields = entry.split("|");
    if (fields.length < 2) continue;
    frames.push({ time: checked(parseInt(fields[0])), health: checked(parseFloat(fields[1])) });
  }
  return frames;
}

export function readOsr(source: ArrayBuffer | Uint8Array): OsrReplay {
  const reader = new OsrReader(source instanceof Uint8Array ? source : new Uint8Array(source));
  const header: ServerReplay["header"] = {
    playerName: "", gameMode: 0, beatmapHash: "", modsUsed: 0, totalScore: 0, maxCombo: 0,
    count300: 0, count100: 0, count50: 0, countGeki: 0, countKatu: 0, countMiss: 0, isPerfect: false,
  };
  let rawFrames: RawReplayFrameLike[] = [];
  let lifeBar: ReplayLifeBarFrame[] = [];
  let scoreId = 0;
  let scoreInfoBlock: Uint8Array | null = null;

  let gameVersion = 0;
  let lifeBarText = "";
  let frameData: Uint8Array | null = null;
  let fileScoreId = 0;
  // Like osu-parsers, a file that breaks partway keeps whatever was read.
  try {
    header.gameMode = reader.byte();
    gameVersion = reader.int32();
    header.beatmapHash = reader.string();
    header.playerName = reader.string();
    reader.string(); // replay hash
    header.count300 = reader.uint16();
    header.count100 = reader.uint16();
    header.count50 = reader.uint16();
    header.countGeki = reader.uint16();
    header.countKatu = reader.uint16();
    header.countMiss = reader.uint16();
    header.totalScore = reader.int32();
    header.maxCombo = reader.uint16();
    header.isPerfect = reader.byte() !== 0;
    header.modsUsed = reader.int32() || 0;
    lifeBarText = reader.string();
    reader.pos += 8; // timestamp
    frameData = reader.bytesOf(reader.int32());
    if (gameVersion >= 20140721) fileScoreId = reader.int64();
    else if (gameVersion >= 20121008) fileScoreId = reader.int32();
    if (gameVersion >= LAZER_SCORE_INFO_VERSION) {
      const length = reader.int32();
      if (length > 0 && length <= MAX_SCORE_INFO_COMPRESSED_BYTES) scoreInfoBlock = reader.bytesOf(length);
    }
  } catch {
    // Keep what was read.
  }

  // osu-parsers reads the score id only once the frames decoded cleanly.
  let framesDecoded = frameData != null;
  if (frameData && frameData.length > 0) {
    framesDecoded = false;
    header.gameVersion = gameVersion || undefined;
    try {
      const text = new TextDecoder().decode(decodeLzma(frameData, { maxOutputBytes: MAX_FRAME_DATA_BYTES }));
      rawFrames = decodeRawFrames(text);
      lifeBar = decodeLifeBar(lifeBarText);
      framesDecoded = true;
    } catch {
      // Keep what was decoded.
    }
  }
  if (framesDecoded) scoreId = fileScoreId;

  const frames = decodeStableManiaReplayFrames(rawFrames);
  let pressedBits = 0;
  for (const frame of frames) pressedBits |= frame.keyState;

  return {
    replay: {
      header,
      frames,
      lifeBarFrames: lifeBar
        .map((frame) => ({ time: Math.round(frame.time), health: Math.max(0, Math.min(1, frame.health)) }))
        .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.health))
        .sort((a, b) => a.time - b.time),
      // The highest column pressed; callers that know the chart's key count use that.
      keyCount: Math.max(4, 32 - Math.clz32(pressedBits)),
      stableScrollSpeedScale: getStableManiaReplayScrollSpeedScale(rawFrames) ?? undefined,
    },
    rawFrameCount: rawFrames.length,
    scoreId,
    scoreInfoBlock,
  };
}

/** Lazer's score info JSON, or null when it is missing or unreadable. */
export function readLazerScoreInfo(block: Uint8Array | null): unknown {
  if (!block) return null;
  try {
    const json = new TextDecoder().decode(decodeLzma(block, { maxOutputBytes: MAX_SCORE_INFO_DECOMPRESSED_BYTES }));
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
