import type { SkinPreviewChartNote, SkinPreviewChartSnippet } from "./skin-preview-patterns";
import type { ReplaySkinKeymodeProfile, ReplaySkinSettings } from "./replay-skin";
import {
  getReplaySkinProfile,
  getReplaySkinStagePosition,
  OSU_MANIA_DEFAULT_COLUMN_LINE_WIDTH,
  OSU_MANIA_DEFAULT_COLUMN_START,
  OSU_MANIA_DEFAULT_LIGHT_POSITION,
} from "./replay-skin";

// Composes the browse-card preview for an uploaded skin: a fixed 1280x720
// playfield snippet rendered from the skin's own note/receptor/LN assets, with
// flat-colour fallbacks where the skin has none. Sprite sizing and anchoring
// follow osu!stable, not naive image-fitting: the stage sits at ColumnStart
// like in game (not centred), note heights come from noteHeightScale, LN
// bodies follow the skin's NoteBodyStyle - cascade at natural aspect from the
// tail end by default (what makes Percy-style 40000px body images show their
// baked-in rounded cap instead of squashing it flat), stretch one copy when
// the skin declares style 0, cascade from the head end for 2 - the body runs
// half-way under the head cap and the full depth of the tail cap, and key
// images stretch from the hit line to the bottom edge. The note pattern is
// seeded by the key count only, so every skin renders the same "chart" and
// previews stay comparable side by side. The image doubles as the OG card.

export const SKIN_PREVIEW_WIDTH = 1280;
export const SKIN_PREVIEW_HEIGHT = 720;
const PREVIEW_BACKGROUND = "#16121d";
// Flat backdrop triangles: base side length before per-triangle jitter, the
// grid they are dealt onto, the darkest shade of the accent any of them take,
// and an equilateral triangle's height per unit of side. The grid is dense
// enough (126 triangles once the off-canvas ring is counted) that the field
// covers the canvas about three times over, the way osu!'s own triangle
// texture leaves no background showing.
const BACKDROP_TRIANGLE_SIDE = 215;
const BACKDROP_COLUMNS = 12;
const BACKDROP_ROWS = 7;
const BACKDROP_TONE_FLOOR = 0.085;
const BACKDROP_EQUILATERAL = 0.866;
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
  // Columns whose receptor is down at the frozen instant: a note landing on the
  // line, or a hold being held through it. They get the pressed key image, the
  // column light and the hit lighting.
  pressed: number[];
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
  // Nothing lands on the line in the synthetic pattern, so one column is simply
  // shown held; the second one, which every keymode from 2K up has.
  return { taps, longNotes, pressed: [Math.min(1, keys - 1)] };
}

// The scroll speed to lay a snippet out at, as a multiple of the note's own
// height between the tightest pair of notes in a column. Packing them as close
// as they can go without touching fills the card wall to wall and buries the
// note art; a couple of note heights of air is roughly what a playable scroll
// speed looks like, and it leaves the skin visible between the notes.
const CHART_PATTERN_TARGET_GAP = 2.2;
// Two note heights of air is a lot of field when the notes are tall circles,
// so the gap is also capped at a share of the playfield: however big the art,
// a column still gets about this many notes rather than two and a gap.
const CHART_PATTERN_TARGET_ROWS = 5;
// The hard floor, whatever the art: closer than this and two notes read as one
// smear.
const CHART_PATTERN_MIN_GAP = 1.05;
// The shortest stretch of chart a card will show. A snippet that jacks tighter
// than the note art can render gets overlapping notes rather than a field with
// four notes on it: the frame is a still, and an empty one says less about a
// skin than a busy one.
const CHART_PATTERN_MIN_WINDOW_MS = 320;

// Lays a chart snippet out on the field. The scroll speed is chosen here rather
// than baked into the snippet, because how much chart fits is a question about
// the skin's note art: tall circle notes need more room per note than thin bars,
// so the same snippet shows less of the chart under them. Within that limit the
// field is filled as far as the snippet reaches.
export function buildChartPreviewPattern(
  snippet: SkinPreviewChartSnippet,
  options: SkinPreviewPatternOptions = {},
): SkinPreviewPattern {
  const keys = Math.max(1, Math.floor(snippet.keys));
  const canvasHeight = options.canvasHeight ?? SKIN_PREVIEW_HEIGHT;
  const hitLineY = options.hitLineY ?? canvasHeight * HIT_LINE_FRACTION;
  const noteHeight = Math.max(12, options.noteHeight ?? 40);
  const usable = Math.max(1, hitLineY - canvasHeight * SCROLL_TOP_FRACTION);
  const notes = snippet.notes.filter((note) => note.column >= 0 && note.column < keys);

  const spanMs = Math.max(1, ...notes.map((note) => note.time));
  const gapPx = Math.max(
    noteHeight * CHART_PATTERN_MIN_GAP,
    Math.min(noteHeight * CHART_PATTERN_TARGET_GAP, usable / CHART_PATTERN_TARGET_ROWS),
  );
  const pxPerMs = fitScrollSpeed(notes, { usable, gapPx, spanMs });
  const windowMs = usable / pxPerMs;

  const taps: SkinPreviewTapNote[] = [];
  const longNotes: SkinPreviewLongNote[] = [];
  const pressed = new Set<number>();
  for (const note of notes) {
    if (note.endTime > note.time) {
      if (note.endTime <= 0 || note.time > windowMs) continue;
      // A hold being held sticks to the judgement line while its body drains
      // through it, exactly as the replay viewer draws one.
      if (note.time <= 0) pressed.add(note.column);
      longNotes.push({
        column: note.column,
        headY: hitLineY - Math.max(0, note.time) * pxPerMs,
        // Tails past the top of the field are left off the canvas, so a long
        // hold runs off the edge instead of growing a cap that is not there.
        tailY: hitLineY - note.endTime * pxPerMs,
      });
      continue;
    }
    if (note.time < 0 || note.time > windowMs) continue;
    // The note sitting on the line is the one being hit.
    if (note.time === 0) pressed.add(note.column);
    taps.push({ column: note.column, y: hitLineY - note.time * pxPerMs });
  }
  taps.sort((a, b) => a.y - b.y);
  return { taps, longNotes, pressed: [...pressed].sort((a, b) => a - b) };
}

// Pixels per millisecond, which is the scroll speed and so how much of the
// snippet the card shows.
//
// The tightest pair of notes in a column decides it, but only among the notes
// that end up on screen: a snippet is a couple of seconds long and a single
// jack a second and a half up would otherwise speed the whole frame up to
// nothing. So the notes are walked in time order, each one tightening the
// constraint and shortening the window, and the walk stops at the first note
// the window no longer reaches. A note counted on the way is never drawn closer
// than the gap it asked for, which is what keeps a column from smearing.
function fitScrollSpeed(
  notes: SkinPreviewChartNote[],
  { usable, gapPx, spanMs }: { usable: number; gapPx: number; spanMs: number },
): number {
  const slowest = usable / spanMs;
  const fastest = usable / CHART_PATTERN_MIN_WINDOW_MS;
  // Where each column is next free: a hold occupies through its tail, so the
  // note after it is measured from there rather than from the head.
  const freeAt = new Map<number, number>();
  let tightest = Number.POSITIVE_INFINITY;
  let pxPerMs = Math.min(fastest, slowest);
  for (const note of [...notes].sort((a, b) => a.time - b.time)) {
    if (note.time > usable / pxPerMs) break;
    const previous = freeAt.get(note.column);
    // Two notes stacked on the same instant in a column happen in the wild and
    // there is no scroll speed that separates them, so the pair is passed over
    // rather than pinning the whole frame to a gap of zero.
    if (previous != null && note.time > previous) tightest = Math.min(tightest, note.time - previous);
    freeAt.set(note.column, Math.max(note.time, note.endTime));
    if (Number.isFinite(tightest)) pxPerMs = Math.min(fastest, Math.max(slowest, gapPx / tightest));
  }
  return pxPerMs;
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
  // The chart snippet to freeze on the field. Null or absent renders the
  // synthetic pattern, which is what every preview drawn before the picker
  // existed used. A snippet for the wrong keymode is ignored.
  pattern?: SkinPreviewChartSnippet | null;
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
  const hitGap = Math.max(0, Math.min(768, getReplaySkinStagePosition(profile, settings, "hitPosition"))) * (480 / 768) * layout.scale;
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
  const patternOptions = {
    canvasHeight: SKIN_PREVIEW_HEIGHT,
    hitLineY: judgmentY,
    noteHeight: patternNoteHeight,
  };
  const snippet = options.pattern && options.pattern.keys === keys ? options.pattern : null;
  const pattern = snippet
    ? buildChartPreviewPattern(snippet, patternOptions)
    : buildSkinPreviewPattern(keys, patternOptions);

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
  // Whatever the pattern says is being held right now. A chart snippet often
  // presses several columns at once (a chord landing, a hold running through
  // the line); the synthetic pattern names one.
  const pressedColumns = pattern.pressed.filter((column) => column >= 0 && column < keys);
  const isPressed = (column: number) => pressedColumns.includes(column);
  const judgmentLineY = mapY(judgmentY);

  const lightAsset = stage.light;
  const lightImage = lightAsset ? images.get(lightAsset.src) : undefined;
  if (lightImage) {
    // Stable draws the column light up the lane while the key is held, its
    // bottom edge at skin.ini LightPosition - NOT at the hit position. The
    // default 413 sits 11 units below the default hit line, and O2Jam-style
    // decks rely on the light overlapping their key tops. Anchored relative
    // to the (possibly clamped) judgement line so the declared gap survives
    // the card's clamping; only the pressed columns show it.
    const height = stageScale(lightAsset, lightImage);
    const hitUnits = Math.max(0, Math.min(768, getReplaySkinStagePosition(profile, settings, "hitPosition"))) * (480 / 768);
    const lightUnits = 480 - (profile.lightPosition ?? OSU_MANIA_DEFAULT_LIGHT_POSITION);
    const lightShift = (hitUnits - lightUnits) * layout.scale;
    for (const column of pressedColumns) {
      const tint = stage.lightColors[column] || "";
      const art = tint ? tintedImage(lightImage, tint) : lightImage;
      const laneX = layout.laneXs[column];
      const laneWidth = layout.laneWidths[column];
      if (upscroll) drawImageFlippedY(ctx, art, laneX, judgmentLineY - lightShift, laneWidth, height);
      else ctx.drawImage(art, laneX, judgmentLineY + lightShift - height, laneWidth, height);
    }
  }

  const hintAsset = stage.hint;
  const hintImage = hintAsset ? images.get(hintAsset.src) : undefined;
  if (hintImage) {
    // The hint marks the hit position across the whole stage.
    const height = stageScale(hintAsset, hintImage);
    if (upscroll) drawImageFlippedY(ctx, hintImage, layout.stageX, judgmentLineY, layout.stageWidth, height);
    else ctx.drawImage(hintImage, layout.stageX, judgmentLineY - height / 2, layout.stageWidth, height);
  }

  // Imported key-area art is authored against the stage edge below the hit
  // line, not against this preview canvas's edge. The preview may clamp the
  // hit line upward for readability, so anchoring to the canvas separated the
  // receptor from the note and LightingN art that should overlap it. This is
  // the same positioning rule as ReplayCanvas.renderReceptors.
  const drawReceptors = () => {
    const stageEdge = hitGap;
    for (let col = 0; col < keys; col += 1) {
      const assets = profile.assets.columns[col] ?? {};
      const asset = isPressed(col) ? assets.receptorPressed ?? assets.receptor : assets.receptor;
      const image = asset ? images.get(asset.src) : undefined;
      const laneX = layout.laneXs[col];
      const laneWidth = layout.laneWidths[col];
      if (image) {
        const assetScale = asset?.scale && asset.scale > 0 ? asset.scale : 1;
        const nativeHeight = (asset?.height && asset.height > 0 ? asset.height : image.naturalHeight || 1) / assetScale;
        const height = Math.max(1, nativeHeight * (480 / 768) * layout.scale);
        const top = upscroll
          ? judgmentLineY - stageEdge
          : judgmentLineY + stageEdge - height;
        if (upscroll) drawImageFlippedY(ctx, image, laneX, top, laneWidth, height);
        else ctx.drawImage(image, laneX, top, laneWidth, height);
      } else {
        const height = Math.max(6, SKIN_PREVIEW_HEIGHT * 0.012);
        const top = upscroll ? judgmentLineY - height - 2 : judgmentLineY + 2;
        ctx.fillStyle = isPressed(col) ? accent : "rgba(255, 255, 255, 0.25)";
        fillRoundedRect(ctx, laneX + 2, top, laneWidth - 4, height, 2);
      }
    }
  };

  // Match the game's sprite order. Most circle skins leave KeysUnderNotes at
  // zero, so their receptor ring belongs over the landing note; arrow/deck
  // skins can explicitly put the key area underneath instead.
  if (profile.keysUnderNotes) drawReceptors();
  for (const ln of pattern.longNotes) {
    drawLongNote(ctx, profile, images, layout, ln, settings, noteAssetHeight, mapY);
  }
  for (const tap of pattern.taps) {
    drawTapNote(ctx, profile, images, layout, tap, upscroll, noteAssetHeight, mapY);
  }

  // The line at HitPosition uses the skin's declared colour. Black-on-black
  // is intentionally invisible; inventing a translucent white line made this
  // skin look unlike both stable and lazer.
  if (profile.judgementLine) {
    ctx.fillStyle = profile.judgementLineColor || "rgba(255, 255, 255, 0.25)";
    ctx.fillRect(layout.stageX, judgmentLineY - 1, layout.stageWidth, 2);
  }
  if (!profile.keysUnderNotes) drawReceptors();

  // Deck, frame and hit glow sit over the columns, as they do in game: the
  // key area art overlaps the bottom of the stage and the frame flanks it.
  const bottomAsset = stage.bottom;
  const bottomImage = bottomAsset ? images.get(bottomAsset.src) : undefined;
  if (bottomImage) {
    // Stable never stretches this element ("this element will not be
    // stretched to fit the stage width"). Its native size is authored in the
    // 480-unit playfield space on both axes; 0.625 is the relationship between
    // that space and the 768-unit screen, not another width multiplier. A
    // canvas taller than 480 therefore hangs off the TOP of the screen and is
    // clipped - tekkito2's 576-tall canvas keeps only the lower slice of its
    // black bar, a strip hugging the very top of the field, not a box
    // mid-stage.
    const bottomScale = bottomAsset?.scale && bottomAsset.scale > 0 ? bottomAsset.scale : 1;
    const nativeWidth = (bottomAsset?.width && bottomAsset.width > 0 ? bottomAsset.width : bottomImage.naturalWidth || 1) / bottomScale;
    const nativeHeight = (bottomAsset?.height && bottomAsset.height > 0 ? bottomAsset.height : bottomImage.naturalHeight || 1) / bottomScale;
    const width = Math.max(1, nativeWidth * layout.scale);
    const height = Math.max(1, nativeHeight * layout.scale);
    const x = layout.stageX + (layout.stageWidth - width) / 2;
    if (upscroll) drawImageFlippedY(ctx, bottomImage, x, 0, width, height);
    else ctx.drawImage(bottomImage, x, SKIN_PREVIEW_HEIGHT - height, width, height);
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
    const assetScale = lightingAsset?.scale && lightingAsset.scale > 0 ? lightingAsset.scale : 1;
    const nativeWidth = (lightingAsset?.width && lightingAsset.width > 0 ? lightingAsset.width : lightingImage.naturalWidth || 1) / assetScale;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const column of pressedColumns) {
      const declaredWidth = stage.lightingWidths[column];
      const width = Math.max(1, (declaredWidth && declaredWidth > 0 ? declaredWidth : nativeWidth * (480 / 768)) * layout.scale);
      const height = Math.max(1, width * ((lightingImage.naturalHeight || 1) / (lightingImage.naturalWidth || 1)));
      const centerX = layout.laneXs[column] + layout.laneWidths[column] / 2;
      ctx.drawImage(lightingImage, centerX - width / 2, judgmentLineY - height / 2, width, height);
    }
    ctx.restore();
  }

  drawJudgementAndCombo(ctx, profile, images, layout, settings);

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
  // The same field the upload modal's drop zone drifts, and the same one
  // lazer scatters behind its menus: every triangle equilateral and pointing
  // up, sizes clustered around one base, each filled opaque with a shade of
  // the accent. What made the old backdrop read as a pile of shards was the
  // opposite of all three - a dozen triangles, up and down, from half to a
  // full canvas height, stacked with alpha so every overlap became another
  // seam.
  const tint = hexChannels(accent) ?? [255, 102, 171];
  const base = hexChannels(PREVIEW_BACKGROUND) ?? [22, 18, 29];
  const shade = (amount: number) => {
    const channel = (index: number) => Math.round(base[index] + (tint[index] - base[index]) * amount);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  };

  // Only ever seen through the gaps, since the field covers the canvas three
  // times over; the darkest shade, so a sliver reads as part of it.
  ctx.fillStyle = shade(BACKDROP_TONE_FLOOR);
  ctx.fillRect(0, 0, SKIN_PREVIEW_WIDTH, SKIN_PREVIEW_HEIGHT);

  const random = mulberry32(0x5eed);
  // Box-Muller off the seeded stream: sizes cluster around the base with a
  // tail each way, so the field gets its handful of dominant triangles and its
  // scattering of small ones instead of one uniform size.
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const cellWidth = SKIN_PREVIEW_WIDTH / BACKDROP_COLUMNS;
  const cellHeight = SKIN_PREVIEW_HEIGHT / BACKDROP_ROWS;
  const field: { x: number; y: number; side: number; tone: number }[] = [];
  // One triangle per cell of a jittered grid, carried a ring past every edge
  // so the border is never bare. Purely random placement clumps in one corner
  // and leaves holes in another; the jitter is wide enough that no row or
  // column shows through.
  for (let row = -1; row <= BACKDROP_ROWS; row += 1) {
    for (let col = -1; col <= BACKDROP_COLUMNS; col += 1) {
      // Odd rows sit half a cell over, packing the field like a honeycomb.
      const stagger = Math.abs(row % 2) === 1 ? cellWidth / 2 : 0;
      const scale = Math.min(2.6, Math.max(0.26, 1 + 0.42 * normal()));
      field.push({
        x: (col + 0.5) * cellWidth + stagger + (random() - 0.5) * cellWidth * 0.8,
        y: (row + 0.5) * cellHeight + (random() - 0.5) * cellHeight * 0.8,
        side: BACKDROP_TRIANGLE_SIDE * scale,
        tone: random(),
      });
    }
  }
  // Large behind, small in front, lazer's draw order.
  field.sort((a, b) => b.side - a.side);
  for (const triangle of field) {
    const height = triangle.side * BACKDROP_EQUILATERAL;
    // A narrow band of shades: wide contrast turns every overlap into an edge
    // that competes with the stage.
    ctx.fillStyle = shade(BACKDROP_TONE_FLOOR + triangle.tone * 0.16);
    ctx.beginPath();
    ctx.moveTo(triangle.x, triangle.y - height / 2);
    ctx.lineTo(triangle.x - triangle.side / 2, triangle.y + height / 2);
    ctx.lineTo(triangle.x + triangle.side / 2, triangle.y + height / 2);
    ctx.closePath();
    ctx.fill();
  }
}

// Channels of a #rrggbb colour; null for anything else, so a caller can fall
// back rather than draw with NaN.
function hexChannels(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
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

// The vertical extent of a texture's visible pixels, as fractions of its
// height (0 = top edge). Read once per texture from a scratch canvas and
// cached by source; null when the art is fully transparent or unreadable.
// The tail cap needs it: where its art actually sits inside the box decides
// how far the body has to run to meet it.
const alphaBoundsCache = new Map<string, { top: number; bottom: number } | null>();
const ALPHA_BOUNDS_THRESHOLD = 25;

function imageAlphaBounds(image: HTMLImageElement): { top: number; bottom: number } | null {
  const key = image.src;
  const cached = alphaBoundsCache.get(key);
  if (cached !== undefined) return cached;
  let bounds: { top: number; bottom: number } | null = null;
  const width = image.naturalWidth || 0;
  const height = image.naturalHeight || 0;
  if (width > 0 && height > 0) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        const alpha = ctx.getImageData(0, 0, width, height).data;
        const rowVisible = (row: number) => {
          const start = row * width * 4;
          for (let index = start + 3; index < start + width * 4; index += 4) {
            if (alpha[index] >= ALPHA_BOUNDS_THRESHOLD) return true;
          }
          return false;
        };
        let top = 0;
        while (top < height && !rowVisible(top)) top += 1;
        if (top < height) {
          let bottom = height - 1;
          while (bottom > top && !rowVisible(bottom)) bottom -= 1;
          bounds = { top: top / height, bottom: (bottom + 1) / height };
        }
      }
    } catch {
      bounds = null;
    }
  }
  alphaBoundsCache.set(key, bounds);
  return bounds;
}

// Where the tail cap's art meets the body, as a fraction of the tail box's
// height from its top. Downscroll draws the cap flipped, so the texture's
// TOP edge faces the body in both scroll directions.
export function lnTailArtEdgeFraction(artTopFraction: number, upscroll: boolean): number {
  return upscroll ? artTopFraction : 1 - artTopFraction;
}

export interface SkinPreviewLongNoteGeometry {
  bodyTop: number;
  bodyBottom: number;
  headBoxTop: number;
  tailBoxTop: number;
}

// Stable's hold-note layout. Both caps are notes at their position lines and
// both boxes grow away from the receptor, the tail's texture drawn flipped
// (lazer's LegacyHoldNoteTailPiece inverts the scroll direction for exactly
// this). At the head the body stops at the cap's CENTRE, where a round cap is
// widest, so no nub of body pokes out around it.
//
// The span this returns is the CASCADE's, not the drawn one. At the tail it
// runs the full depth of the box, right to the far edge, because that edge is
// the origin the cascade counts from: a Percy body authors a transparent
// lead-in exactly as tall as the tail art, so the cap lands in it and the two
// interlock. Start the cascade half a cap late, as a centre stop would, and
// the lead-in slides down with it and opens a band of backdrop between cap
// and body. Where the body actually stops being drawn is drawLongNote's
// business, and it is the cap's centre there too.
export function longNoteGeometry(input: {
  upscroll: boolean;
  headEndY: number;
  tailEndY: number;
  headHeight: number;
  tailHeight: number;
}): SkinPreviewLongNoteGeometry {
  const { upscroll, headEndY, tailEndY, headHeight, tailHeight } = input;
  const headBoxTop = upscroll ? headEndY : headEndY - headHeight;
  const tailBoxTop = upscroll ? tailEndY : tailEndY - tailHeight;
  const headSideY = upscroll ? headEndY + headHeight / 2 : headEndY - headHeight / 2;
  const tailSideY = upscroll ? tailBoxTop + tailHeight : tailBoxTop;
  // Directional, NOT min/max. A hold whose tail has come within half a cap of
  // the head has no body left, and taking the absolute span would flip it and
  // draw that remainder on the far side of the head's centre. Callers treat
  // bodyBottom <= bodyTop as nothing to draw.
  return {
    bodyTop: upscroll ? headSideY : tailSideY,
    bodyBottom: upscroll ? tailSideY : headSideY,
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
  // A cap that draws nothing occupies no box. Skins routinely point the tail
  // at a blank placeholder (a 1x1 or 5x4 transparent png, or the default
  // mania-note#T they never authored) because the body image already ends in
  // its own rounded cap. Sizing a box off that placeholder's aspect invents a
  // lane-width-tall cap out of one transparent pixel, and since the body's
  // cascade starts at the box's far edge, the hold grows by that much and eats
  // the gap to the next note. Zero here, and likewise with no tail image at
  // all: the body then runs to the end line exactly, as in game.
  const tailBounds = tailImage ? imageAlphaBounds(tailImage) : null;
  const tailHeight = tailImage && tailBounds ? noteAssetHeight(tailImage) : 0;

  const geometry = longNoteGeometry({
    upscroll,
    headEndY,
    tailEndY,
    headHeight,
    tailHeight,
  });
  const { headBoxTop, tailBoxTop, bodyTop, bodyBottom } = geometry;

  // Where the body stops is a separate question from where its cascade starts.
  // It stops at the cap's CENTRE, stable's rule: cap art is widest there, so
  // the join hides under it and a hollow cap (ArrowMania's roof is two thin
  // strokes) has nothing showing through its middle. Caps whose art sits shy
  // of the centre - StepMania roofs, whose base is at 48% of the box - would
  // leave a seam of backdrop, so for those the body runs a pixel further, to
  // just under the art's own edge. A blank cap has no box (tailHeight 0) and
  // so nothing to clip against. The cascade meanwhile still counts from the
  // box's far edge, which is what puts a Percy lead-in under the cap.
  let visibleTop = bodyTop;
  let visibleBottom = bodyBottom;
  if (tailHeight > 0 && tailBounds) {
    const centreY = tailBoxTop + tailHeight / 2;
    const artEdgeY = tailBoxTop + lnTailArtEdgeFraction(tailBounds.top, upscroll) * tailHeight;
    const capEdgeY = upscroll ? Math.max(centreY, artEdgeY + 1) : Math.min(centreY, artEdgeY - 1);
    if (upscroll) visibleBottom = Math.min(visibleBottom, capEdgeY);
    else visibleTop = Math.max(visibleTop, capEdgeY);
  }

  if (bodyImage && visibleBottom > visibleTop) {
    // The skin's NoteBodyStyle decides how the art fills the span: stretch one
    // copy (0), or cascade it at natural aspect - tiling when the art is
    // shorter than the hold - anchored at the tail (1, stable's default) or
    // the head (2). Percy bodies are one huge cascade tile whose rounded cap
    // (and "appears shorter" transparent lead-in) lands at the tail. Cascades
    // draw via source slices so the destination rect never exceeds the visible
    // span: Chromium quietly rasterises multi-thousand-pixel upscales through
    // a capped intermediate, which would squash the cap flat.
    const bodyStyle = profile.noteBodyStyles[ln.column] ?? 1;
    const sourceWidth = bodyImage.naturalWidth || 1;
    const sourceHeight = bodyImage.naturalHeight || 1;
    ctx.save();
    // Clipped before the flip so the rect stays in canvas space either way.
    ctx.beginPath();
    ctx.rect(laneX, visibleTop, laneWidth, visibleBottom - visibleTop);
    ctx.clip();
    // bodyTileRects anchors at bodyTop, so flip the span whenever the anchor
    // end - the tail for cascade styles 0/1, the head for 2 - sits at the
    // bottom. That both repositions the tiles and mirrors the art so its top
    // row keeps facing the anchor, the same rule the replay canvas draws by.
    const anchorAtBottom = bodyStyle === 2 ? !upscroll : upscroll;
    if (anchorAtBottom) {
      ctx.translate(0, bodyTop + bodyBottom);
      ctx.scale(1, -1);
    }
    if (bodyStyle === 0) {
      ctx.drawImage(bodyImage, 0, 0, sourceWidth, sourceHeight, laneX, bodyTop, laneWidth, bodyBottom - bodyTop);
    } else {
      for (const tile of bodyTileRects(bodyTop, bodyBottom, sourceHeight, laneWidth / sourceWidth)) {
        ctx.drawImage(bodyImage, 0, 0, sourceWidth, tile.sourceRows, laneX, tile.top, laneWidth, tile.height);
      }
    }
    ctx.restore();
  } else if (visibleBottom > visibleTop) {
    ctx.fillStyle = settings.lnBodyColor || "#8b8b93";
    ctx.globalAlpha = 0.9;
    ctx.fillRect(laneX + laneWidth * 0.16, visibleTop, laneWidth * 0.68, visibleBottom - visibleTop);
    ctx.globalAlpha = 1;
  }

  // Both caps' boxes grow away from the receptor; the tail's texture is drawn
  // flipped relative to the notes - flipped on downscroll, upright on upscroll
  // (lazer's LegacyHoldNoteTailPiece inverts the scroll direction for exactly
  // this). Drawn over the body, which runs the full depth of the box beneath
  // it, so no cap can leave a seam.
  if (tailImage && tailHeight > 0) {
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
  settings: ReplaySkinSettings,
): void {
  const centerX = layout.stageX + layout.stageWidth / 2;
  const averageLane = layout.stageWidth / Math.max(1, layout.laneWidths.length);
  const stagePositionY = (key: "scorePosition" | "comboPosition") => {
    const fromBottom = Math.max(0, Math.min(768, getReplaySkinStagePosition(profile, settings, key)))
      * (480 / 768) * layout.scale;
    return settings.upscroll ? fromBottom : SKIN_PREVIEW_HEIGHT - fromBottom;
  };
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
    const centerY = Math.max(
      SKIN_PREVIEW_HEIGHT * 0.05,
      Math.min(SKIN_PREVIEW_HEIGHT * 0.8, stagePositionY("scorePosition")),
    );
    ctx.drawImage(judgementImage, centerX - width / 2, centerY - height / 2, width, height);
  }

  const combo = profile.assets.combo;
  // ComboPosition pushed off the stage means the skin wants no counter.
  if (!combo || profile.comboHidden) return;
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
  // Centred on skin.ini ComboPosition (kept by the importer as the replay
  // viewer's from-the-bottom 768-space), through the same stage zoom as the
  // hit line so it stays aligned with the stage furniture. Skins design
  // around the declared spot - tekkito2 paints a mania-stage-bottom bar
  // there as the counter's backdrop - so a fixed height left that art
  // orphaned. Clamped to the card for degenerate values.
  const comboCenter = stagePositionY("comboPosition");
  const y = Math.max(
    SKIN_PREVIEW_HEIGHT * 0.05,
    Math.min(SKIN_PREVIEW_HEIGHT * 0.8, comboCenter - digitHeight / 2),
  );
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
