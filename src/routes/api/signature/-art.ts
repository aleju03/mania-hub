// The site's own two backdrops, redrawn at signature size. The `-` prefix
// keeps this out of the route tree, same convention as the layouts.
//
// Both are deterministic for a given (art, colour, size). That is not a style
// choice: a render is stored under a key derived from the player's data and
// style, so a backdrop that scattered itself differently each time would make
// the stored image disagree with the preview that produced it, and every
// re-render would look like a change nobody made.

import { createElement as h } from "react";
import type { ReactNode } from "react";

import { getNoteSpriteDataUrl } from "../../../lib/og-render";
import { canHoldNote, NOTE_SPRITES, noteSpriteBox, type NoteSprite } from "../../../lib/note-sprites";
import { getAssetOrigin } from "../../../lib/origin";
import { shadeHex, styleArt, type SignatureStyle } from "../../../lib/signature-style";

/* Satori does not implement the CSS `inset` shorthand: a layer that uses it
   silently renders blank. Same constant, same reason, as in -renderers.ts. */
const FILL = { top: "0", left: "0", right: "0", bottom: "0" } as const;

/* The triangle field, ported from drawPreviewBackdrop in
   lib/skin-preview-render.ts - the one behind skin thumbnails and drifting in
   the upload drop zone, which is lazer's Triangles drawable. Not the page's
   OsuTriangleBackdrop, whose huge faceted polygons are a different thing
   entirely and read as diagonal bands at card size.
 *
 * What makes it that field rather than a pile of shards: every triangle
 * equilateral and pointing up, sizes clustered around one base, each filled
 * opaque with a shade from a narrow band, and the field dense enough to cover
 * the canvas about three times so no background shows through.
 *
 * That module is canvas-only, hence the port rather than a call. The numbers
 * below are its numbers; the geometry is expressed relative to the triangle
 * side so a 880x200 banner and a 300x300 badge get the same field rather than
 * the same triangle count. */
const TRIANGLE_SIDE_AT_REFERENCE = 215;
const REFERENCE_AREA = 1280 * 720;
const EQUILATERAL = 0.866;
/* Cell size as a fraction of a triangle, from the reference grid (12x7 cells
   at 1280x720 against a 215 side). This is what sets the three-times-over
   coverage; deriving it keeps that constant at any card size. */
const CELL_PER_SIDE_X = 1 / 2.02;
const CELL_PER_SIDE_Y = 1 / 1.81;
const TONE_FLOOR = 0.085;
const TONE_RANGE = 0.16;

function mixHex(from: string, to: string, amount: number): string {
  const a = hexChannels(from);
  const b = hexChannels(to);
  const channel = (index: number) => Math.round(a[index]! + (b[index]! - a[index]!) * amount);
  return `#${[channel(0), channel(1), channel(2)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function hexChannels(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function trianglesSvg(width: number, height: number, base: string, tint: string): string {
  // Sized off area rather than either edge: scaling by width alone gives a
  // tall card enormous triangles, and by height alone gives a banner a rash of
  // tiny ones.
  const side = TRIANGLE_SIDE_AT_REFERENCE * Math.sqrt((width * height) / REFERENCE_AREA);
  const cellWidth = side * CELL_PER_SIDE_X;
  const cellHeight = side * EQUILATERAL * CELL_PER_SIDE_Y;
  const columns = Math.max(2, Math.ceil(width / cellWidth));
  const rows = Math.max(2, Math.ceil(height / cellHeight));

  const random = seededRandom(0x5eed);
  // Box-Muller off the seeded stream: sizes cluster around the base with a
  // tail each way, so the field gets a handful of dominant triangles and a
  // scattering of small ones instead of one uniform size.
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

  const field: Array<{ x: number; y: number; side: number; tone: number }> = [];
  /* One triangle per cell of a jittered grid, carried a ring past every edge
     so no border is bare. Purely random placement clumps in one corner and
     leaves holes in another. */
  for (let row = -1; row <= rows; row += 1) {
    for (let column = -1; column <= columns; column += 1) {
      // Odd rows sit half a cell over, packing the field like a honeycomb.
      const stagger = Math.abs(row % 2) === 1 ? cellWidth / 2 : 0;
      const scale = Math.min(2.6, Math.max(0.26, 1 + 0.42 * normal()));
      field.push({
        x: (column + 0.5) * cellWidth + stagger + (random() - 0.5) * cellWidth * 0.8,
        y: (row + 0.5) * cellHeight + (random() - 0.5) * cellHeight * 0.8,
        side: side * scale,
        tone: random(),
      });
    }
  }
  // Large behind, small in front, lazer's draw order.
  field.sort((a, b) => b.side - a.side);

  const polygons = field.map((triangle) => {
    const triangleHeight = triangle.side * EQUILATERAL;
    const top = triangle.y - triangleHeight / 2;
    const bottom = triangle.y + triangleHeight / 2;
    const points = `${triangle.x.toFixed(1)},${top.toFixed(1)} `
      + `${(triangle.x - triangle.side / 2).toFixed(1)},${bottom.toFixed(1)} `
      + `${(triangle.x + triangle.side / 2).toFixed(1)},${bottom.toFixed(1)}`;
    // A narrow band of shades: wide contrast turns every overlap into an edge
    // that competes with the text on top.
    return `<polygon points="${points}" fill="${mixHex(base, tint, TONE_FLOOR + triangle.tone * TONE_RANGE)}"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    // Only ever seen through the gaps, since the field covers the canvas
    // several times over; the darkest shade, so a sliver reads as part of it.
    + `<rect width="${width}" height="${height}" fill="${mixHex(base, tint, TONE_FLOOR)}"/>`
    + polygons
    + `</svg>`;
}

/* The falling notes: the home page's rain, frozen.
 *
 * Not a chart. A charted version of this got built first and it was wrong -
 * lanes and a beat grid read as a fixed pattern, which is what the site's own
 * backdrops are conspicuously not. What the home page and the skins page drop
 * is a scatter: the real sprites at mixed sizes, tilts and opacities, a few of
 * them stretched into holds. The skins social card already freezes exactly that
 * for a still (SKINS_OG_NOTES in routes/api/og.ts), by hand, for one canvas.
 * This is the same picture generated for any card size, from the same sprites.
 *
 * Depth is what carries a still that has no motion to sell it, so the two
 * things a moving rain can leave to chance are deliberate here: size and
 * opacity move together, and the notes are drawn back to front. Placement is a
 * jittered grid, which is also what ManiaRain seeds itself on - free random
 * placement clumps in one corner and leaves a hole in another, and on a still
 * frame that never resolves.
 */

/* Canvas per note, note size, and how hard the notes are drawn.
 *
 * These three read off the skins social card rather than off the moving rain,
 * because that card is the site's own answer to "what does this look like
 * held still". It carries 25 notes on 1200x630 - one per 30,000px, ten times
 * sparser than a first pass at this - at 24 to 92px and 0.2 to 0.95 opacity.
 * Few, large and bold, with air between them. Many, small and faint is what
 * reads as noise, which is exactly what a tall card full of it looked like. */
const RAIN_AREA_PER_NOTE = 9000;
const RAIN_NOTE_SIZE = 32;
const RAIN_REFERENCE_AREA = 880 * 200;
const RAIN_SIZE_RANGE = { min: 0.6, max: 1.6 } as const;
/** Under the skins card's ceiling, since that one is a hero image and these
    sit under a name and three stat rows, but not far under: the sprites are
    pastel on a near-black base and the bottom of the range vanishes. */
const RAIN_OPACITY = { min: 0.1, max: 0.32 } as const;
/** Degrees either way. ManiaRain spins notes through a full turn because it is
    moving; on a still a hard tilt just reads as a mistake. */
const RAIN_TILT = 42;
/** About the skins card's two holds in twenty-five notes. */
const RAIN_HOLD_CHANCE = 0.1;

export interface RainNote {
  sprite: NoteSprite;
  /** Centre of the head. */
  x: number;
  y: number;
  /** Head box before the sprite's own aspect is applied. */
  size: number;
  rotate: number;
  opacity: number;
  /** How far the hold body reaches above the head; 0 for a tap. */
  hold: number;
}

/* The scatter, as data. Kept separate from the nodes that draw it so the thing
   with all the judgement in it can be tested without a renderer. */
export function planNoteRain(style: SignatureStyle, width: number, height: number): RainNote[] {
  const random = seededRandom(0x9e3779b9);
  const target = Math.max(6, Math.round((width * height) / RAIN_AREA_PER_NOTE));
  /* The fourth root of the area ratio, so note size barely moves between cards:
     a tall card gets notes about a tenth larger than the banner's, not the
     fifth that scaling by the square root gave it. The rain is a thing at its
     own scale, the way ManiaRain drops 18-40px notes at any viewport, but a
     300px badge still wants slightly smaller ones than an 880px banner. */
  const base = RAIN_NOTE_SIZE * ((width * height) / RAIN_REFERENCE_AREA) ** 0.25;
  const columns = Math.max(1, Math.ceil(Math.sqrt((target * width) / height)));
  const rows = Math.max(1, Math.ceil(target / columns));
  /* Every cell gets a note, rather than stopping at the target the grid was
     sized from. Stopping leaves the last row half-filled, which on a banner
     three rows tall is a visibly bare bottom-right corner. */
  const count = columns * rows;
  /* Overhang on every side, so the rain runs off the card instead of stopping
     politely inside a margin. Measured against the SMALLEST note rather than
     the largest: the margin is how far a centre may sit past the edge, so
     sizing it to the largest lets a small note in the outer ring land wholly
     off the card and count for nothing. This way every note still touches. */
  const margin = base * RAIN_SIZE_RANGE.min * 0.5;
  const cellWidth = (width + margin * 2) / columns;
  const cellHeight = (height + margin * 2) / rows;

  const notes: RainNote[] = [];
  for (let row = 0; row < rows && notes.length < count; row += 1) {
    for (let column = 0; column < columns && notes.length < count; column += 1) {
      const sprite = NOTE_SPRITES[Math.floor(random() * NOTE_SPRITES.length)]!;
      /* Squared, so most notes are small and a few are large. A flat draw gives
         every note a middling size and the field reads as one plane. */
      const spread = random() ** 2;
      const size = base * (RAIN_SIZE_RANGE.min + spread * (RAIN_SIZE_RANGE.max - RAIN_SIZE_RANGE.min));
      const hold = random() < RAIN_HOLD_CHANCE && canHoldNote(sprite)
        ? size * (1.6 + random() * 3.4)
        : 0;
      notes.push({
        sprite,
        x: -margin + (column + random()) * cellWidth,
        y: -margin + (row + random()) * cellHeight,
        size,
        // A hold's head keeps the sprite upright so its body lines up under it.
        rotate: hold > 0 ? 0 : Math.round((random() * 2 - 1) * RAIN_TILT),
        /* Bigger is nearer is brighter, with enough jitter that the two are not
           locked together. Depth is the whole reason a still of this works. */
        opacity: clamp01(
          (RAIN_OPACITY.min + spread * (RAIN_OPACITY.max - RAIN_OPACITY.min))
          * (0.82 + random() * 0.36)
          * (style.brightness / 100),
        ),
        hold,
      });
    }
  }
  // Back to front, the way SKINS_OG_NOTES is listed: faint notes first, so a
  // bright one in front reads as in front rather than as a collision.
  return notes.sort((a, b) => a.opacity - b.opacity);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Mulberry32. Seeded so the scatter is fixed art rather than a variable. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* One note as satori nodes, following skinsFallingNote in routes/api/og.ts.
   The body's flat bottom ends at the head centre so the opaque middle of the
   head sprite covers the seam - ManiaRain punches the head out of the body
   instead, which satori cannot do. */
function rainNoteNodes(note: RainNote, src: string, key: string): ReactNode[] {
  const box = noteSpriteBox(note.sprite, note.size);
  const parts: ReactNode[] = [];

  if (note.hold > 0) {
    const bodyWidth = Math.round(note.size * 0.5);
    parts.push(h("div", {
      key: `${key}-body`,
      style: {
        position: "absolute",
        left: `${Math.round(note.x - bodyWidth / 2)}px`,
        top: `${Math.round(note.y - note.hold)}px`,
        width: `${bodyWidth}px`,
        height: `${Math.round(note.hold)}px`,
        borderTopLeftRadius: `${bodyWidth / 2}px`,
        borderTopRightRadius: `${bodyWidth / 2}px`,
        background: "rgba(255,255,255,0.22)",
        opacity: note.opacity,
      },
    }));
  }

  parts.push(h("img", {
    key: `${key}-head`,
    src,
    style: {
      position: "absolute",
      left: `${Math.round(note.x - box.width / 2)}px`,
      top: `${Math.round(note.y - box.height / 2)}px`,
      width: `${Math.round(box.width)}px`,
      height: `${Math.round(box.height)}px`,
      opacity: note.opacity,
      ...(note.rotate ? { transform: `rotate(${note.rotate}deg)` } : {}),
    },
  }));

  return parts;
}

/* The rain as layers: the player's colour as the base, then the notes over it.
   Sprites are prefetched into data URLs rather than handed to satori as paths,
   for the reason getNoteSpriteDataUrl documents - two dozen parallel
   self-requests drop connections and notes go silently missing.

   A sprite that will not load is skipped rather than thrown: a backdrop is not
   worth failing a render over, and the base colour alone is a legitimate card
   (it is the "Solid" option). */
async function noteRainLayers(
  origin: string,
  style: SignatureStyle,
  width: number,
  height: number,
): Promise<ReactNode[]> {
  const notes = planNoteRain(style, width, height);
  const sprites = new Map<string, string>();
  // Sequential for the reason renderSkinsOg gives: the dev server serving this
  // route also serves the sprites, and a parallel burst is what broke satori's
  // own loading in the first place. Each one is a cache hit after the first
  // render of the process anyway.
  for (const name of new Set(notes.map((note) => note.sprite.name))) {
    try {
      sprites.set(name, await getNoteSpriteDataUrl(origin, name));
    } catch {
      // Left out of the map; the notes using it are dropped below.
    }
  }

  const layers: ReactNode[] = [h("div", {
    key: "bg-base",
    style: { position: "absolute", ...FILL, background: shadeHex(style.color, (style.brightness / 100) * 0.34) },
  })];
  for (const [index, note] of notes.entries()) {
    const src = sprites.get(note.sprite.name);
    if (src) layers.push(...rainNoteNodes(note, src, `bg-note-${index}`));
  }
  return layers;
}

/* The ManiaCard's own fleck field, ported from drawTrianglePattern in
   components/player/maniacard3d/cardTexture.ts: small triangles, slightly
   rotated, mostly white and occasionally dark, scattered over the tier
   gradient. It is what stops the card front from being a bare gradient, and
   its absence is exactly why the tier background read as "the rarity's base
   colour with a fade on it".

   Alphas are raised from the card's. There they sit on a 1000x1400 texture
   under a holographic shader that lifts them; here they are flat pixels on a
   card a fifth the size, and at the source values nothing would be visible. */
const CARD_SPACE_WIDTH = 1000;
const CARD_SPACE_HEIGHT = 1400;
const FLECK_HEIGHT_RATIO = 1.18;

export function tierFlecksDataUrl(width: number, height: number): string {
  // Same fleck size relative to the card, so a banner and a tall card get the
  // same texture rather than the same count.
  const scale = Math.sqrt((width * height) / (CARD_SPACE_WIDTH * CARD_SPACE_HEIGHT));
  const cellWidth = 110 * scale;
  const cellHeight = 96 * scale;
  const columns = Math.ceil(width / cellWidth) + 1;
  const rows = Math.ceil(height / cellHeight) + 1;

  const random = seededRandom(0x1c3d5f);
  const parts: string[] = [];
  for (let row = -1; row < rows; row += 1) {
    for (let column = -1; column < columns; column += 1) {
      if (random() < 0.55) {
        // Drawn from the stream either way, so skipping a cell does not shift
        // every fleck after it.
        random(); random(); random(); random(); random();
        continue;
      }
      const x = (column + 0.5) * cellWidth + (random() - 0.5) * 70 * scale;
      const y = (row + 0.5) * cellHeight + (random() - 0.5) * 80 * scale;
      const size = (18 + random() * 22) * scale;
      const rotation = (random() - 0.5) * 24;
      const dark = random() > 0.82;
      const alpha = dark ? 0.05 + random() * 0.05 : 0.09 + random() * 0.09;
      const halfWidth = size / 2;
      const halfHeight = (size * FLECK_HEIGHT_RATIO) / 2;
      const points = `${x.toFixed(1)},${(y - halfHeight).toFixed(1)} `
        + `${(x + halfWidth).toFixed(1)},${(y + halfHeight).toFixed(1)} `
        + `${(x - halfWidth).toFixed(1)},${(y + halfHeight).toFixed(1)}`;
      parts.push(
        `<polygon points="${points}" fill="${dark ? "#000000" : "#ffffff"}"`
        + ` fill-opacity="${alpha.toFixed(3)}"`
        + ` transform="rotate(${rotation.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + parts.join("")
    + `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/* The star field the two cosmic tiers carry. Their bases are near-black
   (#010409 through #000000 for World Class), so gradient and foil alone leave
   a banner looking like an unlit rectangle - the stars are what make those
   cards read as cosmic rather than as very dark. Colours are the tier's own
   `stars` list, which is where the 3D card's overlay shader gets them. */
export function cosmicStarsDataUrl(width: number, height: number, colors: string[]): string {
  const random = seededRandom(0x2b7e15);
  const count = Math.max(18, Math.round((width * height) / 2600));
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = random() * width;
    const y = random() * height;
    // A few bright ones among many faint, which is what reads as depth. A
    // uniform field reads as noise.
    const bright = random() > 0.86;
    const radius = bright ? 1.5 + random() * 1.4 : 0.5 + random() * 0.9;
    const alpha = bright ? 0.55 + random() * 0.35 : 0.14 + random() * 0.3;
    const color = colors[Math.floor(random() * colors.length)] ?? "255, 255, 255";
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" fill="rgb(${color})" fill-opacity="${alpha.toFixed(3)}"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + parts.join("")
    + `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** The triangle field as an SVG data URL, base colour included. Generated, so
    unlike a photo it cannot fail and needs no fallback path. */
export function trianglesArtDataUrl(style: SignatureStyle, width: number, height: number): string {
  const factor = style.brightness / 100;
  /* A blend between a near-black version of the colour and the colour itself,
     which is what the skin thumbnails do with their accent. Brightness scales
     both ends, so the slider moves the whole field rather than washing out one
     side of the blend. */
  const svg = trianglesSvg(
    width,
    height,
    shadeHex(style.color, factor * 0.10),
    shadeHex(style.color, factor),
  );
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** The finished backdrop as satori layers, base colour included, or null if
    this style draws no artwork.

    Two art styles, two shapes of output, and the difference is not arbitrary:
    the triangles are one flat field that an SVG says in a few kilobytes, while
    the rain is two dozen photographic sprites that satori composites natively
    and that no amount of SVG would reproduce. */
export async function signatureArtLayers(
  request: Request,
  style: SignatureStyle,
  width: number,
  height: number,
): Promise<ReactNode[] | null> {
  const art = styleArt(style);
  if (!art) return null;
  if (art === "triangles") {
    return [h("img", {
      key: "bg",
      src: trianglesArtDataUrl(style, width, height),
      width,
      height,
      style: { position: "absolute", top: "0", left: "0", width: `${width}px`, height: `${height}px` },
    })];
  }
  return noteRainLayers(getAssetOrigin(request), style, width, height);
}
