import { chainIsEndless, formatChainScore, type ChainSceneId } from "#/lib/chain-run";
import { sceneArtUrl } from "../sceneArt";
import { SCENE_ART_ID } from "./ChainHud";
import { KIT } from "./chainKit";

/* The run's end as a picture to share: a 1080x1350 card (the 4:5 a phone's
   feed shows whole) with the run's name, how far it got, its best row and
   rows played, the scene cards it held and who played it. Drawn on a canvas
   in the table's marker font, so it needs no server. */

export interface ChainShareRun {
  won: boolean;
  round: number;
  bestRow: number;
  rows: number;
  scenes: ChainSceneId[];
  username: string;
  labels: { title: string; round: string; bestRow: string; rows: string; footer: string };
}

const W = 1080;
const H = 1350;
const FONT = '"Name Permanent Marker"';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/* Text that shrinks to fit `max` px wide. */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, max: number, color: string, stroke = 0) {
  let px = size;
  ctx.font = `${px}px ${FONT}`;
  while (px > 18 && ctx.measureText(text).width > max) {
    px -= 4;
    ctx.font = `${px}px ${FONT}`;
  }
  if (stroke) {
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke;
    ctx.strokeStyle = KIT.dark;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export async function renderChainShareImage(run: ChainShareRun): Promise<Blob | null> {
  await document.fonts?.load(`64px ${FONT}`).catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // The table: deep plum with a warm glow behind the numbers.
  ctx.fillStyle = "#1a0f22";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 520, 40, W / 2, 520, 720);
  glow.addColorStop(0, run.won ? "rgba(255,211,107,0.32)" : "rgba(255,122,184,0.30)");
  glow.addColorStop(1, "rgba(26,15,34,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  // A frame of linked rings round the edge, the game's own mark.
  ctx.strokeStyle = "rgba(243,233,216,0.14)";
  ctx.lineWidth = 6;
  for (let x = 70; x < W - 40; x += 64) {
    for (const y of [46, H - 46]) {
      ctx.beginPath();
      ctx.ellipse(x, y, 26, 16, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  fitText(ctx, "OVERJOY", W / 2, 170, 64, W - 200, "rgba(243,233,216,0.55)");
  fitText(ctx, run.labels.title, W / 2, 290, 120, W - 140, KIT.cream, 14);
  fitText(ctx, run.labels.round, W / 2, 500, 190, W - 120, run.won || chainIsEndless(run.round) ? KIT.gold : KIT.pink, 20);

  // Best row and rows, side by side.
  const stat = (label: string, value: string, x: number, color: string) => {
    ctx.font = "900 34px system-ui, sans-serif";
    ctx.fillStyle = "rgba(243,233,216,0.55)";
    ctx.fillText(label.toUpperCase(), x, 640);
    fitText(ctx, value, x, 740, 92, 440, color, 12);
  };
  stat(run.labels.bestRow, formatChainScore(run.bestRow), W * 0.32, KIT.gold);
  stat(run.labels.rows, formatChainScore(run.rows), W * 0.74, KIT.cream);

  // The scene cards held, in the gold medallion.
  const scenes = run.scenes.slice(0, 3);
  if (scenes.length) {
    const medallion = await loadImage("/images/packs/run/medallion-v1.webp");
    const size = 230;
    const gap = 50;
    const left = W / 2 - (scenes.length * size + (scenes.length - 1) * gap) / 2;
    for (let index = 0; index < scenes.length; index += 1) {
      const x = left + index * (size + gap);
      const y = 830;
      const art = await loadImage(sceneArtUrl(SCENE_ART_ID[scenes[index]]));
      if (art) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2 + 8, size * 0.33, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(art, x + size * 0.15, y + size * 0.15 + 8, size * 0.7, size * 0.7);
        ctx.restore();
      }
      if (medallion) ctx.drawImage(medallion, x, y, size, size);
    }
  }

  fitText(ctx, run.username, W / 2, 1180, 64, W - 200, KIT.cream, 10);
  ctx.font = "800 32px system-ui, sans-serif";
  ctx.fillStyle = "rgba(243,233,216,0.5)";
  ctx.fillText(run.labels.footer, W / 2, 1250);

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

/* Shares the card through the phone's share sheet, or saves it and copies
   the caption where files can't be shared. "shared", "saved" or null when
   it could not be made or the sheet was closed. */
export async function shareChainRun(run: ChainShareRun, caption: string): Promise<"shared" | "saved" | null> {
  const blob = await renderChainShareImage(run);
  if (!blob) return null;
  const file = new File([blob], `overjoy-round-${run.round}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: caption });
      return "shared";
    } catch {
      return null;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  await navigator.clipboard?.writeText(caption).catch(() => undefined);
  return "saved";
}
