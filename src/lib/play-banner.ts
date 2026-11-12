// The strip at the top of the Discord bot's top play post: the beatmap's cover
// with the player's avatar and name on it. Components V2 has no small image
// slot beside text, so the two are drawn into one picture here.
//
// sharp does the photographs and satori only the name, which keeps a render
// near 30ms; a full satori card with two embedded photos is several times that.

import { createElement as h } from "react";

import { renderOgPng } from "./og-image-response";
import { ogFontList } from "./og-render";

export const PLAY_BANNER_WIDTH = 1040;
export const PLAY_BANNER_HEIGHT = 128;

const AVATAR_SIZE = 78;
const AVATAR_RING = 4;
const AVATAR_LEFT = 26;
// Covers are 18:5. The strip is a slice of that, taken a little above the
// middle, where a cover's subject usually is.
const COVER_ASPECT = 500 / 1800;
const COVER_SLICE_AT = 0.38;
const FALLBACK_BACKGROUND = { r: 27, g: 28, b: 32 };

const FETCH_TIMEOUT_MS = 5_000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export interface PlayBannerParts {
  cover: Buffer | null;
  avatar: Buffer | null;
  username: string | null;
  fonts: [ArrayBuffer, ArrayBuffer];
}

async function nameOverlay(username: string, withAvatar: boolean, fonts: [ArrayBuffer, ArrayBuffer]): Promise<Buffer> {
  const ringSize = AVATAR_SIZE + AVATAR_RING * 2;
  const fontList = ogFontList(...fonts);
  return renderOgPng(
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          width: `${PLAY_BANNER_WIDTH}px`,
          height: `${PLAY_BANNER_HEIGHT}px`,
          backgroundImage: "linear-gradient(90deg, rgba(0,0,0,0.66) 0%, rgba(0,0,0,0.25) 55%, rgba(0,0,0,0) 100%)",
          fontFamily: fontList[0].name,
        },
      },
      withAvatar
        ? h("div", {
          key: "ring",
          style: {
            marginLeft: `${AVATAR_LEFT - AVATAR_RING}px`,
            width: `${ringSize}px`,
            height: `${ringSize}px`,
            borderRadius: "50%",
            backgroundColor: "rgba(255,255,255,0.92)",
          },
        })
        : null,
      h(
        "div",
        {
          key: "name",
          style: {
            marginLeft: withAvatar ? "22px" : `${AVATAR_LEFT}px`,
            fontSize: "44px",
            fontWeight: 900,
            color: "#fff",
            textShadow: "0 2px 6px rgba(0,0,0,0.7)",
          },
        },
        username,
      ),
    ),
    { width: PLAY_BANNER_WIDTH, height: PLAY_BANNER_HEIGHT, fonts: fontList },
  );
}

/** Buffers in, JPEG out. A missing cover draws a flat strip, a missing player draws the cover alone. */
export async function drawPlayBanner(parts: PlayBannerParts): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const fullHeight = Math.max(PLAY_BANNER_HEIGHT, Math.round(PLAY_BANNER_WIDTH * COVER_ASPECT));
  let base: Buffer | null = null;
  if (parts.cover) {
    try {
      base = await sharp(parts.cover)
        .resize(PLAY_BANNER_WIDTH, fullHeight, { fit: "cover" })
        .extract({ left: 0, top: Math.round((fullHeight - PLAY_BANNER_HEIGHT) * COVER_SLICE_AT), width: PLAY_BANNER_WIDTH, height: PLAY_BANNER_HEIGHT })
        .removeAlpha()
        .png({ compressionLevel: 0 })
        .toBuffer();
    } catch {
      base = null;
    }
  }
  const canvas = base
    ? sharp(base)
    : sharp({ create: { width: PLAY_BANNER_WIDTH, height: PLAY_BANNER_HEIGHT, channels: 3, background: FALLBACK_BACKGROUND } });

  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  if (parts.username) {
    let avatar: Buffer | null = null;
    if (parts.avatar) {
      const mask = Buffer.from(`<svg width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${AVATAR_SIZE / 2}" cy="${AVATAR_SIZE / 2}" r="${AVATAR_SIZE / 2}"/></svg>`);
      try {
        avatar = await sharp(parts.avatar)
          .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
          .composite([{ input: mask, blend: "dest-in" }])
          .png()
          .toBuffer();
      } catch {
        avatar = null;
      }
    }
    layers.push({ input: await nameOverlay(parts.username, Boolean(avatar), parts.fonts), left: 0, top: 0 });
    if (avatar) layers.push({ input: avatar, left: AVATAR_LEFT, top: Math.round((PLAY_BANNER_HEIGHT - AVATAR_SIZE) / 2) });
  }
  return canvas.composite(layers).jpeg({ quality: 88 }).toBuffer();
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > 0 && buffer.length <= MAX_SOURCE_BYTES ? buffer : null;
  } catch {
    return null;
  }
}

// Both hosts are fixed and only the numbers come from the request.
export function fetchPlayBannerSources(beatmapsetId: number, userId: number): Promise<[Buffer | null, Buffer | null]> {
  return Promise.all([
    fetchImage(`https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/cover@2x.jpg`),
    fetchImage(`https://a.ppy.sh/${userId}`),
  ]);
}
