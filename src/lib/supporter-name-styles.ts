import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/* Supporter name tag styles: how an active supporter's username is drawn on
   their profile hero and in lists. CSS (the `name-tag--<id>` rules in
   styles.css, applied by SupporterStyledName); chrome and ethereal also run a
   WebGL shader over big names (name-tag-shaders.ts). The backend keeps the pick against the
   same ids (SUPPORTER_NAME_STYLES in features/supporters.ts). */

export const SUPPORTER_NAME_STYLES = [
  "holo",
  "chrome",
  "neon",
  "glitch",
  "ember",
  "frost",
  "aurora",
  "gold",
  "pixel",
  "sticker",
  "rainbow",
  "hit-light",
  "300g",
  "terminal",
  "plate",
  "sunset",
  "ethereal",
  "molten-gold",
  "pearl",
  "galaxy",
  "heatmap",
  "note-rain",
  "plasma",
  "ink",
  "caustics",
  "lava",
  "dither",
  "mesh",
  "inferno",
  "hellfire",
  "aero",
] as const;

type BuiltInNameStyleId = (typeof SUPPORTER_NAME_STYLES)[number];
/* A solid colour of the supporter's choosing: "solid-" and six lowercase hex
   digits, stored in the same column as the named styles. */
export type SolidNameStyle = `solid-${string}`;
export type SupporterNameStyleId = BuiltInNameStyleId | SolidNameStyle;

const SOLID_NAME_STYLE = /^solid-[0-9a-f]{6}$/;
export const DEFAULT_SOLID_COLOUR = "#ff66aa";

export function isSolidNameStyle(value: unknown): value is SolidNameStyle {
  return typeof value === "string" && SOLID_NAME_STYLE.test(value);
}

/** "#AABBCC" or "aabbcc" to the stored style id. */
export function solidNameStyle(hex: string): SolidNameStyle {
  const clean = hex.replace(/^#/, "").toLowerCase();
  return `solid-${/^[0-9a-f]{6}$/.test(clean) ? clean : DEFAULT_SOLID_COLOUR.slice(1)}`;
}

export function solidNameColour(value: SolidNameStyle): string {
  return `#${value.slice(6)}`;
}

/* Styles that also run as a WebGL shader over big names (name-tag-shaders.ts). */
export const SHADER_NAME_STYLES = [
  "chrome", "ethereal", "aurora", "glitch", "molten-gold", "pearl", "galaxy", "heatmap",
  "note-rain", "plasma", "ink", "caustics", "lava", "dither", "mesh", "inferno", "hellfire",
] as const satisfies readonly SupporterNameStyleId[];

export type ShaderNameStyle = (typeof SHADER_NAME_STYLES)[number];

export function isShaderNameStyle(value: SupporterNameStyleId): value is ShaderNameStyle {
  return (SHADER_NAME_STYLES as readonly string[]).includes(value);
}

export function isSupporterNameStyle(value: unknown): value is SupporterNameStyleId {
  return typeof value === "string" && ((SUPPORTER_NAME_STYLES as readonly string[]).includes(value) || SOLID_NAME_STYLE.test(value));
}

export function nameStyleLabel(id: SupporterNameStyleId): MessageDescriptor {
  return isSolidNameStyle(id) ? msg`Solid colour` : SUPPORTER_NAME_STYLE_LABELS[id];
}

export const SUPPORTER_NAME_STYLE_LABELS: Record<BuiltInNameStyleId, MessageDescriptor> = {
  holo: msg`Holo`,
  chrome: msg`Chrome`,
  neon: msg`Neon`,
  glitch: msg`Glitch`,
  ember: msg`Ember`,
  frost: msg`Frost`,
  aurora: msg`Aurora`,
  gold: msg`Gold`,
  pixel: msg`Pixel`,
  sticker: msg`Sticker`,
  rainbow: msg`Rainbow`,
  "hit-light": msg`Hit light`,
  aero: msg`Aero`,
  "300g": msg`300g`,
  terminal: msg`Terminal`,
  plate: msg`Nameplate`,
  sunset: msg`Sunset`,
  ethereal: msg`Ethereal`,
  "molten-gold": msg`Molten gold`,
  pearl: msg`Pearl`,
  galaxy: msg`Galaxy`,
  heatmap: msg`Heatmap`,
  "note-rain": msg`Note rain`,
  plasma: msg`Plasma`,
  ink: msg`Ink marble`,
  caustics: msg`Caustics`,
  lava: msg`Lava lamp`,
  dither: msg`Dither`,
  mesh: msg`Mesh gradient`,
  inferno: msg`Inferno`,
  hellfire: msg`Hellfire`,
};
