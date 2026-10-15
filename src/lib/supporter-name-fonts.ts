import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/* Supporter name fonts: the typeface of an active supporter's name, wherever
   it shows, on its own or under a name tag style. Self-hosted open fonts in
   /fonts/name/ (licences beside them), declared as `name-font--<id>` in
   styles.css. The backend keeps the pick against the same ids
   (SUPPORTER_NAME_FONTS in features/supporters.ts). */

export const SUPPORTER_NAME_FONTS = [
  "pixel",
  "vt323",
  "orbitron",
  "unbounded",
  "bungee",
  "bebas",
  "righteous",
  "monoton",
  "marker",
  "pacifico",
  "cinzel",
  "playfair",
  "silkscreen",
  "audiowide",
  "russo",
  "blackops",
  "bangers",
  "luckiest",
  "creepster",
  "lobster",
  "rocksalt",
  "unifraktur",
  "abril",
  "majormono",
  "michroma",
  "rubikglitch",
  "shrikhand",
  "zendots",
] as const;

export type SupporterNameFontId = (typeof SUPPORTER_NAME_FONTS)[number];

export function isSupporterNameFont(value: unknown): value is SupporterNameFontId {
  return typeof value === "string" && (SUPPORTER_NAME_FONTS as readonly string[]).includes(value);
}

export const SUPPORTER_NAME_FONT_LABELS: Record<SupporterNameFontId, MessageDescriptor> = {
  pixel: msg`Arcade`,
  vt323: msg`Terminal`,
  orbitron: msg`Orbitron`,
  unbounded: msg`Wide`,
  bungee: msg`Block`,
  bebas: msg`Condensed`,
  righteous: msg`Retro`,
  monoton: msg`Neon lines`,
  marker: msg`Marker`,
  pacifico: msg`Script`,
  cinzel: msg`Classic`,
  playfair: msg`Serif`,
  silkscreen: msg`Bitmap`,
  audiowide: msg`Audiowide`,
  russo: msg`Heavy`,
  blackops: msg`Stencil`,
  bangers: msg`Comic`,
  luckiest: msg`Cartoon`,
  creepster: msg`Horror`,
  lobster: msg`Lobster`,
  rocksalt: msg`Scrawl`,
  unifraktur: msg`Blackletter`,
  abril: msg`Fatface`,
  majormono: msg`Thin mono`,
  michroma: msg`Extended`,
  rubikglitch: msg`Glitched`,
  shrikhand: msg`Groovy`,
  zendots: msg`Dots`,
};
