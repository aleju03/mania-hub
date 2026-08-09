import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH } from "./layout";
import { buildFaceLayout } from "./textureLayout";
import type { FaceLayout } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";
import type { ManiaCardTier } from "#/lib/maniacard";

const FONT = "Torus, Arial, sans-serif";
/* Every weight the faces below draw with.

   Canvas text never triggers a webfont download the way DOM text does: it uses
   whatever is already loaded and silently falls back to Arial for the rest, so
   `font-display: swap` cannot save it either. Torus ships one file per weight,
   so the weights the surrounding page happens to have rendered decide which
   parts of the card get the real font: the username (900) came out in Torus
   while the stats block and the star average (800) came out in Arial. Force
   both in before measuring, and the card stops depending on that. */
const FONT_WEIGHTS = [800, 900];
/* Draw in the fallback rather than hang the card on a stalled font request,
   which is what happened on every draw before the wait existed. */
const FONT_LOAD_TIMEOUT_MS = 3000;
const CARD_CORNER_RADIUS = 58;
const TRIANGLE_HEIGHT_RATIO = 1.18;
const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

// Tiers at the top of the ladder drop the tier gradient and triangle flecks for
// a dark starfield front. One palette entry per tier drives the background
// wash, the star colors, and the foil rim.
export interface CosmicTierPalette {
  base: Array<[number, string]>;
  foilA: [string, string];
  foilB: [string, string];
  aurora: [string, string, string, string, string];
  stars: string[];
  // Star-core color and holo rainbow amount for the overlay shader (0-1 rgb).
  starTint: [number, number, number];
  rainbow: number;
  rim: Array<[number, string]>;
  rimGlow: string;
  glint: string;
  // Draws a large faint laurel + star behind the avatar, echoing the card back.
  laurelWatermark?: boolean;
}

const COSMIC_TIERS: Partial<Record<ManiaCardTier, CosmicTierPalette>> = {
  worldClass: {
    base: [[0, "#010409"], [0.38, "#020617"], [0.72, "#030712"], [1, "#000000"]],
    foilA: ["rgba(74, 222, 128, 0.26)", "rgba(16, 185, 129, 0.14)"],
    foilB: ["rgba(45, 212, 191, 0.16)", "rgba(22, 163, 74, 0.1)"],
    aurora: [
      "rgba(20, 83, 45, 0)",
      "rgba(34, 197, 94, 0.13)",
      "rgba(6, 182, 212, 0.08)",
      "rgba(21, 128, 61, 0.1)",
      "rgba(20, 83, 45, 0)",
    ],
    stars: ["255, 255, 255", "187, 247, 208", "153, 246, 228", "209, 250, 229"],
    starTint: [0.78, 1.0, 0.9],
    rainbow: 1,
    rim: [
      [0, "rgba(236,253,245,0.72)"],
      [0.18, "rgba(34,197,94,0.88)"],
      [0.5, "rgba(6,182,212,0.26)"],
      [0.78, "rgba(34,197,94,0.72)"],
      [1, "rgba(236,253,245,0.62)"],
    ],
    rimGlow: "rgba(34,197,94,0.52)",
    glint: "rgba(220,252,231,0.88)",
  },
  goat: {
    base: [[0, "#0c0a09"], [0.38, "#1a1006"], [0.72, "#120a03"], [1, "#000000"]],
    foilA: ["rgba(251, 191, 36, 0.30)", "rgba(217, 119, 6, 0.14)"],
    foilB: ["rgba(253, 230, 138, 0.16)", "rgba(180, 83, 9, 0.1)"],
    aurora: [
      "rgba(120, 53, 15, 0)",
      "rgba(245, 158, 11, 0.12)",
      "rgba(253, 224, 71, 0.07)",
      "rgba(146, 64, 14, 0.1)",
      "rgba(120, 53, 15, 0)",
    ],
    stars: ["253, 230, 138", "251, 191, 36", "254, 243, 199", "252, 211, 77"],
    starTint: [1.0, 0.9, 0.62],
    rainbow: 0.3,
    rim: [
      [0, "rgba(254,243,199,0.72)"],
      [0.18, "rgba(245,158,11,0.9)"],
      [0.5, "rgba(253,224,71,0.28)"],
      [0.78, "rgba(217,119,6,0.75)"],
      [1, "rgba(254,243,199,0.62)"],
    ],
    rimGlow: "rgba(245,158,11,0.52)",
    glint: "rgba(254,243,199,0.9)",
    laurelWatermark: true,
  },
};

export function getCosmicTierPalette(tier: ManiaCardTier) {
  return COSMIC_TIERS[tier] ?? null;
}

export interface CardTextureSet {
  frontTexture: CanvasTexture;
  backTexture: CanvasTexture;
  layout: FaceLayout;
  dispose: () => void;
}

/* Resolves once every weight in FONT_WEIGHTS is loaded, or once the timeout
   gives up on one. Repeat calls are cheap: the browser dedupes a load already
   in flight and returns immediately for a face it has. */
export async function loadCardFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  const loads = FONT_WEIGHTS.map((weight) =>
    // A missing or 404ing face is exactly the fallback case: draw anyway.
    document.fonts.load(`${weight} 40px Torus`).catch(() => []),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.all(loads), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function createCardTextures(
  data: ManiaCardReadyData,
  /* frontOnly leaves the back texture blank (it still exists and disposes the
     same): thumbnail snapshots read only the front, and the back's paint is
     half the canvas work. */
  options: { textureScale?: number; frontOnly?: boolean } = {},
): Promise<CardTextureSet> {
  // Before measuring, not just before drawing: the username is auto-sized from
  // its measured width, so Arial metrics would size it wrong even if the font
  // landed in time for the draw.
  await loadCardFonts();
  const textureScale = Math.max(0.5, Math.min(1, options.textureScale ?? 1));
  const frontCanvas = createCanvas(textureScale);
  const backCanvas = createCanvas(textureScale);
  const front = getContext(frontCanvas);
  const back = getContext(backCanvas);
  if (textureScale !== 1) {
    front.scale(textureScale, textureScale);
    back.scale(textureScale, textureScale);
  }
  const measure = (text: string, size: number, family: string, weight: number) => {
    front.font = `${weight} ${size}px ${family}`;
    return front.measureText(text).width;
  };
  const layout = buildFaceLayout(data, measure);
  const [avatar, laurel] = await Promise.all([
    loadImage(data.avatarUrl).catch(() => null),
    loadImage("/images/maniacard/laurel-wreath.svg").catch(() => null),
  ]);

  drawFront(front, data, layout, avatar, laurel);
  if (!options.frontOnly) drawBack(back, data, layout, laurel);

  const frontTexture = toTexture(frontCanvas);
  const backTexture = toTexture(backCanvas);

  return {
    frontTexture,
    backTexture,
    layout,
    dispose: () => {
      frontTexture.dispose();
      backTexture.dispose();
    },
  };
}

function createCanvas(textureScale: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(CARD_TEXTURE_WIDTH * textureScale);
  canvas.height = Math.round(CARD_TEXTURE_HEIGHT * textureScale);
  return canvas;
}

function getContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  return context;
}

function toTexture(canvas: HTMLCanvasElement) {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${src}`));
    image.src = src;
  });
}

function drawFront(
  context: CanvasRenderingContext2D,
  data: ManiaCardReadyData,
  layout: FaceLayout,
  avatar: HTMLImageElement | null,
  laurel: HTMLImageElement | null,
) {
  context.save();
  clipCard(context);
  drawTierBackground(context, data);
  // Cosmic tiers skip the triangle flecks entirely - their front is a clean
  // starfield (static here, drifting/twinkling in the overlay shader).
  const cosmic = COSMIC_TIERS[data.tier];
  if (cosmic) {
    if (cosmic.laurelWatermark) drawLaurelWatermark(context, data, laurel);
    drawCosmicFoilAccents(context, cosmic);
  } else {
    drawTrianglePattern(context, 0.18);
  }
  drawModeBadge(context, data);
  drawUsername(context, layout);
  drawTierLabel(context, data, layout);
  drawAvatar(context, layout, avatar);
  drawStats(context, layout);
  drawStars(context, layout);
  context.restore();
}

function drawBack(
  context: CanvasRenderingContext2D,
  data: ManiaCardReadyData,
  layout: FaceLayout,
  laurel: HTMLImageElement | null,
) {
  context.save();
  clipCard(context);
  drawTierBackground(context, data);
  drawBackOsuTriangles(context);
  drawBackRadialOverlays(context);
  drawBackFrame(context, data);
  drawBackTopPlate(context);
  drawBackBottomPlate(context);
  drawBackSideNotches(context);
  drawBackEmblem(context, data, layout);
  drawBackSparkles(context);
  drawBackLaurelAndLabel(context, data, layout, laurel);
  context.restore();
}

function clipCard(context: CanvasRenderingContext2D) {
  roundedRect(context, 0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT, CARD_CORNER_RADIUS);
  context.clip();
}

// osu!-style triangle motif for the card back: a deliberate composition of a
// few LARGE interlocking up/down triangles whose vertices share one
// equilateral grid (side 500, row height 433 on the 1000x1400 texture), in
// three flat white tones. Two double-size anchors bleed off the edges and are
// drawn first, behind the mids; two half-size accents subdivide larger shapes.
// The card clip is already applied, so edge bleed trims cleanly.
function drawBackOsuTriangles(context: CanvasRenderingContext2D) {
  const FAINT = 0.04;
  const MID = 0.065;
  const BRIGHT = 0.1;
  // Grid rows: y = -132, 301, 734, 1167, 1600; columns every 250px.
  const shapes: Array<{ points: Array<[number, number]>; alpha: number }> = [
    // Anchors (side 1000)
    { points: [[250, -132], [-250, 734], [750, 734]], alpha: FAINT },
    { points: [[250, 734], [1250, 734], [750, 1600]], alpha: FAINT },
    // Band 1 (top)
    { points: [[250, -132], [0, 301], [500, 301]], alpha: MID },
    { points: [[250, -132], [750, -132], [500, 301]], alpha: FAINT },
    { points: [[750, -132], [500, 301], [1000, 301]], alpha: BRIGHT },
    // Band 2
    { points: [[-250, 301], [250, 301], [0, 734]], alpha: MID },
    { points: [[750, 301], [1250, 301], [1000, 734]], alpha: BRIGHT },
    // Band 3
    { points: [[0, 734], [500, 734], [250, 1167]], alpha: MID },
    { points: [[750, 734], [500, 1167], [1000, 1167]], alpha: FAINT },
    // Band 4 (bottom)
    { points: [[0, 1167], [-250, 1600], [250, 1600]], alpha: BRIGHT },
    { points: [[250, 1167], [750, 1167], [500, 1600]], alpha: FAINT },
    { points: [[1000, 1167], [750, 1600], [1250, 1600]], alpha: MID },
    // Half-size accents subdividing two of the mids
    { points: [[625, 84.5], [875, 84.5], [750, 301]], alpha: BRIGHT },
    { points: [[250, 734], [125, 950.5], [375, 950.5]], alpha: BRIGHT },
  ];
  context.save();
  for (const shape of shapes) {
    polygon(context, shape.points, `rgba(255,255,255,${shape.alpha})`);
  }
  context.restore();
}

// Returns true iff (x, y) is at least `margin` px inside the rounded card path
// (a CARD_TEXTURE_WIDTH x CARD_TEXTURE_HEIGHT rect with CARD_CORNER_RADIUS).
function isInsideRoundedCard(x: number, y: number, margin: number) {
  const r = CARD_CORNER_RADIUS;
  if (x < margin || x > CARD_TEXTURE_WIDTH - margin) return false;
  if (y < margin || y > CARD_TEXTURE_HEIGHT - margin) return false;
  // If we're within the corner-quadrant box, check the arc.
  const cornerX = x < r ? r : x > CARD_TEXTURE_WIDTH - r ? CARD_TEXTURE_WIDTH - r : null;
  const cornerY = y < r ? r : y > CARD_TEXTURE_HEIGHT - r ? CARD_TEXTURE_HEIGHT - r : null;
  if (cornerX !== null && cornerY !== null) {
    const dist = Math.hypot(x - cornerX, y - cornerY);
    if (dist > r - margin) return false;
  }
  return true;
}

// CSS coords use a 500x700 viewBox, our texture is 1000x1400 - everything * 2.
function drawBackRadialOverlays(context: CanvasRenderingContext2D) {
  context.save();
  const tl = context.createRadialGradient(280, 252, 0, 280, 252, 720);
  tl.addColorStop(0, "rgba(255,255,255,0.23)");
  tl.addColorStop(0.34, "rgba(255,255,255,0)");
  context.fillStyle = tl;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

  const br = context.createRadialGradient(720, 952, 0, 720, 952, 1100);
  br.addColorStop(0, "rgba(8,20,70,0.42)");
  br.addColorStop(0.52, "rgba(8,20,70,0)");
  context.fillStyle = br;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

  const sheen = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH * 0.91, CARD_TEXTURE_HEIGHT * 0.42);
  sheen.addColorStop(0, "rgba(255,255,255,0.20)");
  sheen.addColorStop(0.24, "rgba(255,255,255,0)");
  sheen.addColorStop(0.72, "rgba(0,0,0,0.22)");
  context.fillStyle = sheen;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  context.restore();
}

function drawBackFrame(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  // Outer notched frame: rounded corners + inset notches at the vertical mid-sides
  // CSS path (scaled 2x): M86 96 Q86 60 122 60 H878 Q914 60 914 96 V340 Q882 356 882 388 V1012 Q882 1044 914 1060 V1304 Q914 1340 878 1340 H122 Q86 1340 86 1304 V1060 Q118 1044 118 1012 V388 Q118 356 86 340 Z
  const outer = (context: CanvasRenderingContext2D) => {
    context.beginPath();
    context.moveTo(86, 96);
    context.quadraticCurveTo(86, 60, 122, 60);
    context.lineTo(878, 60);
    context.quadraticCurveTo(914, 60, 914, 96);
    context.lineTo(914, 340);
    context.quadraticCurveTo(882, 356, 882, 388);
    context.lineTo(882, 1012);
    context.quadraticCurveTo(882, 1044, 914, 1060);
    context.lineTo(914, 1304);
    context.quadraticCurveTo(914, 1340, 878, 1340);
    context.lineTo(122, 1340);
    context.quadraticCurveTo(86, 1340, 86, 1304);
    context.lineTo(86, 1060);
    context.quadraticCurveTo(118, 1044, 118, 1012);
    context.lineTo(118, 388);
    context.quadraticCurveTo(118, 356, 86, 340);
    context.closePath();
  };

  context.save();
  outer(context);
  const grad = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.34, "rgba(255,255,255,0.34)");
  grad.addColorStop(0.62, `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.92)`);
  grad.addColorStop(1, "rgba(255,255,255,0.5)");
  context.strokeStyle = grad;
  context.lineWidth = 8;
  context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.45)`;
  context.shadowBlur = 18;
  context.globalAlpha = 0.9;
  context.stroke();
  context.restore();

  // Inner notched frame
  context.save();
  context.beginPath();
  context.moveTo(106, 108);
  context.quadraticCurveTo(106, 80, 134, 80);
  context.lineTo(866, 80);
  context.quadraticCurveTo(894, 80, 894, 108);
  context.lineTo(894, 332);
  context.quadraticCurveTo(862, 352, 862, 388);
  context.lineTo(862, 1012);
  context.quadraticCurveTo(862, 1048, 894, 1068);
  context.lineTo(894, 1292);
  context.quadraticCurveTo(894, 1320, 866, 1320);
  context.lineTo(134, 1320);
  context.quadraticCurveTo(106, 1320, 106, 1292);
  context.lineTo(106, 1068);
  context.quadraticCurveTo(138, 1048, 138, 1012);
  context.lineTo(138, 388);
  context.quadraticCurveTo(138, 352, 106, 332);
  context.closePath();
  context.fillStyle = "rgba(255,255,255,0.03)";
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.46)";
  context.lineWidth = 2.8;
  context.stroke();
  context.restore();
}

function drawBackTopPlate(context: CanvasRenderingContext2D) {
  // Top trapezoidal plate: M332 60 H668 L636 116 Q628 132 608 132 H392 Q372 132 364 116 Z
  context.save();
  context.beginPath();
  context.moveTo(332, 60);
  context.lineTo(668, 60);
  context.lineTo(636, 116);
  context.quadraticCurveTo(628, 132, 608, 132);
  context.lineTo(392, 132);
  context.quadraticCurveTo(372, 132, 364, 116);
  context.closePath();
  context.fillStyle = "rgba(32,8,70,0.28)";
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.28)";
  context.lineWidth = 2.8;
  context.stroke();

  // Two horizontal accent lines
  context.strokeStyle = "rgba(255,255,255,0.42)";
  context.lineWidth = 2.4;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(352, 78);
  context.lineTo(648, 78);
  context.moveTo(380, 108);
  context.lineTo(620, 108);
  context.stroke();

  // Five tiny stars
  context.font = `900 24px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.58)";
  for (const x of [420, 460, 500, 540, 580]) {
    context.fillText("★", x, 84);
  }
  context.restore();
}

function drawBackBottomPlate(context: CanvasRenderingContext2D) {
  // Bottom trapezoid: M344 1340 H656 L624 1312 Q614 1304 598 1304 H402 Q386 1304 376 1312 Z
  context.save();
  context.beginPath();
  context.moveTo(344, 1340);
  context.lineTo(656, 1340);
  context.lineTo(624, 1312);
  context.quadraticCurveTo(614, 1304, 598, 1304);
  context.lineTo(402, 1304);
  context.quadraticCurveTo(386, 1304, 376, 1312);
  context.closePath();
  context.fillStyle = "rgba(24,8,64,0.3)";
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.24)";
  context.lineWidth = 2.8;
  context.stroke();

  context.lineCap = "round";
  context.strokeStyle = "rgba(255,255,255,0.42)";
  context.lineWidth = 2.8;
  context.beginPath();
  context.moveTo(392, 1326);
  context.lineTo(476, 1326);
  context.moveTo(524, 1326);
  context.lineTo(608, 1326);
  context.stroke();

  // Center diamond marker
  context.beginPath();
  context.moveTo(500, 1312);
  context.lineTo(512, 1326);
  context.lineTo(500, 1340);
  context.lineTo(488, 1326);
  context.closePath();
  context.strokeStyle = "rgba(255,255,255,0.58)";
  context.lineWidth = 3.5;
  context.stroke();
  context.restore();
}

function drawBackSideNotches(context: CanvasRenderingContext2D) {
  context.save();
  context.lineCap = "round";
  context.strokeStyle = "rgba(255,255,255,0.4)";
  context.lineWidth = 2.6;
  context.beginPath();
  // Left side
  context.moveTo(70, 440);
  context.lineTo(70, 620);
  context.moveTo(70, 752);
  context.lineTo(70, 932);
  // Right side
  context.moveTo(930, 440);
  context.lineTo(930, 620);
  context.moveTo(930, 752);
  context.lineTo(930, 932);
  context.stroke();

  context.fillStyle = "rgba(255,255,255,0.54)";
  for (const y of [410, 452, 494, 972, 1018, 1064]) {
    context.beginPath();
    context.arc(70, y, 3.2, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.arc(930, y, 3.2, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawBackEmblem(context: CanvasRenderingContext2D, data: ManiaCardReadyData, layout: FaceLayout) {
  const { x, y } = layout.back.logoCenter;
  context.save();
  context.translate(x, y);

  // Outer ring (thick, semi-transparent)
  context.strokeStyle = "rgba(255,255,255,0.34)";
  context.lineWidth = 4.8;
  context.beginPath();
  context.arc(0, 0, 362, 0, Math.PI * 2);
  context.stroke();

  // Mid ring (dashed)
  context.strokeStyle = "rgba(255,255,255,0.46)";
  context.lineWidth = 2.4;
  context.setLineDash([4, 12]);
  context.beginPath();
  context.arc(0, 0, 336, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);

  // Inner ring
  context.strokeStyle = "rgba(255,255,255,0.26)";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(0, 0, 300, 0, Math.PI * 2);
  context.stroke();

  // 36 ring ticks (every 10°), 6 prominent
  for (let index = 0; index < 36; index += 1) {
    const angle = (index * Math.PI) / 18 - Math.PI / 2;
    const prominent = index % 6 === 0;
    const inner = prominent ? 336 : 316;
    const outer = 364;
    context.beginPath();
    context.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    context.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    context.strokeStyle = prominent ? "rgba(255,255,255,0.62)" : "rgba(255,255,255,0.36)";
    context.lineWidth = prominent ? 3.2 : 2;
    context.lineCap = "round";
    context.stroke();
  }

  // 8 orbit stars (compass positions)
  const starPositions: Array<[number, number, number, number]> = [
    [0, -346, 40, 0],
    [210, -270, 36, 18],
    [294, 0, 38, -10],
    [210, 270, 36, 12],
    [0, 346, 40, 0],
    [-210, 270, 36, -16],
    [-294, 0, 38, 8],
    [-210, -270, 36, -12],
  ];
  context.fillStyle = "rgba(255,255,255,0.78)";
  for (const [sx, sy, size, rot] of starPositions) {
    drawStarShape(context, sx, sy, size, rot);
  }

  // Disc shadow
  context.beginPath();
  context.arc(0, 0, 258, 0, Math.PI * 2);
  context.fillStyle = "rgba(0,0,0,0.22)";
  context.fill();

  // Disc gradient (matches CSS mc-back-disc)
  const disc = context.createLinearGradient(-242, -242, 242, 242);
  disc.addColorStop(0, "rgba(255,255,255,0.72)");
  disc.addColorStop(0.24, `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.88)`);
  disc.addColorStop(0.55, `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.82)`);
  disc.addColorStop(1, "rgba(9,16,58,0.82)");
  context.beginPath();
  context.arc(0, 0, 242, 0, Math.PI * 2);
  context.fillStyle = disc;
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.56)";
  context.lineWidth = 5.6;
  context.stroke();

  // Accent bed (inner colored disc behind glyph)
  context.beginPath();
  context.arc(0, 0, 194, 0, Math.PI * 2);
  context.fillStyle = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.54)`;
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.18)";
  context.lineWidth = 2.4;
  context.stroke();

  // White ring around the glyph. Drawn at the same radius as the glyph's outer
  // circle so the two overlap into a single thick solid ring rather than two
  // visible stroke edges with empty space between them.
  context.beginPath();
  context.arc(0, 0, 152, 0, Math.PI * 2);
  context.strokeStyle = "rgba(255,255,255,0.98)";
  context.lineWidth = 32;
  context.stroke();

  // Mania glyph at scale 0.304 - its outer circle sits on top of the white
  // ring stroke (both at radius 152), reinforcing the ring's thickness.
  drawManiaGlyph(context, -152, -152, 304, "rgba(255,255,255,0.98)");

  context.restore();
}

function drawStarShape(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rotateDeg: number,
) {
  const r1 = size / 2;
  const r2 = r1 * 0.42;
  context.save();
  context.translate(cx, cy);
  context.rotate((rotateDeg * Math.PI) / 180);
  context.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    const r = i % 2 === 0 ? r1 : r2;
    const px = Math.cos(angle) * r;
    const py = Math.sin(angle) * r;
    if (i === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
  context.fill();
  context.restore();
}

function drawBackSparkles(context: CanvasRenderingContext2D) {
  context.save();
  context.fillStyle = "white";
  const sparkles: Array<[number, number, number, number]> = [
    [210, 360, 34, 0.82],
    [810, 410, 18, 0.48],
    [824, 1030, 28, 0.62],
    [192, 1050, 20, 0.54],
    [298, 346, 8, 0.5],
    [712, 1054, 8, 0.48],
  ];
  for (const [sx, sy, size, opacity] of sparkles) {
    drawSparkle(context, sx, sy, size, opacity);
  }
  context.restore();
}

function drawSparkle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  opacity: number,
) {
  context.save();
  context.globalAlpha = opacity;
  context.beginPath();
  context.moveTo(x, y - size);
  context.lineTo(x + size * 0.22, y - size * 0.22);
  context.lineTo(x + size, y);
  context.lineTo(x + size * 0.22, y + size * 0.22);
  context.lineTo(x, y + size);
  context.lineTo(x - size * 0.22, y + size * 0.22);
  context.lineTo(x - size, y);
  context.lineTo(x - size * 0.22, y - size * 0.22);
  context.closePath();
  context.fill();
  context.restore();
}

function drawBackLaurelAndLabel(
  context: CanvasRenderingContext2D,
  data: ManiaCardReadyData,
  layout: FaceLayout,
  laurel: HTMLImageElement | null,
) {
  const cx = 500;
  const cy = 1162;
  // Preserve the SVG's natural aspect (~1.145) so the leaves don't squash.
  const laurelHeight = 150;
  const laurelWidth = laurelHeight * 1.145;

  context.save();
  if (laurel) {
    const off = document.createElement("canvas");
    off.width = laurelWidth;
    off.height = laurelHeight;
    const offCtx = off.getContext("2d");
    if (offCtx) {
      offCtx.drawImage(laurel, 0, 0, laurelWidth, laurelHeight);
      offCtx.globalCompositeOperation = "source-in";
      offCtx.fillStyle = "rgba(255,255,255,0.7)";
      offCtx.fillRect(0, 0, laurelWidth, laurelHeight);
      context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.7)`;
      context.shadowBlur = 18;
      context.drawImage(off, cx - laurelWidth / 2, cy - laurelHeight / 2);
    }
  } else {
    context.translate(cx, cy);
    context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.65)`;
    context.shadowBlur = 18;
    context.fillStyle = "rgba(255,255,255,0.42)";
    drawLaurelHalf(context, -1);
    drawLaurelHalf(context, 1);
    context.translate(-cx, -cy);
  }

  context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.7)`;
  context.shadowBlur = 14;
  context.fillStyle = "rgba(255,255,255,0.78)";
  drawStarShape(context, cx, cy, 56, 0);
  context.restore();

  // Rarity label
  context.save();
  context.font = `900 46px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.46)";
  context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.6)`;
  context.shadowBlur = 16;
  const spaced = layout.back.rarityLabel
    .toUpperCase()
    .split("")
    .join("   ");
  context.fillText(spaced, 500, 1284);
  context.restore();
}

function drawLaurelHalf(context: CanvasRenderingContext2D, side: 1 | -1) {
  // 7 leaves curving from the bottom up and out, mirroring across the y-axis.
  const leaves: Array<{ angle: number; distance: number; length: number; width: number; tilt: number }> = [
    { angle: 78, distance: 70, length: 38, width: 14, tilt: 28 },
    { angle: 64, distance: 84, length: 40, width: 14, tilt: 18 },
    { angle: 48, distance: 96, length: 42, width: 15, tilt: 8 },
    { angle: 30, distance: 104, length: 40, width: 14, tilt: -2 },
    { angle: 14, distance: 108, length: 38, width: 13, tilt: -10 },
    { angle: -2, distance: 108, length: 36, width: 12, tilt: -16 },
    { angle: -16, distance: 104, length: 32, width: 11, tilt: -22 },
  ];
  for (const leaf of leaves) {
    const angleRad = (leaf.angle * Math.PI) / 180;
    const lx = Math.cos(angleRad) * leaf.distance * side;
    const ly = -Math.sin(angleRad) * leaf.distance;
    context.save();
    context.translate(lx, ly);
    context.rotate(((leaf.angle - 90) * Math.PI) / 180 * side + (leaf.tilt * Math.PI) / 180);
    context.beginPath();
    context.ellipse(0, 0, leaf.width, leaf.length, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

function drawTierBackground(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  const cosmic = COSMIC_TIERS[data.tier];
  if (cosmic) {
    drawCosmicBackground(context, cosmic);
    return;
  }

  const gradient = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  const stops = data.badgeGradientStops.length > 0
    ? data.badgeGradientStops
    : [{ color: "#7c3aed", offset: 0 }, { color: "#1e1b4b", offset: 1 }];
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
}

function drawCosmicBackground(context: CanvasRenderingContext2D, tier: CosmicTierPalette) {
  context.save();

  const base = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  for (const [offset, color] of tier.base) base.addColorStop(offset, color);
  context.fillStyle = base;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

  const foilA = context.createRadialGradient(250, 210, 0, 250, 210, 560);
  foilA.addColorStop(0, tier.foilA[0]);
  foilA.addColorStop(0.2, tier.foilA[1]);
  foilA.addColorStop(0.62, "rgba(0, 0, 0, 0)");
  context.fillStyle = foilA;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

  const foilB = context.createRadialGradient(800, 1110, 0, 800, 1110, 520);
  foilB.addColorStop(0, tier.foilB[0]);
  foilB.addColorStop(0.26, tier.foilB[1]);
  foilB.addColorStop(0.76, "rgba(0, 0, 0, 0)");
  context.fillStyle = foilB;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

  const aurora = context.createLinearGradient(0, 180, CARD_TEXTURE_WIDTH, 880);
  aurora.addColorStop(0, tier.aurora[0]);
  aurora.addColorStop(0.34, tier.aurora[1]);
  aurora.addColorStop(0.46, tier.aurora[2]);
  aurora.addColorStop(0.66, tier.aurora[3]);
  aurora.addColorStop(1, tier.aurora[4]);
  context.fillStyle = aurora;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

  drawCosmicStarfield(context, tier.stars);

  context.restore();
}

function drawCosmicStarfield(context: CanvasRenderingContext2D, palette: string[]) {
  context.save();
  for (let index = 0; index < 130; index += 1) {
    const x = random01(index * 19.43 + 2.1) * CARD_TEXTURE_WIDTH;
    const y = random01(index * 31.77 + 8.4) * CARD_TEXTURE_HEIGHT;
    if (!isInsideRoundedCard(x, y, 18)) continue;
    const radius = 0.8 + random01(index * 7.91 + 4.6) * 2.4;
    const alpha = 0.14 + random01(index * 11.23 + 1.9) * 0.46;
    const color = palette[Math.floor(random01(index * 5.37 + 3.3) * palette.length) % palette.length];
    // An occasional brighter star gets a soft halo so the field reads as
    // having depth instead of uniform noise.
    if (index % 16 === 5) {
      const halo = context.createRadialGradient(x, y, 0, x, y, radius * 7);
      halo.addColorStop(0, `rgba(${color}, ${(alpha * 0.5).toFixed(3)})`);
      halo.addColorStop(1, `rgba(${color}, 0)`);
      context.fillStyle = halo;
      context.beginPath();
      context.arc(x, y, radius * 7, 0, Math.PI * 2);
      context.fill();
    }
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
    context.fill();
  }
  context.restore();
}

function drawCosmicFoilAccents(context: CanvasRenderingContext2D, tier: CosmicTierPalette) {
  context.save();

  const rim = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  for (const [offset, color] of tier.rim) rim.addColorStop(offset, color);
  roundedRect(context, 10, 10, CARD_TEXTURE_WIDTH - 20, CARD_TEXTURE_HEIGHT - 20, CARD_CORNER_RADIUS - 6);
  context.strokeStyle = rim;
  context.lineWidth = 6;
  context.shadowColor = tier.rimGlow;
  context.shadowBlur = 18;
  context.stroke();

  const glints: Array<[number, number, number, number]> = [
    [152, 130, 42, 0.7],
    [832, 178, 26, 0.46],
    [808, 1010, 36, 0.42],
    [214, 1140, 22, 0.36],
  ];
  context.fillStyle = tier.glint;
  for (const [x, y, size, opacity] of glints) {
    drawSparkle(context, x, y, size, opacity);
  }

  context.restore();
}

// Oversized laurel wreath framing the avatar, in the tier's glow color. Reuses
// the card back's wreath art so both faces read as the same emblem. Drawn
// before the avatar so the leaves sit behind it and read as a frame.
function drawLaurelWatermark(
  context: CanvasRenderingContext2D,
  data: ManiaCardReadyData,
  laurel: HTMLImageElement | null,
) {
  if (!laurel) return;
  const { r, g, b } = data.glowColor;
  // Preserve the SVG's natural aspect (~1.145) so the leaves don't squash.
  const height = 740;
  const width = height * 1.145;
  const cx = 500;
  const cy = 600;

  const tinted = document.createElement("canvas");
  tinted.width = width;
  tinted.height = height;
  const tintedContext = tinted.getContext("2d");
  if (!tintedContext) return;
  tintedContext.drawImage(laurel, 0, 0, width, height);
  tintedContext.globalCompositeOperation = "source-in";
  tintedContext.fillStyle = `rgb(${r}, ${g}, ${b})`;
  tintedContext.fillRect(0, 0, width, height);

  context.save();
  context.globalAlpha = 0.13;
  context.drawImage(tinted, cx - width / 2, cy - height / 2);
  context.restore();
}

function drawTrianglePattern(context: CanvasRenderingContext2D, opacity: number) {
  context.save();
  context.globalAlpha = opacity;

  const fitsInsideCard = (x: number, y: number, size: number, rotation: number) => {
    // Test the 3 actual triangle vertices (rotated) against the rounded card
    // path. This catches both axis-aligned overshoot and corner-arc clipping.
    const halfW = size * 0.5;
    const halfH = (size * TRIANGLE_HEIGHT_RATIO) * 0.5;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const verts: Array<[number, number]> = [
      [0, -halfH * 0.96],
      [halfW * 1.0, halfH * 0.96],
      [-halfW * 1.0, halfH * 0.96],
    ];
    for (const [vx, vy] of verts) {
      const wx = x + vx * cos - vy * sin;
      const wy = y + vx * sin + vy * cos;
      if (!isInsideRoundedCard(wx, wy, 10)) return false;
    }
    return true;
  };

  // Subtle, mostly-white flecks - mirrors the CSS pattern which is faint
  // white polygons over the tier gradient. Dark triangles only show up rarely
  // and at very low opacity so they read as soft shadows, not gashes.
  for (let row = 0; row < 14; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const index = row * 17 + col;
      const seed = random01(index * 19.17 + 4.2);
      if (seed < 0.55) continue;
      const x = 70 + col * 110 + (random01(index * 43.91 + 8.5) - 0.5) * 70;
      const y = 70 + row * 96 + (random01(index * 29.37 + 12.4) - 0.5) * 80;
      const size = 18 + random01(index * 13.81 + 2.7) * 22;
      const rotation = (random01(index * 31.7 + 11.2) - 0.5) * 0.42;
      if (!fitsInsideCard(x, y, size, rotation)) continue;
      const isDark = random01(index * 3.11 + 6.9) > 0.82;
      const alpha = isDark
        ? 0.018 + random01(index * 5.21 + 1.3) * 0.020
        : 0.030 + random01(index * 5.21 + 1.3) * 0.040;
      const tone = isDark ? "0,0,0" : "255,255,255";
      drawTriangle(context, x, y, size, size * TRIANGLE_HEIGHT_RATIO, `rgba(${tone},${alpha.toFixed(3)})`, rotation);
    }
  }
  for (let index = 0; index < 12; index += 1) {
    const seed = random01(index * 23.41 + 17.6);
    if (seed < 0.32) continue;
    const x = 100 + random01(index * 37.13 + 4.8) * (CARD_TEXTURE_WIDTH - 200);
    const y = 100 + random01(index * 61.27 + 2.2) * (CARD_TEXTURE_HEIGHT - 200);
    const size = 14 + random01(index * 11.33 + 1.7) * 14;
    const rotation = (random01(index * 17.7 + 10.1) - 0.5) * 0.56;
    if (!fitsInsideCard(x, y, size, rotation)) continue;
    const alpha = 0.018 + random01(index * 3.7 + 5.4) * 0.022;
    drawTriangle(context, x, y, size, size * TRIANGLE_HEIGHT_RATIO, `rgba(255,255,255,${alpha.toFixed(3)})`, rotation);
  }
  context.restore();
}

function drawModeBadge(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  const boxX = 38;
  const boxY = 38;
  const boxSize = 132;
  const boxRadius = 30;

  // Halo (radial bloom behind the badge)
  context.save();
  const halo = context.createRadialGradient(
    boxX + boxSize / 2,
    boxY + boxSize / 2,
    boxSize * 0.1,
    boxX + boxSize / 2,
    boxY + boxSize / 2,
    boxSize * 0.85,
  );
  halo.addColorStop(0, `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.55)`);
  halo.addColorStop(1, `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0)`);
  context.fillStyle = halo;
  context.fillRect(boxX - 18, boxY - 18, boxSize + 36, boxSize + 36);
  context.restore();

  // Base gradient fill
  context.save();
  roundedRect(context, boxX, boxY, boxSize, boxSize, boxRadius);
  context.clip();
  const gradient = context.createLinearGradient(boxX, boxY, boxX + boxSize, boxY + boxSize);
  if (data.badgeGradientStops.length > 0) {
    for (const stop of data.badgeGradientStops) gradient.addColorStop(stop.offset, stop.color);
    context.fillStyle = gradient;
  } else {
    context.fillStyle = "rgba(255,255,255,0.22)";
  }
  context.fillRect(boxX, boxY, boxSize, boxSize);

  // Repeating triangle pattern (mirrors CSS: 30x26 tile, soft white/black triangles)
  drawBadgeTrianglePattern(context, boxX, boxY, boxSize);

  // Top highlight (white to transparent over top half)
  const top = context.createLinearGradient(0, boxY, 0, boxY + boxSize / 2);
  top.addColorStop(0, "rgba(255,255,255,0.22)");
  top.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = top;
  context.fillRect(boxX, boxY, boxSize, boxSize / 2);

  // Bottom darken (black to transparent over bottom 2/5)
  const bottomStart = boxY + boxSize * 0.6;
  const bot = context.createLinearGradient(0, boxSize + boxY, 0, bottomStart);
  bot.addColorStop(0, "rgba(0,0,0,0.25)");
  bot.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = bot;
  context.fillRect(boxX, bottomStart, boxSize, boxSize - boxSize * 0.6);

  // Mania glyph (72% of box, centered)
  const glyphSize = boxSize * 0.72;
  const glyphX = boxX + (boxSize - glyphSize) / 2;
  const glyphY = boxY + (boxSize - glyphSize) / 2;
  context.shadowColor = "rgba(0,0,0,0.45)";
  context.shadowBlur = 4;
  context.shadowOffsetY = 2;
  drawManiaGlyph(context, glyphX, glyphY, glyphSize, "#ffffff");
  context.restore();

  // Outer white ring + inner black ring (matches CSS ring-1 ring-white/35 + ring-1 ring-black/20)
  context.save();
  roundedRect(context, boxX, boxY, boxSize, boxSize, boxRadius);
  context.strokeStyle = "rgba(255,255,255,0.35)";
  context.lineWidth = 3;
  context.stroke();
  roundedRect(context, boxX + 4, boxY + 4, boxSize - 8, boxSize - 8, boxRadius - 4);
  context.strokeStyle = "rgba(0,0,0,0.22)";
  context.lineWidth = 2;
  context.stroke();
  context.restore();
}

function drawUsername(context: CanvasRenderingContext2D, layout: FaceLayout) {
  const username = layout.front.username;
  const box = { x: 244, y: 76, width: 640, height: 104, radius: 24 };
  const centerX = box.x + box.width / 2;

  context.save();
  roundedRect(context, box.x, box.y, box.width, box.height, box.radius);
  context.fillStyle = "rgba(0,0,0,0.34)";
  context.fill();
  roundedRect(context, box.x, box.y, box.width, box.height, box.radius);
  context.clip();
  drawUsernamePixelTrail(context, box.x, box.y);
  context.font = `900 ${username.fontSize}px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "white";
  context.shadowColor = "rgba(0,0,0,0.52)";
  context.shadowBlur = 5;
  context.shadowOffsetY = 3;
  context.fillText(username.text, centerX, box.y + box.height / 2 + username.fontSize * 0.34);
  context.restore();
}

function drawTierLabel(
  context: CanvasRenderingContext2D,
  data: ManiaCardReadyData,
  layout: FaceLayout,
) {
  const label = layout.front.tierLabel;
  context.save();
  context.font = `italic 900 ${label.fontSize}px ${FONT}`;
  context.textAlign = "right";

  // First pass: dark drop shadow for legibility against any background.
  context.fillStyle = "rgba(255,255,255,0.95)";
  context.shadowColor = "rgba(0,0,0,0.65)";
  context.shadowBlur = 8;
  context.shadowOffsetY = 5;
  context.fillText(label.text, label.x, label.y);

  // Second pass: tier-tinted glow on top to keep the colored bloom.
  context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.6)`;
  context.shadowBlur = 22;
  context.shadowOffsetY = 0;
  context.fillText(label.text, label.x, label.y);
  context.restore();
}

function drawAvatar(context: CanvasRenderingContext2D, layout: FaceLayout, avatar: HTMLImageElement | null) {
  const box = layout.front.avatar;
  context.save();
  roundedRect(context, box.x - 8, box.y - 8, box.size + 16, box.size + 16, box.radius + 8);
  context.fillStyle = "rgba(255,255,255,0.16)";
  context.fill();
  roundedRect(context, box.x, box.y, box.size, box.size, box.radius);
  context.clip();
  if (avatar) {
    context.drawImage(avatar, box.x, box.y, box.size, box.size);
  } else {
    context.fillStyle = "rgba(0,0,0,0.42)";
    context.fillRect(box.x, box.y, box.size, box.size);
    context.font = `900 120px ${FONT}`;
    context.textAlign = "center";
    context.fillStyle = "rgba(255,255,255,0.64)";
    context.fillText("?", box.x + box.size / 2, box.y + box.size / 2 + 42);
  }
  context.restore();
}

function drawStats(context: CanvasRenderingContext2D, layout: FaceLayout) {
  context.save();
  roundedRect(context, 205, 942, 590, 250, 32);
  context.fillStyle = "rgba(0,0,0,0.30)";
  context.fill();
  context.shadowColor = "rgba(0,0,0,0.6)";
  context.shadowBlur = 6;
  context.shadowOffsetY = 4;
  context.font = `800 40px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.84)";
  for (const stat of layout.front.stats) {
    context.textAlign = "left";
    context.fillText(`${stat.label}:`, stat.x, stat.y);
    context.textAlign = "right";
    context.font = `900 56px ${FONT}`;
    context.fillStyle = "white";
    context.fillText(String(stat.value), 742, stat.y);
    context.font = `800 40px ${FONT}`;
    context.fillStyle = "rgba(255,255,255,0.84)";
  }
  context.restore();
}

function drawStars(context: CanvasRenderingContext2D, layout: FaceLayout) {
  const starSize = 64;
  const starSpacing = 70;
  const starY = 1252;
  const startX = 500 - ((layout.front.stars.length - 1) * starSpacing) / 2;
  const fullColor = "#fcd34d";

  context.save();
  context.shadowColor = "rgba(0,0,0,0.5)";
  context.shadowBlur = 4;
  context.shadowOffsetY = 4;
  context.lineWidth = 1.6;
  context.strokeStyle = "rgba(0,0,0,0.32)";

  for (const [index, star] of layout.front.stars.entries()) {
    const x = startX + index * starSpacing;
    if (star === "full") {
      context.fillStyle = fullColor;
      drawFivePointStar(context, x, starY, starSize, true);
    } else if (star === "half") {
      // Left half full, right half faded - mirrors the CSS half-star gradient.
      context.save();
      context.beginPath();
      context.rect(x - starSize, starY - starSize, starSize, starSize * 2);
      context.clip();
      context.fillStyle = fullColor;
      drawFivePointStar(context, x, starY, starSize, true);
      context.restore();

      context.save();
      context.beginPath();
      context.rect(x, starY - starSize, starSize, starSize * 2);
      context.clip();
      context.fillStyle = "rgba(252,211,77,0.22)";
      drawFivePointStar(context, x, starY, starSize, true);
      context.restore();
    } else {
      context.fillStyle = "rgba(252,211,77,0.22)";
      drawFivePointStar(context, x, starY, starSize, true);
    }
  }
  context.restore();

  context.save();
  context.textAlign = "center";
  context.font = `800 36px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.78)";
  context.shadowColor = "rgba(0,0,0,0.45)";
  context.shadowBlur = 4;
  context.shadowOffsetY = 2;
  context.fillText(layout.front.starAverage, 500, 1320);
  context.restore();
}

function drawFivePointStar(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  stroke: boolean,
) {
  const r1 = size / 2;
  const r2 = r1 * 0.42;
  context.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    const r = i % 2 === 0 ? r1 : r2;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
  context.fill();
  if (stroke) context.stroke();
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function drawTriangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fillStyle: string,
  rotation = 0,
) {
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.beginPath();
  context.moveTo(0, -height * 0.48);
  context.lineTo(width * 0.5, height * 0.48);
  context.lineTo(-width * 0.5, height * 0.48);
  context.closePath();
  context.fillStyle = fillStyle;
  context.fill();
  context.restore();
}

function drawBadgeTrianglePattern(
  context: CanvasRenderingContext2D,
  boxX: number,
  boxY: number,
  boxSize: number,
) {
  // Mirrors the CSS pattern: a 30x26 tile with 3 small triangles (white 0.14,
  // black 0.12, white 0.08), tiled across the badge.
  const tileWidth = 30;
  const tileHeight = 26;
  const cols = Math.ceil(boxSize / tileWidth) + 1;
  const rows = Math.ceil(boxSize / tileHeight) + 1;

  context.save();
  context.globalAlpha = 0.8;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const ox = boxX + col * tileWidth;
      const oy = boxY + row * tileHeight;

      // Up-pointing triangle: points 15,3 28,22 2,22 -> white 0.14
      polygon(context, [
        [ox + 15, oy + 3],
        [ox + 28, oy + 22],
        [ox + 2, oy + 22],
      ], "rgba(255,255,255,0.14)");

      // Left wedge: 3,12 11,23 -5,23 -> black 0.12
      polygon(context, [
        [ox + 3, oy + 12],
        [ox + 11, oy + 23],
        [ox - 5, oy + 23],
      ], "rgba(0,0,0,0.12)");

      // Right wedge: 27,12 35,23 19,23 -> white 0.08
      polygon(context, [
        [ox + 27, oy + 12],
        [ox + 35, oy + 23],
        [ox + 19, oy + 23],
      ], "rgba(255,255,255,0.08)");
    }
  }
  context.restore();
}

function polygon(
  context: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  fillStyle: string,
) {
  context.beginPath();
  for (let i = 0; i < points.length; i += 1) {
    const [px, py] = points[i];
    if (i === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
  context.fillStyle = fillStyle;
  context.fill();
}

function random01(value: number) {
  return fract(Math.sin(value) * 43758.5453123);
}

function fract(value: number) {
  return value - Math.floor(value);
}

function drawUsernamePixelTrail(context: CanvasRenderingContext2D, x: number, y: number) {
  const blocks = [
    [0, 0, 32, 32, "rgba(0,0,0,0.28)"],
    [0, 44, 18, 18, "rgba(0,0,0,0.36)"],
    [32, 34, 14, 14, "rgba(255,255,255,0.13)"],
    [58, 0, 24, 24, "rgba(0,0,0,0.20)"],
    [70, 36, 19, 19, "rgba(0,0,0,0.32)"],
    [102, 14, 16, 16, "rgba(0,0,0,0.24)"],
    [142, 36, 12, 12, "rgba(255,255,255,0.12)"],
  ] as const;
  for (const [left, top, width, height, fill] of blocks) {
    context.fillStyle = fill;
    context.fillRect(x + left, y + top, width, height);
  }
}

export function drawManiaGlyph(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fillStyle: string,
) {
  const path = new Path2D(MANIA_GLYPH_D);
  context.save();
  context.translate(x, y + size * 0.86);
  context.scale(size / 1000, -size / 1000);
  context.fillStyle = fillStyle;
  context.fill(path);
  context.restore();
}
