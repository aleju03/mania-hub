// The picture in the Discord bot's /rankings reply: one row per player with
// their rank, avatar, name, the board's value and their place beside it.
// Components V2 has no table, no aligned columns and one image slot per
// section, so the page is drawn here as play-banner.ts draws its strip: satori
// for the text, sharp for the avatars.
//
// The rows come in the URL, signed by the backend with the bridge token
// (`rankingsBoardUrl` in the backend's discord/format.ts), so a URL cannot put
// its own text on a board. The same standings make the same URL, which Discord
// and the CDN keep by URL: an unchanged board is drawn once.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createElement as h } from "react";

import { renderOgPng } from "./og-image-response";
import { ogFontList } from "./og-render";
import { UNKNOWN_FLAG_URL, getCountryFlagLargeUrl } from "./country";

export const RANKINGS_BOARD_WIDTH = 1040;
const ROW_HEIGHT = 68;
const PAD_Y = 6;
const PAD_X = 30;
const RANK_WIDTH = 54;
const AVATAR_SIZE = 48;
const AVATAR_GAP = 20;
const MAX_ROWS = 12;
const PLACE_WIDTH = 170;
// A dan board keeps a column for the badges, so they line up under each other.
const EMBLEM_SLOT = 62;
const EMBLEM_SIZE = 46;
const FLAG_WIDTH = 42;
const FLAG_HEIGHT = 28;
const VALUE_SIZE = 32;
// Torus digits differ in width; each gets the same box so numbers line up.
const DIGIT_WIDTH = 20;
const BACKGROUND = { r: 30, g: 31, b: 36 };
const RANK_COLORS: Record<number, string> = { 1: "#f5c542", 2: "#c9ced6", 3: "#d08a52" };

const FETCH_TIMEOUT_MS = 5_000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export interface RankingsBoardRow {
  rank: number;
  userId: number;
  name: string;
  /** What the board ranks by, written out: "17,141pp", "Delta++", "35.80". */
  value: string;
  /** Beside it: the global rank on a country's board, the country on the Global one. */
  place: string;
  /** A dan board's badge, drawn after the dan's name. */
  emblem?: RankingsBoardEmblem | null;
}

export interface RankingsBoardEmblem {
  label: string;
  family: "dan" | "ln";
  keyCount: number;
}

function readEmblem(raw: unknown): RankingsBoardEmblem | null {
  const [label, family, keys] = String(raw ?? "").split("|");
  const keyCount = Number(keys);
  if (!label || !/^[a-z0-9+\-]{1,14}$/.test(label) || !Number.isInteger(keyCount) || keyCount <= 0 || keyCount > 18) return null;
  return { label, family: family === "ln" ? "ln" : "dan", keyCount };
}

export function signRankingsBoard(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("hex").slice(0, 24);
}

/** The rows of a signed URL, or null when the signature or the payload is not the backend's. */
export function readRankingsBoard(payload: string | null, signature: string | null, key: string | undefined): RankingsBoardRow[] | null {
  if (!payload || !signature || !key || payload.length > 4000) return null;
  const expected = Buffer.from(signRankingsBoard(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.slice(0, MAX_ROWS).map((row) => {
      const [rank, userId, name, value, place, emblem] = row as unknown[];
      return {
        rank: Number(rank),
        userId: Number(userId),
        name: String(name ?? "").slice(0, 24),
        value: String(value ?? "").slice(0, 16),
        place: String(place ?? "").slice(0, 12),
        emblem: emblem == null ? null : readEmblem(emblem),
      };
    }).filter((row) => Number.isSafeInteger(row.rank) && Number.isSafeInteger(row.userId) && row.userId > 0);
  } catch {
    return null;
  }
}

// A number with every digit in a box of one width; other text as it is.
function valueText(text: string) {
  if (!/^[\d.,]+$/.test(text)) return [text];
  return [...text].map((char, index) => /\d/.test(char)
    ? h("div", { key: index, style: { display: "flex", justifyContent: "center", width: `${DIGIT_WIDTH}px` } }, char)
    : h("div", { key: index, style: { display: "flex" } }, char));
}

function rowElement(row: RankingsBoardRow, index: number, withEmblems: boolean, withFlag: boolean) {
  const pp = /^([\d,.]+)pp$/.exec(row.value);
  return h(
    "div",
    {
      key: index,
      style: {
        display: "flex",
        alignItems: "center",
        height: `${ROW_HEIGHT}px`,
        paddingLeft: `${PAD_X}px`,
        paddingRight: `${PAD_X}px`,
        borderTop: index ? "1px solid rgba(255,255,255,0.07)" : "1px solid rgba(255,255,255,0)",
      },
    },
    h("div", { key: "rank", style: { display: "flex", width: `${RANK_WIDTH}px`, fontSize: "30px", fontWeight: 900, color: RANK_COLORS[row.rank] ?? "#8b8e98" } }, String(row.rank)),
    // The avatar is laid over this gap by sharp.
    h("div", { key: "avatar", style: { display: "flex", width: `${AVATAR_SIZE + AVATAR_GAP}px` } }),
    h("div", { key: "name", style: { display: "flex", flexGrow: 1, fontSize: "30px", fontWeight: 900, color: "#fff" } }, row.name),
    h(
      "div",
      { key: "value", style: { display: "flex", alignItems: "baseline", justifyContent: "flex-end", width: "240px", fontSize: `${VALUE_SIZE}px`, fontWeight: 900, color: "#fff" } },
      ...valueText(pp ? pp[1] : row.value),
      pp ? h("div", { key: "unit", style: { display: "flex", fontSize: "20px", marginLeft: "2px", color: "#c5c7cf" } }, "pp") : null,
    ),
    // The badge is laid over this gap by sharp.
    withEmblems ? h("div", { key: "emblem", style: { display: "flex", width: `${EMBLEM_SLOT}px` } }) : null,
    h("div", { key: "place", style: { display: "flex", justifyContent: "flex-end", width: `${PLACE_WIDTH}px`, fontSize: "24px", fontWeight: 400, color: "#9a9da8" } }, withFlag ? "" : row.place),
  );
}

export type RankingsBoardEmblemArt = { source: Buffer; isSvg: boolean } | null;

/** Buffers in, PNG out. A missing avatar or badge leaves its spot empty. */
export async function drawRankingsBoard(
  rows: RankingsBoardRow[],
  avatars: Array<Buffer | null>,
  fonts: [ArrayBuffer, ArrayBuffer],
  emblems: RankingsBoardEmblemArt[] = [],
  flags: Array<Buffer | null> = [],
): Promise<Buffer> {
  const withEmblems = rows.some((row) => row.emblem);
  const { default: sharp } = await import("sharp");
  const height = rows.length * ROW_HEIGHT + PAD_Y * 2;
  const fontList = ogFontList(...fonts);
  const text = await renderOgPng(
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", width: `${RANKINGS_BOARD_WIDTH}px`, height: `${height}px`, paddingTop: `${PAD_Y}px`, fontFamily: fontList[0].name } },
      rows.map((row, index) => rowElement(row, index, withEmblems, Boolean(flags[index]))),
    ),
    { width: RANKINGS_BOARD_WIDTH, height, fonts: fontList },
  );
  const mask = Buffer.from(`<svg width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${AVATAR_SIZE / 2}" cy="${AVATAR_SIZE / 2}" r="${AVATAR_SIZE / 2}"/></svg>`);
  const layers: Array<{ input: Buffer; left: number; top: number }> = [{ input: text, left: 0, top: 0 }];
  for (const [index, source] of avatars.entries()) {
    if (!source || index >= rows.length) continue;
    try {
      const avatar = await sharp(source).resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
      layers.push({ input: avatar, left: PAD_X + RANK_WIDTH, top: PAD_Y + index * ROW_HEIGHT + Math.round((ROW_HEIGHT - AVATAR_SIZE) / 2) });
    } catch {
      // Left empty.
    }
  }
  for (const [index, art] of emblems.entries()) {
    if (!art || index >= rows.length) continue;
    try {
      const emblem = await sharp(art.source, art.isSvg ? { density: 300 } : undefined)
        .resize(EMBLEM_SIZE, EMBLEM_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      layers.push({
        input: emblem,
        left: RANKINGS_BOARD_WIDTH - PAD_X - PLACE_WIDTH - EMBLEM_SLOT + (EMBLEM_SLOT - EMBLEM_SIZE),
        top: PAD_Y + index * ROW_HEIGHT + Math.round((ROW_HEIGHT - EMBLEM_SIZE) / 2),
      });
    } catch {
      // Left empty.
    }
  }
  const flagMask = Buffer.from(`<svg width="${FLAG_WIDTH}" height="${FLAG_HEIGHT}"><rect width="${FLAG_WIDTH}" height="${FLAG_HEIGHT}" rx="3" ry="3"/></svg>`);
  for (const [index, source] of flags.entries()) {
    if (!source || index >= rows.length) continue;
    try {
      const flag = await sharp(source).resize(FLAG_WIDTH, FLAG_HEIGHT, { fit: "cover" }).composite([{ input: flagMask, blend: "dest-in" }]).png().toBuffer();
      layers.push({
        input: flag,
        left: RANKINGS_BOARD_WIDTH - PAD_X - FLAG_WIDTH,
        top: PAD_Y + index * ROW_HEIGHT + Math.round((ROW_HEIGHT - FLAG_HEIGHT) / 2),
      });
    } catch {
      // Left empty.
    }
  }
  return sharp({ create: { width: RANKINGS_BOARD_WIDTH, height, channels: 3, background: BACKGROUND } }).composite(layers).png().toBuffer();
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

// The host is fixed and only the ids come from the request.
export function fetchRankingsBoardAvatars(rows: RankingsBoardRow[]): Promise<Array<Buffer | null>> {
  return Promise.all(rows.map((row) => fetchImage(`https://a.ppy.sh/${row.userId}`)));
}

// The Global board's place is a country code; it is drawn as the flag. A
// fetch that fails leaves the code written out instead.
export async function fetchRankingsBoardFlags(rows: RankingsBoardRow[]): Promise<Array<Buffer | null>> {
  const byCode = new Map<string, Promise<Buffer | null>>();
  return Promise.all(rows.map((row) => {
    if (!/^[A-Z]{2}$/.test(row.place)) return null;
    const url = getCountryFlagLargeUrl(row.place);
    if (url === UNKNOWN_FLAG_URL) return null;
    let pending = byCode.get(row.place);
    if (!pending) {
      pending = fetchImage(url);
      byCode.set(row.place, pending);
    }
    return pending;
  }));
}
