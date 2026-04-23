import { createFileRoute } from "@tanstack/react-router";
import sharp from "sharp";

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_TITLE_LEN = 30;
const MAX_SUBTITLE_LEN = 140;

const cache = new Map<string, Promise<Buffer>>();
const CACHE_MAX_ENTRIES = 64;

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

function buildSvg(title: string, subtitle: string): Buffer {
  const safeTitle = escapeXml(title);
  const safeSubtitle = escapeXml(subtitle);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
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
    <text x="0" y="56" fill="#ff99cc" font-family="Inter, Arial, sans-serif" font-size="28" font-weight="600" letter-spacing="4">O!MANIA TRACKER</text>
  </g>
  <g transform="translate(80, 260)">
    <text fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="82" font-weight="900">${safeTitle}</text>
  </g>
  ${safeSubtitle ? `<g transform="translate(80, 380)">
    <text fill="#c7b8c1" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="400">${safeSubtitle}</text>
  </g>` : ""}
  <g transform="translate(80, 540)">
    <text fill="#7a6b74" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="500">osu!mania rankings · top plays · replays</text>
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
          "Country rankings, live scores, top plays, replays.";

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
