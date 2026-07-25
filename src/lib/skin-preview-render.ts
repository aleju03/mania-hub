import type { ReplaySkinKeymodeProfile, ReplaySkinSettings } from "./replay-skin";
import {
  getReplaySkinProfile,
  OSU_MANIA_DEFAULT_COLUMN_LINE_WIDTH,
  OSU_MANIA_DEFAULT_COLUMN_START,
  OSU_MANIA_DEFAULT_LIGHT_POSITION,
} from "./replay-skin";

// Composes the browse-card preview for an uploaded skin: a fixed 1280x720
// playfield snippet rendered from the skin's own note/receptor/LN assets, with
// flat-colour fallbacks where the skin has none. Sprite sizing and anchoring
// follow osu!stable, not naive image-fitting: the stage sits at ColumnStart
// like in game (not centred), note heights come from noteHeightScale, LN
// bodies cascade at natural aspect from the tail end (stable's default
// NoteBodyStyle, which is what makes Percy-style 40000px body images show
// their baked-in rounded cap instead of squashing it flat), the body lies
// half-way under the head and tail caps, and key images stretch from the hit
// line to the bottom edge. The note pattern is seeded by the key count only,
// so every skin renders the same "chart" and previews stay comparable side by
// side. The image doubles as the OG card.

export const SKIN_PREVIEW_WIDTH = 1280;
export const SKIN_PREVIEW_HEIGHT = 720;
const PREVIEW_BACKGROUND = "#16121d";
// The playfield a mania skin is authored against: opaque, not a dim over the
// map art. skin.ini Colour{n} overrides it per column when the skin sets one.
const PLAYFIELD_BACKGROUND = "#040308";
// Safety cap only: the true stage width comes from the game's 480-unit
// vertical space (a 65-wide column is 65/480 of the screen height), which on
// a 16:9 canvas reproduces the in-game proportions exactly. Ultra-wide skins
// (10K at max column width) still get clamped so the stage fits the card.
const STAGE_MAX_FRACTION = 0.94;
// The game's HitPosition for mania skins sits around 440-450 of 480 (~92-94%);
// 0.9 keeps that proportion while leaving the key area readable on a card.
const HIT_LINE_FRACTION = 0.9;
// How far up the card a skin's own HitPosition may push the judgement line.
// Skins with a tall key deck (RESIDENT sits at 320 of 480, two thirds down)
// were being dragged back to 0.75 and lost the deck art below the receptors.
const HIT_LINE_MIN_FRACTION = 0.62;
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
  profile: Pick<ReplaySkinKeymodeProfile, "columnWidth" | "columnWidths" | "columnSpacing" | "columnStart">,
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
  // In-game scale: skin units are 480ths of the screen height.
  const scale = Math.min(canvasHeight / 480, maxStage / rawStage);
  const laneWidths = rawWidths.map((width) => width * scale);
  const scaledSpacing = spacing * scale;
  const stageWidth = laneWidths.reduce((sum, width) => sum + width, 0) + scaledSpacing * (keys - 1);
  // Stable positions the stage's left edge ColumnStart osu!pixels from the
  // screen's left (the canvas is 16:9, so the unit space is 853.33 wide -
  // exactly canvasWidth at the uncapped scale). Skins centre themselves with
  // ColumnStart = 427 - width/2; BMS-style boards like RESIDENT sit at the
  // left on purpose, and stable's default 136 is left of centre too. Clamped
  // so the stage always stays on the card.
  const columnStart = profile.columnStart ?? OSU_MANIA_DEFAULT_COLUMN_START;
  const stageX = Math.max(0, Math.min(canvasWidth - stageWidth, columnStart * scale));
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
  // Long enough that Percy-style bodies (transparent lead-in at the tail)
  // still show a good stretch of body between cap and head.
  const longNotes: SkinPreviewLongNote[] = lnColumns.slice(0, 2).map((column, index) => {
    const headY = hitLineY - usable * (0.08 + 0.4 * index + random() * 0.06);
    const length = Math.max(noteHeight * 2.6, usable * (0.26 + random() * 0.12));
    // tailY is a position line and the tail sprite's box grows above it
    // (downscroll), so it needs the same sprite-height headroom as the taps.
    return { column, headY, tailY: Math.max(minY, headY - length) };
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
  // The sampled note-art accent actually used in the render; more faithful
  // than the skin.ini colours the backend parses out of the .osk.
  accent: string;
}

export interface SkinPreviewRenderOptions {
  // A decoded, same-origin (or otherwise canvas-safe) beatmap background;
  // drawn cover-fit and dimmed behind the stage. Without one the backdrop
  // falls back to flat accent-tinted triangles.
  background?: HTMLImageElement | null;
}

// Real ranked mania sets whose covers back the preview like in-game map art.
// All verified to have a fullsize cover on assets.ppy.sh, and all pre-shrunk
// into public/images/skin-preview-backdrops. The live pool the upload modal
// offers is drawn from the map catalog (see skin-preview-backdrops.ts); this
// baked list is its offline fallback.
export const SKIN_PREVIEW_BACKGROUND_SETS = [
  2556057, 2297326, 2127200, 476691, 712142, 2344640, 849169,
  2076003, 2045674, 1297881, 2485019, 1112479, 2519924, 2383217,
];

const PREBUILT_BACKGROUND_SETS = new Set(SKIN_PREVIEW_BACKGROUND_SETS);

// Small direct thumbnail for picker rows; plain <img> display needs no CORS.
export function skinPreviewBackgroundThumbUrl(setId: number): string {
  return `https://assets.ppy.sh/beatmaps/${setId}/covers/card.jpg`;
}

// Loads one set's cover for the canvas. The baked ids come from the pre-shrunk
// static copies in public/images/skin-preview-backdrops (~50-190 KB each,
// built by scripts/build-skin-preview-backdrops.mjs; rerun it when the list
// changes) - same-origin, so the canvas stays clean. Anything drawn from the
// live catalog has no static copy, so it proxies the original through
// /api/background instead (assets.ppy.sh sends no CORS headers, so a direct
// load would taint the canvas); that response is edge-cached for a year, so a
// cover only costs its download once. Resolves null when nothing loads; the
// renderer then uses its flat triangle backdrop.
export function loadSkinPreviewBackgroundForSet(setId: number): Promise<HTMLImageElement | null> {
  const proxied = () => decodeImage(`/api/background?beatmapsetId=${setId}&inline=1&cover=fullsize`);
  const source = PREBUILT_BACKGROUND_SETS.has(setId)
    ? decodeImage(`/images/skin-preview-backdrops/${setId}.webp`).catch(proxied)
    : proxied();
  return source.catch(() => null);
}

export async function renderSkinPreview(
  settings: ReplaySkinSettings,
  keyCount: number,
  options: SkinPreviewRenderOptions = {},
): Promise<SkinPreviewRenderResult> {
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
  // Accent from the note art itself: skin.ini colours are unreliable (many
  // skins leave them black while the actual sprites carry the identity).
  const accent = sampleAccentColor(profile, images)
    ?? cleanAccentCandidate(firstTruthy(profile.tapColors) ?? profile.tapColor)
    ?? "#ff66ab";
  const keys = Math.max(1, Math.floor(keyCount));
  // Mirrors ReplayCanvas.getNoteAssetHeight: sprite height comes from the
  // aspect ratio at the skin's WidthForNoteHeightScale, not the lane width.
  const noteScaleWidth = Math.max(1, profile.noteHeightScale * layout.scale);
  const noteAssetHeight = (image: HTMLImageElement) =>
    Math.max(1, (image.naturalHeight || 1) * (noteScaleWidth / (image.naturalWidth || 1)));
  const fallbackNoteHeight = (laneWidth: number) => Math.max(10, laneWidth * 0.3);

  // Judgment line straight from the skin's HitPosition. settings.hitPosition
  // is in the replay viewer's 768-space, measured from the bottom edge;
  // convert back to skin units (480-space) and scale with the stage zoom so
  // note/receptor/hit-gap proportions stay exactly as in game. Clamped so a
  // degenerate HitPosition still leaves a usable field.
  const hitGap = Math.max(0, Math.min(768, settings.hitPosition)) * (480 / 768) * layout.scale;
  const judgmentY = Math.max(
    SKIN_PREVIEW_HEIGHT * HIT_LINE_MIN_FRACTION,
    Math.min(SKIN_PREVIEW_HEIGHT * 0.95, SKIN_PREVIEW_HEIGHT - hitGap),
  );

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

  // Map background behind the field, dimmed like in game; the flat triangle
  // backdrop stands in when no cover was loaded.
  if (options.background) {
    drawCoverFit(ctx, options.background);
    ctx.fillStyle = "rgba(6, 4, 10, 0.72)";
    ctx.fillRect(0, 0, SKIN_PREVIEW_WIDTH, SKIN_PREVIEW_HEIGHT);
  } else {
    drawPreviewBackdrop(ctx, accent);
  }

  // Stage: opaque black, the playfield a mania skin is authored against. It
  // used to be 72% black, which let the map art wash through every column.
  // A skin that declares Colour{n} gets exactly that colour instead, alpha
  // included, so the ones that deliberately show the background still do.
  ctx.fillStyle = PLAYFIELD_BACKGROUND;
  ctx.fillRect(layout.stageX, 0, layout.stageWidth, SKIN_PREVIEW_HEIGHT);
  for (let col = 0; col < keys; col += 1) {
    const declared = profile.columnBackgrounds[col];
    if (!declared) continue;
    ctx.clearRect(layout.laneXs[col], 0, layout.laneWidths[col], SKIN_PREVIEW_HEIGHT);
    // Cleared first: a translucent Colour{n} is meant to show the map art
    // through, not to sit on top of the default black.
    if (options.background) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(layout.laneXs[col], 0, layout.laneWidths[col], SKIN_PREVIEW_HEIGHT);
      ctx.clip();
      drawCoverFit(ctx, options.background);
      ctx.fillStyle = "rgba(6, 4, 10, 0.72)";
      ctx.fillRect(layout.laneXs[col], 0, layout.laneWidths[col], SKIN_PREVIEW_HEIGHT);
      ctx.restore();
    }
    ctx.fillStyle = declared;
    ctx.fillRect(layout.laneXs[col], 0, layout.laneWidths[col], SKIN_PREVIEW_HEIGHT);
  }
  // Column lines exactly as skin.ini declares them (ColumnLineWidth +
  // ColourColumnLine), instead of invented separators or accent side borders.
  drawColumnLines(ctx, profile, layout);

  // Stage furniture, behind the notes: the column light under the pressed key
  // and the hint line at the hit position. Skins like RESIDENT are mostly this
  // art, and a playfield without it reads as bare columns.
  const stage = profile.assets.stage;
  const stageScale = (asset: { height?: number; scale?: number } | undefined, image: HTMLImageElement) => {
    const assetScale = asset?.scale && asset.scale > 0 ? asset.scale : 1;
    const nativeHeight = (asset?.height && asset.height > 0 ? asset.height : image.naturalHeight || 1) / assetScale;
    return Math.max(1, nativeHeight * (480 / 768) * layout.scale);
  };
  const pressedColumn = Math.min(1, keys - 1);
  const judgmentLineY = mapY(judgmentY);

  const lightAsset = stage.light;
  const lightImage = lightAsset ? images.get(lightAsset.src) : undefined;
  if (lightImage) {
    // Stable draws the column light up the lane while the key is held, its
    // bottom edge at skin.ini LightPosition - NOT at the hit position. The
    // default 413 sits 11 units below the default hit line, and O2Jam-style
    // decks rely on the light overlapping their key tops. Anchored relative
    // to the (possibly clamped) judgement line so the declared gap survives
    // the card's clamping; only the one pressed column shows it here.
    const height = stageScale(lightAsset, lightImage);
    const hitUnits = Math.max(0, Math.min(768, settings.hitPosition)) * (480 / 768);
    const lightUnits = 480 - (profile.lightPosition ?? OSU_MANIA_DEFAULT_LIGHT_POSITION);
    const lightShift = (hitUnits - lightUnits) * layout.scale;
    const tint = stage.lightColors[pressedColumn] || "";
    const art = tint ? tintedImage(lightImage, tint) : lightImage;
    const laneX = layout.laneXs[pressedColumn];
    const laneWidth = layout.laneWidths[pressedColumn];
    if (upscroll) drawImageFlippedY(ctx, art, laneX, judgmentLineY - lightShift, laneWidth, height);
    else ctx.drawImage(art, laneX, judgmentLineY + lightShift - height, laneWidth, height);
  }

  const hintAsset = stage.hint;
  const hintImage = hintAsset ? images.get(hintAsset.src) : undefined;
  if (hintImage) {
    // The hint marks the hit position across the whole stage.
    const height = stageScale(hintAsset, hintImage);
    if (upscroll) drawImageFlippedY(ctx, hintImage, layout.stageX, judgmentLineY, layout.stageWidth, height);
    else ctx.drawImage(hintImage, layout.stageX, judgmentLineY - height / 2, layout.stageWidth, height);
  }

  // Key images: width stretched to the lane, height at the texture's NATIVE
  // size in the game's 768-unit space (pixel height / @2x scale, then into
  // 480-space), bottom-anchored at the screen edge. This is the lazer legacy
  // key-area rule and it matches gameplay pixel-for-pixel: pl0x's 400px @2x
  // key renders 125 skin-units tall, putting its ring exactly note-sized with
  // its bottom on the hit line. One column renders pressed for life.
  for (let col = 0; col < keys; col += 1) {
    const assets = profile.assets.columns[col] ?? {};
    const asset = col === pressedColumn ? assets.receptorPressed ?? assets.receptor : assets.receptor;
    const image = asset ? images.get(asset.src) : undefined;
    const laneX = layout.laneXs[col];
    const laneWidth = layout.laneWidths[col];
    if (image) {
      const assetScale = asset?.scale && asset.scale > 0 ? asset.scale : 1;
      const nativeHeight = (asset?.height && asset.height > 0 ? asset.height : image.naturalHeight || 1) / assetScale;
      const height = Math.max(1, nativeHeight * (480 / 768) * layout.scale);
      if (upscroll) {
        // The game flips the stage for upscroll: key art hangs from the top.
        ctx.save();
        ctx.scale(1, -1);
        ctx.drawImage(image, laneX, -height, laneWidth, height);
        ctx.restore();
      } else {
        ctx.drawImage(image, laneX, SKIN_PREVIEW_HEIGHT - height, laneWidth, height);
      }
    } else {
      const height = Math.max(6, SKIN_PREVIEW_HEIGHT * 0.012);
      const top = upscroll ? judgmentLineY - height - 2 : judgmentLineY + 2;
      ctx.fillStyle = col === pressedColumn ? accent : "rgba(255, 255, 255, 0.25)";
      fillRoundedRect(ctx, laneX + 2, top, laneWidth - 4, height, 2);
    }
  }

  // The white line at HitPosition, only when skin.ini asks for it
  // (JudgementLine, default on); circle and arrow skins turn it off.
  if (profile.judgementLine) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.fillRect(layout.stageX, judgmentLineY - 1, layout.stageWidth, 2);
  }

  for (const ln of pattern.longNotes) {
    drawLongNote(ctx, profile, images, layout, ln, settings, noteAssetHeight, mapY);
  }
  for (const tap of pattern.taps) {
    drawTapNote(ctx, profile, images, layout, tap, upscroll, noteAssetHeight, mapY);
  }

  // Deck, frame and hit glow sit over the columns, as they do in game: the
  // key area art overlaps the bottom of the stage and the frame flanks it.
  const bottomAsset = stage.bottom;
  const bottomImage = bottomAsset ? images.get(bottomAsset.src) : undefined;
  if (bottomImage) {
    const height = stageScale(bottomAsset, bottomImage);
    if (upscroll) drawImageFlippedY(ctx, bottomImage, layout.stageX, 0, layout.stageWidth, height);
    else ctx.drawImage(bottomImage, layout.stageX, SKIN_PREVIEW_HEIGHT - height, layout.stageWidth, height);
  }

  for (const [asset, side] of [[stage.left, "left"], [stage.right, "right"]] as const) {
    const image = asset ? images.get(asset.src) : undefined;
    if (!image) continue;
    // The frame hangs outside the columns at its own width, stretched down the
    // full stage the way stable scales it to the playfield height.
    const assetScale = asset?.scale && asset.scale > 0 ? asset.scale : 1;
    const nativeWidth = (asset?.width && asset.width > 0 ? asset.width : image.naturalWidth || 1) / assetScale;
    const width = Math.max(1, nativeWidth * (480 / 768) * layout.scale);
    const x = side === "left" ? layout.stageX - width : layout.stageX + layout.stageWidth;
    ctx.drawImage(image, x, 0, width, SKIN_PREVIEW_HEIGHT);
  }

  const lightingAsset = stage.lighting;
  const lightingImage = lightingAsset ? images.get(lightingAsset.src) : undefined;
  if (lightingImage) {
    // Hit lighting is additive in game, and LightingNWidth overrides the art's
    // own width per column.
    const declaredWidth = stage.lightingWidths[pressedColumn];
    const assetScale = lightingAsset?.scale && lightingAsset.scale > 0 ? lightingAsset.scale : 1;
    const nativeWidth = (lightingAsset?.width && lightingAsset.width > 0 ? lightingAsset.width : lightingImage.naturalWidth || 1) / assetScale;
    const width = Math.max(1, (declaredWidth && declaredWidth > 0 ? declaredWidth : nativeWidth * (480 / 768)) * layout.scale);
    const height = Math.max(1, width * ((lightingImage.naturalHeight || 1) / (lightingImage.naturalWidth || 1)));
    const centerX = layout.laneXs[pressedColumn] + layout.laneWidths[pressedColumn] / 2;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(lightingImage, centerX - width / 2, judgmentLineY - height / 2, width, height);
    ctx.restore();
  }

  drawJudgementAndCombo(ctx, profile, images, layout);

  const blob = await canvasToBlob(canvas);
  return { blob, width: SKIN_PREVIEW_WIDTH, height: SKIN_PREVIEW_HEIGHT, mime: blob.type || "image/png", accent };
}

// skin.ini column lines: keys+1 boundaries, outer stage edges included. An
// empty columnLineWidths means the skin never set the key, which in stable
// renders the 2-unit default at every boundary; explicit zeros hide lines.
function drawColumnLines(
  ctx: CanvasRenderingContext2D,
  profile: Pick<ReplaySkinKeymodeProfile, "columnLineWidths" | "columnLineColor">,
  layout: SkinPreviewLayout,
): void {
  const keys = layout.laneWidths.length;
  const widths = profile.columnLineWidths;
  const lineWidth = (boundary: number) =>
    widths.length > 0 ? (widths[boundary] ?? 0) : OSU_MANIA_DEFAULT_COLUMN_LINE_WIDTH;
  ctx.fillStyle = profile.columnLineColor || "#ffffff";
  for (let boundary = 0; boundary <= keys; boundary += 1) {
    const units = lineWidth(boundary);
    if (units <= 0) continue;
    const width = Math.max(1, units * layout.scale);
    let x: number;
    if (boundary === 0) {
      x = layout.stageX;
    } else if (boundary === keys) {
      x = layout.stageX + layout.stageWidth - width;
    } else {
      // Centre the line in the gap between the two lanes (zero-width when
      // there is no column spacing).
      const gapCenter = (layout.laneXs[boundary - 1] + layout.laneWidths[boundary - 1] + layout.laneXs[boundary]) / 2;
      x = gapCenter - width / 2;
    }
    ctx.fillRect(x, 0, width, SKIN_PREVIEW_HEIGHT);
  }
}

// Average the opaque pixels of the first tap/LN-head sprite to get the
// skin's visual accent; returns null when the art is effectively greyscale
// black (then skin.ini colours get their chance).
function sampleAccentColor(
  profile: ReplaySkinKeymodeProfile,
  images: Map<string, HTMLImageElement>,
): string | null {
  for (const column of profile.assets.columns) {
    for (const asset of [column?.tap, column?.lnHead]) {
      const image = asset ? images.get(asset.src) : undefined;
      if (!image) continue;
      try {
        const sample = document.createElement("canvas");
        sample.width = 12;
        sample.height = 12;
        const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
        if (!sampleCtx) return null;
        sampleCtx.drawImage(image, 0, 0, 12, 12);
        const data = sampleCtx.getImageData(0, 0, 12, 12).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3] / 255;
          if (alpha < 0.4) continue;
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          weight += alpha;
        }
        if (weight < 4) continue;
        const color = toHexColor(r / weight, g / weight, b / weight);
        if (color) return color;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cleanAccentCandidate(color: string | null): string | null {
  if (!color) return null;
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return toHexColor((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

// Rejects near-black (no tint to give); keeps everything else as-is.
function toHexColor(r: number, g: number, b: number): string | null {
  if (Math.max(r, g, b) < 40) return null;
  const to = (channel: number) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function drawCoverFit(ctx: CanvasRenderingContext2D, image: HTMLImageElement): void {
  const sourceWidth = image.naturalWidth || 1;
  const sourceHeight = image.naturalHeight || 1;
  const scale = Math.max(SKIN_PREVIEW_WIDTH / sourceWidth, SKIN_PREVIEW_HEIGHT / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  ctx.drawImage(image, (SKIN_PREVIEW_WIDTH - width) / 2, (SKIN_PREVIEW_HEIGHT - height) / 2, width, height);
}

function drawPreviewBackdrop(ctx: CanvasRenderingContext2D, accent: string): void {
  // Accent-tinted base so the whole backdrop carries the skin's hue.
  ctx.fillStyle = PREVIEW_BACKGROUND;
  ctx.fillRect(0, 0, SKIN_PREVIEW_WIDTH, SKIN_PREVIEW_HEIGHT);
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, SKIN_PREVIEW_WIDTH, SKIN_PREVIEW_HEIGHT);

  const random = mulberry32(0x5eed);
  for (let i = 0; i < 12; i += 1) {
    // Large flat-shaded triangles spread across the width; overlaps read as
    // interlocking shapes once the alphas stack. A few lighter ones give the
    // tonal variety of dimmed artwork.
    const size = SKIN_PREVIEW_HEIGHT * (0.45 + random() * 0.6);
    const centerX = SKIN_PREVIEW_WIDTH * ((i + random() * 0.9) / 12);
    const centerY = SKIN_PREVIEW_HEIGHT * (0.05 + random() * 0.9);
    const up = random() > 0.4;
    const light = random() > 0.7;
    const half = size / 2;
    ctx.globalAlpha = light ? 0.05 + random() * 0.05 : 0.08 + random() * 0.1;
    ctx.fillStyle = light ? "#ffffff" : accent;
    ctx.beginPath();
    ctx.moveTo(centerX, up ? centerY - half : centerY + half);
    ctx.lineTo(centerX - half, up ? centerY + half : centerY - half);
    ctx.lineTo(centerX + half, up ? centerY + half : centerY - half);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Draws an image mirrored vertically inside its target rect; stable flips
// note sprites like this depending on scroll direction.
function drawImageFlippedY(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.translate(0, y * 2 + height);
  ctx.scale(1, -1);
  ctx.drawImage(image, x, y, width, height);
  ctx.restore();
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
    // Note textures flip on upscroll (stable's NoteFlipWhenUpsideDown, on by
    // default) so directional art keeps pointing the intended way.
    const height = noteAssetHeight(image);
    const top = upscroll ? anchorY : anchorY - height;
    if (upscroll) drawImageFlippedY(ctx, image, laneX, top, laneWidth, height);
    else ctx.drawImage(image, laneX, top, laneWidth, height);
    return;
  }
  const height = Math.max(10, laneWidth * 0.3);
  const top = upscroll ? anchorY : anchorY - height;
  ctx.fillStyle = profile.tapColors[tap.column] || profile.tapColor || "#ff66ab";
  fillRoundedRect(ctx, laneX + 1, top, laneWidth - 2, height, 4);
}

export interface SkinPreviewBodyTile {
  top: number;
  height: number;
  sourceRows: number;
}

// The cascade of body tiles between the two caps, snapped to whole pixels.
//
// A tile drawn into a fractional rect only half-covers the pixel row at each
// end, and two half-covered rows composited one after the other come to 75%
// opacity rather than 100% - which is the faint line that used to show at
// every seam of a tiled LN body. Rounding both edges (and carrying the
// unrounded position forward, so the next tile rounds to the same boundary)
// leaves the tiles flush with no partial coverage anywhere.
export function bodyTileRects(
  bodyTop: number,
  bodyBottom: number,
  sourceHeight: number,
  scale: number,
): SkinPreviewBodyTile[] {
  const tiles: SkinPreviewBodyTile[] = [];
  if (!(scale > 0) || !(sourceHeight > 0) || !(bodyBottom > bodyTop)) return tiles;
  let y = bodyTop;
  // The cap is a backstop against a pathological scale, not a real limit.
  while (y < bodyBottom - 0.01 && tiles.length < 4096) {
    const sourceRows = Math.min(sourceHeight, (bodyBottom - y) / scale);
    const top = Math.round(y);
    const bottom = Math.round(y + sourceRows * scale);
    tiles.push({ top, height: Math.max(1, bottom - top), sourceRows });
    y += sourceRows * scale;
  }
  return tiles;
}

// skin.ini ColourLight{n} tints the column light, which skins ship as white
// art. Multiply keeps the art's own shading; the cache means a preview tints
// each texture once rather than per keymode.
const tintedImageCache = new Map<string, HTMLCanvasElement>();

function tintedImage(image: HTMLImageElement, color: string): CanvasImageSource {
  const key = `${image.src}|${color}`;
  const cached = tintedImageCache.get(key);
  if (cached) return cached;
  const width = image.naturalWidth || 0;
  const height = image.naturalHeight || 0;
  if (width < 1 || height < 1) return image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return image;
  ctx.drawImage(image, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  // Multiply paints the transparent surround too; clip it back to the art.
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(image, 0, 0);
  tintedImageCache.set(key, canvas);
  return canvas;
}

export interface SkinPreviewLongNoteGeometry {
  bodyTop: number;
  bodyBottom: number;
  headBoxTop: number;
  tailBoxTop: number;
}

// Stable's hold-note layout, which lazer's DrawableHoldNote spells out: the
// body is positioned "to lie half-way under the head and the tail notes",
// and the tail is a note at the end position - its box grows away from the
// receptor like every other note, with the texture drawn flipped relative to
// the notes (lazer's LegacyHoldNoteTailPiece inverts the scroll direction for
// exactly this). Running the body to each cap's CENTRE, under the cap art,
// is what lets arrow-style caps cover the join with their own shape - and
// since the body never passes a cap's centre, nothing pokes out past art
// that fills only the far half of its box. Head/tail end Ys are the position
// lines (where each cap's receptor-side edge sits); trim is the Percy
// shortening, applied at the tail side.
export function longNoteGeometry(input: {
  upscroll: boolean;
  headEndY: number;
  tailEndY: number;
  headHeight: number;
  tailHeight: number;
  trim?: number;
}): SkinPreviewLongNoteGeometry {
  const { upscroll, headEndY, tailEndY, headHeight, tailHeight } = input;
  const trim = input.trim ?? 0;
  const headBoxTop = upscroll ? headEndY : headEndY - headHeight;
  const tailBoxTop = upscroll ? tailEndY : tailEndY - tailHeight;
  const headSideY = upscroll ? headEndY + headHeight / 2 : headEndY - headHeight / 2;
  const tailSideY = (upscroll ? tailEndY + tailHeight / 2 : tailEndY - tailHeight / 2)
    + (upscroll ? -trim : trim);
  return {
    bodyTop: Math.min(headSideY, tailSideY),
    bodyBottom: Math.max(headSideY, tailSideY),
    headBoxTop,
    tailBoxTop,
  };
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
  const headHeight = headImage ? noteAssetHeight(headImage) : Math.max(10, laneWidth * 0.3);
  const tailHeight = tailImage ? noteAssetHeight(tailImage) : 0;

  // Percy trim, as in ReplayCanvas: pull the body's tail end back so oversized
  // LN sprites read at their intended length.
  const trim = settings.percy ? Math.min(20, laneWidth * 0.35) : 0;

  const { bodyTop, bodyBottom, headBoxTop, tailBoxTop } = longNoteGeometry({
    upscroll,
    headEndY,
    tailEndY,
    headHeight,
    tailHeight,
    trim,
  });

  if (bodyImage && bodyBottom > bodyTop) {
    // Cascade, not stretch (stable's default NoteBodyStyle): the image runs at
    // natural aspect from the tail end toward the head, tiling if it is
    // shorter than the span. Percy bodies are one huge tile whose rounded cap
    // (and "appears shorter" transparent lead-in) lands at the tail. Draw via
    // source slices so the destination rect never exceeds the visible span:
    // Chromium quietly rasterises multi-thousand-pixel upscales through a
    // capped intermediate, which would squash the cap flat.
    const sourceWidth = bodyImage.naturalWidth || 1;
    const sourceHeight = bodyImage.naturalHeight || 1;
    ctx.save();
    if (upscroll) {
      // Tail end is at the bottom: flip the span so the cap edge lands there.
      ctx.translate(0, bodyTop + bodyBottom);
      ctx.scale(1, -1);
    }
    for (const tile of bodyTileRects(bodyTop, bodyBottom, sourceHeight, laneWidth / sourceWidth)) {
      ctx.drawImage(bodyImage, 0, 0, sourceWidth, tile.sourceRows, laneX, tile.top, laneWidth, tile.height);
    }
    ctx.restore();
  } else if (bodyBottom > bodyTop) {
    ctx.fillStyle = settings.lnBodyColor || "#8b8b93";
    ctx.globalAlpha = 0.9;
    ctx.fillRect(laneX + laneWidth * 0.16, bodyTop, laneWidth * 0.68, bodyBottom - bodyTop);
    ctx.globalAlpha = 1;
  }

  // The tail is a note at the end position: its box grows away from the
  // receptor like every other note's, and the texture is drawn flipped
  // relative to the notes - flipped on downscroll, upright on upscroll
  // (lazer's LegacyHoldNoteTailPiece inverts the scroll direction for
  // exactly this). Drawn over the body, which runs to its centre.
  if (tailImage) {
    if (upscroll) ctx.drawImage(tailImage, laneX, tailBoxTop, laneWidth, tailHeight);
    else drawImageFlippedY(ctx, tailImage, laneX, tailBoxTop, laneWidth, tailHeight);
  }

  if (headImage) {
    // Heads flip with the notes (on upscroll), unlike the tail.
    if (upscroll) drawImageFlippedY(ctx, headImage, laneX, headBoxTop, laneWidth, headHeight);
    else ctx.drawImage(headImage, laneX, headBoxTop, laneWidth, headHeight);
  } else {
    ctx.fillStyle = profile.lnHeadColors[ln.column] || profile.lnHeadColor || "#ffffff";
    fillRoundedRect(ctx, laneX + 1, headBoxTop, laneWidth - 2, headHeight, 4);
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
  // The MAX judgement, exactly as the skin defines it: a skin that ships a
  // transparent 300g hides perfect hits in game, so the preview stays empty
  // there too. hit300 only stands in when the skin has no 300g asset at all.
  const judgementAsset = profile.assets.judgements.hit300g ?? profile.assets.judgements.hit300;
  const judgementImage = judgementAsset ? images.get(judgementAsset.src) : undefined;
  const judgementScale = judgementAsset?.scale && judgementAsset.scale > 0 ? judgementAsset.scale : 1;
  if (judgementImage) {
    // Native texture pixels in the game's 768-unit space (the key-area rule),
    // so @2x art draws at half its pixel size and tiny textures stay tiny
    // like they do in game. Capped for absurdly wide art.
    const nativeWidth = (judgementImage.naturalWidth || 1) / judgementScale;
    const nativeHeight = (judgementImage.naturalHeight || 1) / judgementScale;
    const width = Math.min(layout.stageWidth * 0.9, nativeWidth * (480 / 768) * layout.scale);
    const height = nativeHeight * (width / nativeWidth);
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
  for (const asset of [
    profile.assets.stage.left,
    profile.assets.stage.right,
    profile.assets.stage.bottom,
    profile.assets.stage.hint,
    profile.assets.stage.light,
    profile.assets.stage.lighting,
  ]) {
    if (asset?.src) sources.add(asset.src);
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
