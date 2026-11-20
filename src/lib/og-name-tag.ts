// A supporter's name as the site draws it in a list, for the pictures /api/og
// makes: their name tag style, name font and outline. The site draws these
// with CSS (the `name-tag--<id>`, `name-font--<id>` and `name-outline` rules
// in styles.css); here the same rules are drawn as an SVG, since a picture has
// no stylesheet. The letters come from satori as outlines, the fills below are
// the stylesheet's own values read as CSS, and resvg rasters the result.
//
// A CSS style is drawn on its resting frame, the one the stylesheet shows under
// reduced motion. A shader style (chrome, galaxy, inferno...) is drawn as the
// still of its shader, the look the site gives a profile's big name
// (og-name-shaders.ts). A style or font this file does not know draws as none.

import { createElement as h } from "react";
import satori from "satori";

import { OG_NAME_FONTS, type OgNameFont } from "./og-name-fonts";
import { isOgShaderNameStyle, previewMask, shadeNameStill, type NameMask } from "./og-name-shaders";
import type { ShaderNameStyle } from "./supporter-name-styles";

export interface OgNameLook {
  style: string | null;
  font: string | null;
  /** Six hex digits, then an optional thickness digit (supporter-name-styles.ts). */
  outline: string | null;
}

export function hasNameLook(look: OgNameLook | null | undefined): look is OgNameLook {
  return Boolean(look && (look.style || look.font || look.outline));
}

// ---------------------------------------------------------------------------
// The stylesheet's rules, as it writes them.

interface NameStyle {
  /** background-image, clipped to the letters. */
  images?: string;
  size?: string;
  position?: string;
  repeat?: string;
  blend?: "soft-light";
  /** The letters' own colour, for a style that clips nothing into them. */
  fill?: string;
  textShadow?: string;
  /** -webkit-text-stroke. */
  stroke?: string;
  /** paint-order: stroke fill. */
  strokeUnder?: boolean;
  filter?: string;
  /** Its own typeface, where no name font is picked. */
  mono?: boolean;
  spacing?: number;
  /** position: relative; top. */
  shift?: number;
  /** The shape its ::before draws behind the letters. */
  backing?: "plate" | "label-tape" | "highlighter" | "long-note";
}

const SHADER_LINE = "calc(50% - 0.34em)";

const NAME_STYLES: Record<string, NameStyle> = {
  holo: {
    images: "linear-gradient(100deg, #ffb8e8 0%, #ffeab0 17%, #b5ffe1 34%, #aee0ff 51%, #dcb8ff 68%, #ffb8e8 85%, #ffb8e8 100%)",
    size: "200% 100%",
    filter: "drop-shadow(0 0.04em 0.06em rgba(0, 0, 0, 0.55)) drop-shadow(0 0 0.3em rgba(214, 176, 255, 0.4))",
  },
  chrome: {
    images: `linear-gradient(105deg, transparent 0 44%, rgba(255, 255, 255, 0.85) 50%, transparent 56% 100%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.4) ${SHADER_LINE}, transparent calc(50% - 0.06em), rgba(10, 12, 20, 0.22) calc(50% + 0.5em)),
      linear-gradient(100deg, #f5f7fc 0%, #dfe3ec 30%, #a9afc0 55%, #6c7284 78%, #4c5264 100%)`,
    size: "250% 100%, 100% 100%, 100% 100%",
    repeat: "no-repeat",
    position: "150% 50%, 0 0, 0 0",
    filter: "drop-shadow(0 0.06em 0.1em rgba(0, 0, 0, 0.7))",
  },
  neon: {
    fill: "#fff2fb",
    textShadow: "0 0 0.04em #fff, 0 0 0.12em #ff8fd0",
    filter: "drop-shadow(0 0 0.12em rgba(255, 70, 175, 0.95)) drop-shadow(0 0 0.45em rgba(255, 40, 160, 0.65))",
  },
  glitch: {
    fill: "#fff",
    textShadow: "-0.04em 0 rgba(255, 45, 110, 0.85), 0.04em 0 rgba(0, 225, 255, 0.85)",
  },
  ember: {
    images: "linear-gradient(0deg, #ff3b1f 0%, #ff6a1a 22%, #ffa21f 48%, #ffd760 70%, #fff4c4 100%)",
    filter: "drop-shadow(0 0.04em 0.05em rgba(0, 0, 0, 0.6)) drop-shadow(0 0 0.22em rgba(255, 110, 30, 0.75))",
  },
  frost: {
    images: `linear-gradient(115deg, transparent 0 28%, rgba(255, 255, 255, 0.75) 28% 31%, transparent 31% 58%, rgba(255, 255, 255, 0.55) 58% 60%, transparent 60% 100%),
      linear-gradient(180deg, #ffffff 0%, #e2f7ff 35%, #8fd4ff 62%, #c9efff 82%, #ffffff 100%)`,
    size: "200% 100%, 100% 100%",
    filter: "drop-shadow(0 0.04em 0.05em rgba(0, 20, 40, 0.6)) drop-shadow(0 0 0.25em rgba(110, 200, 255, 0.55))",
  },
  aurora: {
    images: `linear-gradient(100deg, transparent 0%, rgba(140, 255, 200, 0.4) 18%, transparent 36%, rgba(170, 140, 255, 0.35) 60%, transparent 80%),
      linear-gradient(180deg, #7896d8 ${SHADER_LINE}, #4aa0b0 calc(50% - 0.08em), #38bd8e calc(50% + 0.22em), #2c9a88 calc(50% + 0.5em))`,
    size: "200% 100%, 100% 100%",
    filter: "drop-shadow(0 0.04em 0.05em rgba(0, 0, 0, 0.6)) drop-shadow(0 0 0.32em rgba(80, 230, 200, 0.45))",
  },
  gold: {
    images: `linear-gradient(105deg, transparent 0 44%, rgba(255, 255, 255, 0.95) 50%, transparent 56% 100%),
      linear-gradient(180deg, #fff8d6 0%, #ffe27a 28%, #f2b52c 50%, #b97a0f 56%, #e3a52a 72%, #ffe89c 100%)`,
    size: "250% 100%, 100% 100%",
    repeat: "no-repeat",
    position: "150% 50%, 0 0",
    filter: "drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.65)) drop-shadow(0 0 0.25em rgba(255, 190, 60, 0.4))",
  },
  pixel: {
    images: "pixel-grid(78%, rgba(255, 160, 40, 0.45), #ffe066)",
    size: "0.09em 0.09em",
    filter: "drop-shadow(0 0 0.1em rgba(255, 190, 40, 0.95)) drop-shadow(0 0 0.35em rgba(255, 150, 20, 0.5))",
  },
  sticker: {
    fill: "#fff",
    stroke: "0.14em #1d1233",
    strokeUnder: true,
    filter: "drop-shadow(0.08em 0.08em 0 #ff5fae)",
  },
  rainbow: {
    images: "linear-gradient(90deg, #ff6b7d 0%, #ffae5c 14%, #ffe45c 28%, #7cf08f 43%, #5cd2ff 57%, #8f7dff 71%, #ff79d8 86%, #ff6b7d 100%)",
    size: "200% 100%",
    filter: "drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.65))",
  },
  "hit-light": {
    images: "linear-gradient(0deg, #6fd8ff 0%, #c9f1ff 40%, #ffffff 65%)",
    filter: "drop-shadow(0 0 0.1em rgba(120, 215, 255, 0.9)) drop-shadow(0 0 0.3em rgba(40, 170, 255, 0.55))",
  },
  "300g": {
    images: `linear-gradient(180deg, #9b2cff calc(50% - 0.3em), #1d65ff calc(50% - 0.15em), #41d9ff calc(50% + 0.04em),
      #4fdc3a calc(50% + 0.16em), #ffe234 calc(50% + 0.28em), #ff9a1f calc(50% + 0.4em))`,
    size: "100% 100%",
    repeat: "no-repeat",
    filter: "drop-shadow(0 0.04em 0.05em rgba(0, 0, 0, 0.6))",
  },
  terminal: {
    mono: true,
    spacing: -0.02,
    shift: 0.07,
    images: "repeating-linear-gradient(180deg, #a8ffc4 0 0.06em, #4ad67a 0.06em 0.1em)",
    filter: "drop-shadow(0 0 0.1em rgba(80, 255, 150, 0.65)) drop-shadow(0 0 0.3em rgba(40, 220, 110, 0.35))",
  },
  plate: { backing: "plate", fill: "#fff", textShadow: "0 0.04em 0.08em rgba(0, 0, 0, 0.5)" },
  "label-tape": {
    backing: "label-tape",
    fill: "#fff",
    textShadow: "0 0.035em 0 rgba(70, 0, 12, 0.75), 0 -0.02em 0 rgba(255, 255, 255, 0.55), 0 0 0.09em rgba(255, 255, 255, 0.55)",
  },
  highlighter: { backing: "highlighter", fill: "#17151d" },
  "long-note": { backing: "long-note", fill: "#fff", textShadow: "0 0.04em 0.07em rgba(0, 30, 70, 0.75)" },
  karaoke: {
    images: "linear-gradient(90deg, #ff5fa8 0%, #ffb23e 25%, #ffe45c 49.6%, #f4f6ff 50.4%, #f4f6ff 100%)",
    size: "200% 100%",
    position: "50% 0",
    filter: "drop-shadow(0 0.05em 0.04em rgba(0, 0, 0, 0.75)) drop-shadow(0 0 0.02em rgba(0, 0, 0, 0.9))",
  },
  wireframe: {
    stroke: "0.05em #8fe6ff",
    images: "linear-gradient(100deg, rgba(143, 230, 255, 0.2) 0 38%, rgba(190, 242, 255, 0.8) 50%, rgba(143, 230, 255, 0.2) 62% 100%)",
    size: "200% 100%",
    filter: "drop-shadow(0 0 0.09em rgba(60, 200, 255, 0.7)) drop-shadow(0 0.04em 0.05em rgba(0, 0, 0, 0.6))",
  },
  sunset: {
    images: `linear-gradient(180deg,
      #fff1a6 0%, #ffc05c 30%, #ff6f7d 54%, #f4609a 59%,
      transparent 59% 60.5%, #ea58aa 60.5%, #dc52bc 66.5%,
      transparent 66.5% 68.5%, #c64fd2 68.5%, #8b4dff 100%)`,
    filter: "drop-shadow(0 0.05em 0.05em rgba(30, 0, 50, 0.7)) drop-shadow(0 0 0.25em rgba(255, 90, 170, 0.45))",
  },
  aero: {
    images: `linear-gradient(180deg, rgba(255, 255, 255, 0.75) 0%, rgba(255, 255, 255, 0.3) 34%, rgba(255, 255, 255, 0) 42%),
      aero-water(),
      aero-bubbles(a),
      aero-bubbles(b),
      linear-gradient(180deg, #7fe4ff 0%, #2bb8f0 45%, #1186d2 70%, #0a5aa0 100%)`,
    size: "100% 100%, 2.4em 100%, 1.9em 1.14em, 2.66em 1.52em, 100% 100%",
    repeat: "no-repeat, repeat-x, repeat, repeat, no-repeat",
    position: "0 0, 0 0, 0 0, 0.7em 0.3em, 0 0",
    stroke: "0.02em rgba(225, 250, 255, 0.35)",
    filter: "drop-shadow(0 0.05em 0.04em rgba(0, 38, 70, 0.8)) drop-shadow(0 0 0.22em rgba(80, 205, 255, 0.45))",
  },
  ethereal: {
    images: `radial-gradient(ellipse 30% 70% at 30% 62%, #fff0a8 0, #ff9e5c 35%, rgba(255, 120, 190, 0) 75%),
      radial-gradient(ellipse 22% 60% at 72% 45%, #ff9ad6 0, rgba(255, 154, 214, 0) 70%),
      linear-gradient(180deg, #8b93ff, #6870f2)`,
    size: "200% 100%, 200% 100%, 100% 100%",
    filter: "drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.55))",
  },
  "molten-gold": {
    images: `linear-gradient(180deg, rgba(255, 250, 220, 0.4) ${SHADER_LINE}, transparent calc(50% - 0.06em), rgba(40, 20, 0, 0.25) calc(50% + 0.5em)),
      linear-gradient(100deg, #fbf0c4 0%, #ecd27a 26%, #c79a2c 52%, #8a5a10 78%, #5e3606 100%)`,
    filter: "drop-shadow(0 0.05em 0.07em rgba(0, 0, 0, 0.6))",
  },
  pearl: {
    images: "linear-gradient(100deg, #c9a8f4 0%, #f1cfe8 14%, #e2dcae 30%, #a6e8d6 48%, #8fd8ea 64%, #c9a8f4 82%, #f1cfe8 100%)",
    size: "200% 100%",
    filter: "drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.55))",
  },
  galaxy: {
    images: `radial-gradient(circle at 22% 38%, #fff 0 0.035em, transparent 0.06em),
      radial-gradient(circle at 68% 66%, #fff 0 0.03em, transparent 0.055em),
      radial-gradient(ellipse 34% 70% at 30% 55%, rgba(226, 104, 200, 0.55) 0, transparent 70%),
      radial-gradient(ellipse 30% 70% at 74% 45%, rgba(110, 150, 245, 0.45) 0, transparent 70%),
      linear-gradient(180deg, #c4a6f6 calc(50% - 0.42em), #9a5ee8 calc(50% - 0.22em), #6a3ac4 calc(50% + 0.02em),
        #50349e calc(50% + 0.26em), #8a5ce0 calc(50% + 0.48em))`,
    filter: "drop-shadow(0 0 0.05em rgba(170, 130, 255, 0.5)) drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.6))",
  },
  heatmap: {
    images: `linear-gradient(180deg, #3f7fe0 calc(50% - 0.36em), #86dcf2 calc(50% - 0.2em), #ffe27c calc(50% - 0.04em),
      #ffa035 calc(50% + 0.12em), #ffd66e calc(50% + 0.3em), #7ad2ea calc(50% + 0.46em), #3f7fe0 calc(50% + 0.6em))`,
    filter: "drop-shadow(0 0 0.06em rgba(120, 190, 255, 0.45)) drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.5))",
  },
  "note-rain": {
    images: "linear-gradient(180deg, #a596ee calc(50% - 0.36em), #6249ad calc(50% - 0.16em), #6a4fb8 calc(50% + 0.2em), #8064d2 calc(50% + 0.5em))",
    filter: "drop-shadow(0 0 0.05em rgba(210, 200, 255, 0.6)) drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.55))",
  },
  plasma: {
    images: `radial-gradient(ellipse 40% 9% at 30% 45%, rgba(190, 230, 255, 0.9) 0, transparent 100%),
      radial-gradient(ellipse 35% 8% at 72% 60%, rgba(120, 200, 255, 0.85) 0, transparent 100%),
      linear-gradient(180deg, #9edbff calc(50% - 0.36em), #3a6be6 calc(50% - 0.18em), #2452d6 calc(50% + 0.12em), #4a80f0 calc(50% + 0.5em))`,
    filter: "drop-shadow(0 0 0.08em rgba(90, 170, 255, 0.85)) drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.5))",
  },
  ink: {
    images: `linear-gradient(115deg, #f4efe2 0%, #f4efe2 16%, #2a2c66 22%, #f4efe2 29%, #f4efe2 46%, #c99a3e 49%, #f4efe2 52%,
      #f4efe2 64%, #1d1d38 70%, #3a3f9a 74%, #f4efe2 80%, #f4efe2 100%)`,
    size: "200% 100%",
    filter: "drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.6))",
  },
  caustics: {
    images: `radial-gradient(ellipse 30% 12% at 28% 40%, rgba(200, 255, 250, 0.75) 0, transparent 100%),
      radial-gradient(ellipse 26% 10% at 68% 62%, rgba(200, 255, 250, 0.6) 0, transparent 100%),
      linear-gradient(180deg, #8ef0ea calc(50% - 0.36em), #1f93ad calc(50% - 0.16em), #0f7690 calc(50% + 0.2em), #1d8ea6 calc(50% + 0.5em))`,
    filter: "drop-shadow(0 0 0.06em rgba(120, 255, 240, 0.5)) drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.5))",
  },
  lava: {
    images: `radial-gradient(ellipse 22% 40% at 22% 55%, #ffb050 0, #ff7a28 45%, transparent 75%),
      radial-gradient(ellipse 18% 34% at 58% 35%, #ffd27a 0, #ff8a2e 45%, transparent 75%),
      linear-gradient(180deg, #b0226a calc(50% - 0.3em), #d42b48 calc(50% + 0.1em), #e8443a calc(50% + 0.45em))`,
    filter: "drop-shadow(0 0 0.06em rgba(255, 90, 40, 0.55)) drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.5))",
  },
  dither: {
    images: "checker(#8bac0f, #306230), linear-gradient(180deg, #c7dc60, #306230)",
    size: "0.12em 0.12em, 100% 100%",
    blend: "soft-light",
    filter: "drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.55))",
  },
  mesh: {
    images: `radial-gradient(ellipse 50% 90% at 20% 40%, #ff8cbf 0, transparent 70%),
      radial-gradient(ellipse 50% 90% at 55% 60%, #7a9cff 0, transparent 70%),
      radial-gradient(ellipse 50% 90% at 85% 40%, #ffc78c 0, transparent 70%),
      linear-gradient(90deg, #b47aff, #b47aff)`,
    size: "200% 100%",
    filter: "drop-shadow(0 0.05em 0.06em rgba(0, 0, 0, 0.55))",
  },
  inferno: {
    images: "linear-gradient(0deg, #ffb35c 0%, #ffe2b0 55%, #fff6e4 100%)",
    filter: "drop-shadow(0 0.03em 0.04em rgba(60, 10, 0, 0.7)) drop-shadow(0 0 0.12em rgba(255, 110, 20, 0.85)) drop-shadow(0 0 0.32em rgba(255, 50, 0, 0.45))",
  },
  hellfire: {
    images: "linear-gradient(0deg, #a9b4ff 0%, #e2ecff 55%, #f7fbff 100%)",
    filter: "drop-shadow(0 0.03em 0.04em rgba(10, 0, 40, 0.7)) drop-shadow(0 0 0.12em rgba(120, 110, 255, 0.85)) drop-shadow(0 0 0.32em rgba(90, 50, 255, 0.45))",
  },
};

/** The style ids this file draws, for the test that holds them to the site's list. */
export const OG_NAME_STYLE_IDS = Object.keys(NAME_STYLES);

// The line widths of `nameOutlineInline` (supporter-name-styles.ts), thinnest first.
const OUTLINE_WIDTHS = [0.04, 0.07, 0.105, 0.14];

// ---------------------------------------------------------------------------
// Reading CSS values.

/** A length of a percentage plus ems, as `calc(50% - 0.34em)` is. */
interface Length {
  pct: number;
  em: number;
}

interface Colour {
  rgb: string;
  alpha: number;
}

function splitTop(value: string, separator: "," | " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    const breaks = depth === 0 && (separator === "," ? char === "," : /\s/.test(char));
    if (breaks) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseLength(token: string): Length {
  const value = token.trim();
  if (value.startsWith("calc(")) {
    const length = { pct: 0, em: 0 };
    for (const [, sign, amount, unit] of value.slice(5, -1).matchAll(/([+-]?)\s*([\d.]+)(%|em)/g)) {
      const signed = (sign === "-" ? -1 : 1) * Number(amount);
      if (unit === "%") length.pct += signed / 100;
      else length.em += signed;
    }
    return length;
  }
  if (value.endsWith("%")) return { pct: Number(value.slice(0, -1)) / 100, em: 0 };
  if (value.endsWith("em")) return { pct: 0, em: Number(value.slice(0, -2)) };
  return { pct: 0, em: Number(value) || 0 };
}

function isLength(token: string): boolean {
  return /^(calc\(|[-\d.])/.test(token);
}

function parseColour(token: string): Colour | null {
  const value = token.trim();
  if (value === "transparent") return null;
  if (value.startsWith("#")) {
    const hex = value.length === 4 ? value.slice(1).replace(/./g, "$&$&") : value.slice(1);
    return { rgb: `#${hex.slice(0, 6)}`, alpha: 1 };
  }
  const parts = value.slice(value.indexOf("(") + 1, -1).split(",").map((part) => Number(part.trim()));
  return { rgb: `rgb(${parts[0]},${parts[1]},${parts[2]})`, alpha: parts.length > 3 ? parts[3]! : 1 };
}

function paint(colour: Colour, attribute: "fill" | "stroke" | "stop" | "flood"): string {
  const name = attribute === "stop" ? "stop-color" : attribute === "flood" ? "flood-color" : attribute;
  const opacity = attribute === "stop" ? "stop-opacity" : attribute === "flood" ? "flood-opacity" : `${attribute}-opacity`;
  return `${name}="${colour.rgb}"${colour.alpha < 1 ? ` ${opacity}="${colour.alpha}"` : ""}`;
}

interface Stop {
  /** null for `transparent`, which takes its neighbour's colour at no alpha. */
  colour: Colour | null;
  at: Length | null;
}

function parseStops(parts: string[]): Stop[] {
  const stops: Stop[] = [];
  for (const part of parts) {
    const tokens = splitTop(part, " ");
    const colour = parseColour(tokens[0]!);
    const positions = tokens.slice(1).map(parseLength);
    if (positions.length === 0) stops.push({ colour, at: null });
    for (const at of positions) stops.push({ colour, at });
  }
  return stops;
}

interface PlacedStop {
  colour: Colour;
  /** Along the gradient's line, in pixels. */
  at: number;
}

// CSS's own fix-up: ends default to the line's ends, a stop never sits before
// the one ahead of it, and the unplaced ones spread evenly between neighbours.
function placeStops(stops: Stop[], line: number, em: number): PlacedStop[] {
  const at: Array<number | null> = stops.map((stop) => (stop.at ? stop.at.pct * line + stop.at.em * em : null));
  if (at[0] == null) at[0] = 0;
  if (at[at.length - 1] == null) at[at.length - 1] = line;
  let reached = -Infinity;
  for (let index = 0; index < at.length; index++) {
    if (at[index] == null) continue;
    at[index] = Math.max(at[index]!, reached);
    reached = at[index]!;
  }
  for (let index = 0; index < at.length; index++) {
    if (at[index] != null) continue;
    let next = index;
    while (at[next] == null) next += 1;
    const from = at[index - 1]!;
    const step = (at[next]! - from) / (next - index + 1);
    for (let fill = index; fill < next; fill++) at[fill] = from + step * (fill - index + 1);
  }
  // `transparent` fades its neighbours out without passing through black.
  const placed: PlacedStop[] = [];
  for (const [index, stop] of stops.entries()) {
    if (stop.colour) {
      placed.push({ colour: stop.colour, at: at[index]! });
      continue;
    }
    const before = stops.slice(0, index).reverse().find((other) => other.colour)?.colour;
    const after = stops.slice(index + 1).find((other) => other.colour)?.colour;
    const first = before ?? after;
    const second = after ?? before;
    if (first) placed.push({ colour: { rgb: first.rgb, alpha: 0 }, at: at[index]! });
    if (second && second.rgb !== first?.rgb) placed.push({ colour: { rgb: second.rgb, alpha: 0 }, at: at[index]! });
  }
  return placed;
}

function stopTags(stops: PlacedStop[], from: number, span: number): string {
  return stops.map((stop) => `<stop offset="${span > 0 ? ((stop.at - from) / span).toFixed(5) : 0}" ${paint(stop.colour, "stop")}/>`).join("");
}

// ---------------------------------------------------------------------------
// Background layers.

interface Draw {
  defs: string[];
  /** A fresh id for a gradient, filter or mask. */
  id: () => string;
  em: number;
}

const round = (value: number) => Number(value.toFixed(3));

// One tile of a layer's image, `width` by `height` with its corner at the origin.
function tileImage(image: string, width: number, height: number, draw: Draw): string {
  const name = image.slice(0, image.indexOf("("));
  const args = splitTop(image.slice(image.indexOf("(") + 1, image.lastIndexOf(")")), ",");
  const rect = (fill: string) => `<rect width="${round(width)}" height="${round(height)}" fill="${fill}"/>`;

  if (name === "linear-gradient" || name === "repeating-linear-gradient") {
    const angled = /deg$/.test(args[0]!);
    const angle = ((angled ? Number(args[0]!.slice(0, -3)) : 180) * Math.PI) / 180;
    const direction = [Math.sin(angle), -Math.cos(angle)] as const;
    const line = Math.abs(width * direction[0]) + Math.abs(height * direction[1]);
    const stops = placeStops(parseStops(angled ? args.slice(1) : args), line, draw.em);
    const from = stops[0]!.at;
    const to = stops[stops.length - 1]!.at;
    const point = (along: number) => [width / 2 + direction[0] * (along - line / 2), height / 2 + direction[1] * (along - line / 2)];
    const [x1, y1] = point(from);
    const [x2, y2] = point(to);
    const id = draw.id();
    draw.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${round(x1!)}" y1="${round(y1!)}" x2="${round(x2!)}" y2="${round(y2!)}"${name.startsWith("repeating") ? ' spreadMethod="repeat"' : ""}>${stopTags(stops, from, to - from)}</linearGradient>`);
    return rect(`url(#${id})`);
  }

  if (name === "radial-gradient") {
    const [shape, place] = args[0]!.split(" at ");
    const [centreX, centreY] = splitTop(place!, " ").map(parseLength);
    const cx = centreX!.pct * width + centreX!.em * draw.em;
    const cy = centreY!.pct * height + centreY!.em * draw.em;
    const radii = splitTop(shape!, " ").slice(1).map(parseLength);
    // A circle with no size reaches its farthest corner.
    const far = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
    const rx = radii[0] ? radii[0].pct * width + radii[0].em * draw.em : far;
    const ry = radii[1] ? radii[1].pct * height + radii[1].em * draw.em : far;
    const stops = placeStops(parseStops(args.slice(1)), rx, draw.em);
    const id = draw.id();
    draw.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${round(cx)} ${round(cy)}) scale(${round(rx)} ${round(ry)})">${stopTags(stops, 0, rx)}</radialGradient>`);
    return rect(`url(#${id})`);
  }

  // conic-gradient(at 78% 78%, dim 75%, lit 0): the tile's top-left corner lit.
  if (name === "pixel-grid") {
    const lit = parseLength(args[0]!).pct;
    return `${rect("none")}<rect width="${round(width)}" height="${round(height)}" ${paint(parseColour(args[1]!)!, "fill")}/><rect width="${round(width * lit)}" height="${round(height * lit)}" ${paint(parseColour(args[2]!)!, "fill")}/>`;
  }

  // repeating-conic-gradient(a 0 25%, b 0 50%): quarters, alternating from the top right.
  if (name === "checker") {
    const [a, b] = args.map((arg) => parseColour(arg)!);
    const half = (x: number, y: number, colour: Colour) => `<rect x="${round(x)}" y="${round(y)}" width="${round(width / 2)}" height="${round(height / 2)}" ${paint(colour, "fill")}/>`;
    return half(width / 2, 0, a!) + half(width / 2, height / 2, b!) + half(0, height / 2, a!) + half(0, 0, b!);
  }

  // Aero's water: pale glass down to a waterline with a white crest, stretched to the tile.
  if (name === "aero-water") {
    const id = draw.id();
    draw.defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4fdff"/><stop offset="1" stop-color="#b9eeff"/></linearGradient>`);
    return `<svg width="${round(width)}" height="${round(height)}" viewBox="0 0 120 100" preserveAspectRatio="none"><path d="M0 0H120V50C90 42 90 42 60 50C30 58 30 58 0 50Z" fill="url(#${id})"/><path d="M0 50C30 58 30 58 60 50C90 42 90 42 120 50" fill="none" stroke="#fff" stroke-opacity=".95" stroke-width="3.2"/></svg>`;
  }

  if (name === "aero-bubbles") {
    const body = args[0] === "a"
      ? `<g fill="#fff" fill-opacity=".16" stroke="#fff" stroke-opacity=".85" stroke-width="1.4"><circle cx="14" cy="12" r="3.6"/><circle cx="46" cy="40" r="2.6"/><circle cx="78" cy="18" r="4.4"/><circle cx="30" cy="54" r="3"/></g><g fill="#fff" fill-opacity=".85"><circle cx="12.8" cy="10.7" r="0.9"/><circle cx="45.2" cy="39.1" r="0.7"/><circle cx="76.6" cy="16.4" r="1.1"/><circle cx="29.0" cy="52.9" r="0.7"/></g>`
      : `<g fill="#fff" fill-opacity=".16" stroke="#fff" stroke-opacity=".65" stroke-width="1.4"><circle cx="24" cy="30" r="2.4"/><circle cx="70" cy="66" r="3.2"/><circle cx="118" cy="44" r="2"/><circle cx="96" cy="10" r="2.8"/></g><g fill="#fff" fill-opacity=".65"><circle cx="23.2" cy="29.1" r="0.7"/><circle cx="69.0" cy="64.8" r="0.8"/><circle cx="117.4" cy="43.3" r="0.7"/><circle cx="95.1" cy="9.0" r="0.7"/></g>`;
    return `<svg width="${round(width)}" height="${round(height)}" viewBox="${args[0] === "a" ? "0 0 100 60" : "0 0 140 80"}">${body}</svg>`;
  }

  return "";
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The style's background over its box, last layer first as CSS paints them.
function backgroundLayers(style: NameStyle, box: Box, draw: Draw): string {
  const images = splitTop(style.images ?? "", ",");
  const list = (value: string | undefined) => (value ? splitTop(value, ",") : []);
  const sizes = list(style.size);
  const positions = list(style.position);
  const repeats = list(style.repeat);
  const pick = (values: string[], index: number) => (values.length ? values[index % values.length]! : null);
  const out: string[] = [];
  for (let index = images.length - 1; index >= 0; index--) {
    const size = pick(sizes, index)?.split(/\s+/).map(parseLength);
    const width = size ? size[0]!.pct * box.width + size[0]!.em * draw.em : box.width;
    const height = size ? size[1]!.pct * box.height + size[1]!.em * draw.em : box.height;
    const position = splitTop(pick(positions, index) ?? "0% 0%", " ").map(parseLength);
    // A percentage places that point of the image on that point of the box.
    const left = position[0]!.pct * (box.width - width) + position[0]!.em * draw.em;
    const top = position[1]!.pct * (box.height - height) + position[1]!.em * draw.em;
    const repeat = pick(repeats, index) ?? "repeat";
    const tile = tileImage(images[index]!, width, height, draw);
    const firstColumn = repeat === "no-repeat" ? 0 : -Math.ceil(left / width);
    const lastColumn = repeat === "no-repeat" ? 0 : Math.ceil((box.width - left) / width) - 1;
    const firstRow = repeat === "repeat" ? -Math.ceil(top / height) : 0;
    const lastRow = repeat === "repeat" ? Math.ceil((box.height - top) / height) - 1 : 0;
    const tiles: string[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        tiles.push(`<g transform="translate(${round(box.x + left + column * width)} ${round(box.y + top + row * height)})">${tile}</g>`);
      }
    }
    const blend = style.blend && index < images.length - 1 ? ` style="mix-blend-mode:${style.blend}"` : "";
    out.push(`<g${blend}>${tiles.join("")}</g>`);
  }
  return `<g${style.blend ? ' style="isolation:isolate"' : ""}>${out.join("")}</g>`;
}

// ---------------------------------------------------------------------------
// Shadows.

interface Shadow {
  x: number;
  y: number;
  blur: number;
  colour: Colour;
}

function parseShadow(value: string, em: number): Shadow {
  const tokens = splitTop(value, " ");
  const lengths = tokens.filter(isLength).map((token) => parseLength(token).em * em);
  const colour = parseColour(tokens.find((token) => !isLength(token)) ?? "#000") ?? { rgb: "#000", alpha: 0 };
  return { x: lengths[0] ?? 0, y: lengths[1] ?? 0, blur: lengths[2] ?? 0, colour };
}

// filter: drop-shadow() drop-shadow(): each one also shadows the one before it.
// Its blur is the deviation itself, where a text-shadow's is twice it.
function dropShadowFilter(filter: string, canvas: Box, draw: Draw): string {
  const shadows = [...filter.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)].map((match) => parseShadow(match[1]!, draw.em));
  const id = draw.id();
  draw.defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${canvas.x}" y="${canvas.y}" width="${canvas.width}" height="${canvas.height}" color-interpolation-filters="sRGB">${
    shadows.map((shadow) => `<feDropShadow dx="${round(shadow.x)}" dy="${round(shadow.y)}" stdDeviation="${round(shadow.blur)}" ${paint(shadow.colour, "flood")}/>`).join("")
  }</filter>`);
  return id;
}

// ---------------------------------------------------------------------------
// The shapes four styles draw behind the letters (their ::before).

function backing(kind: NonNullable<NameStyle["backing"]>, box: Box, draw: Draw): string {
  const { em } = draw;
  const inset = (top: number, sides: number, bottom = top): Box => ({
    x: box.x + sides * em,
    y: box.y + top * em,
    width: box.width - sides * 2 * em,
    height: box.height - (top + bottom) * em,
  });
  const gradient = (stops: string, x2 = 0, y2 = 1) => {
    const id = draw.id();
    draw.defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops}</linearGradient>`);
    return `url(#${id})`;
  };
  const blur = (deviation: number) => {
    const id = draw.id();
    draw.defs.push(`<filter id="${id}" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="${round(deviation)}"/></filter>`);
    return `url(#${id})`;
  };

  if (kind === "plate") {
    const plate = inset(0.04, 0.16);
    const edge = 0.06 * em;
    const radius = 0.12 * em;
    const inner = `x="${round(plate.x + edge)}" y="${round(plate.y + edge)}" width="${round(plate.width - edge * 2)}" height="${round(plate.height - edge * 2)}" rx="${round(Math.max(0, radius - edge))}"`;
    const clip = draw.id();
    draw.defs.push(`<clipPath id="${clip}"><rect ${inner}/></clipPath>`);
    return `<g transform="translate(${round(plate.x + plate.width / 2)} ${round(plate.y + plate.height / 2)}) skewX(-12) translate(${round(-(plate.x + plate.width / 2))} ${round(-(plate.y + plate.height / 2))})">`
      + `<rect x="${round(plate.x)}" y="${round(plate.y)}" width="${round(plate.width)}" height="${round(plate.height)}" rx="${round(radius)}" fill="${gradient('<stop offset="0" stop-color="#ff66b3"/><stop offset="1" stop-color="#9b7bff"/>', 1, 0)}"/>`
      + `<rect ${inner} fill="${gradient('<stop offset="0" stop-color="#2a1d45"/><stop offset="1" stop-color="#160f29"/>')}"/>`
      + `<rect ${inner} fill="${gradient('<stop offset="0" stop-color="#fff" stop-opacity="0.1"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/>')}"/>`
      + `<rect x="${round(plate.x + edge)}" y="${round(plate.y + edge)}" width="${round(0.14 * em)}" height="${round(plate.height - edge * 2)}" fill="#ff66b3" clip-path="url(#${clip})"/>`
      + "</g>";
  }

  if (kind === "label-tape") {
    const tape = inset(0.05, 0.12);
    const right = tape.x + tape.width;
    const bottom = tape.y + tape.height;
    const shape = `M${round(tape.x + 0.05 * em)} ${round(tape.y)}L${round(right)} ${round(tape.y)}L${round(right - 0.04 * em)} ${round(bottom)}L${round(tape.x)} ${round(bottom)}Z`;
    return `<path d="${shape}" fill="#000" fill-opacity="0.5" transform="translate(0 ${round(0.05 * em)})" filter="${blur(0.04 * em)}"/>`
      + `<path d="${shape}" fill="#cf1f3a"/>`
      + `<path d="${shape}" fill="${gradient('<stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="0.09" stop-color="#fff" stop-opacity="0.34"/><stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.24"/>')}"/>`;
  }

  if (kind === "highlighter") {
    const mark: Box = { x: box.x + 0.1 * em, y: box.y + 0.17 * em, width: box.width - 0.2 * em, height: box.height - 0.27 * em };
    // border-radius: 0.3em 0.1em 0.34em 0.12em / 0.2em 0.3em 0.16em 0.34em
    const [tl, tr, br, bl] = [[0.3, 0.2], [0.1, 0.3], [0.34, 0.16], [0.12, 0.34]].map(([x, y]) => [x! * em, y! * em] as const);
    const right = mark.x + mark.width;
    const bottom = mark.y + mark.height;
    const shape = `M${round(mark.x + tl![0])} ${round(mark.y)}L${round(right - tr![0])} ${round(mark.y)}A${round(tr![0])} ${round(tr![1])} 0 0 1 ${round(right)} ${round(mark.y + tr![1])}`
      + `L${round(right)} ${round(bottom - br![1])}A${round(br![0])} ${round(br![1])} 0 0 1 ${round(right - br![0])} ${round(bottom)}`
      + `L${round(mark.x + bl![0])} ${round(bottom)}A${round(bl![0])} ${round(bl![1])} 0 0 1 ${round(mark.x)} ${round(bottom - bl![1])}`
      + `L${round(mark.x)} ${round(mark.y + tl![1])}A${round(tl![0])} ${round(tl![1])} 0 0 1 ${round(mark.x + tl![0])} ${round(mark.y)}Z`;
    const clip = draw.id();
    draw.defs.push(`<clipPath id="${clip}"><path d="${shape}"/></clipPath>`);
    const streaks = tileImage("repeating-linear-gradient(178deg, rgba(255, 255, 255, 0.2) 0 0.05em, rgba(255, 255, 255, 0) 0.05em 0.19em)", mark.width, mark.height, draw);
    return `<g transform="rotate(-1.1 ${round(mark.x + mark.width / 2)} ${round(mark.y + mark.height / 2)})">`
      + `<path d="${shape}" fill="${gradient('<stop offset="0" stop-color="#ffe838"/><stop offset="0.6" stop-color="#f9f04a"/><stop offset="1" stop-color="#ffe22e"/>', 1, 0)}"/>`
      + `<g clip-path="url(#${clip})"><g transform="translate(${round(mark.x)} ${round(mark.y)})">${streaks}</g></g>`
      + "</g>";
  }

  const note = inset(0.07, 0.12);
  const rect = `x="${round(note.x)}" y="${round(note.y)}" width="${round(note.width)}" height="${round(note.height)}" rx="${round(0.14 * em)}"`;
  return `<rect ${rect} fill="rgb(70,170,255)" fill-opacity="0.6" filter="${blur(0.15 * em)}"/>`
    + `<rect ${rect} fill="${gradient('<stop offset="0" stop-color="#4fb4ff"/><stop offset="1" stop-color="#2a7df0"/>')}"/>`
    // The hold's light, at rest on the note's first 45%.
    + `<rect x="${round(note.x)}" y="${round(note.y)}" width="${round(note.width * 0.45)}" height="${round(note.height)}" rx="${round(0.14 * em)}" fill="${gradient('<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>', 1, 0)}"/>`;
}

// ---------------------------------------------------------------------------
// The letters.

export interface OgNameTagFonts {
  /** The picture's own heavy font, for a name with no name font picked. */
  base: ArrayBuffer;
  /** A name font's TTF, by its file name in /fonts/name/ttf/. */
  load: (file: string) => Promise<ArrayBuffer>;
}

/** The monospace face the Terminal style sets its name in: JetBrains Mono ExtraBold, Basic Latin only. */
const TERMINAL_FONT_FILE = "terminal-mono";

// The em the letters are outlined at; the picture scales them to its own size.
const REFERENCE = 240;

interface Outlines {
  d: string;
  /** The line's advance, in reference pixels. */
  advance: number;
}

async function outlineName(name: string, font: ArrayBuffer, size: number, spacing: number, lineHeight: number): Promise<Outlines | null> {
  const svg = await satori(
    h("div", { style: { display: "flex", alignItems: "flex-start", width: "100%", height: "100%" } },
      h("div", { style: { fontFamily: "name", fontSize: `${size}px`, lineHeight: `${lineHeight}px`, letterSpacing: `${spacing}px`, whiteSpace: "nowrap", color: "#fff" } }, name),
      h("div", { style: { width: "1px", height: "1px", backgroundColor: "#f00" } }),
    ),
    { width: Math.ceil(REFERENCE * 1.6 * Math.max(name.length, 4)), height: Math.ceil(lineHeight), fonts: [{ name: "name", data: font, weight: 400, style: "normal" }] },
  );
  const d = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1]).join("");
  const marker = /<rect x="([\d.]+)" y="0" width="1" height="1" fill="#f00"\/>/.exec(svg);
  return d && marker ? { d, advance: Number(marker[1]) } : null;
}

// A shader style's box round the name's line, in em: the padding the profile
// gives its big name, and the room a fire style takes for its flames.
function shaderPadding(style: ShaderNameStyle, face: OgNameFont | null): { inline: number; top: number; bottom: number } {
  if (style === "inferno" || style === "hellfire") return { inline: 0.2, top: 0.8, bottom: 0.45 };
  const block = face ? face.padBlock : 0.3;
  return { inline: 0.2, top: block, bottom: block };
}

// What the page adds round a live shader's canvas (styles.css).
const SHADER_FILTERS: Partial<Record<ShaderNameStyle, string>> = {
  chrome: "drop-shadow(0 0.04em 0.06em rgba(0, 0, 0, 0.6))",
  inferno: "drop-shadow(0 -0.06em 0.3em rgba(255, 90, 20, 0.45))",
  hellfire: "drop-shadow(0 -0.06em 0.3em rgba(110, 90, 255, 0.5))",
};

// The shader works at twice the picture's size, as a browser does on a dense screen.
const SHADER_SCALE = 2;

/** The still of a shader style over `box`, as a PNG data URL the size of the box. */
async function shaderStill(style: ShaderNameStyle, d: string, box: Box, glyphX: number, glyphY: number, scale: number): Promise<string> {
  const width = Math.max(2, Math.round(box.width * SHADER_SCALE));
  const height = Math.max(2, Math.round(box.height * SHADER_SCALE));
  const { renderAsync } = await import("@resvg/resvg-js");
  // The mask: the letters in white where the box lays them out.
  const rendered = await renderAsync(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}"><path d="${d}" fill="#fff" transform="translate(${round(glyphX)} ${round(glyphY)}) scale(${scale.toFixed(5)})"/></svg>`,
    { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } },
  );
  const pixels = rendered.pixels;
  const alpha = new Float32Array(rendered.width * rendered.height);
  for (let index = 0; index < alpha.length; index++) alpha[index] = pixels[index * 4 + 3]! / 255;
  const mask: NameMask = { alpha, width: rendered.width, height: rendered.height };
  // The moment is picked on a smaller copy: the fire styles shade every pixel of their box.
  const shaded = shadeNameStill(style, mask, previewMask(mask, style === "inferno" || style === "hellfire" ? 4 : 2));
  const raw = Buffer.alloc(shaded.length);
  for (let at = 0; at < shaded.length; at += 4) {
    const a = shaded[at + 3]!;
    // The all-but-invisible pixels are cleared, as the site clears them off a still.
    if (a < 10 / 255) continue;
    raw[at] = Math.round(Math.min(1, shaded[at]! / a) * 255);
    raw[at + 1] = Math.round(Math.min(1, shaded[at + 1]! / a) * 255);
    raw[at + 2] = Math.round(Math.min(1, shaded[at + 2]! / a) * 255);
    raw[at + 3] = Math.round(Math.min(1, a) * 255);
  }
  const { default: sharp } = await import("sharp");
  const png = await sharp(raw, { raw: { width: mask.width, height: mask.height, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

export interface OgNameTag {
  png: Buffer;
  /** The picture's size, glow room included. */
  width: number;
  height: number;
  /** Where the name's own line sits in the picture: lay the picture out by this box. */
  line: Box;
}

export interface OgNameTagOptions {
  name: string;
  look: OgNameLook;
  /** The size and line height the picture sets a plain name at. */
  fontSize: number;
  lineHeight?: number;
  /** The plain name's colour, which a font or outline alone keeps. */
  color: string;
  /** The name is set smaller until it is no wider than this. */
  maxWidth?: number;
  fonts: OgNameTagFonts;
}

/* A supporter's name comes up in picture after picture (every feed post, each
   rankings page), and a shader still takes a moment to work out: the last
   drawn names are kept. A drawing depends on nothing but its options. */
const DRAWN_LIMIT = 200;
const drawn = new Map<string, Promise<OgNameTag | null>>();

/** The name in its look, or null when it cannot be drawn: the caller then draws it plain. */
export function drawNameTag(options: OgNameTagOptions): Promise<OgNameTag | null> {
  const { look } = options;
  const key = JSON.stringify([options.name, look.style, look.font, look.outline, options.fontSize, options.lineHeight ?? null, options.color, options.maxWidth ?? null]);
  const kept = drawn.get(key);
  if (kept) {
    // Moved to the end: the first key is the one unused longest.
    drawn.delete(key);
    drawn.set(key, kept);
    return kept;
  }
  const pending = drawNameTagFresh(options);
  drawn.set(key, pending);
  if (drawn.size > DRAWN_LIMIT) drawn.delete(drawn.keys().next().value!);
  // A name that could not be drawn is tried again next time.
  void pending.then((tag) => {
    if (!tag && drawn.get(key) === pending) drawn.delete(key);
  });
  return pending;
}

async function drawNameTagFresh(options: OgNameTagOptions): Promise<OgNameTag | null> {
  const { name, look } = options;
  const lineHeight = options.lineHeight ?? 1.25;
  const styleId = look.style === "terminal-bare" ? "terminal" : look.style;
  const shader = isOgShaderNameStyle(styleId) ? styleId : null;
  const solid = styleId && /^solid-[0-9a-f]{6}$/.test(styleId) ? `#${styleId.slice(6)}` : null;
  const style: NameStyle = solid ? { fill: solid } : (styleId ? NAME_STYLES[styleId] : null) ?? {};
  const face: OgNameFont | null = look.font ? OG_NAME_FONTS[look.font] ?? null : null;
  const outline = look.outline && /^[0-9a-f]{6}[1-3]?$/.test(look.outline) ? look.outline : null;
  if (!solid && !Object.keys(style).length && !face && !outline) return null;

  try {
    const fontFile = face?.file ?? (style.mono ? TERMINAL_FONT_FILE : null);
    const fontData = fontFile ? await options.fonts.load(fontFile) : options.fonts.base;
    // A picked font's spacing wins over a style's own.
    const spacing = face ? face.spacing : style.spacing ?? 0;
    const outlines = await outlineName(name, fontData, REFERENCE * (face?.scale ?? 1), spacing * REFERENCE, REFERENCE * lineHeight);
    if (!outlines) return null;

    const natural = (outlines.advance / REFERENCE) * options.fontSize;
    const em = options.fontSize * (options.maxWidth && natural > options.maxWidth ? options.maxWidth / natural : 1);
    const scale = em / REFERENCE;
    // Glow room round the line; a fire style's flames and their glow rise further.
    const room = Math.ceil(em * (shader === "inferno" || shader === "hellfire" ? 1.7 : 1.05));
    const line: Box = { x: room, y: room, width: outlines.advance * scale, height: em * lineHeight };
    const width = Math.ceil(line.width + room * 2);
    const height = Math.ceil(line.height + room * 2);
    const canvas: Box = { x: 0, y: 0, width, height };

    // The box the fill is painted over: the line and the padding its rules add.
    const padInline = style.backing ? (style.backing === "long-note" ? 0.46 : 0.42) : face ? 0.08 : styleId ? 0.4 : 0;
    const padBlock = face ? face.padBlock : styleId ? 0.25 : 0;
    const shift = (style.shift ?? 0) * em;
    const box: Box = { x: line.x - padInline * em, y: line.y - padBlock * em + shift, width: line.width + padInline * 2 * em, height: line.height + padBlock * 2 * em };

    let ids = 0;
    const draw: Draw = { defs: [], id: () => `n${ids++}`, em };
    draw.defs.push(`<path id="t" d="${outlines.d}"/>`);
    const letters = (attributes: string, dx = 0, dy = 0) =>
      `<use href="#t" transform="translate(${round(line.x + dx)} ${round(line.y + shift + dy)}) scale(${scale.toFixed(5)})" ${attributes}/>`;
    const strokeWidth = (value: number) => `stroke-width="${round(value / scale)}"`;

    // The stroke the letters carry: the outline wins over a style's or a font's own.
    const styleStroke = style.stroke ? splitTop(style.stroke, " ") : null;
    const stroke = outline
      ? { width: OUTLINE_WIDTHS[outline.length > 6 ? Number(outline[6]) - 1 : 3]! * em, colour: { rgb: `#${outline.slice(0, 6)}`, alpha: 1 } as Colour | null, under: true, join: "round" }
      : styleStroke
        ? { width: Math.max(parseLength(styleStroke[0]!).em * em, 0.8), colour: parseColour(styleStroke[1]!), under: Boolean(style.strokeUnder), join: "miter" }
        // Heavy pixel thickens itself in its own colour; under a clipped fill the fill shows through instead.
        : face?.stroke
          ? { width: face.stroke * em, colour: style.images ? null : parseColour(style.fill ?? options.color), under: true, join: "miter" }
          : null;
    const strokeTag = stroke?.colour
      ? letters(`fill="none" ${paint(stroke.colour, "stroke")} ${strokeWidth(stroke.width)} stroke-linejoin="${stroke.join}"`)
      : "";

    if (shader) {
      // The still of the shader over the letters, an outline under it as the page draws one.
      const pad = shaderPadding(shader, face);
      const stillBox: Box = { x: line.x - pad.inline * em, y: line.y - pad.top * em, width: line.width + pad.inline * 2 * em, height: line.height + (pad.top + pad.bottom) * em };
      const still = await shaderStill(shader, outlines.d, stillBox, line.x, line.y, scale);
      const under = outline ? strokeTag : "";
      const glow = SHADER_FILTERS[shader];
      const filterId = glow ? dropShadowFilter(glow, canvas, draw) : null;
      const image = `<image x="${round(stillBox.x)}" y="${round(stillBox.y)}" width="${round(stillBox.width)}" height="${round(stillBox.height)}" preserveAspectRatio="none" href="${still}"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${draw.defs.join("")}</defs>${under}<g${filterId ? ` filter="url(#${filterId})"` : ""}>${image}</g></svg>`;
      const { renderAsync } = await import("@resvg/resvg-js");
      const drawn = await renderAsync(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } });
      return { png: drawn.asPng(), width, height, line };
    }

    const body: string[] = [];
    if (style.backing) body.push(backing(style.backing, box, draw));
    if (style.textShadow) {
      for (const shadow of splitTop(style.textShadow, ",").map((value) => parseShadow(value, em)).reverse()) {
        let filter = "";
        if (shadow.blur > 0) {
          const id = draw.id();
          draw.defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><feGaussianBlur stdDeviation="${round(shadow.blur / 2)}"/></filter>`);
          filter = ` filter="url(#${id})"`;
        }
        body.push(`<g${filter}>${letters(paint(shadow.colour, "fill"), shadow.x, shadow.y)}</g>`);
      }
    }
    if (style.images) {
      // The fill shows through the letters and through their stroke's width.
      const mask = draw.id();
      draw.defs.push(`<mask id="${mask}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">${letters(`fill="#fff"${stroke ? ` stroke="#fff" ${strokeWidth(stroke.width)} stroke-linejoin="${stroke.join}"` : ""}`)}</mask>`);
      body.push(`<g mask="url(#${mask})">${backgroundLayers(style, box, draw)}</g>`);
      // The letters themselves are clear, so a stroke shows whole, whichever side of the fill it is painted.
      body.push(strokeTag);
    } else {
      if (stroke?.under) body.push(strokeTag);
      body.push(letters(paint(parseColour(style.fill ?? options.color) ?? { rgb: "#fff", alpha: 1 }, "fill")));
      if (stroke && !stroke.under) body.push(strokeTag);
    }

    const filter = style.filter ? ` filter="url(#${dropShadowFilter(style.filter, canvas, draw)})"` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${draw.defs.join("")}</defs><g${filter}>${body.join("")}</g></svg>`;
    const { renderAsync } = await import("@resvg/resvg-js");
    const image = await renderAsync(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } });
    return { png: image.asPng(), width, height, line };
  } catch {
    return null;
  }
}
