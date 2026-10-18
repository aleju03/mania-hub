const PROB_INIT = 1024;
const NUM_BIT_MODEL_TOTAL_BITS = 11;
const NUM_MOVE_BITS = 5;
const BIT_MODEL_TOTAL = 1 << NUM_BIT_MODEL_TOTAL_BITS;

const TOP_MASK = 0xff000000 | 0;

const NUM_POS_BITS_MAX = 4;
const NUM_STATES = 12;
const NUM_LEN_TO_POS_STATES = 4;
const NUM_ALIGN_BITS = 4;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
const MATCH_MIN_LEN = 2;

const LEN_LOW = 2;
const LEN_MID = LEN_LOW + (1 << (NUM_POS_BITS_MAX + 3));
const LEN_HIGH = LEN_MID + (1 << (NUM_POS_BITS_MAX + 3));
const LEN_SIZE = LEN_HIGH + 256;
const IS_MATCH = 0;
const IS_REP = IS_MATCH + (NUM_STATES << NUM_POS_BITS_MAX);
const IS_REP_G0 = IS_REP + NUM_STATES;
const IS_REP_G1 = IS_REP_G0 + NUM_STATES;
const IS_REP_G2 = IS_REP_G1 + NUM_STATES;
const IS_REP0_LONG = IS_REP_G2 + NUM_STATES;
const POS_SLOT = IS_REP0_LONG + (NUM_STATES << NUM_POS_BITS_MAX);
const POS_DECODERS = POS_SLOT + (NUM_LEN_TO_POS_STATES << 6);
const ALIGN = POS_DECODERS + 1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX;
const LEN_DECODER = ALIGN + (1 << NUM_ALIGN_BITS);
const REP_LEN_DECODER = LEN_DECODER + LEN_SIZE;
const LITERAL = REP_LEN_DECODER + LEN_SIZE;

export class LzmaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LzmaError";
  }
}

export interface LzmaLimits {
  maxOutputBytes: number;
  maxDictionaryBytes?: number;
}

class RangeDecoder {
  range = -1;
  code = 0;
  private pos: number;

  constructor(private readonly input: Uint8Array, private readonly probs: Uint16Array, start: number) {
    if (input.length - start < 5) throw new LzmaError("LZMA stream is truncated.");
    if (input[start] !== 0) throw new LzmaError("LZMA range coder header is invalid.");
    this.code = (input[start + 1] << 24) | (input[start + 2] << 16) | (input[start + 3] << 8) | input[start + 4];
    this.pos = start + 5;
  }

  normalize(): void {
    if ((this.range & TOP_MASK) === 0) {
      this.range <<= 8;
      if (this.pos >= this.input.length) throw new LzmaError("LZMA stream ended early.");
      this.code = (this.code << 8) | this.input[this.pos++];
    }
  }

  bit(index: number): number {
    const prob = this.probs[index];
    const bound = Math.imul(this.range >>> NUM_BIT_MODEL_TOTAL_BITS, prob);
    let bit = 0;
    if ((this.code >>> 0) < (bound >>> 0)) {
      this.probs[index] = prob + ((BIT_MODEL_TOTAL - prob) >>> NUM_MOVE_BITS);
      this.range = bound;
    } else {
      this.probs[index] = prob - (prob >>> NUM_MOVE_BITS);
      this.code = (this.code - bound) | 0;
      this.range = (this.range - bound) | 0;
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  directBits(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i += 1) {
      this.range >>>= 1;
      const t = ((this.code - this.range) >>> 31) ^ 1;
      if (t === 1) this.code = (this.code - this.range) | 0;
      result = (result << 1) | t;
      this.normalize();
    }
    return result;
  }

  tree(offset: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i += 1) m = (m << 1) | this.bit(offset + m);
    return m - (1 << bits);
  }

  reverseTree(offset: number, bits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i += 1) {
      const bit = this.bit(offset + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }

  length(base: number, posState: number): number {
    if (this.bit(base) === 0) return this.tree(base + LEN_LOW + (posState << 3), 3);
    if (this.bit(base + 1) === 0) return 8 + this.tree(base + LEN_MID + (posState << 3), 3);
    return 16 + this.tree(base + LEN_HIGH, 8);
  }
}

export interface LzmaHeader {
  lc: number;
  lp: number;
  pb: number;
  dictionarySize: number;
  declaredSize: bigint | null;
}

export function readLzmaHeader(buffer: Uint8Array): LzmaHeader {
  if (buffer.length < 13) throw new LzmaError("LZMA header is truncated.");
  const properties = buffer[0];
  if (properties >= 9 * 5 * 5) throw new LzmaError("LZMA properties byte is invalid.");
  const lc = properties % 9;
  const remainder = Math.floor(properties / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const dictionarySize = view.getUint32(1, true);
  const declared = view.getBigUint64(5, true);
  return {
    lc, lp, pb, dictionarySize,
    declaredSize: declared === 0xffffffffffffffffn ? null : declared,
  };
}

export function decodeLzma(buffer: Uint8Array, limits: LzmaLimits): Uint8Array {
  const header = readLzmaHeader(buffer);
  const maxDictionary = limits.maxDictionaryBytes ?? 64 * 1024 * 1024;
  if (header.dictionarySize > maxDictionary) throw new LzmaError("LZMA dictionary size is too large.");
  if (header.declaredSize == null) throw new LzmaError("LZMA stream does not declare its size.");
  if (header.declaredSize > BigInt(limits.maxOutputBytes)) throw new LzmaError("LZMA output would exceed the limit.");
  const outputSize = Number(header.declaredSize);
  if (!Number.isSafeInteger(outputSize) || outputSize < 0) throw new LzmaError("LZMA declared size is invalid.");

  const { lc, lp, pb } = header;
  const out = new Uint8Array(outputSize);
  let outPos = 0;

  const probs = new Uint16Array(LITERAL + (0x300 << (lc + lp))).fill(PROB_INIT);
  const rc = new RangeDecoder(buffer, probs, 13);

  const posMask = (1 << pb) - 1;
  const literalPosMask = (1 << lp) - 1;

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;

  while (outPos < outputSize) {
    const posState = outPos & posMask;
    if (rc.bit(IS_MATCH + (state << NUM_POS_BITS_MAX) + posState) === 0) {
      const prevByte = outPos > 0 ? out[outPos - 1] : 0;
      const base = LITERAL + 0x300 * (((outPos & literalPosMask) << lc) + (prevByte >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[outPos - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(base + symbol);
      out[outPos++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len: number;
    if (rc.bit(IS_REP + state) !== 0) {
      if (outPos === 0) throw new LzmaError("LZMA rep match before any output.");
      if (rc.bit(IS_REP_G0 + state) === 0) {
        if (rc.bit(IS_REP0_LONG + (state << NUM_POS_BITS_MAX) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[outPos] = out[outPos - rep0 - 1];
          outPos += 1;
          continue;
        }
      } else {
        let distance: number;
        if (rc.bit(IS_REP_G1 + state) === 0) {
          distance = rep1;
        } else {
          if (rc.bit(IS_REP_G2 + state) === 0) {
            distance = rep2;
          } else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      len = rc.length(REP_LEN_DECODER, posState) + MATCH_MIN_LEN;
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = rc.length(LEN_DECODER, posState) + MATCH_MIN_LEN;
      state = state < 7 ? 7 : 10;
      const posSlot = rc.tree(POS_SLOT + (Math.min(len - MATCH_MIN_LEN, NUM_LEN_TO_POS_STATES - 1) << 6), 6);
      if (posSlot < 4) {
        rep0 = posSlot;
      } else {
        const directBits = (posSlot >> 1) - 1;
        rep0 = (2 | (posSlot & 1)) << directBits;
        if (posSlot < END_POS_MODEL_INDEX) {
          rep0 += rc.reverseTree(POS_DECODERS + rep0 - posSlot, directBits);
        } else {
          rep0 = (rep0 + (rc.directBits(directBits - NUM_ALIGN_BITS) << NUM_ALIGN_BITS)) >>> 0;
          rep0 = (rep0 + rc.reverseTree(ALIGN, NUM_ALIGN_BITS)) >>> 0;
        }
        if (rep0 === 0xffffffff) break;
      }
    }

    if (rep0 >= outPos) throw new LzmaError("LZMA match distance is out of range.");
    if (outPos + len > outputSize) throw new LzmaError("LZMA output overran its declared size.");
    let source = outPos - rep0 - 1;
    if (rep0 >= len) {
      out.copyWithin(outPos, source, source + len);
      outPos += len;
    } else {
      for (let i = 0; i < len; i += 1) out[outPos++] = out[source++];
    }
  }

  if (outPos !== outputSize) throw new LzmaError("LZMA stream ended before its declared size.");
  return out;
}
