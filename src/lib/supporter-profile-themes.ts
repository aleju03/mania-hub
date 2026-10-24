import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { CSSProperties } from "react";

/* Supporter profile themes: the mood of a supporter's whole profile. A theme
   re-tints every surface and accent on the page (the site's colours all hang
   off --theme-hue and --theme-sat, so setting those on the profile's root is
   enough) and plays a living backdrop behind it, drawn by a WebGL shader
   (profile-theme-shaders.ts, loaded on demand). The bands of the page turn
   see-through over it, so the backdrop glows between the panels. The backend
   keeps the pick against the same ids (SUPPORTER_PROFILE_THEMES in
   features/supporters.ts), and it lapses with the status like the frame. */

export const SUPPORTER_PROFILE_THEMES = [
  "aurora", "sakura", "synthwave", "abyss", "cosmos", "terminal",
  "inferno", "frost", "highway", "storm", "noir", "sunset",
  "judgements", "koi", "hanabi", "vaporwave", "blackhole", "singularity",
  "knight", "knightfight", "sketch",
] as const;

export type SupporterProfileThemeId = (typeof SUPPORTER_PROFILE_THEMES)[number];

export function isSupporterProfileTheme(value: unknown): value is SupporterProfileThemeId {
  return typeof value === "string" && (SUPPORTER_PROFILE_THEMES as readonly string[]).includes(value);
}

export interface ProfileThemeLook {
  /** The site hue and saturation (0..1) the profile takes on. */
  hue: number;
  sat: number;
  /** The backdrop's darkest colour, shown until the shader draws. */
  base: string;
  /** A flat stand-in for the backdrop, for thumbnails and browsers without WebGL2. */
  swatch: string;
  /** How strongly the player's cover shows in the hero, soft-lit into the backdrop. */
  cover: number;
}

export const PROFILE_THEME_LOOKS: Record<SupporterProfileThemeId, ProfileThemeLook> = {
  aurora: { hue: 162, sat: 0.8, base: "#03080d", swatch: "linear-gradient(180deg,#05131c 0%,#0c3b3a 45%,#3a2a6b 70%,#03080d 100%)", cover: 0.25 },
  sakura: { hue: 342, sat: 0.72, base: "#120810", swatch: "linear-gradient(170deg,#2a1020 0%,#4d1d36 55%,#1a0b14 100%)", cover: 0.25 },
  synthwave: { hue: 292, sat: 0.95, base: "#0b0418", swatch: "linear-gradient(180deg,#14062e 0%,#5a1460 48%,#ff6a8a 50%,#1a0730 52%,#0b0418 100%)", cover: 0.2 },
  abyss: { hue: 196, sat: 0.9, base: "#010810", swatch: "linear-gradient(180deg,#0b3a52 0%,#06202f 45%,#010810 100%)", cover: 0.25 },
  cosmos: { hue: 252, sat: 0.8, base: "#04030c", swatch: "radial-gradient(120% 90% at 30% 30%,#3b1f6e 0%,#140b33 45%,#04030c 100%)", cover: 0.25 },
  terminal: { hue: 138, sat: 0.7, base: "#010603", swatch: "linear-gradient(180deg,#02140a 0%,#010603 100%)", cover: 0.2 },
  inferno: { hue: 16, sat: 1, base: "#0b0302", swatch: "linear-gradient(0deg,#1c0a07 0%,#2c0f08 26%,#a8380c 33%,#3a0c05 38%,#0b0302 100%)", cover: 0.25 },
  frost: { hue: 204, sat: 0.45, base: "#060a10", swatch: "linear-gradient(180deg,#1b2a3a 0%,#0d1520 60%,#060a10 100%)", cover: 0.3 },
  highway: { hue: 222, sat: 0.75, base: "#03040b", swatch: "linear-gradient(180deg,#03040b 0%,#0d1440 70%,#2a3c9a 100%)", cover: 0.2 },
  storm: { hue: 214, sat: 0.32, base: "#05070a", swatch: "linear-gradient(180deg,#1a2028 0%,#0b0e13 60%,#05070a 100%)", cover: 0.3 },
  noir: { hue: 0, sat: 0, base: "#050505", swatch: "radial-gradient(circle at 30% 70%,#3a3a3a 0 3%,transparent 4%),radial-gradient(circle at 70% 60%,#2e2e2e 0 4%,transparent 5%),linear-gradient(0deg,#1c1c1c 0%,#0c0c0c 50%,#050505 100%)", cover: 0.35 },
  judgements: { hue: 44, sat: 0.7, base: "#0a0806", swatch: "radial-gradient(90% 80% at 60% 40%,#3a2a10 0%,#140d06 55%,#0a0806 100%)", cover: 0.22 },
  koi: { hue: 178, sat: 0.55, base: "#021012", swatch: "radial-gradient(100% 90% at 40% 40%,#0d3b3a 0%,#06201f 55%,#021012 100%)", cover: 0.2 },
  hanabi: { hue: 255, sat: 0.55, base: "#03030c", swatch: "radial-gradient(70% 60% at 60% 35%,#5a2a5a 0%,#151230 45%,#03030c 100%)", cover: 0.2 },
  vaporwave: { hue: 300, sat: 0.6, base: "#160a1c", swatch: "linear-gradient(180deg,#3a1f5a 0%,#b0608a 45%,#f0a080 52%,#2a1838 56%,#160a1c 100%)", cover: 0.18 },
  blackhole: { hue: 28, sat: 0.75, base: "#030203", swatch: "radial-gradient(60% 30% at 60% 50%,#ffb060 0%,#5a2a10 30%,#030203 70%)", cover: 0.2 },
  singularity: { hue: 192, sat: 0.8, base: "#020309", swatch: "radial-gradient(45% 55% at 62% 35%,#000 0%,#000 14%,#f2fbff 17%,#3fc8ff 30%,#0b1a3a 55%,#020309 100%)", cover: 0.15 },
  knight: { hue: 318, sat: 0.4, base: "#030103", swatch: "linear-gradient(160deg,#030103 0%,#030103 46%,#ffffff 47%,#030103 49%,#2a0a2a 100%)", cover: 0.15 },
  knightfight: { hue: 272, sat: 0.6, base: "#06020c", swatch: "radial-gradient(60% 55% at 62% 35%,#5a1f8a 0%,#22093a 45%,#06020c 100%)", cover: 0.15 },
  sketch: { hue: 40, sat: 0.06, base: "#0c0b0f", swatch: "linear-gradient(160deg,#16151a 0%,#0c0b0f 60%,#08070a 100%)", cover: 0.2 },
  sunset: { hue: 22, sat: 0.85, base: "#120610", swatch: "linear-gradient(180deg,#2a0f3a 0%,#8a2f4a 45%,#f08a3c 70%,#3a1222 100%)", cover: 0.22 },
};

export const SUPPORTER_PROFILE_THEME_LABELS: Record<SupporterProfileThemeId, MessageDescriptor> = {
  aurora: msg`Aurora`,
  sakura: msg`Sakura`,
  synthwave: msg`Synthwave`,
  abyss: msg`Deep sea`,
  cosmos: msg`Nebula`,
  terminal: msg`Code rain`,
  inferno: msg`Inferno`,
  frost: msg`Frost`,
  highway: msg`Note highway`,
  storm: msg`Thunderstorm`,
  noir: msg`Noir`,
  sunset: msg`Golden hour`,
  judgements: msg`Judgement rain`,
  koi: msg`Koi pond`,
  hanabi: msg`Hanabi`,
  vaporwave: msg`Vaporwave`,
  blackhole: msg`Black hole`,
  singularity: msg`Universe Shifter`,
  knight: msg`Shattered stars`,
  knightfight: msg`Bullet hell`,
  sketch: msg`Sketchbook`,
};

/* A theme's own switches, saved with the pick (the backend keeps the same
   keys): `charts` has the Note highway play the owner's top plays instead of
   made-up notes. */
export interface ProfileThemeOptions {
  charts?: true;
}

export function parseProfileThemeOptions(value: unknown): ProfileThemeOptions {
  return value && typeof value === "object" && (value as Record<string, unknown>).charts === true ? { charts: true } : {};
}

/* The colour override for an element wearing the theme: everything under it
   that uses the site colours takes the theme's hue. The site keeps its dark
   surfaces near grey; a theme turns their tint up (--theme-surface, styles.css)
   so the panels and buttons wear the theme's colour, not the default's. */
const THEME_SURFACE = "3";

export function profileThemeStyle(theme: SupporterProfileThemeId | null, notes: HighwayNotes | null = null): CSSProperties | undefined {
  if (!theme) return undefined;
  const look = PROFILE_THEME_LOOKS[theme];
  // The Note highway takes the colour of the player's own notes.
  if (theme === "highway" && notes?.accent) {
    const { hue, sat } = rgbToHueSat(notes.accent);
    return { "--theme-hue": String(hue), "--theme-sat": String(Math.max(0.45, Math.min(0.9, sat))), "--theme-surface": THEME_SURFACE } as CSSProperties;
  }
  return { "--theme-hue": String(look.hue), "--theme-sat": String(look.sat), "--theme-surface": THEME_SURFACE } as CSSProperties;
}

/* A player's replay skin notes for the Note highway (loaded by
   components/supporter/use-highway-notes.ts, drawn by profile-theme-gl.ts). */
export const HIGHWAY_MAX_LANES = 10;

export interface HighwayNotes {
  lanes: number;
  /** Each lane's tap note side by side, one equal cell per lane; null for a skin without note art. */
  atlas: HTMLCanvasElement | null;
  /** Each lane's note height over its width, to undo the cell's stretch. */
  aspects: number[];
  /** Each lane's note colour, 0..1 rgb. */
  colors: [number, number, number][];
  /** Changes whenever the notes do, for the renderer to know when to re-upload. */
  key: string;
  /** The player's replay judgements (judgement-atlas.ts), for Judgement rain. */
  judgements: HTMLCanvasElement | null;
  /** The notes' dominant colour, 0..1 rgb at full brightness, when they have
      one: the playfield's lines and glow and the whole profile take it on.
      Null for white or grey notes, which keep the theme's blue. */
  accent: [number, number, number] | null;
}

/* Hue (degrees) and saturation (0..1) of an rgb colour. */
export function rgbToHueSat([r, g, b]: [number, number, number]): { hue: number; sat: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta < 1e-6) return { hue: 0, sat: 0 };
  const sat = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: Math.round((hue * 60 + 360) % 360), sat: Math.min(1, sat) };
}

/* A real chart section for the Note highway (use-highway-chart.ts builds it).
   Times are in ms from the section's start. */
export interface HighwayChart {
  lanes: number;
  /** One RGBA32F texel per note: start, end, 0, 0; lane after lane, each in time order. */
  notes: Float32Array;
  notesWidth: number;
  notesHeight: number;
  /** R32F, `buckets` wide and one row per lane: the first note of the lane still sounding at each bucket's start, or -1. */
  index: Float32Array;
  buckets: number;
  bucketMs: number;
  /** Per lane, one past its last note's position in `notes`. */
  laneEnd: number[];
  /** The loop's length, section plus a breath. */
  period: number;
  key: string;
}
