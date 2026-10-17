import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";


/* A supporter's packs cosmetics: the case the cards they own are kept in (a
   3D sleeve, toploader, magnetic case or graded slab around the card
   whenever it is lifted into the spotlight or turned over in a pack; never
   painted into the card's image, since the card is someone else's), the colour of their binder (their album,
   and their shelf when others visit it), the wrapper their packs are
   printed on, and the blade they open them with. All four are theirs alone, change
   nothing about a card's worth, and lapse with the status like the rest. The
   backend keeps the same ids (SUPPORTER_PACK_* in features/supporters.ts). */

export const SUPPORTER_CARD_SLEEVES = ["penny", "toploader", "onetouch", "slab"] as const;
export type SupporterCardSleeveId = (typeof SUPPORTER_CARD_SLEEVES)[number];

export const SUPPORTER_BINDERS = ["leather", "denim", "holo", "carbon", "zip"] as const;
export type SupporterBinderId = (typeof SUPPORTER_BINDERS)[number];

/* The foil the viewer's packs are printed on (packArt.ts draws each). */
export const SUPPORTER_WRAPPERS = ["holo", "playfield", "cassette", "envelope"] as const;
export type SupporterWrapperId = (typeof SUPPORTER_WRAPPERS)[number];

/* The blade a pack is opened with: its streak, sparks and sounds (packBlades.ts). */
export const SUPPORTER_BLADES = ["katana", "neon", "ember", "lightning"] as const;
export type SupporterBladeId = (typeof SUPPORTER_BLADES)[number];

export interface SupporterPackStyle {
  sleeve: SupporterCardSleeveId | null;
  binder: SupporterBinderId | null;
  wrapper: SupporterWrapperId | null;
  blade: SupporterBladeId | null;
}

export const NO_PACK_STYLE: SupporterPackStyle = { sleeve: null, binder: null, wrapper: null, blade: null };

export const SUPPORTER_CARD_SLEEVE_LABELS: Record<SupporterCardSleeveId, MessageDescriptor> = {
  penny: msg`Penny sleeve`,
  toploader: msg`Toploader`,
  onetouch: msg`Magnetic case`,
  slab: msg`Graded slab`,
};

export const SUPPORTER_BINDER_LABELS: Record<SupporterBinderId, MessageDescriptor> = {
  leather: msg`Leather`,
  denim: msg`Denim`,
  holo: msg`Holo`,
  carbon: msg`Carbon fiber`,
  zip: msg`Zip binder`,
};

export const SUPPORTER_WRAPPER_LABELS: Record<SupporterWrapperId, MessageDescriptor> = {
  holo: msg`Holo foil`,
  playfield: msg`Playfield`,
  cassette: msg`Cassette`,
  envelope: msg`Sealed envelope`,
};

export const SUPPORTER_BLADE_LABELS: Record<SupporterBladeId, MessageDescriptor> = {
  katana: msg`Katana`,
  neon: msg`Neon`,
  ember: msg`Ember`,
  lightning: msg`Lightning`,
};

export function isSupporterCardSleeve(value: unknown): value is SupporterCardSleeveId {
  return typeof value === "string" && (SUPPORTER_CARD_SLEEVES as readonly string[]).includes(value);
}

function pick<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? value as T : null;
}

export function parsePackStyle(value: unknown): SupporterPackStyle {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return NO_PACK_STYLE;
    }
  }
  if (!raw || typeof raw !== "object") return NO_PACK_STYLE;
  const style = raw as Record<string, unknown>;
  return {
    sleeve: pick(SUPPORTER_CARD_SLEEVES, style.sleeve),
    binder: pick(SUPPORTER_BINDERS, style.binder),
    wrapper: pick(SUPPORTER_WRAPPERS, style.wrapper),
    blade: pick(SUPPORTER_BLADES, style.blade),
  };
}
