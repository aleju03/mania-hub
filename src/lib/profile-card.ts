// The picture the Discord bot's /profile reply is when the caller asks for one:
// the player's standing at the left, their best plays on each map's cover at
// the right, their keymodes with their dans along the bottom. Drawn as
// play-card.ts draws a play: sharp for the photographs, satori for the rest.
//
// The profile rides in the URL, signed by the backend with the bridge token
// (`profileCardUrl` in the backend's discord/profile-card.ts), so a URL cannot
// put its own text on a card. A standing makes one URL, which Discord and the
// CDN keep by.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createElement as h, type ReactNode } from "react";

import { getCountryFlagLargeUrl, UNKNOWN_FLAG_URL } from "./country";
import { renderOgPng } from "./og-image-response";
import { ogFontList } from "./og-render";

export const PROFILE_CARD_WIDTH = 1100;
const PAD_X = 44;
// The player's column, and the plays beside it.
const LEFT = 400;
const INNER = LEFT - PAD_X - 30;
const BAND = 132;
const BAND_GAP = 4;
export const PROFILE_CARD_PLAYS = 4;
const BANDS_HEIGHT = PROFILE_CARD_PLAYS * BAND + (PROFILE_CARD_PLAYS - 1) * BAND_GAP;
const ART_WIDTH = 330;
// Keymodes sit three to a line.
const MODES_PER_LINE = 3;
export const PROFILE_CARD_MODES = 6;
const MODE_LINE = 76;
const EMBLEM = 72;

const BACKGROUND = { r: 28, g: 23, b: 25 };
const BAND_RGB = "40,33,36";
const MUTED = "#b9acb1";
const SOFT = "#f5d6e3";
const PINK = "#ff66ab";
const HAIRLINE = "rgba(255,255,255,0.18)";

export interface ProfileCardPlay {
  pp: number | null;
  /** 0 to 100. */
  accuracy: number;
  grade: string;
  mods: string[];
  title: string;
  version: string;
  beatmapsetId: number | null;
}

export interface ProfileCardMode {
  keyCount: number;
  overall: number | null;
  /** The dan labels whose badges are drawn, as the emblem route names them. */
  rice: string | null;
  ln: string | null;
}

export interface ProfileCardData {
  userId: number;
  username: string;
  countryCode: string | null;
  pp: number | null;
  globalRank: number | null;
  countryRank: number | null;
  playCount: number | null;
  /** 0 to 100. */
  accuracy: number | null;
  hoursPlayed: number | null;
  peakRank: number | null;
  /** Global rank, oldest first, over `historyDays`. */
  history: number[];
  historyDays: number | null;
  plays: ProfileCardPlay[];
  modes: ProfileCardMode[];
}

// The kind is signed with the payload: another picture's signed payload is not this one's.
export function signProfileCard(payload: string, key: string): string {
  return createHmac("sha256", key).update(`profile-card:${payload}`).digest("hex").slice(0, 24);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
}

function number(value: unknown, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function danLabel(value: unknown): string | null {
  const label = text(value, 14).toLowerCase();
  return /^[a-z0-9+\-]{1,14}$/.test(label) ? label : null;
}

function readPlay(raw: unknown): ProfileCardPlay | null {
  if (!Array.isArray(raw)) return null;
  const accuracy = number(raw[1], 0, 100);
  const title = text(raw[4], 80);
  if (accuracy == null || !title) return null;
  return {
    pp: number(raw[0], 0, 100_000),
    accuracy,
    grade: text(raw[2], 3).toUpperCase(),
    mods: text(raw[3], 40).toLowerCase().split(",").filter((mod) => /^[a-z0-9]{1,4}$/.test(mod)).slice(0, 4),
    title,
    version: text(raw[5], 80),
    beatmapsetId: number(raw[6], 1, Number.MAX_SAFE_INTEGER),
  };
}

function readMode(raw: unknown): ProfileCardMode | null {
  if (!Array.isArray(raw)) return null;
  const keyCount = Number(raw[0]);
  if (!Number.isInteger(keyCount) || keyCount <= 0 || keyCount > 18) return null;
  return { keyCount, overall: number(raw[1], 0, 100), rice: danLabel(raw[2]), ln: danLabel(raw[3]) };
}

// The first rank, then each day's change from the one before.
function readHistory(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 120) return [];
  const ranks: number[] = [];
  let rank = 0;
  for (const step of raw) {
    const value = Number(step);
    if (!Number.isFinite(value)) return [];
    rank += value;
    if (rank <= 0 || rank > 100_000_000) return [];
    ranks.push(rank);
  }
  return ranks;
}

/** The profile of a signed URL, or null when the signature or the payload is not the backend's. */
export function readProfileCard(payload: string | null, signature: string | null, key: string | undefined): ProfileCardData | null {
  if (!payload || !signature || !key || payload.length > 1900) return null;
  const expected = Buffer.from(signProfileCard(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const userId = Number(raw.u);
    const username = text(raw.n, 32);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !username) return null;
    const countryCode = text(raw.cc, 2).toUpperCase();
    const history = readHistory(raw.rh);
    return {
      userId,
      username,
      countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
      pp: number(raw.pp, 0, 1_000_000),
      globalRank: number(raw.gr, 1, 100_000_000),
      countryRank: number(raw.cr, 1, 100_000_000),
      playCount: number(raw.pc, 0, 100_000_000),
      accuracy: number(raw.a, 0, 100),
      hoursPlayed: number(raw.pt, 0, 1_000_000),
      peakRank: number(raw.pk, 1, 100_000_000),
      history,
      historyDays: history.length ? number(raw.rd, 1, 1000) : null,
      plays: Array.isArray(raw.p) ? raw.p.slice(0, PROFILE_CARD_PLAYS).map(readPlay).filter((play): play is ProfileCardPlay => play != null) : [],
      modes: Array.isArray(raw.k) ? raw.k.slice(0, PROFILE_CARD_MODES).map(readMode).filter((mode): mode is ProfileCardMode => mode != null) : [],
    };
  } catch {
    return null;
  }
}

export interface ProfileCardEmblem {
  source: Buffer;
  isSvg: boolean;
}

export interface ProfileCardParts {
  data: ProfileCardData;
  avatar: Buffer | null;
  flag: Buffer | null;
  /** Each play's map cover, in the plays' order. */
  covers: Array<Buffer | null>;
  /** Each keymode's badges, in the keymodes' order. */
  emblems: Array<{ rice: ProfileCardEmblem | null; ln: ProfileCardEmblem | null }>;
  /** The grade pills and the mod badges of each play, as data URLs satori lays out with the text. */
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
const rule = (height: number, margin: number) => box({ width: "2px", height: `${height}px`, margin: `0 ${margin}px`, backgroundColor: HAIRLINE });
const oneLine = (value: string, style: Style) => h("div", {
  style: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.25, ...style },
}, value);
const at = (top: number, left: number, width: number, height: number): Style => ({
  position: "absolute", top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px`,
});

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function ppText(value: number, size: number) {
  return row({ alignItems: "baseline" },
    label(count(value), { fontSize: `${size}px`, fontWeight: 900, color: "#fff", letterSpacing: size >= 60 ? "-1px" : "0px" }),
    label("pp", { marginLeft: `${Math.max(3, Math.round(size / 12))}px`, fontSize: `${Math.round(size * 0.6)}px`, fontWeight: 900, color: PINK }),
  );
}

function rankText(value: number, place: string, size: number) {
  return row({ alignItems: "baseline" },
    label(`#${count(value)}`, { fontSize: `${size}px`, fontWeight: 900, color: "#fff" }),
    label(place, { marginLeft: "10px", fontSize: `${Math.round(size * 0.62)}px`, color: MUTED }),
  );
}

// A long name is set smaller, so the flag stays on its line.
function nameSize(username: string): number {
  return username.length <= 9 ? 34 : username.length <= 12 ? 28 : 22;
}

function nameRow(data: ProfileCardData, avatar: string | null, flag: string | null) {
  const size = nameSize(data.username);
  const flagWidth = Math.round(size * 1.05);
  // The widest names still end before the flag.
  const room = INNER - (avatar ? 86 : 0) - (flag ? flagWidth + 14 : 0);
  return row({ height: "68px" },
    avatar ? image(avatar, 68, 68, { marginRight: "18px" }) : null,
    oneLine(data.username, { maxWidth: `${room}px`, fontSize: `${size}px`, fontWeight: 900, color: SOFT }),
    flag ? image(flag, flagWidth, Math.round(size * 0.7), { marginLeft: "14px" }) : null,
  );
}

// Both ranks share a line while they fit the column; longer ones take a line each.
function ranksFitOneLine(data: ProfileCardData): boolean {
  if (data.globalRank == null || data.countryRank == null) return true;
  return count(data.globalRank).length + count(data.countryRank).length <= 7;
}

function ranks(data: ProfileCardData) {
  const global = data.globalRank != null ? rankText(data.globalRank, "global", 34) : null;
  const country = data.countryRank != null && data.countryCode ? rankText(data.countryRank, data.countryCode, 34) : null;
  if (!global && !country) return label("Unranked", { marginTop: "12px", fontSize: "28px", color: MUTED });
  if (global && country && !ranksFitOneLine(data)) return col({ marginTop: "12px" }, global, box({ height: "6px" }), country);
  return row({ marginTop: "12px" }, global, global && country ? rule(28, 14) : null, country);
}

// Lower is better, so the line climbs as the rank improves.
function rankGraph(history: number[], width: number, height: number) {
  const low = Math.min(...history);
  const high = Math.max(...history);
  const pad = 8;
  const points = history.map((value, index) => [
    pad + (index / (history.length - 1)) * (width - pad * 2),
    high === low ? height / 2 : pad + ((value - low) / (high - low)) * (height - pad * 2),
  ] as const);
  const d = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [endX, endY] = points[points.length - 1]!;
  return h("svg", { width, height, viewBox: `0 0 ${width} ${height}` },
    h("path", { d: `${d} L${endX.toFixed(1)} ${height} L${pad} ${height} Z`, fill: "rgba(255,102,171,0.12)" }),
    h("path", { d, stroke: PINK, strokeWidth: 4, fill: "none", strokeLinejoin: "round", strokeLinecap: "round" }),
    h("circle", { cx: endX, cy: endY, r: 7, fill: "#fff" }),
  );
}

function stat(value: string, name: string) {
  return col({ width: "166px" },
    label(value, { fontSize: "30px", fontWeight: 900, color: "#fff" }),
    label(name, { marginTop: "6px", fontSize: "22px", color: MUTED }),
  );
}

// The room the player's column and the plays share: four plays' worth, less
// for a profile with little to show in either.
function standingHeight(data: ProfileCardData): number {
  const stats = [data.playCount, data.accuracy, data.hoursPlayed, data.peakRank].filter((value) => value != null).length;
  const stacked = data.globalRank != null && data.countryRank != null && !ranksFitOneLine(data);
  let column = 32 + 68 + 18;
  if (data.pp != null) column += 20 + 70;
  column += 12 + (stacked ? 74 : 34);
  if (data.history.length >= 2) column += 16 + (stacked ? 70 : 82) + 8 + 22;
  if (stats) column += 20 + 58;
  if (stats > 2) column += 14 + 58;
  const bands = data.plays.length * BAND + Math.max(0, data.plays.length - 1) * BAND_GAP;
  return Math.max(bands, Math.min(column, BANDS_HEIGHT));
}

function playerColumn(data: ProfileCardData, avatar: string | null, flag: string | null) {
  const stats = [
    data.playCount != null ? stat(count(data.playCount), "plays") : null,
    data.accuracy != null ? stat(`${data.accuracy.toFixed(2)}%`, "accuracy") : null,
    data.hoursPlayed != null ? stat(`${count(data.hoursPlayed)} h`, "played") : null,
    data.peakRank != null ? stat(`#${count(data.peakRank)}`, "peak rank") : null,
  ].filter(Boolean);
  const graph = data.history.length >= 2;
  return col({ ...at(0, PAD_X, INNER, standingHeight(data)), paddingTop: "32px", paddingBottom: "18px" },
    nameRow(data, avatar, flag),
    data.pp != null ? box({ marginTop: "20px" }, ppText(data.pp, 70)) : null,
    ranks(data),
    box({ marginTop: "auto" }),
    graph ? rankGraph(data.history, INNER, ranksFitOneLine(data) ? 82 : 70) : null,
    graph
      ? row({ marginTop: "8px", fontSize: "22px", color: MUTED },
        label(`#${count(data.history[0]!)}`, {}),
        data.historyDays ? label(`${data.historyDays} days`, { marginLeft: "auto", marginRight: "auto" }) : box({ marginLeft: "auto" }),
        label(`#${count(data.history[data.history.length - 1]!)}`, { fontWeight: 900, color: SOFT }),
      )
      : null,
    stats.length ? row({ marginTop: graph ? "20px" : "0px" }, ...stats.slice(0, 2)) : null,
    stats.length > 2 ? row({ marginTop: "14px" }, ...stats.slice(2)) : null,
  );
}

function playBand(play: ProfileCardPlay, index: number, gradeIcon: string | null, modIcons: Array<string | null>) {
  const width = PROFILE_CARD_WIDTH - LEFT;
  return box({ ...at(index * (BAND + BAND_GAP), LEFT, width, BAND) },
    // Solid under the text, thinning over the cover so the picture stays a picture.
    box({
      ...at(0, 0, width, BAND),
      backgroundImage: `linear-gradient(90deg, rgba(${BAND_RGB},1) 0%, rgba(${BAND_RGB},1) 54%, rgba(${BAND_RGB},0.86) 66%, rgba(${BAND_RGB},0.3) 86%, rgba(${BAND_RGB},0) 100%)`,
    }),
    col({ ...at(0, 30, 440, BAND), justifyContent: "center" },
      row({ height: "40px" },
        play.pp != null && play.pp > 0 ? box({ marginRight: "14px" }, ppText(play.pp, 40)) : null,
        label(`${play.accuracy.toFixed(2)}%`, { fontSize: "24px", fontWeight: 900, color: SOFT }),
        gradeIcon ? image(gradeIcon, 64, 32, { marginLeft: "14px" }) : null,
        ...play.mods.map((mod, modIndex) => modIcons[modIndex]
          ? image(modIcons[modIndex]!, 43, 30, { marginLeft: "8px" })
          : label(mod.toUpperCase(), { marginLeft: "10px", fontSize: "22px", fontWeight: 900, color: SOFT })),
      ),
      oneLine(play.title, { maxWidth: "420px", marginTop: "8px", fontSize: "27px", fontWeight: 900, color: "#fff" }),
      play.version ? oneLine(play.version, { maxWidth: "420px", fontSize: "22px", color: MUTED }) : null,
    ),
  );
}

// A keymode on one line: its rating and, where its ladder has art, its dans.
function modeCell(mode: ProfileCardMode, index: number, emblems: { rice: string | null; ln: string | null } | undefined) {
  return row({},
    index ? rule(40, 24) : null,
    label(`${mode.keyCount}K`, { fontSize: "28px", fontWeight: 900, color: PINK }),
    mode.overall != null && mode.overall > 0 ? label(mode.overall.toFixed(2), { marginLeft: "12px", fontSize: "34px", fontWeight: 900, color: "#fff" }) : null,
    emblems?.rice ? image(emblems.rice, EMBLEM, EMBLEM, { marginLeft: "8px" }) : null,
    emblems?.ln ? image(emblems.ln, EMBLEM, EMBLEM, { marginLeft: emblems.rice ? "0px" : "8px" }) : null,
  );
}

function modeLines<T>(modes: T[]): T[][] {
  const lines: T[][] = [];
  for (let index = 0; index < modes.length; index += MODES_PER_LINE) lines.push(modes.slice(index, index + MODES_PER_LINE));
  return lines;
}

export function profileCardHeight(data: ProfileCardData): number {
  const lines = modeLines(data.modes).length;
  return standingHeight(data) + (lines ? lines * MODE_LINE + 24 : 0);
}

function pngUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

/** Buffers in, JPEG out. A missing cover leaves its band flat; a missing avatar, flag or badge is left out. */
export async function drawProfileCard(parts: ProfileCardParts): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const { data } = parts;
  const height = profileCardHeight(data);
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];

  for (const [index, cover] of parts.covers.slice(0, data.plays.length).entries()) {
    if (!cover) continue;
    try {
      const art = await sharp(cover).resize(ART_WIDTH, BAND, { fit: "cover", position: "centre" }).removeAlpha().png({ compressionLevel: 0 }).toBuffer();
      layers.push({ input: art, left: PROFILE_CARD_WIDTH - ART_WIDTH, top: index * (BAND + BAND_GAP) });
    } catch {
      // A file sharp cannot read leaves the band flat.
    }
  }

  const masked = async (source: Buffer | null, width: number, height: number, radius: number): Promise<string | null> => {
    if (!source) return null;
    const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></svg>`);
    try {
      return pngUrl(await sharp(source).resize(width, height, { fit: "cover" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer());
    } catch {
      return null;
    }
  };
  const badge = async (emblem: ProfileCardEmblem | null): Promise<string | null> => {
    if (!emblem) return null;
    try {
      return pngUrl(await sharp(emblem.source, emblem.isSvg ? { density: 150 } : undefined)
        .resize(EMBLEM * 2, EMBLEM * 2, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer());
    } catch {
      return null;
    }
  };
  const [avatar, flag, emblems] = await Promise.all([
    masked(parts.avatar, 136, 136, 68),
    masked(parts.flag, 72, 48, 8),
    Promise.all(data.modes.map(async (_mode, index) => ({ rice: await badge(parts.emblems[index]?.rice ?? null), ln: await badge(parts.emblems[index]?.ln ?? null) }))),
  ]);

  const lines = modeLines(data.modes.map((mode, index) => ({ mode, emblems: emblems[index] })));
  const fontList = ogFontList(...parts.fonts);
  const overlay = await renderOgPng(
    box({ position: "relative", width: `${PROFILE_CARD_WIDTH}px`, height: `${height}px`, fontFamily: fontList[0].name },
      playerColumn(data, avatar, flag),
      ...data.plays.map((play, index) => playBand(play, index, parts.gradeIcons[index] ?? null, parts.modIcons[index] ?? [])),
      lines.length
        ? col({ ...at(standingHeight(data), PAD_X, PROFILE_CARD_WIDTH - PAD_X * 2, height - standingHeight(data)), justifyContent: "center" },
          ...lines.map((line) => row({ height: `${MODE_LINE}px`, justifyContent: "center" }, ...line.map((cell, index) => modeCell(cell.mode, index, cell.emblems)))),
        )
        : null,
    ),
    { width: PROFILE_CARD_WIDTH, height, fonts: fontList },
  );
  layers.push({ input: overlay, left: 0, top: 0 });

  return sharp({ create: { width: PROFILE_CARD_WIDTH, height, channels: 3, background: BACKGROUND } })
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

/** The avatar, the flag and each play's cover. The hosts are fixed; only ids and a country code come from the card. */
export async function fetchProfileCardSources(data: ProfileCardData): Promise<{ avatar: Buffer | null; flag: Buffer | null; covers: Array<Buffer | null> }> {
  const flagUrl = data.countryCode ? getCountryFlagLargeUrl(data.countryCode) : UNKNOWN_FLAG_URL;
  const [avatar, flag, covers] = await Promise.all([
    fetchImage(`https://a.ppy.sh/${data.userId}`),
    flagUrl === UNKNOWN_FLAG_URL ? null : fetchImage(flagUrl),
    Promise.all(data.plays.map((play) => play.beatmapsetId ? fetchImage(`https://assets.ppy.sh/beatmaps/${play.beatmapsetId}/covers/cover@2x.jpg`) : null)),
  ]);
  return { avatar, flag, covers };
}
