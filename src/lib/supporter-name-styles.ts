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
  "karaoke",
  "wireframe",
  "label-tape",
  "highlighter",
  "long-note",
] as const;

type BuiltInNameStyleId = (typeof SUPPORTER_NAME_STYLES)[number];
/* A solid colour of the supporter's choosing: "solid-" and six lowercase hex
   digits, stored in the same column as the named styles. */
export type SolidNameStyle = `solid-${string}`;
/* Terminal with its cursor held still, for a wearer who does not want the
   blink: the one style's other setting, kept as its own id the way a solid
   colour is, so it is no tile of its own and adds nothing to the count. */
export const TERMINAL_STEADY = "terminal-steady";
export type SupporterNameStyleId = BuiltInNameStyleId | SolidNameStyle | typeof TERMINAL_STEADY;

/** The style an id is drawn, listed and labelled as. */
export function baseNameStyle(id: SupporterNameStyleId): BuiltInNameStyleId | SolidNameStyle {
  return id === TERMINAL_STEADY ? "terminal" : id;
}

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

/* An outline round the name in a colour the supporter picked: six lowercase
   hex digits, as the backend keeps it (features/supporters.ts), then one digit
   for a thinner line (1 the thinnest, to 3). With none it is the full width,
   which every outline had before there was a choice. */
export function isSupporterNameOutline(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{6}[1-3]?$/.test(value);
}

/* The line's width at each thickness, 1 to 4 (the full width). */
const NAME_OUTLINE_WIDTHS = ["0.04em", "0.07em", "0.105em", "0.14em"] as const;
export const NAME_OUTLINE_THICKEST = NAME_OUTLINE_WIDTHS.length;

export function nameOutlineThickness(outline: string): number {
  return outline.length > 6 ? Number(outline[6]) : NAME_OUTLINE_THICKEST;
}

/* The value kept for a colour (six hex digits, any trailing thickness dropped) at a thickness. */
export function nameOutlineValue(colour: string, thickness: number): string {
  const level = Math.min(NAME_OUTLINE_THICKEST, Math.max(1, Math.round(thickness)));
  return `${colour.slice(0, 6)}${level === NAME_OUTLINE_THICKEST ? "" : level}`;
}

/* The custom properties `.name-outline` (styles.css) draws the line from. */
export function nameOutlineInline(outline: string): Record<string, string> {
  return { "--name-outline": `#${outline.slice(0, 6)}`, "--name-outline-width": NAME_OUTLINE_WIDTHS[nameOutlineThickness(outline) - 1] };
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
  return typeof value === "string" && ((SUPPORTER_NAME_STYLES as readonly string[]).includes(value) || SOLID_NAME_STYLE.test(value) || value === TERMINAL_STEADY);
}

export function nameStyleLabel(id: SupporterNameStyleId): MessageDescriptor {
  const base = baseNameStyle(id);
  return isSolidNameStyle(base) ? msg`Solid colour` : SUPPORTER_NAME_STYLE_LABELS[base];
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
  karaoke: msg`Karaoke`,
  wireframe: msg`Wireframe`,
  "label-tape": msg`Label tape`,
  highlighter: msg`Highlighter`,
  "long-note": msg`Long note`,
};
