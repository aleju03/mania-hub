import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/* Supporter card foils: the light that plays over every copy of an active
   supporter's card. A foil is light only, never a colour of its own, so a
   card keeps its tier's colours and a Legendary still has to be earned. The
   3D card draws each one in its overlay shader (cardShaders.ts, branch
   `uFoilStyle` = the id's index here); flat renders (pack thumbnails, share
   images) bake the holo still for all of them. The backend keeps the pick
   against the same ids (SUPPORTER_CARD_FOILS in features/supporters.ts). */

export const SUPPORTER_FOILS = ["holo", "cracked-ice", "glitter", "sunburst", "caustics", "note-rain", "scanline", "aurora"] as const;

export type SupporterFoilId = (typeof SUPPORTER_FOILS)[number];

export const DEFAULT_SUPPORTER_FOIL: SupporterFoilId = "holo";

export function isSupporterFoil(value: unknown): value is SupporterFoilId {
  return typeof value === "string" && (SUPPORTER_FOILS as readonly string[]).includes(value);
}

/* The shader's branch for a foil. */
export function supporterFoilIndex(id: SupporterFoilId): number {
  return SUPPORTER_FOILS.indexOf(id);
}

export const SUPPORTER_FOIL_LABELS: Record<SupporterFoilId, MessageDescriptor> = {
  holo: msg`Holo lattice`,
  "cracked-ice": msg`Cracked ice`,
  glitter: msg`Glitter`,
  sunburst: msg`Sunburst`,
  caustics: msg`Caustics`,
  "note-rain": msg`Note rain`,
  scanline: msg`Scanline`,
  aurora: msg`Aurora`,
};
