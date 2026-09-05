/* The image a hand-granted maniacard floats in its background instead of the
   triangle flecks or starfield its tier would draw. Mirrors
   src/lib/card-motif.ts on the frontend, which is where the shape is
   documented; this copy exists because the backend never imports from src/.

   The admin grant desk writes motifs. Legacy crafted finishes remain readable. The wallet sync
   path does not read the field at all, so a client cannot put a URL on a card:
   normalizeCard never builds one and the ownership upsert never names the
   column, which leaves whatever the grant wrote in place.

   Bounded here rather than trusted, because these URLs are handed to browsers
   and to the OG renderer, and a stored row can be older than the rules. */

export const CARD_MOTIF_PALETTES = ["gold", "prismatic", "aurora", "ember"] as const;
export type CardMotifPalette = (typeof CARD_MOTIF_PALETTES)[number];

export interface CardMotif {
  url: string;
  scale: number;
  opacity: number;
  /* A colour scheme replacing the tier's (the milestone's golden card). */
  palette?: CardMotifPalette;
}

export const CARD_MOTIF_URL_MAX_CHARS = 400;
export const CARD_MOTIF_JSON_MAX_CHARS = 600;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

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
    scale: clamp(raw.scale, 0.25, 4, 1),
    opacity: clamp(raw.opacity, 0.05, 1, 1),
    ...(palette ? { palette } : {}),
  };
}

/** The text a row stores, re-serialized from the parsed shape so the column can only hold bounded JSON. */
export function serializeCardMotif(motif: CardMotif | null): string | null {
  return motif ? JSON.stringify(motif) : null;
}
