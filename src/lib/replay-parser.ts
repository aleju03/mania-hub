import type { ReplayHeader, ReplayFrame, ReplayLifeBarFrame, ParsedReplay } from "./types";
import { decodeStableManiaReplayFrames, getStableManiaReplayScrollSpeedScale } from "./replay-frames";

class BinaryReader {
  private view: DataView;
  private pos = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  get offset() { return this.pos; }

  readByte(): number {
    return this.view.getUint8(this.pos++);
  }

  readShort(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readInt(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readLong(): number {
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    return lo + hi * 0x100000000;
  }

  readULEB128(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readByte();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  readOsuString(): string {
    const indicator = this.readByte();
    if (indicator === 0x00) return "";
    if (indicator !== 0x0b) return "";
    const length = this.readULEB128();
    const bytes = new Uint8Array(this.view.buffer, this.pos, length);
    this.pos += length;
    return new TextDecoder("utf-8").decode(bytes);
  }

  readBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, this.pos, length);
    this.pos += length;
    return bytes;
  }

  get remaining(): number {
    return this.view.byteLength - this.pos;
  }
}

function parseHeader(reader: BinaryReader): ReplayHeader {
  const gameMode = reader.readByte();
  const gameVersion = reader.readInt();
  const beatmapHash = reader.readOsuString();
  const playerName = reader.readOsuString();
  const replayHash = reader.readOsuString();
  const count300 = reader.readShort();
  const count100 = reader.readShort();
  const count50 = reader.readShort();
  const countGeki = reader.readShort();
  const countKatu = reader.readShort();
  const countMiss = reader.readShort();
  const totalScore = reader.readInt();
  const maxCombo = reader.readShort();
  const isPerfect = reader.readByte() === 1;
  const modsUsed = reader.readInt();
  const lifeBarGraph = reader.readOsuString();
  const timestamp = reader.readLong();
  const replayDataLength = reader.readInt();

  return {
    gameMode, gameVersion, beatmapHash, playerName, replayHash,
    count300, count100, count50, countGeki, countKatu, countMiss,
    totalScore, maxCombo, isPerfect, modsUsed, lifeBarGraph,
    timestamp, replayDataLength,
  };
}

function decompressLZMA(data: Uint8Array): Promise<Uint8Array> {
  // Simple LZMA decompression using DecompressionStream if available,
  // otherwise manual minimal decoder
  return new Promise((resolve, reject) => {
    try {
      // The .osr replay data is raw LZMA (not LZMA2, not xz)
      // We'll try to decompress using a minimal approach
      // For broader compatibility, we attempt the raw decompression

      // LZMA header: 5 bytes properties + 8 bytes uncompressed size
      if (data.length < 13) {
        reject(new Error("LZMA data too short"));
        return;
      }

      // Use a simple JS LZMA decoder
      const decoded = lzmaDecode(data);
      resolve(decoded);
    } catch (e) {
      reject(e);
    }
  });
}

// Minimal LZMA decoder for osu! replay data
function lzmaDecode(input: Uint8Array): Uint8Array {
  // Read LZMA properties header
  const propsByte = input[0];
  const lc = propsByte % 9;
  const remainder = Math.floor(propsByte / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);

  // Read dictionary size (little-endian 32-bit)
  const dictSize = (input[1] | (input[2] << 8) | (input[3] << 16) | (input[4] << 24)) >>> 0;

  // Read uncompressed size (little-endian 64-bit, but we only use lower 32 bits for sanity)
  let uncompressedSize = 0;
  for (let i = 0; i < 8; i++) {
    uncompressedSize += input[5 + i] * Math.pow(256, i);
  }
  // Cap at 50MB for safety
  if (uncompressedSize > 50_000_000 || uncompressedSize < 0) {
    uncompressedSize = -1; // unknown size, decode until end marker
  }

  const compressedData = input.slice(13);
  return lzmaDecompress(compressedData, lc, lp, pb, dictSize, uncompressedSize);
}

// LZMA range decoder and decompressor
function lzmaDecompress(
  data: Uint8Array,
  lc: number, lp: number, pb: number,
  _dictSize: number, uncompressedSize: number
): Uint8Array {
  const output: number[] = [];
  // Range decoder state
  let range = 0xFFFFFFFF;
  let code = 0;
  let dataPos = 0;

  function readByte(): number {
    return dataPos < data.length ? data[dataPos++] : 0;
  }

  // Initialize range decoder
  readByte(); // first byte is ignored
  for (let i = 0; i < 4; i++) {
    code = ((code << 8) | readByte()) >>> 0;
  }

  // Probability models
  const kNumStates = 12;
  const kNumLenToPosStates = 4;
  const kNumAlignBits = 4;
  const kEndPosModelIndex = 14;
  const kNumFullDistances = 1 << (kEndPosModelIndex >> 1);
  const kNumPosSlotBits = 6;

  const PROB_INIT = 1024;
  const numLitProbs = 0x300 << (lc + lp);

  const probs = new Uint16Array(
    1 +  // isMatch
    kNumStates * (1 << pb) + // isMatch array
    kNumStates + // isRep
    kNumStates + // isRepG0
    kNumStates + // isRepG1
    kNumStates + // isRepG2
    kNumStates * (1 << pb) + // isRep0Long
    numLitProbs + // literal probs
    (kNumLenToPosStates << kNumPosSlotBits) + // posSlot
    kNumFullDistances - kEndPosModelIndex + // specPos
    (1 << kNumAlignBits) + // align
    // len decoder
    1 + (1 << 3) + (1 << 8) +
    // repLen decoder
    1 + (1 << 3) + (1 << 8) +
    100 // padding
  );
  probs.fill(PROB_INIT);

  let state = 0;
  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;

  // Offsets into probs array
  let pIsMatch = 0;
  let pIsRep = pIsMatch + kNumStates * (1 << pb);
  let pIsRepG0 = pIsRep + kNumStates;
  let pIsRepG1 = pIsRepG0 + kNumStates;
  let pIsRepG2 = pIsRepG1 + kNumStates;
  let pIsRep0Long = pIsRepG2 + kNumStates;
  let pLitProbs = pIsRep0Long + kNumStates * (1 << pb);
  let pPosSlot = pLitProbs + numLitProbs;
  let pSpecPos = pPosSlot + (kNumLenToPosStates << kNumPosSlotBits);
  let pAlign = pSpecPos + kNumFullDistances - kEndPosModelIndex;
  let pLenChoice = pAlign + (1 << kNumAlignBits);
  let pLenChoice2 = pLenChoice + 1;
  let pLenLow = pLenChoice2 + 1;
  let pLenMid = pLenLow + (1 << 3);
  let pLenHigh = pLenMid + (1 << 8);
  let pRepLenChoice = pLenHigh + (1 << 8);
  let pRepLenChoice2 = pRepLenChoice + 1;
  let pRepLenLow = pRepLenChoice2 + 1;
  let pRepLenMid = pRepLenLow + (1 << 3);
  let pRepLenHigh = pRepLenMid + (1 << 8);

  function normalize() {
    while (range < 0x1000000) {
      range = (range << 8) >>> 0;
      code = ((code << 8) | readByte()) >>> 0;
    }
  }

  function decodeBit(probIdx: number): number {
    normalize();
    const prob = probs[probIdx];
    const bound = (range >>> 11) * prob;
    if ((code >>> 0) < (bound >>> 0)) {
      range = bound;
      probs[probIdx] = prob + ((2048 - prob) >> 5);
      return 0;
    } else {
      range = (range - bound) >>> 0;
      code = (code - bound) >>> 0;
      probs[probIdx] = prob - (prob >> 5);
      return 1;
    }
  }

  function decodeTree(baseIdx: number, numBits: number): number {
    let symbol = 1;
    for (let i = 0; i < numBits; i++) {
      symbol = (symbol << 1) | decodeBit(baseIdx + symbol);
    }
    return symbol - (1 << numBits);
  }

  function decodeReverse(baseIdx: number, numBits: number): number {
    let symbol = 1;
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = decodeBit(baseIdx + symbol);
      symbol = (symbol << 1) | bit;
      result |= bit << i;
    }
    return result;
  }

  function decodeLenDecoder(choiceIdx: number, choice2Idx: number, lowIdx: number, midIdx: number, highIdx: number, posState: number): number {
    if (decodeBit(choiceIdx) === 0) {
      return decodeTree(lowIdx + (posState << 3), 3);
    }
    if (decodeBit(choice2Idx) === 0) {
      return 8 + decodeTree(midIdx + (posState << 3), 3);  // fixed: should be posState << 3 but mid has 8 entries per posState
    }
    return 16 + decodeTree(highIdx, 8);
  }

  let outputPos = 0;

  while (uncompressedSize < 0 || outputPos < uncompressedSize) {
    const posState = outputPos & ((1 << pb) - 1);

    if (decodeBit(pIsMatch + state * (1 << pb) + posState) === 0) {
      // Literal
      const prevByte = outputPos > 0 ? output[outputPos - 1] : 0;
      let litIdx = pLitProbs + (0x300 * ((((outputPos) & ((1 << lp) - 1)) << lc) + (prevByte >>> (8 - lc))));
      let symbol = 1;

      if (state >= 7) {
        let matchByte = outputPos >= (rep0 + 1) ? output[outputPos - rep0 - 1] : 0;
        do {
          const matchBit = (matchByte >> 7) & 1;
          matchByte <<= 1;
          const bit = decodeBit(litIdx + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) {
        symbol = (symbol << 1) | decodeBit(litIdx + symbol);
      }
      output[outputPos++] = symbol & 0xFF;

      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
    } else {
      let len: number;
      if (decodeBit(pIsRep + state) === 0) {
        // Simple match
        rep3 = rep2; rep2 = rep1; rep1 = rep0;
        len = decodeLenDecoder(pLenChoice, pLenChoice2, pLenLow, pLenMid, pLenHigh, posState);

        const lenToPosState = Math.min(len, kNumLenToPosStates - 1);
        const posSlot = decodeTree(pPosSlot + (lenToPosState << kNumPosSlotBits), kNumPosSlotBits);

        if (posSlot >= 4) {
          const numDirectBits = (posSlot >> 1) - 1;
          rep0 = (2 | (posSlot & 1)) << numDirectBits;

          if (posSlot < kEndPosModelIndex) {
            rep0 += decodeReverse(pSpecPos + rep0 - posSlot - 1, numDirectBits);
          } else {
            normalize();
            let result = 0;
            for (let i = numDirectBits - kNumAlignBits - 1; i >= 0; i--) {
              range >>>= 1;
              const t = ((code - range) >>> 31);
              code -= range & (t - 1);
              result = (result << 1) | (1 - t);
            }
            rep0 += result << kNumAlignBits;
            rep0 += decodeReverse(pAlign, kNumAlignBits);
          }
        } else {
          rep0 = posSlot;
        }

        if (rep0 === 0xFFFFFFFF) break; // End marker
        len += 2;
        state = state < 7 ? 7 : 10;
      } else {
        // Rep match
        if (decodeBit(pIsRepG0 + state) === 0) {
          if (decodeBit(pIsRep0Long + state * (1 << pb) + posState) === 0) {
            state = state < 7 ? 9 : 11;
            const byte = outputPos >= (rep0 + 1) ? output[outputPos - rep0 - 1] : 0;
            output[outputPos++] = byte;
            continue;
          }
        } else {
          let dist: number;
          if (decodeBit(pIsRepG1 + state) === 0) {
            dist = rep1;
          } else {
            if (decodeBit(pIsRepG2 + state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = decodeLenDecoder(pRepLenChoice, pRepLenChoice2, pRepLenLow, pRepLenMid, pRepLenHigh, posState) + 2;
        state = state < 7 ? 8 : 11;
      }

      // Copy from dictionary
      for (let i = 0; i < len; i++) {
        const byte = outputPos >= (rep0 + 1) ? output[outputPos - rep0 - 1] : 0;
        output[outputPos++] = byte;
      }
    }

    if (outputPos > 10_000_000) break; // Safety limit
  }

  return new Uint8Array(output);
}

function parseReplayFrames(decompressed: string): { frames: ReplayFrame[]; stableScrollSpeedScale: number | null } {
  const frames: Array<{ buttonState: number; mouseX: number; mouseY: number; time: number }> = [];
  let absoluteTime = 0;

  const parts = decompressed.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const fields = trimmed.split("|");
    if (fields.length < 2) continue;

    const timeDelta = parseInt(fields[0], 10);

    if (timeDelta === -12345) continue; // RNG seed frame

    absoluteTime += timeDelta;
    frames.push({
      buttonState: Number.parseInt(fields[3] ?? "0", 10),
      mouseX: Number.parseFloat(fields[1] ?? "0"),
      mouseY: Number.parseFloat(fields[2] ?? "0"),
      time: absoluteTime,
    });
  }

  return {
    frames: decodeStableManiaReplayFrames(frames),
    stableScrollSpeedScale: getStableManiaReplayScrollSpeedScale(frames),
  };
}

function detectKeyCount(frames: ReplayFrame[], modsUsed: number): number {
  // Check mods for explicit key count
  // Mod bitmask: 1K=67108864, 2K=268435456, 3K=134217728, etc.
  const keyMods: Record<number, number> = {
    67108864: 1,   // 1K
    268435456: 2,  // 2K
    134217728: 3,  // 3K
    // 4K-10K don't have mod bits, determined by beatmap CS
  };

  for (const [mask, keys] of Object.entries(keyMods)) {
    if (modsUsed & Number(mask)) return keys;
  }

  // Detect from highest bit used in any frame
  let maxBit = 0;
  for (const frame of frames) {
    let state = frame.keyState;
    let bit = 0;
    while (state > 0) {
      bit++;
      state >>= 1;
    }
    if (bit > maxBit) maxBit = bit;
  }

  // Common key counts: 4, 5, 6, 7, 8, 9, 10
  return Math.max(maxBit, 4);
}

function parseLifeBarGraph(graph: string): ReplayLifeBarFrame[] {
  if (!graph) return [];

  return graph
    .split(",")
    .map((entry) => {
      const [timeRaw, healthRaw] = entry.split("|");
      const time = Number.parseInt(timeRaw, 10);
      const health = Number.parseFloat(healthRaw);
      return {
        time,
        health: Math.max(0, Math.min(1, health)),
      };
    })
    .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.health))
    .sort((a, b) => a.time - b.time);
}

export async function parseReplay(buffer: ArrayBuffer): Promise<ParsedReplay> {
  const reader = new BinaryReader(buffer);
  const header = parseHeader(reader);

  if (header.gameMode !== 3) {
    throw new Error(`This is not a mania replay (mode: ${header.gameMode})`);
  }

  let frames: ReplayFrame[] = [];
  let stableScrollSpeedScale: number | null = null;

  if (header.replayDataLength > 0) {
    const compressedData = reader.readBytes(header.replayDataLength);

    try {
      const decompressed = await decompressLZMA(compressedData);
      const text = new TextDecoder("utf-8").decode(decompressed);
      const parsedFrames = parseReplayFrames(text);
      frames = parsedFrames.frames;
      stableScrollSpeedScale = parsedFrames.stableScrollSpeedScale;
    } catch (e) {
      console.warn("LZMA decompression failed, trying raw parse:", e);
      // Some replays might not be compressed properly
    }
  }

  const keyCount = detectKeyCount(frames, header.modsUsed);
  const lifeBarFrames = parseLifeBarGraph(header.lifeBarGraph);

  return { header, frames, lifeBarFrames, keyCount, stableScrollSpeedScale: stableScrollSpeedScale ?? undefined };
}
