// Rasterizes the osu! grade pills and mod glyphs into PNG emoji assets the
// Discord bot uploads as custom application emojis (see
// live-backend/src/discord/emojis.ts). Discord only accepts raster emoji
// (PNG/GIF/JPEG, <=256KB), so the source SVGs are baked here once and the
// resulting PNGs are committed under public/images/discord/emojis/. The backend
// fetches them over HTTP from the site origin at registration time.
//
// Grades keep their native colored-pill look. Mods are composited the osu! way:
// a rounded plate in the mod's difficulty colour with the glyph knocked out in
// white, so a mod reads at a glance even at emoji size on Discord's dark theme.
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

// Difficulty colour buckets, mirroring osu!-web / the in-app ModBadge
// (lazer's ModType categories: increase/reduction/conversion/automation/fun/system).
const RED = "#ff5b6b"; // difficulty increase
const GREEN = "#9fd84a"; // difficulty reduction
const PURPLE = "#b18bff"; // conversion
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

// Square emoji canvas. Discord scales emoji down to ~24-48px, so 128 keeps them
// crisp while the PNGs stay tiny (well under the 256KB cap).
const SIZE = 128;
const PLATE_RADIUS = 30;
const GLYPH = 92; // glyph box inside the plate

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

// White silhouette of a mod glyph: render the svg, then recolour every opaque
// pixel to white keeping its alpha. The source mods are tinted shapes the app
// uses as masks, so only their alpha matters here.
async function whiteGlyph(svg) {
  const rendered = await sharp(svg, { density: 600 })
    .resize(GLYPH, GLYPH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = rendered;
  for (let i = 0; i < data.length; i += info.channels) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
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
  const plateSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
      `<rect x="6" y="6" width="${SIZE - 12}" height="${SIZE - 12}" rx="${PLATE_RADIUS}" fill="${def.color}"/>` +
      `</svg>`,
  );
  const plate = await sharp(plateSvg).png().toBuffer();
  const glyph = await whiteGlyph(await readFile(modPath));
  return sharp(plate).composite([{ input: glyph, gravity: "centre" }]).png().toBuffer();
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
  console.log(`Wrote ${count} emoji PNGs to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
