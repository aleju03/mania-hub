// Shared satori/resvg rendering machinery for the two PNG-producing routes:
// /api/og (social cards) and /api/signature (dynamic renders).
//
// This lives in lib/ rather than in either route because the render gate in
// particular must be ONE instance across both. CPU is the shared resource on a
// 4-vCPU box; two independent caps would just be two ways to saturate it.

import { waitUntil } from "@vercel/functions";

import { noteSpritePath } from "./note-sprites";
import { getAssetOrigin } from "./origin";

const FONT_FETCH_TIMEOUT_MS = 10_000;

const fontCache = new Map<string, Promise<ArrayBuffer>>();

/* Fonts are fetched over HTTP from our own public asset origin rather than read
   off disk: public/ is not bundled into a serverless function, so fs.readFile
   throws ENOENT there. Memoized process-wide, and the promise is dropped on
   rejection so a blip does not poison the cache. */
export function getFont(request: Request, fileName: string): Promise<ArrayBuffer> {
  const url = new URL(`/fonts/${fileName}`, getAssetOrigin(request)).toString();
  const cached = fontCache.get(url);
  if (cached) return cached;

  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`font fetch ${response.status}`);
      }
      return response.arrayBuffer();
    } finally {
      clearTimeout(timeout);
    }
  })();

  fontCache.set(url, promise);
  promise.catch(() => fontCache.delete(url));
  return promise;
}

export async function loadOgFonts(request: Request): Promise<[ArrayBuffer, ArrayBuffer]> {
  return Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
  ]);
}

export function ogFontList(regularFont: ArrayBuffer, heavyFont: ArrayBuffer) {
  return [
    { name: "Torus OG" as const, data: regularFont, style: "normal" as const, weight: 400 as const },
    { name: "Torus OG" as const, data: heavyFont, style: "normal" as const, weight: 900 as const },
  ];
}

/* Satori fetches assets with fetch() and will not resolve a relative path, so
   a stored avatar path has to become absolute against our own asset origin. */
export function ogAvatarUrl(request: Request, avatarUrl: string | null | undefined, userId?: number): string {
  if (avatarUrl && !/^(https?:)?\/\//i.test(avatarUrl) && !avatarUrl.startsWith("data:")) {
    return new URL(avatarUrl, getAssetOrigin(request)).toString();
  }
  if (avatarUrl) return avatarUrl;
  return userId ? `https://a.ppy.sh/${userId}` : "";
}

/* Satori fetches every <img> itself; two dozen parallel self-requests for the
   note sprites is enough to get connections dropped (notes silently missing, or
   the whole render dying on "socket hang up"). Prefetch each unique sprite
   once, cache it, and hand satori data: URLs.

   Shared by the skins social card and the signature backdrop, which draw the
   same rain and would otherwise keep two caches of the same two dozen files. */
const noteSpriteCache = new Map<string, Promise<string>>();

export function getNoteSpriteDataUrl(origin: string, img: string): Promise<string> {
  const url = new URL(noteSpritePath(img), origin).toString();
  const cached = noteSpriteCache.get(url);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load note sprite ${img}: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:image/png;base64,${buffer.toString("base64")}`;
  })();

  noteSpriteCache.set(url, promise);
  promise.catch(() => noteSpriteCache.delete(url));
  return promise;
}

export function clamp(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}...`;
}

export function formatOgInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return Math.round(value).toLocaleString("en-US");
}

export function formatOgAcc(accuracy: number | null | undefined): string {
  if (accuracy == null || !Number.isFinite(accuracy)) return "--";
  // osu! API returns accuracy as 0-1 float for lazer scores and 0-100 for
  // legacy, but the LeanRankingEntry ships it 0-1. OsuScore ships 0-1. Scale
  // to percent.
  const pct = accuracy <= 1 ? accuracy * 100 : accuracy;
  return `${pct.toFixed(2)}%`;
}

export class OgFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OgFallbackError";
  }
}

export function isOgFallbackError(error: unknown): error is OgFallbackError {
  return error instanceof OgFallbackError;
}

/* Rasterization is the most expensive thing this box does, so two limits sit
   around it. Renders of the same card collapse into one (a link posted in a
   busy Discord unfurls from many crawlers at once, all missing the same key),
   and no more than a couple run at a time - past that, callers are handed
   something cached instead of queueing behind multi-second renders. That keeps
   the 4 vCPUs available for serving pages no matter how many distinct card
   identities someone asks for. */
export const MAX_CONCURRENT_OG_RENDERS = 2;

/* A small hand-off semaphore, rather than a check followed by an increment.
   The distinction matters on a cold default-card cache: the overflow request
   may have to wait for one of the two active renders, but it must never become
   a third render while doing so. Releasing directly hands the occupied slot to
   the oldest waiter, so a new arrival cannot steal it between wake-up and the
   waiter's continuation. */
export class OgRenderGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // The slot stays counted as active while ownership is handed over.
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

/** The single gate shared by every PNG route. Do not construct another. */
export const ogRenderGate = new OgRenderGate(MAX_CONCURRENT_OG_RENDERS);

/* Lets a cache write outlive the response without keeping the caller waiting.
   Outside a Vercel function context there is no waitUntil, and the callers all
   swallow their own errors, so letting it run detached is safe. */
export function scheduleDetached(promise: Promise<unknown>): void {
  try {
    waitUntil(promise);
  } catch {
    void promise;
  }
}

export function imageResponse(
  buffer: Buffer,
  contentType: string,
  cacheControl: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
      "Cache-Control": cacheControl,
      ...extraHeaders,
    },
  });
}

export function pngResponse(buffer: Buffer, cacheControl: string, extraHeaders?: Record<string, string>): Response {
  return imageResponse(buffer, "image/png", cacheControl, extraHeaders);
}

/* Satori only emits PNG, and a signature is the one card where that is the
   wrong container: the layouts composite a photograph (an osu! banner, a top
   play cover, a pasted url) behind text, and RGBA PNG stores that at roughly a
   byte per pixel. An 880x200 render measured 129 KB, which a viewer's browser
   paints scanline by scanline as it arrives - the picture visibly wipes in from
   the top. The same render is 32 KB as WebP.
 *
 * Quality 98 rather than the usual 75-82: these are small cards carrying small
 * text, and the artifacts a photograph hides show up on a glyph edge. The walk
 * up was empirical - at 90 someone looking for the difference finds it in the
 * soft gradients of an avatar, at 94 they have to hunt, and 98 is where a 3x
 * zoom against the source stops being an argument. It costs 32 KB against the
 * PNG's 129 KB, still a quarter of the bytes and nowhere near the size where a
 * transfer is slow enough to paint scanline by scanline. Effort 4 keeps the
 * encode near 25ms, which is noise next to the rasterization it follows.
 *
 * Only stored renders go through this. /api/signature-preview stays PNG: it is
 * no-store, it runs once per slider drag, and it has no transfer worth 25ms of
 * CPU. */
export async function encodeSignatureWebp(png: Buffer): Promise<Buffer> {
  // Lazy for the same reason the background pass is: sharp is a native module
  // and nothing about booting the server should pull it in.
  const { default: sharp } = await import("sharp");
  return sharp(png)
    .webp({ quality: 98, alphaQuality: 100, effort: 4, smartSubsample: true })
    .toBuffer();
}
