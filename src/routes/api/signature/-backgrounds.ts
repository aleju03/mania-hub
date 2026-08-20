// Background art for dynamic renders. The `-` prefix keeps this out of the
// route tree, same convention as the layouts and the colocated tests.
//
// Blur and opacity are baked into a flat JPEG here rather than expressed as
// CSS on the satori side, for three reasons:
//
//  - satori's `filter: blur()` blurs the edge pixels inward, so a full-bleed
//    background picks up a dark vignette the player never asked for. Blurring
//    the source with a cover-fit resize has no edge to pull in.
//  - Baking the opacity over the card surface yields one opaque layer, which
//    renders in roughly a third of the time of the equivalent CSS composite
//    and produces a noticeably smaller PNG.
//  - The result is deterministic, which matters when the whole freshness model
//    assumes one stored object per (data, style) version.
//
// The sharp pass costs ~40ms and happens once per version, not per view.

import { fetchValidatedImage, ProxyError, readCappedStream } from "../../../lib/safe-image-fetch";
import {
  normalizeSignatureImageUrl,
  styleIsCustomImage,
  styleUsesImage,
  type SignatureStyle,
} from "../../../lib/signature-style";

/* The two image sources are the player's own osu! assets, read off a profile
   payload we already fetched. The allowlist is belt-and-braces: those URLs
   arrive from an API response rather than from the request, but a background
   picker must not be one upstream field away from fetching an arbitrary
   address server-side. */
const ALLOWED_IMAGE_HOSTS = new Set(["assets.ppy.sh", "a.ppy.sh", "b.ppy.sh", "i.ppy.sh"]);

const SOURCE_FETCH_TIMEOUT_MS = 5_000;
/* osu! covers run to a megabyte. Anything far past that is not a cover, and
   decoding it would cost more than the render it decorates. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

const SOURCE_MEMO_MS = 5 * 60_000;
const SOURCE_MEMO_MAX = 32;

interface SourceMemoEntry {
  bytes: Buffer;
  expiresAt: number;
}

/* Tuning a slider re-renders on every change, and each of those would
   otherwise re-download the same ~800KB cover. Small and short-lived: this is
   a drag-gesture buffer, not a cache tier. */
const sourceMemo = new Map<string, SourceMemoEntry>();

function readMemo(url: string, now: number): Buffer | null {
  const entry = sourceMemo.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    sourceMemo.delete(url);
    return null;
  }
  return entry.bytes;
}

function writeMemo(url: string, bytes: Buffer, now: number): void {
  if (sourceMemo.size >= SOURCE_MEMO_MAX) {
    for (const [key, entry] of sourceMemo) {
      if (entry.expiresAt <= now) sourceMemo.delete(key);
    }
    // Still full of live entries: drop the oldest insertion, which Map
    // iteration order gives for free.
    if (sourceMemo.size >= SOURCE_MEMO_MAX) {
      const oldest = sourceMemo.keys().next();
      if (!oldest.done) sourceMemo.delete(oldest.value);
    }
  }
  sourceMemo.set(url, { bytes, expiresAt: now + SOURCE_MEMO_MS });
}

export interface SignatureBackgroundSources {
  /** The player's osu! profile banner. */
  coverUrl?: string | null;
  /** The beatmapset cover of their best play. */
  mapUrl?: string | null;
}

/* The osu! sources arrive from an API response rather than from the player, so
   they get held to the hosts they are supposed to come from. A drifting
   upstream field should not become an arbitrary fetch. */
function allowedOsuImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return ALLOWED_IMAGE_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceUrlFor(style: SignatureStyle, sources: SignatureBackgroundSources): string | null {
  if (styleIsCustomImage(style)) {
    // Already shape-checked (https, no credentials, length capped) by
    // normalizeSignatureStyle both on write and on read. Where it points is
    // the transport's problem, not this function's.
    return style.imageUrl;
  }
  return allowedOsuImageUrl(style.background === "cover" ? sources.coverUrl
    : style.background === "map" ? sources.mapUrl
    : null);
}

/* How far down a cover is pulled before white text goes on it, matching the
   brightness-[0.38] the profile page dims these same covers to. Fixed rather
   than measured the way a full-card background is: this band always carries
   the same four lines of white text, and the player has no slider here to
   compensate with if it came back too bright. */
const COVER_BAND_BRIGHTNESS = 0.34;

/** The beatmap cover behind one row, rather than behind a whole card.
 *
 *  Not backgroundImageDataUrl: that one paints a whole layout from the style
 *  the player picked, and this is a fixed band inside a layout whose own
 *  background may already be something else entirely. Same pinned transport
 *  and same host allowlist, since the address still comes off an API payload.
 *
 *  Null on any failure, like every background here: the row draws flat and the
 *  render still says what it exists to say. */
export async function beatmapCoverBandDataUrl(
  rawUrl: string | null | undefined,
  width: number,
  height: number,
): Promise<string | null> {
  const url = allowedOsuImageUrl(rawUrl);
  if (!url) return null;
  const bytes = await fetchSource(url);
  if (!bytes) return null;

  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(bytes, { failOn: "none" })
      // A 900x250 cover squeezed into a strip crops to the artwork rather than
      // to whichever corner happened to be in the middle.
      .resize(width, height, { fit: "cover", position: "attention" })
      .modulate({ brightness: COVER_BAND_BRIGHTNESS })
      /* PNG, unlike the full-card background above. Dimming a cover to a third
         of its brightness compresses it into the bottom of the range, where
         JPEG has the fewest levels to spend - a smooth sky came out visibly
         blocked, and the render it is baked into is a lossless PNG that then
         preserves those blocks forever. This costs a bigger data URL inside
         one render and nothing at all in what gets stored. */
      .png({ compressionLevel: 9 })
      .toBuffer();
    return `data:image/png;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The player's osu! avatar, square and already the size it is drawn at.
 *
 *  Fetched here rather than handed to satori as a url, for the same reasons as
 *  the cover band: the address comes off an API payload, so it goes through the
 *  same pinned transport and host allowlist, and a fetch that fails returns
 *  null instead of taking the whole render down with it. The header then draws
 *  without a portrait, which is the layout it had before there was one. */
export async function avatarSquareDataUrl(
  rawUrl: string | null | undefined,
  size: number,
): Promise<string | null> {
  const url = allowedOsuImageUrl(rawUrl);
  if (!url) return null;
  const bytes = await fetchSource(url);
  if (!bytes) return null;

  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(bytes, { failOn: "none" })
      // Resized here rather than by the renderer: satori scales an oversized
      // source with a box filter, and an osu! avatar is 256px going into a
      // 28px square.
      .resize(size, size, { fit: "cover" })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return `data:image/png;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

/* Everything goes through the pinned transport, osu! assets included. It
   resolves the hostname once, refuses every private and reserved range on both
   address families, dials the socket at the address it validated (so DNS
   cannot rebind underneath the check), and re-runs all of that on each
   redirect hop. Using plain fetch() for the player-supplied url would be the
   whole SSRF bug; using it for the osu! ones as well would just be a second
   code path to keep honest. */
async function fetchSource(url: string): Promise<Buffer | null> {
  const now = Date.now();
  const memoized = readMemo(url, now);
  if (memoized) return memoized;

  try {
    const response = await fetchValidatedImage(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
    if (response.status !== 200) {
      response.stream.destroy();
      return null;
    }
    // A background must be a picture. sharp would reject anything else anyway,
    // but refusing here means we never buffer 8MB of someone's tarball first.
    if (response.contentType && !/^image\//i.test(response.contentType.trim())) {
      response.stream.destroy();
      return null;
    }
    const bytes = await readCappedStream(response.stream, MAX_SOURCE_BYTES, response.contentLength);
    if (!bytes || bytes.length === 0) return null;
    writeMemo(url, bytes, now);
    return bytes;
  } catch {
    return null;
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16) || 0,
    g: parseInt(value.slice(2, 4), 16) || 0,
    b: parseInt(value.slice(4, 6), 16) || 0,
  };
}

/** Builds the flattened background layer, or null when the style has no image
    source, the fetch fails, or sharp throws. A background is decoration: it
    must never be the reason a signature fails to draw. */
export async function backgroundImageDataUrl(
  style: SignatureStyle,
  width: number,
  height: number,
  sources: SignatureBackgroundSources,
  surface: string,
): Promise<string | null> {
  if (!styleUsesImage(style)) return null;
  const url = sourceUrlFor(style, sources);
  if (!url) return null;
  const bytes = await fetchSource(url);
  if (!bytes) return null;

  try {
    // Lazy: sharp is a native module, and a render with no image background
    // has no reason to pay for loading it. Mirrors how the live backend keeps
    // sharp out of its boot module graph.
    const { default: sharp } = await import("sharp");
    const fitted = await sharp(bytes, { failOn: "none" })
      // "attention" crops toward the busiest region, which for a square map
      // cover squeezed into a wide banner is the artwork rather than a corner.
      .resize(width, height, { fit: "cover", position: "attention" })
      .toBuffer();

    let pipeline = sharp(fitted);
    // sharp rejects a sigma under 0.3, and a 0px blur means the player asked
    // for none.
    if (style.blur >= 1) pipeline = pipeline.blur(style.blur);

    /* The slider scales the automatic level rather than replacing it. Taking
       the number literally instead reads fine on paper and is broken to use:
       the cap on a bright cover lands around 0.5, so leaving the default of
       100 for 99 would jump the picture from half brightness to nearly full
       and dragging *down* would make it brighter. Scaling keeps the control
       monotonic - 100 is whatever the picture needed, and every step from
       there moves the way it looks like it should. */
    const brightness = (await legibilityBrightness(sharp, fitted, style.opacity))
      * (style.brightness / 100);
    if (brightness !== 1) pipeline = pipeline.modulate({ brightness });

    const fade = Math.min(1, Math.max(0, 1 - style.opacity / 100));
    if (fade > 0) {
      const { r, g, b } = hexToRgb(surface);
      pipeline = pipeline.composite([{
        input: { create: { width, height, channels: 4, background: { r, g, b, alpha: fade } } },
      }]);
    }

    /* Quality 90, not the 74 this started at. A background is the largest
       smooth-gradient area in any render, which is exactly what a mid-quality
       JPEG blocks, and the render it lands in is a lossless PNG that keeps
       every block forever. Still JPEG rather than lossless: the same layer as
       a PNG is ~18x the bytes handed to satori, for a difference nobody can
       see at this quality. */
    const out = await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

/* White text over an arbitrary photograph is the whole difficulty here. Osu!
   banners and beatmap covers are frequently near-white, and no fixed scrim
   both keeps those readable and leaves a dark cover looking like anything at
   all - one setting has to lose.

   So the dimming adapts to the picture instead: measure what came back and
   pull it down only if it is too bright to sit text on. A dark cover is left
   alone. This is a floor rather than a look, which is why it is not a slider -
   a player cannot drag their own signature into being unreadable on someone
   else's profile, and the opacity they can drag still decides how much of the
   photo comes through. */
async function legibilityBrightness(
  sharp: typeof import("sharp").default,
  fitted: Buffer,
  opacity: number,
): Promise<number> {
  try {
    const { channels } = await sharp(fitted).stats();
    const [red, green, blue] = channels;
    if (!red || !green || !blue) return 1;
    const luminance = (0.2126 * red.mean + 0.7152 * green.mean + 0.0722 * blue.mean) / 255;
    if (luminance <= 0) return 1;
    // A stronger opacity earns a slightly brighter target, so turning it up is
    // visible rather than being clawed straight back by the cap.
    const target = 0.22 + 0.10 * (opacity / 100);
    return luminance > target ? Math.max(0.2, target / luminance) : 1;
  } catch {
    return 1;
  }
}

/* A small copy of a background, for the moderation page. Fetched here rather
   than pointed at with an <img src>: a browser loading the player's address
   directly would hand that host the moderator's IP and the fact that someone
   is looking, and would put whatever it answers with straight into the page.
   Coming through the same pinned transport the render uses, the page only ever
   shows bytes this server already decoded. */
export async function thumbnailDataUrl(url: string, width = 128, height = 72): Promise<string | null> {
  const bytes = await fetchSource(url);
  if (!bytes) return null;
  try {
    const { default: sharp } = await import("sharp");
    const out = await sharp(bytes, { failOn: "none" })
      .resize(width, height, { fit: "cover", position: "attention" })
      .jpeg({ quality: 62, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

/* Why a picture did not come back. A render treats every one of these the same
   way - draw without a background - which is right for a stranger loading an
   osu! profile and useless for the player who just pasted the address and is
   watching nothing happen. So the page asks separately and says which it was.

   The reasons stay coarse on purpose. This runs the same fetch the render
   does, at the same admin gate, but a caller who could read back a status code
   or an error string would have a probe worth pointing at things. */
export type SignatureImageProbe =
  | "ok"
  | "blocked"
  | "refused"
  | "unreachable"
  | "not-an-image"
  | "too-large";

export async function probeSignatureImageUrl(raw: string): Promise<SignatureImageProbe> {
  const url = normalizeSignatureImageUrl(raw);
  if (!url) return "blocked";

  const now = Date.now();
  if (readMemo(url, now)) return "ok";

  let response;
  try {
    response = await fetchValidatedImage(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
  } catch (error) {
    // The transport's own refusals - private range, odd port, too many hops -
    // all arrive as a 400-class ProxyError.
    return error instanceof ProxyError && error.status === 400 ? "blocked" : "unreachable";
  }

  if (response.status !== 200) {
    response.stream.destroy();
    /* 401/403 is the common one and worth its own wording: hosts behind a bot
       challenge (Cloudflare's "Just a moment") answer every non-browser client
       this way, so the player's link is fine and the host simply will not
       serve it to us. Nothing here spoofs a browser to get around that. */
    return response.status === 401 || response.status === 403 ? "refused" : "unreachable";
  }
  if (response.contentType && !/^image\//i.test(response.contentType.trim())) {
    response.stream.destroy();
    return "not-an-image";
  }

  const bytes = await readCappedStream(response.stream, MAX_SOURCE_BYTES, response.contentLength);
  if (!bytes) return "too-large";
  if (bytes.length === 0) return "not-an-image";

  try {
    const { default: sharp } = await import("sharp");
    await sharp(bytes, { failOn: "none" }).metadata();
  } catch {
    return "not-an-image";
  }
  // The render that follows a successful check is moments away, so hand it the
  // bytes rather than making the player wait for a second download.
  writeMemo(url, bytes, now);
  return "ok";
}

/** Test seam: the memo is process-wide and would otherwise leak across cases. */
export function clearSignatureBackgroundMemo(): void {
  sourceMemo.clear();
}
