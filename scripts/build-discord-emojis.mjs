// Rasterizes the osu! grade pills and mod glyphs into PNG emoji assets the
// Discord bot uploads as custom application emojis (see
// live-backend/src/discord/emojis.ts). Discord only accepts raster emoji
// (PNG/GIF/JPEG, <=256KB), so the source SVGs are baked here once and the
// resulting PNGs are committed under public/images/discord/emojis/. The backend
// fetches them over HTTP from the site origin at registration time.
//
// Grades keep their native colored-pill look. Mods reproduce the real osu!
// mod badge (src/components/ui/ModBadge.tsx): the mod-icon.svg plate shape
// tinted the lazer ModType colour, with the glyph in the darkened same-hue
// tone lazer uses (color-mix(in srgb-linear, black, colour 10%)).
//
// Run from the repo root:  node scripts/build-discord-emojis.mjs
// Re-run after changing the source art or the catalog below.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GRADE_DIR = join(ROOT, "public/images/badges/score-ranks-v2019");
const MOD_DIR = join(ROOT, "public/images/badges/mods");
const OUT_DIR = join(ROOT, "public/images/discord/emojis");

// Grade name (lowercase, used in the emoji name `grade_<x>`) -> source pill svg.
const GRADES = {
  xh: "GradeSmall-SS-Silver",
  x: "GradeSmall-SS",
  sh: "GradeSmall-S-Silver",
  s: "GradeSmall-S",
  a: "GradeSmall-A",
  b: "GradeSmall-B",
  c: "GradeSmall-C",
  d: "GradeSmall-D",
  f: "GradeSmall-F",
};

// Difficulty colour buckets, matching the in-app ModBadge / lazer's
// OsuColour.ForModType exactly (increase/reduction/conversion/fun/system).
const RED = "#ff6666"; // difficulty increase
const GREEN = "#b2ff66"; // difficulty reduction
const PURPLE = "#8c66ff"; // conversion
const PINK = "#ff66ab"; // fun
const YELLOW = "#ffcc22"; // system / scoring

// Mod acronym (lowercase, emoji name `mod_<acr>`) -> { file, colour }. Curated to
// the mods that actually show up on osu!mania scores plus the key-conversion
// mods, so the upload stays small.
const MODS = {
  // Difficulty increase
  dt: { file: "mod-double-time", color: RED },
  nc: { file: "mod-nightcore", color: RED },
  hd: { file: "mod-hidden", color: RED },
  fi: { file: "mod-fade-in", color: RED },
  co: { file: "mod-cover", color: RED },
  hr: { file: "mod-hard-rock", color: RED },
  fl: { file: "mod-flashlight", color: RED },
  sd: { file: "mod-sudden-death", color: RED },
  pf: { file: "mod-perfect", color: RED },
  ac: { file: "mod-accuracy-challenge", color: RED },
  // Difficulty reduction
  ez: { file: "mod-easy", color: GREEN },
  nf: { file: "mod-no-fail", color: GREEN },
  ht: { file: "mod-half-time", color: GREEN },
  dc: { file: "mod-daycore", color: GREEN },
  nr: { file: "mod-no-release", color: GREEN },
  // Conversion
  mr: { file: "mod-mirror", color: PURPLE },
  rd: { file: "mod-random", color: PURPLE },
  in: { file: "mod-invert", color: PURPLE },
  ho: { file: "mod-hold-off", color: PURPLE },
  cs: { file: "mod-constant-speed", color: PURPLE },
  da: { file: "mod-difficulty-adjust", color: PURPLE },
  cl: { file: "mod-classic", color: PURPLE },
  // Fun
  as: { file: "mod-adaptive-speed", color: PINK },
  wu: { file: "mod-wind-up", color: PINK },
  wd: { file: "mod-wind-down", color: PINK },
  mu: { file: "mod-muted", color: PINK },
  sy: { file: "mod-synesthesia", color: PINK },
  // System / scoring
  sv2: { file: "mod-score-v2", color: YELLOW },
  // Key conversion
  "1k": { file: "mod-one-key", color: PURPLE },
  "2k": { file: "mod-two-keys", color: PURPLE },
  "3k": { file: "mod-three-keys", color: PURPLE },
  "4k": { file: "mod-four-keys", color: PURPLE },
  "5k": { file: "mod-five-keys", color: PURPLE },
  "6k": { file: "mod-six-keys", color: PURPLE },
  "7k": { file: "mod-seven-keys", color: PURPLE },
  "8k": { file: "mod-eight-keys", color: PURPLE },
  "9k": { file: "mod-nine-keys", color: PURPLE },
  "10k": { file: "mod-ten-keys", color: PURPLE },
};

// Judgement pills (emoji name `hit_<key>`): a rounded plate in the replay-HUD
// judgement colour with the label in a darkened same-hue tone (the osu-web mod
// badge treatment), used for the score hit breakdown. Colours mirror
// JUDGMENT_COLORS in src/components/replay/ReplayCanvas.ts.
const HITS = {
  320: { color: "#b3f5ff", label: "320" },
  300: { color: "#ffcc22", label: "300" },
  200: { color: "#88da20", label: "200" },
  100: { color: "#5a8fff", label: "100" },
  50: { color: "#cc8800", label: "50" },
  miss: { color: "#ff4444", label: "miss" },
};

// Discord scales an emoji to the line height preserving aspect, so each shape
// is rendered at its native aspect: grade pills 2:1, mod badges at the
// mod-icon.svg plate's 10:7 (the frontend ModBadge is 36x24 with the same
// plate contain-fitted). 128px wide keeps them crisp at any emoji size while
// the PNGs stay tiny (well under the 256KB cap).
const SIZE = 128;
const MOD_W = 120;
const MOD_H = 84; // 10:7, mod-icon.svg's native viewBox aspect
const MOD_GLYPH_INSET = 4; // ModBadge's 1px inset on a 24px-tall badge, scaled

async function svgExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// Renders a grade pill at its native 2:1 aspect (no square padding). Discord
// scales an emoji to the line height preserving aspect, so a 2:1 pill ends up the
// same height as the mod icons and the surrounding text, whereas a square canvas
// would letterbox it and render at half height.
async function buildGrade(name, file) {
  const svg = await readFile(join(GRADE_DIR, `${file}.svg`));
  return sharp(svg, { density: 600 })
    .resize(SIZE, Math.round(SIZE / 2), { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// Silhouette of an svg tinted to a flat colour: render it, then recolour every
// pixel keeping its alpha. The plate and mod sources are shapes the app uses as
// masks, so only their alpha matters here.
async function tintedSilhouette(svg, hex, width, height) {
  const rendered = await sharp(svg, { density: 600 })
    .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = rendered;
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  for (let i = 0; i < data.length; i += info.channels) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(l) {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
}

// The glyph tone ModBadge uses: color-mix(in srgb-linear, black, colour 10%).
function glyphTone(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (shift) => linearToSrgb(srgbToLinear((n >> shift) & 0xff) * 0.1);
  return `#${[16, 8, 0].map((shift) => mix(shift).toString(16).padStart(2, "0")).join("")}`;
}

async function buildMod(name, def) {
  let modPath = join(MOD_DIR, `${def.file}.svg`);
  if (!(await svgExists(modPath))) {
    if (def.fallbackFile) modPath = join(MOD_DIR, `${def.fallbackFile}.svg`);
    if (!(await svgExists(modPath))) {
      console.warn(`  ! skip mod_${name}: missing ${def.file}.svg`);
      return null;
    }
  }
  const plate = await tintedSilhouette(await readFile(join(MOD_DIR, "mod-icon.svg")), def.color, MOD_W, MOD_H);
  const glyph = await tintedSilhouette(
    await readFile(modPath),
    glyphTone(def.color),
    MOD_W - MOD_GLYPH_INSET * 2,
    MOD_H - MOD_GLYPH_INSET * 2,
  );
  return sharp(plate).composite([{ input: glyph, gravity: "centre" }]).png().toBuffer();
}

// Darkens a #rrggbb colour toward black, for the label on a coloured plate
// (readable on light plates like the 320 cyan, where white text washes out).
function darken(hex, factor = 0.32) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 0xff) * factor);
  return `#${[16, 8, 0].map((shift) => ch(shift).toString(16).padStart(2, "0")).join("")}`;
}

// A judgement pill at the grade pill's 2:1 aspect so it matches line height:
// coloured plate, bold darkened-same-hue label.
async function buildHit(def) {
  const w = SIZE;
  const h = SIZE / 2;
  const fontSize = def.label.length > 3 ? 34 : 42;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<rect x="3" y="3" width="${w - 6}" height="${h - 6}" rx="${h / 2 - 3}" fill="${def.color}"/>` +
      `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="Exo, 'Exo 2', sans-serif" ` +
      `font-size="${fontSize}" font-weight="800" fill="${darken(def.color)}">${def.label}</text>` +
      `</svg>`,
  );
  return sharp(svg, { density: 300 }).resize(w, h).png().toBuffer();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let count = 0;
  for (const [name, file] of Object.entries(GRADES)) {
    const png = await buildGrade(name, file);
    await writeFile(join(OUT_DIR, `grade_${name}.png`), png);
    count += 1;
  }
  for (const [name, def] of Object.entries(MODS)) {
    const png = await buildMod(name, def);
    if (!png) continue;
    await writeFile(join(OUT_DIR, `mod_${name}.png`), png);
    count += 1;
  }
  for (const [name, def] of Object.entries(HITS)) {
    const png = await buildHit(def);
    await writeFile(join(OUT_DIR, `hit_${name}.png`), png);
    count += 1;
  }
  console.log(`Wrote ${count} emoji PNGs to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
