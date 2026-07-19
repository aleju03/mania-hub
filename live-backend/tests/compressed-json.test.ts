import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { packJson, unpackJson } from "../src/shared/compressed-json.js";

describe("compressed-json", () => {
  it("round-trips values through gzip", () => {
    const value = { scores: [{ id: 1, pp: 123.45, mods: [{ acronym: "DT" }] }], user: "テスト" };
    const packed = packJson(value);
    expect(packed[0]).toBe(0x1f);
    expect(packed[1]).toBe(0x8b);
    expect(unpackJson(packed, null)).toEqual(value);
  });

  it("reads legacy plain-text cells", () => {
    expect(unpackJson('{"a":1}', null)).toEqual({ a: 1 });
  });

  it("reads blobs surfaced as ArrayBuffer (libsql blob shape)", () => {
    const packed = packJson([1, 2, 3]);
    const arrayBuffer = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
    expect(unpackJson(arrayBuffer, null)).toEqual([1, 2, 3]);
  });

  it("reads uncompressed utf8 blobs", () => {
    expect(unpackJson(Buffer.from('{"b":2}', "utf8"), null)).toEqual({ b: 2 });
  });

  it("falls back on null, garbage blobs, and truncated gzip", () => {
    expect(unpackJson(null, "fallback")).toBe("fallback");
    expect(unpackJson(undefined, "fallback")).toBe("fallback");
    expect(unpackJson(42, "fallback")).toBe("fallback");
    expect(unpackJson(Buffer.from([0x1f, 0x8b, 0x00]), "fallback")).toBe("fallback");
    expect(unpackJson(gzipSync(Buffer.from("not json")), "fallback")).toBe("fallback");
    expect(unpackJson("not json", "fallback")).toBe("fallback");
  });

  it("compresses repetitive score JSON well", () => {
    const score = { classic_total_score: 271594, preserve: true, processed: true, ranked: true, statistics: { great: 6967, perfect: 9164 }, pp: 1092.71 };
    const scores = Array.from({ length: 200 }, (_, index) => ({ ...score, id: index }));
    const packed = packJson(scores);
    expect(packed.length).toBeLessThan(JSON.stringify(scores).length / 5);
  });
});
