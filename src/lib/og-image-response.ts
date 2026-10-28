// Replaces @vercel/og's ImageResponse: satori for layout, then the native
// resvg build for the raster. @vercel/og rasterized through sharp (librsvg)
// whenever sharp was installed, which it is here; resvg is what satori's SVG
// is written for, and native resvg ran every dynamic render about 3.5x faster
// than sharp in total and up to 30x on the activity calendars. renderAsync
// keeps the raster on libuv's thread pool, off the event loop.
//
// The fallback fonts and emoji are @vercel/og's: a glyph the given fonts lack
// (a CJK or Arabic username, an emoji) is fetched from Google Fonts or
// Twemoji once and memoized for the process.

import type { ReactNode } from "react";
import satori, { type SatoriOptions } from "satori";

type OgFont = SatoriOptions["fonts"][number];

export interface OgImageOptions {
  width: number;
  height: number;
  /** Leave out only for a picture with no text in it. */
  fonts?: OgFont[];
}

const LANGUAGE_FONTS: Record<string, string | string[]> = {
  "ja-JP": "Noto+Sans+JP",
  "ko-KR": "Noto+Sans+KR",
  "zh-CN": "Noto+Sans+SC",
  "zh-TW": "Noto+Sans+TC",
  "zh-HK": "Noto+Sans+HK",
  "th-TH": "Noto+Sans+Thai",
  "bn-IN": "Noto+Sans+Bengali",
  "ar-AR": "Noto+Sans+Arabic",
  "ta-IN": "Noto+Sans+Tamil",
  "ml-IN": "Noto+Sans+Malayalam",
  "he-IL": "Noto+Sans+Hebrew",
  "te-IN": "Noto+Sans+Telugu",
  devanagari: "Noto+Sans+Devanagari",
  kannada: "Noto+Sans+Kannada",
  symbol: ["Noto+Sans+Symbols", "Noto+Sans+Symbols+2"],
  math: "Noto+Sans+Math",
  unknown: "Noto+Sans",
};

// Google Fonts answers with TTF only to an old Safari, and with the
// unicode-range blocks the detector reads only to a modern Chrome.
const TTF_USER_AGENT = "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";
const RANGES_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";

type CodeRange = number | [number, number];
const rangesByFont: Record<string, CodeRange[]> = {};

async function loadFontRanges(fonts: string[]): Promise<void> {
  const missing = fonts.filter((font) => !rangesByFont[font]);
  if (missing.length === 0) return;
  const params = missing.map((font) => `family=${font}&`).join("") + "display=swap";
  const css = await (await fetch(`https://fonts.googleapis.com/css2?${params}`, {
    headers: { "User-Agent": RANGES_USER_AGENT },
  })).text();
  for (const [, family, range] of css.matchAll(/font-family:\s*'(.+?)';.+?unicode-range:\s*(.+?);/gms)) {
    const font = family!.replaceAll(" ", "+");
    (rangesByFont[font] ??= []).push(...range!.split(", ").map((part): CodeRange => {
      const [start, end] = part.replaceAll("U+", "").split("-").map((hex) => parseInt(hex, 16));
      return Number.isNaN(end) || end === undefined ? start! : [start!, end];
    }));
  }
}

async function textByFont(text: string, fonts: string[]): Promise<Record<string, string>> {
  await loadFontRanges(fonts);
  const result: Record<string, string> = {};
  for (const segment of text) {
    const code = segment.codePointAt(0);
    if (!code) continue;
    const font = fonts.find((name) => rangesByFont[name]?.some((range) =>
      typeof range === "number" ? code === range : range[0] <= code && code <= range[1]));
    if (font) result[font] = (result[font] ?? "") + segment;
  }
  return result;
}

async function loadGoogleFont(font: string, text: string): Promise<ArrayBuffer> {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${font}&text=${encodeURIComponent(text)}`, {
    headers: { "User-Agent": TTF_USER_AGENT },
  })).text();
  const resource = css.match(/src: url\((.+)\) format\('(opentype|truetype)'\)/);
  if (!resource) throw new Error("Failed to download dynamic font");
  const response = await fetch(resource[1]!);
  if (!response.ok) throw new Error(`Failed to download dynamic font. Status: ${response.status}`);
  return response.arrayBuffer();
}

function twemojiCode(char: string): string {
  const source = char.includes("‍") ? char : char.replace(/️/g, "");
  const codes: string[] = [];
  for (const symbol of source) codes.push(symbol.codePointAt(0)!.toString(16));
  return codes.join("-");
}

async function loadAsset(code: string, text: string): Promise<string | OgFont[]> {
  if (code === "emoji") {
    const response = await fetch(`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${twemojiCode(text)}.svg`);
    return `data:image/svg+xml;base64,${Buffer.from(await response.text()).toString("base64")}`;
  }
  const codes = code.split("|");
  const names = codes.flatMap((entry) => LANGUAGE_FONTS[entry] ?? []);
  if (names.length === 0) return [];
  try {
    const split = await textByFont(text, names);
    const fonts = Object.keys(split);
    const data = await Promise.all(fonts.map((font) => loadGoogleFont(font, split[font]!)));
    return data.map((entry, index) => ({
      name: `satori_${codes[index]}_fallback_${text}`,
      data: entry,
      weight: 400,
      style: "normal",
      lang: codes[index] === "unknown" ? undefined : codes[index],
    }));
  } catch {
    return [];
  }
}

const assetCache = new Map<string, Promise<string | OgFont[]>>();

function loadAdditionalAsset(code: string, text: string): Promise<string | OgFont[]> {
  const key = `${code}\u0000${text}`;
  const cached = assetCache.get(key);
  if (cached) return cached;
  const promise = loadAsset(code, text);
  assetCache.set(key, promise);
  promise.catch(() => assetCache.delete(key));
  return promise;
}

export async function renderOgPng(element: ReactNode, options: OgImageOptions): Promise<Buffer> {
  const svg = await satori(element, {
    width: options.width,
    height: options.height,
    fonts: options.fonts ?? [],
    loadAdditionalAsset,
  });
  // satori turns every glyph into a path, so resvg needs no fonts of its own;
  // scanning the system's would cost ~70ms a render.
  const { renderAsync } = await import("@resvg/resvg-js");
  const image = await renderAsync(svg, {
    fitTo: { mode: "width", value: options.width },
    font: { loadSystemFonts: false },
  });
  return image.asPng();
}

export class ImageResponse extends Response {
  constructor(element: ReactNode, options: OgImageOptions) {
    super(new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(new Uint8Array(await renderOgPng(element, options)));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }), {
      headers: {
        "content-type": "image/png",
        "cache-control": process.env.NODE_ENV === "development" ? "no-cache, no-store" : "public, immutable, no-transform, max-age=31536000",
      },
    });
  }
}
