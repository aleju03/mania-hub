// The picture a Recent plays or Dan clears feed post is: the difficulty's own
// background at the right, the play written over a fade at the left. An embed
// has no coloured text, no large numbers and one small image slot, so the whole
// post is drawn here, as play-banner.ts draws its strip: sharp for the
// photographs, satori for the text.
//
// The play rides in the URL, signed by the backend with the bridge token
// (`playCardUrl` in the backend's discord/format.ts), so a URL cannot put its
// own text on a card. A play makes one URL, which Discord and the CDN keep by.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createElement as h, type ReactNode } from "react";

import { extractBeatmapArchiveFileByRange } from "./beatmap-archive";
import { drawFramedAvatar } from "./og-avatar-frame";
import { renderOgPng } from "./og-image-response";
import { drawNameTag, type OgNameTag } from "./og-name-tag";
import { ogFontList } from "./og-render";
import { lookLayer, readOgSupporterLook, type OgLookSources, type OgSupporterLook } from "./og-supporter-look";
import { getCachedBeatmapAssetUrl, putBeatmapAssetAndGetUrl } from "./r2-cache";

export const PLAY_CARD_WIDTH = 1100;
const PLAY_HEIGHT = 472;
const DAN_HEIGHT = 540;

const PAD_X = 44;
const PAD_TOP = 36;
const PAD_BOTTOM = 32;
const AVATAR_SIZE = 52;
// The art takes the right 58%; the text column's fade ends inside it.
const ART_SHARE = 0.58;
const TEXT_WIDTH = 640;

const BACKGROUND = { r: 28, g: 23, b: 25 };
const BACKGROUND_RGB = `${BACKGROUND.r},${BACKGROUND.g},${BACKGROUND.b}`;
const MUTED = "#b9acb1";
const SOFT = "#f5d6e3";
const PINK = "#ff66ab";
const YELLOW = "#ffcc22";
const RED = "#ff7a85";
const HAIRLINE = "rgba(255,255,255,0.18)";

// The replay HUD's judgement colours (JUDGMENT_COLORS in ReplayCanvas.ts).
const HIT_COLORS = ["#b3f5ff", "#ffcc22", "#88da20", "#5a8fff", "#cc8800", "#ff4444"];
const HIT_LABELS = ["320", "300", "200", "100", "50", "miss"];

export type DanCardTier = "near" | "clear" | "overclear";
const TIER_HEADINGS: Record<DanCardTier, string> = { near: "Near clear", clear: "Clear", overclear: "Overclear" };
const TIER_COLORS: Record<DanCardTier, string> = { near: "#66ccff", clear: "#88da20", overclear: "#ffcc33" };

const GRADE_FILES: Record<string, string> = {
  X: "SS", SS: "SS", XH: "SS-Silver", SSH: "SS-Silver", S: "S", SH: "S-Silver", A: "A", B: "B", C: "C", D: "D", F: "F",
};

export interface PlayCardEmblem {
  label: string;
  family: "dan" | "ln";
  keyCount: number;
}

export interface PlayCardData {
  kind: "play" | "dan";
  userId: number;
  username: string;
  /** A supporter's name style, font, outline and avatar frame. */
  look: OgSupporterLook | null;
  beatmapsetId: number | null;
  /** The difficulty's background file in the set's archive. */
  background: string | null;
  title: string;
  /** The difficulty's name; a dan clear writes it after the title. */
  version: string;
  /** 0 to 100. */
  accuracy: number;
  grade: string;
  combo: number | null;
  fullCombo: boolean;
  pp: number | null;
  /** 320, 300, 200, 100, 50, miss. */
  hits: number[];
  mods: string[];
  stars: number | null;
  msd: number | null;
  skillset: string | null;
  /** "1.2x" when the play is not at 1.0. */
  rate: string | null;
  /** The chart's dan on a play, the course's level on a dan clear. */
  emblem: PlayCardEmblem | null;
  /** The app an imported play came through. */
  app: string | null;
  /** A failed play: the share of the chart reached, or 0 when unknown. Null for a pass. */
  failedAt: number | null;
  tier: DanCardTier | null;
  /** The pass bar and the best run before this one, 0 to 100. */
  bar: number | null;
  previous: number | null;
  /** A line under the course: the formula the accuracy is in, when the game showed another. */
  note: string | null;
  /** Beside a dan clear's heading: the keymode, the kind of chart and the level. */
  level: string[];
}

export function signPlayCard(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("hex").slice(0, 24);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
}

function number(value: unknown, min: number, max: number): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function readEmblem(raw: unknown): PlayCardEmblem | null {
  if (!Array.isArray(raw)) return null;
  const label = text(raw[0], 14).toLowerCase();
  const keyCount = Number(raw[2]);
  if (!/^[a-z0-9+\-]{1,14}$/.test(label) || !Number.isInteger(keyCount) || keyCount <= 0 || keyCount > 18) return null;
  return { label, family: raw[1] === "ln" ? "ln" : "dan", keyCount };
}

/** The play of a signed URL, or null when the signature or the payload is not the backend's. */
export function readPlayCard(payload: string | null, signature: string | null, key: string | undefined): PlayCardData | null {
  if (!payload || !signature || !key || payload.length > 1800) return null;
  const expected = Buffer.from(signPlayCard(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const userId = Number(raw.u);
    const accuracy = number(raw.a, 0, 100);
    const username = text(raw.n, 32);
    if (!Number.isSafeInteger(userId) || userId <= 0 || accuracy == null || !username) return null;
    const hits = Array.isArray(raw.h) ? raw.h.slice(0, 6).map((count) => number(count, 0, 10_000_000) ?? 0) : [];
    while (hits.length < 6) hits.push(0);
    const tier = raw.tier === "near" || raw.tier === "clear" || raw.tier === "overclear" ? raw.tier : null;
    const background = text(raw.bg, 260);
    return {
      kind: raw.k === "dan" && tier ? "dan" : "play",
      userId,
      username,
      look: readOgSupporterLook(raw.lk),
      beatmapsetId: number(raw.s, 1, Number.MAX_SAFE_INTEGER),
      background: background && !background.includes("..") ? background : null,
      title: text(raw.t, 160),
      version: text(raw.d, 120),
      accuracy,
      grade: text(raw.g, 3).toUpperCase(),
      combo: number(raw.c, 0, 10_000_000),
      fullCombo: raw.fc === 1,
      pp: number(raw.pp, 0, 100_000),
      hits,
      mods: Array.isArray(raw.m) ? raw.m.map((mod) => text(mod, 4).toLowerCase()).filter((mod) => /^[a-z0-9]{1,4}$/.test(mod)).slice(0, 6) : [],
      stars: number(raw.st, 0, 100),
      msd: number(raw.msd, 0, 100),
      skillset: text(raw.sk, 24) || null,
      rate: text(raw.r, 8) || null,
      emblem: readEmblem(raw.e),
      app: text(raw.app, 16) || null,
      failedAt: number(raw.fail, 0, 99),
      tier,
      bar: number(raw.bar, 0, 100),
      previous: number(raw.prev, 0, 100),
      note: text(raw.note, 80) || null,
      level: Array.isArray(raw.lv) ? raw.lv.map((part) => text(part, 24)).filter(Boolean).slice(0, 3) : [],
    };
  } catch {
    return null;
  }
}

export function playCardGradeFile(grade: string): string {
  return `GradeSmall-${GRADE_FILES[grade] ?? "F"}`;
}

export interface PlayCardParts {
  data: PlayCardData;
  /** The difficulty's background, or the set's cover when it could not be read. */
  art: Buffer | null;
  avatar: Buffer | null;
  emblem: { source: Buffer; isSvg: boolean } | null;
  /** The grade pill and the mod badges, as data URLs satori lays out with the text. */
  gradeIcon: string | null;
  modIcons: Array<string | null>;
  fonts: [ArrayBuffer, ArrayBuffer];
  /** The name fonts and frame art of a supporter's look; without them the look is not drawn. */
  lookSources?: OgLookSources;
  /** Set by drawPlayCard once the look is drawn: the room the player row keeps for it. */
  drawn?: { avatarGap: number; styledName: boolean };
}

type Style = Record<string, string | number>;

function row(key: string, style: Style, ...children: ReactNode[]) {
  return h("div", { key, style: { display: "flex", alignItems: "center", ...style } }, ...children);
}

function hairline(key: string, height: number) {
  return h("div", { key, style: { display: "flex", width: "2px", height: `${height}px`, margin: "0 16px", backgroundColor: HAIRLINE } });
}

function oneLine(key: string, value: string, style: Style) {
  return h("div", {
    key,
    style: { display: "block", maxWidth: `${TEXT_WIDTH}px`, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...style },
  }, value);
}

// Tracker Round has no star glyph.
function star(size: number) {
  return h("svg", { key: "star", width: size, height: size, viewBox: "0 0 24 24", style: { marginLeft: "5px" } },
    h("path", { d: "M12 1.6l3.2 6.6 7.2 1-5.2 5.1 1.2 7.2L12 18.1l-6.4 3.4 1.2-7.2L1.6 9.2l7.2-1z", fill: YELLOW }));
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

// Whole or half points lose their zeros ("96%"); an accuracy keeps two decimals.
function percent(value: number, decimals = 2): string {
  return `${decimals === 0 ? Number(value.toFixed(2)) : value.toFixed(decimals)}%`;
}

const NAME_SIZE = 30;
const NAME_WIDTH = 520;

// A supporter's name is drawn apart in its look and laid over the card (drawPlayCard): the row leaves it out.
function playerRow(data: PlayCardData, withAvatar: boolean, avatarGap: number, styledName: boolean) {
  return row("player", { height: `${AVATAR_SIZE}px` },
    withAvatar ? h("div", { key: "slot", style: { display: "flex", width: `${AVATAR_SIZE + avatarGap}px` } }) : null,
    styledName ? null : oneLine("name", data.username, { fontSize: `${NAME_SIZE}px`, fontWeight: 900, color: SOFT, maxWidth: `${NAME_WIDTH}px` }),
  );
}

// The grade, the accuracy, and beside it the pp over the combo with the mods.
function heroRow(parts: PlayCardParts, accSize: number, marginTop: number | string) {
  const { data } = parts;
  const mods = parts.modIcons.map((icon, index) => icon
    ? h("img", { key: `mod${index}`, src: icon, width: 54, height: 38, style: { marginLeft: index === 0 ? "14px" : "6px" } })
    : h("div", { key: `mod${index}`, style: { display: "flex", marginLeft: index === 0 ? "14px" : "8px", fontSize: "26px", fontWeight: 900, color: SOFT } }, data.mods[index]?.toUpperCase() ?? ""));
  const combo = data.combo != null ? `${count(data.combo)}x${data.fullCombo ? " FC" : ""}` : null;
  const pp = data.pp != null && data.pp > 0 ? `${count(data.pp)}pp` : null;
  const first = pp ?? combo;
  const second = pp ? combo : null;
  return row("hero", { height: `${accSize}px`, marginTop },
    parts.gradeIcon ? h("img", { key: "grade", src: parts.gradeIcon, width: 120, height: 60, style: { marginRight: "22px" } }) : null,
    h("div", { key: "acc", style: { display: "flex", fontSize: `${accSize}px`, lineHeight: 1, fontWeight: 900, color: "#fff", letterSpacing: "-1px" } }, percent(data.accuracy)),
    h("div", { key: "side", style: { display: "flex", flexDirection: "column", justifyContent: "center", marginLeft: "24px" } },
      first || mods.length
        ? row("first", { height: "44px" },
          first ? h("div", { key: "v", style: { display: "flex", fontSize: "42px", lineHeight: 1, fontWeight: 900, color: pp ? PINK : SOFT } }, first) : null,
          ...mods,
        )
        : null,
      second ? h("div", { key: "second", style: { display: "flex", marginTop: "4px", fontSize: "30px", lineHeight: 1, fontWeight: 900, color: SOFT } }, second) : null,
    ),
  );
}

function hitsRow(data: PlayCardData, marginTop: number) {
  return row("hits", { height: "60px", marginTop, alignItems: "flex-start" },
    ...data.hits.map((value, index) => h("div", { key: index, style: { display: "flex", flexDirection: "column", marginRight: "34px" } },
      h("div", { key: "n", style: { display: "flex", fontSize: "34px", lineHeight: 1, fontWeight: 900, color: HIT_COLORS[index]! } }, count(value)),
      h("div", { key: "l", style: { display: "flex", marginTop: "5px", fontSize: "21px", lineHeight: 1, color: MUTED } }, HIT_LABELS[index]!),
    )),
  );
}

function playBody(parts: PlayCardParts) {
  const { data } = parts;
  const meta: ReactNode[] = [];
  const add = (key: string, node: ReactNode) => {
    if (meta.length) meta.push(hairline(`${key}-rule`, 22));
    meta.push(node);
  };
  if (data.stars != null && data.stars > 0) add("stars", row("stars", { fontWeight: 900, color: YELLOW }, data.stars.toFixed(2), star(22)));
  if (data.msd != null && data.msd > 0) {
    add("msd", row("msd", {},
      h("div", { key: "l", style: { display: "flex" } }, "MSD"),
      h("div", { key: "v", style: { display: "flex", margin: "0 8px", fontWeight: 900, color: "#fff" } }, data.msd.toFixed(2)),
      data.skillset ? h("div", { key: "s", style: { display: "flex" } }, data.skillset) : null,
    ));
  }
  if (data.rate) add("rate", h("div", { key: "rate", style: { display: "flex" } }, data.rate));
  if (data.app) add("app", h("div", { key: "app", style: { display: "flex" } }, data.app));
  if (data.failedAt != null) {
    add("fail", h("div", { key: "fail", style: { display: "flex", fontWeight: 900, color: RED } }, data.failedAt > 0 ? `Failed at ${Math.round(data.failedAt)}%` : "Failed"));
  }
  return [
    playerRow(data, Boolean(parts.avatar), parts.drawn?.avatarGap ?? 18, Boolean(parts.drawn?.styledName)),
    oneLine("title", data.title, { marginTop: "22px", height: "46px", fontSize: "36px", lineHeight: "46px", fontWeight: 900, color: "#fff" }),
    data.version ? oneLine("version", data.version, { marginTop: "2px", height: "34px", fontSize: "26px", lineHeight: "34px", color: MUTED }) : null,
    meta.length ? row("meta", { marginTop: "4px", height: "34px", fontSize: "26px", color: MUTED }, ...meta) : null,
    heroRow(parts, 92, "auto"),
    hitsRow(data, 26),
  ];
}

const SCALE_WIDTH = 600;
const LABEL_WIDTH = 220;

// The run on a line that ends at 100%, with the pass bar marked on it.
function accuracyScale(data: PlayCardData, color: string) {
  const bar = data.bar ?? data.accuracy;
  const low = Math.max(0, Math.floor(Math.min(bar - 3, data.accuracy - 1)));
  const at = (value: number) => Math.round(Math.max(0, Math.min(1, (value - low) / (100 - low))) * SCALE_WIDTH);
  const tick = at(bar);
  const label = (key: string, left: number, value: string, justify: string) => h("div", {
    key,
    style: { display: "flex", justifyContent: justify, position: "absolute", top: "36px", left: `${left}px`, width: `${LABEL_WIDTH}px`, fontSize: "21px", lineHeight: 1, color: MUTED },
  }, value);
  return h("div", { key: "scale", style: { display: "flex", position: "relative", width: `${SCALE_WIDTH}px`, height: "60px", marginTop: "auto" } },
    h("div", { key: "track", style: { display: "flex", position: "absolute", top: "8px", left: "0px", width: `${SCALE_WIDTH}px`, height: "12px", borderRadius: "6px", backgroundColor: "rgba(255,255,255,0.14)" } }),
    h("div", { key: "fill", style: { display: "flex", position: "absolute", top: "8px", left: "0px", width: `${Math.max(12, at(data.accuracy))}px`, height: "12px", borderRadius: "6px", backgroundColor: color } }),
    h("div", { key: "tick", style: { display: "flex", position: "absolute", top: "0px", left: `${tick - 2}px`, width: "4px", height: "28px", borderRadius: "2px", backgroundColor: "#fff" } }),
    tick > SCALE_WIDTH * 0.3 ? label("low", 0, `${low}%`, "flex-start") : null,
    label("bar", Math.max(0, Math.min(SCALE_WIDTH - LABEL_WIDTH, tick - LABEL_WIDTH / 2)), `pass ${percent(bar, 0)}`, tick < LABEL_WIDTH / 2 ? "flex-start" : "center"),
    tick < SCALE_WIDTH * 0.72 ? label("high", SCALE_WIDTH - LABEL_WIDTH, "100%", "flex-end") : null,
  );
}

function danBody(parts: PlayCardParts) {
  const { data } = parts;
  const tier = data.tier ?? "clear";
  const context = [data.previous != null ? `Best before ${percent(data.previous)}` : null, data.note].filter(Boolean) as string[];
  return [
    playerRow(data, Boolean(parts.avatar), parts.drawn?.avatarGap ?? 18, Boolean(parts.drawn?.styledName)),
    row("tier", { marginTop: "28px", height: "32px", fontSize: "26px", color: MUTED },
      h("div", { key: "t", style: { display: "flex", fontSize: "30px", fontWeight: 900, color: TIER_COLORS[tier] } }, TIER_HEADINGS[tier]),
      ...data.level.flatMap((part, index) => [hairline(`rule${index}`, 22), h("div", { key: `l${index}`, style: { display: "flex" } }, part)]),
    ),
    heroRow(parts, 88, 8),
    oneLine("course", data.title, { marginTop: "12px", height: "34px", fontSize: "26px", lineHeight: "34px", fontWeight: 900, color: SOFT, maxWidth: "590px" }),
    data.version ? oneLine("version", data.version, { height: "30px", fontSize: "23px", lineHeight: "30px", color: MUTED, maxWidth: "590px" }) : null,
    context.length
      ? row("context", { height: "30px", fontSize: "23px", color: MUTED },
        ...context.flatMap((line, index) => [index ? hairline(`rule${index}`, 20) : null, h("div", { key: `c${index}`, style: { display: "flex" } }, line)]))
      : null,
    accuracyScale(data, TIER_COLORS[tier]),
    hitsRow(data, 20),
  ];
}

async function textOverlay(parts: PlayCardParts, height: number, withEmblem: boolean): Promise<Buffer> {
  const fontList = ogFontList(...parts.fonts);
  const isDan = parts.data.kind === "dan";
  const fill: Style = { display: "flex", position: "absolute", top: "0px", left: "0px", width: `${PLAY_CARD_WIDTH}px`, height: `${height}px` };
  return renderOgPng(
    h("div", { style: { display: "flex", position: "relative", width: `${PLAY_CARD_WIDTH}px`, height: `${height}px`, fontFamily: fontList[0].name } },
      // Solid under the text, thinning over the art so the picture stays a picture.
      h("div", {
        key: "fade",
        style: {
          ...fill,
          backgroundImage: `linear-gradient(90deg, rgba(${BACKGROUND_RGB},1) 0%, rgba(${BACKGROUND_RGB},1) 42%, rgba(${BACKGROUND_RGB},0.9) 55%, rgba(${BACKGROUND_RGB},0.42) 72%, rgba(${BACKGROUND_RGB},0.06) 100%)`,
        },
      }),
      // A play's badge sits in the corner on whatever the art has there.
      withEmblem && !isDan
        ? h("div", { key: "corner", style: { ...fill, backgroundImage: `radial-gradient(circle at 100% 100%, rgba(${BACKGROUND_RGB},0.85) 0%, rgba(${BACKGROUND_RGB},0.55) 16%, rgba(${BACKGROUND_RGB},0) 34%)` } })
        : null,
      h("div", {
        key: "body",
        style: {
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          top: "0px",
          left: `${PAD_X}px`,
          width: `${PLAY_CARD_WIDTH - PAD_X * 2}px`,
          height: `${height}px`,
          paddingTop: `${PAD_TOP}px`,
          paddingBottom: `${PAD_BOTTOM}px`,
        },
      }, ...(isDan ? danBody(parts) : playBody(parts))),
    ),
    { width: PLAY_CARD_WIDTH, height, fonts: fontList },
  );
}

const PLAY_EMBLEM = 150;
const DAN_EMBLEM = 380;

/** Buffers in, JPEG out. Missing art draws a flat card; a missing avatar or badge is left out. */
export async function drawPlayCard(parts: PlayCardParts): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const isDan = parts.data.kind === "dan";
  const height = isDan ? DAN_HEIGHT : PLAY_HEIGHT;
  const artWidth = Math.round(PLAY_CARD_WIDTH * ART_SHARE);
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];

  if (parts.art) {
    try {
      let art = sharp(parts.art).resize(artWidth, height, { fit: "cover", position: "centre" }).removeAlpha();
      // A dan clear's badge is the picture; the art goes behind it.
      if (isDan) art = art.modulate({ brightness: 0.5, saturation: 0.85 });
      layers.push({ input: await art.png({ compressionLevel: 0 }).toBuffer(), left: PLAY_CARD_WIDTH - artWidth, top: 0 });
    } catch {
      // A file sharp cannot read leaves the card flat.
    }
  }

  // A supporter's frame goes round their avatar, their name in its style and font.
  const sources = parts.lookSources;
  const look = parts.data.look;
  const framed = sources && look?.frame && parts.avatar
    ? await drawFramedAvatar({ avatar: parts.avatar, frame: look.frame, size: AVATAR_SIZE, round: true, room: { left: PAD_X - 6, top: PAD_TOP - 6, bottom: 24 }, loadArt: sources.loadArt })
    : null;
  // The gap after the avatar, wider when the frame's art reaches past it.
  const avatarGap = framed
    ? Math.max(18, Math.round(framed.width - framed.avatar.x - framed.avatar.size - (AVATAR_SIZE - framed.avatar.size) / 2) + 8)
    : 18;
  const nameTag: OgNameTag | null = sources && look?.name
    ? await drawNameTag({ name: parts.data.username, look: look.name, fontSize: NAME_SIZE, color: SOFT, maxWidth: NAME_WIDTH - (avatarGap - 18), fonts: sources.fonts })
    : null;

  let avatar: Buffer | null = null;
  if (parts.avatar && !framed) {
    const mask = Buffer.from(`<svg width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${AVATAR_SIZE / 2}" cy="${AVATAR_SIZE / 2}" r="${AVATAR_SIZE / 2}"/></svg>`);
    try {
      avatar = await sharp(parts.avatar)
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
        .composite([{ input: mask, blend: "dest-in" }])
        .png()
        .toBuffer();
    } catch {
      avatar = null;
    }
  }

  let emblem: Buffer | null = null;
  if (parts.emblem) {
    const size = isDan ? DAN_EMBLEM : PLAY_EMBLEM;
    try {
      emblem = await sharp(parts.emblem.source, parts.emblem.isSvg ? { density: isDan ? 300 : 150 } : undefined)
        .resize({ width: size, height: size, fit: "inside" })
        .png()
        .toBuffer();
    } catch {
      emblem = null;
    }
  }

  const hasAvatar = Boolean(avatar || framed);
  layers.push({ input: await textOverlay({ ...parts, avatar: hasAvatar ? parts.avatar : null, drawn: { avatarGap, styledName: Boolean(nameTag) } }, height, Boolean(emblem)), left: 0, top: 0 });
  if (avatar) layers.push({ input: avatar, left: PAD_X, top: PAD_TOP });
  if (framed) {
    // Centred where the bare avatar sits.
    const inset = (AVATAR_SIZE - framed.avatar.size) / 2;
    const layer = await lookLayer(framed.png, Math.round(PAD_X + inset - framed.avatar.x), Math.round(PAD_TOP + inset - framed.avatar.y), PLAY_CARD_WIDTH, height);
    if (layer) layers.push(layer);
  }
  if (nameTag) {
    const left = PAD_X + (hasAvatar ? AVATAR_SIZE + avatarGap : 0);
    const top = PAD_TOP + (AVATAR_SIZE - nameTag.line.height) / 2;
    const layer = await lookLayer(nameTag.png, Math.round(left - nameTag.line.x), Math.round(top - nameTag.line.y), PLAY_CARD_WIDTH, height);
    if (layer) layers.push(layer);
  }
  if (emblem) {
    const { width = 0, height: emblemHeight = 0 } = await sharp(emblem).metadata();
    layers.push(isDan
      ? { input: emblem, left: PLAY_CARD_WIDTH - 64 - width, top: Math.round((height - emblemHeight) / 2) }
      : { input: emblem, left: PLAY_CARD_WIDTH - 22 - width, top: height - 14 - emblemHeight });
  }

  return sharp({ create: { width: PLAY_CARD_WIDTH, height, channels: 3, background: BACKGROUND } })
    .composite(layers)
    .jpeg({ quality: 88 })
    .toBuffer();
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
// A background not read by then leaves the card on the set's cover; the pull
// goes on and stores the file, so the next card of the difficulty has it.
const BACKGROUND_WAIT_MS = 7_000;
const BACKGROUND_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

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

function backgroundMime(filename: string): string {
  const lower = filename.toLowerCase();
  return lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
}

const inFlightBackgrounds = new Map<string, Promise<Buffer | null>>();

// The difficulty's own background: a set has one cover, drawn from one of its
// difficulties, which on a pack of courses is another course's picture.
async function readDifficultyBackground(beatmapsetId: number, filename: string): Promise<Buffer | null> {
  if (!BACKGROUND_EXTENSIONS.some((extension) => filename.toLowerCase().endsWith(extension))) return null;
  const set = String(beatmapsetId);
  const cached = await getCachedBeatmapAssetUrl("background", set, filename).catch(() => null);
  if (cached) return fetchImage(cached.signedUrl);
  const key = `${set}:${filename}`;
  let pending = inFlightBackgrounds.get(key);
  if (!pending) {
    pending = (async () => {
      const buffer = await extractBeatmapArchiveFileByRange(set, filename);
      if (buffer.length === 0 || buffer.length > MAX_SOURCE_BYTES) return null;
      await putBeatmapAssetAndGetUrl("background", set, filename, backgroundMime(filename), buffer).catch(() => null);
      return buffer;
    })().catch(() => null).finally(() => {
      inFlightBackgrounds.delete(key);
    });
    inFlightBackgrounds.set(key, pending);
  }
  return Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), BACKGROUND_WAIT_MS).unref?.())]);
}

/** The card's art and the player's avatar. Both hosts are fixed; the filename is the backend's. */
export async function fetchPlayCardSources(data: PlayCardData): Promise<{ art: Buffer | null; avatar: Buffer | null }> {
  const art = async () => {
    if (!data.beatmapsetId) return null;
    const own = data.background ? await readDifficultyBackground(data.beatmapsetId, data.background) : null;
    return own ?? fetchImage(`https://assets.ppy.sh/beatmaps/${data.beatmapsetId}/covers/cover@2x.jpg`);
  };
  const [artBuffer, avatar] = await Promise.all([art(), fetchImage(`https://a.ppy.sh/${data.userId}`)]);
  return { art: artBuffer, avatar };
}
