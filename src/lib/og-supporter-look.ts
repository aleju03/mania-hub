// A supporter's look on the pictures the site draws for the Discord bot: the
// name tag style, name font and outline their name is set in (og-name-tag.ts)
// and the frame round their avatar (og-avatar-frame.ts). The backend puts it
// in the picture's signed payload as `lk` (its discord/supporter-look.ts), so
// a changed look is a new URL.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { OgFrame, OgFramedAvatar } from "./og-avatar-frame";
import { hasNameLook, type OgNameLook, type OgNameTag, type OgNameTagFonts } from "./og-name-tag";

export interface OgSupporterLook {
  name: OgNameLook | null;
  frame: OgFrame | null;
}

/** What a picture needs to draw a look: the name fonts and the frame art. */
export interface OgLookSources {
  fonts: OgNameTagFonts;
  /** A frame still's bytes, by site path or workshop URL. */
  loadArt: (source: string) => Promise<Buffer | null>;
}

const WORKSHOP_FRAME_HOST = "https://cdn.mania-tracker.com/frames";

function word(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/** The look in a payload's `lk`: style, font, outline, frame, then a workshop frame's art. Null when it names nothing drawable. */
export function readOgSupporterLook(raw: unknown): OgSupporterLook | null {
  if (!Array.isArray(raw)) return null;
  const name: OgNameLook = {
    style: word(raw[0], /^[a-z0-9-]{1,24}$/),
    font: word(raw[1], /^[a-z0-9]{1,20}$/),
    outline: word(raw[2], /^[0-9a-f]{6}[1-3]?$/),
  };
  const id = word(raw[3], /^[a-z0-9-]{1,40}$/);
  let frame: OgFrame | null = id ? { id, art: null } : null;
  if (id && /^u\d{1,12}$/.test(id)) {
    // A workshop frame is its art: without it there is nothing to draw.
    const art = Array.isArray(raw[4]) ? raw[4] : [];
    const still = word(art[0], /^[a-f0-9]{64}$/);
    const round = word(art[1], /^[a-f0-9]{64}$/);
    const overhang = art.slice(2, 6).map(Number);
    frame = still && overhang.length === 4 && overhang.every((side) => Number.isFinite(side) && side >= 0 && side <= 1)
      ? { id, art: { still: `${WORKSHOP_FRAME_HOST}/${still}.png`, round: round ? `${WORKSHOP_FRAME_HOST}/${round}.png` : null, overhang: overhang as [number, number, number, number] } }
      : null;
  }
  const named = hasNameLook(name) ? name : null;
  return named || frame ? { name: named, frame } : null;
}

/**
 * The look on a play banner's URL (`lk`, signed as `ls` with its player by the
 * backend's `bannerLookParams`), or null when it is missing or not the backend's.
 */
export function readBannerLook(payload: string | null, signature: string | null, userId: number, key: string | undefined): OgSupporterLook | null {
  if (!payload || !signature || !key || payload.length > 600) return null;
  const expected = Buffer.from(createHmac("sha256", key).update(`play-banner-look:${userId}:${payload}`).digest("hex").slice(0, 24));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return readOgSupporterLook(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export type { OgFramedAvatar, OgNameTag };

/**
 * A drawn name or framed avatar as a sharp layer at `left`, `top` of a picture
 * `width` by `height`, cut to the part that lands on it (a glow or a wing may
 * reach past the edge). Null when none of it does.
 */
export async function lookLayer(png: Buffer, left: number, top: number, width: number, height: number): Promise<{ input: Buffer; left: number; top: number } | null> {
  const { default: sharp } = await import("sharp");
  const meta = await sharp(png).metadata();
  const cut = {
    left: Math.max(0, -left),
    top: Math.max(0, -top),
    right: Math.min(meta.width ?? 0, width - left),
    bottom: Math.min(meta.height ?? 0, height - top),
  };
  if (cut.right <= cut.left || cut.bottom <= cut.top) return null;
  const whole = cut.left === 0 && cut.top === 0 && cut.right === meta.width && cut.bottom === meta.height;
  const input = whole ? png : await sharp(png).extract({ left: cut.left, top: cut.top, width: cut.right - cut.left, height: cut.bottom - cut.top }).png().toBuffer();
  return { input, left: left + cut.left, top: top + cut.top };
}
