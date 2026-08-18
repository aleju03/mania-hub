// The falling-note sprites, in one place.
//
// Three surfaces drop these: the home page rain (components/home/ManiaRain),
// the skins social card (routes/api/og.ts), and the signature backdrop
// (routes/api/signature/-art.ts). They are meant to look like the same rain,
// so the roster lives here rather than being copied into each one.
//
// `tint` is the flat colour a canvas falls back to before the sprite decodes;
// it is also a fair summary of what the sprite looks like, which is why the
// list carries it rather than each caller guessing.

export interface NoteSprite {
  /** File name under /images/notes, without the extension. */
  name: string;
  /** Bars are wide and flat; everything else draws in a square box. */
  aspect: "square" | "bar";
  /** The file's own width divided by its height. Recorded so a still can draw
      the sprite at the shape it actually is; a test checks each of these
      against the file, so replacing a sprite fails rather than silently
      stretching it. */
  ratio: number;
  tint: string;
}

export const NOTE_SPRITES: NoteSprite[] = [
  { name: "arrow-down-gray", aspect: "square", ratio: 162 / 158, tint: "rgba(225, 225, 235, 0.36)" },
  { name: "arrow-down-green", aspect: "square", ratio: 1, tint: "rgba(166, 228, 120, 0.38)" },
  { name: "arrow-left-gray", aspect: "square", ratio: 162 / 158, tint: "rgba(225, 225, 235, 0.36)" },
  { name: "arrow-left-pink", aspect: "square", ratio: 1, tint: "rgba(255, 131, 192, 0.36)" },
  { name: "arrow-right-gray", aspect: "square", ratio: 162 / 158, tint: "rgba(225, 225, 235, 0.36)" },
  { name: "arrow-right-green", aspect: "square", ratio: 1, tint: "rgba(166, 228, 120, 0.38)" },
  { name: "arrow-up-gray", aspect: "square", ratio: 162 / 158, tint: "rgba(225, 225, 235, 0.36)" },
  { name: "arrow-up-pink", aspect: "square", ratio: 1, tint: "rgba(255, 131, 192, 0.36)" },
  { name: "bar-blue", aspect: "bar", ratio: 252 / 155, tint: "rgba(102, 186, 255, 0.36)" },
  { name: "bar-gray", aspect: "bar", ratio: 252 / 155, tint: "rgba(225, 225, 235, 0.34)" },
  { name: "bar-red", aspect: "bar", ratio: 256 / 115, tint: "rgba(255, 126, 126, 0.36)" },
  { name: "bar-yellow", aspect: "bar", ratio: 252 / 155, tint: "rgba(255, 214, 115, 0.36)" },
  { name: "circle-blue", aspect: "square", ratio: 1, tint: "rgba(102, 186, 255, 0.35)" },
  { name: "circle-blue-light", aspect: "square", ratio: 1, tint: "rgba(135, 214, 255, 0.35)" },
  { name: "circle-gray", aspect: "square", ratio: 1, tint: "rgba(225, 225, 235, 0.34)" },
  { name: "circle-green", aspect: "square", ratio: 150 / 146, tint: "rgba(166, 228, 120, 0.38)" },
  { name: "circle-navy", aspect: "square", ratio: 1, tint: "rgba(121, 148, 255, 0.3)" },
  { name: "circle-pink", aspect: "square", ratio: 150 / 146, tint: "rgba(255, 131, 192, 0.36)" },
  { name: "circle-pink-glow", aspect: "square", ratio: 1, tint: "rgba(255, 149, 206, 0.42)" },
  { name: "circle-purple", aspect: "square", ratio: 1, tint: "rgba(184, 146, 255, 0.34)" },
  { name: "circle-violet", aspect: "square", ratio: 1, tint: "rgba(174, 127, 255, 0.34)" },
  { name: "circle-white", aspect: "square", ratio: 1, tint: "rgba(245, 245, 250, 0.34)" },
];

export function noteSpritePath(name: string): string {
  return `/images/notes/${name}.png`;
}

/* A hold's head keeps the sprite's own orientation so its body lines up under
   it, which an up or down arrow cannot do: the body would run out of the
   arrow's back. Those two are taps only, in the rain and here. */
export function canHoldNote(sprite: NoteSprite): boolean {
  return !sprite.name.startsWith("arrow-up") && !sprite.name.startsWith("arrow-down");
}

/** A circle's share of its own box, which is what "the same amount of ink" is
    measured against below. */
const CIRCLE_FILL = Math.PI / 4;

/* The box to draw a sprite in at a given nominal size, at the sprite's own
   proportion.

   ManiaRain flattens all four bars into one 1.4 x 0.3 box whatever shape they
   are, which is a two to three times vertical squash. On a faint rain that is
   moving it passes; on a still it shows, and bar-red - a hard-edged rectangle,
   natively flatter than the other three - comes out as a pointed sliver once
   it is tilted.

   A bar is scaled to lay down about as much ink as a circle of the same size,
   rather than to the same width, so a flatter sprite does not also read as a
   lighter one. */
export function noteSpriteBox(sprite: NoteSprite, size: number): { width: number; height: number } {
  const width = sprite.aspect === "bar" ? size * Math.sqrt(CIRCLE_FILL * sprite.ratio) : size;
  return { width, height: width / sprite.ratio };
}
