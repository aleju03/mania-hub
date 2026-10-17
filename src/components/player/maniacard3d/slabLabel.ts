/* The printed insert of a graded slab (cardSleeve.ts puts it in the well
   above the card), set the way grading labels are: a white label in a band
   of the tier's colour, the set, the player and the tier down the left over
   a barcode, the rank, GEM MT, the grade and the cert number down the right,
   and a holo seal between them. Its back carries a QR code and the cert
   number. Every slab here is a gem mint 10: it is a display case, not an
   appraisal. Card print, so it stays in English like the card itself. */

export interface SlabLabelInfo {
  userId: number;
  username: string;
  tier: string;
  rank: number | null;
  accent: { r: number; g: number; b: number };
  year: number;
}

/* Set in a plain grotesque, the way grading labels are. */
const FONT = `"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif`;

function mix(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number) {
  return { r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) };
}
const css = (c: { r: number; g: number; b: number }, alpha = 1) => `rgba(${c.r},${c.g},${c.b},${alpha})`;

/* A cert number that is the same for a player every time. */
export function slabCertNumber(userId: number): string {
  let x = (Math.imul(userId ^ 0x5bd1e995, 2654435761) >>> 0) % 100_000_000;
  if (x < 10_000_000) x += 10_000_000;
  const digits = String(x);
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

const withCommas = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxWidth: number, family = FONT): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && s > 10) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

export function drawSlabLabel(ctx: CanvasRenderingContext2D, w: number, h: number, info: SlabLabelInfo): void {
  const accent = info.accent;
  const ink = "#1c1c20";
  // the band, and the white label inside it
  ctx.fillStyle = css(accent);
  ctx.fillRect(0, 0, w, h);
  const bx = w * 0.021, by = h * 0.062;
  const paper = ctx.createLinearGradient(0, by, 0, h - by);
  paper.addColorStop(0, "#fdfdfd");
  paper.addColorStop(1, "#eef0f3");
  ctx.fillStyle = paper;
  ctx.fillRect(bx, by, w - bx * 2, h - by * 2);
  let seed = info.userId * 9301 + 49297;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.015 + rand() * 0.02})`;
    ctx.fillRect(bx + rand() * (w - bx * 2), by + rand() * (h - by * 2), 1.2, 1.2);
  }

  const size = h * 0.152;
  const left = w * 0.066;
  const right = w * 0.938;
  const rows = [0.36, 0.53, 0.7];
  ctx.fillStyle = ink;
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${size * 0.04}px`;
  const maxLeft = w * 0.66;
  const line = (text: string, y: number) => {
    fit(ctx, text, 500, size, maxLeft);
    ctx.fillText(text, left, h * y);
  };
  line(`${info.year} MANIACARDS`, rows[0]);
  line(info.username.toUpperCase(), rows[1]);
  line(`${info.tier.toUpperCase()} MANIACARD`, rows[2]);

  ctx.textAlign = "right";
  ctx.font = `500 ${size}px ${FONT}`;
  if (info.rank) ctx.fillText(`#${withCommas(info.rank)}`, right, h * rows[0]);
  ctx.fillText("GEM MT", right, h * rows[1]);
  ctx.fillText("10", right, h * rows[2]);
  ctx.fillText(slabCertNumber(info.userId).replace(" ", ""), right, h * 0.87);
  ctx.textAlign = "left";
  ctx.letterSpacing = "0px";

  // the barcode, from the cert number
  const cert = slabCertNumber(info.userId).replace(" ", "");
  let bar = left;
  const barEnd = w * 0.335;
  let bits = Number(cert) || 1;
  ctx.fillStyle = ink;
  while (bar < barEnd) {
    bits = (bits * 1103515245 + 12345) % 2147483648;
    const width = (1 + (bits % 3)) * w * 0.0021;
    const gap = (1 + ((bits >> 4) % 2)) * w * 0.0021;
    ctx.fillRect(bar, h * 0.745, Math.min(width, barEnd - bar), h * 0.135);
    bar += width + gap;
  }

  // the holo seal: a silver foil sticker, its rainbow sheen and a heart
  const sw = w * 0.135, sh = h * 0.2;
  const sx = w * 0.5 - sw / 2 + w * 0.02, sy = h * 0.705;
  const foil = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh);
  ["#d9dde3", "#f6c8e6", "#c9f0ff", "#f9f3c4", "#cfd5dd", "#e7d3ff", "#d9dde3"].forEach((c, i, all) => foil.addColorStop(i / (all.length - 1), c));
  ctx.fillStyle = foil;
  ctx.fillRect(sx, sy, sw, sh);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = Math.max(1, h * 0.004);
  for (let x = sx - sh; x < sx + sw; x += sh * 0.16) {
    ctx.beginPath();
    ctx.moveTo(Math.max(sx, x), Math.max(sy, sy + (sx - x)));
    ctx.lineTo(Math.min(sx + sw, x + sh), Math.min(sy + sh, sy + sh - (x + sh - Math.min(sx + sw, x + sh))));
    ctx.stroke();
  }
  const hx = sx + sw / 2, hy = sy + sh * 0.53, hr = sh * 0.3;
  ctx.fillStyle = css(mix(accent, { r: 20, g: 30, b: 80 }, 0.35));
  ctx.beginPath();
  ctx.moveTo(hx, hy + hr * 0.9);
  ctx.bezierCurveTo(hx - hr * 1.6, hy - hr * 0.1, hx - hr * 0.7, hy - hr * 1.3, hx, hy - hr * 0.45);
  ctx.bezierCurveTo(hx + hr * 0.7, hy - hr * 1.3, hx + hr * 1.6, hy - hr * 0.1, hx, hy + hr * 0.9);
  ctx.fill();
}

/* The label's back, seen through the back of the slab: the QR code that
   would verify it, and the cert number. Decorative: the code reads as one
   but is not one. */
export function drawSlabLabelBack(ctx: CanvasRenderingContext2D, w: number, h: number, info: SlabLabelInfo): void {
  ctx.fillStyle = css(info.accent);
  ctx.fillRect(0, 0, w, h);
  const bx = w * 0.021, by = h * 0.062;
  ctx.fillStyle = "#f7f7f5";
  ctx.fillRect(bx, by, w - bx * 2, h - by * 2);
  const ink = "#1c1c20";

  const n = 25;
  const q = (h * 0.72) / n;
  const qx = w * 0.9 - q * n, qy = (h - q * n) / 2;
  let bits = info.userId * 2654435761 + 7;
  const finder = (r: number, c: number) => {
    for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      const dr = r - fr, dc = c - fc;
      if (dr >= -1 && dr <= 7 && dc >= -1 && dc <= 7) {
        if (dr < 0 || dr > 6 || dc < 0 || dc > 6) return 0;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        return ring === 2 ? 0 : 1;
      }
    }
    return -1;
  };
  ctx.fillStyle = ink;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const f = finder(r, c);
      let on: boolean;
      if (f >= 0) on = f === 1;
      else if (r === 6 || c === 6) on = (r + c) % 2 === 0;
      else {
        bits = (bits * 1103515245 + 12345) % 2147483648;
        on = (bits >> 9) % 2 === 1;
      }
      if (on) ctx.fillRect(qx + c * q, qy + r * q, q + 0.5, q + 0.5);
    }
  }

  ctx.fillStyle = ink;
  ctx.textBaseline = "alphabetic";
  const size = h * 0.13;
  ctx.letterSpacing = `${size * 0.05}px`;
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.fillText("SCAN TO VERIFY", w * 0.07, h * 0.42);
  ctx.font = `500 ${size * 0.85}px ${FONT}`;
  ctx.fillStyle = "rgba(28,28,32,0.7)";
  ctx.fillText(`CERT ${slabCertNumber(info.userId).replace(" ", "")}`, w * 0.07, h * 0.62);
  ctx.letterSpacing = "0px";
}
