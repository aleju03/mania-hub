import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH } from "./layout";
import { buildFaceLayout } from "./textureLayout";
import type { FaceLayout } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

const FONT = "Torus, Arial, sans-serif";
const CARD_CORNER_RADIUS = 58;
const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

export interface CardTextureSet {
  frontTexture: CanvasTexture;
  backTexture: CanvasTexture;
  layout: FaceLayout;
  dispose: () => void;
}

export async function createCardTextures(data: ManiaCardReadyData): Promise<CardTextureSet> {
  const frontCanvas = createCanvas();
  const backCanvas = createCanvas();
  const front = getContext(frontCanvas);
  const back = getContext(backCanvas);
  const measure = (text: string, size: number, family: string, weight: number) => {
    front.font = `${weight} ${size}px ${family}`;
    return front.measureText(text).width;
  };
  const layout = buildFaceLayout(data, measure);
  const avatar = await loadImage(data.avatarUrl).catch(() => null);

  drawFront(front, data, layout, avatar);
  drawBack(back, data, layout);

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

function createCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_TEXTURE_WIDTH;
  canvas.height = CARD_TEXTURE_HEIGHT;
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
) {
  context.save();
  clipCard(context);
  drawTierBackground(context, data);
  drawTrianglePattern(context, 0.28);
  drawModeBadge(context, data);
  drawUsername(context, layout);
  drawTierLabel(context, data, layout);
  drawAvatar(context, layout, avatar);
  drawStats(context, layout);
  drawStars(context, layout);
  context.restore();
}

function drawBack(context: CanvasRenderingContext2D, data: ManiaCardReadyData, layout: FaceLayout) {
  context.save();
  clipCard(context);
  drawTierBackground(context, data);
  drawTrianglePattern(context, 0.16);
  drawBackFrame(context, data);
  drawBackEmblem(context, data, layout);
  context.restore();
}

function clipCard(context: CanvasRenderingContext2D) {
  roundedRect(context, 0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT, CARD_CORNER_RADIUS);
  context.clip();
}

function drawBackFrame(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  context.save();
  context.strokeStyle = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.72)`;
  context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.55)`;
  context.shadowBlur = 22;
  context.lineWidth = 7;
  roundedRect(context, 92, 88, 816, 1224, 42);
  context.stroke();

  context.shadowBlur = 0;
  context.strokeStyle = "rgba(255,255,255,0.52)";
  context.lineWidth = 3;
  roundedRect(context, 116, 118, 768, 1164, 28);
  context.stroke();

  context.fillStyle = "rgba(255,255,255,0.18)";
  trapezoid(context, 360, 92, 640, 92, 604, 142, 396, 142);
  context.fill();
  context.font = `900 24px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.48)";
  context.fillText("✦ ✦ ✦ ✦ ✦", 500, 126);
  context.beginPath();
  context.moveTo(276, 1188);
  context.lineTo(724, 1188);
  context.strokeStyle = "rgba(255,255,255,0.26)";
  context.lineWidth = 2;
  context.stroke();
  context.restore();
}

function drawBackEmblem(context: CanvasRenderingContext2D, data: ManiaCardReadyData, layout: FaceLayout) {
  const { x, y } = layout.back.logoCenter;
  context.save();
  context.translate(x, y);

  context.strokeStyle = "rgba(255,255,255,0.22)";
  context.lineWidth = 2;
  for (const radius of [310, 280, 236]) {
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.stroke();
  }

  for (let index = 0; index < 36; index += 1) {
    const angle = (index / 36) * Math.PI * 2;
    const inner = index % 6 === 0 ? 246 : 260;
    const outer = 278;
    context.beginPath();
    context.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    context.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    context.strokeStyle = index % 6 === 0 ? "rgba(255,255,255,0.46)" : "rgba(255,255,255,0.24)";
    context.lineWidth = index % 6 === 0 ? 4 : 2;
    context.stroke();
  }

  context.font = `900 34px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.72)";
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2 - Math.PI / 2;
    context.fillText("★", Math.cos(angle) * 292, Math.sin(angle) * 292 + 12);
  }

  const disc = context.createRadialGradient(-60, -70, 20, 0, 0, 205);
  disc.addColorStop(0, "rgba(255,255,255,0.54)");
  disc.addColorStop(0.42, `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.78)`);
  disc.addColorStop(1, "rgba(20,20,60,0.78)");
  context.beginPath();
  context.arc(0, 0, 198, 0, Math.PI * 2);
  context.fillStyle = "rgba(0,0,0,0.22)";
  context.fill();
  context.beginPath();
  context.arc(0, 0, 176, 0, Math.PI * 2);
  context.fillStyle = disc;
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.58)";
  context.lineWidth = 6;
  context.stroke();

  drawManiaGlyph(context, -96, -96, 192, "rgba(255,255,255,0.96)");

  context.font = `900 44px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.50)";
  context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.58)`;
  context.shadowBlur = 16;
  context.fillText(layout.back.rarityLabel, 0, 436);
  context.restore();
}

function drawTierBackground(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  const gradient = context.createLinearGradient(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
  const stops = data.badgeGradientStops.length > 0
    ? data.badgeGradientStops
    : [{ color: "#7c3aed", offset: 0 }, { color: "#1e1b4b", offset: 1 }];
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT);
}

function drawTrianglePattern(context: CanvasRenderingContext2D, opacity: number) {
  context.save();
  context.globalAlpha = opacity;
  for (let y = -40; y < CARD_TEXTURE_HEIGHT + 80; y += 78) {
    for (let x = -40; x < CARD_TEXTURE_WIDTH + 90; x += 90) {
      context.beginPath();
      context.moveTo(x + 45, y + 8);
      context.lineTo(x + 82, y + 70);
      context.lineTo(x + 8, y + 70);
      context.closePath();
      context.fillStyle = "rgba(255,255,255,0.08)";
      context.fill();
    }
  }
  context.restore();
}

function drawModeBadge(context: CanvasRenderingContext2D, data: ManiaCardReadyData) {
  const gradient = context.createLinearGradient(44, 44, 170, 170);
  for (const stop of data.badgeGradientStops) gradient.addColorStop(stop.offset, stop.color);
  context.save();
  roundedRect(context, 38, 38, 132, 132, 30);
  context.fillStyle = data.badgeGradientStops.length ? gradient : "rgba(255,255,255,0.22)";
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.35)";
  context.lineWidth = 4;
  context.stroke();
  drawManiaGlyph(context, 64, 64, 80, "white");
  context.restore();
}

function drawUsername(context: CanvasRenderingContext2D, layout: FaceLayout) {
  const username = layout.front.username;
  const centerX = username.x + username.maxWidth / 2;

  context.save();
  roundedRect(context, 244, 76, 640, 104, 24);
  context.fillStyle = "rgba(0,0,0,0.34)";
  context.fill();
  context.font = `900 ${username.fontSize}px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "white";
  context.fillText(username.text, centerX, username.y);
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
  context.fillStyle = "rgba(255,255,255,0.95)";
  context.shadowColor = `rgba(${data.glowColor.r}, ${data.glowColor.g}, ${data.glowColor.b}, 0.58)`;
  context.shadowBlur = 18;
  context.shadowOffsetY = 4;
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
  roundedRect(context, 225, 960, 550, 218, 30);
  context.fillStyle = "rgba(0,0,0,0.30)";
  context.fill();
  context.font = `800 34px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.84)";
  for (const stat of layout.front.stats) {
    context.textAlign = "left";
    context.fillText(`${stat.label}:`, stat.x, stat.y);
    context.textAlign = "right";
    context.font = `900 48px ${FONT}`;
    context.fillStyle = "white";
    context.fillText(String(stat.value), 720, stat.y);
    context.font = `800 34px ${FONT}`;
    context.fillStyle = "rgba(255,255,255,0.84)";
  }
  context.restore();
}

function drawStars(context: CanvasRenderingContext2D, layout: FaceLayout) {
  const starSpacing = 48;
  const startX = 500 - ((layout.front.stars.length - 1) * starSpacing) / 2;

  context.save();
  context.textAlign = "center";
  context.font = `900 42px ${FONT}`;
  for (const [index, star] of layout.front.stars.entries()) {
    const x = startX + index * starSpacing;
    context.fillStyle = star === "full"
      ? "#fcd34d"
      : star === "half"
        ? "rgba(252,211,77,0.58)"
        : "rgba(252,211,77,0.30)";
    context.fillText(star === "empty" ? "☆" : "★", x, 1252);
  }
  context.font = `800 24px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.62)";
  context.fillText(layout.front.starAverage, 500, 1292);
  context.restore();
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

function trapezoid(
  context: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.lineTo(x3, y3);
  context.lineTo(x4, y4);
  context.closePath();
}

function drawManiaGlyph(
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
