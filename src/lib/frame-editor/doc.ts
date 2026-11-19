import { WORKSHOP_FRAME_TEMPLATE } from "../supporter-avatar-frames";

/* The avatar frame editor's document (/workshop/frames/editor). A frame is
   drawn on the workshop template's square at twice its size, so brushes and
   text stay sharp when it is exported at the template's 384px. It has two
   boards: the square frame every profile shows, and an optional round one
   lists draw around a round avatar. Each board is a stack of layers, bottom
   first. Paint layers keep their pixels outside the document (see
   `Pixels`), so the document itself stays plain JSON. */

/* The size frames are uploaded at. */
export const WORKSHOP_SIZE = WORKSHOP_FRAME_TEMPLATE.size;
export const DOC_SIZE = WORKSHOP_SIZE * 2;
export const DOC_SCALE = DOC_SIZE / WORKSHOP_FRAME_TEMPLATE.size;
export const AVATAR_INSET = WORKSHOP_FRAME_TEMPLATE.inset * DOC_SCALE;
export const AVATAR_SIZE = WORKSHOP_FRAME_TEMPLATE.avatar * DOC_SCALE;
export const DOC_CENTRE = DOC_SIZE / 2;
/* The site rounds a square avatar's corners by this share of its width. */
export const AVATAR_RADIUS = Math.round((16 / 124) * AVATAR_SIZE);
export const LAYERS_MAX = 40;
/* The loop's length; motion speeds are whole cycles per loop so it never jumps. */
export const LOOP_SECONDS = 3;

export type BoardId = "square" | "round";

export type BlendMode =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export const BLEND_MODES: readonly BlendMode[] = [
  "source-over", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

/* Where a layer sits: its centre in document pixels, its turn in degrees and
   its scale (negative flips it). Paint layers start centred, unturned. */
export interface Transform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /* degrees of slant along each axis */
  skewX?: number;
  skewY?: number;
}

/* A rectangle of the layer's own space, pulled into any four-cornered shape
   (top left, top right, bottom right, bottom left): perspective and distort. */
export interface Distort {
  from: { x0: number; y0: number; x1: number; y1: number };
  to: [number, number][];
}

export type FillKind = "solid" | "linear" | "radial" | "conic";
export interface Fill {
  kind: FillKind;
  color: string;
  color2: string;
  /* degrees, for linear and conic */
  angle: number;
}

export interface Effects {
  stroke: { on: boolean; color: string; width: number; opacity: number };
  glow: { on: boolean; color: string; size: number; opacity: number; strength: number };
  shadow: { on: boolean; color: string; blur: number; distance: number; angle: number; opacity: number };
  overlay: { on: boolean; fill: Fill; opacity: number };
  /* drawn again around the avatar's centre, evenly spaced */
  repeat: { count: number; mirror: boolean };
  adjust: { hue: number; saturation: number; brightness: number; contrast: number; blur: number };
}

export type MotionKind = "none" | "spin" | "orbit" | "pulse" | "bob" | "sway" | "blink" | "hue" | "shimmer" | "keys";

/* One keyframe: where the layer is at moment `t` (0..1 of the loop), as
   offsets from its own position, turn and size. */
export interface MotionKey {
  id: string;
  t: number;
  dx: number;
  dy: number;
  rotation: number;
  scale: number;
  opacity: number;
  ease: "linear" | "smooth";
}

export interface Motion {
  keys?: MotionKey[];
  kind: MotionKind;
  /* whole cycles per loop, so the loop closes */
  speed: number;
  /* how far it moves: degrees for sway, share of size for pulse, px for bob */
  amount: number;
  /* 0..1 of a cycle */
  phase: number;
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  /* clipped to the layer below it, as a clipping mask */
  clip: boolean;
  transform: Transform;
  effects: Effects;
  motion: Motion;
  /* a layer mask: its pixels live under maskKey(id), white shows and clear hides */
  mask?: { enabled: boolean } | null;
  distort?: Distort | null;
}

export interface PaintLayer extends LayerBase {
  kind: "paint";
}

export interface ImageLayer extends LayerBase {
  kind: "image";
  asset: string;
  width: number;
  height: number;
}

export type ShapeKind = "rect" | "ellipse" | "polygon" | "star" | "line" | "arc";
export interface ShapeLayer extends LayerBase {
  kind: "shape";
  shape: ShapeKind;
  width: number;
  height: number;
  /* rect: corner radius in px */
  radius: number;
  /* polygon and star: corners */
  sides: number;
  /* star: inner radius as a share of the outer one */
  inner: number;
  /* arc: the swept angle in degrees */
  sweep: number;
  style: "fill" | "outline";
  lineWidth: number;
  /* outline dashes, as dash and gap lengths in px; 0 for a solid line */
  dash: number;
  gap: number;
  cap: "butt" | "round";
  fill: Fill;
}

export interface TextLayer extends LayerBase {
  kind: "text";
  text: string;
  font: string;
  weight: number;
  size: number;
  spacing: number;
  /* bends the text round a circle of this radius around the layer's centre; 0 keeps it straight */
  arc: number;
  /* along the bottom of the circle, reading left to right */
  arcBelow: boolean;
  fill: Fill;
  italic: boolean;
}

/* One anchor of a pen path, in the layer's own space, with its two curve
   handles (equal to the anchor for a sharp corner). */
export interface PathPoint {
  x: number;
  y: number;
  ix: number;
  iy: number;
  ox: number;
  oy: number;
}

export interface PathLayer extends LayerBase {
  kind: "path";
  points: PathPoint[];
  closed: boolean;
  style: "fill" | "outline";
  lineWidth: number;
  dash: number;
  gap: number;
  cap: "butt" | "round";
  fill: Fill;
}

/* A folder of layers drawn as one: its opacity, blend, mask, effects, repeat
   and motion apply to all of them together. It never has a transform of its
   own; moving it moves the layers inside. */
export interface GroupLayer extends LayerBase {
  kind: "group";
  children: Layer[];
  collapsed: boolean;
}

export type Layer = PaintLayer | ImageLayer | ShapeLayer | TextLayer | PathLayer | GroupLayer;
export type LayerKind = Layer["kind"];

export interface FrameDoc {
  version: 1;
  name: string;
  boards: Record<BoardId, Layer[]>;
  /* the workshop frame this draft was submitted as ("u12"), which Submit updates */
  submitted?: string | null;
}

/* The pixels behind paint layers, and pictures behind image layers, by id.
   A canvas here is never drawn on once it is in a committed state; edits
   make a copy, so history can keep the old one. */
export type Pixels = Record<string, HTMLCanvasElement>;
export type Assets = Record<string, HTMLCanvasElement>;

export interface EditorState {
  doc: FrameDoc;
  pixels: Pixels;
  assets: Assets;
}

export const FONTS: readonly { family: string; label: string; weights: readonly number[] }[] = [
  { family: "Torus", label: "Torus", weights: [300, 400, 600, 800, 900] },
  { family: "Tracker Round", label: "Tracker Round", weights: [300, 400, 600, 800, 900] },
  { family: "Venera", label: "Venera", weights: [500] },
  { family: "Aller", label: "Aller", weights: [400] },
  { family: "Name Orbitron", label: "Orbitron", weights: [400] },
  { family: "Name Unbounded", label: "Unbounded", weights: [400] },
  { family: "Name Bungee", label: "Bungee", weights: [400] },
  { family: "Name Bebas Neue", label: "Bebas Neue", weights: [400] },
  { family: "Name Righteous", label: "Righteous", weights: [400] },
  { family: "Name Monoton", label: "Monoton", weights: [400] },
  { family: "Name Permanent Marker", label: "Permanent Marker", weights: [400] },
  { family: "Name Pacifico", label: "Pacifico", weights: [400] },
  { family: "Name Cinzel", label: "Cinzel", weights: [400] },
  { family: "Name Playfair Display", label: "Playfair Display", weights: [400] },
  { family: "Name Press Start 2P", label: "Press Start 2P", weights: [400] },
  { family: "Name VT323", label: "VT323", weights: [400] },
  { family: "Name Silkscreen", label: "Silkscreen", weights: [400] },
  { family: "Name Audiowide", label: "Audiowide", weights: [400] },
  { family: "Name Russo One", label: "Russo One", weights: [400] },
  { family: "Name Black Ops One", label: "Black Ops One", weights: [400] },
];

let counter = 0;
export function newId(prefix = "l"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function identity(): Transform {
  return { x: DOC_CENTRE, y: DOC_CENTRE, rotation: 0, scaleX: 1, scaleY: 1 };
}

export function solid(color: string): Fill {
  return { kind: "solid", color, color2: "#ffffff", angle: 90 };
}

export function defaultEffects(): Effects {
  return {
    stroke: { on: false, color: "#000000", width: 6, opacity: 1 },
    glow: { on: false, color: "#ff66ab", size: 24, opacity: 0.85, strength: 1 },
    shadow: { on: false, color: "#000000", blur: 12, distance: 6, angle: 90, opacity: 0.6 },
    overlay: { on: false, fill: { kind: "linear", color: "#ff66ab", color2: "#66ccff", angle: 90 }, opacity: 1 },
    repeat: { count: 1, mirror: false },
    adjust: { hue: 0, saturation: 100, brightness: 100, contrast: 100, blur: 0 },
  };
}

export function noMotion(): Motion {
  return { kind: "none", speed: 1, amount: 0.5, phase: 0 };
}

function base(name: string): Omit<LayerBase, "id"> & { id: string } {
  return { id: newId(), name, visible: true, locked: false, opacity: 1, blend: "source-over", clip: false, transform: identity(), effects: defaultEffects(), motion: noMotion() };
}

export function newPaintLayer(name: string): PaintLayer {
  return { ...base(name), kind: "paint" };
}

export function newImageLayer(name: string, asset: string, width: number, height: number): ImageLayer {
  return { ...base(name), kind: "image", asset, width, height };
}

export function newShapeLayer(name: string, shape: ShapeKind, color: string, overrides: Partial<ShapeLayer> = {}): ShapeLayer {
  return {
    ...base(name),
    kind: "shape",
    shape,
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    radius: 0,
    sides: 6,
    inner: 0.5,
    sweep: 90,
    style: shape === "line" || shape === "arc" ? "outline" : "fill",
    lineWidth: 12,
    dash: 0,
    gap: 0,
    cap: "round",
    fill: solid(color),
    ...overrides,
  };
}

export function newTextLayer(name: string, text: string, color: string, overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    ...base(name),
    kind: "text",
    text,
    font: "Torus",
    weight: 800,
    size: 56,
    spacing: 0,
    arc: 0,
    arcBelow: false,
    fill: solid(color),
    italic: false,
    ...overrides,
  };
}

export function newGroupLayer(name: string, children: Layer[] = []): GroupLayer {
  return { ...base(name), kind: "group", children, collapsed: false };
}

export function newPathLayer(name: string, color: string, overrides: Partial<PathLayer> = {}): PathLayer {
  return {
    ...base(name),
    kind: "path",
    points: [],
    closed: false,
    style: "outline",
    lineWidth: 10,
    dash: 0,
    gap: 0,
    cap: "round",
    fill: solid(color),
    ...overrides,
  };
}

export function emptyDoc(name = ""): FrameDoc {
  return { version: 1, name, boards: { square: [], round: [] } };
}

export function blankCanvas(size = DOC_SIZE): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  return canvas;
}

export function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d")!.drawImage(source, 0, 0);
  return canvas;
}

export function maskKey(id: string): string {
  return `${id}:mask`;
}

/* --- The layer tree --------------------------------------------------------------- */

/* Every layer, groups and what's inside them, top-level order first. */
export function walk(layers: readonly Layer[]): Layer[] {
  const out: Layer[] = [];
  for (const layer of layers) {
    out.push(layer);
    if (layer.kind === "group") out.push(...walk(layer.children));
  }
  return out;
}

export function findIn(layers: readonly Layer[], id: string | null): Layer | null {
  if (!id) return null;
  for (const layer of layers) {
    if (layer.id === id) return layer;
    if (layer.kind === "group") {
      const found = findIn(layer.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function findLayer(doc: FrameDoc, board: BoardId, id: string | null): Layer | null {
  return findIn(doc.boards[board], id);
}

/* The group holding a layer (null at the top level), and the list it sits in. */
export function parentOf(layers: Layer[], id: string, parent: string | null = null): { parent: string | null; list: Layer[]; index: number } | null {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index >= 0) return { parent, list: layers, index };
  for (const layer of layers) {
    if (layer.kind !== "group") continue;
    const found = parentOf(layer.children, id, layer.id);
    if (found) return found;
  }
  return null;
}

/* Replaces the list of layers inside `parent` (null for the top level). */
export function withList(layers: Layer[], parent: string | null, list: Layer[]): Layer[] {
  if (parent === null) return list;
  return layers.map((layer) => {
    if (layer.id === parent && layer.kind === "group") return { ...layer, children: list };
    if (layer.kind === "group") return { ...layer, children: withList(layer.children, parent, list) };
    return layer;
  });
}

export function mapTree(layers: Layer[], fn: (layer: Layer) => Layer): Layer[] {
  return layers.map((layer) => {
    const next = fn(layer);
    return next.kind === "group" ? { ...next, children: mapTree(next.children, fn) } : next;
  });
}

export function removeFrom(layers: Layer[], id: string): Layer[] {
  return layers.filter((layer) => layer.id !== id).map((layer) => (layer.kind === "group" ? { ...layer, children: removeFrom(layer.children, id) } : layer));
}

/* Puts a layer just above `above` in the same list, or on top of the top level. */
export function insertInto(layers: Layer[], layer: Layer, above: string | null): Layer[] {
  const place = above ? parentOf(layers, above) : null;
  if (!place) return [...layers, layer];
  const list = [...place.list];
  list.splice(place.index + 1, 0, layer);
  return withList(layers, place.parent, list);
}

export function setBoard(doc: FrameDoc, board: BoardId, layers: Layer[]): FrameDoc {
  return { ...doc, boards: { ...doc.boards, [board]: layers } };
}

export function patchLayer<T extends Layer>(doc: FrameDoc, board: BoardId, id: string, patch: Partial<T>): FrameDoc {
  return setBoard(doc, board, mapTree(doc.boards[board], (layer) => (layer.id === id ? ({ ...layer, ...patch } as Layer) : layer)));
}

/* Every asset or pixel id the document still points at, so the rest can be dropped. */
export function liveIds(doc: FrameDoc): { pixels: Set<string>; assets: Set<string> } {
  const pixels = new Set<string>();
  const assets = new Set<string>();
  for (const layer of walk([...doc.boards.square, ...doc.boards.round])) {
    if (layer.kind === "paint") pixels.add(layer.id);
    if (layer.mask) pixels.add(maskKey(layer.id));
    if (layer.kind === "image") assets.add(layer.asset);
  }
  return { pixels, assets };
}

/* A document read back from storage or a file, checked enough to draw. */
export function parseDoc(raw: unknown): FrameDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<FrameDoc>;
  if (value.version !== 1 || !value.boards || typeof value.boards !== "object") return null;
  const boards = value.boards as Partial<Record<BoardId, unknown>>;
  const layers = (list: unknown): Layer[] => (Array.isArray(list) ? list.filter((layer): layer is Layer => !!layer && typeof layer === "object" && typeof (layer as Layer).id === "string" && ["paint", "image", "shape", "text", "path", "group"].includes((layer as Layer).kind)).map(normalise) : []);
  return {
    version: 1,
    name: typeof value.name === "string" ? value.name.slice(0, 40) : "",
    boards: { square: layers(boards.square), round: layers(boards.round) },
    submitted: typeof value.submitted === "string" && /^u\d{1,12}$/.test(value.submitted) ? value.submitted : null,
  };
}

/* Fills in fields an older draft may lack. */
function normalise(layer: Layer): Layer {
  const effects = defaultEffects();
  const saved = (layer.effects ?? {}) as Partial<Effects>;
  const children = layer.kind === "group" && Array.isArray(layer.children) ? layer.children.filter((child) => child && typeof child === "object" && typeof child.id === "string").map(normalise) : undefined;
  return {
    ...layer,
    ...(layer.kind === "group" ? { children: children ?? [], collapsed: !!layer.collapsed } : {}),
    transform: { ...identity(), ...layer.transform },
    effects: {
      stroke: { ...effects.stroke, ...saved.stroke },
      glow: { ...effects.glow, ...saved.glow },
      shadow: { ...effects.shadow, ...saved.shadow },
      overlay: { ...effects.overlay, ...saved.overlay },
      repeat: { ...effects.repeat, ...saved.repeat },
      adjust: { ...effects.adjust, ...saved.adjust },
    },
    motion: { ...noMotion(), ...layer.motion },
  } as Layer;
}
