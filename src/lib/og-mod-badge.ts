// The site's mod badge, drawn for satori. Shared by the two PNG routes that
// name a play's mods: /api/signature (dynamic renders) and /api/og (the replay
// social card). Kept here rather than in either route so both draw the same
// shield from the same cache instead of one of them spelling the acronym out.

import { createElement as h } from "react";
import type { ReactNode } from "react";

import { MOD_BADGE_FILE_NAMES, MOD_BADGE_TYPE_COLORS } from "../components/ui/ModBadge";
import { getAssetOrigin } from "./origin";

/** What the caller knows about one mod: its acronym, plus a custom lazer rate
 *  when the play did not run at the mod's default speed. */
export interface ModBadgeInput {
  acronym: string;
  rate?: number;
}

export interface RenderModBadge {
  acronym: string;
  color: string;
  shape: string | null;
  glyph: string | null;
  /** Rate text for a custom-rate speed mod, or null at the mod's own rate. */
  tail: string | null;
  /** The recoloured tail shape the rate text sits on. */
  extender: string | null;
}

const recoloredModAssetCache = new Map<string, Promise<string | null>>();

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/* Browser badges tint two white SVG masks with CSS. Satori does not reliably
   implement masks, so the render fetches those same assets once and puts the
   colour into the SVG itself. Keeping them as image layers also preserves the
   site's exact shield and glyph instead of drawing a second approximation for
   the cards. */
export async function recoloredModAsset(request: Request, path: string, color: string): Promise<string | null> {
  const url = new URL(path, getAssetOrigin(request)).toString();
  const key = `${url}|${color}`;
  const cached = recoloredModAssetCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      const svg = (await response.text())
        .replaceAll('fill="white"', `fill="${color}"`)
        .replaceAll('stroke="white"', `stroke="${color}"`);
      return svgDataUrl(svg);
    } catch {
      return null;
    }
  })();
  recoloredModAssetCache.set(key, promise);
  promise.then((value) => {
    if (value == null) recoloredModAssetCache.delete(key);
  });
  return promise;
}

function scaleHex(color: string, factor: number, fallback: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return fallback;
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * factor).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

export function modGlyphColor(color: string): string {
  return scaleHex(color, 0.12, "#17121a");
}

/** The tail's darker fill. 26.3% of the badge colour is osu-framework's
 *  .Darken(2.8f), the same value osu-web's .mod__extender uses. */
function modTailColor(color: string): string {
  return scaleHex(color, 0.263, "#241b2a");
}

export async function loadRenderModBadges(
  request: Request,
  mods: Array<string | ModBadgeInput>,
): Promise<RenderModBadge[]> {
  return Promise.all(mods.map(async (raw) => {
    const input: ModBadgeInput = typeof raw === "string" ? { acronym: raw } : raw;
    const acronym = input.acronym.toUpperCase();
    const color = MOD_BADGE_TYPE_COLORS[acronym] ?? "#ff6666";
    const file = MOD_BADGE_FILE_NAMES[acronym];
    // Format matches the browser badge: two decimals and a multiplication sign.
    const tail = input.rate != null && Number.isFinite(input.rate) ? `${input.rate.toFixed(2)}x` : null;
    const [shape, glyph, extender] = await Promise.all([
      recoloredModAsset(request, "/images/badges/mods/mod-icon.svg", color),
      file
        ? recoloredModAsset(request, `/images/badges/mods/mod-${file}.svg`, modGlyphColor(color))
        : Promise.resolve(null),
      tail
        ? recoloredModAsset(request, "/images/badges/mods/mod-icon-extender.svg", modTailColor(color))
        : Promise.resolve(null),
    ]);
    return { acronym, color, shape, glyph, tail, extender };
  }));
}

/* The browser badge is 36x24 with a 100:70 mask centred inside it. The default
   is its 0.7x profile-card size, including the small transparent side gutters;
   callers that want it to stand where headline text did pass a taller badge. */
export function renderModBadge(badge: RenderModBadge, index: number, height = 16.8): ReactNode {
  const width = height * 1.5;
  const artWidth = (height * 10) / 7;
  const artLeft = (width - artWidth) / 2;
  const pill = h("div", {
    key: "pill",
    style: {
      display: "flex", alignItems: "center", justifyContent: "center", position: "relative",
      width: `${width}px`, height: `${height}px`, flexShrink: 0,
      background: badge.shape ? "transparent" : badge.color,
      borderRadius: badge.shape ? "0" : "6px",
    },
  }, [
    badge.shape
      ? h("img", {
        key: "shape", src: badge.shape, width: artWidth, height,
        style: { position: "absolute", top: "0", left: `${artLeft}px`, width: `${artWidth}px`, height: `${height}px` },
      })
      : h("div", { key: "shape" }),
    badge.glyph
      ? h("img", {
        key: "glyph", src: badge.glyph, width: artWidth, height,
        style: { position: "absolute", top: "0", left: `${artLeft}px`, width: `${artWidth}px`, height: `${height}px` },
      })
      : h("div", {
        key: "glyph",
        style: { position: "relative", fontSize: `${Math.round(height * 0.48)}px`, lineHeight: 1, fontWeight: 900, color: modGlyphColor(badge.color) },
      }, badge.acronym),
  ]);

  if (!badge.tail) {
    return h("div", { key: `${badge.acronym}-${index}`, style: { display: "flex", flexShrink: 0 } }, [pill]);
  }

  /* Dimensions cross-reference osu-web's .mod__extender: 2.2em wide, pulled
     0.5em under the pill, text at 0.5em, where 1em is the badge height. */
  const extenderWidth = Math.round(height * 2.2);
  const overlap = Math.round(height * 0.5);
  const fontSize = Math.round(height * 0.5 * Math.min(1, 5 / badge.tail.length));
  return h("div", {
    key: `${badge.acronym}-${index}`,
    style: { display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0 },
  }, [
    pill,
    h("div", {
      key: "tail",
      style: {
        display: "flex", position: "relative", alignItems: "center", justifyContent: "center",
        width: `${extenderWidth}px`, height: `${height}px`, marginLeft: `${-overlap}px`,
        // The left padding is the slice the pill overlaps, so centring inside
        // it puts the rate in the middle of the tail that is actually visible
        // rather than against its right edge.
        paddingLeft: `${overlap}px`, paddingRight: `${Math.round(height * 0.125)}px`, flexShrink: 0,
        background: badge.extender ? "transparent" : modTailColor(badge.color),
        borderRadius: badge.extender ? "0" : "6px",
      },
    }, [
      badge.extender ? h("img", {
        key: "shape", src: badge.extender, width: extenderWidth, height,
        style: { position: "absolute", top: "0", left: "0", width: `${extenderWidth}px`, height: `${height}px` },
      }) : null,
      h("div", {
        key: "text",
        style: { position: "relative", fontSize: `${fontSize}px`, lineHeight: 1, fontWeight: 900, color: badge.color },
      }, badge.tail),
    ]),
  ]);
}
