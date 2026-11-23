// The picture in the Discord bot's /top reply: a page of a player's plays, one
// band each on its map's cover, in the order the list was asked for (pp, dan,
// LN dan or MSD). Drawn as profile-card.ts draws its play bands: sharp for the
// covers and badges, satori for the rest.
//
// The rows ride in the URL, signed by the backend with the bridge token
// (`topBoardUrl` in the backend's discord/top-board.ts), so a URL cannot put
// its own text on a board. The same page makes the same URL, which Discord and
// the CDN keep by.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createElement as h, type ReactNode } from "react";

import { renderOgPng } from "./og-image-response";
import { ogFontList } from "./og-render";

export const TOP_BOARD_WIDTH = 1040;
const MAX_ROWS = 5;
const BAND = 120;
const BAND_GAP = 8;
const PAD_X = 26;
const PLACE_WIDTH = 58;
const VALUE_WIDTH = 272;
const ART_WIDTH = 400;
const EMBLEM = 76;

const BACKGROUND = { r: 30, g: 31, b: 36 };
const BAND_RGB = "41,42,49";
const MUTED = "#a3a6b1";
const SOFT = "#e3e5ec";
const PINK = "#ff66ab";
// The board's font has no star glyph.
const STAR = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#a3a6b1" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>').toString("base64")}`;
const PLACE_COLORS: Record<number, string> = { 1: "#f5c542", 2: "#c9ced6", 3: "#d08a52" };

export type TopBoardSort = "pp" | "dan" | "ln" | "msd";

export interface TopBoardRow {
  place: number;
  /** What the list is ordered by, written out: "978", "Gamma+", "28.41". */
  value: string;
  /** The dan badge beside a dan list's value, as the emblem route names it. */
  emblem: string | null;
  /** 0 to 100. */
  accuracy: number;
  grade: string;
  mods: string[];
  song: string;
  version: string;
  beatmapsetId: number | null;
  /** Beside the accuracy: the pp on a dan or MSD list, the stars on the pp one. */
  aside: string;
}

export interface TopBoardData {
  sort: TopBoardSort;
  /** The keymode, whose ladder the dan badges come from; 0 when unknown. */
  keyCount: number;
  rows: TopBoardRow[];
}

// The kind is signed with the payload: another picture's signed payload is not this one's.
export function signTopBoard(payload: string, key: string): string {
  return createHmac("sha256", key).update(`top-board:${payload}`).digest("hex").slice(0, 24);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
}

function number(value: unknown, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function readRow(raw: unknown): TopBoardRow | null {
  if (!Array.isArray(raw)) return null;
  const place = number(raw[0], 1, 100_000);
  const song = text(raw[6], 60);
  if (place == null || !song) return null;
  const emblem = text(raw[2], 14).toLowerCase();
  return {
    place,
    value: text(raw[1], 16),
    emblem: /^[a-z0-9+\-]{1,14}$/.test(emblem) ? emblem : null,
    accuracy: number(raw[3], 0, 100) ?? 0,
    grade: text(raw[4], 3).toUpperCase(),
    mods: text(raw[5], 40).toLowerCase().split(",").filter((mod) => /^[a-z0-9]{1,4}$/.test(mod)).slice(0, 4),
    song,
    // "[7K] Extra" says the keymode the whole page is in.
    version: text(raw[7], 60).replace(/^\[\d{1,2}K\]\s*/i, ""),
    beatmapsetId: number(raw[8], 1, Number.MAX_SAFE_INTEGER),
    aside: text(raw[9], 12),
  };
}

/** The board of a signed URL, or null when the signature or the payload is not the backend's. */
export function readTopBoard(payload: string | null, signature: string | null, key: string | undefined): TopBoardData | null {
  if (!payload || !signature || !key || payload.length > 1900) return null;
  const expected = Buffer.from(signTopBoard(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const sort: TopBoardSort = raw.s === "dan" || raw.s === "ln" || raw.s === "msd" ? raw.s : "pp";
    const rows = Array.isArray(raw.p) ? raw.p.slice(0, MAX_ROWS).map(readRow).filter((row): row is TopBoardRow => row != null) : [];
    return rows.length ? { sort, keyCount: number(raw.k, 1, 18) ?? 0, rows } : null;
  } catch {
    return null;
  }
}

export interface TopBoardArt {
  source: Buffer;
  isSvg: boolean;
}

export interface TopBoardParts {
  data: TopBoardData;
  /** Each row's map cover, in the rows' order. */
  covers: Array<Buffer | null>;
  /** Each row's dan badge, in the rows' order. */
  emblems: Array<TopBoardArt | null>;
  /** The grade pills and the mod badges of each row, as data URLs satori lays out with the text. */
  gradeIcons: Array<string | null>;
  modIcons: Array<Array<string | null>>;
  fonts: [ArrayBuffer, ArrayBuffer];
}

type Style = Record<string, string | number>;
type Child = ReactNode;

const box = (style: Style, ...children: Child[]) => h("div", { style: { display: "flex", ...style } }, ...children);
const row = (style: Style, ...children: Child[]) => box({ alignItems: "center", ...style }, ...children);
const col = (style: Style, ...children: Child[]) => box({ flexDirection: "column", ...style }, ...children);
const label = (value: string, style: Style) => box({ lineHeight: 1, ...style }, value);
const image = (src: string, width: number, height: number, style: Style = {}) => h("img", { src, width, height, style });
const oneLine = (value: string, style: Style) => h("div", {
  style: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.25, ...style },
}, value);
const at = (top: number, left: number, width: number, height: number): Style => ({
  position: "absolute", top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px`,
});

function count(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString("en-US") : value;
}

// The number the list is ordered by, the largest thing on the band.
function valueCell(sort: TopBoardSort, item: TopBoardRow, emblem: string | null) {
  if (sort === "pp") {
    return row({ alignItems: "baseline" },
      label(count(item.value), { fontSize: "50px", fontWeight: 900, color: "#fff" }),
      label("pp", { marginLeft: "4px", fontSize: "30px", fontWeight: 900, color: PINK }),
    );
  }
  if (sort === "msd") {
    return row({ alignItems: "baseline" },
      label(item.value, { fontSize: "50px", fontWeight: 900, color: "#fff" }),
      label("MSD", { marginLeft: "8px", fontSize: "24px", fontWeight: 900, color: PINK }),
    );
  }
  return row({},
    emblem ? image(emblem, EMBLEM, EMBLEM, { marginRight: "10px" }) : null,
    oneLine(item.value, { maxWidth: `${VALUE_WIDTH - (emblem ? EMBLEM + 10 : 0) - 12}px`, fontSize: emblem ? "36px" : "44px", fontWeight: 900, color: "#fff" }),
  );
}

function band(sort: TopBoardSort, item: TopBoardRow, index: number, emblem: string | null, gradeIcon: string | null, modIcons: Array<string | null>) {
  const textLeft = PLACE_WIDTH + VALUE_WIDTH;
  const textWidth = TOP_BOARD_WIDTH - PAD_X * 2 - textLeft - 110;
  return box({ ...at(index * (BAND + BAND_GAP), 0, TOP_BOARD_WIDTH, BAND) },
    // Solid under the text, thinning over the cover so the picture stays a picture.
    box({
      ...at(0, 0, TOP_BOARD_WIDTH, BAND),
      backgroundImage: `linear-gradient(90deg, rgba(${BAND_RGB},1) 0%, rgba(${BAND_RGB},1) 62%, rgba(${BAND_RGB},0.9) 74%, rgba(${BAND_RGB},0.55) 88%, rgba(${BAND_RGB},0.25) 100%)`,
    }),
    row({ ...at(0, PAD_X, PLACE_WIDTH, BAND) },
      label(String(item.place), { fontSize: "34px", fontWeight: 900, color: PLACE_COLORS[item.place] ?? "#8b8e98" }),
    ),
    row({ ...at(0, PAD_X + PLACE_WIDTH, VALUE_WIDTH, BAND) }, valueCell(sort, item, emblem)),
    col({ ...at(0, PAD_X + textLeft, textWidth, BAND), justifyContent: "center" },
      oneLine(item.song, { maxWidth: `${textWidth}px`, fontSize: "34px", fontWeight: 900, color: "#fff" }),
      row({ marginTop: "10px", height: "34px" },
        gradeIcon ? image(gradeIcon, 60, 30, { marginRight: "12px" }) : null,
        label(`${item.accuracy.toFixed(2)}%`, { flexShrink: 0, fontSize: "27px", fontWeight: 900, color: SOFT }),
        ...item.mods.map((mod, modIndex) => modIcons[modIndex]
          ? image(modIcons[modIndex]!, 43, 30, { marginLeft: "8px" })
          : label(mod.toUpperCase(), { marginLeft: "10px", fontSize: "25px", fontWeight: 900, color: SOFT })),
        item.aside && sort === "pp"
          ? row({ marginLeft: "18px", flexShrink: 0 }, label(item.aside, { fontSize: "26px", color: MUTED }), image(STAR, 20, 20, { marginLeft: "4px" }))
          : item.aside ? label(`${count(item.aside)}pp`, { marginLeft: "18px", fontSize: "26px", color: MUTED }) : null,
        item.version ? oneLine(item.version, { marginLeft: "18px", flexShrink: 1, fontSize: "26px", color: MUTED }) : null,
      ),
    ),
  );
}

export function topBoardHeight(data: TopBoardData): number {
  return data.rows.length * BAND + Math.max(0, data.rows.length - 1) * BAND_GAP;
}

function pngUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

/** Buffers in, JPEG out (the covers are photographs). A missing cover leaves its band flat; a missing badge or icon is left out. */
export async function drawTopBoard(parts: TopBoardParts): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const { data } = parts;
  const height = topBoardHeight(data);
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];

  for (const [index, cover] of parts.covers.slice(0, data.rows.length).entries()) {
    if (!cover) continue;
    try {
      const art = await sharp(cover).resize(ART_WIDTH, BAND, { fit: "cover", position: "centre" }).removeAlpha().png({ compressionLevel: 0 }).toBuffer();
      layers.push({ input: art, left: TOP_BOARD_WIDTH - ART_WIDTH, top: index * (BAND + BAND_GAP) });
    } catch {
      // A file sharp cannot read leaves the band flat.
    }
  }

  const emblems = await Promise.all(parts.emblems.slice(0, data.rows.length).map(async (art) => {
    if (!art) return null;
    try {
      return pngUrl(await sharp(art.source, art.isSvg ? { density: 150 } : undefined)
        .resize(EMBLEM * 2, EMBLEM * 2, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer());
    } catch {
      return null;
    }
  }));

  const fontList = ogFontList(...parts.fonts);
  const overlay = await renderOgPng(
    box({ position: "relative", width: `${TOP_BOARD_WIDTH}px`, height: `${height}px`, fontFamily: fontList[0].name },
      ...data.rows.map((item, index) => band(data.sort, item, index, emblems[index] ?? null, parts.gradeIcons[index] ?? null, parts.modIcons[index] ?? [])),
    ),
    { width: TOP_BOARD_WIDTH, height, fonts: fontList },
  );
  layers.push({ input: overlay, left: 0, top: 0 });

  return sharp({ create: { width: TOP_BOARD_WIDTH, height, channels: 3, background: BACKGROUND } })
    .composite(layers)
    .jpeg({ quality: 88 })
    .toBuffer();
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

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

/** Each row's map cover. The host is fixed; only the beatmapset ids come from the board. */
export function fetchTopBoardCovers(data: TopBoardData): Promise<Array<Buffer | null>> {
  return Promise.all(data.rows.map((item) => item.beatmapsetId ? fetchImage(`https://assets.ppy.sh/beatmaps/${item.beatmapsetId}/covers/cover@2x.jpg`) : null));
}
