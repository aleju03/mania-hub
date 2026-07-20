import { createFileRoute } from "@tanstack/react-router";
import sharp from "sharp";
import { getCountryFlagGradient, isGlobalScope, normalizeCountryScope } from "#/lib/country";
import { SITE_FAVICON_URL, SITE_FAVICON_VERSION } from "#/lib/seo";

const ICON_SIZE = 64;
const ARROW_SIZE = Math.round(ICON_SIZE * 0.62);
const ARROW_PAD = Math.round((ICON_SIZE - ARROW_SIZE) / 2);
const FLAG_FETCH_TIMEOUT_MS = 10_000;

// Inlined from public/images/notes/arrow-left-pink.png. Vercel doesn't bundle
// public/ into the serverless function (it's served by the CDN instead), so
// fs.readFile against process.cwd()+"/public" worked locally but threw ENOENT
// on prod, leaving the favicon endpoint returning a 500 and the tab icon
// missing. The asset is 1.8KB; embedding it as base64 keeps the function
// self-contained.
const ARROW_PNG_BASE64 =
  "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";
const ARROW_PNG_BUFFER = Buffer.from(ARROW_PNG_BASE64, "base64");

const iconCache = new Map<string, Promise<Buffer>>();
let arrowAlphaPromise: Promise<Buffer> | null = null;

async function loadArrowAlpha(): Promise<Buffer> {
  if (!arrowAlphaPromise) {
    arrowAlphaPromise = sharp(ARROW_PNG_BUFFER)
      .flop()
      .resize(ARROW_SIZE, ARROW_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({
        top: ARROW_PAD,
        bottom: ICON_SIZE - ARROW_SIZE - ARROW_PAD,
        left: ARROW_PAD,
        right: ICON_SIZE - ARROW_SIZE - ARROW_PAD,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    arrowAlphaPromise.catch(() => {
      arrowAlphaPromise = null;
    });
  }
  return arrowAlphaPromise;
}

function gradientToSvgBuffer(gradient: string): Buffer | null {
  const match = /^linear-gradient\(\s*(\d+)deg\s*,\s*(.+)\)\s*$/i.exec(gradient.trim());
  if (!match) return null;
  const deg = Number(match[1]);
  if (![0, 90, 180, 270].includes(deg)) return null;

  const stops: Array<{ color: string; offset: number }> = [];
  const stopRe = /(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s+(\d+(?:\.\d+)?)%/g;
  let m: RegExpExecArray | null;
  while ((m = stopRe.exec(match[2])) !== null) {
    stops.push({ color: m[1], offset: Number(m[2]) });
  }
  if (stops.length < 2) return null;

  // CSS angle -> SVG vector: 0deg=up, 90deg=right, 180deg=down, 270deg=left
  const coords = deg === 0
    ? { x1: 0, y1: 1, x2: 0, y2: 0 }
    : deg === 90
    ? { x1: 0, y1: 0, x2: 1, y2: 0 }
    : deg === 180
    ? { x1: 0, y1: 0, x2: 0, y2: 1 }
    : { x1: 1, y1: 0, x2: 0, y2: 0 };

  const stopXml = stops
    .map((s) => `<stop offset="${s.offset}%" stop-color="${s.color}"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}"><defs><linearGradient id="g" x1="${coords.x1}" y1="${coords.y1}" x2="${coords.x2}" y2="${coords.y2}">${stopXml}</linearGradient></defs><rect width="${ICON_SIZE}" height="${ICON_SIZE}" fill="url(#g)"/></svg>`;
  return Buffer.from(svg);
}

async function fetchFlagPng(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLAG_FETCH_TIMEOUT_MS);
  return fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "mania-hub-favicon" },
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });
}

async function fetchFlagBuffer(code: string): Promise<Buffer> {
  // osu! is missing flag PNGs for a handful of countries (e.g. Curaçao), where
  // its endpoint 404s and the favicon would 500. Fall back to flagcdn's broader
  // set so those countries still get a rendered tab icon.
  const sources = [
    `https://osu.ppy.sh/images/flags/${code}.png`,
    `https://flagcdn.com/w320/${code.toLowerCase()}.png`,
  ];
  let lastStatus = 0;
  for (const url of sources) {
    const response = await fetchFlagPng(url);
    if (response.ok) {
      const ab = await response.arrayBuffer();
      return Buffer.from(ab);
    }
    lastStatus = response.status;
  }
  throw new Error(`Flag fetch failed for ${code}: ${lastStatus}`);
}

async function composeIcon(code: string): Promise<Buffer> {
  const gradient = getCountryFlagGradient(code);
  const gradientSvg = gradient ? gradientToSvgBuffer(gradient) : null;
  const sourceBuf = gradientSvg ?? (await fetchFlagBuffer(code));
  const flagBase = await sharp(sourceBuf)
    .resize(ICON_SIZE, ICON_SIZE, { fit: "cover", position: "center" })
    .ensureAlpha()
    .png()
    .toBuffer();

  const flagBright = await sharp(flagBase)
    .modulate({ brightness: 1.35, saturation: 1.4 })
    .png()
    .toBuffer();

  const arrowAlpha = await loadArrowAlpha();
  const brightArrow = await sharp(flagBright)
    .composite([{ input: arrowAlpha, blend: "dest-in" }])
    .png()
    .toBuffer();

  const dimLayer = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}"><rect width="${ICON_SIZE}" height="${ICON_SIZE}" fill="rgba(0,0,0,0.55)"/></svg>`,
  );
  const circleMask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}"><circle cx="${ICON_SIZE / 2}" cy="${ICON_SIZE / 2}" r="${ICON_SIZE / 2}" fill="white"/></svg>`,
  );

  return sharp(flagBase)
    .composite([
      { input: dimLayer, blend: "over" },
      { input: brightArrow, blend: "over" },
      { input: circleMask, blend: "dest-in" },
    ])
    .png()
    .toBuffer();
}

function getIcon(code: string): Promise<Buffer> {
  const cached = iconCache.get(code);
  if (cached) return cached;
  const promise = composeIcon(code);
  iconCache.set(code, promise);
  promise.catch(() => {
    iconCache.delete(code);
  });
  return promise;
}

export const Route = createFileRoute("/api/favicon")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = normalizeCountryScope(url.searchParams.get("code"));
        if (isGlobalScope(code)) {
          const iconUrl = new URL(SITE_FAVICON_URL, url.origin);
          iconUrl.searchParams.set("v", SITE_FAVICON_VERSION);
          return new Response(null, {
            status: 302,
            headers: {
              Location: iconUrl.toString(),
              "Cache-Control":
                "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
            },
          });
        }
        try {
          const buffer = await getIcon(code);
          return new Response(buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Length": String(buffer.length),
              "Cache-Control":
                "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Favicon generation failed";
          return new Response(message, { status: 500 });
        }
      },
    },
  },
});
