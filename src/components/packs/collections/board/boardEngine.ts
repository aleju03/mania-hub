import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";

/* The shared card board's drawing and input, kept out of React: the table can
   hold hundreds of thousands of cards and a brush stroke adds dozens a
   second, so nothing here goes through state or the DOM.

   The table is cut into square regions (the same ones the backend stores),
   loaded as they come into view and kept up to date from the live stream.

   What keeps it cheap:
   - Each tier is painted once per size into a sprite (gradient, rim and
     shadow baked in), and a card is one drawImage of its sprite. Nothing is
     stroked, filled or blurred per card.
   - Frames are drawn on request only, at most one per animation frame, and
     never while the board is off screen.
   - Close up, the settled cards live in a cached layer the size of the view.
     A card laid on top is drawn onto that layer on its own; only moving the
     view or a change under other cards repaints it, and that pass skips every
     region outside the view.
   - Far out, the board does not load cards at all: each region comes as a
     small colour grid (the tier of the top card in every half-card cell, a
     few hundred bytes), drawn as one image. Cards load only once the view is
     close enough to touch them, which is also the only distance edits work
     at.
   - Close up, cards show their real face (the collection's own thumbnail,
     see boardFaces.ts); a little further out a light stand-in of avatar and
     name; further still the bare tier sprite. Faces are only asked for once
     a card is drawn big enough to read, so a far view never loads one. */

export const CARD_W = 64;
export const CARD_H = 90;
export const REGION = 2048;
const REGIONS_PER_SIDE = 32;
const HALF = REGIONS_PER_SIDE / 2;
const TURN = Math.PI * 2;
/* Below this zoom the view is drawn from region images. */
const TILE_ZOOM = 0.09;
/* Region image pixels per board unit, and the margin it keeps for cards
   that reach over the region's edge. */
const TILE_SCALE = 0.1;
const TILE_MARGIN = 160;
const TILE_LIMIT = 220;
/* The zoomed-out colour grid: cells per region side, cell size in board
   units, and the margin of cells round it (backend regionPreview). */
const PREVIEW_CELLS = 64;
const PREVIEW_MARGIN = 2;
const PREVIEW_CELL = REGION / PREVIEW_CELLS;
/* Tier order of the grid's values, 1-based (backend TIERS). */
const PREVIEW_TIERS = ["common", "rare", "elite", "superRare", "ultraRare", "legendary", "mythic", "ascendant", "worldClass", "goat", "eternal"];
const REGION_LIMIT = 260;

export const angleOf = (r: number) => (r / 256) * TURN;
export const scaleOf = (s: number) => 2 ** ((s - 128) / 64);
export const rotByte = (angle: number) => (((Math.round((angle / TURN) * 256) % 256) + 256) % 256);
export const scaleByte = (scale: number) => Math.min(255, Math.max(0, Math.round(128 + 64 * Math.log2(scale))));

export function regionOf(x: number, y: number): number {
  const rx = Math.min(REGIONS_PER_SIDE - 1, Math.max(0, Math.floor(x / REGION) + HALF));
  const ry = Math.min(REGIONS_PER_SIDE - 1, Math.max(0, Math.floor(y / REGION) + HALF));
  return rx * REGIONS_PER_SIDE + ry;
}

export function regionOrigin(region: number): [number, number] {
  return [(Math.floor(region / REGIONS_PER_SIDE) - HALF) * REGION, ((region % REGIONS_PER_SIDE) - HALF) * REGION];
}

export const EXTENT = HALF * REGION;
const clampCoord = (value: number) => Math.min(EXTENT - 1, Math.max(-EXTENT, Math.round(value)));

export interface BoardCardFace {
  key: string;
  tier: string | null;
  name: string;
}

export interface BoardCard extends BoardCardFace {
  owner: number;
  ownerName: string;
  n: number;
  z: number;
  x: number;
  y: number;
  r: number;
  s: number;
  /* A palette colour laid over the card (TINTS, 1-based), 0 for none. */
  tint: number;
  /* Derived from r and s, kept so a frame does no trigonometry. */
  cos: number;
  sin: number;
  sc: number;
}

export function makeCard(fields: Omit<BoardCard, "cos" | "sin" | "sc">): BoardCard {
  const card = { ...fields, cos: 1, sin: 0, sc: 1 };
  refresh(card);
  return card;
}

function refresh(card: BoardCard) {
  const angle = angleOf(card.r);
  card.cos = Math.cos(angle);
  card.sin = Math.sin(angle);
  card.sc = scaleOf(card.s);
}

/* An edit as the backend takes it. */
export type BoardOp =
  | ["a", number, string, number, number, number, number, number]
  | ["u", number, number, number, number, number, 0 | 1, number]
  | ["d", number];

interface CardState {
  face: BoardCardFace;
  x: number;
  y: number;
  r: number;
  s: number;
  tint: number;
}

/* The tint palette: what the brush paints with on top of the tier colours.
   A card keeps its tint as a number (backend PACK_BOARD_TINTS), so the order
   is fixed: add colours at the end only. */
export const TINTS = [
  "#ffffff", "#c7c9d1", "#8a8d99", "#4a4d57", "#1c1d22",
  "#ff4d4d", "#c81e3a", "#7a1424", "#ff8a2a", "#ffb35c",
  "#ffe14d", "#fff3a8", "#9be15d", "#3fbf5a", "#1f7a45",
  "#0f3d2a", "#2fd6c2", "#1aa3b0", "#6fc8ff", "#2f7dff",
  "#1e3fa8", "#142166", "#9b6bff", "#6a3fd1", "#3b1f7a",
  "#ff7ac8", "#e0409b", "#ffc2e2", "#f2c49b", "#c98a5e",
  "#8a5530", "#4d2e1a",
];

/* One undoable step: each of the viewer's cards it touched, before and after
   (null for not on the board). */
interface Change {
  n: number;
  before: CardState | null;
  after: CardState | null;
  /* For a brush card: already handed to the host mid-stroke. */
  sent?: boolean;
}

/* ---------- sprites ---------- */

interface TierPaint {
  light: string;
  mid: string;
  dark: string;
}

const paints = new Map<string, TierPaint>();
export function tierPaint(tier: string | null): TierPaint {
  const name = tier && tier in MANIA_TIER_STYLES ? tier : "common";
  let paint = paints.get(name);
  if (!paint) {
    const hexes = MANIA_TIER_STYLES[name as ManiaCardTier].badgeGradient.match(/#[0-9a-f]{6}/gi) ?? ["#cbd5e1", "#64748b", "#1e293b"];
    paint = { light: hexes[0], mid: hexes[1], dark: hexes[hexes.length - 1] };
    paints.set(name, paint);
  }
  return paint;
}

/* A tint as a card paint: the colour itself in the middle, lighter at the
   lit corner and darker at the far one. */
function tintPaint(tint: number): TierPaint {
  const id = `tint:${tint}`;
  let paint = paints.get(id);
  if (!paint) {
    const [r, g, b] = hexRgb(TINTS[tint - 1] ?? "#888888");
    const mixTo = (target: number, amount: number) => `rgb(${[r, g, b].map((c) => Math.round(c + (target - c) * amount)).join(",")})`;
    paint = { light: mixTo(255, 0.45), mid: TINTS[tint - 1] ?? "#888888", dark: mixTo(0, 0.6) };
    paints.set(id, paint);
  }
  return paint;
}

export function cardPaint(card: { tier: string | null; tint: number }): TierPaint {
  return card.tint ? tintPaint(card.tint) : tierPaint(card.tier);
}

/* Sprite widths in device pixels. A card is drawn from the smallest one at
   least as wide as it is on screen, so scaling only ever shrinks a sprite. */
const LODS = [12, 24, 48, 96, 192];

interface Sprite {
  canvas: HTMLCanvasElement;
  /* Sprite pixels per board unit. */
  ppu: number;
  pad: number;
}

const sprites = new Map<string, Sprite>();
function sprite(card: { tier: string | null; tint: number }, lod: number): Sprite {
  const id = `${card.tint ? `tint:${card.tint}` : card.tier ?? ""}:${lod}`;
  let made = sprites.get(id);
  if (made) return made;
  const paint = cardPaint(card);
  const w = lod;
  const h = Math.round((lod * CARD_H) / CARD_W);
  const pad = Math.ceil(lod * 0.14);
  const canvas = document.createElement("canvas");
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  const g = canvas.getContext("2d")!;
  g.translate(pad, pad);
  const radius = w * 0.1;
  const fill = g.createLinearGradient(0, 0, w * 0.7, h);
  fill.addColorStop(0, paint.light);
  fill.addColorStop(0.5, paint.mid);
  fill.addColorStop(1, paint.dark);
  if (lod >= 24) {
    g.shadowColor = "rgba(0,0,0,0.5)";
    g.shadowBlur = w * 0.09;
    g.shadowOffsetY = w * 0.04;
  }
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(0, 0, w, h, radius);
  g.fill();
  g.shadowColor = "transparent";
  if (lod >= 24) {
    // the art window and the light catching the top edge
    g.fillStyle = "rgba(0,0,0,0.2)";
    g.beginPath();
    g.roundRect(w * 0.09, h * 0.07, w * 0.82, h * 0.58, radius * 0.6);
    g.fill();
    const shine = g.createLinearGradient(0, 0, 0, h * 0.4);
    shine.addColorStop(0, "rgba(255,255,255,0.28)");
    shine.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = shine;
    g.beginPath();
    g.roundRect(0, 0, w, h * 0.4, [radius, radius, 0, 0]);
    g.fill();
  }
  g.strokeStyle = "rgba(255,255,255,0.4)";
  g.lineWidth = Math.max(0.75, w / 70);
  g.beginPath();
  g.roundRect(0.5, 0.5, w - 1, h - 1, radius);
  g.stroke();
  made = { canvas, ppu: w / CARD_W, pad };
  sprites.set(id, made);
  return made;
}

/* A soft card-shaped shadow, for under a real face. Board units of margin
   round the card. */
const SHADOW_PAD = 6;
/* Black for an untinted card; a tinted one glows in its colour. */
const shadows = new Map<string, HTMLCanvasElement>();
function shadow(lod: number, tint = 0): HTMLCanvasElement {
  const id = `${lod}:${tint}`;
  let made = shadows.get(id);
  if (made) return made;
  const ppu = lod / CARD_W;
  made = document.createElement("canvas");
  made.width = Math.ceil((CARD_W + SHADOW_PAD * 2) * ppu);
  made.height = Math.ceil((CARD_H + SHADOW_PAD * 2) * ppu);
  const g = made.getContext("2d")!;
  if (tint) {
    // a halo only: the card shape is drawn far off the canvas and just its
    // blur is shifted back in, so no solid edge can show past the card
    const away = made.width * 4;
    g.shadowColor = TINTS[tint - 1] ?? "#000000";
    g.shadowBlur = 5 * ppu;
    g.shadowOffsetX = away;
    g.fillStyle = "#000";
    g.beginPath();
    g.roundRect(SHADOW_PAD * ppu - away, SHADOW_PAD * ppu, CARD_W * ppu, CARD_H * ppu, 6 * ppu);
    g.fill();
  } else {
    g.shadowColor = "rgba(0,0,0,0.55)";
    g.shadowBlur = 4 * ppu;
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.beginPath();
    g.roundRect(SHADOW_PAD * ppu, SHADOW_PAD * ppu, CARD_W * ppu, CARD_H * ppu, 6 * ppu);
    g.fill();
  }
  shadows.set(id, made);
  return made;
}

/* ---------- engine ---------- */

export type BoardTool = "move" | "brush";

export interface BoardEngineOptions {
  /* The viewer's user id when they can lay cards down, else null. */
  me: number | null;
  /* Admins can select anyone's card, to take it off. */
  canModerate?: boolean;
  /* Hands the brush its next card, or null when there is none left to deal. */
  takeCard?: () => BoardCardFace | null;
  /* Asks the host for these regions' cards; it answers with setRegion. */
  loadRegions: (ids: number[]) => void;
  /* Asks the host for these regions' colour grids; it answers with setPreview. */
  loadPreviews: (ids: number[]) => void;
  /* Whether the view is too far out to edit, each time that changes. */
  onFarChange?: (far: boolean) => void;
  /* Every edit the viewer makes, in order, to send to the backend. */
  onOps?: (ops: BoardOp[]) => void;
  /* Whether the viewer's card n has edits the backend has not answered yet:
     those keep their local state when a region is read again. */
  isPending?: (n: number) => boolean;
  /* The selected cards: the viewer's own (one or many), or for an admin
     somebody else's single card. */
  onSelect?: (cards: BoardCard[]) => void;
  onHover?: (card: BoardCard | null, clientX: number, clientY: number) => void;
  onHistory?: (canUndo: boolean, canRedo: boolean) => void;
  /* A card the brush or tray did not lay down, and why: it would cover
     someone's day-old drawing, or the viewer is going faster than allowed. */
  onRefused?: (why: "protected" | "slow") => void;
  /* The view moved or zoomed. */
  onView?: () => void;
  /* Where on the board the pointer is, in board units, as it moves; null
     when it leaves. */
  onPointerAt?: (point: [number, number] | null) => void;
  /* The real face for a card and when it arrived, once loaded; null to draw
     the tier sprite. */
  face?: (card: BoardCard) => { image: CanvasImageSource; at: number } | null;
}

/* The real face fades in over a band of on-screen widths (device pixels),
   from the tier sprite at FACE_FROM to the full card at FACE_FULL, and over
   FACE_FADE_MS when it first arrives, so neither zooming nor loading ever
   swaps one look for the other in a single frame. */
const FACE_FROM = 44;
const FACE_FULL = 76;
const FACE_FADE_MS = 260;
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

interface Region {
  id: number;
  version: number;
  cards: BoardCard[];
  tile: HTMLCanvasElement | null;
  tileDirty: boolean;
}

type Brush = { kind: "brush"; lastX: number; lastY: number; carry: number; changes: Change[] };
type Gesture =
  | { kind: "pan"; startX: number; startY: number; camX: number; camY: number }
  | { kind: "drag"; cards: { card: BoardCard; before: CardState }[]; lastX: number; lastY: number; moved: boolean }
  | { kind: "marquee"; additive: boolean }
  | { kind: "turn"; card: BoardCard; before: CardState; startAngle: number; startR: number }
  | { kind: "size"; card: BoardCard; before: CardState; startDist: number; startS: number }
  | Brush
  | { kind: "pinch"; dist: number; midX: number; midY: number; camX: number; camY: number; z: number };

const HISTORY_LIMIT = 60;
/* Cards a minute (backend PACK_BOARD_RATE). */
const RATE = 300;
const HANDLE = 7;
const TURN_REACH = 22;

export class BoardEngine {
  tool: BoardTool = "move";
  /* The brush; its tint also colours cards laid from the tray. */
  brush = { scale: 0.7, follow: false, tint: 0 };
  cam = { x: 0, y: 0, z: 0.5 };

  private regions = new Map<number, Region>();
  /* Regions with cards on the server, and their versions. */
  private overview = new Map<number, number>();
  private requested = new Map<number, number>();
  private previews = new Map<number, { version: number; image: HTMLCanvasElement }>();
  private previewsRequested = new Map<number, number>();
  private far = false;
  /* The viewer's own cards in the loaded regions, by their number. */
  private own = new Map<number, BoardCard>();
  private nextN = 1;
  private topZ = 0;
  /* Stacking numbers from here up are under a day old (backend
     packBoardFreshFrom); other players' cards that new count as protected. */
  private freshFrom = Infinity;
  /* The viewer's own card allowance, mirroring the backend's
     PACK_BOARD_RATE, so the brush paces itself instead of being refused. */
  private tokens = RATE;
  private tokensAt = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly layer = document.createElement("canvas");
  private readonly lg: CanvasRenderingContext2D;
  private layerDirty = true;
  /* The cards in view, sorted by stacking order, and what they were for. */
  private drawList: BoardCard[] = [];
  private drawListFor = "";
  private generation = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private frame = 0;
  private loadTimer = 0;
  private visible = true;
  /* Cards in hand (dragged, turned or resized), drawn over the cached layer. */
  private active: BoardCard[] = [];
  private selection = new Set<BoardCard>();
  /* The box being dragged out to select with, in board units. */
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private spaceHeld = false;
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  /* True until the view is first moved by hand: until then a resize (the
     layout settling, a rotated phone) fits the board again. */
  private pristine = true;
  private fitTarget: (() => void) | null = null;
  /* The regions the last fit was asked for, while the view still sits where
     that fit put it: when one of them loads, the fit is redone on its cards
     (it could only use the region's outline before). */
  private fitRegions: number[] | null = null;
  /* Set while a face is part way through fading in: keeps frames coming. */
  private fading = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, private readonly options: BoardEngineOptions) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d")!;
    this.lg = this.layer.getContext("2d")!;

    const resize = new ResizeObserver(() => this.resize());
    resize.observe(canvas);
    const seen = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      if (this.visible) this.request();
    });
    seen.observe(canvas);
    this.cleanup.push(() => resize.disconnect(), () => seen.disconnect());

    this.listen(canvas, "pointerdown", (e) => this.down(e as PointerEvent));
    this.listen(canvas, "pointermove", (e) => this.move(e as PointerEvent));
    this.listen(canvas, "pointerup", (e) => this.up(e as PointerEvent));
    this.listen(canvas, "pointercancel", (e) => this.up(e as PointerEvent));
    this.listen(canvas, "pointerleave", () => {
      this.options.onHover?.(null, 0, 0);
      this.options.onPointerAt?.(null);
    });
    this.listen(canvas, "wheel", (e) => this.wheel(e as WheelEvent), { passive: false });
    this.listen(canvas, "contextmenu", (e) => e.preventDefault());
    this.listen(canvas, "keydown", (e) => this.key(e as KeyboardEvent));
    this.listen(canvas, "keyup", (e) => {
      if ((e as KeyboardEvent).code === "Space") this.spaceHeld = false;
    });
    this.resize();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.loadTimer);
    for (const run of this.cleanup) run();
  }

  /* ---------- data in ---------- */

  /* Which regions have cards and their versions; loads whatever in view is
     missing or behind. */
  setOverview(regions: Iterable<[number, number]>) {
    this.overview = new Map(regions);
    for (const id of [...this.regions.keys()]) {
      if (!this.overview.has(id) && !this.hasPendingIn(id)) this.dropRegion(id);
    }
    for (const id of [...this.previews.keys()]) if (!this.overview.has(id)) this.previews.delete(id);
    this.touch();
    this.scheduleLoad();
  }

  /* A region changed on the server. `ours` is the answer to the viewer's own
     save: when nothing else happened in between, the region is already up to
     date here and needs no read. */
  noteVersion(id: number, version: number, ours = false) {
    const region = this.regions.get(id);
    if (ours && region && region.version === version - 1) region.version = version;
    if ((this.overview.get(id) ?? -1) < version) this.overview.set(id, version);
    this.scheduleLoad();
  }

  /* Regions the host could not read, so they are asked for again later. */
  forgetRequests(ids: number[]) {
    for (const id of ids) {
      this.requested.delete(id);
      this.previewsRequested.delete(id);
    }
  }

  /* Reads every loaded region again: after an edit the backend refused, so
     the viewer's cards go back to where the server has them. */
  reloadLoaded() {
    for (const region of this.regions.values()) region.version = -1;
    this.requested.clear();
    this.scheduleLoad();
  }

  /* A region's colour grid, painted once into an image the size of the grid. */
  setPreview(id: number, version: number, cells: Uint8Array) {
    this.previewsRequested.delete(id);
    const held = this.previews.get(id);
    if (held && held.version >= version) return;
    const side = PREVIEW_CELLS + PREVIEW_MARGIN * 2;
    if (cells.length !== side * side) return;
    const image = held?.image ?? document.createElement("canvas");
    image.width = side;
    image.height = side;
    const g = image.getContext("2d")!;
    const pixels = g.createImageData(side, side);
    const colours = previewColours();
    for (let i = 0; i < cells.length; i++) {
      const colour = colours[cells[i]];
      if (!colour) continue;
      pixels.data.set(colour, i * 4);
      pixels.data[i * 4 + 3] = 255;
    }
    g.putImageData(pixels, 0, 0);
    this.previews.set(id, { version, image });
    if (this.cam.z < TILE_ZOOM) this.invalidate();
  }

  /* Repaints everything, for a face that just loaded. */
  repaint() {
    this.invalidate();
  }

  /* Whether the view is too far out to touch cards. */
  get isFar() {
    return this.cam.z < TILE_ZOOM;
  }

  setRegion(id: number, version: number, cards: BoardCard[]) {
    this.requested.delete(id);
    const held = this.regions.get(id);
    if (held && held.version > version) return;
    const me = this.options.me;
    const pending = (n: number) => this.options.isPending?.(n) ?? false;
    const list: BoardCard[] = [];
    const ownHere = new Set<number>();
    for (const card of cards) {
      this.topZ = Math.max(this.topZ, card.z);
      if (me == null || card.owner !== me) {
        list.push(card);
        continue;
      }
      ownHere.add(card.n);
      this.nextN = Math.max(this.nextN, card.n + 1);
      const local = this.own.get(card.n);
      // in hand right now, or with edits not answered yet: the local one wins
      if (local && (this.active.includes(local) || pending(card.n))) continue;
      if (local && this.selection.has(local)) {
        Object.assign(local, { x: card.x, y: card.y, r: card.r, s: card.s, z: card.z });
        refresh(local);
        list.push(local);
      } else {
        this.own.set(card.n, card);
        list.push(card);
      }
    }
    if (me != null) {
      for (const [n, card] of this.own) {
        if (this.active.includes(card) || regionOf(card.x, card.y) !== id) continue;
        if (pending(n)) {
          list.push(card);
        } else if (!ownHere.has(n)) {
          // the server no longer has it here (moved elsewhere, or taken off)
          this.own.delete(n);
          this.unselect(card);
        }
      }
    }
    list.sort((a, b) => a.z - b.z);
    this.regions.set(id, { id, version, cards: list, tile: null, tileDirty: true });
    if (this.fitRegions?.includes(id)) this.fitTarget?.();
    this.overview.set(id, Math.max(this.overview.get(id) ?? 0, version));
    this.trimRegions();
    this.touch();
  }

  /* The stacking order the backend gave one of the viewer's adds or lifts. */
  ack(n: number, z: number) {
    const card = this.own.get(n);
    if (!card || card.z === z) return;
    card.z = z;
    this.topZ = Math.max(this.topZ, z);
    const region = this.regions.get(regionOf(card.x, card.y));
    if (region) region.cards.sort((a, b) => a.z - b.z);
    this.generation++;
  }

  /* One of the viewer's cards the backend took off (a recycled copy). */
  dropOwn(n: number) {
    const card = this.own.get(n);
    if (!card) return;
    this.own.delete(n);
    this.detach(card);
    this.unselect(card);
    this.touch();
  }

  setFreshFrom(z: number) {
    this.freshFrom = z;
  }

  /* Whether a card laid here would cover another player's fresh cards, judged
     on the loaded regions round it (the backend has the final say). */
  private coversFresh(x: number, y: number, r: number, s: number): boolean {
    if (this.freshFrom === Infinity) return false;
    const probe = { x, y, r, s };
    const rx = Math.floor(x / REGION) + HALF, ry = Math.floor(y / REGION) + HALF;
    for (let ix = rx - 1; ix <= rx + 1; ix++) {
      for (let iy = ry - 1; iy <= ry + 1; iy++) {
        const region = this.regions.get(ix * REGIONS_PER_SIDE + iy);
        if (!region) continue;
        for (const card of region.cards) {
          if (card.owner !== this.options.me && card.z >= this.freshFrom && overlaps(probe, card)) return true;
        }
      }
    }
    return false;
  }

  private takeToken(): boolean {
    const now = performance.now();
    this.tokens = Math.min(RATE, this.tokens + ((now - this.tokensAt) / 60_000) * RATE);
    this.tokensAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  setNextN(n: number) {
    this.nextN = Math.max(this.nextN, n);
  }

  get selectedCards(): BoardCard[] {
    return [...this.selection];
  }

  /* The one selected card, when exactly one is: the one with handles. */
  private get selected(): BoardCard | null {
    return this.selection.size === 1 ? this.selection.values().next().value! : null;
  }

  /* ---------- view ---------- */

  /* Fits these regions (the viewer's cards, say), or every region with cards,
     or the middle of the table. */
  fit(regions?: number[]) {
    const run = () => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const take = (x0: number, y0: number, x1: number, y1: number) => {
        minX = Math.min(minX, x0);
        minY = Math.min(minY, y0);
        maxX = Math.max(maxX, x1);
        maxY = Math.max(maxY, y1);
      };
      for (const id of regions?.length ? regions : this.overview.keys()) {
        const loaded = this.regions.get(id);
        if (loaded?.cards.length) {
          for (const card of loaded.cards) {
            if (regions?.length && card.owner !== this.options.me) continue;
            take(card.x - 55 * card.sc, card.y - 55 * card.sc, card.x + 55 * card.sc, card.y + 55 * card.sc);
          }
        } else {
          const [ox, oy] = regionOrigin(id);
          take(ox, oy, ox + REGION, oy + REGION);
        }
      }
      if (minX === Infinity) {
        this.cam = { x: 0, y: 0, z: 0.5 };
      } else {
        const z = Math.min(1.2, (this.width || 800) / (maxX - minX + 120), (this.height || 500) / (maxY - minY + 120));
        this.cam = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: clampZoom(z) };
      }
      this.invalidate();
      this.scheduleLoad();
    };
    this.fitTarget = run;
    this.fitRegions = regions?.length ? regions : null;
    run();
  }

  /* Moves the view to a spot (board units), at a zoom if given. */
  goTo(x: number, y: number, z?: number) {
    this.pristine = false;
    this.fitRegions = null;
    this.fitTarget = null;
    this.cam = { x: clampCoord(x), y: clampCoord(y), z: z ? clampZoom(z) : this.cam.z };
    this.invalidate();
    this.scheduleLoad();
  }

  zoomBy(factor: number) {
    this.pristine = false;
    this.fitRegions = null;
    this.cam.z = clampZoom(this.cam.z * factor);
    this.invalidate();
    this.scheduleLoad();
  }

  /* ---------- edits ---------- */

  /* Puts a card on the board at a point on screen, or the middle of the view. */
  addCard(face: BoardCardFace, clientX?: number, clientY?: number) {
    if (this.options.me == null || this.cam.z < TILE_ZOOM) return;
    const [x, y] = clientX == null || clientY == null
      ? [this.cam.x + ((Math.random() - 0.5) * 40) / this.cam.z, this.cam.y + ((Math.random() - 0.5) * 40) / this.cam.z]
      : this.toWorld(clientX, clientY);
    if (Math.abs(x) >= EXTENT || Math.abs(y) >= EXTENT) return;
    const after = { face, x: clampCoord(x), y: clampCoord(y), r: rotByte((Math.random() - 0.5) * 0.2), s: 128, tint: this.brush.tint };
    if (this.coversFresh(after.x, after.y, after.r, after.s)) return this.options.onRefused?.("protected");
    if (!this.takeToken()) return this.options.onRefused?.("slow");
    const n = this.nextN++;
    this.commit([{ n, before: null, after }]);
    this.select(this.own.get(n) ?? null);
  }

  /* The viewer's selected cards, bottom to top. */
  private ownSelection(): BoardCard[] {
    return [...this.selection].filter((card) => card.owner === this.options.me).sort((a, b) => a.z - b.z);
  }

  removeSelected() {
    this.commit(this.ownSelection().map((card) => ({ n: card.n, before: stateOf(card), after: null })));
  }

  /* Turns or resizes each selected card in place by a step (keyboard and
     buttons). */
  nudgeSelected(turn: number, grow: number) {
    this.commit(this.ownSelection().map((card) => {
      const before = stateOf(card);
      return { n: card.n, before, after: { ...before, r: (before.r + turn + 256) % 256, s: Math.min(255, Math.max(0, before.s + grow)) } };
    }));
  }

  clearSelection() {
    this.setSelection([]);
  }

  /* Recolours the viewer's selected cards (0 takes the tint off). */
  tintSelected(tint: number) {
    this.commit(this.ownSelection().filter((card) => card.tint !== tint).map((card) => {
      const before = stateOf(card);
      return { n: card.n, before, after: { ...before, tint } };
    }));
  }

  /* Scaling the selection with a slider: begin takes the cards in hand and
     notes where they started, preview resizes them (and spreads or gathers
     their positions round the selection's middle, so a drawing keeps its
     shape), end saves it as one step. */
  private scaling: { cards: { card: BoardCard; before: CardState }[]; cx: number; cy: number } | null = null;

  beginScale() {
    if (this.scaling) return;
    const cards = this.ownSelection().map((card) => ({ card, before: stateOf(card) }));
    if (cards.length === 0) return;
    let cx = 0, cy = 0;
    for (const { card } of cards) {
      cx += card.x;
      cy += card.y;
    }
    this.scaling = { cards, cx: cx / cards.length, cy: cy / cards.length };
    this.lift(cards.map(({ card }) => card));
  }

  previewScale(factor: number) {
    const scaling = this.scaling;
    if (!scaling) return;
    const grow = Math.round(64 * Math.log2(factor));
    for (const { card, before } of scaling.cards) {
      card.s = Math.min(255, Math.max(0, before.s + grow));
      // single cards stay put; a group spreads round its middle
      if (scaling.cards.length > 1) {
        card.x = clampCoord(scaling.cx + (before.x - scaling.cx) * factor);
        card.y = clampCoord(scaling.cy + (before.y - scaling.cy) * factor);
      }
      refresh(card);
    }
    this.request();
  }

  endScale() {
    const scaling = this.scaling;
    if (!scaling) return;
    this.scaling = null;
    const changes: Change[] = scaling.cards.map(({ card, before }) => {
      const after = stateOf(card);
      Object.assign(card, { x: before.x, y: before.y, r: before.r, s: before.s });
      refresh(card);
      this.attach(card);
      return { n: card.n, before, after };
    });
    this.active = [];
    const moved = changes.some(({ before, after }) => after && (before!.s !== after.s || before!.x !== after.x || before!.y !== after.y));
    if (moved) this.commit(changes);
    else this.touch();
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return;
    this.redoStack.push(step);
    this.apply(step.map((change) => ({ n: change.n, before: change.after, after: change.before })).reverse(), true);
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
    this.apply(step, true);
  }

  /* Applies a step of changes and records it for undo. */
  private commit(changes: Change[]) {
    if (changes.length === 0) return;
    this.apply(changes, false);
    this.remember(changes);
  }

  private remember(changes: Change[]) {
    this.undoStack.push(changes);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.history();
  }

  /* Puts changes on the board and hands their edits to the host. */
  private apply(changes: Change[], fromHistory: boolean) {
    const ops: BoardOp[] = [];
    for (const { n, after } of changes) {
      const card = this.own.get(n);
      if (!after) {
        if (!card) continue;
        this.own.delete(n);
        this.detach(card);
        this.unselect(card);
        ops.push(["d", n]);
        continue;
      }
      if (!card) {
        const made = makeCard({ ...after.face, owner: this.options.me!, ownerName: "", n, z: ++this.topZ, x: after.x, y: after.y, r: after.r, s: after.s, tint: after.tint });
        this.own.set(n, made);
        this.attach(made);
        ops.push(["a", n, after.face.key, made.x, made.y, made.r, made.s, made.tint]);
        continue;
      }
      this.detach(card);
      card.x = after.x;
      card.y = after.y;
      card.r = after.r;
      card.s = after.s;
      card.tint = after.tint;
      refresh(card);
      // a card handled by hand comes to the top; an undo leaves it where it is
      if (!fromHistory) card.z = ++this.topZ;
      this.attach(card);
      ops.push(["u", n, card.x, card.y, card.r, card.s, fromHistory ? 0 : 1, card.tint]);
    }
    if (fromHistory) this.history();
    this.touch();
    if (ops.length) this.options.onOps?.(ops);
  }

  private history() {
    this.options.onHistory?.(this.undoStack.length > 0, this.redoStack.length > 0);
  }

  /* Puts a card into the region it sits in, keeping that region's order. */
  private attach(card: BoardCard) {
    const id = regionOf(card.x, card.y);
    let region = this.regions.get(id);
    if (!region) {
      region = { id, version: this.overview.get(id) ?? 0, cards: [], tile: null, tileDirty: true };
      this.regions.set(id, region);
      if (!this.overview.has(id)) this.overview.set(id, 0);
    }
    let index = region.cards.length;
    while (index > 0 && region.cards[index - 1].z > card.z) index--;
    region.cards.splice(index, 0, card);
    region.tileDirty = true;
    this.generation++;
  }

  private detach(card: BoardCard) {
    const region = this.regions.get(regionOf(card.x, card.y));
    if (!region) return;
    const index = region.cards.indexOf(card);
    if (index >= 0) region.cards.splice(index, 1);
    region.tileDirty = true;
    this.generation++;
  }

  private hasPendingIn(id: number) {
    for (const card of this.own.values()) {
      if (regionOf(card.x, card.y) === id && this.options.isPending?.(card.n)) return true;
    }
    return false;
  }

  private dropRegion(id: number) {
    const region = this.regions.get(id);
    if (!region) return;
    for (const card of region.cards) {
      if (card.owner === this.options.me && this.own.get(card.n) === card && !this.active.includes(card)) this.own.delete(card.n);
    }
    this.regions.delete(id);
    this.generation++;
  }

  /* Keeps memory bounded on a big table: the regions farthest from the view
     go first, and are read again if the view comes back. */
  private trimRegions() {
    const distance = (id: number) => {
      const [ox, oy] = regionOrigin(id);
      return Math.hypot(ox + REGION / 2 - this.cam.x, oy + REGION / 2 - this.cam.y);
    };
    const nearFirst = [...this.regions.keys()].sort((a, b) => distance(a) - distance(b));
    let tiles = 0;
    nearFirst.forEach((id, index) => {
      const region = this.regions.get(id)!;
      if (index >= REGION_LIMIT && !this.hasPendingIn(id)) {
        this.dropRegion(id);
      } else if (region.tile && ++tiles > TILE_LIMIT) {
        region.tile = null;
      }
    });
  }

  /* ---------- loading ---------- */

  private scheduleLoad() {
    if (this.loadTimer) return;
    this.loadTimer = window.setTimeout(() => {
      this.loadTimer = 0;
      this.loadVisible();
    }, 120);
  }

  private loadVisible() {
    const far = this.cam.z < TILE_ZOOM;
    if (far !== this.far) {
      this.far = far;
      this.options.onFarChange?.(far);
      // too far out to touch cards: nothing stays selected
      if (far) this.setSelection([]);
    }
    if (far) {
      // far out: colour grids only, for regions not already here as cards
      const grids: number[] = [];
      for (const id of this.visibleRegions(TILE_MARGIN)) {
        const version = this.overview.get(id);
        if (version === undefined) continue;
        if ((this.regions.get(id)?.version ?? -1) >= version) continue;
        if ((this.previews.get(id)?.version ?? -1) >= version) continue;
        if ((this.previewsRequested.get(id) ?? -1) >= version) continue;
        this.previewsRequested.set(id, version);
        grids.push(id);
      }
      if (grids.length) this.options.loadPreviews(grids);
      return;
    }
    const wanted: number[] = [];
    for (const id of this.visibleRegions(REGION / 2)) {
      const version = this.overview.get(id);
      if (version === undefined) continue;
      const loaded = this.regions.get(id);
      if (loaded && loaded.version >= version) continue;
      if ((this.requested.get(id) ?? -1) >= version) continue;
      this.requested.set(id, version);
      wanted.push(id);
    }
    if (wanted.length) this.options.loadRegions(wanted);
  }

  /* Region ids under the view, padded by `pad` board units each way. */
  private visibleRegions(pad: number): number[] {
    const halfW = this.width / 2 / this.cam.z + pad;
    const halfH = this.height / 2 / this.cam.z + pad;
    const rx0 = Math.max(0, Math.floor((this.cam.x - halfW) / REGION) + HALF);
    const rx1 = Math.min(REGIONS_PER_SIDE - 1, Math.floor((this.cam.x + halfW) / REGION) + HALF);
    const ry0 = Math.max(0, Math.floor((this.cam.y - halfH) / REGION) + HALF);
    const ry1 = Math.min(REGIONS_PER_SIDE - 1, Math.floor((this.cam.y + halfH) / REGION) + HALF);
    const ids: number[] = [];
    for (let rx = rx0; rx <= rx1; rx++) for (let ry = ry0; ry <= ry1; ry++) ids.push(rx * REGIONS_PER_SIDE + ry);
    return ids;
  }

  /* ---------- drawing ---------- */

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = rect.width;
    this.height = rect.height;
    const w = Math.round(rect.width * this.dpr);
    const h = Math.round(rect.height * this.dpr);
    for (const canvas of [this.canvas, this.layer]) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
    if (this.pristine && this.fitTarget) this.fitTarget();
    else this.invalidate();
    this.scheduleLoad();
  }

  /* Every view change comes through here: the view is held on the board (its
     middle can't leave it), and the host hears where it is. */
  private invalidate() {
    this.cam.x = Math.min(EXTENT, Math.max(-EXTENT, this.cam.x));
    this.cam.y = Math.min(EXTENT, Math.max(-EXTENT, this.cam.y));
    this.layerDirty = true;
    this.request();
    this.options.onView?.();
  }

  /* The view's size in CSS pixels, for the minimap. */
  get viewSize() {
    return { width: this.width, height: this.height };
  }

  /* Something changed in the cards: refresh the draw list and repaint. */
  private touch() {
    this.generation++;
    this.invalidate();
  }

  private request() {
    if (!this.frame && this.visible) this.frame = requestAnimationFrame(() => this.render());
  }

  private render() {
    this.frame = 0;
    if (!this.width) return;
    this.fading = false;
    if (this.layerDirty) this.paintLayer();
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.layer, 0, 0);
    for (const card of this.active) this.drawCardAt(g, card, this.cam.z * this.dpr, ...this.devicePoint(card), true);
    this.drawSelections(g);
    if (this.marquee) {
      const [x0, y0] = this.toDevice(Math.min(this.marquee.x0, this.marquee.x1), Math.min(this.marquee.y0, this.marquee.y1));
      const [x1, y1] = this.toDevice(Math.max(this.marquee.x0, this.marquee.x1), Math.max(this.marquee.y0, this.marquee.y1));
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = "rgba(255,102,171,0.12)";
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = "#ff66ab";
      g.lineWidth = 1.5 * this.dpr;
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    // a face still fading in needs the next frame too
    if (this.fading) this.invalidate();
  }

  private toDevice(x: number, y: number): [number, number] {
    return [(this.width / 2 + (x - this.cam.x) * this.cam.z) * this.dpr, (this.height / 2 + (y - this.cam.y) * this.cam.z) * this.dpr];
  }

  /* An outline round each selected card, or past a few hundred of them one
     box round the lot, which says the same for a fraction of the strokes. */
  private drawSelections(g: CanvasRenderingContext2D) {
    if (this.selection.size === 0) return;
    if (this.selection.size <= 300) {
      for (const card of this.selection) this.drawSelection(g, card, this.selection.size === 1);
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const card of this.selection) {
      const reach = 50 * card.sc;
      minX = Math.min(minX, card.x - reach);
      minY = Math.min(minY, card.y - reach);
      maxX = Math.max(maxX, card.x + reach);
      maxY = Math.max(maxY, card.y + reach);
    }
    const [x0, y0] = this.toDevice(minX, minY);
    const [x1, y1] = this.toDevice(maxX, maxY);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.setLineDash([6 * this.dpr, 4 * this.dpr]);
    g.strokeStyle = "#ff66ab";
    g.lineWidth = 1.5 * this.dpr;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.setLineDash([]);
  }

  private devicePoint(card: BoardCard): [number, number] {
    return [(this.width / 2 + (card.x - this.cam.x) * this.cam.z) * this.dpr, (this.height / 2 + (card.y - this.cam.y) * this.cam.z) * this.dpr];
  }

  private paintLayer() {
    this.layerDirty = false;
    const g = this.lg;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.layer.width, this.layer.height);
    this.drawGrid(g);
    if (this.cam.z < TILE_ZOOM) {
      this.paintTiles(g);
      return;
    }
    const halfW = this.width / 2 / this.cam.z;
    const halfH = this.height / 2 / this.cam.z;
    const left = this.cam.x - halfW, right = this.cam.x + halfW;
    const top = this.cam.y - halfH, bottom = this.cam.y + halfH;
    const u = this.cam.z * this.dpr;
    for (const card of this.cardsInView()) {
      const reach = 56 * card.sc;
      if (card.x + reach < left || card.x - reach > right || card.y + reach < top || card.y - reach > bottom) continue;
      this.drawCardAt(g, card, u, ...this.devicePoint(card), true);
    }
  }

  /* Every card in the regions under the view, in stacking order. Rebuilt only
     when the set of regions or their cards changed. */
  private cardsInView(): BoardCard[] {
    const ids = this.visibleRegions(256).filter((id) => this.regions.get(id)?.cards.length);
    const key = `${this.generation}:${ids.join(",")}`;
    if (key === this.drawListFor) return this.drawList;
    const list: BoardCard[] = [];
    for (const id of ids) list.push(...this.regions.get(id)!.cards);
    if (ids.length > 1) list.sort((a, b) => a.z - b.z);
    this.drawList = list;
    this.drawListFor = key;
    return list;
  }

  private paintTiles(g: CanvasRenderingContext2D) {
    const scale = (this.cam.z * this.dpr) / TILE_SCALE;
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const id of this.visibleRegions(TILE_MARGIN)) {
      const version = this.overview.get(id);
      const region = this.regions.get(id);
      const preview = this.previews.get(id);
      // the region's own cards when they are here and current, else its grid
      if (preview && (!region || region.version < (version ?? 0) || (preview.version > region.version && !this.hasPendingIn(id)))) {
        const [ox, oy] = regionOrigin(id);
        const margin = PREVIEW_MARGIN * PREVIEW_CELL;
        const [dx, dy] = this.toDevice(ox - margin, oy - margin);
        const size = (REGION + margin * 2) * this.cam.z * this.dpr;
        g.imageSmoothingEnabled = false;
        g.drawImage(preview.image, dx, dy, size, size);
        g.imageSmoothingEnabled = true;
        continue;
      }
      if (!region?.cards.length) continue;
      if (!region.tile || region.tileDirty) this.paintTile(region);
      const [ox, oy] = regionOrigin(id);
      const dx = (this.width / 2 + (ox - TILE_MARGIN - this.cam.x) * this.cam.z) * this.dpr;
      const dy = (this.height / 2 + (oy - TILE_MARGIN - this.cam.y) * this.cam.z) * this.dpr;
      g.drawImage(region.tile!, dx, dy, region.tile!.width * scale, region.tile!.height * scale);
    }
  }

  private paintTile(region: Region) {
    const size = Math.ceil((REGION + TILE_MARGIN * 2) * TILE_SCALE);
    const tile = region.tile ?? document.createElement("canvas");
    if (tile.width !== size) {
      tile.width = size;
      tile.height = size;
    }
    const g = tile.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
    const [ox, oy] = regionOrigin(region.id);
    for (const card of region.cards) {
      this.drawCardAt(g, card, TILE_SCALE, (card.x - ox + TILE_MARGIN) * TILE_SCALE, (card.y - oy + TILE_MARGIN) * TILE_SCALE, false);
    }
    region.tile = tile;
    region.tileDirty = false;
  }

  /* A card that lands on top needs no repaint of anything under it. */
  private paintOnLayer(card: BoardCard) {
    if (!this.layerDirty) this.drawCardAt(this.lg, card, this.cam.z * this.dpr, ...this.devicePoint(card), this.cam.z >= TILE_ZOOM);
    this.request();
  }

  /* The table itself: dots to read distance and movement by, faint region
     lines further out, and past the edge a shaded margin with a border, so it
     is always plain where the board ends. */
  private drawGrid(g: CanvasRenderingContext2D) {
    const W = this.layer.width, H = this.layer.height;
    const [left, top] = this.toDevice(-EXTENT, -EXTENT);
    const [right, bottom] = this.toDevice(EXTENT, EXTENT);
    const x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(W, right), y1 = Math.min(H, bottom);

    const step = this.cam.z > 0.5 ? 64 : this.cam.z > 0.12 ? 256 : REGION;
    const spacing = step * this.cam.z * this.dpr;
    if (spacing >= 12) {
      g.fillStyle = "rgba(255,255,255,0.16)";
      const size = Math.max(1.5, this.dpr * 2);
      const startX = left + Math.ceil((x0 - left) / spacing) * spacing;
      const startY = top + Math.ceil((y0 - top) / spacing) * spacing;
      for (let x = startX; x <= x1; x += spacing) {
        for (let y = startY; y <= y1; y += spacing) g.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }
    // region lines once the dots are too far apart to read the scale by
    const regionSpacing = REGION * this.cam.z * this.dpr;
    if (this.cam.z < 0.35 && regionSpacing >= 10) {
      g.strokeStyle = "rgba(255,255,255,0.07)";
      g.lineWidth = Math.max(1, this.dpr);
      g.beginPath();
      for (let x = left + Math.ceil((x0 - left) / regionSpacing) * regionSpacing; x <= x1; x += regionSpacing) {
        g.moveTo(x, y0);
        g.lineTo(x, y1);
      }
      for (let y = top + Math.ceil((y0 - top) / regionSpacing) * regionSpacing; y <= y1; y += regionSpacing) {
        g.moveTo(x0, y);
        g.lineTo(x1, y);
      }
      g.stroke();
    }
    // past the edge
    g.fillStyle = "rgba(0,0,0,0.45)";
    if (top > 0) g.fillRect(0, 0, W, Math.min(H, top));
    if (bottom < H) g.fillRect(0, Math.max(0, bottom), W, H - Math.max(0, bottom));
    if (left > 0) g.fillRect(0, y0, Math.min(W, left), y1 - y0);
    if (right < W) g.fillRect(Math.max(0, right), y0, W - Math.max(0, right), y1 - y0);
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.lineWidth = Math.max(1, this.dpr * 1.5);
    g.strokeRect(left, top, right - left, bottom - top);
  }

  /* `unit` is target pixels per board unit for a card at its own size. */
  private drawCardAt(g: CanvasRenderingContext2D, card: BoardCard, unit: number, ex: number, ey: number, faces: boolean) {
    const u = unit * card.sc;
    const deviceWidth = CARD_W * u;
    if (deviceWidth < 3) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = cardPaint(card).mid;
      const h = (deviceWidth * CARD_H) / CARD_W;
      g.fillRect(ex - deviceWidth / 2, ey - h / 2, Math.max(1, deviceWidth), Math.max(1, h));
      return;
    }
    const lod = LODS.find((size) => size >= deviceWidth) ?? LODS[LODS.length - 1];
    const art = sprite(card, lod);
    g.setTransform(card.cos * u, card.sin * u, -card.sin * u, card.cos * u, ex, ey);
    const face = faces && deviceWidth >= FACE_FROM ? this.options.face?.(card) ?? null : null;
    let mix = 0;
    if (face) {
      const age = (performance.now() - face.at) / FACE_FADE_MS;
      if (age < 1) this.fading = true;
      mix = ease((deviceWidth - FACE_FROM) / (FACE_FULL - FACE_FROM)) * ease(age);
    }
    if (mix < 1) {
      const pad = art.pad / art.ppu;
      g.drawImage(art.canvas, -CARD_W / 2 - pad, -CARD_H / 2 - pad, art.canvas.width / art.ppu, art.canvas.height / art.ppu);
    }
    if (face && mix > 0) {
      // the card's own shadow, then the card, both faded in over the sprite
      g.globalAlpha = mix * 0.85;
      // a drop shadow sits a little low; a tint's halo sits centred
      g.drawImage(shadow(lod, card.tint), -CARD_W / 2 - SHADOW_PAD, -CARD_H / 2 - SHADOW_PAD + (card.tint ? 0 : 2), CARD_W + SHADOW_PAD * 2, CARD_H + SHADOW_PAD * 2);
      g.globalAlpha = mix;
      g.drawImage(card.tint ? tintedFace(face.image, card.tint, card.key.startsWith("team:")) : face.image, -CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H);
      g.globalAlpha = 1;
    }
  }

  private drawSelection(g: CanvasRenderingContext2D, card: BoardCard, handles: boolean) {
    const u = card.sc * this.cam.z * this.dpr;
    // handles bigger than the card would hide it: only the outline then
    if (CARD_W * u < 18 * this.dpr) handles = false;
    const [ex, ey] = this.devicePoint(card);
    g.setTransform(card.cos, card.sin, -card.sin, card.cos, ex, ey);
    const w = CARD_W * u + 6 * this.dpr;
    const h = CARD_H * u + 6 * this.dpr;
    const mine = card.owner === this.options.me;
    g.strokeStyle = mine ? "#ff66ab" : "#ffd166";
    g.lineWidth = 2 * this.dpr;
    g.beginPath();
    g.roundRect(-w / 2, -h / 2, w, h, 6 * this.dpr);
    g.stroke();
    if (!mine || !handles) return;
    const handle = HANDLE * this.dpr;
    g.fillStyle = "#ff66ab";
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5 * this.dpr;
    // turn handle above the top edge, size handle on the bottom-right corner
    g.beginPath();
    g.moveTo(0, -h / 2);
    g.lineTo(0, -h / 2 - TURN_REACH * this.dpr);
    g.stroke();
    for (const [x, y] of [[0, -h / 2 - TURN_REACH * this.dpr], [w / 2, h / 2]]) {
      g.beginPath();
      g.arc(x, y, handle, 0, TURN);
      g.fill();
      g.stroke();
    }
  }

  /* ---------- geometry ---------- */

  toWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [
      (clientX - rect.left - this.width / 2) / this.cam.z + this.cam.x,
      (clientY - rect.top - this.height / 2) / this.cam.z + this.cam.y,
    ];
  }

  /* The topmost card under a point (only the viewer's own when `mine`), by
     its turned rectangle. Looks through the region the point is in and its
     neighbours, which is every card that can reach it. */
  private cardAt(x: number, y: number, mine: boolean): BoardCard | null {
    let best: BoardCard | null = null;
    const rx = Math.floor(x / REGION) + HALF;
    const ry = Math.floor(y / REGION) + HALF;
    for (let ix = rx - 1; ix <= rx + 1; ix++) {
      for (let iy = ry - 1; iy <= ry + 1; iy++) {
        if (ix < 0 || iy < 0 || ix >= REGIONS_PER_SIDE || iy >= REGIONS_PER_SIDE) continue;
        const region = this.regions.get(ix * REGIONS_PER_SIDE + iy);
        if (!region) continue;
        for (let i = region.cards.length - 1; i >= 0; i--) {
          const card = region.cards[i];
          if (best && card.z <= best.z) break;
          if (mine && card.owner !== this.options.me) continue;
          const dx = x - card.x, dy = y - card.y;
          const lx = dx * card.cos + dy * card.sin;
          const ly = -dx * card.sin + dy * card.cos;
          if (Math.abs(lx) <= (CARD_W / 2) * card.sc && Math.abs(ly) <= (CARD_H / 2) * card.sc) {
            best = card;
            break;
          }
        }
      }
    }
    return best;
  }

  private handleAt(clientX: number, clientY: number): "turn" | "size" | null {
    const card = this.selected;
    if (!card || card.owner !== this.options.me) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const cx = this.width / 2 + (card.x - this.cam.x) * this.cam.z;
    const cy = this.height / 2 + (card.y - this.cam.y) * this.cam.z;
    const w = CARD_W * card.sc * this.cam.z + 6;
    const h = CARD_H * card.sc * this.cam.z + 6;
    const at = (lx: number, ly: number): [number, number] => [cx + lx * card.cos - ly * card.sin, cy + lx * card.sin + ly * card.cos];
    const near = ([x, y]: [number, number]) => Math.hypot(px - x, py - y) <= HANDLE + 6;
    if (near(at(0, -h / 2 - TURN_REACH))) return "turn";
    if (near(at(w / 2, h / 2))) return "size";
    return null;
  }

  /* ---------- input ---------- */

  private listen(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler, options);
    this.cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  private down(e: PointerEvent) {
    this.pristine = false;
    this.fitRegions = null;
    this.canvas.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the browser no longer tracks; the gesture works without capture
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      // a second finger turns whatever the first one started into a pinch
      this.finishGesture();
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, camX: this.cam.x, camY: this.cam.y, z: this.cam.z };
      return;
    }
    if (this.pointers.size > 2) return;
    const pan = () => {
      this.gesture = { kind: "pan", startX: e.clientX, startY: e.clientY, camX: this.cam.x, camY: this.cam.y };
    };
    if (e.button === 1 || e.button === 2 || this.spaceHeld) return pan();
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    // too far out to see single cards: the board only moves
    if (this.options.me == null || this.cam.z < TILE_ZOOM) return pan();
    const handle = this.handleAt(e.clientX, e.clientY);
    if (handle && this.selected) {
      const card = this.selected;
      const before = stateOf(card);
      this.lift([card]);
      this.gesture = handle === "turn"
        ? { kind: "turn", card, before, startAngle: Math.atan2(y - card.y, x - card.x), startR: card.r }
        : { kind: "size", card, before, startDist: Math.max(4, Math.hypot(x - card.x, y - card.y)), startS: card.s };
      return;
    }
    if (this.tool === "brush") {
      this.setSelection([]);
      this.gesture = { kind: "brush", lastX: x, lastY: y, carry: Infinity, changes: [] };
      this.deal(x, y, x, y + 1);
      return;
    }
    const card = this.cardAt(x, y, true);
    if (!card) {
      // an admin's click on someone else's card picks it, for taking it off
      const other = this.options.canModerate && this.cam.z >= TILE_ZOOM ? this.cardAt(x, y, false) : null;
      if (!e.shiftKey) this.setSelection(other ? [other] : []);
      // a mouse drags out a box to select with; a finger moves the view
      if (e.pointerType !== "mouse") return pan();
      this.marquee = { x0: x, y0: y, x1: x, y1: y };
      this.gesture = { kind: "marquee", additive: e.shiftKey };
      return;
    }
    if (e.shiftKey) {
      // shift-click adds a card to the selection or takes it back out
      const next = new Set([...this.selection].filter((held) => held.owner === this.options.me));
      if (next.has(card)) next.delete(card);
      else next.add(card);
      this.setSelection(next);
      if (!next.has(card)) return;
    } else if (!this.selection.has(card)) {
      this.setSelection([card]);
    }
    // grabbing one of a selection moves all of it
    const cards = this.ownSelection().map((held) => ({ card: held, before: stateOf(held) }));
    this.lift(cards.map((held) => held.card));
    this.gesture = { kind: "drag", cards, lastX: x, lastY: y, moved: false };
  }

  private move(e: PointerEvent) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === "mouse") this.options.onPointerAt?.(this.toWorld(e.clientX, e.clientY));
    const gesture = this.gesture;
    if (!gesture) {
      if (this.options.onHover && e.pointerType === "mouse") {
        const [x, y] = this.toWorld(e.clientX, e.clientY);
        this.options.onHover(this.cam.z >= TILE_ZOOM ? this.cardAt(x, y, false) : null, e.clientX, e.clientY);
      }
      return;
    }
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    switch (gesture.kind) {
      case "pan":
        this.cam.x = gesture.camX - (e.clientX - gesture.startX) / this.cam.z;
        this.cam.y = gesture.camY - (e.clientY - gesture.startY) / this.cam.z;
        this.invalidate();
        this.scheduleLoad();
        return;
      case "pinch": {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) return;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        this.cam.z = clampZoom(gesture.z * (dist / Math.max(1, gesture.dist)));
        this.cam.x = gesture.camX - (midX - gesture.midX) / this.cam.z;
        this.cam.y = gesture.camY - (midY - gesture.midY) / this.cam.z;
        this.invalidate();
        this.scheduleLoad();
        return;
      }
      case "drag": {
        const dx = Math.round(x - gesture.lastX);
        const dy = Math.round(y - gesture.lastY);
        if (!dx && !dy) return;
        for (const { card } of gesture.cards) {
          card.x = clampCoord(card.x + dx);
          card.y = clampCoord(card.y + dy);
        }
        gesture.lastX += dx;
        gesture.lastY += dy;
        gesture.moved = true;
        this.request();
        return;
      }
      case "marquee":
        this.marquee!.x1 = x;
        this.marquee!.y1 = y;
        this.request();
        return;
      case "turn": {
        const angle = Math.atan2(y - gesture.card.y, x - gesture.card.x) - gesture.startAngle;
        gesture.card.r = (gesture.startR + rotByte(angle)) % 256;
        refresh(gesture.card);
        this.request();
        return;
      }
      case "size": {
        const grow = Math.hypot(x - gesture.card.x, y - gesture.card.y) / gesture.startDist;
        gesture.card.s = Math.min(255, Math.max(0, gesture.startS + Math.round(64 * Math.log2(grow))));
        refresh(gesture.card);
        this.request();
        return;
      }
      case "brush":
        this.deal(gesture.lastX, gesture.lastY, x, y);
        return;
    }
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.gesture?.kind === "pinch") {
      // the finger left behind carries on as a pan, not a jump
      const rest = [...this.pointers.values()][0];
      this.gesture = rest ? { kind: "pan", startX: rest.x, startY: rest.y, camX: this.cam.x, camY: this.cam.y } : null;
      return;
    }
    if (this.pointers.size === 0) this.finishGesture();
  }

  private finishGesture() {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind === "drag" || gesture.kind === "turn" || gesture.kind === "size") {
      const held = gesture.kind === "drag" ? gesture.cards : [{ card: gesture.card, before: gesture.before }];
      // each set back down where it was, then moved through commit like any edit
      const changes: Change[] = held.map(({ card, before }) => {
        const after = stateOf(card);
        Object.assign(card, { x: before.x, y: before.y, r: before.r, s: before.s });
        refresh(card);
        this.attach(card);
        return { n: card.n, before, after };
      });
      this.active = [];
      if (gesture.kind !== "drag" || gesture.moved) this.commit(changes);
      else this.touch();
    } else if (gesture.kind === "marquee") {
      this.endMarquee(gesture.additive);
    } else if (gesture.kind === "brush") {
      this.endStroke(gesture);
    }
  }

  private endStroke(gesture: Brush) {
    this.flushStroke(gesture);
    // the stroke's cards are already down; this only records the step
    if (gesture.changes.length) this.remember(gesture.changes);
  }

  /* Hands a stroke's new cards to the host as it is drawn, so a long stroke
     saves as it goes rather than all at the end. */
  private flushStroke(gesture: Brush) {
    const ops: BoardOp[] = [];
    for (const change of gesture.changes) {
      if (change.sent || !change.after) continue;
      change.sent = true;
      const after = change.after;
      ops.push(["a", change.n, after.face.key, after.x, after.y, after.r, after.s, after.tint]);
    }
    if (ops.length) this.options.onOps?.(ops);
  }

  /* Lays cards along the stroke from the last point to this one, one every
     so often, each turned with the line when the brush says so. */
  private deal(fromX: number, fromY: number, toX: number, toY: number) {
    const gesture = this.gesture;
    if (gesture?.kind !== "brush" || !this.options.takeCard) return;
    const spacing = CARD_H * 0.42 * this.brush.scale;
    const dx = toX - fromX, dy = toY - fromY;
    const length = Math.hypot(dx, dy);
    const direction = Math.atan2(dy, dx);
    let travelled = 0;
    let carry = gesture.carry;
    // the first card goes down where the stroke starts
    if (carry === Infinity) carry = spacing;
    let dealt = 0;
    while (carry + (length - travelled) >= spacing) {
      travelled += spacing - carry;
      carry = 0;
      const t0 = length > 0 ? travelled / length : 0;
      const at = [fromX + dx * t0, fromY + dy * t0];
      // nothing is dealt past the board's edge
      if (Math.abs(at[0]) >= EXTENT || Math.abs(at[1]) >= EXTENT) continue;
      const turn = rotByte(this.brush.follow ? direction + Math.PI / 2 : 0);
      // the stroke leaves a gap over someone's fresh drawing, and while the
      // viewer is out of allowance, rather than ending
      if (this.coversFresh(at[0], at[1], turn, scaleByte(this.brush.scale))) {
        this.options.onRefused?.("protected");
        continue;
      }
      if (!this.takeToken()) {
        this.options.onRefused?.("slow");
        continue;
      }
      const face = this.options.takeCard();
      if (!face) {
        this.gesture = null;
        this.endStroke(gesture);
        return;
      }
      const t = length > 0 ? travelled / length : 0;
      const angle = this.brush.follow ? direction + Math.PI / 2 + (Math.random() - 0.5) * 0.12 : (Math.random() - 0.5) * 0.12;
      const n = this.nextN++;
      const card = makeCard({ ...face, owner: this.options.me!, ownerName: "", n, z: ++this.topZ, x: clampCoord(fromX + dx * t), y: clampCoord(fromY + dy * t), r: rotByte(angle), s: scaleByte(this.brush.scale), tint: this.brush.tint });
      this.own.set(n, card);
      this.attach(card);
      gesture.changes.push({ n, before: null, after: stateOf(card) });
      this.paintOnLayer(card);
      dealt++;
    }
    gesture.carry = carry + (length - travelled);
    gesture.lastX = toX;
    gesture.lastY = toY;
    if (dealt && gesture.changes.filter((change) => !change.sent).length >= 40) this.flushStroke(gesture);
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    this.pristine = false;
    this.fitRegions = null;
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const z = clampZoom(this.cam.z * Math.exp(-e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.0015)));
    // keep the point under the cursor where it is
    this.cam.x = x - (x - this.cam.x) * (this.cam.z / z);
    this.cam.y = y - (y - this.cam.y) * (this.cam.z / z);
    this.cam.z = z;
    this.invalidate();
    this.scheduleLoad();
  }

  private key(e: KeyboardEvent) {
    if (e.code === "Space") {
      this.spaceHeld = true;
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      this.setSelection([]);
      return;
    }
    if (this.options.me == null) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      // every one of the viewer's cards in the loaded part of the table
      e.preventDefault();
      this.setSelection(this.own.values());
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.removeSelected();
    } else if (e.key === "[" || e.key === "]") {
      this.nudgeSelected(e.key === "[" ? -8 : 8, 0);
    } else if (e.key === "-" || e.key === "=" || e.key === "+") {
      this.nudgeSelected(0, e.key === "-" ? -8 : 8);
    }
  }

  /* ---------- bookkeeping ---------- */

  /* Takes cards out of their regions and draws them apart from the cached
     layer while they are handled. */
  private lift(cards: BoardCard[]) {
    for (const card of cards) this.detach(card);
    this.active = cards;
    this.invalidate();
  }

  /* Selects the viewer's cards whose middle is inside the box, adding to the
     selection with shift held. A box too small to mean anything is a click,
     which already settled the selection on the press. */
  private endMarquee(additive: boolean) {
    const box = this.marquee;
    this.marquee = null;
    this.request();
    if (!box) return;
    const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
    const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
    if ((x1 - x0) * this.cam.z < 4 && (y1 - y0) * this.cam.z < 4) return;
    const picked = new Set(additive ? [...this.selection].filter((card) => card.owner === this.options.me) : []);
    for (const card of this.own.values()) {
      if (card.x >= x0 && card.x <= x1 && card.y >= y0 && card.y <= y1) picked.add(card);
    }
    this.setSelection(picked);
  }

  private select(card: BoardCard | null) {
    this.setSelection(card ? [card] : []);
  }

  private setSelection(cards: Iterable<BoardCard>) {
    const next = new Set(cards);
    if (next.size === this.selection.size && [...next].every((card) => this.selection.has(card))) return;
    this.selection = next;
    this.options.onSelect?.([...next]);
    this.request();
  }

  private unselect(card: BoardCard) {
    if (!this.selection.has(card)) return;
    const next = new Set(this.selection);
    next.delete(card);
    this.setSelection(next);
  }
}

/* The colour of each value in a region's colour grid: 1-11 the tiers, 16 and
   up the tints, nothing for bare table. */
let previewPalette: ([number, number, number] | undefined)[] | null = null;
function previewColours(): ([number, number, number] | undefined)[] {
  if (previewPalette) return previewPalette;
  const colours: ([number, number, number] | undefined)[] = [];
  PREVIEW_TIERS.forEach((tier, i) => (colours[i + 1] = hexRgb(tierPaint(tier).mid)));
  TINTS.forEach((hex, i) => (colours[16 + i] = hexRgb(hex)));
  previewPalette = colours;
  return colours;
}

/* A real face in a tint: the card body takes the colour and the picture is
   left as it is. Painted once per face and tint and kept, so a frame still
   draws one image per card. Where the picture sits, as shares of the face,
   from the card renderer's own layout (maniacard3d textureLayout.ts, on its
   1000 x 1400 face): a player's avatar box with its rounded corners, or a
   team card's banner strip down the left. */
const PLAYER_PICTURE = { x: 0.185, y: 0.2, w: 0.63, h: 0.45, radius: 0.032 };
const TEAM_PICTURE = { x: 0, y: 0, w: 0.27, h: 1, radius: 0 };
const tintedFaces = new WeakMap<object, Map<number, HTMLCanvasElement>>();
function tintedFace(image: CanvasImageSource, tint: number, team: boolean): HTMLCanvasElement | CanvasImageSource {
  let byTint = tintedFaces.get(image);
  const held = byTint?.get(tint);
  if (held) return held;
  const source = image as HTMLImageElement;
  const w = source.naturalWidth || source.width || 240;
  const h = source.naturalHeight || source.height || 336;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return image;
  g.drawImage(image, 0, 0, w, h);
  g.save();
  const picture = team ? TEAM_PICTURE : PLAYER_PICTURE;
  const body = new Path2D();
  body.rect(0, 0, w, h);
  body.roundRect(picture.x * w, picture.y * h, picture.w * w, picture.h * h, picture.radius * w);
  g.clip(body, "evenodd");
  const hex = TINTS[tint - 1] ?? "#888888";
  for (const [mode, alpha] of [["color", 1], ["soft-light", 0.9], ["screen", 0.18]] as const) {
    g.globalCompositeOperation = mode;
    g.globalAlpha = alpha;
    g.fillStyle = hex;
    g.fillRect(0, 0, w, h);
  }
  g.restore();
  // back to the face's own outline (its rounded corners stay clear)
  g.globalCompositeOperation = "destination-in";
  g.drawImage(image, 0, 0, w, h);
  if (!byTint) {
    byTint = new Map();
    tintedFaces.set(image, byTint);
  }
  byTint.set(tint, canvas);
  return canvas;
}

/* Whether two turned card rectangles overlap (separating axis test), the
   same test the backend refuses covering edits with. */
function overlaps(a: { x: number; y: number; r: number; s: number }, b: { x: number; y: number; r: number; s: number }): boolean {
  const shape = (card: typeof a) => {
    const scale = scaleOf(card.s);
    const angle = angleOf(card.r);
    return { x: card.x, y: card.y, hw: (CARD_W / 2) * scale, hh: (CARD_H / 2) * scale, cos: Math.cos(angle), sin: Math.sin(angle) };
  };
  const p = shape(a), q = shape(b);
  const dx = q.x - p.x, dy = q.y - p.y;
  if (Math.hypot(dx, dy) > Math.hypot(p.hw, p.hh) + Math.hypot(q.hw, q.hh)) return false;
  for (const axis of [[p.cos, p.sin], [-p.sin, p.cos], [q.cos, q.sin], [-q.sin, q.cos]]) {
    const reach = (c: typeof p) => c.hw * Math.abs(c.cos * axis[0] + c.sin * axis[1]) + c.hh * Math.abs(-c.sin * axis[0] + c.cos * axis[1]);
    if (Math.abs(dx * axis[0] + dy * axis[1]) > reach(p) + reach(q)) return false;
  }
  return true;
}

function hexRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function stateOf(card: BoardCard): CardState {
  return { face: { key: card.key, tier: card.tier, name: card.name }, x: card.x, y: card.y, r: card.r, s: card.s, tint: card.tint };
}

function clampZoom(z: number) {
  return Math.min(4, Math.max(0.012, z));
}
