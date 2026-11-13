// Rasterizes the osu! grade pills, mod glyphs, skill bar segments and dan badges into PNG emoji assets the
// Discord bot uploads as custom application emojis (see
// backend/src/discord/emojis.ts). Discord only accepts raster emoji
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
// (add `dan` to write the dan badges alone)
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

// Skill bar segments (emoji name `b<colour>_<l|m|r><1-4>`, plus the shared
// empties `b0_m` and `b0_r`): square pieces that sit side by side as one bar. A
// left cap, middles and a right cap, each filled in quarters. Colour code ->
// the skillset colour the site uses (src/lib/skill-axes.ts); the codes mirror
// BAR_COLOR_CODES in backend/src/discord/emojis.ts.
const BARS = {
  st: "#8f6bd8", // Stream
  js: "#6f87d8", // Jumpstream / Chordstream
  hs: "#b06bc0", // Handstream / Bracket
  sm: "#ad6b5d", // Stamina
  jk: "#c66f84", // Jackspeed
  cj: "#c59a5c", // Chordjack / Jack
  tc: "#83a86f", // Technical
  sp: "#5fb8c9", // Delay
  ln: "#f07474", // LN
};
const BAR_H = 60; // the strip's height on the 128px square
const BAR_TRACK = "rgba(128,132,142,0.34)"; // reads on dark and light themes

function barShape(kind) {
  const y = (SIZE - BAR_H) / 2;
  const round = BAR_H / 2;
  const tight = 8;
  const left = kind === "l" ? round : tight;
  const right = kind === "r" ? round : tight;
  return (
    `M${left},${y} H${SIZE - right} A${right},${right} 0 0 1 ${SIZE},${y + right} V${y + BAR_H - right} ` +
    `A${right},${right} 0 0 1 ${SIZE - right},${y + BAR_H} H${left} A${left},${left} 0 0 1 0,${y + BAR_H - left} ` +
    `V${y + left} A${left},${left} 0 0 1 ${left},${y} Z`
  );
}

async function buildBar(kind, quarters, color) {
  const shape = barShape(kind);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
      `<clipPath id="c"><path d="${shape}"/></clipPath>` +
      `<path d="${shape}" fill="${BAR_TRACK}"/>` +
      (quarters > 0 ? `<rect x="0" y="0" width="${(SIZE * quarters) / 4}" height="${SIZE}" fill="${color}" clip-path="url(#c)"/>` : "") +
      `</svg>`,
  );
  return sharp(svg).png().toBuffer();
}

// The arrow ahead of a pp gain on a top play post: Discord cannot colour
// text, so the green the site gives the number is carried by this. A gain
// under 1pp gets the grey one, which reads on dark and light themes.
const GAINS = { gain_up: "#88da20", gain_small: "#8e9199" };

async function buildGain(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 128 128"><path d="M64 32 105 96H23Z" fill="${color}" stroke="${color}" stroke-width="12" stroke-linejoin="round"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Dan badges (emoji names `dan<keys>[ln]_<level>[_<tier>]_l` and `..._r`): every
// level of each ladder that has art, plain and with each of its four tier
// drawings (`m2` "--", `m1` "-", `p1` "+", `p2` "++"). The tier marks widen a
// drawing past a square, and Discord fits an emoji into a square, so each is
// written as a left and a right square the bot places side by side, like the
// pills (`dan_gap`, one blank square, stands in for a right square with nothing
// in it). A level's five drawings share one crop and one scale, so the badge is
// the same size at every tier. Mirrors DAN_LADDERS in
// backend/src/discord/emojis.ts and getDanTierImageSrc in src/lib/dan-images.ts.
// Ladder -> [folder under public/images/dans, file prefix, levels].
const DAN_DIR = join(ROOT, "public/images/dans");
const DAN_SIZE = 96;
const DAN_TIERS = { "": "", m2: "-low", m1: "-mid-low", p1: "-mid-high", p2: "-high" };
const numbered = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
const SIXK = [...numbered(0, 9), "terra", "celestial", "mystery", "nihility", "finish"];
const SEVENK = [...numbered(0, 10), "gamma", "azimuth", "zenith", "stellium"];
const DANS = {
  dan4: ["reform", "", [...numbered(1, 10), "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"]],
  dan4ln: ["ln", "", numbered(1, 17)],
  dan6: ["6k", "", SIXK],
  dan6ln: ["6k", "ln-", SIXK],
  dan7: ["7k", "", SEVENK],
  dan7ln: ["7k", "ln-", SEVENK],
};

// One drawing as pixels, with the box its ink sits in.
async function readDan(folder, file) {
  for (const extension of ["svg", "webp"]) {
    const path = join(DAN_DIR, folder, `${file}.${extension}`);
    if (!(await svgExists(path))) continue;
    const png = await sharp(await readFile(path), extension === "svg" ? { density: 96 } : undefined).png().toBuffer();
    const { info } = await sharp(png).trim().toBuffer({ resolveWithObject: true });
    const left = -(info.trimOffsetLeft ?? 0);
    const top = -(info.trimOffsetTop ?? 0);
    return { png, left, top, right: left + info.width, bottom: top + info.height };
  }
  throw new Error(`no dan badge at ${folder}/${file}`);
}

// The five drawings of one level, each as its two squares.
async function buildDanLevel(folder, file) {
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const drawings = {};
  for (const [tier, suffix] of Object.entries(DAN_TIERS)) drawings[tier] = await readDan(folder, `${file}${suffix}`);
  const all = Object.values(drawings);
  const left = Math.min(...all.map((drawing) => drawing.left));
  const top = Math.min(...all.map((drawing) => drawing.top));
  const bottom = Math.max(...all.map((drawing) => drawing.bottom));
  const widest = Math.max(...all.map((drawing) => drawing.right)) - left;
  const scale = Math.min(DAN_SIZE / (bottom - top), (DAN_SIZE * 2) / widest);
  const out = {};
  for (const [tier, drawing] of Object.entries(drawings)) {
    const cut = await sharp(drawing.png).extract({ left, top, width: drawing.right - left, height: bottom - top }).png().toBuffer();
    const sized = await sharp(cut).resize({ width: Math.max(1, Math.round((drawing.right - left) * scale)), height: Math.max(1, Math.round((bottom - top) * scale)), fit: "fill" }).png().toBuffer();
    const wide = await sharp({ create: { width: DAN_SIZE * 2, height: DAN_SIZE, channels: 4, background: clear } })
      .composite([{ input: sized, gravity: "west" }])
      .png()
      .toBuffer();
    // Palette PNGs: the badges are gradients, and in full colour they weigh several times more.
    const half = (x) => sharp(wide).extract({ left: x, top: 0, width: DAN_SIZE, height: DAN_SIZE }).png({ palette: true, quality: 90, effort: 10 }).toBuffer();
    // A drawing that ends inside the first square has nothing in its second: no file, and the bot puts the shared blank there.
    const alpha = await sharp(wide).extract({ left: DAN_SIZE, top: 0, width: DAN_SIZE, height: DAN_SIZE }).extractChannel("alpha").raw().toBuffer();
    const inked = alpha.some((value) => value > 24);
    out[tier] = [await half(0), inked ? await half(DAN_SIZE) : null];
  }
  return out;
}

// Discord fits an emoji into a square, so a wide pill shows at half height. Each
// pill is also written as a left and a right square (`<name>_l`, `<name>_r`)
// that the bot places side by side.
// `scale` below 1 draws the pill smaller, centred in the same squares (the
// judgement pills, `_sl`/`_sr`, which sit six to a reply).
async function writeHalves(name, png, { scale = 1, suffix = "" } = {}) {
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const pill = await sharp(png)
    .resize(Math.round(SIZE * 2 * scale), Math.round(SIZE * scale), { fit: "contain", background: clear })
    .png()
    .toBuffer();
  const wide = await sharp({ create: { width: SIZE * 2, height: SIZE, channels: 4, background: clear } })
    .composite([{ input: pill, gravity: "centre" }])
    .png()
    .toBuffer();
  await writeFile(join(OUT_DIR, `${name}_${suffix}l.png`), await sharp(wide).extract({ left: 0, top: 0, width: SIZE, height: SIZE }).png().toBuffer());
  await writeFile(join(OUT_DIR, `${name}_${suffix}r.png`), await sharp(wide).extract({ left: SIZE, top: 0, width: SIZE, height: SIZE }).png().toBuffer());
}

async function writeDans() {
  let count = 1;
  const narrow = [];
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  await writeFile(join(OUT_DIR, "dan_gap.png"), await sharp({ create: { width: DAN_SIZE, height: DAN_SIZE, channels: 4, background: clear } }).png().toBuffer());
  for (const [ladder, [folder, prefix, levels]] of Object.entries(DANS)) {
    for (const level of levels) {
      for (const [tier, [leftHalf, rightHalf]] of Object.entries(await buildDanLevel(folder, `${prefix}${level}`))) {
        const name = `${ladder}_${level}${tier ? `_${tier}` : ""}`;
        await writeFile(join(OUT_DIR, `${name}_l.png`), leftHalf);
        if (rightHalf) await writeFile(join(OUT_DIR, `${name}_r.png`), rightHalf);
        else narrow.push(name);
        count += rightHalf ? 2 : 1;
      }
    }
  }
  // The badges one emoji wide. DAN_NARROW in backend/src/discord/emojis.ts is this list; its test checks it against the files.
  console.log(`One emoji wide (${narrow.length}): ${narrow.sort().join(" ")}`);
  return count;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let count = 0;
  // `node scripts/build-discord-emojis.mjs dan` writes the dan badges alone.
  if (process.argv[2] === "dan") {
    console.log(`Wrote ${await writeDans()} dan badge PNGs to ${OUT_DIR}`);
    return;
  }
  for (const [name, file] of Object.entries(GRADES)) {
    const png = await buildGrade(name, file);
    await writeFile(join(OUT_DIR, `grade_${name}.png`), png);
    await writeHalves(`grade_${name}`, png);
    count += 3;
  }
  for (const [name, def] of Object.entries(MODS)) {
    const png = await buildMod(name, def);
    if (!png) continue;
    await writeFile(join(OUT_DIR, `mod_${name}.png`), png);
    await writeHalves(`mod_${name}`, png);
    count += 3;
  }
  for (const [name, def] of Object.entries(HITS)) {
    const png = await buildHit(def);
    await writeFile(join(OUT_DIR, `hit_${name}.png`), png);
    await writeHalves(`hit_${name}`, png, { scale: 0.72, suffix: "s" });
    count += 3;
  }
  for (const [name, color] of Object.entries(GAINS)) {
    await writeFile(join(OUT_DIR, `${name}.png`), await buildGain(color));
    count += 1;
  }
  for (const kind of ["m", "r"]) {
    await writeFile(join(OUT_DIR, `b0_${kind}.png`), await buildBar(kind, 0, null));
    count += 1;
  }
  for (const [code, color] of Object.entries(BARS)) {
    for (const kind of ["l", "m", "r"]) {
      for (let quarters = 1; quarters <= 4; quarters++) {
        await writeFile(join(OUT_DIR, `b${code}_${kind}${quarters}.png`), await buildBar(kind, quarters, color));
        count += 1;
      }
    }
  }
  count += await writeDans();
  console.log(`Wrote ${count} emoji PNGs to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
