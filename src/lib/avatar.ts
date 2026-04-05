import { createServerFn } from "@tanstack/react-start";
import sharp from "sharp";
import { getPersistentCacheEntry, setPersistentCache } from "./api";
import { getAvatarAccentCacheKey } from "./avatar-accent";

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const AVATAR_COLOR_CONCURRENCY = 8;
const AVATAR_ACCENT_CACHE_TTL = 3 * 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rgbToHsl({ r, g, b }: RgbColor): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;

  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
      break;
  }

  return { h: h / 6, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): RgbColor {
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  };
}

function toHex({ r, g, b }: RgbColor): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function getLuminance({ r, g, b }: RgbColor): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getSaturation(color: RgbColor): number {
  const { s } = rgbToHsl(color);
  return s;
}

function normalizeForText(color: RgbColor): string {
  const { h, s, l } = rgbToHsl(color);
  if (s < 0.08) {
    return toHex(hslToRgb(0, 0, clamp(Math.max(l, 0.62), 0.58, 0.74)));
  }

  const normalized = hslToRgb(
    h,
    clamp(Math.max(s, 0.55), 0.55, 0.9),
    clamp(Math.max(l, 0.62), 0.58, 0.74),
  );

  return toHex(normalized);
}

function pickAccentColor(colors: RgbColor[]): string | null {
  const preferred = colors.find((color) => {
    const luminance = getLuminance(color);
    const saturation = getSaturation(color);
    return luminance > 45 && luminance < 220 && saturation > 0.18;
  });

  const fallback = colors.find((color) => {
    const luminance = getLuminance(color);
    return luminance > 30 && luminance < 235;
  });

  const chosen = preferred ?? fallback ?? colors[0];
  return chosen ? normalizeForText(chosen) : null;
}

function extractDominantColors(pixelData: Uint8Array | Buffer, channels: number): RgbColor[] {
  const buckets = new Map<string, { count: number; color: RgbColor }>();

  for (let i = 0; i < pixelData.length; i += channels) {
    const r = pixelData[i] ?? 0;
    const g = pixelData[i + 1] ?? 0;
    const b = pixelData[i + 2] ?? 0;
    const quantized: RgbColor = {
      r: Math.round(r / 16) * 16,
      g: Math.round(g / 16) * 16,
      b: Math.round(b / 16) * 16,
    };
    const key = `${quantized.r},${quantized.g},${quantized.b}`;
    const existing = buckets.get(key);

    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, {
        count: 1,
        color: quantized,
      });
    }
  }

  return [...buckets.values()]
    .sort((a, b) => {
      const saturationDelta = getSaturation(b.color) - getSaturation(a.color);
      if (Math.abs(saturationDelta) > 0.08) return saturationDelta;
      return b.count - a.count;
    })
    .slice(0, 6)
    .map((entry) => entry.color);
}

async function extractAvatarAccent(url: string): Promise<string | null> {
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname !== "a.ppy.sh") {
    return null;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch avatar: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const { data, info } = await sharp(buffer, { animated: false })
    .resize(24, 24, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colors = extractDominantColors(data, info.channels);
  return pickAccentColor(colors);
}

async function getAvatarAccentCached(url: string): Promise<string | null> {
  const cacheKey = getAvatarAccentCacheKey(url);
  const cached = await getPersistentCacheEntry<string | null>(cacheKey);
  if (cached.hit) return cached.value;

  const accent = await extractAvatarAccent(url);
  await setPersistentCache(cacheKey, accent, AVATAR_ACCENT_CACHE_TTL);
  return accent;
}

export const getAvatarAccent = createServerFn({ method: "GET" })
  .inputValidator((data: { url: string }) => data)
  .handler(async ({ data }: { data: { url: string } }) => {
    return getAvatarAccentCached(data.url);
  });

export const getAvatarAccents = createServerFn({ method: "GET" })
  .inputValidator((data: { urls: string[] }) => data)
  .handler(async ({ data }: { data: { urls: string[] } }) => {
    const urls = [...new Set(data.urls)];
    const output: Record<string, string | null> = {};
    let nextIndex = 0;

    await Promise.all(
      Array.from({ length: Math.min(AVATAR_COLOR_CONCURRENCY, urls.length) }, async () => {
        while (true) {
          const currentIndex = nextIndex++;
          if (currentIndex >= urls.length) return;

          const url = urls[currentIndex];

          try {
            output[url] = await getAvatarAccentCached(url);
          } catch {
            output[url] = null;
          }
        }
      }),
    );

    return output;
  });
