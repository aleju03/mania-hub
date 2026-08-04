/* The admin ghost: shared vocabulary between the visitor overlay
   (components/ghost) and the control panel (routes/admin/ghost).

   Each character is one atlas under public/images/ghost/: a grid of uniform
   frames, one clip per row, every frame aligned on the same anchor so switching
   clips never makes the sprite hop. The characters differ in frame size, clip
   set, poses and actions, so everything below is looked up through the roster
   rather than read off a single sheet. Route normalization mirrors
   live-backend/src/live/ghost.ts and must stay in step with it: the backend
   matches a session's route against what the overlay reports, so both sides
   have to fold a path the same way. */

/* How much of a screen a character may span. The scale on the wire is in raw
   sprite pixels, which is the same number of pixels on a phone as on a desktop:
   84 per step is a sixth of a wide screen and most of a narrow one, so every
   viewer caps it against their own width. */
export const GHOST_MAX_WIDTH_RATIO = 0.3;

/* Under this many CSS pixels across, count a viewer as being on a phone. Same
   breakpoint the site's own layout switches at. */
export const GHOST_NARROW_WIDTH = 768;

export type GhostFacing = "down" | "up" | "left" | "right";

export interface GhostClip {
  row: number;
  frames: number;
  fps: number;
  /* Which way the art already points, so the renderer knows when to mirror.
     Only "right" clips ever get mirrored: the walk cycles ship both sides, and
     mirroring one of those would turn a left walk back into a right one. */
  native: "down" | "up" | "left" | "right";
  /* Frames are a right-facing and a left-facing drawing rather than an
     animation, so the frame is picked by facing and never advances on a timer. */
  directional?: boolean;
  /* Frames are steps rather than an idle animation: they advance while the
     character is moving and hold still when he is not. What separates the dog
     on stilts, who should only stride when he is going somewhere, from the dog
     with maracas, who shakes them standing still. */
  gait?: boolean;
}

const RALSEI_CLIPS = {
  idle: { row: 0, frames: 1, fps: 1, native: "down" },
  "walk-down": { row: 1, frames: 4, fps: 8, native: "down" },
  "walk-up": { row: 2, frames: 4, fps: 8, native: "up" },
  "walk-left": { row: 3, frames: 4, fps: 8, native: "left" },
  "walk-right": { row: 4, frames: 4, fps: 8, native: "right" },
  shy: { row: 5, frames: 4, fps: 6, native: "down" },
  appear: { row: 6, frames: 8, fps: 7, native: "down" },
  spin: { row: 7, frames: 4, fps: 10, native: "down" },
  sing: { row: 8, frames: 3, fps: 5, native: "right" },
  /* Crouched in a golden glow with the hat pulled down, sparks coming off him.
     Not sleeping, whatever it looked like at first glance. */
  aura: { row: 9, frames: 4, fps: 4, native: "down" },
  cheer: { row: 10, frames: 8, fps: 10, native: "right" },
  heal: { row: 11, frames: 9, fps: 9, native: "right" },
  pacify: { row: 12, frames: 11, fps: 10, native: "right" },
  hat: { row: 13, frames: 4, fps: 6, native: "down" },
  scarf: { row: 14, frames: 8, fps: 12, native: "right" },
  hooded: { row: 15, frames: 2, fps: 2, native: "down" },
  stand: { row: 16, frames: 6, fps: 5, native: "left" },
  wave: { row: 17, frames: 5, fps: 6, native: "right" },
  hide: { row: 18, frames: 8, fps: 7, native: "right" },
  down: { row: 19, frames: 1, fps: 1, native: "down" },
  heap: { row: 20, frames: 1, fps: 1, native: "down" },
  bow: { row: 21, frames: 1, fps: 1, native: "right" },
  tiny: { row: 22, frames: 2, fps: 2, native: "down" },
  /* Both from the Chapter 5 sheet: the flattened pancake, and him actually
     asleep in a bed rather than the glow above. The squash's two frames are the
     two directions he can be flattened in (an exact mirror pair, right first),
     not two frames of an animation. */
  squashed: { row: 23, frames: 2, fps: 1, native: "down", directional: true },
  sleep: { row: 24, frames: 4, fps: 2, native: "down" },
} as const satisfies Record<string, GhostClip>;

export interface GhostClipBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* Union of the non-transparent pixels across every frame in each clip. The
   atlas leaves a large transparent ceiling above most drawings so every pose
   can share one anchor; using the whole 84x100 frame as a pointer target makes
   Ralsei clickable far above where he is actually drawn. */
const RALSEI_BOUNDS = {
  idle: { x: 16, y: 52, w: 23, h: 43 },
  "walk-down": { x: 16, y: 52, w: 23, h: 44 },
  "walk-up": { x: 16, y: 52, w: 23, h: 44 },
  "walk-left": { x: 17, y: 52, w: 21, h: 43 },
  "walk-right": { x: 17, y: 52, w: 21, h: 43 },
  shy: { x: 16, y: 52, w: 23, h: 44 },
  appear: { x: 14, y: 53, w: 28, h: 43 },
  spin: { x: 16, y: 52, w: 24, h: 43 },
  sing: { x: 12, y: 52, w: 32, h: 43 },
  aura: { x: 7, y: 50, w: 37, h: 45 },
  cheer: { x: 12, y: 49, w: 32, h: 46 },
  heal: { x: 14, y: 50, w: 47, h: 45 },
  pacify: { x: 13, y: 52, w: 64, h: 43 },
  hat: { x: 14, y: 56, w: 28, h: 39 },
  scarf: { x: 14, y: 52, w: 43, h: 43 },
  hooded: { x: 15, y: 53, w: 26, h: 42 },
  stand: { x: 15, y: 52, w: 26, h: 43 },
  wave: { x: 15, y: 52, w: 26, h: 43 },
  hide: { x: 10, y: 42, w: 32, h: 53 },
  down: { x: 6, y: 73, w: 43, h: 22 },
  heap: { x: 10, y: 54, w: 37, h: 41 },
  bow: { x: 9, y: 66, w: 37, h: 29 },
  tiny: { x: 16, y: 56, w: 25, h: 39 },
  squashed: { x: 4, y: 64, w: 48, h: 31 },
  sleep: { x: 0, y: 21, w: 55, h: 74 },
} as const satisfies Record<keyof typeof RALSEI_CLIPS, GhostClipBounds>;

/* Starwalker, the yellow star person from the Cyber World, who introduces
   himself as "the original star walker". One walk animation covers every
   direction on purpose: he is a flat star with no back to draw. */
const STARWALKER_CLIPS = {
  idle: { row: 0, frames: 1, fps: 1, native: "down" },
  walk: { row: 1, frames: 8, fps: 10, native: "down" },
  /* Turning side-on until he is a sliver, which is how he arrives and leaves. */
  edge: { row: 2, frames: 2, fps: 6, native: "down" },
  final: { row: 3, frames: 1, fps: 1, native: "down" },
  shadow: { row: 4, frames: 1, fps: 1, native: "down" },
} as const satisfies Record<string, GhostClip>;

const STARWALKER_BOUNDS = {
  idle: { x: 2, y: 3, w: 37, h: 36 },
  walk: { x: 5, y: 2, w: 32, h: 37 },
  edge: { x: 2, y: 3, w: 37, h: 36 },
  final: { x: 2, y: 3, w: 37, h: 36 },
  shadow: { x: 2, y: 3, w: 37, h: 36 },
} as const satisfies Record<keyof typeof STARWALKER_CLIPS, GhostClipBounds>;

/* The Annoying Dog. Small, white, and the only one of the three with a real
   front and back, so all four directions are drawn. The frame is 224 tall
   because of the stilts: every other clip is a 19px dog with a lot of
   transparent air above it, which costs nothing to draw. */
const DOG_CLIPS = {
  idle: { row: 0, frames: 1, fps: 1, native: "left" },
  "walk-left": { row: 1, frames: 2, fps: 7, native: "left" },
  "walk-down": { row: 2, frames: 2, fps: 7, native: "down" },
  "walk-up": { row: 3, frames: 2, fps: 7, native: "up" },
  sleep: { row: 4, frames: 1, fps: 1, native: "left" },
  car: { row: 5, frames: 2, fps: 4, native: "left", gait: true },
  maracas: { row: 6, frames: 2, fps: 5, native: "left" },
  stilts: { row: 7, frames: 4, fps: 6, native: "left", gait: true },
  "stilts-long": { row: 8, frames: 4, fps: 6, native: "left", gait: true },
} as const satisfies Record<string, GhostClip>;

const DOG_BOUNDS = {
  idle: { x: 14, y: 203, w: 22, h: 19 },
  "walk-left": { x: 14, y: 203, w: 22, h: 19 },
  "walk-down": { x: 17, y: 203, w: 16, h: 19 },
  "walk-up": { x: 17, y: 203, w: 16, h: 19 },
  sleep: { x: 11, y: 210, w: 27, h: 12 },
  car: { x: 5, y: 180, w: 40, h: 42 },
  maracas: { x: 3, y: 162, w: 44, h: 60 },
  stilts: { x: 15, y: 150, w: 19, h: 72 },
  "stilts-long": { x: 15, y: 2, w: 19, h: 220 },
} as const satisfies Record<keyof typeof DOG_CLIPS, GhostClipBounds>;

export type GhostEffect = "sparkles" | "hearts" | "notes" | "shake" | "dark" | null;

export interface GhostActionSpec {
  kind: string;
  label: string;
  /* The one-shot clip that takes over while the action plays. */
  clip: string;
  effect: GhostEffect;
  /* Plays the clip backwards, which is how "appear" becomes "vanish". */
  reverse?: boolean;
  loops?: number;
  /* Battle-style banner line, the way Deltarune narrates an ACT. */
  caption?: string;
}

/* Sustained clips the owner can park a character in, as opposed to the walk
   cycles the panel picks automatically from movement. Every roster entry opens
   with "auto", which hands the clip back to whatever the movement wants. */
export interface GhostPoseSpec {
  kind: string;
  label: string;
  clip: string | null;
}

const WALK_POSE = { kind: "auto", label: "Walk", clip: null } as const;

export interface GhostCharacter {
  id: string;
  name: string;
  /* One line for the picker, so choosing between them is not guesswork. */
  blurb: string;
  atlas: { file: string; version: number };
  frame: { w: number; h: number };
  /* Where the character's feet sit inside a frame: the point placed exactly on
     the ghost's (x, y) so a position means the same thing for every clip. */
  anchor: { x: number; y: number };
  clips: Record<string, GhostClip>;
  bounds: Record<string, GhostClipBounds>;
  /* Which clip each direction walks in. Characters drawn from one side point
     several directions at the same clip. */
  walk: Record<GhostFacing, string>;
  idle: string;
  poses: readonly GhostPoseSpec[];
  actions: readonly GhostActionSpec[];
  /* Sprite pixels per step. The three are drawn at wildly different sizes (a
     19px dog against a 43px Ralsei), so each carries the size that puts it on a
     page looking like itself rather than a speck or a billboard. */
  scale: { default: number; min: number; max: number };
}

/* The roster. The wire carries the id, and anything unknown falls back to the
   first entry, so a browser on an older build never draws a sprite it has no
   atlas for. */
export const GHOST_CHARACTERS = {
  ralsei: {
    id: "ralsei",
    name: "Ralsei",
    blurb: "Every pose: heals, sings, sleeps, gets squashed.",
    /* Bump the version whenever the picture changes. The service worker serves
       /images/* cache-first with no expiry, so swapping the art under the same
       URL leaves every returning visitor drawing the new frame grid over the old
       sheet, which renders as a pile of sprite fragments. */
    atlas: { file: "ralsei.png", version: 4 },
    frame: { w: 84, h: 100 },
    anchor: { x: 28, y: 95 },
    clips: RALSEI_CLIPS,
    bounds: RALSEI_BOUNDS,
    walk: { down: "walk-down", up: "walk-up", left: "walk-left", right: "walk-right" },
    idle: "idle",
    poses: [
      WALK_POSE,
      { kind: "stand", label: "Stand", clip: "stand" },
      { kind: "wave", label: "Wave", clip: "wave" },
      { kind: "hide", label: "Hide", clip: "hide" },
      { kind: "sing", label: "Sing", clip: "sing" },
      { kind: "bow", label: "Bow", clip: "bow" },
      { kind: "aura", label: "Aura", clip: "aura" },
      { kind: "sleep", label: "Sleep", clip: "sleep" },
      { kind: "hooded", label: "Hooded", clip: "hooded" },
      { kind: "hat", label: "Hat off", clip: "hat" },
      { kind: "tiny", label: "Under the hat", clip: "tiny" },
      { kind: "squashed", label: "Squashed", clip: "squashed" },
      { kind: "down", label: "Knocked out", clip: "down" },
      { kind: "heap", label: "Heap", clip: "heap" },
    ],
    actions: [
      { kind: "heal", label: "Heal Prayer", clip: "heal", effect: "sparkles", caption: "* Ralsei healed you!" },
      { kind: "pacify", label: "Pacify", clip: "pacify", effect: "hearts", caption: "* You feel calm." },
      { kind: "cheer", label: "Cheer", clip: "cheer", effect: "sparkles" },
      { kind: "sing", label: "Sing", clip: "sing", effect: "notes", loops: 3 },
      { kind: "spin", label: "Spin", clip: "spin", effect: null, loops: 3 },
      { kind: "scarf", label: "Scarf whip", clip: "scarf", effect: "shake" },
      { kind: "dark", label: "Dark World", clip: "spin", effect: "dark", loops: 2, caption: "* The world goes dark." },
      { kind: "appear", label: "Appear", clip: "appear", effect: null },
      { kind: "vanish", label: "Vanish", clip: "appear", effect: null, reverse: true },
    ],
    scale: { default: 3, min: 2, max: 6 },
  },
  starwalker: {
    id: "starwalker",
    name: "Starwalker",
    blurb: "The original star walker. Struts, and leaves side-on.",
    atlas: { file: "starwalker.png", version: 2 },
    frame: { w: 42, h: 41 },
    anchor: { x: 21, y: 39 },
    clips: STARWALKER_CLIPS,
    bounds: STARWALKER_BOUNDS,
    walk: { down: "walk", up: "walk", left: "walk", right: "walk" },
    idle: "idle",
    poses: [
      WALK_POSE,
      { kind: "stand", label: "Stand", clip: "idle" },
      { kind: "final", label: "The final one", clip: "final" },
      { kind: "shadow", label: "Shadow", clip: "shadow" },
    ],
    actions: [
      { kind: "shine", label: "Shine", clip: "idle", effect: "sparkles", caption: "* The star is shining." },
      { kind: "strut", label: "Strut", clip: "walk", effect: "notes", loops: 3 },
      { kind: "dark", label: "Dark World", clip: "shadow", effect: "dark", caption: "* The world goes dark." },
      { kind: "appear", label: "Appear", clip: "edge", effect: null, reverse: true },
      { kind: "vanish", label: "Vanish", clip: "edge", effect: null },
    ],
    scale: { default: 3, min: 2, max: 6 },
  },
  dog: {
    id: "dog",
    name: "Annoying Dog",
    blurb: "Small, white, walks all four ways. Drives, shakes maracas, walks on stilts.",
    atlas: { file: "dog.png", version: 5 },
    frame: { w: 50, h: 224 },
    anchor: { x: 25, y: 222 },
    clips: DOG_CLIPS,
    bounds: DOG_BOUNDS,
    /* One side is drawn and mirrored for the other, which is what the clip's
       native facing is for. */
    walk: { down: "walk-down", up: "walk-up", left: "walk-left", right: "walk-left" },
    idle: "idle",
    /* No actions: he is a dog, and the poses are the whole act. */
    poses: [
      WALK_POSE,
      { kind: "sleep", label: "Sleep", clip: "sleep" },
      { kind: "car", label: "Car", clip: "car" },
      { kind: "maracas", label: "Maracas", clip: "maracas" },
      { kind: "stilts", label: "Stilts", clip: "stilts" },
      { kind: "stilts-long", label: "Long stilts", clip: "stilts-long" },
    ],
    actions: [],
    scale: { default: 6, min: 3, max: 12 },
  },
} as const satisfies Record<string, GhostCharacter>;

export type GhostCharacterId = keyof typeof GHOST_CHARACTERS;

export const GHOST_CHARACTER_LIST: readonly GhostCharacter[] = Object.values(GHOST_CHARACTERS);
export const DEFAULT_GHOST_CHARACTER: GhostCharacterId = "ralsei";

export function isGhostCharacter(id: string): id is GhostCharacterId {
  return Object.hasOwn(GHOST_CHARACTERS, id);
}

/** The roster entry to draw. Anything unrecognised is the default rather than
    nothing: a visitor on a cached build must not be left with a blank page
    where the ghost is, and the wire is a plain string. */
export function ghostCharacter(id: string | null | undefined): GhostCharacter {
  return typeof id === "string" && isGhostCharacter(id)
    ? GHOST_CHARACTERS[id]
    : GHOST_CHARACTERS[DEFAULT_GHOST_CHARACTER];
}

export function ghostAtlasUrl(character: GhostCharacter): string {
  return `/images/ghost/${character.atlas.file}?v=${character.atlas.version}`;
}

/* The atlas is a plain grid, so its size follows from the clip table: one row
   per clip, as many columns as the longest clip. */
export function ghostAtlasRows(character: GhostCharacter): number {
  return Math.max(...Object.values(character.clips).map((clip) => clip.row)) + 1;
}

export function ghostAtlasCols(character: GhostCharacter): number {
  return Math.max(...Object.values(character.clips).map((clip) => clip.frames));
}

export function isGhostClip(character: GhostCharacter, name: string): boolean {
  return Object.hasOwn(character.clips, name);
}

/** The clip that will actually be drawn. Clip names are per character and the
    wire can still be carrying the previous one for a tick after a switch, so an
    unknown name resolves to standing still rather than to a missing row. */
export function resolveGhostClip(character: GhostCharacter, name: string): string {
  return isGhostClip(character, name) ? name : character.idle;
}

export function ghostClip(character: GhostCharacter, name: string): GhostClip {
  return character.clips[resolveGhostClip(character, name)];
}

export function ghostClipBounds(character: GhostCharacter, name: string): GhostClipBounds {
  return character.bounds[resolveGhostClip(character, name)];
}

/** The drawn scale for one viewer, never wider than the ratio above. The floor
    of 1 wins on a screen too narrow to honour the cap, since a sprite scaled
    below its own pixels is not worth showing. */
export function fitGhostScale(character: GhostCharacter, scale: number, viewportWidth: number): number {
  if (!Number.isFinite(scale)) return 1;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return scale;
  return Math.max(1, Math.min(scale, (viewportWidth * GHOST_MAX_WIDTH_RATIO) / character.frame.w));
}

/* How far above the feet a speech bubble hangs, in drawn pixels. Measured from
   the clip's painted pixels rather than the frame: the frame is mostly
   transparent padding above the head, and clearing that leaves the bubble
   floating half a sprite too high. Clips differ a lot here (asleep is tall,
   knocked out is a heap), so this follows whatever the character is doing. */
export function ghostBubbleLift(character: GhostCharacter, name: string, scale: number): number {
  return (character.anchor.y - ghostClipBounds(character, name).y + 4) * scale;
}

export function ghostHitboxRect(
  character: GhostCharacter,
  name: string,
  scale: number,
  flipped: boolean,
): GhostClipBounds {
  const bounds = ghostClipBounds(character, name);
  return {
    x: (flipped ? character.anchor.x - bounds.x - bounds.w : bounds.x - character.anchor.x) * scale,
    y: (bounds.y - character.anchor.y) * scale,
    w: bounds.w * scale,
    h: bounds.h * scale,
  };
}

/* Mirroring is only ever needed when a clip is drawn facing the way it was not
   painted. Ralsei's two walk cycles ship as real art, so neither is ever
   mirrored; the dog's one side is. */
export function shouldFlipGhostClip(character: GhostCharacter, name: string, facing: GhostFacing): boolean {
  const native = ghostClip(character, name).native;
  if (native === "right") return facing === "left";
  if (native === "left") return facing === "right";
  return false;
}

/* A pose with more than one frame keeps cycling while the character stands
   still; a single frame one, a pair that is really two directions, and a gait
   are just held. */
export function isLoopingGhostPose(character: GhostCharacter, name: string): boolean {
  const clip = ghostClip(character, name);
  return clip.frames > 1
    && !clip.directional
    && !clip.gait
    && character.poses.some((pose) => pose.clip === name);
}

/** Whether a clip's frames are steps, so they only advance while he moves. A
    pose that is one keeps the movement flag alive on the wire, which a held
    pose otherwise clears. */
export function isGhostGait(character: GhostCharacter, name: string): boolean {
  return ghostClip(character, name).gait === true;
}

/* Which drawing a two-sided clip should show, or null when the clip is a real
   animation and the frame comes from the clock instead. */
export function directionalGhostFrame(character: GhostCharacter, name: string, facing: GhostFacing): number | null {
  if (!ghostClip(character, name).directional) return null;
  return facing === "left" ? 1 : 0;
}

export function findGhostPose(character: GhostCharacter, kind: string): GhostPoseSpec | null {
  return character.poses.find((pose) => pose.kind === kind) ?? null;
}

export function findGhostAction(character: GhostCharacter, kind: string): GhostActionSpec | null {
  return character.actions.find((action) => action.kind === kind) ?? null;
}

/** Every action kind on the roster, which is what the sound layer keys its cues
    off. Kinds are shared where the cue should be (every character's "vanish"
    sounds the same). */
export const GHOST_ACTION_KINDS: readonly string[] = [
  ...new Set(GHOST_CHARACTER_LIST.flatMap((character) => character.actions.map((action) => action.kind))),
];

/* Where (x, y) is measured against.

   "page" is the original: he stands in the document like a character in a room,
   so parking him beside someone's avatar keeps him there while they scroll, and
   he can be somewhere they have not scrolled to yet. That only means the same
   thing to viewers whose layout matches the one being aimed at.

   "screen" measures against the visible window instead, which puts him in the
   same spot for everyone regardless of layout or scroll position. It is the
   honest choice for an audience of everyone, where there is no single layout to
   aim at. */
export type GhostAnchor = "page" | "screen";

export interface GhostVisual {
  /* Normalized: x across the width, y down the height of whatever the anchor
     below measures against. */
  x: number;
  y: number;
  anchor: GhostAnchor;
  /* Which roster entry is on screen. A plain string on the wire: an id from a
     newer build resolves to the default rather than breaking the overlay. */
  character: string;
  clip: string;
  facing: GhostFacing;
  moving: boolean;
  scale: number;
  speech: { id: number; text: string } | null;
  action: { id: number; kind: string } | null;
}

export interface GhostAudience {
  mode: "everyone" | "user" | "none";
  userId?: number;
}

export interface GhostSessionState {
  route: string;
  audience: GhostAudience;
  visual: GhostVisual;
  seq: number;
  updatedAt: number;
  ownerUserId: number | null;
}

export interface GhostPresenceViewer {
  id: string;
  route: string;
  userId: number | null;
  username: string | null;
  viewport: { w: number; h: number } | null;
  connectedAt: number;
  showing: boolean;
}

export interface GhostPresenceRoute {
  route: string;
  viewers: number;
  named: number;
  showing: number;
  /* How many of them are on a phone-width screen, so the panel can say whether
     one placement can serve the whole page at once. */
  narrow: number;
  viewport: { w: number; h: number } | null;
}

/* Counts for everyone, identities only for the people who can be aimed at. With
   a few hundred pages open the full roster would be a list nobody can read and
   a payload nobody needs, every three seconds. */
export interface GhostPresence {
  routes: GhostPresenceRoute[];
  viewers: GhostPresenceViewer[];
  totals: { viewers: number; named: number; routes: number; showing: number };
  truncated: boolean;
}

/* A viewer talking back. Nothing about this is stored: it reaches the owner's
   open panel and a short in-memory buffer, and dies with the process. */
export interface GhostReply {
  id: number;
  at: number;
  route: string;
  userId: number | null;
  username: string | null;
  text: string;
}

export const GHOST_REPLY_MAX_LENGTH = 200;

export const EMPTY_GHOST_PRESENCE: GhostPresence = {
  routes: [],
  viewers: [],
  totals: { viewers: 0, named: 0, routes: 0, showing: 0 },
  truncated: false,
};

export const DEFAULT_GHOST_VISUAL: GhostVisual = {
  x: 0.5,
  y: 0.72,
  anchor: "page",
  character: DEFAULT_GHOST_CHARACTER,
  clip: "idle",
  facing: "down",
  moving: false,
  scale: 3,
  speech: null,
  action: null,
};

const ROUTE_PATTERN = /^\/[\w\-./%]*$/;
const MAX_ROUTE_LENGTH = 200;

/* Lowercased pathname, no query or hash, no trailing slash; a `/*` suffix is
   kept so a session can cover a section. Mirrors normalizeGhostRoute in
   live-backend/src/live/ghost.ts. */
export function normalizeGhostRoute(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  value = value.split("#")[0].split("?")[0];
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.toLowerCase().replace(/\/{2,}/g, "/");
  const wildcard = value.endsWith("/*");
  if (wildcard) value = value.slice(0, -2) || "/";
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  if (value.length > MAX_ROUTE_LENGTH || !ROUTE_PATTERN.test(value)) return null;
  return wildcard ? `${value === "/" ? "" : value}/*` : value;
}

export function matchesGhostRoute(pattern: string, route: string): boolean {
  if (pattern === route) return true;
  if (!pattern.endsWith("/*")) return false;
  const prefix = pattern.slice(0, -2);
  if (prefix === "") return true;
  return route === prefix || route.startsWith(`${prefix}/`);
}

/* Which clip a walking ghost should be in. Standing still on a walk cycle is
   its first frame, so the wire format never needs a per-direction idle clip. */
export function walkClipFor(character: GhostCharacter, facing: GhostFacing): string {
  return character.walk[facing];
}

/* Deltarune pacing: a deliberate walk, and a run on Shift that is about twice
   as fast. Both are fractions of the visible screen per second, converted to
   page fractions by the caller (a long page must not make him teleport). */
export const GHOST_WALK_SPEED = 0.17;
export const GHOST_SPRINT_SPEED = 0.38;

/* One movement step, as a change in page fractions. x is a fraction of the page
   width and y a fraction of its whole height, so the two axes need different
   conversions to cover the same pixels: without that he walks down at the
   screen's aspect ratio and slower still on a long page. */
export function ghostMoveStep(
  input: { dx: number; dy: number },
  options: { sprinting: boolean; dt: number; viewWidth: number; pageHeight: number },
): { dx: number; dy: number } {
  const length = Math.hypot(input.dx, input.dy) || 1;
  const step = (options.sprinting ? GHOST_SPRINT_SPEED : GHOST_WALK_SPEED) * options.dt;
  return {
    dx: (input.dx / length) * step,
    dy: (input.dy / length) * step * (options.viewWidth / Math.max(1, options.pageHeight)),
  };
}

/* Sideways the page has no edges: walking off the right brings him back on the
   left. Only x wraps, because the top and bottom of a page are real places and
   falling off them would just lose him. */
export function wrapGhostX(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  /* Anything already on the page is left exactly alone: the modulo round trip
     below is lossy in binary floating point, and a position that drifts by a
     hair every frame is a position that never settles. */
  if (value >= 0 && value < 1) return value;
  return ((value % 1) + 1) % 1;
}

/** The shorter way round from one x to another. Following a wrap without this
    slides him back across the whole page instead of over the edge, and any
    move of more than half a page takes the outside route. */
export function ghostWrapDelta(from: number, to: number): number {
  const delta = to - from;
  if (delta > 0.5) return delta - 1;
  if (delta < -0.5) return delta + 1;
  return delta;
}

/* Keeps him inside a comfortable band of the stage and never scrolls past the
   ends of the page, which is what makes walking down feel like a camera
   following him rather than him leaving the frame. */
export function followGhostCamera(current: number, targetPx: number, viewHeight: number, pageHeight: number): number {
  const limit = Math.max(0, pageHeight - viewHeight);
  const band = Math.min(viewHeight * 0.3, viewHeight / 2);
  let next = current;
  if (targetPx < current + band) next = targetPx - band;
  else if (targetPx > current + viewHeight - band) next = targetPx - viewHeight + band;
  return Math.max(0, Math.min(limit, next));
}

export function ghostSpeechDurationMs(text: string): number {
  return Math.min(16_000, Math.max(3_500, 1_400 + text.length * 90));
}
