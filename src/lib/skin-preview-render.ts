import type { ReplaySkinKeymodeProfile, ReplaySkinSettings } from "./replay-skin";
import { getReplaySkinProfile } from "./replay-skin";

// Composes the browse-card preview for an uploaded skin: a fixed 1280x720
// playfield snippet rendered from the skin's own note/receptor/LN assets, with
// flat-colour fallbacks where the skin has none. Sprite sizing and anchoring
// mirror ReplayCanvas (noteHeightScale-based heights, no clamping, heads grow
// up from the anchor and LN tails grow down from theirs) so Percy-style skins
// with huge sprite images render the way they do in game. The note pattern is
// seeded by the key count only, so every skin renders the same "chart" and
// previews stay comparable side by side. The image doubles as the OG card.

export const SKIN_PREVIEW_WIDTH = 1280;
export const SKIN_PREVIEW_HEIGHT = 720;
const PREVIEW_BACKGROUND = "#16121d";
const STAGE_MAX_FRACTION = 0.42;
const LANE_MAX_PIXELS = 150;
const HIT_LINE_FRACTION = 0.86;
const SCROLL_TOP_FRACTION = 0.04;

export interface SkinPreviewLayout {
  stageX: number;
  stageWidth: number;
  laneXs: number[];
  laneWidths: number[];
  hitLineY: number;
  scale: number;
}

export interface SkinPreviewTapNote {
  column: number;
  y: number;
}

export interface SkinPreviewLongNote {
  column: number;
  headY: number;
  tailY: number;
}

export interface SkinPreviewPattern {
  taps: SkinPreviewTapNote[];
  longNotes: SkinPreviewLongNote[];
}

export interface SkinPreviewPatternOptions {
  canvasHeight?: number;
  hitLineY?: number;
  // Visual height of a tap note; spacing keys off it so big circle notes
  // never stack on top of each other in a column.
  noteHeight?: number;
}

export function computeSkinPreviewLayout(
  profile: Pick<ReplaySkinKeymodeProfile, "columnWidth" | "columnWidths" | "columnSpacing">,
  keyCount: number,
  canvasWidth = SKIN_PREVIEW_WIDTH,
  canvasHeight = SKIN_PREVIEW_HEIGHT,
): SkinPreviewLayout {
  const keys = Math.max(1, Math.floor(keyCount));
  const rawWidths = Array.from({ length: keys }, (_, col) => {
    const raw = profile.columnWidths[col] ?? profile.columnWidth;
    return Math.max(8, raw);
  });
  const spacing = Math.max(0, profile.columnSpacing);
  const rawStage = rawWidths.reduce((sum, width) => sum + width, 0) + spacing * (keys - 1);
  const maxStage = canvasWidth * STAGE_MAX_FRACTION;
  const widestLane = Math.max(...rawWidths);
  const scale = Math.min(maxStage / rawStage, LANE_MAX_PIXELS / widestLane);
  const laneWidths = rawWidths.map((width) => width * scale);
  const scaledSpacing = spacing * scale;
  const stageWidth = laneWidths.reduce((sum, width) => sum + width, 0) + scaledSpacing * (keys - 1);
  const stageX = (canvasWidth - stageWidth) / 2;
  const laneXs: number[] = [];
  let x = stageX;
  for (const width of laneWidths) {
    laneXs.push(x);
    x += width + scaledSpacing;
  }
  return { stageX, stageWidth, laneXs, laneWidths, hitLineY: canvasHeight * HIT_LINE_FRACTION, scale };
}

// Deterministic PRNG: identical output for a given key count on every run, so
// two uploads of the same skin produce byte-similar previews.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSkinPreviewPattern(keyCount: number, options: SkinPreviewPatternOptions = {}): SkinPreviewPattern {
  const keys = Math.max(1, Math.floor(keyCount));
  const canvasHeight = options.canvasHeight ?? SKIN_PREVIEW_HEIGHT;
  const hitLineY = options.hitLineY ?? canvasHeight * HIT_LINE_FRACTION;
  const noteHeight = Math.max(12, options.noteHeight ?? 40);
  const random = mulberry32(keys * 7919 + 42);
  const scrollTop = canvasHeight * SCROLL_TOP_FRACTION;
  const usable = hitLineY - scrollTop;
  // Tap anchors are note bottoms: keep the whole sprite inside the scroll area.
  const minY = scrollTop + noteHeight;
  const minGap = noteHeight * 1.2;

  // Long notes first so taps can avoid their columns near the body.
  const lnColumns = keys >= 2
    ? [Math.floor(random() * keys), (Math.floor(random() * (keys - 1)) + 1 + Math.floor(keys / 2)) % keys]
    : [0];
  const longNotes: SkinPreviewLongNote[] = lnColumns.slice(0, 2).map((column, index) => {
    const headY = hitLineY - usable * (0.1 + 0.34 * index + random() * 0.06);
    const length = Math.max(noteHeight * 2.2, usable * (0.16 + random() * 0.12));
    return { column, headY, tailY: Math.max(scrollTop, headY - length) };
  });

  const tapCount = Math.min(14, Math.max(6, keys * 2));
  const taps: SkinPreviewTapNote[] = [];
  const columnYs = new Map<number, number[]>();
  let attempts = 0;
  while (taps.length < tapCount && attempts < tapCount * 24) {
    attempts += 1;
    const column = Math.floor(random() * keys);
    const y = minY + (hitLineY - minY) * random();
    const placed = columnYs.get(column) ?? [];
    if (placed.some((other) => Math.abs(other - y) < minGap)) continue;
    if (longNotes.some((ln) => ln.column === column && y >= ln.tailY - minGap * 0.6 && y - noteHeight <= ln.headY + minGap * 0.6)) continue;
    placed.push(y);
    columnYs.set(column, placed);
    taps.push({ column, y });
  }
  taps.sort((a, b) => a.y - b.y);
  return { taps, longNotes };
}

export interface SkinPreviewRenderResult {
  blob: Blob;
  width: number;
  height: number;
  mime: string;
}

export async function renderSkinPreview(settings: ReplaySkinSettings, keyCount: number): Promise<SkinPreviewRenderResult> {
  const profile = getReplaySkinProfile(settings, keyCount);
  const layout = computeSkinPreviewLayout(profile, keyCount);
  const images = await decodeProfileImages(profile);
  const canvas = document.createElement("canvas");
  canvas.width = SKIN_PREVIEW_WIDTH;
  canvas.height = SKIN_PREVIEW_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available.");

  const upscroll = settings.upscroll;
  const mapY = (y: number) => (upscroll ? SKIN_PREVIEW_HEIGHT - y : y);
  const accent = firstTruthy(profile.tapColors) ?? profile.tapColor ?? "#ff66ab";
  const keys = Math.max(1, Math.floor(keyCount));
  // Mirrors ReplayCanvas.getNoteAssetHeight: sprite height comes from the
  // aspect ratio at the skin's WidthForNoteHeightScale, not the lane width.
  const noteScaleWidth = Math.max(1, profile.noteHeightScale * layout.scale);
  const noteAssetHeight = (image: HTMLImageElement) =>
    Math.max(1, (image.naturalHeight || 1) * (noteScaleWidth / (image.naturalWidth || 1)));
  const fallbackNoteHeight = (laneWidth: number) => Math.max(10, laneWidth * 0.3);

  // Receptors extend downward from the judgment line at full aspect height
  // (stable behaviour), so the line moves up until the tallest one fits.
  const receptorHeights = Array.from({ length: keys }, (_, col) => {
    const assets = profile.assets.columns[col] ?? {};
    const asset = assets.receptor ?? assets.receptorPressed;
    const image = asset ? images.get(asset.src) : undefined;
    return image ? fitHeight(image, layout.laneWidths[col]) : Math.max(6, SKIN_PREVIEW_HEIGHT * 0.012);
  });
  const maxReceptorHeight = Math.min(Math.max(...receptorHeights), SKIN_PREVIEW_HEIGHT * 0.3);
  const judgmentY = Math.min(layout.hitLineY, SKIN_PREVIEW_HEIGHT - maxReceptorHeight - 8);

  // Tap visual height drives pattern spacing so notes never stack.
  const tapHeights = Array.from({ length: keys }, (_, col) => {
    const asset = profile.assets.columns[col]?.tap;
    const image = asset ? images.get(asset.src) : undefined;
    return image ? noteAssetHeight(image) : fallbackNoteHeight(layout.laneWidths[col]);
  });
  const patternNoteHeight = Math.min(Math.max(...tapHeights), SKIN_PREVIEW_HEIGHT * 0.24);
  const pattern = buildSkinPreviewPattern(keys, {
    canvasHeight: SKIN_PREVIEW_HEIGHT,
    hitLineY: judgmentY,
    noteHeight: patternNoteHeight,
  });

  ctx.fillStyle = PREVIEW_BACKGROUND;
  ctx.fillRect(0, 0, SKIN_PREVIEW_WIDTH, SKIN_PREVIEW_HEIGHT);

  // Stage: flat dark field with hairline separators and accent edges.
  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  ctx.fillRect(layout.stageX, 0, layout.stageWidth, SKIN_PREVIEW_HEIGHT);
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
  for (let col = 1; col < keys; col += 1) {
    ctx.fillRect(layout.laneXs[col] - 0.5, 0, 1, SKIN_PREVIEW_HEIGHT);
  }
  ctx.fillStyle = accent;
  ctx.fillRect(layout.stageX - 2, 0, 2, SKIN_PREVIEW_HEIGHT);
  ctx.fillRect(layout.stageX + layout.stageWidth, 0, 2, SKIN_PREVIEW_HEIGHT);

  // Receptors sit on the judgment line; one column renders pressed for life.
  const pressedColumn = Math.min(1, keys - 1);
  const judgmentLineY = mapY(judgmentY);
  for (let col = 0; col < keys; col += 1) {
    const assets = profile.assets.columns[col] ?? {};
    const asset = col === pressedColumn ? assets.receptorPressed ?? assets.receptor : assets.receptor;
    const image = asset ? images.get(asset.src) : undefined;
    const laneX = layout.laneXs[col];
    const laneWidth = layout.laneWidths[col];
    if (image) {
      const height = fitHeight(image, laneWidth);
      const top = upscroll ? judgmentLineY - height : judgmentLineY;
      ctx.drawImage(image, laneX, top, laneWidth, height);
    } else {
      const height = Math.max(6, SKIN_PREVIEW_HEIGHT * 0.012);
      const top = upscroll ? judgmentLineY - height - 2 : judgmentLineY + 2;
      ctx.fillStyle = col === pressedColumn ? accent : "rgba(255, 255, 255, 0.25)";
      fillRoundedRect(ctx, laneX + 2, top, laneWidth - 4, height, 2);
    }
  }

  // Hit line across the stage under the notes.
  ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
  ctx.fillRect(layout.stageX, judgmentLineY - 1, layout.stageWidth, 2);

  for (const ln of pattern.longNotes) {
    drawLongNote(ctx, profile, images, layout, ln, settings, noteAssetHeight, mapY);
  }
  for (const tap of pattern.taps) {
    drawTapNote(ctx, profile, images, layout, tap, upscroll, noteAssetHeight, mapY);
  }

  drawJudgementAndCombo(ctx, profile, images, layout);

  const blob = await canvasToBlob(canvas);
  return { blob, width: SKIN_PREVIEW_WIDTH, height: SKIN_PREVIEW_HEIGHT, mime: blob.type || "image/png" };
}

function drawTapNote(
  ctx: CanvasRenderingContext2D,
  profile: ReplaySkinKeymodeProfile,
  images: Map<string, HTMLImageElement>,
  layout: SkinPreviewLayout,
  tap: SkinPreviewTapNote,
  upscroll: boolean,
  noteAssetHeight: (image: HTMLImageElement) => number,
  mapY: (y: number) => number,
): void {
  const assets = profile.assets.columns[tap.column] ?? {};
  const image = assets.tap ? images.get(assets.tap.src) : undefined;
  const laneX = layout.laneXs[tap.column];
  const laneWidth = layout.laneWidths[tap.column];
  const anchorY = mapY(tap.y);
  if (image) {
    // Anchored like the game: the sprite grows away from the judgment line.
    const height = noteAssetHeight(image);
    const top = upscroll ? anchorY : anchorY - height;
    ctx.drawImage(image, laneX, top, laneWidth, height);
    return;
  }
  const height = Math.max(10, laneWidth * 0.3);
  const top = upscroll ? anchorY : anchorY - height;
  ctx.fillStyle = profile.tapColors[tap.column] || profile.tapColor || "#ff66ab";
  fillRoundedRect(ctx, laneX + 1, top, laneWidth - 2, height, 4);
}

function drawLongNote(
  ctx: CanvasRenderingContext2D,
  profile: ReplaySkinKeymodeProfile,
  images: Map<string, HTMLImageElement>,
  layout: SkinPreviewLayout,
  ln: SkinPreviewLongNote,
  settings: ReplaySkinSettings,
  noteAssetHeight: (image: HTMLImageElement) => number,
  mapY: (y: number) => number,
): void {
  const upscroll = settings.upscroll;
  const assets = profile.assets.columns[ln.column] ?? {};
  const laneX = layout.laneXs[ln.column];
  const laneWidth = layout.laneWidths[ln.column];
  const headImage = (assets.lnHead && images.get(assets.lnHead.src)) ?? (assets.tap && images.get(assets.tap.src)) ?? undefined;
  const bodyImage = assets.lnBody ? images.get(assets.lnBody.src) : undefined;
  const tailImage = assets.lnTail ? images.get(assets.lnTail.src) : undefined;
  const headEndY = mapY(ln.headY);
  const tailEndY = mapY(ln.tailY);

  // Percy trim, as in ReplayCanvas: pull the body end back so oversized
  // LN sprites read at their intended length.
  const trim = settings.percy ? Math.min(20, laneWidth * 0.35) : 0;
  const tailDelta = upscroll ? -trim : trim;
  const bodyTop = Math.min(headEndY, tailEndY + tailDelta);
  const bodyBottom = Math.max(headEndY, tailEndY + tailDelta);

  if (bodyImage && bodyBottom > bodyTop) {
    ctx.drawImage(bodyImage, laneX, bodyTop, laneWidth, bodyBottom - bodyTop);
  } else if (bodyBottom > bodyTop) {
    ctx.fillStyle = settings.lnBodyColor || "#8b8b93";
    ctx.globalAlpha = 0.9;
    ctx.fillRect(laneX + laneWidth * 0.16, bodyTop, laneWidth * 0.68, bodyBottom - bodyTop);
    ctx.globalAlpha = 1;
  }

  // The tail sprite grows toward the head from its anchor (down on
  // downscroll), full aspect height: this is what keeps Percy caps round.
  if (tailImage) {
    const tailHeight = noteAssetHeight(tailImage);
    const tailTop = upscroll ? tailEndY - tailHeight : tailEndY;
    ctx.drawImage(tailImage, laneX, tailTop, laneWidth, tailHeight);
  }

  if (headImage) {
    const headHeight = noteAssetHeight(headImage);
    const headTop = upscroll ? headEndY : headEndY - headHeight;
    ctx.drawImage(headImage, laneX, headTop, laneWidth, headHeight);
  } else {
    const height = Math.max(10, laneWidth * 0.3);
    const top = upscroll ? headEndY : headEndY - height;
    ctx.fillStyle = profile.lnHeadColors[ln.column] || profile.lnHeadColor || "#ffffff";
    fillRoundedRect(ctx, laneX + 1, top, laneWidth - 2, height, 4);
  }
}

function drawJudgementAndCombo(
  ctx: CanvasRenderingContext2D,
  profile: ReplaySkinKeymodeProfile,
  images: Map<string, HTMLImageElement>,
  layout: SkinPreviewLayout,
): void {
  const centerX = layout.stageX + layout.stageWidth / 2;
  const averageLane = layout.stageWidth / Math.max(1, layout.laneWidths.length);
  const judgementAsset = profile.assets.judgements.hit300g ?? profile.assets.judgements.hit300;
  const judgementImage = judgementAsset ? images.get(judgementAsset.src) : undefined;
  if (judgementImage) {
    const width = Math.min(layout.stageWidth * 0.55, judgementImage.naturalWidth);
    const height = judgementImage.naturalHeight * (width / judgementImage.naturalWidth);
    ctx.drawImage(judgementImage, centerX - width / 2, SKIN_PREVIEW_HEIGHT * 0.52 - height / 2, width, height);
  }

  const combo = profile.assets.combo;
  if (!combo) return;
  const digitImages = "727".split("").map((digit) => {
    const asset = combo.digits[Number(digit)];
    return asset ? images.get(asset.src) : undefined;
  });
  if (digitImages.some((image) => !image)) return;
  const digitHeight = Math.min(64, Math.max(28, averageLane * 0.45));
  const overlap = combo.overlap * (digitHeight / 80);
  const widths = digitImages.map((image) => image!.naturalWidth * (digitHeight / image!.naturalHeight));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) - overlap * (widths.length - 1);
  let x = centerX - totalWidth / 2;
  const y = SKIN_PREVIEW_HEIGHT * 0.34;
  digitImages.forEach((image, index) => {
    ctx.drawImage(image!, x, y, widths[index], digitHeight);
    x += widths[index] - overlap;
  });
}

async function decodeProfileImages(profile: ReplaySkinKeymodeProfile): Promise<Map<string, HTMLImageElement>> {
  const sources = new Set<string>();
  for (const column of profile.assets.columns) {
    for (const asset of Object.values(column)) {
      if (asset?.src) sources.add(asset.src);
    }
  }
  for (const asset of Object.values(profile.assets.judgements)) {
    if (asset?.src) sources.add(asset.src);
  }
  if (profile.assets.combo) {
    for (const asset of profile.assets.combo.digits) {
      if (asset?.src) sources.add(asset.src);
    }
  }
  const entries = await Promise.all(
    [...sources].map(async (src): Promise<[string, HTMLImageElement] | null> => {
      const image = await decodeImage(src).catch(() => null);
      return image ? [src, image] : null;
    }),
  );
  return new Map(entries.filter((entry): entry is [string, HTMLImageElement] => entry !== null));
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image."));
    image.src = src;
  });
}

function fitHeight(image: HTMLImageElement, targetWidth: number): number {
  const width = image.naturalWidth || 1;
  const height = image.naturalHeight || 1;
  return height * (targetWidth / width);
}

function fillRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fill();
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((webp) => {
      if (webp && webp.type === "image/webp") {
        resolve(webp);
        return;
      }
      // Safari has no WebP encoder; fall back to PNG.
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error("Canvas export failed."));
      }, "image/png");
    }, "image/webp", 0.9);
  });
}

function firstTruthy(values: string[]): string | null {
  return values.find((value) => value) ?? null;
}
