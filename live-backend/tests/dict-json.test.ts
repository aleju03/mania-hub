import { createHash } from "node:crypto";
import { deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { packDictJson, packDictJsonText, readJsonTextStrict, scoreDictionaryBytes, unpackDictJsonText } from "../src/shared/dict-json.js";
import { unpackJson } from "../src/shared/compressed-json.js";

describe("dictionary JSON", () => {
  it("pins the frozen synthetic dictionary and preserves exact JSON bytes", () => {
    expect(createHash("sha256").update(scoreDictionaryBytes()).digest("hex"))
      .toBe("ad50b21f1fca86eb99c200e16dc4d81ca6e8f4b8b20db4fb499341bc428ddfe8");
    const text = ' { "id": 9007199254740993, "pp": 1.2300, "title": "テスト 🎵", "x": -0 }\n';
    const packed = packDictJsonText(text);
    expect(unpackDictJsonText(packed)).toBe(text);
    expect(readJsonTextStrict(packed)).toBe(text);
    expect(unpackJson(packed, null)).toEqual(JSON.parse(text));
    const buffer = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
    expect(unpackJson(buffer, null)).toEqual(JSON.parse(text));
  });

  it("accepts legacy text, UTF-8 blobs and gzip cells", () => {
    const text = '{"id":12,"mods":[{"acronym":"DT"}]}';
    for (const cell of [text, Buffer.from(text), gzipSync(text)]) {
      expect(unpackJson(cell, null)).toEqual(JSON.parse(text));
      expect(readJsonTextStrict(cell)).toBe(text);
    }
  });

  it("throws for corruption, truncated/trailing streams, missing/wrong dictionaries and unknown versions", () => {
    const packed = packDictJson({ id: 123, pp: 42, mods: [] });
    const damaged = Buffer.from(packed); damaged[damaged.length - 1] ^= 1;
    const unknown = Buffer.from(packed); unknown[1] = 99;
    for (let bit = 0; bit < 8; bit++) {
      const marker = Buffer.from(packed); marker[0] ^= 1 << bit;
      expect(() => unpackJson(marker, null)).toThrow();
    }
    const wrongDict = Buffer.concat([Buffer.from([0, 1]), deflateSync('{"id":12}', { dictionary: Buffer.from('wrong dictionary') })]);
    for (const cell of [damaged, unknown, Buffer.from([0]), packed.subarray(0, -1), Buffer.concat([packed, Buffer.from([0])]), Buffer.concat([packed, packed]), wrongDict]) {
      expect(() => unpackJson(cell, null)).toThrow();
    }
    expect(() => unpackDictJsonText(Buffer.from([2, 1, 2]))).toThrow(/Unknown/);
    expect(() => readJsonTextStrict('not json')).toThrow();
    expect(() => readJsonTextStrict(null)).toThrow();
    const nonJson = Buffer.concat([Buffer.from([0, 1]), deflateSync('not json', { dictionary: scoreDictionaryBytes() })]);
    expect(() => unpackJson(nonJson, {})).toThrow();
  });
});
