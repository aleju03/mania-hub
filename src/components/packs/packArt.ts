import type { PackTypeDef, PackTypeId } from "#/lib/packs";
import { drawManiaGlyph } from "../player/maniacard3d/cardTexture";

// Real booster proportions: ~72x122mm, so width/height ~0.6.
export const PACK_ART_WIDTH = 600;
export const PACK_ART_HEIGHT = 1000;
export const PACK_ASPECT = PACK_ART_WIDTH / PACK_ART_HEIGHT;

// Crimp band heights and the tear line, as fractions of the pack height.
// PackStage reads these so the DOM tear interaction lines up with the art.
export const PACK_CRIMP_FRACTION = 0.078;
export const PACK_TEAR_FRACTION = 0.16;
// The torn strip never extends below the interaction's cut band. Keeping its
// texture cropped to this fraction avoids uploading a mostly transparent
// full-pack canvas when the rip begins.
export const PACK_RIP_STRIP_FRACTION = 0.27;

const FONT = "Torus, Arial, sans-serif";

function random01(value: number) {
  const x = Math.sin(value) * 43758.5453123;
  return x - Math.floor(x);
}

/* What the foil does behind the medallion. The packs are told apart at
   selector-thumbnail size (76px wide), where a tint alone is not enough, so
   each type gets its own field treatment as well as its own colour. */
export type PackMotif = "triangles" | "scatter" | "lanes4" | "lanes7" | "rays" | "burst";

export interface PackArtStyle {
  accent: { r: number; g: number; b: number };
  /* Printed largest on the foil. This is the word that identifies the pack
     when it is 76px wide in the selector, so it is the hero, not the
     MANIACARDS brand line above it. */
  name: string;
  /* Card count on the terms line; pack types differ. */
  cardCount: number;
  /* The slice of the pool this pack deals from, already worded for print. */
  poolLabel: string;
  /* 1-4. Drawn as pips along the bottom and used to weight how loud the
     foil's treatment gets. */
  rank: number;
  motif: PackMotif;
}

const PACK_ART_RECIPES: Record<PackTypeId, { motif: PackMotif; rank: number }> = {
  standard: { motif: "triangles", rank: 1 },
  wild: { motif: "scatter", rank: 2 },
  "4k": { motif: "lanes4", rank: 2 },
  "7k": { motif: "lanes7", rank: 2 },
  elite: { motif: "rays", rank: 3 },
  legend: { motif: "burst", rank: 4 },
};

/* The pack's own terms, printed on it: how much of the ladder it deals from.
   Kept here rather than on PackTypeDef so the art owns its own wording. */
function poolLabelFor(topFraction: number): string {
  if (topFraction >= 1) return "FULL POOL";
  const percent = topFraction * 100;
  return `TOP ${percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export function packArtStyleFor(type: PackTypeDef): PackArtStyle {
  const recipe = PACK_ART_RECIPES[type.id];
  return {
    accent: type.accent,
    name: type.name.toUpperCase(),
    cardCount: type.cardCount,
    // A keymode pack's terms are who it deals, not how deep it deals.
    poolLabel: type.keys ? `${type.keys}K MAINS` : poolLabelFor(type.topFraction),
    rank: recipe.rank,
    motif: recipe.motif,
  };
}

export const DEFAULT_PACK_ART_STYLE: PackArtStyle = {
  accent: { r: 167, g: 139, b: 250 },
  name: "STANDARD",
  cardCount: 5,
  poolLabel: "FULL POOL",
  rank: 1,
  motif: "triangles",
};

const packFrontCanvasCache = new Map<string, HTMLCanvasElement>();
let cachedCardBackCanvas: HTMLCanvasElement | null = null;
let cachedCardBackDataUrl: string | null = null;

function packArtCacheKey(style: PackArtStyle): string {
  return [
    style.accent.r,
    style.accent.g,
    style.accent.b,
    style.name,
    style.cardCount,
    style.poolLabel,
    style.rank,
    style.motif,
  ].join(":");
}

type Rgb = PackArtStyle["accent"];

function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function mixRgb(color: Rgb, target: Rgb, amount: number): Rgb {
  return {
    r: Math.round(color.r + (target.r - color.r) * amount),
    g: Math.round(color.g + (target.g - color.g) * amount),
    b: Math.round(color.b + (target.b - color.b) * amount),
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 8, g: 6, b: 16 };

/* Canvas letter-spacing only landed in Chrome 99 and Safari 26, and the packs
   lean on tracked capitals throughout, so the advance is walked by hand. */
function trackedWidth(context: CanvasRenderingContext2D, text: string, spacing: number): number {
  let total = 0;
  for (const character of text) total += context.measureText(character).width + spacing;
  return total - spacing;
}

function drawTracked(
  context: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  y: number,
  spacing: number,
) {
  const previousAlign = context.textAlign;
  context.textAlign = "left";
  let x = centerX - trackedWidth(context, text, spacing) / 2;
  for (const character of text) {
    context.fillText(character, x, y);
    x += context.measureText(character).width + spacing;
  }
  context.textAlign = previousAlign;
}

/* Shrinks the type until it fits the pack's printable width. "STANDARD" is
   three characters longer than "WILD", and a hero word that overhangs the
   side welds looks like a bug rather than a big pack. */
function fitFontSize(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  weight: string,
  spacing: number,
): number {
  let size = startSize;
  while (size > 24) {
    context.font = `${weight} ${size}px ${FONT}`;
    if (trackedWidth(context, text, spacing) <= maxWidth) break;
    size -= 2;
  }
  context.font = `${weight} ${size}px ${FONT}`;
  return size;
}

/* Metallized film reads as metal because of what happens at millimetre scale:
   a fine machine-direction grain plus the weave of the substrate under it.
   Both are tiny repeating tiles rather than per-pixel passes over the whole
   600x1000 pack, which keeps the whole foil draw inside a frame. */
let foilGrainTile: HTMLCanvasElement | null = null;

function getFoilGrainTile(): HTMLCanvasElement {
  if (foilGrainTile) return foilGrainTile;
  const size = 128;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const context = tile.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Stretched along x so the noise smears into a brushed grain instead of
      // reading as television static.
      const value = random01(x * 0.7 + y * 31.4159);
      const offset = (y * size + x) * 4;
      const level = value > 0.5 ? 255 : 0;
      image.data[offset] = level;
      image.data[offset + 1] = level;
      image.data[offset + 2] = level;
      image.data[offset + 3] = Math.round(Math.abs(value - 0.5) * 46);
    }
  }
  context.putImageData(image, 0, 0);
  foilGrainTile = tile;
  return tile;
}

let foilWeaveTile: HTMLCanvasElement | null = null;

function getFoilWeaveTile(): HTMLCanvasElement {
  if (foilWeaveTile) return foilWeaveTile;
  const size = 12;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const context = tile.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.strokeStyle = "rgba(255,255,255,0.85)";
  context.lineWidth = 1;
  for (const offset of [-size, 0, size]) {
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset + size, size);
    context.stroke();
  }
  foilWeaveTile = tile;
  return tile;
}

function drawFoilSubstrate(context: CanvasRenderingContext2D, width: number, height: number) {
  const weave = context.createPattern(getFoilWeaveTile(), "repeat");
  if (weave) {
    context.save();
    context.globalAlpha = 0.05;
    context.fillStyle = weave;
    context.fillRect(0, 0, width, height);
    context.restore();
  }
  const grain = context.createPattern(getFoilGrainTile(), "repeat");
  if (grain) {
    context.save();
    context.globalAlpha = 0.55;
    context.fillStyle = grain;
    context.fillRect(0, 0, width, height);
    context.restore();
  }
}

/* Foil booster pack front, printed per pack type. Drawn once per style;
   PackStage shows it through background-image slices so the top strip can
   tear away as its own element. */
export function createPackFrontCanvas(style: PackArtStyle = DEFAULT_PACK_ART_STYLE): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = PACK_ART_WIDTH;
  canvas.height = PACK_ART_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");

  const width = PACK_ART_WIDTH;
  const height = PACK_ART_HEIGHT;
  const emblemY = height * 0.4;

  drawFoilBase(context, width, height, style.accent);
  drawFoilSubstrate(context, width, height);
  drawMotif(context, width, height, style, emblemY);
  if (style.rank >= 3) drawPrismBand(context, width, height, style.rank);
  drawSheen(context, width, height);
  drawEmblem(context, width, height, style.accent);
  drawPrint(context, width, height, style);
  drawCrimp(context, width, height, 0, style.accent);
  drawCrimp(context, width, height, height - PACK_CRIMP_FRACTION * height, style.accent);
  drawTearPerforation(context, width, height);
  drawSideWelds(context, width, height);
  drawVignette(context, width, height);

  return canvas;
}

/* Pack art is immutable after it is drawn. The selector thumbnails and the
   live 3D pouch can therefore share the same source canvas instead of paying
   the full foil draw again when a pack type is selected. Callers must treat
   the returned canvas as read-only. */
export function getCachedPackFrontCanvas(
  style: PackArtStyle = DEFAULT_PACK_ART_STYLE,
): HTMLCanvasElement {
  const key = packArtCacheKey(style);
  const cached = packFrontCanvasCache.get(key);
  if (cached) return cached;
  const canvas = createPackFrontCanvas(style);
  packFrontCanvasCache.set(key, canvas);
  return canvas;
}

/* Plain foil back for the 3D pack: same stock, crimps, and welds, no print.
   Only seen at glancing angles and through the torn gap. */
export function createPackBackCanvas(
  accent: Rgb = DEFAULT_PACK_ART_STYLE.accent,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = PACK_ART_WIDTH;
  canvas.height = PACK_ART_HEIGHT;
  paintPackBackCanvas(canvas, accent);
  return canvas;
}

/* Repaints an existing back canvas. Switching pack type has to keep the same
   canvas object: the 3D scene's back texture points at it, and swapping in a
   fresh one would mean tearing down and re-uploading the texture. */
export function paintPackBackCanvas(canvas: HTMLCanvasElement, accent: Rgb) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");

  const width = PACK_ART_WIDTH;
  const height = PACK_ART_HEIGHT;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, width, height);
  drawFoilBase(context, width, height, accent);
  drawFoilSubstrate(context, width, height);
  drawSheen(context, width, height);
  drawCrimp(context, width, height, 0, accent);
  drawCrimp(context, width, height, height - PACK_CRIMP_FRACTION * height, accent);
  drawSideWelds(context, width, height);
  drawVignette(context, width, height);
}

/* The stock itself takes the pack's colour, not just the medallion on it.
   A tinted coin on identical black film left four packs that were only
   distinguishable by squinting at a 76px thumbnail.

   The tint is a darkened accent rather than the accent itself: mixing a bright
   hue straight into the base lifts its luminance as well as its hue, which
   turned the gold pack into sepia instead of black-and-gold. */
function drawFoilBase(context: CanvasRenderingContext2D, width: number, height: number, accent: Rgb) {
  const deep = mixRgb(accent, BLACK, 0.7);
  const base = context.createLinearGradient(0, 0, width * 0.55, height);
  base.addColorStop(0, rgbString(mixRgb({ r: 27, g: 22, b: 48 }, deep, 0.42)));
  base.addColorStop(0.4, rgbString(mixRgb({ r: 17, g: 13, b: 34 }, deep, 0.28)));
  base.addColorStop(0.76, rgbString(mixRgb({ r: 11, g: 8, b: 23 }, deep, 0.18)));
  base.addColorStop(1, rgbString(mixRgb({ r: 6, g: 4, b: 15 }, deep, 0.11)));
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);
}

function rgbString(color: Rgb): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function drawMotif(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  style: PackArtStyle,
  emblemY: number,
) {
  switch (style.motif) {
    case "triangles":
      drawLargeTriangles(context, width, height, style.accent);
      return;
    case "scatter":
      drawTriangleScatter(context, width, height, style.accent);
      return;
    case "lanes4":
      drawLanes(context, width, height, style.accent, 4);
      return;
    case "lanes7":
      drawLanes(context, width, height, style.accent, 7);
      return;
    case "rays":
      drawRays(context, width, height, style.accent, emblemY, 20, 0.075);
      return;
    case "burst":
      drawRays(context, width, height, style.accent, emblemY, 32, 0.125);
      drawStarburst(context, width / 2, emblemY, style.accent);
      return;
  }
}

// A few large interlocking triangles anchored to a loose grid, in quiet foil
// tones - the osu! motif at pack scale.
function drawLargeTriangles(context: CanvasRenderingContext2D, width: number, height: number, accent: Rgb) {
  const accentSoft = mixRgb(accent, WHITE, 0.35);
  const triangles: Array<{ points: Array<[number, number]>; fill: string }> = [
    { points: [[-40, height], [220, height * 0.46], [430, height]], fill: rgba(accent, 0.1) },
    { points: [[150, height], [400, height * 0.56], [650, height]], fill: rgba(accentSoft, 0.08) },
    { points: [[290, height * 0.86], [430, height * 0.6], [570, height * 0.86]], fill: "rgba(255, 255, 255, 0.05)" },
    { points: [[width + 40, height * 0.2], [width * 0.62, height * 0.46], [width + 40, height * 0.62]], fill: rgba(accent, 0.07) },
    { points: [[-30, height * 0.22], [150, height * 0.42], [-30, height * 0.56]], fill: "rgba(255, 255, 255, 0.04)" },
  ];
  fillTriangles(context, triangles);
}

/* The volume pack's field: many small triangles rather than a few big ones,
   thickening toward the bottom so the foil looks like it is full of cards. */
function drawTriangleScatter(context: CanvasRenderingContext2D, width: number, height: number, accent: Rgb) {
  const accentSoft = mixRgb(accent, WHITE, 0.4);
  const triangles: Array<{ points: Array<[number, number]>; fill: string }> = [];
  for (let index = 0; index < 54; index += 1) {
    const seed = index * 12.9898;
    const x = random01(seed) * (width + 120) - 60;
    // Biased downward: squaring the roll pushes the field toward the bottom.
    const y = Math.pow(random01(seed + 4.1), 0.6) * height;
    const size = 26 + random01(seed + 8.3) * 104;
    const flipped = random01(seed + 12.7) > 0.55;
    const tone = random01(seed + 20.1);
    const alpha = 0.03 + random01(seed + 16.5) * 0.075;
    const half = size / 2;
    triangles.push({
      points: flipped
        ? [[x - half, y - half], [x + half, y - half], [x, y + half]]
        : [[x - half, y + half], [x + half, y + half], [x, y - half]],
      fill: tone > 0.62 ? rgba(WHITE, alpha * 0.7) : rgba(tone > 0.3 ? accent : accentSoft, alpha),
    });
  }
  fillTriangles(context, triangles);
}

/* The keymode packs' field: the playfield itself. Full-height lanes with a
   quiet fall of notes, so a 4K and a 7K pack read differently at thumbnail
   size even before the printed name does - four wide columns against seven
   narrow ones. Alphas stay in the same whisper range as the other motifs. */
function drawLanes(context: CanvasRenderingContext2D, width: number, height: number, accent: Rgb, laneCount: number) {
  const accentSoft = mixRgb(accent, WHITE, 0.4);
  const laneWidth = width / laneCount;
  for (let lane = 0; lane < laneCount; lane += 1) {
    const x = lane * laneWidth;
    // Alternating lane tint, then separators, so the columns exist even where
    // no note happens to sit.
    context.fillStyle = lane % 2 === 0 ? rgba(accent, 0.028) : "rgba(255, 255, 255, 0.018)";
    context.fillRect(x, 0, laneWidth, height);
    if (lane > 0) {
      context.fillStyle = "rgba(255, 255, 255, 0.05)";
      context.fillRect(x - 1, 0, 2, height);
    }
    // A loose fall of notes per lane; the seed keeps the print stable.
    const noteHeight = Math.max(18, laneWidth * 0.24);
    const noteInset = laneWidth * 0.14;
    const notes = 3 + Math.floor(random01(lane * 5.31) * 3);
    for (let note = 0; note < notes; note += 1) {
      const seed = lane * 17.23 + note * 6.47;
      const y = random01(seed) * (height - noteHeight);
      const tone = random01(seed + 3.9);
      const alpha = 0.05 + random01(seed + 9.2) * 0.07;
      context.fillStyle = tone > 0.7 ? rgba(WHITE, alpha * 0.7) : rgba(tone > 0.35 ? accent : accentSoft, alpha);
      context.fillRect(x + noteInset, y, laneWidth - noteInset * 2, noteHeight);
    }
  }
}

function fillTriangles(
  context: CanvasRenderingContext2D,
  triangles: Array<{ points: Array<[number, number]>; fill: string }>,
) {
  for (const triangle of triangles) {
    context.beginPath();
    triangle.points.forEach(([x, y], index) => {
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = triangle.fill;
    context.fill();
  }
}

/* Beams thrown out of the medallion. The premium packs earn their price by
   looking lit from inside rather than printed flat. */
function drawRays(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  accent: Rgb,
  centerY: number,
  count: number,
  peakAlpha: number,
) {
  const centerX = width / 2;
  const reach = Math.hypot(width, height);
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + 0.24;
    const spread = (Math.PI / count) * (0.35 + random01(index * 7.13) * 0.75);
    const alpha = peakAlpha * (0.35 + random01(index * 3.77) * 0.65);
    // Beams die well before the print: rays running the full height washed a
    // pale band straight through the pack's name.
    const beam = context.createLinearGradient(centerX, centerY, centerX + Math.cos(angle) * reach, centerY + Math.sin(angle) * reach);
    beam.addColorStop(0, rgba(mixRgb(accent, WHITE, 0.45), alpha));
    beam.addColorStop(0.34, rgba(accent, alpha * 0.4));
    beam.addColorStop(0.72, rgba(accent, 0));
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.lineTo(centerX + Math.cos(angle - spread) * reach, centerY + Math.sin(angle - spread) * reach);
    context.lineTo(centerX + Math.cos(angle + spread) * reach, centerY + Math.sin(angle + spread) * reach);
    context.closePath();
    context.fillStyle = beam;
    context.fill();
  }
  context.restore();
}

function drawStarburst(context: CanvasRenderingContext2D, centerX: number, centerY: number, accent: Rgb) {
  context.save();
  context.translate(centerX, centerY);
  context.fillStyle = rgba(mixRgb(accent, WHITE, 0.55), 0.22);
  for (const rotation of [0, Math.PI / 2]) {
    context.save();
    context.rotate(rotation);
    context.beginPath();
    context.moveTo(0, -300);
    context.lineTo(26, 0);
    context.lineTo(0, 300);
    context.lineTo(-26, 0);
    context.closePath();
    context.fill();
    context.restore();
  }
  context.restore();
}

/* Holographic shift across the film. Rank 3 gets a hint of it, rank 4 wears
   it openly, so the ladder is visible even with the colour ignored. */
function drawPrismBand(context: CanvasRenderingContext2D, width: number, height: number, rank: number) {
  const strength = rank >= 4 ? 0.085 : 0.04;
  const band = context.createLinearGradient(0, height * 0.18, width, height * 0.86);
  band.addColorStop(0, "rgba(120, 220, 255, 0)");
  band.addColorStop(0.22, `rgba(120, 220, 255, ${strength})`);
  band.addColorStop(0.42, `rgba(190, 150, 255, ${strength * 1.15})`);
  band.addColorStop(0.6, `rgba(255, 214, 140, ${strength})`);
  band.addColorStop(0.78, `rgba(255, 140, 200, ${strength * 0.9})`);
  band.addColorStop(1, "rgba(255, 140, 200, 0)");
  context.fillStyle = band;
  context.fillRect(0, 0, width, height);
}

function drawSheen(context: CanvasRenderingContext2D, width: number, height: number) {
  const sheen = context.createLinearGradient(0, 0, width, height * 0.7);
  sheen.addColorStop(0, "rgba(255,255,255,0.09)");
  sheen.addColorStop(0.22, "rgba(255,255,255,0.02)");
  sheen.addColorStop(0.48, "rgba(255,255,255,0.075)");
  sheen.addColorStop(0.62, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.2)");
  context.fillStyle = sheen;
  context.fillRect(0, 0, width, height);
}

function drawVignette(context: CanvasRenderingContext2D, width: number, height: number) {
  const vignette = context.createRadialGradient(
    width / 2,
    height * 0.46,
    width * 0.2,
    width / 2,
    height * 0.5,
    height * 0.72,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.42)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}

/* The pack's seal: a thin ring, a dashed inner ring, tick marks, and a flat
   gradient disc under the glyph. A struck coin with milled edges and a domed
   face was tried in its place and read heavier than the rest of the print;
   rank lives on the band, the pips and the motif instead. */
function drawEmblem(context: CanvasRenderingContext2D, width: number, height: number, accent: Rgb) {
  const cx = width / 2;
  const cy = height * 0.4;

  context.save();
  const halo = context.createRadialGradient(cx, cy, 0, cx, cy, 240);
  halo.addColorStop(0, rgba(accent, 0.34));
  halo.addColorStop(0.55, rgba(accent, 0.10));
  halo.addColorStop(1, rgba(accent, 0));
  context.fillStyle = halo;
  context.fillRect(cx - 250, cy - 250, 500, 500);

  context.strokeStyle = "rgba(255,255,255,0.34)";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(cx, cy, 132, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = "rgba(255,255,255,0.5)";
  context.lineWidth = 1.6;
  context.setLineDash([3, 9]);
  context.beginPath();
  context.arc(cx, cy, 118, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);

  for (let index = 0; index < 24; index += 1) {
    const angle = (index * Math.PI) / 12 - Math.PI / 2;
    const prominent = index % 6 === 0;
    const inner = prominent ? 118 : 124;
    context.beginPath();
    context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    context.lineTo(cx + Math.cos(angle) * 134, cy + Math.sin(angle) * 134);
    context.strokeStyle = prominent ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.3)";
    context.lineWidth = prominent ? 2.4 : 1.4;
    context.lineCap = "round";
    context.stroke();
  }

  context.beginPath();
  context.arc(cx, cy, 96, 0, Math.PI * 2);
  const disc = context.createLinearGradient(cx - 96, cy - 96, cx + 96, cy + 96);
  disc.addColorStop(0, rgba(mixRgb(accent, WHITE, 0.3), 0.85));
  disc.addColorStop(0.5, rgba(mixRgb(accent, BLACK, 0.3), 0.85));
  disc.addColorStop(1, rgba(mixRgb(accent, BLACK, 0.8), 0.9));
  context.fillStyle = disc;
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.55)";
  context.lineWidth = 3.4;
  context.stroke();

  context.shadowColor = "rgba(0,0,0,0.4)";
  context.shadowBlur = 8;
  drawManiaGlyph(context, cx - 62, cy - 62, 124, "rgba(255,255,255,0.96)");
  context.restore();
}

/* Everything printed on the foil below the medallion, top to bottom: the
   brand line, the pack's own name at full size, its terms, and its rank. */
function drawPrint(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  style: PackArtStyle,
) {
  const cx = width / 2;
  context.save();
  context.textAlign = "center";

  /* The brand is the hero. This started out the other way round, with the
     pack type struck large so the four packs could be told apart at 76px in
     the selector, and it read wrong for the same reason a booster of Pokemon
     cards does not say TWILIGHT MASQUERADE across the middle: the product is
     Maniacards, and the type is which Maniacards. The tint, the motif and the
     coin already carry the type at thumbnail size, and the band below picks
     up the rest. */
  const heroSpacing = 2;
  context.save();
  fitFontSize(context, "MANIACARDS", width - 96, 66, "italic 900", heroSpacing);
  context.fillStyle = "rgba(255,255,255,0.95)";
  context.shadowColor = rgba(style.accent, 0.55);
  context.shadowBlur = 22;
  drawTracked(context, "MANIACARDS", cx, height * 0.638, heroSpacing);
  context.restore();

  drawTypeBand(context, cx, height * 0.706, width, style);

  // Terms: what the pack actually deals.
  context.font = `800 24px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.78)";
  drawTracked(context, `${style.cardCount} CARDS`, cx, height * 0.782, 4);
  context.font = `700 20px ${FONT}`;
  context.fillStyle = rgba(mixRgb(style.accent, WHITE, 0.45), 0.85);
  drawTracked(context, style.poolLabel, cx, height * 0.816, 5);

  drawRankPips(context, cx, height * 0.868, style);

  // Fine print. Real packs carry a batch code, and at pack scale that tiny
  // line is most of what sells the thing as a printed object.
  context.font = `700 15px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.2)";
  drawTracked(
    context,
    `MH-${style.name.slice(0, 3)}-${String(style.cardCount).padStart(2, "0")}`,
    cx,
    height * 0.892,
    3,
  );

  context.restore();
}

/* The set band under the wordmark: which Maniacards this is. A solid block of
   the pack's colour is what survives being shrunk to a 76px thumbnail, where
   the word itself stops being readable well before the bar does. */
function drawTypeBand(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  style: PackArtStyle,
) {
  /* A flat stadium of the pack's colour, sized to its word. Fully rounded and
     with no outline or gradient on purpose: the squared, bordered version of
     this read as a UI button, and it turned out to be the border and the
     light-to-dark fill doing that rather than the corners. */
  const spacing = 9;
  const bandHeight = 40;
  context.save();
  const size = fitFontSize(context, style.name, width * 0.44, 26, "900", spacing);
  const bandWidth = trackedWidth(context, style.name, spacing) + 64;
  context.beginPath();
  context.roundRect(cx - bandWidth / 2, cy - bandHeight / 2, bandWidth, bandHeight, bandHeight / 2);
  context.fillStyle = rgba(mixRgb(style.accent, WHITE, 0.04), 0.92);
  context.fill();

  // Dark ink on the colour, the way a printed band reads. Every accent here is
  // light enough to carry it, and it keeps the four looking like one family
  // instead of white-on-some, black-on-others.
  context.fillStyle = "rgba(12,9,22,0.86)";
  context.font = `900 ${size}px ${FONT}`;
  drawTracked(context, style.name, cx, cy + size * 0.35, spacing);
  context.restore();
}

/* Four pips, filled up to the pack's rank. A viewer who cannot tell gold from
   pink still sees three diamonds against four. */
function drawRankPips(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  style: PackArtStyle,
) {
  const size = 11;
  const gap = 30;
  const start = cx - ((4 - 1) * gap) / 2;
  for (let index = 0; index < 4; index += 1) {
    const x = start + index * gap;
    context.beginPath();
    context.moveTo(x, cy - size);
    context.lineTo(x + size * 0.72, cy);
    context.lineTo(x, cy + size);
    context.lineTo(x - size * 0.72, cy);
    context.closePath();
    if (index < style.rank) {
      context.fillStyle = rgba(mixRgb(style.accent, WHITE, 0.4), 0.92);
      context.fill();
    } else {
      context.strokeStyle = "rgba(255,255,255,0.22)";
      context.lineWidth = 1.6;
      context.stroke();
    }
  }
}

function drawCrimp(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  top: number,
  accent: Rgb,
) {
  const crimpHeight = PACK_CRIMP_FRACTION * height;
  context.save();
  const band = context.createLinearGradient(0, top, 0, top + crimpHeight);
  band.addColorStop(0, "rgba(255,255,255,0.16)");
  band.addColorStop(0.5, rgba(mixRgb(accent, WHITE, 0.4), 0.09));
  band.addColorStop(1, "rgba(0,0,0,0.32)");
  context.fillStyle = band;
  context.fillRect(0, top, width, crimpHeight);

  for (let x = 6; x < width; x += 13) {
    const wobble = random01(x * 3.7) * 2;
    context.beginPath();
    context.moveTo(x + wobble, top + 4);
    context.lineTo(x + wobble, top + crimpHeight - 4);
    context.strokeStyle = x % 26 < 13 ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.22)";
    context.lineWidth = 2.4;
    context.stroke();
  }
  context.restore();
}

function drawTearPerforation(context: CanvasRenderingContext2D, width: number, height: number) {
  const y = PACK_TEAR_FRACTION * height;
  context.save();
  context.setLineDash([10, 12]);
  context.strokeStyle = "rgba(255,255,255,0.30)";
  context.lineWidth = 2.4;
  context.beginPath();
  context.moveTo(14, y);
  context.lineTo(width - 14, y);
  context.stroke();
  context.setLineDash([]);

  // Notch markers at both ends of the tear line
  context.fillStyle = "rgba(255,255,255,0.5)";
  for (const x of [10, width - 10]) {
    context.beginPath();
    context.moveTo(x, y - 9);
    context.lineTo(x + (x < width / 2 ? 12 : -12), y);
    context.lineTo(x, y + 9);
    context.closePath();
    context.fill();
  }
  context.restore();
}

function drawSideWelds(context: CanvasRenderingContext2D, width: number, height: number) {
  context.save();
  for (const x of [0, width - 14]) {
    const weld = context.createLinearGradient(x, 0, x + 14, 0);
    const inward = x === 0;
    weld.addColorStop(inward ? 0 : 1, "rgba(0,0,0,0.4)");
    weld.addColorStop(inward ? 1 : 0, "rgba(255,255,255,0.04)");
    context.fillStyle = weld;
    context.fillRect(x, 0, 14, height);
  }
  context.restore();
}

export const CARD_BACK_WIDTH = 500;
export const CARD_BACK_HEIGHT = 700;

/* Uniform face-down card back for the reveal stack. Deliberately neutral so
   it never spoils the tier before the flip. */
export function createCardBackCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_BACK_WIDTH;
  canvas.height = CARD_BACK_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");

  const width = CARD_BACK_WIDTH;
  const height = CARD_BACK_HEIGHT;
  const radius = 28;

  context.beginPath();
  context.roundRect(0, 0, width, height, radius);
  context.clip();

  const base = context.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, "#221a3d");
  base.addColorStop(0.55, "#161029");
  base.addColorStop(1, "#0b0818");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  // Corner triangles
  const corners: Array<{ points: Array<[number, number]>; fill: string }> = [
    { points: [[-20, -20], [170, -20], [-20, 150]], fill: "rgba(255,255,255,0.05)" },
    { points: [[width + 20, height + 20], [width - 170, height + 20], [width + 20, height - 150]], fill: "rgba(255,255,255,0.05)" },
    { points: [[width + 20, -20], [width - 120, -20], [width + 20, 110]], fill: "rgba(167,139,250,0.10)" },
    { points: [[-20, height + 20], [120, height + 20], [-20, height - 110]], fill: "rgba(167,139,250,0.10)" },
  ];
  fillTriangles(context, corners);

  // Frame
  context.beginPath();
  context.roundRect(16, 16, width - 32, height - 32, radius - 8);
  context.strokeStyle = "rgba(255,255,255,0.22)";
  context.lineWidth = 3;
  context.stroke();

  // Center emblem
  const cx = width / 2;
  const cy = height / 2;
  context.strokeStyle = "rgba(255,255,255,0.3)";
  context.lineWidth = 2.6;
  context.beginPath();
  context.arc(cx, cy, 108, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([3, 8]);
  context.strokeStyle = "rgba(255,255,255,0.4)";
  context.lineWidth = 1.4;
  context.beginPath();
  context.arc(cx, cy, 95, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);

  context.beginPath();
  context.arc(cx, cy, 76, 0, Math.PI * 2);
  const disc = context.createLinearGradient(cx - 76, cy - 76, cx + 76, cy + 76);
  disc.addColorStop(0, "rgba(196, 181, 253, 0.5)");
  disc.addColorStop(1, "rgba(30, 17, 70, 0.8)");
  context.fillStyle = disc;
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.4)";
  context.lineWidth = 2.6;
  context.stroke();

  context.shadowColor = "rgba(0,0,0,0.4)";
  context.shadowBlur = 6;
  drawManiaGlyph(context, cx - 48, cy - 48, 96, "rgba(255,255,255,0.92)");
  context.shadowBlur = 0;

  context.font = `800 22px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.4)";
  context.fillText("M A N I A C A R D", cx, height - 44);

  return canvas;
}

/* The neutral back is used by the shuffle, reveal stack, and 3D renderer.
   Canvas drawing and PNG encoding are both synchronous, so keep one immutable
   copy for the session and warm it while the unopened pack is idle. */
export function getCachedCardBackCanvas(): HTMLCanvasElement {
  if (!cachedCardBackCanvas) cachedCardBackCanvas = createCardBackCanvas();
  return cachedCardBackCanvas;
}

export function getCachedCardBackDataUrl(): string {
  if (!cachedCardBackDataUrl) {
    cachedCardBackDataUrl = getCachedCardBackCanvas().toDataURL("image/png");
  }
  return cachedCardBackDataUrl;
}
