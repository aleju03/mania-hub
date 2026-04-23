import { createFileRoute } from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_TITLE_LEN = 38;
const MAX_SUBTITLE_LEN = 150;
const SUBTITLE_LINE_CHARS = 58;
const SUBTITLE_MAX_LINES = 2;

const cache = new Map<string, Promise<Buffer>>();
const CACHE_MAX_ENTRIES = 64;
let fontCss: string | null = null;

function clamp(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function readFontBase64(fileName: string): string | null {
  for (const fontPath of [
    join(process.cwd(), "public", "fonts", fileName),
    join(process.cwd(), ".output", "public", "fonts", fileName),
    join(process.cwd(), "dist", "fonts", fileName),
  ]) {
    try {
      return readFileSync(fontPath).toString("base64");
    } catch {
      // Try the next likely deployment output path.
    }
  }

  return null;
}

function getFontCss(): string {
  if (fontCss !== null) return fontCss;

  const regular = readFontBase64("Torus-Regular.otf");
  const heavy = readFontBase64("Torus-Heavy.otf");
  if (!regular || !heavy) {
    fontCss = "";
    return fontCss;
  }

  fontCss = `<style>
    @font-face {
      font-family: "Torus OG";
      src: url(data:font/otf;base64,${regular}) format("opentype");
      font-weight: 400;
    }
    @font-face {
      font-family: "Torus OG";
      src: url(data:font/otf;base64,${heavy}) format("opentype");
      font-weight: 900;
    }
  </style>`;
  return fontCss;
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) lines.push(current);
    current = word;

    if (lines.length === maxLines) break;
  }

  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
  }

  return lines;
}

function buildSvg(title: string, subtitle: string): Buffer {
  const safeTitle = escapeXml(title);
  const subtitleLines = wrapText(subtitle, SUBTITLE_LINE_CHARS, SUBTITLE_MAX_LINES);
  const subtitleMarkup = subtitleLines
    .map((line, index) => `<tspan x="0" dy="${index === 0 ? 0 : 42}">${escapeXml(line)}</tspan>`)
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    ${getFontCss()}
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1517"/>
      <stop offset="100%" stop-color="#2a1a26"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.25" cy="0.3" r="0.6">
      <stop offset="0%" stop-color="#ff66aa" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#ff66aa" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <g transform="translate(80, 80)">
    <rect x="0" y="0" width="60" height="6" rx="3" fill="#ff66aa"/>
    <text x="0" y="56" fill="#ff99cc" font-family="Torus OG, Arial, sans-serif" font-size="28" font-weight="900" letter-spacing="4">O!MANIA TRACKER</text>
  </g>
  <g transform="translate(80, 260)">
    <text fill="#ffffff" font-family="Torus OG, Arial, sans-serif" font-size="82" font-weight="900">${safeTitle}</text>
  </g>
  ${subtitleMarkup ? `<g transform="translate(80, 380)">
    <text fill="#c7b8c1" font-family="Torus OG, Arial, sans-serif" font-size="34" font-weight="400">${subtitleMarkup}</text>
  </g>` : ""}
  <g transform="translate(80, 540)">
    <text fill="#7a6b74" font-family="Torus OG, Arial, sans-serif" font-size="22" font-weight="400">osu!mania rankings | top plays | replays</text>
  </g>
</svg>`;

  return Buffer.from(svg);
}

async function renderImage(title: string, subtitle: string): Promise<Buffer> {
  const svg = buildSvg(title, subtitle);
  return sharp(svg).png().toBuffer();
}

function getImage(title: string, subtitle: string): Promise<Buffer> {
  const key = `${title}::${subtitle}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  const promise = renderImage(title, subtitle);
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

export const Route = createFileRoute("/api/og")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const title = clamp(url.searchParams.get("title"), MAX_TITLE_LEN) || "o!mania tracker";
        const subtitle = clamp(url.searchParams.get("subtitle"), MAX_SUBTITLE_LEN) ||
          "Rankings, scores, top plays, maps, and replays by country.";

        try {
          const buffer = await getImage(title, subtitle);
          return new Response(new Uint8Array(buffer), {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Length": String(buffer.length),
              "Cache-Control":
                "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "OG image generation failed";
          return new Response(message, { status: 500 });
        }
      },
    },
  },
});
