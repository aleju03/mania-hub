import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH } from "./layout";
import { buildFaceLayout } from "./textureLayout";
import type { FaceLayout } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

const FONT = "Torus, Arial, sans-serif";

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
  drawTierBackground(context, data);
  drawTrianglePattern(context, 0.28);
  drawModeBadge(context, data);
  drawUsername(context, layout);
  drawAvatar(context, layout, avatar);
  drawStats(context, layout);
  drawStars(context, layout);
}

function drawBack(context: CanvasRenderingContext2D, data: ManiaCardReadyData, layout: FaceLayout) {
  drawTierBackground(context, data);
  drawTrianglePattern(context, 0.16);
  context.save();
  context.strokeStyle = "rgba(255,255,255,0.55)";
  context.lineWidth = 8;
  roundedRect(context, 86, 80, 828, 1240, 42);
  context.stroke();
  context.beginPath();
  context.arc(layout.back.logoCenter.x, layout.back.logoCenter.y, 176, 0, Math.PI * 2);
  context.fillStyle = "rgba(255,255,255,0.22)";
  context.fill();
  context.lineWidth = 28;
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.stroke();
  context.font = `900 54px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.48)";
  context.fillText(layout.back.rarityLabel, 500, 1255);
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
  context.font = `900 48px ${FONT}`;
  context.textAlign = "center";
  context.fillStyle = "white";
  context.fillText("M", 104, 122);
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
