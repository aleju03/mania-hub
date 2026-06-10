import { drawManiaGlyph } from "../player/maniacard3d/cardTexture";

export const PACK_ART_WIDTH = 600;
export const PACK_ART_HEIGHT = 840;
export const PACK_ASPECT = PACK_ART_WIDTH / PACK_ART_HEIGHT;

// Crimp band heights and the tear line, as fractions of the pack height.
// PackStage reads these so the DOM tear interaction lines up with the art.
export const PACK_CRIMP_FRACTION = 0.072;
export const PACK_TEAR_FRACTION = 0.16;

const FONT = "Torus, Arial, sans-serif";

function random01(value: number) {
  const x = Math.sin(value) * 43758.5453123;
  return x - Math.floor(x);
}

/* Foil booster pack front. Drawn once per mount; PackStage shows it through
   background-image slices so the top strip can tear away as its own element. */
export function createPackFrontCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = PACK_ART_WIDTH;
  canvas.height = PACK_ART_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");

  const width = PACK_ART_WIDTH;
  const height = PACK_ART_HEIGHT;

  // Foil base
  const base = context.createLinearGradient(0, 0, width * 0.4, height);
  base.addColorStop(0, "#1b1530");
  base.addColorStop(0.42, "#120e22");
  base.addColorStop(0.78, "#0d0a1a");
  base.addColorStop(1, "#070511");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  drawLargeTriangles(context, width, height);
  drawSheen(context, width, height);
  drawEmblem(context, width, height);
  drawWordmark(context, width, height);
  drawCrimp(context, width, height, 0);
  drawCrimp(context, width, height, height - PACK_CRIMP_FRACTION * height);
  drawTearPerforation(context, width, height);
  drawSideWelds(context, width, height);

  return canvas;
}

// A few large interlocking triangles anchored to a loose grid, in quiet foil
// tones - the osu! motif at pack scale.
function drawLargeTriangles(context: CanvasRenderingContext2D, width: number, height: number) {
  const triangles: Array<{ points: Array<[number, number]>; fill: string }> = [
    { points: [[-40, height], [220, height * 0.46], [430, height]], fill: "rgba(167, 139, 250, 0.10)" },
    { points: [[150, height], [400, height * 0.56], [650, height]], fill: "rgba(244, 114, 182, 0.08)" },
    { points: [[290, height * 0.86], [430, height * 0.6], [570, height * 0.86]], fill: "rgba(255, 255, 255, 0.05)" },
    { points: [[width + 40, height * 0.2], [width * 0.62, height * 0.46], [width + 40, height * 0.62]], fill: "rgba(125, 211, 252, 0.07)" },
    { points: [[-30, height * 0.22], [150, height * 0.42], [-30, height * 0.56]], fill: "rgba(255, 255, 255, 0.04)" },
  ];
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

function drawSheen(context: CanvasRenderingContext2D, width: number, height: number) {
  const sheen = context.createLinearGradient(0, 0, width, height * 0.7);
  sheen.addColorStop(0, "rgba(255,255,255,0.10)");
  sheen.addColorStop(0.22, "rgba(255,255,255,0.02)");
  sheen.addColorStop(0.48, "rgba(255,255,255,0.09)");
  sheen.addColorStop(0.62, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.18)");
  context.fillStyle = sheen;
  context.fillRect(0, 0, width, height);
}

function drawEmblem(context: CanvasRenderingContext2D, width: number, height: number) {
  const cx = width / 2;
  const cy = height * 0.4;

  context.save();
  const halo = context.createRadialGradient(cx, cy, 0, cx, cy, 240);
  halo.addColorStop(0, "rgba(167, 139, 250, 0.34)");
  halo.addColorStop(0.55, "rgba(167, 139, 250, 0.10)");
  halo.addColorStop(1, "rgba(167, 139, 250, 0)");
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
  disc.addColorStop(0, "rgba(196, 181, 253, 0.85)");
  disc.addColorStop(0.5, "rgba(124, 58, 237, 0.85)");
  disc.addColorStop(1, "rgba(30, 17, 70, 0.9)");
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

function drawWordmark(context: CanvasRenderingContext2D, width: number, height: number) {
  const cx = width / 2;
  context.save();
  context.textAlign = "center";

  context.font = `italic 900 64px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.95)";
  context.shadowColor = "rgba(167, 139, 250, 0.55)";
  context.shadowBlur = 22;
  context.fillText("MANIACARDS", cx, height * 0.64);

  context.shadowBlur = 0;
  context.font = `700 26px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.55)";
  context.fillText("B O O S T E R   P A C K", cx, height * 0.695);

  // "5 cards" pill
  const pillWidth = 190;
  const pillHeight = 46;
  const pillY = height * 0.80;
  context.beginPath();
  context.roundRect(cx - pillWidth / 2, pillY, pillWidth, pillHeight, 23);
  context.fillStyle = "rgba(255,255,255,0.08)";
  context.fill();
  context.strokeStyle = "rgba(255,255,255,0.3)";
  context.lineWidth = 2;
  context.stroke();
  context.font = `800 26px ${FONT}`;
  context.fillStyle = "rgba(255,255,255,0.85)";
  context.fillText("5 CARDS", cx, pillY + 32);
  context.restore();
}

function drawCrimp(context: CanvasRenderingContext2D, width: number, height: number, top: number) {
  const crimpHeight = PACK_CRIMP_FRACTION * height;
  context.save();
  const band = context.createLinearGradient(0, top, 0, top + crimpHeight);
  band.addColorStop(0, "rgba(255,255,255,0.16)");
  band.addColorStop(0.5, "rgba(255,255,255,0.05)");
  band.addColorStop(1, "rgba(0,0,0,0.3)");
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
  for (const corner of corners) {
    context.beginPath();
    corner.points.forEach(([x, y], index) => {
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = corner.fill;
    context.fill();
  }

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
