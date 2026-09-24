import { afterEach, expect, it, vi } from "vitest";
import { TeamImageCache } from "./team-image-server";

const path = (id: number) => `teams/flag/${id}/${"a".repeat(64)}.png`;
const limits = { bytes: 10, entries: 8, imageBytes: 8, concurrent: 2, ttlMs: 1000, timeoutMs: 50 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shares concurrent requests and evicts images by total bytes", async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array(6)));
  vi.stubGlobal("fetch", fetcher);
  const cache = new TeamImageCache(limits);
  const [a, b] = await Promise.all([cache.get(path(1)), cache.get(path(1))]);
  expect(a.buffer).toBe(b.buffer);
  expect(fetcher).toHaveBeenCalledOnce();
  await cache.get(path(2));
  await cache.get(path(2));
  expect(fetcher).toHaveBeenCalledTimes(2);
  await cache.get(path(1));
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("bounds the body while streaming and does not cache a failed image", async () => {
  const cancel = vi.fn();
  const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); }, cancel,
  })));
  vi.stubGlobal("fetch", fetcher);
  const cache = new TeamImageCache(limits);
  await expect(cache.get(path(1))).rejects.toThrow("too large");
  expect(cancel).toHaveBeenCalled();
  fetcher.mockImplementation(async () => new Response(new Uint8Array(4)));
  expect((await cache.get(path(1))).buffer.length).toBe(4);
});

it("keeps its timeout active after headers arrive", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }))));
  const result = new TeamImageCache(limits).get(path(1));
  const rejected = expect(result).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(51);
  await rejected;
  expect(cancel).toHaveBeenCalled();
});

it("expires retained buffers and rejects paths outside the team image namespace", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response(new Uint8Array(4)));
  vi.stubGlobal("fetch", fetcher);
  const cache = new TeamImageCache(limits);
  await expect(cache.get("../anything")).rejects.toThrow("Invalid");
  await cache.get(path(1));
  await vi.advanceTimersByTimeAsync(1001);
  await cache.get(path(1));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("bounds active downloads and the waiting backlog", async () => {
  vi.useFakeTimers();
  let active = 0;
  let peak = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return new Response(new Uint8Array(4));
  }));
  const cache = new TeamImageCache(limits);
  const pending = Array.from({ length: 8 }, (_, i) => cache.get(path(i + 1)));
  await expect(cache.get(path(9))).rejects.toThrow("busy");
  await vi.advanceTimersByTimeAsync(100);
  await Promise.all(pending);
  expect(peak).toBe(2);
});

it("serves a flag as a WebP no wider than the card draws it", async () => {
  const { default: sharp } = await import("sharp");
  // A grainy gradient: PNG stores the grain losslessly, WebP does not have to.
  let seed = 1;
  const raw = Buffer.from(Array.from({ length: 800 * 400 * 3 }, (_, i) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const pixel = Math.floor(i / 3);
    return ((pixel % 800) + Math.floor(pixel / 800)) / 5 + (seed >>> 28);
  }));
  const png = await sharp(raw, { raw: { width: 800, height: 400, channels: 3 } }).png().toBuffer();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } })));
  const image = await new TeamImageCache({ ...limits, bytes: 4_000_000, imageBytes: 4_000_000, timeoutMs: 5_000 }).get(path(1));
  expect(image.contentType).toBe("image/webp");
  expect(image.buffer.length).toBeLessThan(png.length);
  expect((await sharp(image.buffer).metadata()).width).toBe(646);
});
