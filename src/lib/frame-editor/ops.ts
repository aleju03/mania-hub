import {
  blankCanvas,
  cloneCanvas,
  defaultEffects,
  DOC_CENTRE,
  DOC_SIZE,
  identity,
  findIn,
  insertInto,
  LAYERS_MAX,
  mapTree,
  maskKey,
  newId,
  newImageLayer,
  newGroupLayer,
  newPaintLayer,
  parentOf,
  removeFrom,
  setBoard,
  walk,
  withList,
  type BoardId,
  type EditorState,
  type GroupLayer,
  type Layer,
  type PaintLayer,
  type Transform,
} from "./doc";
import { drawInLayerSpace, type Selection } from "./paint";
import { applyMask, composite, drawContent, layerMatrix, localBox, motionPose, toDoc, type Box } from "./render";

/* Layer operations for the frame editor, each taking a state and giving back
   a new one (pixels are copied, never drawn on in place). */

/* --- Geometry -------------------------------------------------------------------- */

export interface DocBox {
  corners: [number, number][];
  centre: [number, number];
  local: Box;
}

/* The layer's box in the document: its four corners (top left, top right,
   bottom right, bottom left) and centre. */
export function docBox(layer: Layer, pixels: EditorState["pixels"]): DocBox | null {
  const local = localBox(layer, pixels);
  if (!local) return null;
  const corners: [number, number][] = [
    toDoc(layer, local.x0, local.y0),
    toDoc(layer, local.x1, local.y0),
    toDoc(layer, local.x1, local.y1),
    toDoc(layer, local.x0, local.y1),
  ];
  return { corners, centre: toDoc(layer, (local.x0 + local.x1) / 2, (local.y0 + local.y1) / 2), local };
}

export function rotateAbout(t: Transform, px: number, py: number, degrees: number): Transform {
  const rad = (degrees * Math.PI) / 180;
  const dx = t.x - px;
  const dy = t.y - py;
  return { ...t, x: px + dx * Math.cos(rad) - dy * Math.sin(rad), y: py + dx * Math.sin(rad) + dy * Math.cos(rad), rotation: normaliseAngle(t.rotation + degrees) };
}

export function normaliseAngle(degrees: number): number {
  const turned = ((degrees % 360) + 540) % 360 - 180;
  return Math.round(turned * 100) / 100;
}

/* Scales by (fx, fy) along the layer's own axes, keeping the local point (qx, qy) where it is. */
export function scaleAbout(t: Transform, qx: number, qy: number, fx: number, fy: number): Transform {
  const pivot = layerMatrix(t).transformPoint(new DOMPoint(qx, qy));
  const next = { ...t, scaleX: t.scaleX * fx, scaleY: t.scaleY * fy };
  const moved = layerMatrix({ ...next, x: 0, y: 0 }).transformPoint(new DOMPoint(qx, qy));
  return { ...next, x: pivot.x - moved.x, y: pivot.y - moved.y };
}

/* --- Layer list --------------------------------------------------------------------- */

export function layersOf(state: EditorState, board: BoardId): Layer[] {
  return state.doc.boards[board];
}

/* Puts a layer above `above` in the same list (inside a group if `above` is in one), or on top, with its pixels if it's a paint layer. */
export function insertLayer(state: EditorState, board: BoardId, layer: Layer, above: string | null, pixels?: HTMLCanvasElement): EditorState {
  const layers = layersOf(state, board);
  if (walk(layers).length + walk([layer]).length > LAYERS_MAX) return state;
  return {
    ...state,
    doc: setBoard(state.doc, board, insertInto(layers, layer, above)),
    pixels: layer.kind === "paint" && !state.pixels[layer.id] ? { ...state.pixels, [layer.id]: pixels ?? blankCanvas() } : pixels ? { ...state.pixels, [layer.id]: pixels } : state.pixels,
  };
}

export function removeLayer(state: EditorState, board: BoardId, id: string): EditorState {
  return { ...state, doc: setBoard(state.doc, board, removeFrom(layersOf(state, board), id)) };
}

/* A copy of a layer (and everything inside a group) with new ids and copied pixels and masks. */
export function cloneLayerDeep(layer: Layer, state: EditorState, pixels: EditorState["pixels"]): Layer {
  const copy = { ...structuredClone({ ...layer, children: undefined }), id: newId() } as Layer;
  if (layer.kind === "paint" && state.pixels[layer.id]) pixels[copy.id] = cloneCanvas(state.pixels[layer.id]);
  if (layer.mask && state.pixels[maskKey(layer.id)]) pixels[maskKey(copy.id)] = cloneCanvas(state.pixels[maskKey(layer.id)]);
  if (layer.kind === "group" && copy.kind === "group") copy.children = layer.children.map((child) => cloneLayerDeep(child, state, pixels));
  else delete (copy as { children?: unknown }).children;
  return copy;
}

export function duplicateLayer(state: EditorState, board: BoardId, id: string, name: (layer: Layer) => string): { state: EditorState; id: string } | null {
  const layer = findIn(layersOf(state, board), id);
  if (!layer || walk(layersOf(state, board)).length + walk([layer]).length > LAYERS_MAX) return null;
  const pixels = { ...state.pixels };
  const copy = { ...cloneLayerDeep(layer, state, pixels), name: name(layer) } as Layer;
  return { state: { ...state, doc: setBoard(state.doc, board, insertInto(layersOf(state, board), copy, layer.id)), pixels }, id: copy.id };
}

/* Puts the layers of one list (the top level, or a group's) in a new order. */
export function reorder(state: EditorState, board: BoardId, parent: string | null, ids: string[]): EditorState {
  const layers = layersOf(state, board);
  const list = parent === null ? layers : (findIn(layers, parent) as GroupLayer | null)?.children ?? [];
  const byId = new Map(list.map((layer) => [layer.id, layer]));
  const next = ids.map((id) => byId.get(id)).filter((layer): layer is Layer => !!layer);
  if (next.length !== list.length) return state;
  return { ...state, doc: setBoard(state.doc, board, withList(layers, parent, next)) };
}

/* Moves a layer one step up (1) or down (-1) its list. */
export function shiftLayer(state: EditorState, board: BoardId, id: string, direction: 1 | -1): EditorState {
  const layers = layersOf(state, board);
  const place = parentOf(layers, id);
  if (!place) return state;
  const list = [...place.list];
  const to = place.index + direction;
  if (to < 0 || to >= list.length) return state;
  [list[place.index], list[to]] = [list[to], list[place.index]];
  return { ...state, doc: setBoard(state.doc, board, withList(layers, place.parent, list)) };
}

/* Wraps a layer in a new group where it stands. */
export function groupLayer(state: EditorState, board: BoardId, id: string, name: string): { state: EditorState; id: string } | null {
  const layers = layersOf(state, board);
  const place = parentOf(layers, id);
  if (!place || walk(layers).length + 1 > LAYERS_MAX) return null;
  const group = newGroupLayer(name, [place.list[place.index]]);
  const list = [...place.list];
  list[place.index] = group;
  return { state: { ...state, doc: setBoard(state.doc, board, withList(layers, place.parent, list)) }, id: group.id };
}

/* Replaces a group with the layers inside it. */
export function ungroup(state: EditorState, board: BoardId, id: string): EditorState {
  const layers = layersOf(state, board);
  const place = parentOf(layers, id);
  const group = place?.list[place.index];
  if (!place || group?.kind !== "group") return state;
  const list = [...place.list];
  list.splice(place.index, 1, ...group.children);
  return { ...state, doc: setBoard(state.doc, board, withList(layers, place.parent, list)) };
}

/* Moves a layer to the top of a group, or (with `group` null) out of its group, just above it. */
export function moveToGroup(state: EditorState, board: BoardId, id: string, group: string | null): EditorState {
  const layers = layersOf(state, board);
  const layer = findIn(layers, id);
  const place = parentOf(layers, id);
  if (!layer || !place || group === id || (group && layer.kind === "group" && findIn([layer], group))) return state;
  const without = removeFrom(layers, id);
  if (group === null) {
    if (place.parent === null) return state;
    return { ...state, doc: setBoard(state.doc, board, insertInto(without, layer, place.parent)) };
  }
  const target = findIn(without, group);
  if (target?.kind !== "group") return state;
  return { ...state, doc: setBoard(state.doc, board, withList(without, group, [...target.children, layer])) };
}

/* Applies a transform change to a layer, or to every layer inside a group (which keeps none of its own). */
export function transformDeep(layer: Layer, fn: (t: Transform, child: Layer) => Transform): Layer {
  if (layer.kind === "group") return { ...layer, children: layer.children.map((child) => transformDeep(child, fn)) };
  return { ...layer, transform: fn(layer.transform, layer) };
}

/* The layer's content (repeats and adjustments baked in) as document pixels. */
export function bakeContent(layer: Layer, state: EditorState): HTMLCanvasElement {
  const canvas = blankCanvas();
  const input = { pixels: state.pixels, assets: state.assets, size: DOC_SIZE };
  const pose = motionPose({ ...layer.motion, kind: "none" }, 0);
  drawContent(canvas.getContext("2d")!, layer, input, pose);
  applyMask(canvas, layer, input, pose);
  return canvas;
}

/* Turns a shape, text or picture into a paint layer that looks the same. */
export function rasterize(state: EditorState, board: BoardId, id: string): EditorState {
  const layer = findIn(layersOf(state, board), id);
  if (!layer) return state;
  const pixels = bakeContent(layer, state);
  const effects = { ...layer.effects, repeat: defaultEffects().repeat, adjust: defaultEffects().adjust };
  const paint: PaintLayer = { ...newPaintLayer(layer.name), id: layer.id, visible: layer.visible, locked: false, opacity: layer.opacity, blend: layer.blend, clip: layer.clip, effects, motion: layer.motion, mask: null, distort: null };
  return {
    ...state,
    doc: setBoard(state.doc, board, mapTree(layersOf(state, board), (entry) => (entry.id === id ? paint : entry))),
    pixels: { ...state.pixels, [id]: pixels },
  };
}

/* Merges a layer into the one under it, as a paint layer that looks like both. */
export function mergeDown(state: EditorState, board: BoardId, id: string): EditorState {
  const all = layersOf(state, board);
  const place = parentOf(all, id);
  if (!place || place.index <= 0) return state;
  const layers = place.list;
  const below = layers[place.index - 1];
  const top = layers[place.index];
  const canvas = blankCanvas();
  composite(canvas.getContext("2d")!, [{ ...below, visible: true, motion: { ...below.motion, kind: "none" } }, { ...top, clip: top.clip, motion: { ...top.motion, kind: "none" } }], { pixels: state.pixels, assets: state.assets, size: DOC_SIZE });
  const merged: PaintLayer = { ...newPaintLayer(below.name), id: below.id, visible: below.visible };
  return {
    ...state,
    doc: setBoard(state.doc, board, withList(all, place.parent, layers.filter((layer) => layer.id !== top.id).map((layer) => (layer.id === below.id ? merged : layer)))),
    pixels: { ...state.pixels, [below.id]: canvas },
  };
}

/* A paint layer's pixels with the selection cleared (or, with `color`, filled). */
export function editSelection(state: EditorState, board: BoardId, id: string, selection: Selection | null, color: string | null): EditorState {
  const layer = findIn(layersOf(state, board), id);
  if (!layer || layer.kind !== "paint" || layer.locked) return state;
  const pixels = cloneCanvas(state.pixels[id] ?? blankCanvas());
  if (color) {
    const fill = blankCanvas();
    const ctx = fill.getContext("2d")!;
    if (selection) ctx.drawImage(selection.mask, 0, 0);
    else ctx.fillRect(0, 0, DOC_SIZE, DOC_SIZE);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, DOC_SIZE, DOC_SIZE);
    drawInLayerSpace(pixels, fill, layer);
  } else if (selection) {
    drawInLayerSpace(pixels, selection.mask, layer, "destination-out");
  } else {
    pixels.getContext("2d")!.clearRect(0, 0, DOC_SIZE, DOC_SIZE);
  }
  return { ...state, pixels: { ...state.pixels, [id]: pixels } };
}

/* What a layer shows inside the selection, as document pixels (for copy, or a new layer from it). */
export function copySelection(state: EditorState, board: BoardId, id: string, selection: Selection | null): HTMLCanvasElement | null {
  const layer = findIn(layersOf(state, board), id);
  if (!layer) return null;
  const canvas = bakeContent(layer, state);
  if (selection) {
    const ctx = canvas.getContext("2d")!;
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(selection.mask, 0, 0);
  }
  return canvas;
}

/* A new paint layer holding document pixels. */
export function paintLayerFrom(state: EditorState, board: BoardId, canvas: HTMLCanvasElement, name: string, above: string | null): { state: EditorState; id: string } {
  const layer = newPaintLayer(name);
  return { state: insertLayer(state, board, layer, above, canvas), id: layer.id };
}

/* --- Pictures ------------------------------------------------------------------------ */

const ASSET_MAX = 1536;

/* A picture file as a canvas the editor can keep, at most ASSET_MAX on its long side. */
export async function readPicture(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, ASSET_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/* A picture placed as a layer, fitted inside the canvas. */
export function placePicture(state: EditorState, board: BoardId, picture: HTMLCanvasElement, name: string, above: string | null): { state: EditorState; id: string } {
  const asset = newId("a");
  const fit = Math.min(1, DOC_SIZE / Math.max(picture.width, picture.height));
  const layer = newImageLayer(name, asset, Math.round(picture.width * fit), Math.round(picture.height * fit));
  layer.transform = identity();
  const next = insertLayer({ ...state, assets: { ...state.assets, [asset]: picture } }, board, layer, above);
  return { state: next, id: layer.id };
}

/* Moves the layer so its box centres on the avatar. */
export function centreOnAvatar(layer: Layer, pixels: EditorState["pixels"]): Transform {
  const box = docBox(layer, pixels);
  if (!box) return { ...layer.transform, x: DOC_CENTRE, y: DOC_CENTRE };
  return { ...layer.transform, x: layer.transform.x + DOC_CENTRE - box.centre[0], y: layer.transform.y + DOC_CENTRE - box.centre[1] };
}
