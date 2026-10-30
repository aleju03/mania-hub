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
] as const;

export type SupporterNameStyleId = (typeof SUPPORTER_NAME_STYLES)[number];

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
  return typeof value === "string" && (SUPPORTER_NAME_STYLES as readonly string[]).includes(value);
}

export const SUPPORTER_NAME_STYLE_LABELS: Record<SupporterNameStyleId, MessageDescriptor> = {
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
