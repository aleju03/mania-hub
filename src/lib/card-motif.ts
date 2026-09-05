import { packFinishSvg } from "./card-finish-art";

/* The floating shape a maniacard's background drifts with.

   Every card front already has one: ordinary tiers scatter osu! triangle
   flecks, the cosmic tiers (World Class, Eternal, GOAT) drift a starfield
   instead. A motif replaces whichever of the two that card would have drawn
   with an image of the granter's choosing, so a card minted by hand from
   /admin/collections can float somebody's own picture.

   It belongs to one holding rather than to the card, the same way customLabel
   does: giving one collector a card that rains hearts must not repaint it on
   everyone else's shelf.

   The admin grant desk writes motifs. Legacy crafted finishes remain readable. The wallet sync path drops the field
   outright (see normalizeCard in the backend's pack-wallets.ts), which is why
   nothing here needs to defend against a forged motif reaching a render - by
   the time a URL is in a row, an admin typed it. What this module does defend
   against is a stored value that is old, hand-edited or simply wrong: parse
   returns null rather than handing a half-formed motif to a canvas. */

/* A palette a holding's look may swap in for its tier's own: the whole card
   wash, starfield, rim and badge colours, not just the floating image. The
   milestone's gold and legacy crafted finishes use these. Kept on the motif rather than as
   a column of its own because the motif is already "how this holding looks",
   and every surface that carries a motif carries this with it for free. */
export const CARD_MOTIF_PALETTES = ["gold", "prismatic", "aurora", "ember"] as const;
export type CardMotifPalette = (typeof CARD_MOTIF_PALETTES)[number];

export interface CardMotif {
  /** https URL of the image. Loaded through /api/card-motif, never directly. */
  url: string;
  /** Multiplier on the fleck size the tier would have drawn. */
  scale: number;
  /** How strongly the shape reads over the card background. */
  opacity: number;
  /** Colour scheme replacing the tier's, when the holding has one. */
  palette?: CardMotifPalette;
}

export const CARD_MOTIF_URL_MAX_CHARS = 400;
export const CARD_MOTIF_JSON_MAX_CHARS = 600;
export const CARD_MOTIF_SCALE_RANGE = [0.25, 4] as const;
export const CARD_MOTIF_OPACITY_RANGE = [0.05, 1] as const;

function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

/* An https image URL, or null. http is refused rather than upgraded: the page
   is https and a mixed-content image would be blocked by the browser anyway,
   so accepting one would only move the failure to render time. */
export function normalizeCardMotifUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CARD_MOTIF_URL_MAX_CHARS) return null;
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** A motif from a stored row, a form, or an API payload. Null when there isn't one. */
export function parseCardMotif(value: unknown): CardMotif | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > CARD_MOTIF_JSON_MAX_CHARS) return null;
    try {
      return parseCardMotif(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const url = normalizeCardMotifUrl(raw.url);
  if (!url) return null;
  const palette = (CARD_MOTIF_PALETTES as readonly string[]).includes(String(raw.palette))
    ? (raw.palette as CardMotifPalette)
    : undefined;
  return {
    url,
    scale: clamp(raw.scale, CARD_MOTIF_SCALE_RANGE, 1),
    opacity: clamp(raw.opacity, CARD_MOTIF_OPACITY_RANGE, 1),
    ...(palette ? { palette } : {}),
  };
}

export function serializeCardMotif(motif: CardMotif | null): string | null {
  return motif ? JSON.stringify(motif) : null;
}

/* Where the browser actually loads the image from.

   Never the stored URL directly: the card is painted into a 2D canvas and read
   back out (thumbnails, the reveal's tray art), so an image without CORS
   headers would taint the canvas and turn every toDataURL into a security
   error. The proxy adds the headers and is also the only thing that bounds the
   bytes a card can pull in. */
export function cardMotifImageSrc(motif: CardMotif): string {
  const svg = packFinishSvg(motif.url);
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : `/api/card-motif?src=${encodeURIComponent(motif.url)}`;
}

/* Identity of a motif for cache keys and render signatures. A card whose motif
   changed has to repaint, and its cached thumbnail has to miss. */
export function cardMotifSignature(motif: CardMotif | null | undefined): string {
  return motif ? `${motif.url}|${motif.scale}|${motif.opacity}${motif.palette ? `|${motif.palette}` : ""}` : "";
}
