/* The six mania judgements side by side in one canvas, for the Judgement rain
   profile theme: MAX, 300, 200, 100, 50, MISS, each fitted into an equal
   cell keeping its proportions. A player's own (their replay skin's, or the
   built-in set they picked) fill what they have; the site's default set
   fills the rest. */

export const JUDGEMENT_ATLAS_KEYS = ["hit300g", "hit300", "hit200", "hit100", "hit50", "hit0"] as const;
export type JudgementAtlasKey = (typeof JUDGEMENT_ATLAS_KEYS)[number];

const CELL_WIDTH = 256;
const CELL_HEIGHT = 112;
const DEFAULT_SET = "18";

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image.naturalWidth ? image : null);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export async function buildJudgementAtlas(own: Partial<Record<JudgementAtlasKey, { src: string } | undefined>> = {}): Promise<HTMLCanvasElement | null> {
  const images = await Promise.all(JUDGEMENT_ATLAS_KEYS.map(async (key) => {
    const mine = own[key]?.src ? await loadImage(own[key]!.src) : null;
    return mine ?? loadImage(`/images/replay-judgements/set-${DEFAULT_SET}/${key}.webp`);
  }));
  if (images.every((image) => !image)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = CELL_WIDTH * JUDGEMENT_ATLAS_KEYS.length;
  canvas.height = CELL_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return null;
  images.forEach((image, cell) => {
    if (!image) return;
    const scale = Math.min((CELL_WIDTH - 8) / image.naturalWidth, (CELL_HEIGHT - 8) / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, cell * CELL_WIDTH + (CELL_WIDTH - width) / 2, (CELL_HEIGHT - height) / 2, width, height);
  });
  return canvas;
}
