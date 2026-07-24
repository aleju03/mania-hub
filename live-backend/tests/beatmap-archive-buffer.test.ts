import { describe, expect, it } from "vitest";
import { __readResponseBufferWithLimitForTest } from "../src/audio/beatmap-archive.js";

const LIMIT = 1024;

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function responseOf(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  return new Response(bodyOf(chunks), { headers });
}

function bytes(from: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => ((from + index) % 255) + 1);
}

describe("readResponseBufferWithLimit", () => {
  it("returns the exact body when Content-Length is honest", async () => {
    const chunks = [bytes(0, 100), bytes(100, 40)];
    const buffer = await __readResponseBufferWithLimitForTest(
      responseOf(chunks, { "content-length": "140" }),
      LIMIT,
    );

    expect(buffer.byteLength).toBe(140);
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([...chunks[0], ...chunks[1]]));
  });

  it("ignores Content-Length when the body is encoded", async () => {
    // undici decodes gzip/br transparently but leaves the compressed
    // Content-Length on the headers, so the growth path must handle it.
    const chunks = [bytes(0, 200)];
    const buffer = await __readResponseBufferWithLimitForTest(
      responseOf(chunks, { "content-length": "23", "content-encoding": "gzip" }),
      LIMIT,
    );

    expect(buffer.byteLength).toBe(200);
    expect(new Uint8Array(buffer)).toEqual(chunks[0]);
  });

  it("reads chunked responses without a Content-Length", async () => {
    const chunks = [bytes(0, 10), bytes(10, 10), bytes(20, 5)];
    const buffer = await __readResponseBufferWithLimitForTest(responseOf(chunks), LIMIT);

    expect(buffer.byteLength).toBe(25);
  });

  it("rejects a declared length over the limit before reading the body", async () => {
    await expect(__readResponseBufferWithLimitForTest(
      responseOf([bytes(0, 8)], { "content-length": String(LIMIT + 1) }),
      LIMIT,
    )).rejects.toThrow(/too large/);
  });

  it("rejects a garbage Content-Length", async () => {
    await expect(__readResponseBufferWithLimitForTest(
      responseOf([bytes(0, 8)], { "content-length": "not-a-number" }),
      LIMIT,
    )).rejects.toThrow(/too large/);
  });

  it("rejects a body longer than its declared length", async () => {
    await expect(__readResponseBufferWithLimitForTest(
      responseOf([bytes(0, 50), bytes(50, 50)], { "content-length": "60" }),
      LIMIT,
    )).rejects.toThrow(/exceeded its declared length/);
  });

  it("truncates a body shorter than its declared length without zero padding", async () => {
    const chunk = bytes(7, 40);
    const buffer = await __readResponseBufferWithLimitForTest(
      responseOf([chunk], { "content-length": "500" }),
      LIMIT,
    );

    expect(buffer.byteLength).toBe(40);
    expect(new Uint8Array(buffer)).toEqual(chunk);
    // A zip's EOCD is found by scanning backwards from the end, so a trailing
    // run of zeros would silently break archive parsing.
    expect(new Uint8Array(buffer)[39]).toBe(chunk[39]);
  });

  it("handles a zero-length body", async () => {
    const buffer = await __readResponseBufferWithLimitForTest(
      responseOf([], { "content-length": "0" }),
      LIMIT,
    );

    expect(buffer.byteLength).toBe(0);
  });

  it("preallocates from a caller-supplied expected length", async () => {
    const chunks = [bytes(0, 16), bytes(16, 16)];
    const buffer = await __readResponseBufferWithLimitForTest(responseOf(chunks), LIMIT, 32);
    expect(buffer.byteLength).toBe(32);

    await expect(__readResponseBufferWithLimitForTest(responseOf(chunks), LIMIT, 20))
      .rejects.toThrow(/exceeded its declared length/);
  });

  it("falls back to the growth path when the expected length is out of range", async () => {
    const buffer = await __readResponseBufferWithLimitForTest(
      responseOf([bytes(0, 12)]),
      LIMIT,
      LIMIT + 1,
    );

    expect(buffer.byteLength).toBe(12);
  });

  it("stops a body that grows past the limit without a Content-Length", async () => {
    await expect(__readResponseBufferWithLimitForTest(
      responseOf([bytes(0, 600), bytes(0, 600)]),
      LIMIT,
    )).rejects.toThrow(/too large/);
  });
});
