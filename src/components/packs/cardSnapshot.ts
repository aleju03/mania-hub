import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { createCardTextures, getCosmicTierPalette } from "../player/maniacard3d/cardTexture";
import { drawManiaGlyph } from "../player/maniacard3d/cardTexture";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH } from "../player/maniacard3d/layout";
import { parseGradientStops } from "../player/maniacard3d/renderData";
import type { ManiaCardReadyData } from "../player/maniacard3d/types";

const CARD_THUMBNAIL_MIME_TYPE = "image/webp";
const CARD_THUMBNAIL_QUALITY = 0.86;

function canvasToBlob(canvas: HTMLCanvasElement, type = CARD_THUMBNAIL_MIME_TYPE): Promise<Blob> {
  if (typeof canvas.toBlob === "function") {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Card thumbnail encoding failed"));
        },
        type,
        CARD_THUMBNAIL_QUALITY,
      );
    });
  }

  const dataUrl = canvas.toDataURL(type, CARD_THUMBNAIL_QUALITY);
  return fetch(dataUrl).then((response) => response.blob());
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Card thumbnail data URL conversion failed"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Card thumbnail data URL conversion failed"));
    reader.readAsDataURL(blob);
  });
}

async function renderCardThumbnailCanvas(data: ManiaCardReadyData, width: number): Promise<{ canvas: HTMLCanvasElement; dispose: () => void }> {
  const textures = await createCardTextures(data, {
    textureScale: Math.max(0.5, Math.min(1, width / 560)),
    frontOnly: true,
  });
  const source = textures.frontTexture.image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(width * 1.4);
  const context = canvas.getContext("2d");
  if (!context) {
    textures.dispose();
    throw new Error("2D canvas is unavailable");
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, dispose: textures.dispose };
}

/* Renders a card front to a small WebP blob for persistent thumbnail caches.
   Reuses the exact texture pipeline the 3D card draws with, scaled down so
   collection pages don't hold full-size canvases alive. */
export async function renderCardThumbnailBlob(data: ManiaCardReadyData, width = 280): Promise<Blob> {
  const rendered = await renderCardThumbnailCanvas(data, width);
  try {
    return await canvasToBlob(rendered.canvas);
  } finally {
    rendered.dispose();
  }
}

/* Data URL wrapper for UI spots that need an immediate <img src>. */
export async function renderCardThumbnail(data: ManiaCardReadyData, width = 280): Promise<string> {
  return blobToDataUrl(await renderCardThumbnailBlob(data, width));
}

/* A blank, rarity-less face for pages whose rarities can't be guessed before
   they load (a collection ordered by pull date). Nearly flat and near-black,
   with the contents drawn at NEUTRAL_SKELETON_ALPHA so the tile reads as an
   empty slot rather than as the grey card Common actually is. */
const NEUTRAL_SKELETON_GRADIENT = "linear-gradient(142deg, #282a31 0%, #212329 46%, #171a1e 100%)";
const NEUTRAL_SKELETON_ALPHA = 0.3;

function skeletonGradient(tier: ManiaCardTier | null): string {
  return tier ? MANIA_TIER_STYLES[tier].badgeGradient : NEUTRAL_SKELETON_GRADIENT;
}

export function renderCardSkeletonThumbnail(tier: ManiaCardTier | null, width = 240): string | null {
  if (typeof document === "undefined") return null;

  const source = document.createElement("canvas");
  source.width = CARD_TEXTURE_WIDTH;
  source.height = CARD_TEXTURE_HEIGHT;
  const context = source.getContext("2d");
  if (!context) return null;

  drawSkeletonFront(context, tier);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(width * 1.4);
  const thumbContext = canvas.getContext("2d");
  if (!thumbContext) return null;
  thumbContext.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", CARD_THUMBNAIL_QUALITY);
}

function drawSkeletonFront(context: CanvasRenderingContext2D, tier: ManiaCardTier | null) {
  context.save();
  roundedRect(context, 0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT, 58);
  context.clip();
  drawSkeletonTierBackground(context, tier);
  if (tier && getCosmicTierPalette(tier)) drawSkeletonCosmicAccents(context, tier);
  else drawSkeletonTrianglePattern(context, tier ? 0.18 : 0.07);
  context.save();
  if (!tier) context.globalAlpha = NEUTRAL_SKELETON_ALPHA;
  drawSkeletonModeBadge(context, tier);
  drawSkeletonNamePlate(context);
  if (tier) drawSkeletonTierLabel(context, tier);
  drawSkeletonAvatar(context);
  drawSkeletonStats(context);
  context.restore();
  context.restore();
}

function drawSkeletonTierBackground(context: CanvasRenderingContext2D, tier: ManiaCardTier | null) {
  const cosmic = tier ? getCosmicTierPalette(tier) : null;
  if (cosmic) {
    const base = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
    for (const [offset, color] of cosmic.base) base.addColorStop(offset, color);
    context.fillStyle = base;
    context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

    const foilA = context.createRadialGradient(250, 210, 0, 250, 210, 560);
    foilA.addColorStop(0, cosmic.foilA[0]);
    foilA.addColorStop(0.2, cosmic.foilA[1]);
    foilA.addColorStop(0.62, "rgba(0, 0, 0, 0)");
    context.fillStyle = foilA;
    context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

    const aurora = context.createLinearGradient(0, 180, CARD_TEXTURE_WIDTH, 880);
    aurora.addColorStop(0, cosmic.aurora[0]);
    aurora.addColorStop(0.34, cosmic.aurora[1]);
    aurora.addColorStop(0.46, cosmic.aurora[2]);
    aurora.addColorStop(0.66, cosmic.aurora[3]);
    aurora.addColorStop(1, cosmic.aurora[4]);
    context.fillStyle = aurora;
    context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);

    drawSkeletonStarfield(context, cosmic.stars);
    return;
  }

  const gradient = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  const stops = parseGradientStops(skeletonGradient(tier));
  for (const stop of stops.length > 0 ? stops : [{ color: "#7c3aed", offset: 0 }, { color: "#1e1b4b", offset: 1 }]) {
    gradient.addColorStop(stop.offset, stop.color);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
}

function drawSkeletonCosmicAccents(context: CanvasRenderingContext2D, tier: ManiaCardTier) {
  const cosmic = getCosmicTierPalette(tier);
  if (!cosmic) return;

  const rim = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  for (const [offset, color] of cosmic.rim) rim.addColorStop(offset, color);
  roundedRect(context, 10, 10, CARD_TEXTURE_WIDTH - 20, CARD_TEXTURE_HEIGHT - 20, 52);
  context.strokeStyle = rim;
  context.lineWidth = 6;
  context.shadowColor = cosmic.rimGlow;
  context.shadowBlur = 18;
  context.stroke();

  context.fillStyle = cosmic.glint;
  drawSkeletonSparkle(context, 152, 130, 42, 0.58);
  drawSkeletonSparkle(context, 832, 178, 26, 0.4);
  drawSkeletonSparkle(context, 808, 1010, 36, 0.32);
}

function drawSkeletonModeBadge(context: CanvasRenderingContext2D, tier: ManiaCardTier | null) {
  const boxX = 38;
  const boxY = 38;
  const boxSize = 132;
  const boxRadius = 30;
  const stops = parseGradientStops(skeletonGradient(tier));

  context.save();
  roundedRect(context, boxX, boxY, boxSize, boxSize, boxRadius);
  context.clip();
  const gradient = context.createLinearGradient(boxX, boxY, boxX + boxSize, boxY + boxSize);
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.color);
  context.fillStyle = stops.length > 0 ? gradient : "rgba(255,255,255,0.22)";
  context.fillRect(boxX, boxY, boxSize, boxSize);
  drawSkeletonBadgePattern(context, boxX, boxY);

  const top = context.createLinearGradient(0, boxY, 0, boxY + boxSize / 2);
  top.addColorStop(0, "rgba(255,255,255,0.22)");
  top.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = top;
  context.fillRect(boxX, boxY, boxSize, boxSize / 2);

  const bottom = context.createLinearGradient(0, boxSize + boxY, 0, boxY + boxSize * 0.6);
  bottom.addColorStop(0, "rgba(0,0,0,0.25)");
  bottom.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = bottom;
  context.fillRect(boxX, boxY + boxSize * 0.6, boxSize, boxSize * 0.4);

  context.shadowColor = "rgba(0,0,0,0.45)";
  context.shadowBlur = 4;
  context.shadowOffsetY = 2;
  const glyphSize = boxSize * 0.72;
  drawManiaGlyph(context, boxX + (boxSize - glyphSize) / 2, boxY + (boxSize - glyphSize) / 2, glyphSize, "rgba(255,255,255,0.82)");
  context.restore();

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

function drawSkeletonNamePlate(context: CanvasRenderingContext2D) {
  const box = { x: 244, y: 76, width: 640, height: 104, radius: 24 };
  context.save();
  roundedRect(context, box.x, box.y, box.width, box.height, box.radius);
  context.fillStyle = "rgba(0,0,0,0.34)";
  context.fill();
  roundedRect(context, box.x, box.y, box.width, box.height, box.radius);
  context.clip();
  drawSkeletonPixelTrail(context, box.x, box.y);
  context.fillStyle = "rgba(255,255,255,0.20)";
  roundedRect(context, box.x + 190, box.y + 42, 250, 18, 9);
  context.fill();
  context.restore();
}

function drawSkeletonTierLabel(context: CanvasRenderingContext2D, tier: ManiaCardTier) {
  context.save();
  context.font = "italic 900 56px Torus, Arial, sans-serif";
  context.textAlign = "right";
  context.fillStyle = "rgba(255,255,255,0.82)";
  context.shadowColor = "rgba(0,0,0,0.65)";
  context.shadowBlur = 8;
  context.shadowOffsetY = 5;
  context.fillText(MANIA_TIER_STYLES[tier].label, 930, 232);
  context.restore();
}

function drawSkeletonAvatar(context: CanvasRenderingContext2D) {
  context.save();
  roundedRect(context, 177, 272, 646, 646, 40);
  context.fillStyle = "rgba(255,255,255,0.16)";
  context.fill();
  roundedRect(context, 185, 280, 630, 630, 32);
  context.clip();
  context.fillStyle = "rgba(255,255,255,0.58)";
  context.fillRect(185, 280, 630, 630);
  const shade = context.createLinearGradient(185, 280, 815, 910);
  shade.addColorStop(0, "rgba(255,255,255,0.22)");
  shade.addColorStop(1, "rgba(0,0,0,0.10)");
  context.fillStyle = shade;
  context.fillRect(185, 280, 630, 630);
  context.restore();
}

function drawSkeletonStats(context: CanvasRenderingContext2D) {
  context.save();
  roundedRect(context, 205, 942, 590, 250, 32);
  context.fillStyle = "rgba(0,0,0,0.30)";
  context.fill();
  context.shadowColor = "rgba(0,0,0,0.6)";
  context.shadowBlur = 6;
  context.shadowOffsetY = 4;
  context.font = "800 40px Torus, Arial, sans-serif";
  context.fillStyle = "rgba(255,255,255,0.72)";
  const labels = ["Control:", "Speed:", "Precision:"];
  for (let index = 0; index < labels.length; index += 1) {
    const y = 1015 + index * 62;
    context.textAlign = "left";
    context.fillText(labels[index]!, 260, y);
    roundedRect(context, 640, y - 30, 102, 22, 11);
    context.fillStyle = "rgba(255,255,255,0.24)";
    context.fill();
    context.fillStyle = "rgba(255,255,255,0.72)";
  }
  context.restore();
}

function drawSkeletonTrianglePattern(context: CanvasRenderingContext2D, opacity: number) {
  context.save();
  context.globalAlpha = opacity;
  for (let row = 0; row < 14; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const index = row * 17 + col;
      if (random01(index * 19.17 + 4.2) < 0.55) continue;
      const x = 70 + col * 110 + (random01(index * 43.91 + 8.5) - 0.5) * 70;
      const y = 70 + row * 96 + (random01(index * 29.37 + 12.4) - 0.5) * 80;
      const size = 18 + random01(index * 13.81 + 2.7) * 22;
      drawTriangle(context, x, y, size, size * 1.18, "rgba(255,255,255,0.045)", (random01(index * 31.7 + 11.2) - 0.5) * 0.42);
    }
  }
  context.restore();
}

function drawSkeletonStarfield(context: CanvasRenderingContext2D, palette: string[]) {
  for (let index = 0; index < 130; index += 1) {
    const x = random01(index * 19.43 + 2.1) * CARD_TEXTURE_WIDTH;
    const y = random01(index * 31.77 + 8.4) * CARD_TEXTURE_HEIGHT;
    const radius = 0.8 + random01(index * 7.91 + 4.6) * 2.4;
    const alpha = 0.14 + random01(index * 11.23 + 1.9) * 0.46;
    const color = palette[Math.floor(random01(index * 5.37 + 3.3) * palette.length) % palette.length];
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
    context.fill();
  }
}

function drawSkeletonBadgePattern(context: CanvasRenderingContext2D, x: number, y: number) {
  context.save();
  context.globalAlpha = 0.5;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const ox = x + col * 30;
      const oy = y + row * 26;
      drawTriangle(context, ox + 15, oy + 2, 20, 24, "rgba(255,255,255,0.07)", 0);
      drawTriangle(context, ox + 2, oy + 16, 12, 16, "rgba(0,0,0,0.08)", 0);
    }
  }
  context.restore();
}

function drawSkeletonPixelTrail(context: CanvasRenderingContext2D, x: number, y: number) {
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

function drawSkeletonSparkle(context: CanvasRenderingContext2D, x: number, y: number, size: number, opacity: number) {
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

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawTriangle(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: string, rotation = 0) {
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.beginPath();
  context.moveTo(0, -height / 2);
  context.lineTo(width / 2, height / 2);
  context.lineTo(-width / 2, height / 2);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.restore();
}

function random01(value: number) {
  const x = Math.sin(value * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
