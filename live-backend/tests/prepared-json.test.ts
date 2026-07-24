import { describe, expect, it, vi } from "vitest";

// File-scoped zlib mock: compression can be forced to fail here without
// touching the rest of the suite. Callback-style, matching the real API.
const compressionState = { fail: false };

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  const maybeFail = (
    real: (buffer: Buffer, options: object, callback: (error: Error | null, result: Buffer) => void) => void,
  ) =>
    (buffer: Buffer, options: object, callback: (error: Error | null, result: Buffer) => void): void => {
      if (compressionState.fail) {
        callback(new Error("forced compression failure"), Buffer.alloc(0));
        return;
      }
      real(buffer, options, callback);
    };
  return {
    ...actual,
    brotliCompress: maybeFail(actual.brotliCompress as never),
    gzip: maybeFail(actual.gzip as never),
  };
});

const { COMPRESSIBLE_MIN_BYTES, prepareJsonResponse } = await import("../src/http/prepared-json.js");

const LARGE_BODY = { data: "x".repeat(COMPRESSIBLE_MIN_BYTES * 2) };

describe("prepareJsonResponse", () => {
  it("skips compression and vary for sub-MTU bodies", async () => {
    const prepared = await prepareJsonResponse(200, { ok: true }, "br");
    expect(prepared).toMatchObject({ status: 200, encoding: null, vary: false });
    expect(JSON.parse(prepared.body.toString("utf8"))).toEqual({ ok: true });
  });

  it("compresses large bodies with the negotiated encoding", async () => {
    for (const encoding of ["br", "gzip"] as const) {
      const prepared = await prepareJsonResponse(200, LARGE_BODY, encoding);
      expect(prepared.encoding).toBe(encoding);
      expect(prepared.vary).toBe(true);
      expect(prepared.body.length).toBeLessThan(JSON.stringify(LARGE_BODY).length);
    }
  });

  it("marks large identity responses as varying without an encoding", async () => {
    const prepared = await prepareJsonResponse(200, LARGE_BODY, null);
    expect(prepared).toMatchObject({ encoding: null, vary: true });
    expect(JSON.parse(prepared.body.toString("utf8"))).toEqual(LARGE_BODY);
  });

  it("falls back to the identity body when compression fails", async () => {
    compressionState.fail = true;
    try {
      for (const encoding of ["br", "gzip"] as const) {
        const prepared = await prepareJsonResponse(200, LARGE_BODY, encoding);
        expect(prepared.encoding).toBeNull();
        expect(prepared.vary).toBe(true);
        expect(JSON.parse(prepared.body.toString("utf8"))).toEqual(LARGE_BODY);
      }
    } finally {
      compressionState.fail = false;
    }
  });
});
