import { CARD_MOTIF_PALETTES, type CardMotif, type CardMotifPalette } from "./card-motif";
import {
  DEFAULT_SUPPORTER_MOTIF,
  SUPPORTER_MOTIF_IDS,
  supporterMotifUrl,
  type SupporterMotifId,
} from "./supporter-motif-art";

/* How an active supporter's cards look, on every copy anyone holds.

   The backend attaches `supporterLook` to a card payload only while the
   player's supporter status is live, so its presence is the whole signal: a
   card that has one draws the holographic foil, floats the supporter's chosen
   motif and, when they picked one, paints in that palette. Unlike a holding's
   own motif (a grant, the milestone card, a legacy finish), the look belongs
   to the player, so it reaches every collector's copy at once.

   A holding's own motif still wins over the supporter's: that art was given to
   one collector's copy on purpose, and the foil rides on top of it either way. */

export { SUPPORTER_MOTIF_IDS, DEFAULT_SUPPORTER_MOTIF, type SupporterMotifId } from "./supporter-motif-art";

export const SUPPORTER_PALETTES = CARD_MOTIF_PALETTES;
export type SupporterPalette = CardMotifPalette;

export interface SupporterLook {
  /** A preset sprite, or "custom" for the supporter's own image. */
  motif: SupporterMotifId | "custom";
  /** Null keeps the tier's own colours. */
  palette: SupporterPalette | null;
  /** Only on "custom": the converted upload, and how large and strong it floats. */
  url?: string;
  scale?: number;
  opacity?: number;
}

/* A supporter's own image is converted on upload and stored content-addressed
   under supporter-motifs/ in the public image bucket; the backend refuses any
   other URL, and so does this, so a stray value never reaches a canvas. */
const CUSTOM_MOTIF_URL = /^https:\/\/[a-z0-9.-]+\/supporter-motifs\/[a-f0-9]{64}\.webp$/;
export const CUSTOM_MOTIF_SCALE_RANGE = [0.4, 3] as const;
export const CUSTOM_MOTIF_OPACITY_RANGE = [0.2, 1] as const;

export function isCustomMotifUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= 400 && CUSTOM_MOTIF_URL.test(value);
}

function clampTo(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : fallback;
}

interface SupporterMotifDefinition {
  id: SupporterMotifId;
  /** English label; the settings page wraps it for translation. */
  label: string;
  /** Multiplier on the fleck size, as CardMotif.scale. */
  scale: number;
  /** As CardMotif.opacity. */
  opacity: number;
}

/* Scale and opacity per shape: the busy sprites (notes, stellium) sit a little
   larger so their detail survives a thumbnail, the solid ones a little fainter
   so they stay behind the card's text. */
export const SUPPORTER_MOTIFS: readonly SupporterMotifDefinition[] = [
  { id: "stars", label: "Stars", scale: 0.9, opacity: 0.85 },
  { id: "notes", label: "Notes", scale: 1.0, opacity: 0.85 },
  { id: "stellium", label: "Stellium", scale: 0.95, opacity: 0.8 },
  { id: "petals", label: "Petals", scale: 0.9, opacity: 0.85 },
  { id: "feathers", label: "Feathers", scale: 1.0, opacity: 0.8 },
  { id: "hearts", label: "Hearts", scale: 0.85, opacity: 0.8 },
];

const MOTIFS_BY_ID = new Map(SUPPORTER_MOTIFS.map((motif) => [motif.id, motif]));

function isSupporterMotifId(value: unknown): value is SupporterMotifId {
  return typeof value === "string" && (SUPPORTER_MOTIF_IDS as readonly string[]).includes(value);
}

function isSupporterPalette(value: unknown): value is SupporterPalette {
  return typeof value === "string" && (SUPPORTER_PALETTES as readonly string[]).includes(value);
}

/* A look from an API payload, a stored row or a form. Null when there is none.

   An object is a supporter even if its fields are off: an unknown motif falls
   back to the default and an unknown palette to the tier's own colours, so a
   backend that grows a new motif before this build knows it still shows the
   card as a supporter's rather than as an ordinary one. */
export function parseSupporterLook(value: unknown): SupporterLook | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 400) return null;
    try {
      return parseSupporterLook(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const palette = isSupporterPalette(raw.palette) ? raw.palette : null;
  if (raw.motif === "custom" && isCustomMotifUrl(raw.url)) {
    return {
      motif: "custom",
      palette,
      url: raw.url,
      scale: clampTo(raw.scale, CUSTOM_MOTIF_SCALE_RANGE, 1),
      opacity: clampTo(raw.opacity, CUSTOM_MOTIF_OPACITY_RANGE, 0.85),
    };
  }
  return {
    motif: isSupporterMotifId(raw.motif) ? raw.motif : DEFAULT_SUPPORTER_MOTIF,
    palette,
  };
}

/* The motif a look floats, in the shape every card surface already draws. */
export function supporterLookMotif(look: SupporterLook | null | undefined): CardMotif | null {
  const parsed = parseSupporterLook(look);
  if (!parsed) return null;
  if (parsed.motif === "custom" && parsed.url) {
    return {
      url: parsed.url,
      scale: parsed.scale ?? 1,
      opacity: parsed.opacity ?? 0.85,
      ...(parsed.palette ? { palette: parsed.palette } : {}),
    };
  }
  const definition = MOTIFS_BY_ID.get(parsed.motif as SupporterMotifId) ?? MOTIFS_BY_ID.get(DEFAULT_SUPPORTER_MOTIF)!;
  return {
    url: supporterMotifUrl(definition.id),
    scale: definition.scale,
    opacity: definition.opacity,
    ...(parsed.palette ? { palette: parsed.palette } : {}),
  };
}

/* Identity of a look for cache keys. Empty for a card without one, so a key
   that appends it only moves for supporters' cards. */
export function supporterLookSignature(look: SupporterLook | null | undefined): string {
  const parsed = parseSupporterLook(look);
  if (!parsed) return "";
  /* A custom image names itself by its content hash, so a new upload, or a
     new size or strength, is a new key. Dots, not colons: the OG key turns the
     one colon into a dash. */
  const motif = parsed.motif === "custom" && parsed.url
    ? `custom.${parsed.url.slice(parsed.url.lastIndexOf("/") + 1, -5).slice(0, 16)}.${parsed.scale}.${parsed.opacity}`
    : parsed.motif;
  return `${motif}:${parsed.palette ?? "-"}`;
}

export interface EffectiveCardLook {
  /** What the card floats and which palette it paints in. */
  motif: CardMotif | null;
  /** Whether the holographic supporter foil is drawn. */
  foil: boolean;
}

/* Precedence, in one place: the holding's own motif wins whole (its palette
   included), else the supporter's motif and palette; the foil follows the look
   alone, so a supporter's granted copy keeps its art and still shines. */
export function effectiveCardLook(
  ownMotif: CardMotif | null | undefined,
  supporterLook: unknown,
): EffectiveCardLook {
  const look = parseSupporterLook(supporterLook);
  return {
    motif: ownMotif ?? supporterLookMotif(look),
    foil: look !== null,
  };
}
