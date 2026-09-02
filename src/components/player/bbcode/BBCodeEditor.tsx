import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ALargeSmall,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ClipboardPaste,
  Code,
  Copy,
  Crop,
  Eraser,
  ExternalLink,
  EyeOff,
  Heading1,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Map,
  Megaphone,
  Music,
  Palette,
  Pencil,
  Plus,
  Rainbow,
  Replace,
  Scaling,
  Scissors,
  Strikethrough,
  TextQuote,
  Trash2,
  Underline,
  Unlink,
  UserRound,
  X,
  Youtube,
} from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { buildGradientBBCode, containsBBCode, findBBNodePathAtOffset, gradientCharColors, normalizeHexColor, parseBBCode, parseYoutubeInput, shiftHexHue, type BBAlign, type BBSourceSpan } from "../../../lib/bbcode";
import {
  ALIGN_SELECTOR,
  applyColorSequence,
  bbcodeToEditableHtml,
  captureColorSequence,
  cssColorToBB,
  distributeInlineWrap,
  editableWrapMarkup,
  elementAlign,
  escapeBBHtml,
  serializeBBCodeDom,
  unwrapAligns,
  type EditableWrapKind,
} from "../../../lib/bbcode-dom";
import { getUser, searchUsers } from "../../../lib/osu";
import {
  fetchImageBlobViaProxy,
  isUploadableImage,
  MAX_IMAGE_UPLOAD_BYTES,
  uploadImageToCatbox,
} from "../../../lib/catbox-upload";
import {
  encodeImageAtDisplayWidth,
  measureImageContent,
  type EncodePlan,
  type ImageAlign,
  type ImageContentRect,
} from "../../../lib/image-resize";
import { OSU_PROFILE_COLUMN_WIDTH, columnFitScale, shouldOpenAtActualSize } from "../../../lib/bbcode-layout";
import { pendingBlobUrls, resolvePendingBlobUrls, stripPendingImages } from "../../../lib/bbcode-pending-images";
import { SearchInput } from "../../ui/SearchInput";
import { BBCodePreview, pickHighlightNode } from "./BBCodePreview";
import { BBCodeContextMenu, type ContextMenuItem, type ContextMenuState } from "./BBCodeContextMenu";
import { ImageEditorModal, type ImageEditorSource } from "./ImageEditorModal";

const DRAFT_KEY_PREFIX = "mania-hub-bbcode-draft-v1:";
// Fit-the-pane or osu!'s own size, kept out of the draft so it survives a reset
// and follows the device rather than the page being written.
const COLUMN_ZOOM_KEY = "mania-hub-bbcode-zoom-v1";
const DRAFT_SAVE_DEBOUNCE_MS = 400;
const VISUAL_SYNC_DEBOUNCE_MS = 300;
// How long a resize may run before it is worth saying so. Below this it reads
// as instant, and the status row would only make the docked inspector jump.
const RESIZE_STATUS_DELAY_MS = 250;
// A promise-backed ClipboardItem reserves permission while images upload, but
// a browser is allowed to leave that write pending. Do not call that an upload
// failure forever: fall back to writeText once the hosted source is ready.
const CLIPBOARD_RESERVATION_TIMEOUT_MS = 1_500;

const COLOR_SWATCHES = [
  "#FFFFFF", "#FF66AA", "#B14DE8", "#66A4FF", "#5EE08A",
  "#FFD53D", "#FF7A2F", "#FF4D5E", "#9AA0B0", "#000000",
];

const SIZE_PRESETS: Array<{ label: ReturnType<typeof msg>; value: number }> = [
  { label: msg`Tiny`, value: 50 },
  { label: msg`Small`, value: 85 },
  { label: msg`Normal`, value: 100 },
  { label: msg`Large`, value: 150 },
];

const GRADIENT_PRESETS: Array<{ label: ReturnType<typeof msg>; stops: string[]; mirror: boolean }> = [
  { label: msg`Gold`, stops: ["#E6821E", "#FDE071"], mirror: true },
  { label: msg`Pink`, stops: ["#FF66AA", "#FFD1E8"], mirror: true },
  { label: msg`Purple`, stops: ["#B14DE8", "#FF9ECF"], mirror: false },
  { label: msg`Rainbow`, stops: ["#FF4D5E", "#FFB42F", "#FFE45E", "#5EE08A", "#66A4FF", "#B14DE8"], mirror: false },
];

const GRADIENT_MAX_STOPS = 6;

const IMAGEMAP_TEMPLATE = "[imagemap]\nhttps://example.com/image.png\n0 0 50 100 https://example.com left half tooltip\n50 0 50 100 https://osu.ppy.sh right half tooltip\n[/imagemap]";
const IMAGEMAP_AREA_SELECTOR = '[data-bb-imagemap-area="1"]';

type EditMode = "visual" | "code";

type ToolDialog =
  | "color" | "gradient" | "size" | "link" | "image"
  | "youtube" | "audio" | "profile" | "box";

type ImagemapField = "x" | "y" | "width" | "height" | "href" | "title";
type ImagemapDragKind = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

interface ImagemapAreaFields {
  x: string;
  y: string;
  width: string;
  height: string;
  href: string;
  title: string;
}

interface ImagemapSelection extends ImagemapAreaFields {
  areaIndex: number;
  areaCount: number;
}

interface ImagemapDragState {
  areaEl: HTMLElement;
  mapEl: HTMLElement;
  kind: ImagemapDragKind;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

interface LinkSelection {
  href: string;
  text: string;
  bare: boolean;
}

interface SelectionSnapshot {
  start: number;
  end: number;
  text: string;
}

interface ImageSelection {
  src: string;
  href: string;
}

function rgbToHex(value: string): string | null {
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(value.trim());
  if (!match) return null;
  return `#${match.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Reads an explicit color off one element (our spans stamp data-bb-color),
    resolving named colors like "green" to a hex the color picker can show. */
function readElementColor(el: HTMLElement): string | null {
  const attr = el.getAttribute("data-bb-color");
  if (attr) {
    const hex = normalizeHexColor(attr);
    if (hex) return hex;
    // Named color: resolve via the element's computed color (it carries it).
    const computed = typeof window !== "undefined" ? rgbToHex(window.getComputedStyle(el).color) : null;
    return computed ?? attr.toUpperCase();
  }
  const inline = el.style?.color;
  if (inline) return rgbToHex(inline) ?? normalizeHexColor(inline);
  return null;
}

/** Reads an explicit [size] percent off one element. */
function readElementSize(el: HTMLElement): number | null {
  const attr = el.getAttribute("data-bb-size");
  if (attr) {
    const value = Number(attr);
    return Number.isFinite(value) ? value : null;
  }
  const match = /^(\d+)%$/.exec(el.style?.fontSize ?? "");
  return match ? Number(match[1]) : null;
}

/** Pointer travel before a press on an image becomes a reorder drag. */
const IMAGE_REORDER_THRESHOLD_PX = 6;

function isLineBreak(node: Node | null): node is HTMLBRElement {
  return node?.nodeType === 1 && (node as Element).tagName === "BR";
}

/**
 * The node an image travels as when it is dragged to a new spot: the image,
 * the link that wraps only it, and any align block that holds only that.
 */
function imageReorderUnit(img: HTMLImageElement, root: HTMLElement): HTMLElement {
  let unit: HTMLElement = img;
  while (unit.parentElement && unit.parentElement !== root) {
    const parent = unit.parentElement;
    if (!parent.matches('a[data-bb="url"], center, div[data-bb="align"]')) break;
    const alone = Array.from(parent.childNodes).every((node) =>
      node === unit || (node.nodeType === 3 && !(node.nodeValue ?? "").trim()));
    if (!alone) break;
    unit = parent;
  }
  return unit;
}

/** Images that can be reordered: real [img]s, not embed thumbnails or imagemaps. */
function reorderableImages(root: HTMLElement): HTMLImageElement[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>("img"))
    .filter((img) => !img.closest(".bbcode-editor-embed, .imagemap"));
}

/**
 * Moves `unit` next to `target`. The line break that separated the moved image
 * from its neighbours travels with it, so images stacked one per line stay
 * one per line; an image set inline with other content moves alone.
 */
function moveImageUnit(unit: HTMLElement, target: HTMLElement, side: "before" | "after") {
  let br: HTMLBRElement | null = null;
  if (isLineBreak(unit.nextSibling)) br = unit.nextSibling;
  else if (isLineBreak(unit.previousSibling)) br = unit.previousSibling;
  br?.remove();
  unit.remove();
  if (side === "before") target.before(...(br ? [unit, br] : [unit]));
  else target.after(...(br ? [br, unit] : [unit]));
}

/** caretRangeFromPoint with a Firefox (caretPositionFromPoint) fallback. */
function caretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") return doc.caretRangeFromPoint(x, y);
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

/** Walks ancestors from a selection node up to (not including) the surface. */
function climbForValue<T>(node: Node | null, root: HTMLElement, read: (el: HTMLElement) => T | null): T | null {
  let el: HTMLElement | null = node
    ? (node.nodeType === 3 ? node.parentElement : (node as HTMLElement))
    : null;
  while (el && el !== root && root.contains(el)) {
    const value = read(el);
    if (value != null) return value;
    el = el.parentElement;
  }
  return null;
}

// Placeholder dropped into code-mode source while an image uploads; stripped
// from anything serialized/persisted so a stray token never reaches output.
// editableWrapMarkup kinds that render as block elements (their open/close can
// legitimately contain block lines); everything else is an inline wrap.
const BLOCK_WRAP_KINDS = new Set<EditableWrapKind>([
  "heading", "centre", "left", "right", "notice", "quote", "codeblock", "box",
]);

/** The three toolbar wraps that set alignment, in EditableWrapKind terms. */
const ALIGN_WRAP_KINDS: Partial<Record<EditableWrapKind, BBAlign>> = {
  centre: "centre",
  left: "left",
  right: "right",
};

const UPLOAD_TOKEN_PATTERN = /\[uploading image #up-\d+\]/g;
function stripUploadTokens(value: string): string {
  return value.replace(UPLOAD_TOKEN_PATTERN, "");
}

// Pasted/dropped images are held as local blob: URLs until the user copies, then
// uploaded and swapped for real URLs. Blob URLs are session-only, so they're
// stripped from the saved draft (a reloaded blob URL points at nothing).

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota or privacy mode; the editor keeps working without drafts.
  }
}

function clearStored(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

async function waitForReservedClipboardWrite(write: Promise<void>): Promise<void> {
  let timeout: number | null = null;
  try {
    await Promise.race([
      write,
      new Promise<void>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error("Reserved clipboard write timed out.")),
          CLIPBOARD_RESERVATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout != null) window.clearTimeout(timeout);
  }
}

function formatImagemapNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(3)).toString();
}

function clampImagemapNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampImagemapPercent(value: string, fallback: string, min = 0): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return formatImagemapNumber(Math.min(100, Math.max(min, parsed)));
}

function getImagemapAreas(mapEl: HTMLElement): HTMLElement[] {
  return Array.from(mapEl.querySelectorAll<HTMLElement>(IMAGEMAP_AREA_SELECTOR));
}

function readImagemapAreaFields(areaEl: HTMLElement): ImagemapAreaFields {
  return {
    x: areaEl.getAttribute("data-x") ?? "0",
    y: areaEl.getAttribute("data-y") ?? "0",
    width: areaEl.getAttribute("data-width") ?? "10",
    height: areaEl.getAttribute("data-height") ?? "10",
    href: areaEl.getAttribute("data-href") ?? "",
    title: areaEl.getAttribute("data-title") ?? "",
  };
}

function applyImagemapAreaFields(areaEl: HTMLElement, fields: ImagemapAreaFields) {
  const current = readImagemapAreaFields(areaEl);
  const x = clampImagemapPercent(fields.x, current.x);
  const y = clampImagemapPercent(fields.y, current.y);
  const width = clampImagemapPercent(fields.width, current.width, 0.1);
  const height = clampImagemapPercent(fields.height, current.height, 0.1);
  const href = fields.href.trim();
  const title = fields.title.trim();

  areaEl.setAttribute("data-x", x);
  areaEl.setAttribute("data-y", y);
  areaEl.setAttribute("data-width", width);
  areaEl.setAttribute("data-height", height);
  areaEl.setAttribute("data-href", href);
  areaEl.setAttribute("data-title", title);
  areaEl.style.left = `${x}%`;
  areaEl.style.top = `${y}%`;
  areaEl.style.width = `${width}%`;
  areaEl.style.height = `${height}%`;
  if (title) areaEl.setAttribute("title", title);
  else areaEl.removeAttribute("title");
}

function reindexImagemapAreas(mapEl: HTMLElement) {
  getImagemapAreas(mapEl).forEach((area, index) => area.setAttribute("data-index", String(index)));
}

function clearImagemapHandles(root: HTMLElement | null) {
  root?.querySelectorAll(".bbcode-imagemap-handle").forEach((handle) => handle.remove());
}

function addImagemapHandles(areaEl: HTMLElement) {
  clearImagemapHandles(areaEl.closest(".bbcode-editor-surface"));
  const handles: ImagemapDragKind[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  for (const kind of handles) {
    const handle = document.createElement("span");
    handle.className = `bbcode-imagemap-handle bbcode-imagemap-handle--${kind}`;
    handle.setAttribute("data-bb-imagemap-handle", kind);
    handle.setAttribute("aria-hidden", "true");
    areaEl.appendChild(handle);
  }
}

/** What a resized image was cut from, and what the file on screen is made of. */
interface ImageOrigin {
  /** The bytes a re-cut goes back to, at their own resolution. */
  blob: Blob;
  /** Width of the picture inside those bytes, margins excluded. */
  naturalWidth: number;
  /** Where the picture sits inside `blob`, when that file has margins of its own. */
  sourceRect?: ImageContentRect;
  /** Geometry of the file currently at this src, when it carries margins. */
  layout?: EncodePlan;
}

/**
 * Share of an image's box the picture fills.
 *
 * All of it, unless the file was padded to place a smaller picture in the
 * column - then the margins are part of the box and nothing on screen should be
 * measured against its edges.
 */
function contentRatios(layout: EncodePlan | undefined): { left: number; width: number } {
  if (!layout?.padded || layout.fileWidth <= 0) return { left: 0, width: 1 };
  return { left: layout.contentLeft / layout.fileWidth, width: layout.contentWidth / layout.fileWidth };
}

/**
 * True when nothing else sits on the image's line.
 *
 * Padding takes an image's box out to the full column, so it is only safe where
 * nothing shares the row: a line of badges or an image set in a sentence would
 * be pushed apart by margins that are invisible but still take up space.
 */
/**
 * Whether an element opens a line of its own on the editable surface.
 *
 * Read off the rendered box rather than a tag list, so a [centre] (a <center>),
 * a [notice] (a styled div) and a contentEditable line div all count without
 * having to be enumerated.
 */
function isBlockLevel(el: Element): boolean {
  const display = window.getComputedStyle(el).display;
  return display !== "inline" && display !== "inline-block" && display !== "contents";
}

function isAloneOnItsLine(node: HTMLElement): boolean {
  const scan = (key: "previousSibling" | "nextSibling"): boolean => {
    for (let sibling = node[key]; sibling; sibling = sibling[key]) {
      if (sibling.nodeType === Node.TEXT_NODE) {
        if ((sibling.textContent ?? "").trim() !== "") return false;
        continue;
      }
      if (sibling.nodeType !== Node.ELEMENT_NODE) continue;
      return (sibling as HTMLElement).tagName === "BR";
    }
    return true;
  };
  return scan("previousSibling") && scan("nextSibling");
}

/** Which side a padded file's own margins already hold its picture to. */
function marginAlign(layout: EncodePlan): ImageAlign {
  const margin = layout.fileWidth - layout.contentWidth;
  if (layout.contentLeft <= 0) return "left";
  if (layout.contentLeft >= margin) return "right";
  return "center";
}

/** Which side of the column the picture is held to, so margins go on the other. */
function effectiveAlign(node: HTMLElement): ImageAlign {
  const align = window.getComputedStyle(node.parentElement ?? node).textAlign;
  if (align === "center") return "center";
  if (align === "right" || align === "end") return "right";
  return "left";
}

/**
 * Hands layout back to the image's own pixels after a drag.
 *
 * Only safe once the re-encoded file is in place, since until then the natural
 * size is still the pre-resize one.
 */
function endResizePreview(img: HTMLImageElement) {
  img.classList.remove("is-resizing");
  img.style.removeProperty("width");
  img.style.removeProperty("height");
}

/**
 * Decodes `src` in a detached image before anything on screen points at it.
 *
 * Assigning a src the browser has not decoded yet empties the element until it
 * has, so warming it here is what makes the swap a single frame instead of a
 * blink through nothing.
 */
async function preloadImage(src: string): Promise<void> {
  try {
    // globalThis.Image: the lucide `Image` icon import shadows the constructor
    // here, the same way it does for Map.
    const loader = new globalThis.Image();
    loader.src = src;
    await loader.decode();
  } catch {
    // decode() is absent on older browsers and rejects on a broken image; the
    // swap still happens, it just is not guaranteed to be seamless.
  }
}

function removeImageResizeHandle(frame: HTMLElement | null) {
  frame
    ?.querySelectorAll(".bbcode-image-resize-handle, .bbcode-image-resize-readout, .bbcode-image-outline")
    .forEach((node) => node.remove());
}

function updateImagemapRaw(mapEl: HTMLElement) {
  const src = mapEl.getAttribute("data-src")
    ?? mapEl.querySelector<HTMLImageElement>(".imagemap__image")?.getAttribute("src")
    ?? "";
  const currentRaw = mapEl.getAttribute("data-raw") ?? "";
  const prefix = currentRaw.startsWith("\n") ? "\n" : "";
  const suffix = currentRaw.endsWith("\n") ? "\n" : "";
  const lines = [src];
  for (const area of getImagemapAreas(mapEl)) {
    const fields = readImagemapAreaFields(area);
    const href = fields.href.trim() || "#";
    const title = fields.title.trim();
    lines.push(`${fields.x} ${fields.y} ${fields.width} ${fields.height} ${href}${title ? ` ${title}` : ""}`);
  }
  mapEl.setAttribute("data-raw", `${prefix}${lines.join("\n")}${suffix}`);
}

function fieldsFromImagemapDrag(state: ImagemapDragState, clientX: number, clientY: number): ImagemapAreaFields {
  const rect = state.mapEl.getBoundingClientRect();
  const dx = rect.width > 0 ? ((clientX - state.startClientX) / rect.width) * 100 : 0;
  const dy = rect.height > 0 ? ((clientY - state.startClientY) / rect.height) * 100 : 0;
  const minSize = 0.1;
  const current = readImagemapAreaFields(state.areaEl);

  if (state.kind === "move") {
    return {
      ...current,
      x: formatImagemapNumber(clampImagemapNumber(state.startX + dx, 0, 100 - state.startWidth)),
      y: formatImagemapNumber(clampImagemapNumber(state.startY + dy, 0, 100 - state.startHeight)),
      width: formatImagemapNumber(state.startWidth),
      height: formatImagemapNumber(state.startHeight),
    };
  }

  let left = state.startX;
  let top = state.startY;
  let right = state.startX + state.startWidth;
  let bottom = state.startY + state.startHeight;

  if (state.kind.includes("w")) left = clampImagemapNumber(state.startX + dx, 0, right - minSize);
  if (state.kind.includes("e")) right = clampImagemapNumber(state.startX + state.startWidth + dx, left + minSize, 100);
  if (state.kind.includes("n")) top = clampImagemapNumber(state.startY + dy, 0, bottom - minSize);
  if (state.kind.includes("s")) bottom = clampImagemapNumber(state.startY + state.startHeight + dy, top + minSize, 100);

  return {
    ...current,
    x: formatImagemapNumber(left),
    y: formatImagemapNumber(top),
    width: formatImagemapNumber(right - left),
    height: formatImagemapNumber(bottom - top),
  };
}

/** Inserts text at the textarea selection, keeping the native undo stack alive. */
function insertAtSelection(el: HTMLTextAreaElement, text: string) {
  el.focus();
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (inserted) return;
  const { selectionStart, selectionEnd, value } = el;
  const next = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  const caret = selectionStart + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors duration-[120ms] cursor-pointer shrink-0 ${
        active
          ? "bg-osu-h1/20 text-osu-c1 border border-osu-h1/40"
          : "text-osu-l2 border border-transparent hover:bg-osu-b3/60 hover:text-osu-c1"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Where the pane is looking, when the column is wider than the pane.
 *
 * At osu!'s own size on a phone the pane is a window onto a page nearly three
 * times as wide, and a page that is centred in its column leaves the two edges
 * off screen with nothing to say they are there. This is that "there is more
 * either way, and you are here" - a plain scrollbar, since the browser only
 * flashes its own while a touch scroll is actually moving.
 */
function ColumnScrollPosition({ frameRef }: { frameRef: RefObject<HTMLDivElement | null> }) {
  const [overflows, setOverflows] = useState(false);
  const thumbRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const hidden = frame.scrollWidth - frame.clientWidth;
      setOverflows((prev) => (prev === hidden > 1 ? prev : hidden > 1));
      const thumb = thumbRef.current;
      if (!thumb || hidden <= 1) return;
      thumb.style.width = `${(frame.clientWidth / frame.scrollWidth) * 100}%`;
      thumb.style.left = `${(frame.scrollLeft / frame.scrollWidth) * 100}%`;
    };
    update();
    frame.addEventListener("scroll", update, { passive: true });
    // The frame keeps its size when the column's zoom changes, so watch the
    // column itself as well or the thumb would keep a stale width.
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    if (frame.firstElementChild) observer.observe(frame.firstElementChild);
    return () => {
      frame.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [frameRef, overflows]);

  if (!overflows) return null;
  return (
    <div className="relative h-[3px] mx-3 mb-1 rounded-full bg-osu-b3/40">
      <div ref={thumbRef} className="absolute inset-y-0 rounded-full bg-osu-f1/60" />
    </div>
  );
}

function ToolDivider() {
  return <div className="w-px h-5 bg-osu-b3/60 mx-1 shrink-0" />;
}

function DialogField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] font-semibold text-osu-f1 uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

const dialogInputClass = "w-full px-2.5 py-1.5 rounded-md bg-osu-b5 text-osu-c1 text-[13px] placeholder:text-osu-f1 border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none";
const dialogApplyClass = "px-3 py-1.5 rounded-md bg-osu-h1/20 border border-osu-h1/40 text-[12px] font-semibold text-osu-c1 hover:bg-osu-h1/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default";

export function BBCodeEditor({
  userId,
  username,
  initialSource,
  onClose,
  enableLoadFromUser = false,
  enableLoadOwnPage = false,
}: {
  userId: number | null;
  username?: string;
  initialSource: string | null;
  onClose?: () => void;
  enableLoadFromUser?: boolean;
  enableLoadOwnPage?: boolean;
}) {
  const { t, i18n } = useLingui();
  const draftKey = `${DRAFT_KEY_PREFIX}${userId ?? "guest"}`;
  const baseSource = initialSource ?? "";
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [source, setSource] = useState<string>(baseSource);
  const [editMode, setEditMode] = useState<EditMode>("visual");
  const [dialog, setDialog] = useState<ToolDialog | null>(null);
  const [mobilePane, setMobilePane] = useState<"write" | "preview">("write");
  // "fit" shrinks osu!'s 890px column into the pane, which on a phone leaves it
  // too small to read; "full" shows the column at osu!'s size and scrolls.
  const [columnZoom, setColumnZoom] = useState<"fit" | "full">("fit");
  // How far the column has to shrink to fit. Below 1 the pane is narrower than
  // a profile, which is the only time the zoom is worth a control.
  const [fitScale, setFitScale] = useState(1);
  // Set once the zoom is settled, by a stored choice or by the pane being too
  // narrow to read, so measuring the pane again never overrides it.
  const zoomChosenRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [loadingUserPage, setLoadingUserPage] = useState(false);
  const [loadStatus, setLoadStatus] = useState<{ kind: "loaded" | "empty" | "error"; name?: string } | null>(null);
  const [inlineStates, setInlineStates] = useState({ bold: false, italic: false, underline: false, strike: false });
  // Alignment of the text under the caret. Nothing around it means left, which
  // is what the page does anyway, so the left button lights up for plain text.
  const [selectionAlign, setSelectionAlign] = useState<BBAlign>("left");
  const [imagemapSelection, setImagemapSelection] = useState<ImagemapSelection | null>(null);
  const [linkSelection, setLinkSelection] = useState<LinkSelection | null>(null);
  const [imageSelection, setImageSelection] = useState<ImageSelection | null>(null);
  const [selectedImageCount, setSelectedImageCount] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [imageEditorState, setImageEditorState] = useState<{ source: ImageEditorSource } | null>(null);
  const [imageEditorBusy, setImageEditorBusy] = useState(false);
  // "resizing" is not an upload: re-cutting an image only re-reads the original
  // bytes and stages the result locally. Nothing leaves the browser until Copy
  // BBCode, so saying "uploading" here would be a lie about where the file is.
  const [uploadStatus, setUploadStatus] = useState<{ kind: "uploading" | "copying" | "resizing" | "error"; message?: string } | null>(null);
  // Kept separate from the delayed resize status: mutations must lock Copy and
  // the resize handle immediately, even when they finish too fast to show UI.
  const [imageMutationBusy, setImageMutationBusy] = useState(false);
  // Color/size of the current visual selection, for toolbar state + dialog prefill.
  const [selectionColor, setSelectionColor] = useState<string | null>(null);
  const [selectionSize, setSelectionSize] = useState<number | null>(null);
  const [focusImageLinkTick, setFocusImageLinkTick] = useState(0);
  // Height of the floating inspector/dialog overlay, so the surface can pad its
  // bottom by that much: bottom padding never shifts content at the current
  // scroll position, and anything the overlay covers stays reachable by scroll.
  const [overlayHeight, setOverlayHeight] = useState(0);
  // Caret offset in the raw-source textarea; the preview highlights its node.
  const [caretOffset, setCaretOffset] = useState<number | null>(null);
  // Bumped whenever the visual surface must be rebuilt from `source`.
  const [visualEpoch, setVisualEpoch] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const visualRef = useRef<HTMLDivElement | null>(null);
  const imagemapElementRef = useRef<HTMLElement | null>(null);
  const imagemapDragRef = useRef<ImagemapDragState | null>(null);
  const linkElementRef = useRef<HTMLAnchorElement | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  // Selection order matters: Ctrl/Cmd-click keeps the first image as the size
  // reference and makes each later image a target for "Match sizes".
  const selectedImageElementsRef = useRef<HTMLImageElement[]>([]);
  const visualFrameRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const resizeHandleRef = useRef<HTMLSpanElement | null>(null);
  const resizeReadoutRef = useRef<HTMLSpanElement | null>(null);
  const resizeOutlineRef = useRef<HTMLSpanElement | null>(null);
  const realignPaddedImageRef = useRef<((img: HTMLImageElement) => void) | null>(null);
  const startImageReorderRef = useRef<((event: PointerEvent, img: HTMLImageElement) => void) | null>(null);
  const imageReorderRef = useRef<{
    img: HTMLImageElement;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    target: { img: HTMLImageElement; side: "before" | "after" } | null;
    line: HTMLSpanElement | null;
  } | null>(null);
  const resizeStatusTimerRef = useRef<number | null>(null);
  const imageMutationInFlightRef = useRef(false);
  const copyInFlightRef = useRef(false);
  const imageResizeRef = useRef<{
    img: HTMLImageElement;
    startX: number;
    /** Width of the picture itself, which is what the drag is sizing. */
    startWidth: number;
    width: number;
    minWidth: number;
    maxWidth: number;
    /** Share of the image box the picture fills, so a padded file previews right. */
    contentRatio: number;
    /** Pointer px per column px, so a scaled-down column still tracks the pointer 1:1. */
    scale: number;
  } | null>(null);
  // The bytes a resized image was last cut from. Re-encoding always goes back to
  // these rather than to whatever is on screen, so dragging an image small and
  // then large again re-cuts from the full-resolution original instead of
  // upscaling a thumbnail - and repeated nudges cost no quality.
  const resizeOriginsRef = useRef<Map<string, ImageOrigin>>(new globalThis.Map());
  const imageEditorTargetRef = useRef<HTMLImageElement | null>(null);
  const replaceTargetRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageLinkInputRef = useRef<HTMLInputElement | null>(null);
  // Pasted/dropped images kept local (blob URL -> file) until Copy BBCode uploads them.
  // globalThis.Map: the lucide `Map` icon import shadows the Map constructor here.
  const pendingUploadsRef = useRef<Map<string, Blob>>(new globalThis.Map());
  const selectionColorRef = useRef<string | null>(null);
  const selectionSizeRef = useRef<number | null>(null);
  const overlayObserverRef = useRef<ResizeObserver | null>(null);
  const sourceRef = useRef(source);
  const selectionRef = useRef<SelectionSnapshot>({ start: 0, end: 0, text: "" });
  const visualRangeRef = useRef<Range | null>(null);
  const visualSyncHandle = useRef<number | null>(null);
  // Format painter: the color sequence copied from one selection to paint another.
  const capturedColorsRef = useRef<(string | null)[] | null>(null);
  const hueShiftRef = useRef(0);
  const deferredSource = useDeferredValue(source);
  const deferredCaretOffset = useDeferredValue(caretOffset);
  // Source range of the node the preview highlights, drawn behind the textarea
  // so both panes mark the same thing.
  const sourceHighlightSpan = useMemo<BBSourceSpan | null>(() => {
    if (deferredCaretOffset == null || editMode !== "code") return null;
    const nodes = parseBBCode(deferredSource, { spans: true });
    const node = pickHighlightNode(findBBNodePathAtOffset(nodes, deferredCaretOffset));
    const span = node?.span;
    if (!span || span.end <= span.start) return null;
    return span;
  }, [deferredCaretOffset, deferredSource, editMode]);
  const sourceBackdropRef = useRef<HTMLDivElement | null>(null);
  const syncSourceBackdrop = useCallback(() => {
    const el = textareaRef.current;
    const backdrop = sourceBackdropRef.current;
    if (!el || !backdrop) return;
    backdrop.scrollTop = el.scrollTop;
    backdrop.scrollLeft = el.scrollLeft;
    backdrop.style.right = `${el.offsetWidth - el.clientWidth}px`;
  }, []);
  useEffect(() => {
    syncSourceBackdrop();
  }, [sourceHighlightSpan, syncSourceBackdrop]);

  // Dialog form state. One dialog is open at a time, so shared fields are fine.
  const [urlField, setUrlField] = useState("");
  const [textField, setTextField] = useState("");
  const [hexField, setHexField] = useState("#FF66AA");
  const [gradientStops, setGradientStops] = useState<string[]>(["#B14DE8", "#FF9ECF"]);
  const [gradientMirror, setGradientMirror] = useState(false);
  const [customSize, setCustomSize] = useState("100");
  const [hasCapturedFormat, setHasCapturedFormat] = useState(false);
  const [hueShift, setHueShift] = useState(0);

  const updateSource = useCallback((next: string) => {
    sourceRef.current = next;
    setSource(next);
  }, []);

  // The draft only exists in localStorage, so restoring it while rendering would
  // make the first client render disagree with the server's (the "load a me!
  // page" row keys off an empty source) and React would throw the hydrated tree
  // away. Restore right after mount instead, and rebuild the visual surface the
  // same way every other out-of-band source change does.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    const draft = readStored(draftKey);
    if (draft == null || draft === baseSource) return;
    setRestoredDraft(true);
    updateSource(draft);
    setVisualEpoch((epoch) => epoch + 1);
  }, [baseSource, draftKey, updateSource]);

  // Build (or rebuild) the visual editing surface from the current source.
  useEffect(() => {
    if (editMode !== "visual") return;
    const el = visualRef.current;
    if (!el) return;
    el.innerHTML = bbcodeToEditableHtml(sourceRef.current);
    imagemapElementRef.current = null;
    linkElementRef.current = null;
    imageElementRef.current = null;
    selectedImageElementsRef.current = [];
    setImagemapSelection(null);
    setLinkSelection(null);
    setImageSelection(null);
    setSelectedImageCount(0);
    setContextMenu(null);
  }, [editMode, visualEpoch]);

  const flushVisual = useCallback((): string => {
    const el = visualRef.current;
    if (!el || editMode !== "visual") return sourceRef.current;
    const serialized = serializeBBCodeDom(el);
    if (serialized !== sourceRef.current) updateSource(serialized);
    return serialized;
  }, [editMode, updateSource]);

  const scheduleVisualSync = useCallback(() => {
    if (visualSyncHandle.current != null) window.clearTimeout(visualSyncHandle.current);
    visualSyncHandle.current = window.setTimeout(() => {
      visualSyncHandle.current = null;
      flushVisual();
    }, VISUAL_SYNC_DEBOUNCE_MS);
  }, [flushVisual]);

  useEffect(() => () => {
    if (visualSyncHandle.current != null) window.clearTimeout(visualSyncHandle.current);
  }, []);

  const clearLinkSelection = useCallback(() => {
    visualRef.current
      ?.querySelectorAll<HTMLAnchorElement>("a.is-selected")
      .forEach((anchor) => anchor.classList.remove("is-selected"));
    linkElementRef.current = null;
    setLinkSelection(null);
  }, []);

  const selectLink = useCallback((anchor: HTMLAnchorElement) => {
    const bbKind = anchor.getAttribute("data-bb");
    if (bbKind && bbKind !== "url") {
      clearLinkSelection();
      return;
    }
    clearLinkSelection();
    anchor.classList.add("is-selected");
    linkElementRef.current = anchor;
    setLinkSelection({
      href: anchor.getAttribute("href") ?? "",
      text: anchor.textContent ?? "",
      bare: anchor.getAttribute("data-bare") === "1",
    });
  }, [clearLinkSelection]);

  const updateSelectedLinkHref = useCallback((href: string) => {
    const anchor = linkElementRef.current;
    if (!anchor) return;
    const oldHref = anchor.getAttribute("href") ?? "";
    anchor.setAttribute("href", href);
    anchor.setAttribute("title", href);
    if (anchor.getAttribute("data-bare") === "1" || anchor.textContent === oldHref) {
      anchor.textContent = href;
    }
    setLinkSelection({
      href,
      text: anchor.textContent ?? "",
      bare: anchor.getAttribute("data-bare") === "1",
    });
    scheduleVisualSync();
  }, [scheduleVisualSync]);

  const updateSelectedLinkText = useCallback((text: string) => {
    const anchor = linkElementRef.current;
    if (!anchor) return;
    // Setting textContent would delete a wrapped <img>; leave image-links alone.
    if (anchor.querySelector("img")) return;
    anchor.textContent = text;
    if (text !== (anchor.getAttribute("href") ?? "")) {
      anchor.removeAttribute("data-bare");
    }
    setLinkSelection({
      href: anchor.getAttribute("href") ?? "",
      text,
      bare: anchor.getAttribute("data-bare") === "1",
    });
    scheduleVisualSync();
  }, [scheduleVisualSync]);


  const removeSelectedLink = useCallback(() => {
    const anchor = linkElementRef.current;
    if (!anchor) return;
    const fragment = document.createDocumentFragment();
    while (anchor.firstChild) fragment.appendChild(anchor.firstChild);
    anchor.replaceWith(fragment);
    clearLinkSelection();
    scheduleVisualSync();
  }, [clearLinkSelection, scheduleVisualSync]);

  const clearImagemapSelection = useCallback(() => {
    const root = visualRef.current;
    clearImagemapHandles(root);
    root
      ?.querySelectorAll<HTMLElement>(".imagemap__link.is-selected")
      .forEach((area) => area.classList.remove("is-selected"));
    imagemapDragRef.current = null;
    imagemapElementRef.current = null;
    setImagemapSelection(null);
  }, []);

  const clearImageSelection = useCallback(() => {
    visualRef.current
      ?.querySelectorAll<HTMLImageElement>("img.is-selected")
      .forEach((img) => img.classList.remove("is-selected"));
    selectedImageElementsRef.current = [];
    imageElementRef.current = null;
    setSelectedImageCount(0);
    setImageSelection(null);
  }, []);

  const selectImage = useCallback((img: HTMLImageElement, additive = false) => {
    clearLinkSelection();
    clearImagemapSelection();
    const connected = selectedImageElementsRef.current.filter((selected) => selected.isConnected);
    let next: HTMLImageElement[];
    if (additive) {
      next = connected.includes(img)
        ? connected.filter((selected) => selected !== img)
        : [...connected, img];
    } else {
      next = [img];
    }

    visualRef.current
      ?.querySelectorAll<HTMLImageElement>("img.is-selected")
      .forEach((other) => other.classList.toggle("is-selected", next.includes(other)));
    selectedImageElementsRef.current = next;
    setSelectedImageCount(next.length);

    const active = next.at(-1) ?? null;
    imageElementRef.current = active;
    if (!active) {
      setImageSelection(null);
      return;
    }
    active.classList.add("is-selected");
    const anchor = active.closest<HTMLAnchorElement>('a[data-bb="url"]');
    setImageSelection({
      src: active.getAttribute("src") ?? "",
      href: anchor?.getAttribute("href") ?? "",
    });
  }, [clearImagemapSelection, clearLinkSelection]);

  /**
   * Puts a real DOM range around the selected image (or its sole-wrapping link)
   * so toolbar wraps like [centre] act on the image instead of dropping the
   * placeholder word at a stray caret. Returns true if an image was selected.
   */
  const selectImageRange = useCallback((): boolean => {
    const img = imageElementRef.current;
    const el = visualRef.current;
    if (!img || !img.isConnected || !el || !el.contains(img)) return false;
    // Formatting actions operate on one DOM range. If several images were
    // selected for size matching, keep the active one and make that scope
    // change visible instead of silently wrapping just one of many highlights.
    if (selectedImageElementsRef.current.length > 1) {
      selectedImageElementsRef.current.forEach((selected) => {
        if (selected !== img) selected.classList.remove("is-selected");
      });
      selectedImageElementsRef.current = [img];
      setSelectedImageCount(1);
    }
    el.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return false;
    const anchor = img.closest<HTMLAnchorElement>('a[data-bb="url"]');
    const target = anchor && anchor.querySelectorAll("img").length === 1 && (anchor.textContent ?? "").trim() === ""
      ? anchor
      : img;
    const range = document.createRange();
    range.selectNode(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, []);

  // After a wrap replaces a selected image node, re-point to the fresh element.
  // A wrap can also be [centre], which an image sized by margins cannot answer
  // without re-cutting them, so the realign below is part of finishing the wrap.
  const resyncImageAfterWrap = useCallback(() => {
    const stale = imageElementRef.current;
    if (!stale) return;
    if (stale.isConnected) {
      realignPaddedImageRef.current?.(stale);
      return;
    }
    const fresh = visualRef.current?.querySelector<HTMLImageElement>("img.is-selected");
    if (!fresh) {
      clearImageSelection();
      return;
    }
    selectedImageElementsRef.current = [fresh];
    imageElementRef.current = fresh;
    setSelectedImageCount(1);
    setImageSelection({
      src: fresh.getAttribute("src") ?? "",
      href: fresh.closest<HTMLAnchorElement>('a[data-bb="url"]')?.getAttribute("href") ?? "",
    });
    realignPaddedImageRef.current?.(fresh);
  }, [clearImageSelection]);

  const selectImagemapArea = useCallback((areaEl: HTMLElement) => {
    const mapEl = areaEl.closest<HTMLElement>('.imagemap[data-bb="imagemap"]');
    if (!mapEl) return;
    visualRef.current
      ?.querySelectorAll<HTMLElement>(".imagemap__link.is-selected")
      .forEach((area) => area.classList.remove("is-selected"));
    areaEl.classList.add("is-selected");
    addImagemapHandles(areaEl);
    imagemapElementRef.current = mapEl;
    const areas = getImagemapAreas(mapEl);
    const index = Math.max(0, areas.indexOf(areaEl));
    clearLinkSelection();
    setImagemapSelection({
      ...readImagemapAreaFields(areaEl),
      areaIndex: index,
      areaCount: areas.length,
    });
  }, [clearLinkSelection]);

  const pickImagemapAreaAtPoint = useCallback((mapEl: HTMLElement, clientX: number, clientY: number): HTMLElement | null => {
    const rect = mapEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return getImagemapAreas(mapEl).reverse().find((area) => {
      const fields = readImagemapAreaFields(area);
      const left = Number(fields.x);
      const top = Number(fields.y);
      const width = Number(fields.width);
      const height = Number(fields.height);
      return x >= left && x <= left + width && y >= top && y <= top + height;
    }) ?? null;
  }, []);

  const selectImagemapAreaByIndex = useCallback((index: number) => {
    const mapEl = imagemapElementRef.current;
    if (!mapEl) return;
    const areas = getImagemapAreas(mapEl);
    if (areas.length === 0) {
      clearImagemapSelection();
      return;
    }
    const wrapped = (index + areas.length) % areas.length;
    selectImagemapArea(areas[wrapped]);
  }, [clearImagemapSelection, selectImagemapArea]);

  const commitImagemapAreaElement = useCallback((areaEl: HTMLElement, mapEl: HTMLElement, fields: ImagemapAreaFields) => {
    applyImagemapAreaFields(areaEl, fields);
    updateImagemapRaw(mapEl);
    scheduleVisualSync();
    const areas = getImagemapAreas(mapEl);
    setImagemapSelection({
      ...readImagemapAreaFields(areaEl),
      areaIndex: Math.max(0, areas.indexOf(areaEl)),
      areaCount: areas.length,
    });
  }, [scheduleVisualSync]);

  const commitImagemapAreaFields = useCallback((fields: ImagemapAreaFields) => {
    const mapEl = imagemapElementRef.current;
    if (!mapEl || !imagemapSelection) return;
    const areaEl = getImagemapAreas(mapEl)[imagemapSelection.areaIndex];
    if (!areaEl) return;
    commitImagemapAreaElement(areaEl, mapEl, fields);
  }, [commitImagemapAreaElement, imagemapSelection]);

  const handleImagemapPointerMove = useCallback((event: PointerEvent) => {
    const drag = imagemapDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    commitImagemapAreaElement(drag.areaEl, drag.mapEl, fieldsFromImagemapDrag(drag, event.clientX, event.clientY));
  }, [commitImagemapAreaElement]);

  const stopImagemapDrag = useCallback((event: PointerEvent) => {
    const drag = imagemapDragRef.current;
    if (drag && event.pointerId !== drag.pointerId) return;
    imagemapDragRef.current = null;
    document.removeEventListener("pointermove", handleImagemapPointerMove);
    document.removeEventListener("pointerup", stopImagemapDrag);
    document.removeEventListener("pointercancel", stopImagemapDrag);
  }, [handleImagemapPointerMove]);

  const handleVisualPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    const mapEl = target?.closest?.<HTMLElement>('.imagemap[data-bb="imagemap"]') ?? null;
    const root = visualRef.current;
    if (!root || !target) return;
    // Box header chip: the triangle/button toggles the box open or closed;
    // clicks on the title text still edit it. `is-open` is view-only state,
    // so collapsing never changes the serialized BBCode.
    const boxLink = target.closest<HTMLElement>(".js-spoilerbox__link");
    if (boxLink && root.contains(boxLink) && !target.closest('[data-bb-role="box-title"]')) {
      event.preventDefault();
      boxLink.closest(".js-spoilerbox")?.classList.toggle("is-open");
      return;
    }
    if (!mapEl || !root.contains(mapEl)) {
      if (imagemapSelection && root.contains(target)) clearImagemapSelection();
      const img = target.closest<HTMLImageElement>("img");
      if (img && root.contains(img) && !img.closest(".bbcode-editor-embed")) {
        event.preventDefault();
        const additive = event.ctrlKey || event.metaKey;
        selectImage(img, additive);
        if (!additive) startImageReorderRef.current?.(event.nativeEvent, img);
        return;
      }
      if (imageSelection && root.contains(target)) clearImageSelection();
      // Link selection is driven by the caret (selectionchange) instead of being
      // stolen here, so clicking inside link text drops the cursor where clicked.
      return;
    }

    const directArea = target.closest<HTMLElement>(IMAGEMAP_AREA_SELECTOR);
    const areaEl = directArea && mapEl.contains(directArea)
      ? directArea
      : pickImagemapAreaAtPoint(mapEl, event.clientX, event.clientY);
    if (!areaEl) return;
    event.preventDefault();
    event.stopPropagation();
    selectImagemapArea(areaEl);

    const handle = target.closest<HTMLElement>("[data-bb-imagemap-handle]");
    const handleKind = handle?.getAttribute("data-bb-imagemap-handle") as ImagemapDragKind | null;
    const fields = readImagemapAreaFields(areaEl);
    imagemapDragRef.current = {
      areaEl,
      mapEl,
      kind: handleKind ?? "move",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: Number(fields.x) || 0,
      startY: Number(fields.y) || 0,
      startWidth: Number(fields.width) || 0.1,
      startHeight: Number(fields.height) || 0.1,
    };
    document.addEventListener("pointermove", handleImagemapPointerMove);
    document.addEventListener("pointerup", stopImagemapDrag);
    document.addEventListener("pointercancel", stopImagemapDrag);
  }, [
    clearImageSelection,
    clearImagemapSelection,
    handleImagemapPointerMove,
    imageSelection,
    imagemapSelection,
    pickImagemapAreaAtPoint,
    selectImage,
    selectImagemapArea,
    stopImagemapDrag,
  ]);

  useEffect(() => () => {
    document.removeEventListener("pointermove", handleImagemapPointerMove);
    document.removeEventListener("pointerup", stopImagemapDrag);
    document.removeEventListener("pointercancel", stopImagemapDrag);
  }, [handleImagemapPointerMove, stopImagemapDrag]);

  const updateImagemapSelectionField = useCallback((field: ImagemapField, value: string) => {
    setImagemapSelection((current) => {
      if (!current) return current;
      const next = { ...current, [field]: value };
      commitImagemapAreaFields(next);
      return next;
    });
  }, [commitImagemapAreaFields]);

  const addImagemapArea = useCallback(() => {
    const mapEl = imagemapElementRef.current;
    if (!mapEl) return;
    const base = imagemapSelection ?? { x: "5", y: "5", width: "20", height: "20", href: "", title: "" };
    const area = document.createElement("span");
    area.className = "imagemap__link";
    area.setAttribute("data-bb-imagemap-area", "1");
    applyImagemapAreaFields(area, {
      x: formatImagemapNumber(Math.min(90, Number(base.x) + 5 || 5)),
      y: formatImagemapNumber(Math.min(90, Number(base.y) + 5 || 5)),
      width: base.width || "20",
      height: base.height || "20",
      href: base.href || "",
      title: base.title ? `${base.title} copy` : "",
    });
    mapEl.appendChild(area);
    reindexImagemapAreas(mapEl);
    updateImagemapRaw(mapEl);
    scheduleVisualSync();
    selectImagemapArea(area);
  }, [imagemapSelection, scheduleVisualSync, selectImagemapArea]);

  const deleteImagemapArea = useCallback(() => {
    const mapEl = imagemapElementRef.current;
    if (!mapEl || !imagemapSelection) return;
    const areas = getImagemapAreas(mapEl);
    const area = areas[imagemapSelection.areaIndex];
    if (!area) return;
    area.remove();
    reindexImagemapAreas(mapEl);
    updateImagemapRaw(mapEl);
    scheduleVisualSync();
    const nextAreas = getImagemapAreas(mapEl);
    if (nextAreas.length === 0) clearImagemapSelection();
    else selectImagemapArea(nextAreas[Math.min(imagemapSelection.areaIndex, nextAreas.length - 1)]);
  }, [clearImagemapSelection, imagemapSelection, scheduleVisualSync, selectImagemapArea]);

  /**
   * Turns an existing image into an imagemap around the same file.
   *
   * [imagemap] is not something you add to an image, it replaces it: the tag
   * carries its own image URL and its clickable areas, and osu! renders no
   * [img] inside it. So the only way this reads as one action is to swap the
   * element for a map of the same picture, seeded with one area to drag.
   */
  const convertImageToImagemap = useCallback((img: HTMLImageElement) => {
    const src = img.getAttribute("src") ?? "";
    if (!src || !visualRef.current?.contains(img)) return;
    // A linked image already has the destination the first area should carry.
    const anchor = img.closest<HTMLAnchorElement>('a[data-bb="url"]');
    const href = anchor?.getAttribute("href")?.trim();
    const holder = document.createElement("div");
    holder.innerHTML = bbcodeToEditableHtml(
      `[imagemap]\n${src}\n25 25 50 50 ${href || "#"}\n[/imagemap]`,
    );
    const mapEl = holder.querySelector<HTMLElement>('.imagemap[data-bb="imagemap"]');
    if (!mapEl) return;
    clearImageSelection();
    (anchor ?? img).replaceWith(mapEl);
    const area = getImagemapAreas(mapEl)[0];
    flushVisual();
    if (area) selectImagemapArea(area);
    mapEl.scrollIntoView({ block: "nearest" });
  }, [clearImageSelection, flushVisual, selectImagemapArea]);

  /** The way back out: an imagemap becomes the plain [img] it was drawn on. */
  const convertImagemapToImage = useCallback((mapEl: HTMLElement) => {
    const src = mapEl.getAttribute("data-src")
      ?? mapEl.querySelector<HTMLImageElement>(".imagemap__image")?.getAttribute("src")
      ?? "";
    if (!src || !visualRef.current?.contains(mapEl)) return;
    const holder = document.createElement("div");
    holder.innerHTML = bbcodeToEditableHtml(`[img]${src}[/img]`);
    const img = holder.querySelector("img");
    if (!img) return;
    clearImagemapSelection();
    mapEl.replaceWith(img);
    flushVisual();
    selectImage(img);
  }, [clearImagemapSelection, flushVisual, selectImage]);

  const deleteImagemap = useCallback((mapEl: HTMLElement) => {
    if (!visualRef.current?.contains(mapEl)) return;
    clearImagemapSelection();
    mapEl.remove();
    flushVisual();
  }, [clearImagemapSelection, flushVisual]);

  useEffect(() => {
    const handle = window.setTimeout(() => writeStored(draftKey, stripPendingImages(stripUploadTokens(source))), DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftKey, source]);

  useEffect(() => {
    if (!copied) return;
    const handle = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(handle);
  }, [copied]);

  useEffect(() => {
    if (!confirmReset) return;
    const handle = window.setTimeout(() => setConfirmReset(false), 3000);
    return () => window.clearTimeout(handle);
  }, [confirmReset]);

  // Reflect the caret's inline formatting, color, size and link in the toolbar
  // and inspectors while visually editing.
  useEffect(() => {
    if (editMode !== "visual") return;
    const handler = () => {
      const el = visualRef.current;
      const selection = window.getSelection();
      if (!el || !selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) return;
      // Bail out of state updates when nothing changed so caret moves don't
      // re-render the whole editor on every keystroke.
      try {
        const next = {
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          underline: document.queryCommandState("underline"),
          strike: document.queryCommandState("strikeThrough"),
        };
        setInlineStates((prev) =>
          prev.bold === next.bold && prev.italic === next.italic && prev.underline === next.underline && prev.strike === next.strike
            ? prev
            : next,
        );
      } catch {
        // queryCommandState can throw on detached selections; keep last state.
      }
      const node = selection.focusNode ?? selection.anchorNode;
      const color = climbForValue(node, el, readElementColor);
      const size = climbForValue(node, el, readElementSize);
      selectionColorRef.current = color;
      selectionSizeRef.current = size;
      setSelectionColor((prev) => (prev === color ? prev : color));
      setSelectionSize((prev) => (prev === size ? prev : size));
      const align = climbForValue(node, el, elementAlign) ?? "left";
      setSelectionAlign((prev) => (prev === align ? prev : align));
      // Show the link under the caret in the inspector (without stealing clicks).
      const anchor = climbForValue<HTMLAnchorElement>(node, el, (cur) =>
        cur.tagName === "A" && cur.getAttribute("data-bb") === "url" ? (cur as HTMLAnchorElement) : null,
      );
      if (anchor) {
        if (linkElementRef.current !== anchor) selectLink(anchor);
        else {
          // Keep the inspector's Text field synced while typing in the link.
          const text = anchor.textContent ?? "";
          setLinkSelection((prev) => (prev && prev.text !== text ? { ...prev, text } : prev));
        }
      } else if (linkElementRef.current) {
        clearLinkSelection();
      }
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [clearLinkSelection, editMode, selectLink]);

  const switchMode = useCallback((next: EditMode) => {
    if (next === editMode) return;
    if (editMode === "visual") flushVisual();
    setDialog(null);
    // Inspectors point at DOM in the surface we're leaving; drop them so the
    // overlay doesn't float stale controls over the other mode.
    clearLinkSelection();
    clearImageSelection();
    clearImagemapSelection();
    setEditMode(next);
  }, [clearImageSelection, clearImagemapSelection, clearLinkSelection, editMode, flushVisual]);

  // ---- visual-mode selection helpers -------------------------------------

  const ensureVisualSelection = useCallback(() => {
    const el = visualRef.current;
    if (!el) return;
    // preventScroll: refocusing the surface after a dialog/toolbar action must
    // not yank the scroll to the caret (that was the "insert jumps to top" bug).
    el.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return;
    if (selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);

  /** The innermost element around the caret matching `selector`, if any. */
  const closestAtCaret = useCallback((selector: string): Element | null => {
    const surface = visualRef.current;
    if (!surface) return null;
    const node = window.getSelection()?.focusNode ?? null;
    const from = node instanceof Element ? node : node?.parentElement ?? null;
    if (!from || !surface.contains(from)) return null;
    return from.closest(selector);
  }, []);

  /** How the text around the caret is aligned; nothing around it means left. */
  const alignAtCaret = useCallback((): BBAlign => {
    const el = closestAtCaret(ALIGN_SELECTOR);
    return (el && elementAlign(el)) || "left";
  }, [closestAtCaret]);

  /**
   * Wraps that would not change anything on the page, so they are skipped
   * rather than written into the source.
   *
   * osu! reads each of its tags with one pass, so a [centre] inside a [centre]
   * is not a tag there - it prints as its literal text (NESTABLE_TAGS in
   * lib/bbcode.ts). Aligning text to the alignment it already has is that case,
   * and so is a [heading] inside a heading. Alignments differing from each
   * other still nest: [left] inside [centre] is how a stretch comes back left.
   */
  const isRedundantWrap = useCallback((kind: EditableWrapKind): boolean => {
    const align = ALIGN_WRAP_KINDS[kind];
    if (align) return alignAtCaret() === align;
    if (kind === "heading") return closestAtCaret("h1,h2,h3,h4,h5,h6") !== null;
    return false;
  }, [alignAtCaret, closestAtCaret]);

  const restoreVisualRange = useCallback(() => {
    const el = visualRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const saved = visualRangeRef.current;
    const selection = window.getSelection();
    if (saved && selection) {
      selection.removeAllRanges();
      selection.addRange(saved);
    } else {
      ensureVisualSelection();
    }
  }, [ensureVisualSelection]);

  const visualSelectionHtml = useCallback((): string => {
    const el = visualRef.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0) return "";
    const range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return "";
    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    return holder.innerHTML;
  }, []);

  const insertVisualHtml = useCallback((html: string) => {
    ensureVisualSelection();
    try {
      document.execCommand("insertHTML", false, html);
    } catch {
      // execCommand gone? Insert at the saved range manually.
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const fragment = document.createDocumentFragment();
        while (holder.firstChild) fragment.appendChild(holder.firstChild);
        range.insertNode(fragment);
        range.collapse(false);
      }
    }
    scheduleVisualSync();
  }, [ensureVisualSelection, scheduleVisualSync]);

  /**
   * Replaces the saved selection with `html`, preserving ancestor wrappers.
   * insertHTML alone deletes inline ancestors ([b]/[url]/[size]) when the
   * selection covers their whole content, so when the selection exactly
   * covers an element we swap that element's children instead - recoloring
   * "osu!mania CR time machine" keeps its link and bold intact.
   */
  const replaceVisualSelectionHtml = useCallback((expectedText: string, html: string) => {
    restoreVisualRange();
    const el = visualRef.current;
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!el || !range || range.collapsed || range.toString() !== expectedText) {
      insertVisualHtml(html);
      return;
    }
    const container = range.commonAncestorContainer;
    const target = container.nodeType === 3 ? container.parentElement : container as Element;
    if (target && target !== el && el.contains(target)) {
      const cover = document.createRange();
      cover.selectNodeContents(target);
      if (cover.toString() === range.toString()) {
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const fragment = document.createDocumentFragment();
        while (holder.firstChild) fragment.appendChild(holder.firstChild);
        const style = target.getAttribute("style") ?? "";
        const isColorOnlySpan = target.tagName === "SPAN"
          && (target.hasAttribute("data-bb-color") || /^\s*color\s*:[^;]+;?\s*$/i.test(style));
        // Swapping a pure color span for the new spans avoids stale nesting
        // like [color=old][color=new]x[/color][/color].
        if (isColorOnlySpan) target.replaceWith(fragment);
        else target.replaceChildren(fragment);
        scheduleVisualSync();
        return;
      }
    }
    insertVisualHtml(html);
  }, [insertVisualHtml, restoreVisualRange, scheduleVisualSync]);

  /**
   * Grows the live selection over inline ancestors ([b]/[url]/[color] spans)
   * whose entire content is selected. cloneContents on a selection that sits
   * inside a single text node returns bare text, and insertHTML then deletes
   * the emptied ancestors - so wrapping a fully-selected bold link in
   * [centre] would strip the bold and the link without this.
   */
  const expandSelectionOverInlineWrappers = useCallback(() => {
    const el = visualRef.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !el.contains(range.commonAncestorContainer)) return;
    const INLINE_TAGS = new Set(["A", "B", "STRONG", "I", "EM", "U", "INS", "S", "DEL", "STRIKE", "SPAN", "CODE", "FONT"]);
    for (;;) {
      const container = range.commonAncestorContainer;
      const parent = container.nodeType === 3 ? container.parentElement : container as Element;
      if (!parent || parent === el || !el.contains(parent) || !INLINE_TAGS.has(parent.tagName)) break;
      const cover = document.createRange();
      cover.selectNodeContents(parent);
      if (cover.toString() !== range.toString()) break;
      range.selectNode(parent);
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  /**
   * Grows the selection to the whole lines it touches, for block wraps.
   *
   * [centre] and the rest are divs on the profile: they take whole lines, they
   * cannot hold three words out of a sentence. Chrome agrees in its own way -
   * insertHTML given a block for a part-of-a-line selection silently flattens
   * it into a styled span, which used to lose the tag and leave a stray colour
   * behind. Rounding out to the line boundaries (a <br>, or the edge of the
   * block the line sits in) is what the wrap means anyway.
   */
  const expandSelectionOverLines = useCallback(() => {
    const el = visualRef.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;

    // The line runs between <br>s inside whichever block holds the caret, so
    // never step out of that block: a line of a [notice] stays in the notice.
    const blockOf = (node: Node): Element => {
      let cur: Node | null = node.nodeType === 3 ? node.parentElement : node;
      while (cur && cur !== el && !isBlockLevel(cur as Element)) cur = cur.parentElement;
      return (cur as Element) ?? el;
    };
    const startBlock = blockOf(range.startContainer);
    const endBlock = blockOf(range.endContainer);
    // A selection crossing block edges is already whole lines; leave it be.
    if (startBlock !== endBlock) return;

    const children = startBlock.childNodes;
    /** Which child of the block a range boundary falls in, walking `dir`. */
    const childAt = (container: Node, offset: number, dir: -1 | 1): number => {
      if (container === startBlock) {
        // The boundary sits between children; take the one on the side walked.
        return dir < 0 ? offset - 1 : Math.min(offset, children.length - 1);
      }
      let node: Node = container;
      while (node.parentNode && node.parentNode !== startBlock) node = node.parentNode;
      return Array.prototype.indexOf.call(children, node);
    };

    let start = 0;
    for (let i = childAt(range.startContainer, range.startOffset, -1); i >= 0; i -= 1) {
      if (children[i]?.nodeName === "BR") { start = i + 1; break; }
    }
    let end = children.length;
    for (let i = childAt(range.endContainer, range.endOffset, 1); i >= 0 && i < children.length; i += 1) {
      if (children[i]?.nodeName === "BR") { end = i; break; }
    }
    range.setStart(startBlock, start);
    range.setEnd(startBlock, Math.max(start, end));
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  /**
   * When the line being aligned is all there is inside an alignment block, the
   * selection is grown to that block so the new one replaces it, instead of
   * leaving [left] wrapped around a [right] every time the button changes.
   * Returns the block whose contents the caller should re-wrap.
   */
  const alignedBlockToReplace = useCallback((): Element | null => {
    const surface = visualRef.current;
    const selection = window.getSelection();
    if (!surface || !selection || selection.rangeCount === 0) return null;
    const wrapper = closestAtCaret(ALIGN_SELECTOR);
    if (!wrapper || !surface.contains(wrapper)) return null;
    const cover = document.createRange();
    cover.selectNodeContents(wrapper);
    if (cover.toString() !== selection.getRangeAt(0).toString()) return null;
    const whole = document.createRange();
    whole.selectNode(wrapper);
    selection.removeAllRanges();
    selection.addRange(whole);
    return wrapper;
  }, [closestAtCaret]);

  /**
   * Grows the selection to the whole heading it sits in, for block wraps.
   *
   * osu! purifies the HTML it renders and a heading there may only hold inline
   * content, so a block tag inside one - an alignment div above all - costs the
   * whole heading: [heading][left]x[/left][/heading] lands as plain text on the
   * page. The other order says the same thing and survives, so a block wrap
   * pressed inside a heading goes around it. Returns the heading it selected.
   */
  const expandSelectionOverHeading = useCallback((): Element | null => {
    const surface = visualRef.current;
    const selection = window.getSelection();
    if (!surface || !selection || selection.rangeCount === 0) return null;
    const heading = closestAtCaret("h1,h2,h3,h4,h5,h6");
    if (!heading || !surface.contains(heading)) return null;
    const range = document.createRange();
    range.selectNode(heading);
    selection.removeAllRanges();
    selection.addRange(range);
    return heading;
  }, [closestAtCaret]);

  /**
   * Swaps one element for `html` directly in the DOM, caret at the end of what
   * went in. insertHTML cannot do this: given a selection that covers a whole
   * block element, Chrome deletes the block, pulls the following line up into
   * the gap, and rewrites inherited styles as literal spans - which is how
   * centering a heading used to eat the line under it and center nothing.
   */
  const replaceVisualNodeWithHtml = useCallback((target: Element, html: string) => {
    const el = visualRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const fragment = document.createDocumentFragment();
    while (holder.firstChild) fragment.appendChild(holder.firstChild);
    const last = fragment.lastChild;
    target.replaceWith(fragment);
    const selection = window.getSelection();
    if (selection && last) {
      const range = document.createRange();
      range.selectNodeContents(last);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    scheduleVisualSync();
  }, [scheduleVisualSync]);

  const wrapVisual = useCallback((kind: EditableWrapKind, param: string | undefined, placeholder: string) => {
    // A selected image has no text range, so target its DOM node directly;
    // otherwise the wrap would drop `placeholder` at a stray caret.
    const onImage = selectImageRange();
    ensureVisualSelection();
    if (isRedundantWrap(kind)) {
      // Nothing moved, but a selected image still owns the handle and needs it
      // put back where it was before selectImageRange took the selection.
      if (onImage) resyncImageAfterWrap();
      return;
    }
    const isBlock = BLOCK_WRAP_KINDS.has(kind);
    // A heading is wrapped whole rather than from the inside; "heading" itself
    // is exempt, since that one only ever means the caret's own line.
    const heading = isBlock && kind !== "heading" && !onImage ? expandSelectionOverHeading() : null;
    if (isBlock && !onImage) { if (!heading) expandSelectionOverLines(); }
    else expandSelectionOverInlineWrappers();
    const replacing = ALIGN_WRAP_KINDS[kind] ? alignedBlockToReplace() : null;
    const selected = replacing ? replacing.innerHTML : (visualSelectionHtml() || escapeBBHtml(placeholder));
    // An alignment already inside the heading is what broke it; the new one
    // outside covers the same text, so it leaves with nothing lost.
    const inner = heading && ALIGN_WRAP_KINDS[kind] ? unwrapAligns(selected) : selected;
    const { open, close } = editableWrapMarkup(kind, param);
    // Block wraps ([centre]/[quote]/[box]/...) legitimately contain block lines;
    // inline wraps ([size]/[spoiler]/[c]) must push into each line instead, or a
    // multi-line selection gets wiped by execCommand("insertHTML").
    const html = isBlock ? open + inner + close : distributeInlineWrap(inner, open, close);
    // When the wrap lands around one whole element (an align block being
    // re-aligned, a heading being wrapped), swap that node directly; both are
    // exactly the whole-block selections insertHTML mangles.
    const target = replacing ?? heading;
    if (target) replaceVisualNodeWithHtml(target, html);
    else insertVisualHtml(html);
    if (onImage) resyncImageAfterWrap();
  }, [alignedBlockToReplace, ensureVisualSelection, expandSelectionOverHeading, expandSelectionOverInlineWrappers, expandSelectionOverLines, insertVisualHtml, isRedundantWrap, replaceVisualNodeWithHtml, resyncImageAfterWrap, selectImageRange, visualSelectionHtml]);

  const execVisual = useCallback((command: string) => {
    selectImageRange();
    ensureVisualSelection();
    try {
      document.execCommand(command);
    } catch {
      // Unsupported command; nothing sensible to fall back to.
    }
    scheduleVisualSync();
  }, [ensureVisualSelection, scheduleVisualSync, selectImageRange]);

  // Colors the current selection with the browser's native foreColor, which
  // handles multi-line selections correctly. Used instead of wrapping the
  // selection in one [color] span when it spans blocks - wrapping block lines in
  // an inline span makes execCommand("insertHTML") drop them (the "it wiped my
  // text" bug). styleWithCSS is toggled so the result is a `color:` span that
  // serializes back to [color], then reset so it doesn't affect later commands.
  const applyVisualForeColor = useCallback((color: string) => {
    ensureVisualSelection();
    try {
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("foreColor", false, color);
      document.execCommand("styleWithCSS", false, "false");
    } catch {
      // execCommand unavailable; leave the selection untouched.
    }
    scheduleVisualSync();
  }, [ensureVisualSelection, scheduleVisualSync]);

  // ---- format painter + hue shift ------------------------------------------
  // Copy the color sequence of the right-clicked selection (its gradient).
  const copyFormatting = useCallback(() => {
    const range = visualRangeRef.current;
    if (!range) return;
    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    const seq = captureColorSequence(holder.innerHTML);
    if (seq.every((color) => color == null)) {
      setUploadStatus({ kind: "error", message: t`That selection has no colors to copy.` });
      return;
    }
    capturedColorsRef.current = seq;
    setHasCapturedFormat(true);
  }, [t]);

  // Paint the copied color sequence onto the right-clicked selection, stretched
  // to fit its length (so a gradient re-maps proportionally onto longer/shorter text).
  const pasteFormatting = useCallback(() => {
    const seq = capturedColorsRef.current;
    const range = visualRangeRef.current;
    if (!seq || !range) return;
    const text = range.toString();
    if (!text) return;
    replaceVisualSelectionHtml(text, applyColorSequence(text, seq));
  }, [replaceVisualSelectionHtml]);

  // Rotate the hue of every colored span touched by the selection, in place
  // (mutating attributes keeps the saved range valid, so a slider can drag live).
  const shiftSelectionHue = useCallback((delta: number) => {
    const el = visualRef.current;
    const range = visualRangeRef.current;
    if (!el || !range || delta === 0) return;
    el.querySelectorAll<HTMLElement>("[data-bb-color], [style*=color]").forEach((node) => {
      if (!range.intersectsNode(node)) return;
      const current = node.getAttribute("data-bb-color") ?? cssColorToBB(node.style.color || "");
      const shifted = current ? shiftHexHue(current, delta) : null;
      if (!shifted) return;
      node.setAttribute("data-bb-color", shifted);
      node.style.color = shifted;
    });
    scheduleVisualSync();
  }, [scheduleVisualSync]);

  // ---- code-mode selection helpers ----------------------------------------

  const wrapSelection = useCallback((before: string, after: string, placeholder = "") => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const selected = el.value.slice(start, el.selectionEnd) || placeholder;
    insertAtSelection(el, before + selected + after);
    const innerStart = start + before.length;
    el.setSelectionRange(innerStart, innerStart + selected.length);
  }, []);

  const insertSnippet = useCallback((snippet: string) => {
    const el = textareaRef.current;
    if (!el) return;
    insertAtSelection(el, snippet);
  }, []);

  const sourceCaretOffsetForSpan = useCallback((span: BBSourceSpan): number => {
    const sourceSlice = sourceRef.current.slice(span.start, span.end);
    if (!sourceSlice.startsWith("[")) return span.start;
    const tagEnd = sourceSlice.indexOf("]");
    return tagEnd === -1 ? span.start : span.start + tagEnd + 1;
  }, []);

  const selectSourceSpan = useCallback((span: BBSourceSpan) => {
    const caret = sourceCaretOffsetForSpan(span);
    setMobilePane("write");
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      setCaretOffset(caret);

      const before = el.value.slice(0, caret);
      const lineIndex = before.split("\n").length - 1;
      const computed = window.getComputedStyle(el);
      const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
      el.scrollTop = Math.max(0, lineIndex * lineHeight - el.clientHeight * 0.35);
    });
  }, [sourceCaretOffsetForSpan]);

  // ---- mode-dispatching toolbar actions ------------------------------------

  const applyInline = useCallback((command: string, tag: string, placeholder: string) => {
    if (editMode === "visual") execVisual(command);
    else wrapSelection(`[${tag}]`, `[/${tag}]`, placeholder);
  }, [editMode, execVisual, wrapSelection]);

  const applyWrap = useCallback((kind: EditableWrapKind, param: string | undefined, open: string, close: string, placeholder: string) => {
    if (editMode === "visual") wrapVisual(kind, param, placeholder);
    else wrapSelection(open, close, placeholder);
  }, [editMode, wrapSelection, wrapVisual]);

  const insertBBCode = useCallback((snippet: string) => {
    if (editMode === "visual") insertVisualHtml(bbcodeToEditableHtml(snippet));
    else insertSnippet(snippet);
  }, [editMode, insertSnippet, insertVisualHtml]);

  /**
   * The imagemap tool acts on the image you picked. Inserting the tag's
   * skeleton at the caret instead (what this used to do) pointed at
   * example.com, which in the visual pane is a broken image somewhere off
   * screen: the button looked like it did nothing.
   */
  const applyImagemapTool = useCallback(() => {
    if (editMode !== "visual") {
      insertBBCode(IMAGEMAP_TEMPLATE);
      return;
    }
    const img = imageElementRef.current;
    if (img?.isConnected) {
      convertImageToImagemap(img);
      return;
    }
    setUploadStatus({
      kind: "error",
      message: t`Click an image first. Imagemap turns that image into clickable areas.`,
    });
  }, [convertImageToImagemap, editMode, insertBBCode, t]);

  const insertList = useCallback((ordered: boolean) => {
    if (editMode === "visual") {
      execVisual(ordered ? "insertOrderedList" : "insertUnorderedList");
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    const selected = el.value.slice(el.selectionStart, el.selectionEnd);
    const lines = selected.split("\n").map((line) => line.trim()).filter(Boolean);
    const items = (lines.length > 0 ? lines : ["item"]).map((line) => `[*]${line}`).join("\n");
    insertAtSelection(el, `[list${ordered ? "=1" : ""}]\n${items}\n[/list]`);
  }, [editMode, execVisual]);

  const openDialog = useCallback((next: ToolDialog) => {
    let selectedText = "";
    if (editMode === "visual") {
      const selection = window.getSelection();
      const el = visualRef.current;
      if (selection && selection.rangeCount > 0 && el && el.contains(selection.anchorNode)) {
        visualRangeRef.current = selection.getRangeAt(0).cloneRange();
        selectedText = selection.toString();
      } else {
        visualRangeRef.current = null;
      }
    } else {
      const el = textareaRef.current;
      if (el) {
        selectionRef.current = {
          start: el.selectionStart,
          end: el.selectionEnd,
          text: el.value.slice(el.selectionStart, el.selectionEnd),
        };
        selectedText = selectionRef.current.text;
      }
    }
    setDialog((current) => {
      if (current === next) return null;
      if (next === "link" || next === "gradient" || next === "profile") {
        setTextField(selectedText);
        setUrlField("");
      } else if (next === "image" || next === "youtube" || next === "audio") {
        setUrlField("");
      } else if (next === "box") {
        setTextField("");
      } else if (next === "color") {
        if (selectionColorRef.current) setHexField(selectionColorRef.current);
        hueShiftRef.current = 0;
        setHueShift(0);
      } else if (next === "size") {
        if (selectionSizeRef.current != null) setCustomSize(String(selectionSizeRef.current));
      }
      return next;
    });
  }, [editMode]);

  const restoreSelectionForApply = useCallback(() => {
    if (editMode === "visual") {
      restoreVisualRange();
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
  }, [editMode, restoreVisualRange]);

  const applyAndClose = useCallback((apply: () => void) => {
    restoreSelectionForApply();
    apply();
    setDialog(null);
  }, [restoreSelectionForApply]);

  const selectedDialogText = useCallback((): string => {
    return editMode === "visual"
      ? (visualRangeRef.current?.toString() ?? "")
      : selectionRef.current.text;
  }, [editMode]);

  const copyBBCode = useCallback(async () => {
    if (copyInFlightRef.current) return;
    if (imageMutationInFlightRef.current) {
      setUploadStatus({ kind: "error", message: t`Wait for the image resize to finish, then copy again.` });
      return;
    }
    copyInFlightRef.current = true;
    const initialValue = stripUploadTokens(editMode === "visual" ? flushVisual() : sourceRef.current);

    // Upload every image that was pasted/dropped but deferred until now, and
    // swap its blob: URL for the real hosted URL. ClipboardItem is started
    // synchronously from the click and receives the eventual text as a Promise;
    // that preserves browser clipboard permission across the network wait.
    const blobUrls = pendingBlobUrls(initialValue);
    if (blobUrls.length === 0) {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(initialValue);
        setCopied(true);
        setUploadStatus(null);
      } catch {
        setUploadStatus({ kind: "error", message: t`The browser blocked the clipboard. Try Copy BBCode again.` });
      } finally {
        copyInFlightRef.current = false;
      }
      return;
    }

    setUploadStatus({ kind: "uploading" });
    const resolvedValuePromise = resolvePendingBlobUrls(initialValue, async (blobUrl) => {
      const blob = pendingUploadsRef.current.get(blobUrl);
      if (!blob) {
        throw new Error(t`A pasted image is no longer available. Paste it again before copying.`);
      }
      const uploadedUrl = await uploadImageToCatbox(blob);
      visualRef.current
        ?.querySelectorAll<HTMLImageElement>("img")
        .forEach((img) => {
          if (img.getAttribute("src") !== blobUrl) return;
          img.setAttribute("src", uploadedUrl);
          if (imageElementRef.current === img) {
            setImageSelection((selection) => selection ? { ...selection, src: uploadedUrl } : selection);
          }
        });
      visualRef.current
        ?.querySelectorAll<HTMLElement>('.imagemap[data-bb="imagemap"]')
        .forEach((mapEl) => {
          if (mapEl.getAttribute("data-src") !== blobUrl) return;
          mapEl.setAttribute("data-src", uploadedUrl);
          updateImagemapRaw(mapEl);
        });
      // Follow the resize original over to the hosted URL, so an image can
      // still be dragged back up to full resolution after it is copied.
      const origin = resizeOriginsRef.current.get(blobUrl);
      if (origin) {
        resizeOriginsRef.current.delete(blobUrl);
        resizeOriginsRef.current.set(uploadedUrl, origin);
      }
      pendingUploadsRef.current.delete(blobUrl);
      URL.revokeObjectURL(blobUrl);
      // Keep each successful replacement durable even if a later image fails.
      // This is essential in code mode, where there is no live DOM for the next
      // Copy attempt to serialize and recover the already-hosted URL from.
      if (editMode === "visual") flushVisual();
      else updateSource(sourceRef.current.split(blobUrl).join(uploadedUrl));
      return uploadedUrl;
    });

    let clipboardWrite: Promise<void> | null = null;
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      try {
        const textBlob = resolvedValuePromise.then((value) => new Blob([value], { type: "text/plain" }));
        clipboardWrite = navigator.clipboard.write([new ClipboardItem({ "text/plain": textBlob })]);
        // The upload may reject before this promise is awaited below.
        void clipboardWrite.catch(() => {});
      } catch {
        clipboardWrite = null;
      }
    }

    let value: string;
    try {
      value = await resolvedValuePromise;
      // Persist the fully resolved source. Never strip an unresolved image from
      // copied output: a missing staged Blob is an error above, not permission
      // to make that image disappear.
      updateSource(value);
      setUploadStatus({ kind: "copying" });
    } catch (error) {
      setUploadStatus({ kind: "error", message: error instanceof Error ? error.message : t`Image upload failed.` });
      copyInFlightRef.current = false;
      return;
    }

    try {
      if (clipboardWrite) {
        try {
          await waitForReservedClipboardWrite(clipboardWrite);
        } catch {
          // Chromium normally completes the reserved ClipboardItem once its
          // Blob promise resolves. Local/dev browser policies can reject or
          // strand it; the image is hosted now, so try the ordinary write too.
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
          await navigator.clipboard.writeText(value);
        }
      } else {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(value);
      }
      setUploadStatus(null);
      setCopied(true);
    } catch {
      // The images are already uploaded and the source is now stable, so the
      // retry is an immediate clipboard write and cannot omit the new image.
      setUploadStatus({
        kind: "error",
        message: t`The images uploaded, but the browser blocked the clipboard. Click Copy BBCode once more.`,
      });
    } finally {
      copyInFlightRef.current = false;
    }
  }, [editMode, flushVisual, t, updateSource]);

  const resetToProfile = useCallback(() => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setRestoredDraft(false);
    updateSource(baseSource);
    clearStored(draftKey);
    setVisualEpoch((epoch) => epoch + 1);
  }, [baseSource, confirmReset, draftKey, updateSource]);

  const searchPlayers = useCallback(async (query: string) => {
    const res = await searchUsers({ data: { query } });
    return (res.user?.data ?? [])
      .slice(0, 6)
      .map((entry: { id: number; username: string; avatar_url: string; country_code: string }) => ({
        id: entry.id,
        username: entry.username,
        avatar_url: entry.avatar_url,
        country_code: entry.country_code,
      }));
  }, []);

  // Pulls a player's existing me! page into the editor as a starting point.
  // Replaces the current source (like a reset) so the draft restore can't fight it.
  const loadUserPage = useCallback(async (picked: { id: number; username: string }) => {
    setLoadStatus(null);
    setLoadingUserPage(true);
    try {
      const fetched = await getUser({ data: { key: String(picked.id) } });
      const raw = fetched.page?.raw ?? "";
      setRestoredDraft(false);
      setConfirmReset(false);
      updateSource(raw);
      clearStored(draftKey);
      setVisualEpoch((epoch) => epoch + 1);
      const name = fetched.username || picked.username;
      setLoadStatus(raw.trim() ? { kind: "loaded", name } : { kind: "empty", name });
    } catch {
      setLoadStatus({ kind: "error" });
    } finally {
      setLoadingUserPage(false);
    }
  }, [draftKey, updateSource]);

  const gradientPreview = useMemo(() => {
    const text = textField || t`preview`;
    const colors = gradientCharColors(text, gradientStops, gradientMirror);
    if (!colors) return null;
    return { text, colors };
  }, [gradientMirror, gradientStops, t, textField]);

  // ---- images: upload, link, replace, crop ---------------------------------

  const insertImageMarkup = useCallback((url: string) => {
    if (editMode === "visual") insertVisualHtml(bbcodeToEditableHtml(`[img]${url}[/img]`));
    else insertSnippet(`[img]${url}[/img]`);
  }, [editMode, insertSnippet, insertVisualHtml]);

  // Holds a local image (paste, drop, crop, replace) as a blob: URL until
  // copyBBCode() uploads it. Returns the blob URL to drop into the markup.
  const registerPendingImage = useCallback((blob: Blob): string => {
    const blobUrl = URL.createObjectURL(blob);
    pendingUploadsRef.current.set(blobUrl, blob);
    return blobUrl;
  }, []);

  // Frees a staged blob URL if the given src was one (e.g. a crop/replace
  // discards the pre-edit image); no-op for already-uploaded URLs.
  const releasePendingImage = useCallback((url: string | null) => {
    if (!url) return;
    resizeOriginsRef.current.delete(url);
    if (pendingUploadsRef.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  /**
   * Stages a pasted/dropped image locally as a blob: URL and drops it in as
   * [img]blob:...[/img]. Nothing is uploaded here - copyBBCode() uploads every
   * staged image at once and swaps the blob URLs for real hosted URLs.
   */
  const stagePendingImage = useCallback((file: Blob) => {
    if (!isUploadableImage(file)) {
      setUploadStatus({ kind: "error", message: t`That file isn't a supported image.` });
      return;
    }
    const blobUrl = registerPendingImage(file);
    if (editMode === "visual") {
      insertVisualHtml(bbcodeToEditableHtml(`[img]${blobUrl}[/img]`));
    } else {
      const el = textareaRef.current;
      if (el) insertAtSelection(el, `[img]${blobUrl}[/img]`);
    }
  }, [editMode, insertVisualHtml, registerPendingImage, t]);

  // Release any staged blob URLs when the editor unmounts.
  useEffect(() => {
    const pending = pendingUploadsRef.current;
    return () => {
      pending.forEach((_, url) => URL.revokeObjectURL(url));
      pending.clear();
    };
  }, []);

  // ---- images: drag-to-resize ----------------------------------------------

  /** Announces a resize only if it is still running once the delay is up. */
  const showResizeStatusSoon = useCallback(() => {
    if (resizeStatusTimerRef.current != null) window.clearTimeout(resizeStatusTimerRef.current);
    resizeStatusTimerRef.current = window.setTimeout(() => {
      resizeStatusTimerRef.current = null;
      setUploadStatus({ kind: "resizing" });
    }, RESIZE_STATUS_DELAY_MS);
  }, []);

  /** Ends a resize's status, cancelling the announcement if it never fired. */
  const settleResizeStatus = useCallback((status: { kind: "error"; message: string } | null) => {
    if (resizeStatusTimerRef.current != null) {
      window.clearTimeout(resizeStatusTimerRef.current);
      resizeStatusTimerRef.current = null;
    }
    setUploadStatus(status);
  }, []);

  useEffect(() => () => {
    if (resizeStatusTimerRef.current != null) window.clearTimeout(resizeStatusTimerRef.current);
  }, []);

  // The handle lives in the frame, which is the scroller and is not zoomed, so
  // its coordinates are plain pointer-space pixels. A padded file's box runs
  // wider than the picture in it, so everything here is drawn to the picture.
  const positionResizeHandle = useCallback(() => {
    const frame = visualFrameRef.current;
    const img = imageElementRef.current;
    const handle = resizeHandleRef.current;
    if (!frame || !img || !handle || !img.isConnected) return;
    const frameRect = frame.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    // The file behind the image is the same one all through a drag, so its
    // margins keep their share of the box however wide the box is stretched.
    const ratios = contentRatios(resizeOriginsRef.current.get(img.getAttribute("src") ?? "")?.layout);
    const offsetLeft = frameRect.left + frame.clientLeft - frame.scrollLeft;
    const offsetTop = frameRect.top + frame.clientTop - frame.scrollTop;
    const contentLeft = imgRect.left + imgRect.width * ratios.left - offsetLeft;
    const contentRight = contentLeft + imgRect.width * ratios.width;
    const bottom = imgRect.bottom - offsetTop;
    handle.style.left = `${contentRight}px`;
    handle.style.top = `${bottom}px`;
    const readout = resizeReadoutRef.current;
    if (readout) {
      readout.style.left = `${contentRight}px`;
      readout.style.top = `${bottom}px`;
    }
    const outline = resizeOutlineRef.current;
    if (outline) {
      outline.style.left = `${contentLeft}px`;
      outline.style.top = `${imgRect.top - offsetTop}px`;
      outline.style.width = `${imgRect.width * ratios.width}px`;
      outline.style.height = `${imgRect.height}px`;
    }
  }, []);

  // ---- drag to reorder images ----------------------------------------------
  // A press on an image selects it; once the pointer travels far enough the
  // press becomes a drag, and a line shows where the image will land relative
  // to the nearest other image. Releasing moves it there.

  const stopImageReorder = useCallback((event?: PointerEvent) => {
    const drag = imageReorderRef.current;
    if (!drag) return;
    if (event && event.pointerId !== drag.pointerId) return;
    imageReorderRef.current = null;
    document.removeEventListener("pointermove", reorderListenersRef.current.move);
    document.removeEventListener("pointerup", reorderListenersRef.current.up);
    document.removeEventListener("pointercancel", reorderListenersRef.current.up);
    drag.line?.remove();
    drag.img.classList.remove("is-reorder-source");
    visualFrameRef.current?.classList.remove("is-reordering");
    const root = visualRef.current;
    if (!drag.active || !drag.target || event?.type !== "pointerup" || !root) return;
    const unit = imageReorderUnit(drag.img, root);
    const targetUnit = imageReorderUnit(drag.target.img, root);
    if (unit === targetUnit || unit.contains(targetUnit) || targetUnit.contains(unit)) return;
    moveImageUnit(unit, targetUnit, drag.target.side);
    flushVisual();
    selectImage(drag.img);
    window.requestAnimationFrame(positionResizeHandle);
  }, [flushVisual, positionResizeHandle, selectImage]);

  const handleImageReorderMove = useCallback((event: PointerEvent) => {
    const drag = imageReorderRef.current;
    const root = visualRef.current;
    const frame = visualFrameRef.current;
    if (!drag || !root || !frame || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < IMAGE_REORDER_THRESHOLD_PX) return;
      drag.active = true;
      drag.img.classList.add("is-reorder-source");
      frame.classList.add("is-reordering");
      const line = document.createElement("span");
      line.className = "bbcode-image-drop-line";
      line.setAttribute("aria-hidden", "true");
      line.style.display = "none";
      frame.append(line);
      drag.line = line;
    }
    // Nudge the pane when the pointer sits near its edge, so a long page can
    // be crossed without letting go.
    const frameRect = frame.getBoundingClientRect();
    const edge = 40;
    if (event.clientY < frameRect.top + edge) frame.scrollTop -= 12;
    else if (event.clientY > frameRect.bottom - edge) frame.scrollTop += 12;

    let best: { img: HTMLImageElement; side: "before" | "after"; rect: DOMRect; distance: number } | null = null;
    for (const img of reorderableImages(root)) {
      if (img === drag.img) continue;
      const rect = imageReorderUnit(img, root).getBoundingClientRect();
      if (rect.height === 0) continue;
      const centre = rect.top + rect.height / 2;
      const distance = Math.abs(event.clientY - centre);
      if (!best || distance < best.distance) {
        best = { img, side: event.clientY < centre ? "before" : "after", rect, distance };
      }
    }
    drag.target = best ? { img: best.img, side: best.side } : null;
    const line = drag.line;
    if (!line) return;
    if (!best) {
      line.style.display = "none";
      return;
    }
    const offsetLeft = frameRect.left + frame.clientLeft - frame.scrollLeft;
    const offsetTop = frameRect.top + frame.clientTop - frame.scrollTop;
    line.style.display = "block";
    line.style.left = `${best.rect.left - offsetLeft}px`;
    line.style.width = `${best.rect.width}px`;
    line.style.top = `${(best.side === "before" ? best.rect.top : best.rect.bottom) - offsetTop}px`;
  }, []);

  // The document listeners are added in one callback and removed in another,
  // possibly renders apart, so they are fixed wrappers over the latest handlers.
  const handleImageReorderMoveRef = useRef(handleImageReorderMove);
  const stopImageReorderRef = useRef(stopImageReorder);
  useEffect(() => {
    handleImageReorderMoveRef.current = handleImageReorderMove;
    stopImageReorderRef.current = stopImageReorder;
  }, [handleImageReorderMove, stopImageReorder]);
  const reorderListenersRef = useRef({
    move: (event: PointerEvent) => handleImageReorderMoveRef.current(event),
    up: (event: PointerEvent) => stopImageReorderRef.current(event),
  });

  const startImageReorder = useCallback((event: PointerEvent, img: HTMLImageElement) => {
    if (imageMutationInFlightRef.current || imageReorderRef.current) return;
    imageReorderRef.current = {
      img,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target: null,
      line: null,
    };
    document.addEventListener("pointermove", reorderListenersRef.current.move);
    document.addEventListener("pointerup", reorderListenersRef.current.up);
    document.addEventListener("pointercancel", reorderListenersRef.current.up);
  }, []);

  useEffect(() => {
    startImageReorderRef.current = startImageReorder;
  }, [startImageReorder]);

  useEffect(() => () => stopImageReorderRef.current(), []);

  const handleImageResizeMove = useCallback((event: PointerEvent) => {
    const drag = imageResizeRef.current;
    if (!drag) return;
    // The pointer moves in screen px; the column it is resizing inside may be
    // scaled down to fit the pane, so convert before applying the delta.
    const delta = (event.clientX - drag.startX) / drag.scale;
    const next = Math.round(Math.max(drag.minWidth, Math.min(drag.maxWidth, drag.startWidth + delta)));
    drag.width = next;
    // The box is what CSS can be given, and on a padded file the picture is only
    // part of it, so the box is stretched by however much margin it carries.
    drag.img.style.width = `${next / drag.contentRatio}px`;
    drag.img.style.height = "auto";
    positionResizeHandle();
    const readout = resizeReadoutRef.current;
    if (readout) readout.textContent = `${next} px`;
  }, [positionResizeHandle]);

  /** Re-encodes one image so its visible picture lands at `targetWidth`. */
  const recutImageToWidth = useCallback(async (
    img: HTMLImageElement,
    targetWidth: number,
    previousDisplayWidth?: number,
  ) => {
    const currentSrc = img.getAttribute("src") ?? "";
    if (!currentSrc || targetWidth < 1) return;
    const origin = resizeOriginsRef.current.get(currentSrc);
    const currentRatio = contentRatios(origin?.layout).width;
    // During a drag, inline preview width is already the target by the time the
    // re-cut starts, so the caller supplies the width from pointerdown.
    const currentDisplayWidth = previousDisplayWidth
      ?? Math.max(1, Math.round(img.offsetWidth * currentRatio));
    // Margins can only be added where nothing else sits on the image's line,
    // and they go opposite whichever side the column holds the picture to. An
    // enlargement is written directly at the requested width instead: padding
    // is useful for preserving pixels while shrinking, but makes a tiny growth
    // depend on a new transparent-margin ratio when it can simply be 786px.
    const node = img.closest<HTMLElement>('a[data-bb="url"]') ?? img;
    const pad = targetWidth < currentDisplayWidth
      && isAloneOnItsLine(node)
      && !img.closest(".imagemap");
    const align = effectiveAlign(node);
    // A staged image is already in hand. One that is already hosted has to be
    // read back through our origin, because a canvas cannot read the pixels of
    // a cross-origin image without being tainted by them. This downloads the
    // file; nothing is uploaded until Copy BBCode.
    const staged = origin?.blob ?? pendingUploadsRef.current.get(currentSrc);
    const source = staged ?? await fetchImageBlobViaProxy(currentSrc).catch(() => {
      throw new Error(t`Couldn't read the original image to resize it. Its host didn't answer.`);
    });
    // A file read back off a host may be one of ours, already carrying
    // margins. The drag then sized its box, and the picture inside only ever
    // filled the share of that box the margins leave over.
    let sourceRect = origin?.sourceRect;
    let displayWidth = targetWidth;
    if (!staged) {
      const measured = await measureImageContent(source);
      if (measured.content.width > 0 && measured.content.width < measured.width) {
        sourceRect = measured.content;
        displayWidth = Math.max(1, Math.round(targetWidth * (measured.content.width / measured.width)));
      }
    }
    let encoded = await encodeImageAtDisplayWidth(source, displayWidth, { align, pad, sourceRect });
    // Transparent margins cost a PNG almost nothing, but a padded photo can
    // still come out past the upload cap; then the smaller file is the one
    // that can be posted at all.
    if (encoded.padded && encoded.blob.size > MAX_IMAGE_UPLOAD_BYTES) {
      encoded = await encodeImageAtDisplayWidth(source, displayWidth, { align, pad: false, sourceRect });
    }
    const blobUrl = registerPendingImage(encoded.blob);
    // Carry the original bytes over to the new blob URL so the next drag still
    // cuts from full resolution instead of from this smaller copy.
    resizeOriginsRef.current.set(blobUrl, {
      blob: origin?.blob ?? source,
      naturalWidth: origin?.naturalWidth || sourceRect?.width || img.naturalWidth || targetWidth,
      sourceRect,
      layout: encoded.padded ? encoded : undefined,
    });
    await preloadImage(blobUrl);
    if (!img.isConnected) {
      releasePendingImage(blobUrl);
      return;
    }
    // Pin the size according to the *new* file while the on-screen element
    // adopts it. A detached preloader having decoded the URL does not guarantee
    // every browser updates this element's naturalWidth in the same frame.
    const encodedRatio = contentRatios(encoded.padded ? encoded : undefined).width;
    img.style.width = `${encoded.displayWidth / encodedRatio}px`;
    img.setAttribute("src", blobUrl);
    try {
      await img.decode();
    } catch {
      // The detached preload already had its chance; leave normal image loading
      // as the fallback, while still releasing the preview on the next frame.
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (!img.isConnected) {
      releasePendingImage(blobUrl);
      return;
    }
    // Swap and release together only after this element has the new intrinsic
    // size, so letting CSS take back over cannot flash or settle at the old one.
    endResizePreview(img);
    releasePendingImage(currentSrc);
    if (imageElementRef.current === img) {
      setImageSelection((sel) => (sel ? { ...sel, src: blobUrl } : sel));
    }
    flushVisual();
    window.requestAnimationFrame(positionResizeHandle);
  }, [
    flushVisual,
    positionResizeHandle,
    registerPendingImage,
    releasePendingImage,
    t,
  ]);

  const stopImageResize = useCallback((event: PointerEvent) => {
    void event;
    const drag = imageResizeRef.current;
    imageResizeRef.current = null;
    document.removeEventListener("pointermove", handleImageResizeMove);
    document.removeEventListener("pointerup", stopImageResize);
    document.removeEventListener("pointercancel", stopImageResize);
    const readout = resizeReadoutRef.current;
    if (readout) readout.style.display = "none";
    if (!drag) return;
    const img = drag.img;
    const targetWidth = drag.width;
    const currentSrc = img.getAttribute("src") ?? "";
    // A click that didn't really drag shouldn't re-encode the image.
    if (!currentSrc || targetWidth < 1 || Math.abs(targetWidth - drag.startWidth) < 2) {
      endResizePreview(img);
      window.requestAnimationFrame(positionResizeHandle);
      return;
    }
    if (imageMutationInFlightRef.current) {
      endResizePreview(img);
      window.requestAnimationFrame(positionResizeHandle);
      return;
    }

    // Lock immediately. Without this, a quick second drag can race the first
    // encode and the older result can land last, making the image snap back.
    imageMutationInFlightRef.current = true;
    setImageMutationBusy(true);
    showResizeStatusSoon();
    void recutImageToWidth(img, targetWidth, drag.startWidth)
      .then(() => settleResizeStatus(null))
      .catch((error) => {
        settleResizeStatus({
          kind: "error",
          message: error instanceof Error ? error.message : t`Could not resize the image.`,
        });
      })
      .finally(() => {
        endResizePreview(img);
        imageMutationInFlightRef.current = false;
        setImageMutationBusy(false);
        window.requestAnimationFrame(positionResizeHandle);
      });
  }, [handleImageResizeMove, positionResizeHandle, recutImageToWidth, settleResizeStatus, showResizeStatusSoon, t]);

  const startImageResize = useCallback((event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation(); // keep the surface's pointerdown from re-selecting/clearing
    if (imageMutationInFlightRef.current) return;
    const img = imageElementRef.current;
    if (!img) return;
    // Everything below is in column pixels - the width osu! will lay the picture
    // out at - not in whatever the pane is currently scaled to, and not in the
    // image box either, which on a padded file is wider than the picture.
    const origin = resizeOriginsRef.current.get(img.getAttribute("src") ?? "");
    const ratios = contentRatios(origin?.layout);
    const boxWidth = img.offsetWidth;
    const startWidth = Math.max(1, Math.round(boxWidth * ratios.width));
    const rect = img.getBoundingClientRect();
    const scale = boxWidth > 0 ? rect.width / boxWidth : 1;
    // osu! clips at the column. Upscaling a smaller file can soften it, but it
    // is still preferable to a handle that appears to accept the drag and then
    // snaps back; matching a neighboring image also needs the full range.
    imageResizeRef.current = {
      img,
      startX: event.clientX,
      startWidth,
      width: startWidth,
      minWidth: 40,
      maxWidth: OSU_PROFILE_COLUMN_WIDTH,
      contentRatio: ratios.width,
      scale: scale > 0 ? scale : 1,
    };
    img.classList.add("is-resizing");
    img.style.width = `${boxWidth}px`;
    const readout = resizeReadoutRef.current;
    if (readout) {
      readout.textContent = `${startWidth} px`;
      readout.style.display = "block";
    }
    document.addEventListener("pointermove", handleImageResizeMove);
    document.addEventListener("pointerup", stopImageResize);
    document.addEventListener("pointercancel", stopImageResize);
  }, [handleImageResizeMove, stopImageResize]);

  const matchSelectedImageSizes = useCallback(() => {
    if (imageMutationInFlightRef.current) return;
    const images = selectedImageElementsRef.current.filter((img) => img.isConnected);
    if (images.length < 2) return;
    selectedImageElementsRef.current = images;

    const reference = images[0];
    const referenceOrigin = resizeOriginsRef.current.get(reference.getAttribute("src") ?? "");
    const referenceRatio = contentRatios(referenceOrigin?.layout).width;
    const targetWidth = Math.max(1, Math.round(reference.offsetWidth * referenceRatio));
    const targets = images.slice(1).filter((img) => {
      const origin = resizeOriginsRef.current.get(img.getAttribute("src") ?? "");
      const width = Math.round(img.offsetWidth * contentRatios(origin?.layout).width);
      return Math.abs(width - targetWidth) >= 2;
    });
    if (targets.length === 0) return;

    imageMutationInFlightRef.current = true;
    setImageMutationBusy(true);
    setUploadStatus({ kind: "resizing" });
    void (async () => {
      try {
        // Keep the order deterministic and the UI responsive; these usually
        // work from local blobs, while hosted images are fetched one at a time.
        for (const img of targets) await recutImageToWidth(img, targetWidth);
        settleResizeStatus(null);
      } catch (error) {
        settleResizeStatus({
          kind: "error",
          message: error instanceof Error ? error.message : t`Could not match the image sizes.`,
        });
      } finally {
        imageMutationInFlightRef.current = false;
        setImageMutationBusy(false);
        window.requestAnimationFrame(positionResizeHandle);
      }
    })();
  }, [positionResizeHandle, recutImageToWidth, settleResizeStatus, t]);

  /**
   * Re-cuts a padded image's margins onto the side its alignment now asks for.
   *
   * A picture sized by margins sits in a file that fills the column, so
   * [centre] and friends have nothing left to move: where the picture lands is
   * decided by which side those margins are on. Re-encoding from the original
   * bytes is what makes the wrap show, and it costs no quality.
   */
  const realignPaddedImage = useCallback((img: HTMLImageElement) => {
    const currentSrc = img.getAttribute("src") ?? "";
    const origin = resizeOriginsRef.current.get(currentSrc);
    const layout = origin?.layout;
    if (!origin || !layout?.padded) return;
    const node = img.closest<HTMLElement>('a[data-bb="url"]') ?? img;
    const align = effectiveAlign(node);
    if (align === marginAlign(layout)) return;
    void (async () => {
      try {
        const encoded = await encodeImageAtDisplayWidth(origin.blob, layout.displayWidth, {
          align,
          sourceRect: origin.sourceRect,
        });
        const blobUrl = registerPendingImage(encoded.blob);
        resizeOriginsRef.current.set(blobUrl, {
          ...origin,
          layout: encoded.padded ? encoded : undefined,
        });
        await preloadImage(blobUrl);
        if (!img.isConnected) {
          releasePendingImage(blobUrl);
          return;
        }
        img.setAttribute("src", blobUrl);
        releasePendingImage(currentSrc);
        setImageSelection((sel) => (sel ? { ...sel, src: blobUrl } : sel));
        flushVisual();
        window.requestAnimationFrame(positionResizeHandle);
      } catch {
        // The picture stays where it was; the wrap itself is still in the source.
      }
    })();
  }, [flushVisual, positionResizeHandle, registerPendingImage, releasePendingImage]);

  // Wraps are applied from further up the file than this, so they reach it here.
  useEffect(() => {
    realignPaddedImageRef.current = realignPaddedImage;
  }, [realignPaddedImage]);

  const showResizeHandle = useCallback(() => {
    const frame = visualFrameRef.current;
    const img = imageElementRef.current;
    if (!frame || !img) return;
    removeImageResizeHandle(frame);
    const handle = document.createElement("span");
    handle.className = "bbcode-image-resize-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = t`Drag to resize`;
    handle.addEventListener("pointerdown", startImageResize);
    resizeHandleRef.current = handle;
    // Dragging is the only way to learn what an image's width will be, so say it.
    const readout = document.createElement("span");
    readout.className = "bbcode-image-resize-readout";
    readout.setAttribute("aria-hidden", "true");
    readout.style.display = "none";
    resizeReadoutRef.current = readout;
    // The selection is drawn here rather than as an outline on the element,
    // because a padded file's box runs out to the column and outlining that
    // would ring empty space instead of the picture.
    const outline = document.createElement("span");
    outline.className = "bbcode-image-outline";
    outline.setAttribute("aria-hidden", "true");
    resizeOutlineRef.current = outline;
    frame.append(outline, handle, readout);
    positionResizeHandle();
  }, [positionResizeHandle, startImageResize, t]);

  const hideResizeHandle = useCallback(() => {
    removeImageResizeHandle(visualFrameRef.current);
    resizeHandleRef.current = null;
    resizeReadoutRef.current = null;
    resizeOutlineRef.current = null;
  }, []);

  // Show the resize handle whenever an image is selected; reposition it when the
  // selection changes (e.g. after a resize swaps the image). The chrome is drawn
  // in the frame rather than on the image, so editing text above a selected
  // image has to move it along with everything else.
  useEffect(() => {
    if (!imageSelection) {
      hideResizeHandle();
      return;
    }
    showResizeHandle();
    const surface = visualRef.current;
    const reposition = () => positionResizeHandle();
    surface?.addEventListener("input", reposition);
    return () => surface?.removeEventListener("input", reposition);
  }, [imageSelection, showResizeHandle, hideResizeHandle, positionResizeHandle]);

  // Keep the osu!-width column scaled to whatever the pane happens to be. It
  // shrinks as one piece rather than reflowing, so an image that fills the
  // column here fills it on the profile too.
  useEffect(() => {
    const frames = [visualFrameRef.current, previewFrameRef.current].filter(
      (frame): frame is HTMLDivElement => frame !== null,
    );
    if (frames.length === 0) return;
    const fit = (frame: HTMLDivElement) => {
      const scale = columnFitScale(frame.clientWidth);
      setFitScale((prev) => (Math.abs(prev - scale) < 0.001 ? prev : scale));
      if (!zoomChosenRef.current && shouldOpenAtActualSize(frame.clientWidth)) {
        zoomChosenRef.current = true;
        setColumnZoom("full");
        return; // The state change re-runs this effect with the new zoom.
      }
      frame.style.setProperty("--bbcode-fit", `${columnZoom === "full" ? 1 : scale}`);
    };
    frames.forEach(fit);
    positionResizeHandle();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) fit(entry.target as HTMLDivElement);
      positionResizeHandle();
    });
    frames.forEach((frame) => observer.observe(frame));
    return () => observer.disconnect();
  }, [columnZoom, editMode, mobilePane, positionResizeHandle]);

  // A profile is written down the middle of its column, so a pane too narrow to
  // hold the column starts looking at the middle of it rather than the gutter.
  useEffect(() => {
    for (const frame of [visualFrameRef.current, previewFrameRef.current]) {
      if (!frame) continue;
      frame.scrollLeft = columnZoom === "full" ? Math.max(0, (frame.scrollWidth - frame.clientWidth) / 2) : 0;
    }
  }, [columnZoom, editMode, mobilePane]);

  // Restore the zoom after hydration, so SSR markup matches on first paint. A
  // stored choice is the user's and outranks the width-based one above.
  useEffect(() => {
    const stored = readStored(COLUMN_ZOOM_KEY);
    if (stored !== "fit" && stored !== "full") return;
    zoomChosenRef.current = true;
    setColumnZoom(stored);
  }, []);

  const chooseColumnZoom = useCallback((next: "fit" | "full") => {
    zoomChosenRef.current = true;
    setColumnZoom(next);
    writeStored(COLUMN_ZOOM_KEY, next);
  }, []);

  /** Wraps/updates/unwraps the [url] around the selected image. */
  const mutateImageLinkDom = useCallback((value: string) => {
    const img = imageElementRef.current;
    if (!img) return;
    const existing = img.closest<HTMLAnchorElement>('a[data-bb="url"]');
    const trimmed = value.trim();
    if (existing) {
      if (trimmed) {
        existing.setAttribute("href", trimmed);
        existing.setAttribute("title", trimmed);
      } else {
        const fragment = document.createDocumentFragment();
        while (existing.firstChild) fragment.appendChild(existing.firstChild);
        existing.replaceWith(fragment);
      }
    } else if (/^https?:\/\/\S+/i.test(trimmed)) {
      const anchor = document.createElement("a");
      anchor.setAttribute("href", trimmed);
      anchor.setAttribute("data-bb", "url");
      anchor.setAttribute("title", trimmed);
      img.replaceWith(anchor);
      anchor.appendChild(img);
    }
    scheduleVisualSync();
  }, [scheduleVisualSync]);

  const updateImageLink = useCallback((value: string) => {
    setImageSelection((sel) => (sel ? { ...sel, href: value } : sel));
    mutateImageLinkDom(value);
  }, [mutateImageLinkDom]);

  const deleteSelectedImage = useCallback(() => {
    const img = imageElementRef.current;
    if (!img) return;
    const anchor = img.closest<HTMLAnchorElement>('a[data-bb="url"]');
    // Remove the wrapping link too if it only existed to wrap this image.
    if (anchor && (anchor.textContent ?? "").trim() === "" && anchor.querySelectorAll("img").length === 1) {
      anchor.remove();
    } else {
      img.remove();
    }
    clearImageSelection();
    flushVisual();
  }, [clearImageSelection, flushVisual]);

  const openImageEditor = useCallback((img: HTMLImageElement) => {
    imageEditorTargetRef.current = img;
    setImageEditorState({ source: { url: img.getAttribute("src") ?? "" } });
  }, []);

  const applyImageEdit = useCallback((blob: Blob) => {
    setImageEditorBusy(true);
    try {
      const url = registerPendingImage(blob);
      const img = imageEditorTargetRef.current;
      if (img && img.isConnected) {
        releasePendingImage(img.getAttribute("src")); // drop the pre-crop blob if it was staged
        img.setAttribute("src", url);
        setImageSelection((sel) => (sel ? { ...sel, src: url } : sel));
        flushVisual();
      } else {
        // Target was removed (surface rebuilt) while editing: insert fresh.
        insertImageMarkup(url);
      }
      imageEditorTargetRef.current = null;
      setImageEditorState(null);
    } finally {
      setImageEditorBusy(false);
    }
  }, [flushVisual, insertImageMarkup, registerPendingImage, releasePendingImage]);

  const triggerReplaceImage = useCallback((img: HTMLImageElement) => {
    replaceTargetRef.current = img;
    fileInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback((event: ReactChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const img = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (!file || !img) return;
    if (!isUploadableImage(file)) {
      setUploadStatus({ kind: "error", message: t`That file isn't a supported image.` });
      return;
    }
    const url = registerPendingImage(file);
    if (img.isConnected) {
      releasePendingImage(img.getAttribute("src")); // drop the replaced blob if it was staged
      img.setAttribute("src", url);
      setImageSelection((sel) => (sel ? { ...sel, src: url } : sel));
      flushVisual();
    } else {
      insertImageMarkup(url);
    }
  }, [flushVisual, insertImageMarkup, registerPendingImage, releasePendingImage, t]);

  // ---- clipboard, paste, drop ----------------------------------------------

  const copySelection = useCallback(() => {
    try { document.execCommand("copy"); } catch { /* clipboard blocked */ }
  }, []);

  const cutSelection = useCallback(() => {
    try { document.execCommand("cut"); } catch { /* clipboard blocked */ }
    scheduleVisualSync();
  }, [scheduleVisualSync]);

  const insertPlainText = useCallback((text: string) => {
    if (editMode === "visual") {
      restoreVisualRange();
      insertVisualHtml(escapeBBHtml(text).replace(/\n/g, "<br>"));
    } else {
      const el = textareaRef.current;
      if (el) insertAtSelection(el, text);
    }
  }, [editMode, insertVisualHtml, restoreVisualRange]);

  // Context-menu paste: route images through the upload endpoint, drop text inline.
  const pasteFromClipboard = useCallback(async () => {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith("image/"));
          if (imageType) {
            stagePendingImage(await item.getType(imageType));
            return;
          }
        }
        const textItem = items.find((item) => item.types.includes("text/plain"));
        if (textItem) {
          insertPlainText(await (await textItem.getType("text/plain")).text());
          return;
        }
      }
      const text = await navigator.clipboard?.readText?.();
      if (text) insertPlainText(text);
    } catch {
      setUploadStatus({ kind: "error", message: t`Couldn't read the clipboard. Use Ctrl+V instead.` });
    }
  }, [insertPlainText, stagePendingImage, t]);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          stagePendingImage(file);
          return;
        }
      }
    }
    // Visual mode: render pasted BBCode inline instead of dropping the raw
    // [tags] in as literal characters. Plain text (no recognized tags) falls
    // through to the browser's native paste. Raw mode keeps BBCode as text.
    if (editMode === "visual") {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text && containsBBCode(text)) {
        event.preventDefault();
        insertVisualHtml(bbcodeToEditableHtml(text));
      }
    }
  }, [editMode, insertVisualHtml, stagePendingImage]);

  // A selected image is a DOM node, not a text range, so the browser's own
  // Backspace/Delete won't remove it - handle those keys ourselves.
  const handleVisualKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.key === "Backspace" || event.key === "Delete") && imageElementRef.current) {
      event.preventDefault();
      deleteSelectedImage();
    }
  }, [deleteSelectedImage]);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file")) {
      event.preventDefault();
    }
  }, []);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    const file = Array.from(event.dataTransfer?.files ?? []).find((entry) => entry.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    if (editMode === "visual") {
      const range = caretRangeFromPoint(event.clientX, event.clientY);
      const selection = window.getSelection();
      if (range && selection && visualRef.current?.contains(range.startContainer)) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    stagePendingImage(file);
  }, [editMode, stagePendingImage]);

  // ---- right-click context menu --------------------------------------------

  const buildImageMenuItems = useCallback((img: HTMLImageElement): ContextMenuItem[] => {
    const src = img.getAttribute("src") ?? "";
    const anchor = img.closest<HTMLAnchorElement>('a[data-bb="url"]');
    const items: ContextMenuItem[] = [
      { label: t`Resize / crop…`, icon: <Crop size={14} />, onSelect: () => openImageEditor(img) },
    ];
    if (selectedImageElementsRef.current.filter((selected) => selected.isConnected).length > 1) {
      items.push({
        label: t`Match sizes to first selected image`,
        icon: <Scaling size={14} />,
        disabled: imageMutationInFlightRef.current,
        onSelect: matchSelectedImageSizes,
      });
    }
    items.push(
      { label: t`Replace image…`, icon: <Replace size={14} />, onSelect: () => triggerReplaceImage(img) },
      {
        label: anchor ? t`Edit link…` : t`Add link…`,
        icon: anchor ? <Pencil size={14} /> : <Link size={14} />,
        onSelect: () => { selectImage(img); setFocusImageLinkTick((tick) => tick + 1); },
      },
      { label: t`Make imagemap`, icon: <Map size={14} />, onSelect: () => convertImageToImagemap(img) },
    );
    if (anchor) {
      items.push({ label: t`Remove link`, icon: <Unlink size={14} />, onSelect: () => { selectImage(img); updateImageLink(""); } });
    }
    items.push(
      { separator: true },
      { label: t`Copy image URL`, icon: <Copy size={14} />, disabled: !src, onSelect: () => { void navigator.clipboard?.writeText?.(src); } },
      { label: t`Open image in new tab`, icon: <ExternalLink size={14} />, disabled: !src, onSelect: () => { window.open(src, "_blank", "noopener,noreferrer"); } },
      { separator: true },
      { label: t`Delete image`, icon: <Trash2 size={14} />, danger: true, onSelect: () => { selectImage(img); deleteSelectedImage(); } },
    );
    return items;
  }, [convertImageToImagemap, deleteSelectedImage, matchSelectedImageSizes, openImageEditor, selectImage, t, triggerReplaceImage, updateImageLink]);

  const buildImagemapMenuItems = useCallback(
    (mapEl: HTMLElement, clientX: number, clientY: number): ContextMenuItem[] => {
      // Right-click doesn't go through the pointerdown selection path, so the
      // area under the cursor is picked here and becomes what these items act on.
      const areaEl = pickImagemapAreaAtPoint(mapEl, clientX, clientY);
      if (areaEl) selectImagemapArea(areaEl);
      else imagemapElementRef.current = mapEl;
      const items: ContextMenuItem[] = [
        { label: t`Add area`, icon: <Plus size={14} />, onSelect: addImagemapArea },
      ];
      if (areaEl) {
        items.push({ label: t`Delete area`, icon: <Trash2 size={14} />, danger: true, onSelect: deleteImagemapArea });
      }
      items.push(
        { separator: true },
        { label: t`Back to plain image`, icon: <Image size={14} />, onSelect: () => convertImagemapToImage(mapEl) },
        { separator: true },
        { label: t`Delete imagemap`, icon: <Trash2 size={14} />, danger: true, onSelect: () => deleteImagemap(mapEl) },
      );
      return items;
    },
    [addImagemapArea, convertImagemapToImage, deleteImagemap, deleteImagemapArea, pickImagemapAreaAtPoint, selectImagemapArea, t],
  );

  const buildLinkMenuItems = useCallback((anchor: HTMLAnchorElement): ContextMenuItem[] => {
    const href = anchor.getAttribute("href") ?? "";
    const selection = window.getSelection();
    const hasSelection = !!selection && !selection.isCollapsed && selection.toString().length > 0;
    return [
      { label: t`Edit link…`, icon: <Pencil size={14} />, onSelect: () => selectLink(anchor) },
      { label: t`Open link`, icon: <ExternalLink size={14} />, disabled: !href, onSelect: () => { window.open(href, "_blank", "noopener,noreferrer"); } },
      { label: t`Copy link URL`, icon: <Copy size={14} />, disabled: !href, onSelect: () => { void navigator.clipboard?.writeText?.(href); } },
      { separator: true },
      // A gradient link's colors live on the link text, so offer the painter here too.
      { label: t`Copy formatting`, icon: <Copy size={14} />, disabled: !hasSelection, onSelect: copyFormatting },
      { label: t`Paste formatting`, icon: <ClipboardPaste size={14} />, disabled: !hasSelection || !capturedColorsRef.current, onSelect: pasteFormatting },
      { separator: true },
      { label: t`Remove link`, icon: <Unlink size={14} />, onSelect: () => { selectLink(anchor); removeSelectedLink(); } },
    ];
  }, [copyFormatting, pasteFormatting, removeSelectedLink, selectLink, t]);

  const buildTextMenuItems = useCallback((): ContextMenuItem[] => {
    const selection = window.getSelection();
    const hasSelection = !!selection && !selection.isCollapsed && selection.toString().length > 0;
    return [
      { label: t`Cut`, icon: <Scissors size={14} />, disabled: !hasSelection, onSelect: cutSelection },
      { label: t`Copy`, icon: <Copy size={14} />, disabled: !hasSelection, onSelect: copySelection },
      { label: t`Paste`, icon: <ClipboardPaste size={14} />, onSelect: () => { void pasteFromClipboard(); } },
      { separator: true },
      { label: t`Bold`, icon: <Bold size={14} />, onSelect: () => applyInline("bold", "b", "text") },
      { label: t`Italic`, icon: <Italic size={14} />, onSelect: () => applyInline("italic", "i", "text") },
      { label: t`Underline`, icon: <Underline size={14} />, onSelect: () => applyInline("underline", "u", "text") },
      { label: t`Text color…`, icon: <Palette size={14} />, onSelect: () => openDialog("color") },
      { label: t`Add link…`, icon: <Link size={14} />, onSelect: () => openDialog("link") },
      { separator: true },
      { label: t`Copy formatting`, icon: <Copy size={14} />, disabled: !hasSelection, onSelect: copyFormatting },
      { label: t`Paste formatting`, icon: <ClipboardPaste size={14} />, disabled: !hasSelection || !capturedColorsRef.current, onSelect: pasteFormatting },
      { separator: true },
      { label: t`Clear formatting`, icon: <Eraser size={14} />, onSelect: () => execVisual("removeFormat") },
    ];
  }, [applyInline, copyFormatting, copySelection, cutSelection, execVisual, openDialog, pasteFormatting, pasteFromClipboard, t]);

  const handleVisualContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const root = visualRef.current;
    const target = event.target as HTMLElement | null;
    if (!root || !target || !root.contains(target)) return;
    event.preventDefault();
    // Snapshot the right-click caret so a later Paste lands where clicked.
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
      visualRangeRef.current = selection.getRangeAt(0).cloneRange();
    }
    const mapEl = target.closest<HTMLElement>('.imagemap[data-bb="imagemap"]');
    const img = target.closest<HTMLImageElement>("img");
    const anchor = target.closest<HTMLAnchorElement>('a[data-bb="url"]');
    let items: ContextMenuItem[];
    if (mapEl && root.contains(mapEl)) {
      items = buildImagemapMenuItems(mapEl, event.clientX, event.clientY);
    } else if (img && root.contains(img) && !img.closest(".bbcode-editor-embed")) {
      // Right-clicking one member of a multi-selection must not collapse it
      // before the size-matching command gets a chance to use the group.
      if (!img.classList.contains("is-selected") || selectedImageElementsRef.current.length < 2) {
        selectImage(img);
      }
      items = buildImageMenuItems(img);
    } else if (anchor && root.contains(anchor)) {
      items = buildLinkMenuItems(anchor);
    } else {
      items = buildTextMenuItems();
    }
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }, [buildImageMenuItems, buildImagemapMenuItems, buildLinkMenuItems, buildTextMenuItems, selectImage]);

  // Focus the image-link field when the context menu asks to edit it.
  useEffect(() => {
    if (focusImageLinkTick === 0) return;
    imageLinkInputRef.current?.focus();
    imageLinkInputRef.current?.select();
  }, [focusImageLinkTick]);

  // Close whatever is docked in the bottom overlay (a tool dialog, a selection
  // inspector, or an upload message).
  const dismissOverlay = useCallback(() => {
    if (dialog) setDialog(null);
    if (imageSelection) clearImageSelection();
    if (linkSelection) clearLinkSelection();
    if (imagemapSelection) clearImagemapSelection();
    if (uploadStatus) setUploadStatus(null);
  }, [clearImageSelection, clearImagemapSelection, clearLinkSelection, dialog, imageSelection, imagemapSelection, linkSelection, uploadStatus]);

  // Measure the floating overlay so the surface can offset its content by it.
  const setOverlayNode = useCallback((node: HTMLDivElement | null) => {
    overlayObserverRef.current?.disconnect();
    overlayObserverRef.current = null;
    if (!node) {
      setOverlayHeight(0);
      return;
    }
    setOverlayHeight(node.offsetHeight);
    if (typeof ResizeObserver !== "undefined") {
      overlayObserverRef.current = new ResizeObserver(() => setOverlayHeight(node.offsetHeight));
      overlayObserverRef.current.observe(node);
    }
  }, []);

  useEffect(() => () => overlayObserverRef.current?.disconnect(), []);

  const surfacePadBottom = overlayHeight ? overlayHeight + 12 : undefined;

  // If the bottom-docked overlay covers the selected element, scroll the
  // surface just enough to bring it back into view above the overlay.
  useEffect(() => {
    if (!overlayHeight) return;
    const surface = visualRef.current;
    // The frame is the scroller, and its box is the part of the column on screen.
    const frame = visualFrameRef.current;
    if (!surface || !frame) return;
    const el = imageSelection
      ? imageElementRef.current
      : imagemapSelection
        ? imagemapElementRef.current
        : linkSelection
          ? linkElementRef.current
          : null;
    if (!el || !surface.contains(el)) return;
    const frameRect = frame.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const visibleBottom = frameRect.bottom - overlayHeight;
    if (rect.bottom <= visibleBottom) return;
    const delta = Math.min(rect.bottom - visibleBottom + 12, Math.max(0, rect.top - frameRect.top));
    if (delta > 0) frame.scrollTop += delta;
  }, [overlayHeight, imageSelection, imagemapSelection, linkSelection]);

  const charCount = source.length;
  const pendingImageCount = useMemo(() => pendingBlobUrls(deferredSource).length, [deferredSource]);

  const renderImageInspector = (): ReactNode => {
    if (!imageSelection) return null;
    if (selectedImageCount > 1) {
      return (
        <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 pr-10 border-b border-osu-b3/30 bg-osu-b5/50">
          <div className="pr-1 text-[11px] font-semibold uppercase tracking-wide text-osu-f1">
            <Plural value={selectedImageCount} one="# image selected" other="# images selected" />
          </div>
          <button
            type="button"
            onClick={matchSelectedImageSizes}
            disabled={imageMutationBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-osu-h1/20 border border-osu-h1/40 text-[12px] font-semibold text-osu-c1 hover:bg-osu-h1/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          >
            <Scaling size={14} /> <Trans>Match sizes to first selected image</Trans>
          </button>
          <span className="text-[11px] text-osu-f1"><Trans>Ctrl/Cmd-click images to add or remove them.</Trans></span>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-end gap-2.5 px-4 py-3 pr-10 border-b border-osu-b3/30 bg-osu-b5/50">
        <div className="self-center pr-1 text-[11px] font-semibold uppercase tracking-wide text-osu-f1"><Trans>Image</Trans></div>
        <DialogField label={t`Link URL (optional)`}>
          <input
            ref={imageLinkInputRef}
            type="text"
            value={imageSelection.href}
            onChange={(event) => updateImageLink(event.target.value)}
            placeholder={t`https://... wraps the image in a link`}
            className={`${dialogInputClass} w-72`}
          />
        </DialogField>
        <button
          type="button"
          onClick={() => imageElementRef.current && openImageEditor(imageElementRef.current)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-osu-b4/70 border border-osu-b3/40 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors cursor-pointer"
        >
          <Crop size={14} /> <Trans>Resize / crop</Trans>
        </button>
        <button
          type="button"
          onClick={() => imageElementRef.current && triggerReplaceImage(imageElementRef.current)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-osu-b4/70 border border-osu-b3/40 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors cursor-pointer"
        >
          <Replace size={14} /> <Trans>Replace</Trans>
        </button>
        <button
          type="button"
          title={t`Remove image`}
          aria-label={t`Remove image`}
          onClick={deleteSelectedImage}
          className="grid h-8 w-8 place-items-center rounded-md border border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20 hover:text-white transition-colors cursor-pointer"
        >
          <Trash2 size={15} />
        </button>
      </div>
    );
  };

  const renderImagemapInspector = (): ReactNode => {
    if (!imagemapSelection) return null;
    return (
      <div className="flex flex-wrap items-end gap-2.5 px-4 py-3 pr-10 border-b border-osu-b3/30 bg-osu-b5/50">
        <div className="flex items-center gap-1.5 self-center pr-1 text-[11px] font-semibold uppercase tracking-wide text-osu-f1">
          <span><Trans>Imagemap area {imagemapSelection.areaIndex + 1}/{imagemapSelection.areaCount}</Trans></span>
          <button
            type="button"
            title={t`Previous area`}
            aria-label={t`Previous area`}
            onClick={() => selectImagemapAreaByIndex(imagemapSelection.areaIndex - 1)}
            className="grid h-7 w-7 place-items-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white cursor-pointer"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            title={t`Next area`}
            aria-label={t`Next area`}
            onClick={() => selectImagemapAreaByIndex(imagemapSelection.areaIndex + 1)}
            className="grid h-7 w-7 place-items-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white cursor-pointer"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <DialogField label={t`URL`}>
          <input
            type="text"
            value={imagemapSelection.href}
            onChange={(event) => updateImagemapSelectionField("href", event.target.value)}
            placeholder="#"
            className={`${dialogInputClass} w-64`}
          />
        </DialogField>
        <DialogField label={t`Title`}>
          <input
            type="text"
            value={imagemapSelection.title}
            onChange={(event) => updateImagemapSelectionField("title", event.target.value)}
            className={`${dialogInputClass} w-44`}
          />
        </DialogField>

        <button
          type="button"
          title={t`Add area`}
          aria-label={t`Add area`}
          onClick={addImagemapArea}
          className="grid h-8 w-8 place-items-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white cursor-pointer"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          title={t`Delete area`}
          aria-label={t`Delete area`}
          onClick={deleteImagemapArea}
          className="grid h-8 w-8 place-items-center rounded-md border border-osu-red/40 bg-osu-red/10 text-osu-red-light transition-colors hover:bg-osu-red/20 hover:text-white cursor-pointer"
        >
          <Trash2 size={15} />
        </button>
      </div>
    );
  };

  const renderLinkInspector = (): ReactNode => {
    if (!linkSelection) return null;
    return (
      <div className="flex flex-wrap items-end gap-2.5 px-4 py-3 pr-10 border-b border-osu-b3/30 bg-osu-b5/50">
        <div className="self-center pr-1 text-[11px] font-semibold uppercase tracking-wide text-osu-f1">
          <Trans>Link</Trans>
        </div>
        <DialogField label={t`URL`}>
          <input
            type="text"
            value={linkSelection.href}
            onChange={(event) => updateSelectedLinkHref(event.target.value)}
            placeholder="https://..."
            className={`${dialogInputClass} w-80`}
          />
        </DialogField>
        <DialogField label={t`Text`}>
          <input
            type="text"
            value={linkSelection.text}
            onChange={(event) => updateSelectedLinkText(event.target.value)}
            className={`${dialogInputClass} w-48`}
          />
        </DialogField>
        <button
          type="button"
          title={t`Remove link`}
          aria-label={t`Remove link`}
          onClick={removeSelectedLink}
          className="grid h-8 w-8 place-items-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white cursor-pointer"
        >
          <Unlink size={15} />
        </button>
      </div>
    );
  };

  const renderDialog = (): ReactNode => {
    switch (dialog) {
      case "color": {
        const applyColor = (color: string) =>
          applyAndClose(() => {
            if (editMode === "visual") {
              const text = selectedDialogText();
              if (text) {
                const inner = visualSelectionHtml();
                // A multi-line selection can't be wrapped in one inline [color]
                // span - let the browser color each line so nothing gets wiped.
                if (/<(br|div|p|h[1-6]|center|blockquote|ul|ol|li|pre)\b/i.test(inner)) {
                  applyVisualForeColor(color);
                  return;
                }
                // Single line: replace in place (keeps inner bold/links, swaps an
                // old color span) instead of nesting a fresh [color] around it.
                const { open, close } = editableWrapMarkup("color", color);
                replaceVisualSelectionHtml(text, open + (inner || escapeBBHtml(text)) + close);
                return;
              }
            }
            applyWrap("color", color, `[color=${color}]`, "[/color]", "text");
          });
        const activeHex = normalizeHexColor(hexField);
        const signedHueShift = `${hueShift > 0 ? "+" : ""}${hueShift}`;
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (activeHex) applyColor(activeHex);
            }}
          >
            <div className="flex items-center gap-1.5">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  title={swatch}
                  onClick={() => applyColor(swatch)}
                  className={`w-6 h-6 rounded-md cursor-pointer hover:scale-110 transition-transform ${
                    activeHex === swatch
                      ? "border-2 border-osu-c1 ring-2 ring-osu-pink/70"
                      : "border border-osu-b3/60"
                  }`}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
            <DialogField label={t`Custom`}>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={normalizeHexColor(hexField) ?? "#FF66AA"}
                  onChange={(event) => setHexField(event.target.value.toUpperCase())}
                  className="w-8 h-8 rounded-md bg-osu-b5 border border-osu-b3/50 cursor-pointer p-0.5"
                />
                <input
                  type="text"
                  value={hexField}
                  onChange={(event) => setHexField(event.target.value)}
                  placeholder="#FF66AA"
                  className={`${dialogInputClass} w-24`}
                />
              </div>
            </DialogField>
            <button type="submit" className={dialogApplyClass} disabled={!normalizeHexColor(hexField)}>
              <Trans>Apply</Trans>
            </button>
            {editMode === "visual" && selectedDialogText() ? (
              <DialogField label={t`Shift hue (${signedHueShift}°)`}>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={5}
                  value={hueShift}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    shiftSelectionHue(value - hueShiftRef.current);
                    hueShiftRef.current = value;
                    setHueShift(value);
                  }}
                  className="w-40 accent-osu-pink cursor-pointer"
                  title={t`Rotate every color in the selection`}
                />
              </DialogField>
            ) : null}
          </form>
        );
      }
      case "gradient":
        return (
          <form
            className="space-y-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!gradientPreview) return;
              const text = textField || selectedDialogText();
              if (!text) return;
              const snippet = buildGradientBBCode(text, gradientStops, gradientMirror);
              applyAndClose(() => {
                if (editMode === "visual") replaceVisualSelectionHtml(text, bbcodeToEditableHtml(snippet));
                else insertSnippet(snippet);
              });
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <DialogField label={t`Text (replaces the selection)`}>
                <input
                  type="text"
                  value={textField}
                  onChange={(event) => setTextField(event.target.value)}
                  placeholder={t`select text or type it here`}
                  className={`${dialogInputClass} w-56`}
                />
              </DialogField>
              <DialogField label={t`Colors`}>
                <div className="flex items-center gap-1">
                  {gradientStops.map((stop, index) => (
                    <span key={index} className="relative group/stop">
                      <input
                        type="color"
                        value={normalizeHexColor(stop) ?? "#FFFFFF"}
                        onChange={(event) => {
                          const value = event.target.value.toUpperCase();
                          setGradientStops((stops) => stops.map((s, i) => (i === index ? value : s)));
                        }}
                        className="w-8 h-8 rounded-md bg-osu-b5 border border-osu-b3/50 cursor-pointer p-0.5"
                      />
                      {gradientStops.length > 2 ? (
                        <button
                          type="button"
                          title={t`Remove color`}
                          aria-label={t`Remove color`}
                          onClick={() => setGradientStops((stops) => stops.filter((_, i) => i !== index))}
                          className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 hidden group-hover/stop:flex items-center justify-center rounded-full bg-osu-b2 text-osu-c1 text-[9px] leading-none cursor-pointer"
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))}
                  {gradientStops.length < GRADIENT_MAX_STOPS ? (
                    <button
                      type="button"
                      title={t`Add color`}
                      aria-label={t`Add color`}
                      onClick={() => setGradientStops((stops) => [...stops, stops[stops.length - 1]])}
                      className="w-8 h-8 rounded-md border border-dashed border-osu-b3/60 text-osu-f1 hover:text-osu-c1 hover:border-osu-b2 transition-colors cursor-pointer text-sm"
                    >
                      +
                    </button>
                  ) : null}
                </div>
              </DialogField>
              <label className="flex items-center gap-1.5 pb-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={gradientMirror}
                  onChange={(event) => setGradientMirror(event.target.checked)}
                  className="accent-(--color-osu-pink) cursor-pointer"
                />
                <span className="text-[12px] text-osu-l2"><Trans>Mirror (out and back)</Trans></span>
              </label>
              <button type="submit" className={dialogApplyClass} disabled={!gradientPreview || !(textField || selectedDialogText())}>
                <Trans>Apply</Trans>
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                {GRADIENT_PRESETS.map((preset, presetIndex) => {
                  // The preset's own name is drawn in its own gradient, so the
                  // translated label is what gets coloured character by character.
                  const label = i18n._(preset.label);
                  const colors = gradientCharColors(label, preset.stops, preset.mirror) ?? [];
                  return (
                    <button
                      key={presetIndex}
                      type="button"
                      onClick={() => {
                        setGradientStops(preset.stops);
                        setGradientMirror(preset.mirror);
                      }}
                      className="px-2 py-1 rounded-md bg-osu-b5 border border-osu-b3/50 text-[11px] font-semibold cursor-pointer hover:bg-osu-b3 transition-colors"
                    >
                      {Array.from(label).map((char, index) => (
                        <span key={index} style={colors[index] ? { color: colors[index] } : undefined}>{char}</span>
                      ))}
                    </button>
                  );
                })}
              </div>
              {gradientPreview ? (
                <div className="text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis max-w-64">
                  {Array.from(gradientPreview.text).map((char, index) => {
                    const color = gradientPreview.colors[index];
                    return (
                      <span key={index} style={color ? { color } : undefined}>{char}</span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </form>
        );
      case "size": {
        const applySize = (size: number) =>
          applyAndClose(() => applyWrap("size", String(size), `[size=${size}]`, "[/size]", "text"));
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const size = Number(customSize);
              if (!Number.isInteger(size) || size < 30 || size > 200) return;
              applySize(size);
            }}
          >
            <div className="flex items-center gap-1.5">
              {SIZE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => applySize(preset.value)}
                  className="px-2.5 py-1.5 rounded-md bg-osu-b5 border border-osu-b3/50 text-[12px] text-osu-l2 hover:bg-osu-b3 hover:text-osu-c1 transition-colors cursor-pointer"
                >
                  {i18n._(preset.label)} ({preset.value})
                </button>
              ))}
            </div>
            <DialogField label={t`Custom (30-200)`}>
              <input
                type="number"
                min={30}
                max={200}
                value={customSize}
                onChange={(event) => setCustomSize(event.target.value)}
                className={`${dialogInputClass} w-24`}
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass}><Trans>Apply</Trans></button>
          </form>
        );
      }
      case "link":
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const href = urlField.trim();
              if (!/^https?:\/\/\S+$/i.test(href)) return;
              const text = textField.trim();
              applyAndClose(() => {
                if (editMode === "visual") {
                  const inner = escapeBBHtml(text) || visualSelectionHtml() || escapeBBHtml(href);
                  const { open, close } = editableWrapMarkup("url", href);
                  insertVisualHtml(open + inner + close);
                } else {
                  insertSnippet(text ? `[url=${href}]${text}[/url]` : `[url]${href}[/url]`);
                }
              });
            }}
          >
            <DialogField label={t`URL`}>
              <input
                type="url"
                value={urlField}
                onChange={(event) => setUrlField(event.target.value)}
                placeholder="https://..."
                className={`${dialogInputClass} w-72`}
                autoFocus
              />
            </DialogField>
            <DialogField label={t`Text (optional)`}>
              <input
                type="text"
                value={textField}
                onChange={(event) => setTextField(event.target.value)}
                placeholder={t`link text`}
                className={`${dialogInputClass} w-48`}
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass} disabled={!/^https?:\/\/\S+$/i.test(urlField.trim())}>
              <Trans>Insert</Trans>
            </button>
          </form>
        );
      case "image":
      case "audio": {
        const label = dialog === "image" ? t`Image URL` : t`Audio URL (mp3)`;
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const href = urlField.trim();
              if (!/^https?:\/\/\S+$/i.test(href)) return;
              const tag = dialog === "image" ? "img" : "audio";
              applyAndClose(() => insertBBCode(`[${tag}]${href}[/${tag}]`));
            }}
          >
            <DialogField label={label}>
              <input
                type="url"
                value={urlField}
                onChange={(event) => setUrlField(event.target.value)}
                placeholder="https://..."
                className={`${dialogInputClass} w-80`}
                autoFocus
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass} disabled={!/^https?:\/\/\S+$/i.test(urlField.trim())}>
              <Trans>Insert</Trans>
            </button>
          </form>
        );
      }
      case "youtube":
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const videoId = parseYoutubeInput(urlField);
              if (!videoId) return;
              applyAndClose(() => insertBBCode(`[youtube]${videoId}[/youtube]`));
            }}
          >
            <DialogField label={t`Video URL or id`}>
              <input
                type="text"
                value={urlField}
                onChange={(event) => setUrlField(event.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                className={`${dialogInputClass} w-80`}
                autoFocus
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass} disabled={!parseYoutubeInput(urlField)}>
              <Trans>Insert</Trans>
            </button>
          </form>
        );
      case "profile":
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const name = textField.trim();
              if (!name) return;
              const id = urlField.trim();
              applyAndClose(() => insertBBCode(id ? `[profile=${id}]${name}[/profile]` : `[profile]${name}[/profile]`));
            }}
          >
            <DialogField label={t`Username`}>
              <input
                type="text"
                value={textField}
                onChange={(event) => setTextField(event.target.value)}
                placeholder={t`username`}
                className={`${dialogInputClass} w-48`}
                autoFocus
              />
            </DialogField>
            <DialogField label={t`User id (optional)`}>
              <input
                type="text"
                value={urlField}
                onChange={(event) => setUrlField(event.target.value)}
                placeholder="7095193"
                className={`${dialogInputClass} w-32`}
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass} disabled={!textField.trim()}>
              <Trans>Insert</Trans>
            </button>
          </form>
        );
      case "box":
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const title = textField.trim();
              applyAndClose(() => {
                if (editMode === "visual") {
                  wrapVisual("box", title || undefined, "content");
                } else if (title) {
                  wrapSelection(`[box=${title}]\n`, "\n[/box]", "content");
                } else {
                  wrapSelection("[spoilerbox]\n", "\n[/spoilerbox]", "content");
                }
              });
            }}
          >
            <DialogField label={t`Box title (empty for SPOILER)`}>
              <input
                type="text"
                value={textField}
                onChange={(event) => setTextField(event.target.value)}
                placeholder={t`title`}
                className={`${dialogInputClass} w-56`}
                autoFocus
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass}><Trans>Insert</Trans></button>
          </form>
        );
      default:
        return null;
    }
  };

  const paneHeightClass = "h-[480px] lg:h-[580px]";

  return (
    <div className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-osu-b3/30">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-osu-c1"><Trans>BBCode editor</Trans></div>
          <div className="text-[12px] text-osu-f1 truncate">
            {/* Two messages rather than one with a placeholder, so the link text
                is part of what gets translated. The plain branch is the same
                message the /bbcode skeleton renders. */}
            {userId != null && username ? (
              <Trans>
                Edits stay in this browser. Copy the result and paste it into the me! editor on{" "}
                <a
                  href={`https://osu.ppy.sh/users/${userId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-osu-pink-light hover:text-osu-pink underline"
                >
                  your osu! page
                </a>.
              </Trans>
            ) : (
              <Trans>Edits stay in this browser. Copy the result and paste it into the me! editor on your osu! page.</Trans>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={copyBBCode}
            // Also while resizing: that swaps an image's src when it lands, and
            // copying mid-swap would put the pre-resize file on the clipboard.
            disabled={imageMutationBusy
              || uploadStatus?.kind === "uploading"
              || uploadStatus?.kind === "copying"
              || uploadStatus?.kind === "resizing"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait ${
              copied
                ? "bg-osu-green/20 border border-osu-green/40 text-osu-green"
                : "bg-osu-h1/20 border border-osu-h1/40 text-osu-c1 hover:bg-osu-h1/30"
            }`}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? <Trans>Copied</Trans> : <Trans>Copy BBCode</Trans>}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              title={t`Close editor`}
              aria-label={t`Close editor`}
              className="w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Load an existing me! page as a starting point or to recover after a clear.
          Only while the editor is empty, so it can never clobber in-progress work. */}
      {(enableLoadFromUser || (enableLoadOwnPage && userId != null)) && source.trim().length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-osu-b3/30 bg-osu-b5/40">
          {enableLoadFromUser ? (
            <>
              <span className="text-[12px] font-semibold text-osu-f1 shrink-0"><Trans>Load a player's me! page</Trans></span>
              <SearchInput
                className="w-full sm:w-64"
                placeholder={t`find player...`}
                onSearch={searchPlayers}
                onSelect={loadUserPage}
              />
            </>
          ) : (
            <>
              <span className="text-[12px] font-semibold text-osu-f1 shrink-0"><Trans>Start from your live me! page</Trans></span>
              <button
                type="button"
                onClick={() => loadUserPage({ id: userId!, username: username ?? "" })}
                disabled={loadingUserPage}
                className={dialogApplyClass}
              >
                <Trans>Load my me! page</Trans>
              </button>
            </>
          )}
          {loadingUserPage ? (
            <span className="flex items-center gap-1.5 text-[12px] text-osu-f1">
              <span className="h-3.5 w-3.5 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
              <Trans>Loading me! page...</Trans>
            </span>
          ) : loadStatus?.kind === "error" ? (
            <span className="text-[12px] text-osu-red"><Trans>Couldn't load that me! page.</Trans></span>
          ) : loadStatus?.kind === "empty" ? (
            <span className="text-[12px] text-osu-yellow"><Trans>{loadStatus.name}'s me! page is empty.</Trans></span>
          ) : loadStatus?.kind === "loaded" ? (
            <span className="text-[12px] text-osu-l2"><Trans>Loaded {loadStatus.name}'s me! page into the editor.</Trans></span>
          ) : null}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-osu-b3/30 overflow-x-auto">
        <ToolButton label={t`Bold`} active={editMode === "visual" && inlineStates.bold} onClick={() => applyInline("bold", "b", "text")}><Bold size={15} /></ToolButton>
        <ToolButton label={t`Italic`} active={editMode === "visual" && inlineStates.italic} onClick={() => applyInline("italic", "i", "text")}><Italic size={15} /></ToolButton>
        <ToolButton label={t`Underline`} active={editMode === "visual" && inlineStates.underline} onClick={() => applyInline("underline", "u", "text")}><Underline size={15} /></ToolButton>
        <ToolButton label={t`Strikethrough`} active={editMode === "visual" && inlineStates.strike} onClick={() => applyInline("strikeThrough", "s", "text")}><Strikethrough size={15} /></ToolButton>
        <ToolButton label={t`Spoiler text`} onClick={() => applyWrap("spoiler", undefined, "[spoiler]", "[/spoiler]", "secret")}><EyeOff size={15} /></ToolButton>
        <ToolDivider />
        <ToolButton label={t`Text color`} active={dialog === "color" || (editMode === "visual" && selectionColor != null)} onClick={() => openDialog("color")}><Palette size={15} /></ToolButton>
        <ToolButton label={t`Gradient text`} active={dialog === "gradient"} onClick={() => openDialog("gradient")}><Rainbow size={15} /></ToolButton>
        <ToolButton label={t`Text size`} active={dialog === "size" || (editMode === "visual" && selectionSize != null)} onClick={() => openDialog("size")}><ALargeSmall size={15} /></ToolButton>
        <ToolDivider />
        <ToolButton label={t`Link`} active={dialog === "link"} onClick={() => openDialog("link")}><Link size={15} /></ToolButton>
        <ToolButton label={t`Image`} active={dialog === "image"} onClick={() => openDialog("image")}><Image size={15} /></ToolButton>
        <ToolButton label={t`YouTube video`} active={dialog === "youtube"} onClick={() => openDialog("youtube")}><Youtube size={15} /></ToolButton>
        <ToolButton label={t`Audio`} active={dialog === "audio"} onClick={() => openDialog("audio")}><Music size={15} /></ToolButton>
        <ToolButton label={t`Profile link`} active={dialog === "profile"} onClick={() => openDialog("profile")}><UserRound size={15} /></ToolButton>
        <ToolDivider />
        <ToolButton label={t`Heading`} onClick={() => applyWrap("heading", undefined, "[heading]", "[/heading]", "Heading")}><Heading1 size={15} /></ToolButton>
        <ToolButton label={t`Align left`} active={editMode === "visual" && selectionAlign === "left"} onClick={() => applyWrap("left", undefined, "[left]", "[/left]", "text")}><AlignLeft size={15} /></ToolButton>
        <ToolButton label={t`Center`} active={editMode === "visual" && selectionAlign === "centre"} onClick={() => applyWrap("centre", undefined, "[centre]", "[/centre]", "text")}><AlignCenter size={15} /></ToolButton>
        <ToolButton label={t`Align right`} active={editMode === "visual" && selectionAlign === "right"} onClick={() => applyWrap("right", undefined, "[right]", "[/right]", "text")}><AlignRight size={15} /></ToolButton>
        <ToolButton label="Quote" onClick={() => applyWrap("quote", undefined, "[quote]", "[/quote]", "quote")}><TextQuote size={15} /></ToolButton>
        <ToolButton label={t`Notice`} onClick={() => applyWrap("notice", undefined, "[notice]\n", "\n[/notice]", "important")}><Megaphone size={15} /></ToolButton>
        <ToolButton label={t`Collapsible box`} active={dialog === "box"} onClick={() => openDialog("box")}><ChevronsDownUp size={15} /></ToolButton>
        <ToolButton label={t`Inline code`} onClick={() => applyWrap("c", undefined, "[c]", "[/c]", "code")}><Braces size={15} /></ToolButton>
        <ToolButton label={t`Code block`} onClick={() => applyWrap("codeblock", undefined, "[code]\n", "\n[/code]", "code")}><Code size={15} /></ToolButton>
        <ToolButton label={t`Bullet list`} onClick={() => insertList(false)}><List size={15} /></ToolButton>
        <ToolButton label={t`Numbered list`} onClick={() => insertList(true)}><ListOrdered size={15} /></ToolButton>
        <ToolButton label={t`Imagemap (clickable areas on an image)`} onClick={applyImagemapTool}>
          <Map size={15} />
        </ToolButton>
        <div className="ml-auto pl-2 flex items-center gap-0.5 shrink-0">
          {(["visual", "code"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => switchMode(mode)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wide cursor-pointer transition-colors ${
                editMode === mode
                  ? "bg-osu-h1/20 text-osu-c1 border border-osu-h1/40"
                  : "text-osu-f1 border border-transparent hover:text-osu-l2"
              }`}
            >
              {mode === "visual" ? t`Visual` : "BBCode"}
            </button>
          ))}
        </div>
      </div>

      {restoredDraft ? (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-osu-b3/30 text-[12px] text-osu-yellow">
          <Trans>Restored an unsaved draft from this browser.</Trans>
          <button
            type="button"
            onClick={() => {
              setRestoredDraft(false);
              updateSource(baseSource);
              clearStored(draftKey);
              setVisualEpoch((epoch) => epoch + 1);
            }}
            className="underline text-osu-l2 hover:text-osu-c1 cursor-pointer"
          >
            <Trans>Discard draft</Trans>
          </button>
        </div>
      ) : null}

      <div className="relative">
        {/* Inspectors, upload status and tool dialogs dock to the bottom of the
            editing surface as an overlay: nothing above them reflows or shifts,
            and the surface's bottom padding keeps covered content scrollable. */}
        {(imagemapSelection || linkSelection || imageSelection || uploadStatus || dialog) ? (
          <div ref={setOverlayNode} className="absolute inset-x-0 bottom-0 z-20 max-h-full overflow-y-auto bg-osu-b4 border-t border-osu-b3/40 shadow-[0_-8px_24px_rgba(0,0,0,0.35)]">
            <button
              type="button"
              onClick={dismissOverlay}
              title={t`Close`}
              aria-label={t`Close`}
              className="absolute top-1.5 right-1.5 z-10 grid h-6 w-6 place-items-center rounded-md text-osu-f1 hover:text-white hover:bg-osu-b3/60 transition-colors cursor-pointer"
            >
              <X size={15} />
            </button>
            {renderImagemapInspector()}
            {renderLinkInspector()}
            {renderImageInspector()}

            {uploadStatus ? (
              <div
                className={`flex items-center gap-2 px-4 py-2 border-b border-osu-b3/30 text-[12px] ${
                  uploadStatus.kind === "error" ? "text-osu-red" : "text-osu-l2"
                }`}
              >
                {uploadStatus.kind === "uploading" || uploadStatus.kind === "copying" || uploadStatus.kind === "resizing" ? (
                  <>
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
                    {uploadStatus.kind === "resizing"
                      ? t`Resizing image...`
                      : uploadStatus.kind === "copying"
                        ? t`Copying BBCode...`
                        : t`Uploading image...`}
                  </>
                ) : (
                  <>
                    <span>{uploadStatus.message}</span>
                    <button
                      type="button"
                      onClick={() => setUploadStatus(null)}
                      className="underline text-osu-f1 hover:text-osu-l2 cursor-pointer"
                    >
                      dismiss
                    </button>
                  </>
                )}
              </div>
            ) : null}

            {/* Tool dialog */}
            {dialog ? (
              <div className="px-4 py-3 pr-10 border-b border-osu-b3/30 bg-osu-b5/50">{renderDialog()}</div>
            ) : null}
          </div>
        ) : null}

      {editMode === "visual" ? (
        <div
          ref={visualFrameRef}
          // The docked inspector overlays the bottom of the pane; pad the
          // scroller (not the zoomed column) so the gap is real screen pixels.
          style={{ paddingBottom: surfacePadBottom, scrollPaddingBottom: surfacePadBottom }}
          className={`${paneHeightClass} bbcode-editor-frame`}
        >
          <div
            ref={visualRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onPointerDown={handleVisualPointerDown}
            onContextMenu={handleVisualContextMenu}
            onKeyDown={handleVisualKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onInput={scheduleVisualSync}
            onBlur={() => flushVisual()}
            data-placeholder={t`Write your page here. Select text and use the toolbar to format it. Right-click for more, or paste an image to add it.`}
            className="bbcode-content bbcode-editor-surface py-3 text-sm text-osu-l2 focus:outline-none"
          />
        </div>
      ) : null}
      {editMode === "visual" ? <ColumnScrollPosition frameRef={visualFrameRef} /> : null}
      {editMode === "visual" ? null : (
        <>
          {/* Mobile pane switch */}
          <div className="flex lg:hidden border-b border-osu-b3/30">
            {(["write", "preview"] as const).map((pane) => (
              <button
                key={pane}
                type="button"
                onClick={() => setMobilePane(pane)}
                className={`flex-1 px-4 py-2 text-[12px] font-semibold capitalize cursor-pointer transition-colors ${
                  mobilePane === pane ? "text-osu-c1 border-b-2 border-osu-h1" : "text-osu-f1"
                }`}
              >
                {pane}
              </button>
            ))}
          </div>

          <div className="grid lg:grid-cols-2">
            <div className={`${mobilePane === "write" ? "block" : "hidden"} lg:block lg:border-r border-osu-b3/30`}>
              <div className="relative">
                <div
                  ref={sourceBackdropRef}
                  aria-hidden
                  style={{ paddingBottom: surfacePadBottom }}
                  className={`${paneHeightClass} bbcode-source-backdrop absolute inset-0 overflow-hidden px-4 py-3 text-[13px] leading-relaxed font-mono whitespace-pre-wrap break-words text-transparent pointer-events-none`}
                >
                  {sourceHighlightSpan ? (
                    <>
                      {source.slice(0, sourceHighlightSpan.start)}
                      <mark className="bbcode-live-highlight">{source.slice(sourceHighlightSpan.start, sourceHighlightSpan.end)}</mark>
                      {source.slice(sourceHighlightSpan.end)}
                    </>
                  ) : null}
                  {"\n"}
                </div>
                <textarea
                  ref={textareaRef}
                  value={source}
                  onChange={(event) => {
                    updateSource(event.target.value);
                    setCaretOffset(event.target.selectionStart);
                  }}
                  onSelect={(event) => setCaretOffset(event.currentTarget.selectionStart)}
                  onScroll={syncSourceBackdrop}
                  onPaste={handlePaste}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  spellCheck={false}
                  placeholder={t`Write BBCode here, or paste your current me! page source...`}
                  style={{ paddingBottom: surfacePadBottom }}
                  className={`${paneHeightClass} relative w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed font-mono text-osu-l2 placeholder:text-osu-f1 focus:outline-none`}
                />
              </div>
            </div>
            <div className={`${mobilePane === "preview" ? "block" : "hidden"} lg:block bg-osu-b5/40`}>
              <div
                ref={previewFrameRef}
                style={{ paddingBottom: surfacePadBottom }}
                className={`${paneHeightClass} bbcode-editor-frame`}
              >
                <div className="bbcode-content bbcode-preview-surface py-3 text-sm text-osu-l2">
                  <BBCodePreview
                    source={deferredSource}
                    highlightOffset={deferredCaretOffset}
                    onSelectSourceSpan={selectSourceSpan}
                  />
                </div>
              </div>
              <ColumnScrollPosition frameRef={previewFrameRef} />
            </div>
          </div>
        </>
      )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-osu-b3/30 text-[12px] text-osu-f1">
        <span><Trans>{charCount.toLocaleString("en-US")} characters</Trans></span>
        <span className="hidden sm:inline"><Trans>Draft autosaves locally</Trans></span>
        {pendingImageCount > 0 ? (
          <span className="text-osu-c1">
            <Plural value={pendingImageCount} one="# image uploads on copy" other="# images upload on copy" />
          </span>
        ) : null}
        {hasCapturedFormat ? (
          <span className="hidden sm:inline text-osu-c1"><Trans>formatting copied - right-click text to paste</Trans></span>
        ) : null}
        {/* Only worth offering while the pane is too narrow for a profile. */}
        {fitScale < 0.999 ? (
          <div className="flex items-center gap-0.5">
            {([["fit", t`Fit`], ["full", t`Actual size`]] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => chooseColumnZoom(mode)}
                className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                  columnZoom === mode
                    ? "bg-osu-h1/20 text-osu-c1 border border-osu-h1/40"
                    : "border border-transparent hover:text-osu-l2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          onClick={resetToProfile}
          className={`ml-auto cursor-pointer transition-colors ${
            confirmReset ? "text-osu-red font-semibold" : "text-osu-f1 hover:text-osu-l2 underline"
          }`}
        >
          {confirmReset
            ? (baseSource ? t`Click again to discard edits` : t`Click again to clear`)
            : (baseSource ? t`Reset to current page` : t`Clear editor`)}
        </button>
      </div>

      {/* Hidden picker for "Replace image". */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleReplaceFile}
      />

      <BBCodeContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />

      {imageEditorState ? (
        <ImageEditorModal
          source={imageEditorState.source}
          busy={imageEditorBusy}
          onApply={applyImageEdit}
          onCancel={() => {
            if (imageEditorBusy) return;
            imageEditorTargetRef.current = null;
            setImageEditorState(null);
          }}
        />
      ) : null}
    </div>
  );
}

export default BBCodeEditor;
