import { createFileRoute } from "@tanstack/react-router";
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs/promises";
import { getCountryFlagGradient, normalizeCountryCode } from "#/lib/country";

const ICON_SIZE = 64;
const ARROW_SIZE = Math.round(ICON_SIZE * 0.62);
const ARROW_PAD = Math.round((ICON_SIZE - ARROW_SIZE) / 2);

const iconCache = new Map<string, Promise<Buffer>>();
let arrowAlphaPromise: Promise<Buffer> | null = null;

async function loadArrowAlpha(): Promise<Buffer> {
  if (!arrowAlphaPromise) {
    arrowAlphaPromise = (async () => {
      const arrowPath = path.join(process.cwd(), "public", "images", "notes", "arrow-left-pink.png");
      const raw = await fs.readFile(arrowPath);
      return sharp(raw)
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
    })();
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

async function fetchFlagBuffer(code: string): Promise<Buffer> {
  const response = await fetch(`https://osu.ppy.sh/images/flags/${code}.png`, {
    redirect: "follow",
    headers: { "User-Agent": "mania-hub-favicon" },
  });
  if (!response.ok) {
    throw new Error(`Flag fetch failed for ${code}: ${response.status}`);
  }
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
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
        const code = normalizeCountryCode(url.searchParams.get("code"));
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
