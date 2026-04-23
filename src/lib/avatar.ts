import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import sharp from "sharp";
import { getPersistentCacheEntries, getPersistentCacheEntry, setPersistentCache } from "./api";
import { getAvatarAccentCacheKey } from "./avatar-accent";

function edgeCache(sMaxage: number, swr?: number): void {
  const effectiveSwr = swr ?? sMaxage * 4;
  setResponseHeader(
    "Cache-Control",
    `public, s-maxage=${sMaxage}, stale-while-revalidate=${effectiveSwr}`,
  );
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface ColorBucket {
  count: number;
  color: RgbColor;
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

function getLightness(color: RgbColor): number {
  const { l } = rgbToHsl(color);
  return l;
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

function averageColors(entries: Array<{ color: RgbColor; weight: number }>): RgbColor | null {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return null;

  const weighted = entries.reduce(
    (sum, entry) => ({
      r: sum.r + entry.color.r * entry.weight,
      g: sum.g + entry.color.g * entry.weight,
      b: sum.b + entry.color.b * entry.weight,
    }),
    { r: 0, g: 0, b: 0 },
  );

  return {
    r: Math.round(weighted.r / totalWeight),
    g: Math.round(weighted.g / totalWeight),
    b: Math.round(weighted.b / totalWeight),
  };
}

function pickNeutralAccentColor(buckets: ColorBucket[]): string | null {
  const neutralCandidates = buckets
    .filter(({ color }) => {
      const luminance = getLuminance(color);
      return getSaturation(color) < 0.18 && luminance > 24 && luminance < 235;
    })
    .map((bucket) => {
      const lightness = getLightness(bucket.color);
      const midtoneWeight = 1 - Math.min(Math.abs(lightness - 0.5) / 0.5, 1);
      return {
        color: bucket.color,
        weight: bucket.count * (0.35 + midtoneWeight),
      };
    });

  const averaged = averageColors(neutralCandidates)
    ?? averageColors(buckets.map((bucket) => ({ color: bucket.color, weight: bucket.count })));

  return averaged ? normalizeForText(averaged) : null;
}

function pickAccentColor(buckets: ColorBucket[]): string | null {
  if (buckets.length === 0) return null;

  const totalPixels = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const chromaticBuckets = buckets.filter(({ color }) => {
    const luminance = getLuminance(color);
    const saturation = getSaturation(color);
    return luminance > 55 && luminance < 248 && saturation >= 0.2;
  });
  const chromaticPixels = chromaticBuckets.reduce((sum, bucket) => sum + bucket.count, 0);

  // Avatars that are almost entirely grayscale should stay neutral instead of
  // latching onto a tiny colored patch.
  if (chromaticPixels / Math.max(totalPixels, 1) < 0.12) {
    return pickNeutralAccentColor(buckets);
  }

  const hueGroups = new Map<number, Array<{ color: RgbColor; weight: number }>>();

  chromaticBuckets.forEach((bucket) => {
    const { h, s, l } = rgbToHsl(bucket.color);
    const hueBin = Math.floor(h * 12) % 12;
    const lightnessWeight = 1 - Math.min(Math.abs(l - 0.58) / 0.58, 1);
    const weight = bucket.count * (0.4 + s) * (0.35 + lightnessWeight);
    const existing = hueGroups.get(hueBin);

    if (existing) {
      existing.push({ color: bucket.color, weight });
    } else {
      hueGroups.set(hueBin, [{ color: bucket.color, weight }]);
    }
  });

  const bestGroup = [...hueGroups.values()]
    .sort((a, b) => {
      const aWeight = a.reduce((sum, entry) => sum + entry.weight, 0);
      const bWeight = b.reduce((sum, entry) => sum + entry.weight, 0);
      return bWeight - aWeight;
    })[0];

  const chosen = bestGroup
    ? averageColors(bestGroup)
    : averageColors(buckets.map((bucket) => ({ color: bucket.color, weight: bucket.count })));

  return chosen ? normalizeForText(chosen) : null;
}

function extractDominantColors(pixelData: Uint8Array | Buffer, channels: number): ColorBucket[] {
  const buckets = new Map<string, ColorBucket>();

  for (let i = 0; i < pixelData.length; i += channels) {
    const r = pixelData[i] ?? 0;
    const g = pixelData[i + 1] ?? 0;
    const b = pixelData[i + 2] ?? 0;
    const quantized: RgbColor = {
      r: clamp(Math.round(r / 16) * 16, 0, 255),
      g: clamp(Math.round(g / 16) * 16, 0, 255),
      b: clamp(Math.round(b / 16) * 16, 0, 255),
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
    .sort((a, b) => b.count - a.count);
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
  const buckets = extractDominantColors(data, info.channels);
  return pickAccentColor(buckets);
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
    edgeCache(86400, 604800);
    return getAvatarAccentCached(data.url);
  });

export const getAvatarAccents = createServerFn({ method: "GET" })
  .inputValidator((data: { urls: string[] }) => data)
  .handler(async ({ data }: { data: { urls: string[] } }) => {
    edgeCache(86400, 604800);
    const urls = [...new Set(data.urls)];
    const output: Record<string, string | null> = {};

    const cacheKeys = urls.map((url) => getAvatarAccentCacheKey(url));
    const keyToUrl = new Map(urls.map((url, i) => [cacheKeys[i], url]));
    const cached = await getPersistentCacheEntries<string | null>(cacheKeys);

    const missingUrls: string[] = [];
    for (const [cacheKey, url] of keyToUrl) {
      if (cached.has(cacheKey)) {
        output[url] = cached.get(cacheKey)!;
      } else {
        missingUrls.push(url);
      }
    }

    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(AVATAR_COLOR_CONCURRENCY, missingUrls.length) }, async () => {
        while (true) {
          const currentIndex = nextIndex++;
          if (currentIndex >= missingUrls.length) return;
          const url = missingUrls[currentIndex];
          try {
            const accent = await extractAvatarAccent(url);
            await setPersistentCache(getAvatarAccentCacheKey(url), accent, AVATAR_ACCENT_CACHE_TTL);
            output[url] = accent;
          } catch {
            output[url] = null;
          }
        }
      }),
    );

    return output;
  });
