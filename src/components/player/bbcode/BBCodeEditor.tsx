import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
import { buildGradientBBCode, containsBBCode, gradientCharColors, normalizeHexColor, parseYoutubeInput, shiftHexHue, type BBSourceSpan } from "../../../lib/bbcode";
import {
  applyColorSequence,
  bbcodeToEditableHtml,
  captureColorSequence,
  cssColorToBB,
  distributeInlineWrap,
  editableWrapMarkup,
  escapeBBHtml,
  serializeBBCodeDom,
  type EditableWrapKind,
} from "../../../lib/bbcode-dom";
import { getUser, searchUsers } from "../../../lib/osu";
import { fetchImageBlobViaProxy, isUploadableImage, uploadImageToCatbox } from "../../../lib/catbox-upload";
import { resizeImageBlobToWidth } from "../../../lib/image-resize";
import { SearchInput } from "../../ui/SearchInput";
import { BBCodePreview } from "./BBCodePreview";
import { BBCodeContextMenu, type ContextMenuItem, type ContextMenuState } from "./BBCodeContextMenu";
import { ImageEditorModal, type ImageEditorSource } from "./ImageEditorModal";

const DRAFT_KEY_PREFIX = "mania-hub-bbcode-draft-v1:";
const DRAFT_SAVE_DEBOUNCE_MS = 400;
const VISUAL_SYNC_DEBOUNCE_MS = 300;

const COLOR_SWATCHES = [
  "#FFFFFF", "#FF66AA", "#B14DE8", "#66A4FF", "#5EE08A",
  "#FFD53D", "#FF7A2F", "#FF4D5E", "#9AA0B0", "#000000",
];

const SIZE_PRESETS: Array<{ label: string; value: number }> = [
  { label: "Tiny", value: 50 },
  { label: "Small", value: 85 },
  { label: "Normal", value: 100 },
  { label: "Large", value: 150 },
];

const GRADIENT_PRESETS: Array<{ label: string; stops: string[]; mirror: boolean }> = [
  { label: "Gold", stops: ["#E6821E", "#FDE071"], mirror: true },
  { label: "Pink", stops: ["#FF66AA", "#FFD1E8"], mirror: true },
  { label: "Purple", stops: ["#B14DE8", "#FF9ECF"], mirror: false },
  { label: "Rainbow", stops: ["#FF4D5E", "#FFB42F", "#FFE45E", "#5EE08A", "#66A4FF", "#B14DE8"], mirror: false },
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
const BLOCK_WRAP_KINDS = new Set<EditableWrapKind>(["heading", "centre", "notice", "quote", "codeblock", "box"]);

const UPLOAD_TOKEN_PATTERN = /\[uploading image #up-\d+\]/g;
function stripUploadTokens(value: string): string {
  return value.replace(UPLOAD_TOKEN_PATTERN, "");
}

// Pasted/dropped images are held as local blob: URLs until the user copies, then
// uploaded and swapped for real URLs. Blob URLs are session-only, so they're
// stripped from the saved draft (a reloaded blob URL points at nothing).
const PENDING_IMG_PATTERN = /\[img\](blob:[^\[\]]+)\[\/img\]/g;
function stripPendingImages(value: string): string {
  return value.replace(PENDING_IMG_PATTERN, "");
}

function readDraft(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDraft(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota or privacy mode; the editor keeps working without drafts.
  }
}

function clearDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore.
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

function removeImageResizeHandle(surface: HTMLElement | null) {
  surface?.querySelectorAll(".bbcode-image-resize-handle").forEach((handle) => handle.remove());
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
  const draftKey = `${DRAFT_KEY_PREFIX}${userId ?? "guest"}`;
  const baseSource = initialSource ?? "";
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [source, setSource] = useState<string>(() => {
    const draft = readDraft(draftKey);
    if (draft != null && draft !== baseSource) {
      setRestoredDraft(true);
      return draft;
    }
    return baseSource;
  });
  const [editMode, setEditMode] = useState<EditMode>("visual");
  const [dialog, setDialog] = useState<ToolDialog | null>(null);
  const [mobilePane, setMobilePane] = useState<"write" | "preview">("write");
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [loadingUserPage, setLoadingUserPage] = useState(false);
  const [loadStatus, setLoadStatus] = useState<{ kind: "loaded" | "empty" | "error"; name?: string } | null>(null);
  const [inlineStates, setInlineStates] = useState({ bold: false, italic: false, underline: false, strike: false });
  const [imagemapSelection, setImagemapSelection] = useState<ImagemapSelection | null>(null);
  const [linkSelection, setLinkSelection] = useState<LinkSelection | null>(null);
  const [imageSelection, setImageSelection] = useState<ImageSelection | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [imageEditorState, setImageEditorState] = useState<{ source: ImageEditorSource } | null>(null);
  const [imageEditorBusy, setImageEditorBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ kind: "uploading" | "error"; message?: string } | null>(null);
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
  const resizeHandleRef = useRef<HTMLSpanElement | null>(null);
  const imageResizeRef = useRef<{ img: HTMLImageElement; startX: number; startWidth: number; maxWidth: number } | null>(null);
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

  // Build (or rebuild) the visual editing surface from the current source.
  useEffect(() => {
    if (editMode !== "visual") return;
    const el = visualRef.current;
    if (!el) return;
    el.innerHTML = bbcodeToEditableHtml(sourceRef.current);
    imagemapElementRef.current = null;
    linkElementRef.current = null;
    imageElementRef.current = null;
    setImagemapSelection(null);
    setLinkSelection(null);
    setImageSelection(null);
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
    imageElementRef.current = null;
    setImageSelection(null);
  }, []);

  const selectImage = useCallback((img: HTMLImageElement) => {
    clearLinkSelection();
    clearImagemapSelection();
    visualRef.current
      ?.querySelectorAll<HTMLImageElement>("img.is-selected")
      .forEach((other) => other.classList.remove("is-selected"));
    img.classList.add("is-selected");
    imageElementRef.current = img;
    const anchor = img.closest<HTMLAnchorElement>('a[data-bb="url"]');
    setImageSelection({
      src: img.getAttribute("src") ?? "",
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
  const resyncImageAfterWrap = useCallback(() => {
    const stale = imageElementRef.current;
    if (!stale || stale.isConnected) return;
    const fresh = visualRef.current?.querySelector<HTMLImageElement>("img.is-selected");
    if (!fresh) {
      clearImageSelection();
      return;
    }
    imageElementRef.current = fresh;
    setImageSelection({
      src: fresh.getAttribute("src") ?? "",
      href: fresh.closest<HTMLAnchorElement>('a[data-bb="url"]')?.getAttribute("href") ?? "",
    });
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
        selectImage(img);
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

  useEffect(() => {
    const handle = window.setTimeout(() => writeDraft(draftKey, stripPendingImages(stripUploadTokens(source))), DRAFT_SAVE_DEBOUNCE_MS);
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

  const wrapVisual = useCallback((kind: EditableWrapKind, param: string | undefined, placeholder: string) => {
    // A selected image has no text range, so target its DOM node directly;
    // otherwise the wrap would drop `placeholder` at a stray caret.
    const onImage = selectImageRange();
    ensureVisualSelection();
    expandSelectionOverInlineWrappers();
    const inner = visualSelectionHtml() || escapeBBHtml(placeholder);
    const { open, close } = editableWrapMarkup(kind, param);
    // Block wraps ([centre]/[quote]/[box]/...) legitimately contain block lines;
    // inline wraps ([size]/[spoiler]/[c]) must push into each line instead, or a
    // multi-line selection gets wiped by execCommand("insertHTML").
    const html = BLOCK_WRAP_KINDS.has(kind) ? open + inner + close : distributeInlineWrap(inner, open, close);
    insertVisualHtml(html);
    if (onImage) resyncImageAfterWrap();
  }, [ensureVisualSelection, expandSelectionOverInlineWrappers, insertVisualHtml, resyncImageAfterWrap, selectImageRange, visualSelectionHtml]);

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
      setUploadStatus({ kind: "error", message: "That selection has no colors to copy." });
      return;
    }
    capturedColorsRef.current = seq;
    setHasCapturedFormat(true);
  }, []);

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
    let value = stripUploadTokens(editMode === "visual" ? flushVisual() : sourceRef.current);

    // Upload every image that was pasted/dropped but deferred until now, and
    // swap its blob: URL for the real catbox URL. Bail without copying if any
    // upload fails, so a dead blob URL can never reach the clipboard.
    const blobUrls = Array.from(
      new Set(Array.from(value.matchAll(PENDING_IMG_PATTERN), (match) => match[1])),
    );
    if (blobUrls.length > 0) {
      setUploadStatus({ kind: "uploading" });
      try {
        for (const blobUrl of blobUrls) {
          const blob = pendingUploadsRef.current.get(blobUrl);
          if (!blob) continue; // Staged in a prior session (blob gone); leave as-is.
          const uploadedUrl = await uploadImageToCatbox(blob);
          value = value.split(`[img]${blobUrl}[/img]`).join(`[img]${uploadedUrl}[/img]`);
          visualRef.current
            ?.querySelectorAll<HTMLImageElement>("img")
            .forEach((img) => { if (img.getAttribute("src") === blobUrl) img.setAttribute("src", uploadedUrl); });
          pendingUploadsRef.current.delete(blobUrl);
          URL.revokeObjectURL(blobUrl);
        }
        setUploadStatus(null);
      } catch (error) {
        setUploadStatus({ kind: "error", message: error instanceof Error ? error.message : "Image upload failed." });
        return;
      }
      // Persist the resolved source so blob URLs stop lingering in state/draft.
      value = stripPendingImages(value);
      updateSource(value);
    }

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => {});
    }
  }, [editMode, flushVisual, updateSource]);

  const resetToProfile = useCallback(() => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setRestoredDraft(false);
    updateSource(baseSource);
    clearDraft(draftKey);
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
      clearDraft(draftKey);
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
    const text = textField || "preview";
    const colors = gradientCharColors(text, gradientStops, gradientMirror);
    if (!colors) return null;
    return { text, colors };
  }, [gradientMirror, gradientStops, textField]);

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
    if (url && pendingUploadsRef.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  /**
   * Stages a pasted/dropped image locally as a blob: URL and drops it in as
   * [img]blob:...[/img]. Nothing is uploaded here - copyBBCode() uploads every
   * staged image at once and swaps the blob URLs for real catbox URLs.
   */
  const stagePendingImage = useCallback((file: Blob) => {
    if (!isUploadableImage(file)) {
      setUploadStatus({ kind: "error", message: "That file isn't a supported image." });
      return;
    }
    const blobUrl = registerPendingImage(file);
    if (editMode === "visual") {
      insertVisualHtml(bbcodeToEditableHtml(`[img]${blobUrl}[/img]`));
    } else {
      const el = textareaRef.current;
      if (el) insertAtSelection(el, `[img]${blobUrl}[/img]`);
    }
  }, [editMode, insertVisualHtml, registerPendingImage]);

  // Release any staged blob URLs when the editor unmounts.
  useEffect(() => {
    const pending = pendingUploadsRef.current;
    return () => {
      pending.forEach((_, url) => URL.revokeObjectURL(url));
      pending.clear();
    };
  }, []);

  // ---- images: drag-to-resize ----------------------------------------------
  // The handle lives in the surface's scrolling content coordinates, so it
  // rides along with the image as you scroll.
  const positionResizeHandle = useCallback(() => {
    const surface = visualRef.current;
    const img = imageElementRef.current;
    const handle = resizeHandleRef.current;
    if (!surface || !img || !handle || !img.isConnected) return;
    const surfaceRect = surface.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    handle.style.left = `${imgRect.right - surfaceRect.left + surface.scrollLeft}px`;
    handle.style.top = `${imgRect.bottom - surfaceRect.top + surface.scrollTop}px`;
  }, []);

  const handleImageResizeMove = useCallback((event: PointerEvent) => {
    const drag = imageResizeRef.current;
    if (!drag) return;
    const next = Math.max(40, Math.min(drag.maxWidth, drag.startWidth + (event.clientX - drag.startX)));
    // Inline width needs !important to beat the surface's `width: auto !important`.
    drag.img.style.setProperty("width", `${Math.round(next)}px`, "important");
    drag.img.style.maxWidth = "none";
    drag.img.style.height = "auto";
    positionResizeHandle();
  }, [positionResizeHandle]);

  const stopImageResize = useCallback((event: PointerEvent) => {
    void event;
    const drag = imageResizeRef.current;
    imageResizeRef.current = null;
    document.removeEventListener("pointermove", handleImageResizeMove);
    document.removeEventListener("pointerup", stopImageResize);
    document.removeEventListener("pointercancel", stopImageResize);
    if (!drag) return;
    const img = drag.img;
    const targetWidth = Math.round(img.getBoundingClientRect().width);
    // Drop the live-preview overrides; the re-encoded file itself carries the size.
    img.classList.remove("is-resizing");
    img.style.removeProperty("width");
    img.style.removeProperty("max-width");
    img.style.removeProperty("height");
    const currentSrc = img.getAttribute("src") ?? "";
    // A click that didn't really drag shouldn't re-encode (and downscale) the image.
    if (!currentSrc || targetWidth < 1 || Math.abs(targetWidth - drag.startWidth) < 2) {
      window.requestAnimationFrame(positionResizeHandle);
      return;
    }
    setUploadStatus({ kind: "uploading" });
    void (async () => {
      try {
        const source = pendingUploadsRef.current.get(currentSrc) ?? await fetchImageBlobViaProxy(currentSrc);
        const resized = await resizeImageBlobToWidth(source, targetWidth);
        if (!img.isConnected) return;
        releasePendingImage(currentSrc); // free the pre-resize blob if it was staged
        const blobUrl = registerPendingImage(resized);
        img.setAttribute("src", blobUrl);
        setImageSelection((sel) => (sel ? { ...sel, src: blobUrl } : sel));
        flushVisual();
        setUploadStatus(null);
        window.requestAnimationFrame(positionResizeHandle);
      } catch (error) {
        setUploadStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not resize the image." });
      }
    })();
  }, [flushVisual, handleImageResizeMove, positionResizeHandle, registerPendingImage, releasePendingImage]);

  const startImageResize = useCallback((event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation(); // keep the surface's pointerdown from re-selecting/clearing
    const img = imageElementRef.current;
    if (!img) return;
    const surface = visualRef.current;
    const rect = img.getBoundingClientRect();
    const maxBySurface = surface ? surface.clientWidth - 32 : rect.width; // leave the px-4 gutters
    imageResizeRef.current = {
      img,
      startX: event.clientX,
      startWidth: rect.width,
      // Don't upscale past the source's own pixels (that only adds blur).
      maxWidth: Math.max(40, Math.min(maxBySurface, img.naturalWidth || maxBySurface)),
    };
    img.classList.add("is-resizing");
    document.addEventListener("pointermove", handleImageResizeMove);
    document.addEventListener("pointerup", stopImageResize);
    document.addEventListener("pointercancel", stopImageResize);
  }, [handleImageResizeMove, stopImageResize]);

  const showResizeHandle = useCallback(() => {
    const surface = visualRef.current;
    const img = imageElementRef.current;
    if (!surface || !img) return;
    removeImageResizeHandle(surface);
    const handle = document.createElement("span");
    handle.className = "bbcode-image-resize-handle";
    handle.setAttribute("data-bb-skip", "1");
    handle.setAttribute("contenteditable", "false");
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to resize";
    handle.addEventListener("pointerdown", startImageResize);
    resizeHandleRef.current = handle;
    surface.appendChild(handle);
    positionResizeHandle();
  }, [positionResizeHandle, startImageResize]);

  const hideResizeHandle = useCallback(() => {
    removeImageResizeHandle(visualRef.current);
    resizeHandleRef.current = null;
  }, []);

  // Show the resize handle whenever an image is selected; reposition it when the
  // selection changes (e.g. after a resize swaps the image).
  useEffect(() => {
    if (imageSelection) showResizeHandle();
    else hideResizeHandle();
  }, [imageSelection, showResizeHandle, hideResizeHandle]);

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
      setUploadStatus({ kind: "error", message: "That file isn't a supported image." });
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
  }, [flushVisual, insertImageMarkup, registerPendingImage, releasePendingImage]);

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

  // Context-menu paste: route images through catbox, drop text inline.
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
      setUploadStatus({ kind: "error", message: "Couldn't read the clipboard. Use Ctrl+V instead." });
    }
  }, [insertPlainText, stagePendingImage]);

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
      { label: "Resize / crop…", icon: <Crop size={14} />, onSelect: () => openImageEditor(img) },
      { label: "Replace image…", icon: <Replace size={14} />, onSelect: () => triggerReplaceImage(img) },
      {
        label: anchor ? "Edit link…" : "Add link…",
        icon: anchor ? <Pencil size={14} /> : <Link size={14} />,
        onSelect: () => { selectImage(img); setFocusImageLinkTick((tick) => tick + 1); },
      },
    ];
    if (anchor) {
      items.push({ label: "Remove link", icon: <Unlink size={14} />, onSelect: () => { selectImage(img); updateImageLink(""); } });
    }
    items.push(
      { separator: true },
      { label: "Copy image URL", icon: <Copy size={14} />, disabled: !src, onSelect: () => { void navigator.clipboard?.writeText?.(src); } },
      { label: "Open image in new tab", icon: <ExternalLink size={14} />, disabled: !src, onSelect: () => { window.open(src, "_blank", "noopener,noreferrer"); } },
      { separator: true },
      { label: "Delete image", icon: <Trash2 size={14} />, danger: true, onSelect: () => { selectImage(img); deleteSelectedImage(); } },
    );
    return items;
  }, [deleteSelectedImage, openImageEditor, selectImage, triggerReplaceImage, updateImageLink]);

  const buildLinkMenuItems = useCallback((anchor: HTMLAnchorElement): ContextMenuItem[] => {
    const href = anchor.getAttribute("href") ?? "";
    const selection = window.getSelection();
    const hasSelection = !!selection && !selection.isCollapsed && selection.toString().length > 0;
    return [
      { label: "Edit link…", icon: <Pencil size={14} />, onSelect: () => selectLink(anchor) },
      { label: "Open link", icon: <ExternalLink size={14} />, disabled: !href, onSelect: () => { window.open(href, "_blank", "noopener,noreferrer"); } },
      { label: "Copy link URL", icon: <Copy size={14} />, disabled: !href, onSelect: () => { void navigator.clipboard?.writeText?.(href); } },
      { separator: true },
      // A gradient link's colors live on the link text, so offer the painter here too.
      { label: "Copy formatting", icon: <Copy size={14} />, disabled: !hasSelection, onSelect: copyFormatting },
      { label: "Paste formatting", icon: <ClipboardPaste size={14} />, disabled: !hasSelection || !capturedColorsRef.current, onSelect: pasteFormatting },
      { separator: true },
      { label: "Remove link", icon: <Unlink size={14} />, onSelect: () => { selectLink(anchor); removeSelectedLink(); } },
    ];
  }, [copyFormatting, pasteFormatting, removeSelectedLink, selectLink]);

  const buildTextMenuItems = useCallback((): ContextMenuItem[] => {
    const selection = window.getSelection();
    const hasSelection = !!selection && !selection.isCollapsed && selection.toString().length > 0;
    return [
      { label: "Cut", icon: <Scissors size={14} />, disabled: !hasSelection, onSelect: cutSelection },
      { label: "Copy", icon: <Copy size={14} />, disabled: !hasSelection, onSelect: copySelection },
      { label: "Paste", icon: <ClipboardPaste size={14} />, onSelect: () => { void pasteFromClipboard(); } },
      { separator: true },
      { label: "Bold", icon: <Bold size={14} />, onSelect: () => applyInline("bold", "b", "text") },
      { label: "Italic", icon: <Italic size={14} />, onSelect: () => applyInline("italic", "i", "text") },
      { label: "Underline", icon: <Underline size={14} />, onSelect: () => applyInline("underline", "u", "text") },
      { label: "Text color…", icon: <Palette size={14} />, onSelect: () => openDialog("color") },
      { label: "Add link…", icon: <Link size={14} />, onSelect: () => openDialog("link") },
      { separator: true },
      { label: "Copy formatting", icon: <Copy size={14} />, disabled: !hasSelection, onSelect: copyFormatting },
      { label: "Paste formatting", icon: <ClipboardPaste size={14} />, disabled: !hasSelection || !capturedColorsRef.current, onSelect: pasteFormatting },
      { separator: true },
      { label: "Clear formatting", icon: <Eraser size={14} />, onSelect: () => execVisual("removeFormat") },
    ];
  }, [applyInline, copyFormatting, copySelection, cutSelection, execVisual, openDialog, pasteFormatting, pasteFromClipboard]);

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
    if (img && root.contains(img) && !img.closest(".bbcode-editor-embed") && !mapEl) {
      selectImage(img);
      items = buildImageMenuItems(img);
    } else if (anchor && root.contains(anchor)) {
      items = buildLinkMenuItems(anchor);
    } else {
      items = buildTextMenuItems();
    }
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }, [buildImageMenuItems, buildLinkMenuItems, buildTextMenuItems, selectImage]);

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
    if (!surface) return;
    const el = imageSelection
      ? imageElementRef.current
      : imagemapSelection
        ? imagemapElementRef.current
        : linkSelection
          ? linkElementRef.current
          : null;
    if (!el || !surface.contains(el)) return;
    const surfaceRect = surface.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const visibleBottom = surfaceRect.bottom - overlayHeight;
    if (rect.bottom <= visibleBottom) return;
    const delta = Math.min(rect.bottom - visibleBottom + 12, Math.max(0, rect.top - surfaceRect.top));
    if (delta > 0) surface.scrollTop += delta;
  }, [overlayHeight, imageSelection, imagemapSelection, linkSelection]);

  const charCount = source.length;
  const pendingImageCount = useMemo(
    () => Array.from(deferredSource.matchAll(PENDING_IMG_PATTERN)).length,
    [deferredSource],
  );

  const renderImageInspector = (): ReactNode => {
    if (!imageSelection) return null;
    return (
      <div className="flex flex-wrap items-end gap-2.5 px-4 py-3 pr-10 border-b border-osu-b3/30 bg-osu-b5/50">
        <div className="self-center pr-1 text-[11px] font-semibold uppercase tracking-wide text-osu-f1">Image</div>
        <DialogField label="Link URL (optional)">
          <input
            ref={imageLinkInputRef}
            type="text"
            value={imageSelection.href}
            onChange={(event) => updateImageLink(event.target.value)}
            placeholder="https://... wraps the image in a link"
            className={`${dialogInputClass} w-72`}
          />
        </DialogField>
        <button
          type="button"
          onClick={() => imageElementRef.current && openImageEditor(imageElementRef.current)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-osu-b4/70 border border-osu-b3/40 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors cursor-pointer"
        >
          <Crop size={14} /> Resize / crop
        </button>
        <button
          type="button"
          onClick={() => imageElementRef.current && triggerReplaceImage(imageElementRef.current)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-osu-b4/70 border border-osu-b3/40 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors cursor-pointer"
        >
          <Replace size={14} /> Replace
        </button>
        <button
          type="button"
          title="Remove image"
          aria-label="Remove image"
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
          <span>Imagemap area {imagemapSelection.areaIndex + 1}/{imagemapSelection.areaCount}</span>
          <button
            type="button"
            title="Previous area"
            aria-label="Previous area"
            onClick={() => selectImagemapAreaByIndex(imagemapSelection.areaIndex - 1)}
            className="grid h-7 w-7 place-items-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white cursor-pointer"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            title="Next area"
            aria-label="Next area"
            onClick={() => selectImagemapAreaByIndex(imagemapSelection.areaIndex + 1)}
            className="grid h-7 w-7 place-items-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white cursor-pointer"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <DialogField label="URL">
          <input
            type="text"
            value={imagemapSelection.href}
            onChange={(event) => updateImagemapSelectionField("href", event.target.value)}
            placeholder="#"
            className={`${dialogInputClass} w-64`}
          />
        </DialogField>
        <DialogField label="Title">
          <input
            type="text"
            value={imagemapSelection.title}
            onChange={(event) => updateImagemapSelectionField("title", event.target.value)}
            className={`${dialogInputClass} w-44`}
          />
        </DialogField>

        <button
          type="button"
          title="Add area"
          aria-label="Add area"
          onClick={addImagemapArea}
          className="grid h-8 w-8 place-items-center rounded-md border border-osu-b3/40 bg-osu-b4/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white cursor-pointer"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          title="Delete area"
          aria-label="Delete area"
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
          Link
        </div>
        <DialogField label="URL">
          <input
            type="text"
            value={linkSelection.href}
            onChange={(event) => updateSelectedLinkHref(event.target.value)}
            placeholder="https://..."
            className={`${dialogInputClass} w-80`}
          />
        </DialogField>
        <DialogField label="Text">
          <input
            type="text"
            value={linkSelection.text}
            onChange={(event) => updateSelectedLinkText(event.target.value)}
            className={`${dialogInputClass} w-48`}
          />
        </DialogField>
        <button
          type="button"
          title="Remove link"
          aria-label="Remove link"
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
            <DialogField label="Custom">
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
              Apply
            </button>
            {editMode === "visual" && selectedDialogText() ? (
              <DialogField label={`Shift hue (${hueShift > 0 ? "+" : ""}${hueShift}°)`}>
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
                  title="Rotate every color in the selection"
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
              <DialogField label="Text (replaces the selection)">
                <input
                  type="text"
                  value={textField}
                  onChange={(event) => setTextField(event.target.value)}
                  placeholder="select text or type it here"
                  className={`${dialogInputClass} w-56`}
                />
              </DialogField>
              <DialogField label="Colors">
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
                          title="Remove color"
                          aria-label="Remove color"
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
                      title="Add color"
                      aria-label="Add color"
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
                <span className="text-[12px] text-osu-l2">Mirror (out and back)</span>
              </label>
              <button type="submit" className={dialogApplyClass} disabled={!gradientPreview || !(textField || selectedDialogText())}>
                Apply
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                {GRADIENT_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setGradientStops(preset.stops);
                      setGradientMirror(preset.mirror);
                    }}
                    className="px-2 py-1 rounded-md bg-osu-b5 border border-osu-b3/50 text-[11px] font-semibold cursor-pointer hover:bg-osu-b3 transition-colors"
                  >
                    {(() => {
                      const colors = gradientCharColors(preset.label, preset.stops, preset.mirror) ?? [];
                      return Array.from(preset.label).map((char, index) => (
                        <span key={index} style={colors[index] ? { color: colors[index] } : undefined}>{char}</span>
                      ));
                    })()}
                  </button>
                ))}
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
                  {preset.label} ({preset.value})
                </button>
              ))}
            </div>
            <DialogField label="Custom (30-200)">
              <input
                type="number"
                min={30}
                max={200}
                value={customSize}
                onChange={(event) => setCustomSize(event.target.value)}
                className={`${dialogInputClass} w-24`}
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass}>Apply</button>
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
            <DialogField label="URL">
              <input
                type="url"
                value={urlField}
                onChange={(event) => setUrlField(event.target.value)}
                placeholder="https://..."
                className={`${dialogInputClass} w-72`}
                autoFocus
              />
            </DialogField>
            <DialogField label="Text (optional)">
              <input
                type="text"
                value={textField}
                onChange={(event) => setTextField(event.target.value)}
                placeholder="link text"
                className={`${dialogInputClass} w-48`}
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass} disabled={!/^https?:\/\/\S+$/i.test(urlField.trim())}>
              Insert
            </button>
          </form>
        );
      case "image":
      case "audio": {
        const label = dialog === "image" ? "Image URL" : "Audio URL (mp3)";
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
              Insert
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
            <DialogField label="Video URL or id">
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
              Insert
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
            <DialogField label="Username">
              <input
                type="text"
                value={textField}
                onChange={(event) => setTextField(event.target.value)}
                placeholder="username"
                className={`${dialogInputClass} w-48`}
                autoFocus
              />
            </DialogField>
            <DialogField label="User id (optional)">
              <input
                type="text"
                value={urlField}
                onChange={(event) => setUrlField(event.target.value)}
                placeholder="7095193"
                className={`${dialogInputClass} w-32`}
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass} disabled={!textField.trim()}>
              Insert
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
            <DialogField label="Box title (empty for SPOILER)">
              <input
                type="text"
                value={textField}
                onChange={(event) => setTextField(event.target.value)}
                placeholder="title"
                className={`${dialogInputClass} w-56`}
                autoFocus
              />
            </DialogField>
            <button type="submit" className={dialogApplyClass}>Insert</button>
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
          <div className="text-[13px] font-bold text-osu-c1">BBCode editor</div>
          <div className="text-[12px] text-osu-f1 truncate">
            Edits stay in this browser. Copy the result and paste it into the me! editor on{" "}
            {userId != null && username ? (
              <a
                href={`https://osu.ppy.sh/users/${userId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-osu-pink-light hover:text-osu-pink underline"
              >
                your osu! page
              </a>
            ) : (
              "your osu! page"
            )}.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={copyBBCode}
            disabled={uploadStatus?.kind === "uploading"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait ${
              copied
                ? "bg-osu-green/20 border border-osu-green/40 text-osu-green"
                : "bg-osu-h1/20 border border-osu-h1/40 text-osu-c1 hover:bg-osu-h1/30"
            }`}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy BBCode"}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              title="Close editor"
              aria-label="Close editor"
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
              <span className="text-[12px] font-semibold text-osu-f1 shrink-0">Load a player's me! page</span>
              <SearchInput
                className="w-full sm:w-64"
                placeholder="find player..."
                onSearch={searchPlayers}
                onSelect={loadUserPage}
              />
            </>
          ) : (
            <>
              <span className="text-[12px] font-semibold text-osu-f1 shrink-0">Start from your live me! page</span>
              <button
                type="button"
                onClick={() => loadUserPage({ id: userId!, username: username ?? "" })}
                disabled={loadingUserPage}
                className={dialogApplyClass}
              >
                Load my me! page
              </button>
            </>
          )}
          {loadingUserPage ? (
            <span className="flex items-center gap-1.5 text-[12px] text-osu-f1">
              <span className="h-3.5 w-3.5 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
              Loading me! page...
            </span>
          ) : loadStatus?.kind === "error" ? (
            <span className="text-[12px] text-osu-red">Couldn't load that me! page.</span>
          ) : loadStatus?.kind === "empty" ? (
            <span className="text-[12px] text-osu-yellow">{loadStatus.name}'s me! page is empty.</span>
          ) : loadStatus?.kind === "loaded" ? (
            <span className="text-[12px] text-osu-l2">Loaded {loadStatus.name}'s me! page into the editor.</span>
          ) : null}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-osu-b3/30 overflow-x-auto">
        <ToolButton label="Bold" active={editMode === "visual" && inlineStates.bold} onClick={() => applyInline("bold", "b", "text")}><Bold size={15} /></ToolButton>
        <ToolButton label="Italic" active={editMode === "visual" && inlineStates.italic} onClick={() => applyInline("italic", "i", "text")}><Italic size={15} /></ToolButton>
        <ToolButton label="Underline" active={editMode === "visual" && inlineStates.underline} onClick={() => applyInline("underline", "u", "text")}><Underline size={15} /></ToolButton>
        <ToolButton label="Strikethrough" active={editMode === "visual" && inlineStates.strike} onClick={() => applyInline("strikeThrough", "s", "text")}><Strikethrough size={15} /></ToolButton>
        <ToolButton label="Spoiler text" onClick={() => applyWrap("spoiler", undefined, "[spoiler]", "[/spoiler]", "secret")}><EyeOff size={15} /></ToolButton>
        <ToolDivider />
        <ToolButton label="Text color" active={dialog === "color" || (editMode === "visual" && selectionColor != null)} onClick={() => openDialog("color")}><Palette size={15} /></ToolButton>
        <ToolButton label="Gradient text" active={dialog === "gradient"} onClick={() => openDialog("gradient")}><Rainbow size={15} /></ToolButton>
        <ToolButton label="Text size" active={dialog === "size" || (editMode === "visual" && selectionSize != null)} onClick={() => openDialog("size")}><ALargeSmall size={15} /></ToolButton>
        <ToolDivider />
        <ToolButton label="Link" active={dialog === "link"} onClick={() => openDialog("link")}><Link size={15} /></ToolButton>
        <ToolButton label="Image" active={dialog === "image"} onClick={() => openDialog("image")}><Image size={15} /></ToolButton>
        <ToolButton label="YouTube video" active={dialog === "youtube"} onClick={() => openDialog("youtube")}><Youtube size={15} /></ToolButton>
        <ToolButton label="Audio" active={dialog === "audio"} onClick={() => openDialog("audio")}><Music size={15} /></ToolButton>
        <ToolButton label="Profile link" active={dialog === "profile"} onClick={() => openDialog("profile")}><UserRound size={15} /></ToolButton>
        <ToolDivider />
        <ToolButton label="Heading" onClick={() => applyWrap("heading", undefined, "[heading]", "[/heading]", "Heading")}><Heading1 size={15} /></ToolButton>
        <ToolButton label="Center" onClick={() => applyWrap("centre", undefined, "[centre]", "[/centre]", "text")}><AlignCenter size={15} /></ToolButton>
        <ToolButton label="Quote" onClick={() => applyWrap("quote", undefined, "[quote]", "[/quote]", "quote")}><TextQuote size={15} /></ToolButton>
        <ToolButton label="Notice" onClick={() => applyWrap("notice", undefined, "[notice]\n", "\n[/notice]", "important")}><Megaphone size={15} /></ToolButton>
        <ToolButton label="Collapsible box" active={dialog === "box"} onClick={() => openDialog("box")}><ChevronsDownUp size={15} /></ToolButton>
        <ToolButton label="Inline code" onClick={() => applyWrap("c", undefined, "[c]", "[/c]", "code")}><Braces size={15} /></ToolButton>
        <ToolButton label="Code block" onClick={() => applyWrap("codeblock", undefined, "[code]\n", "\n[/code]", "code")}><Code size={15} /></ToolButton>
        <ToolButton label="Bullet list" onClick={() => insertList(false)}><List size={15} /></ToolButton>
        <ToolButton label="Numbered list" onClick={() => insertList(true)}><ListOrdered size={15} /></ToolButton>
        <ToolButton label="Imagemap (image with clickable areas)" onClick={() => insertBBCode(IMAGEMAP_TEMPLATE)}>
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
              {mode === "visual" ? "Visual" : "BBCode"}
            </button>
          ))}
        </div>
      </div>

      {restoredDraft ? (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-osu-b3/30 text-[12px] text-osu-yellow">
          Restored an unsaved draft from this browser.
          <button
            type="button"
            onClick={() => {
              setRestoredDraft(false);
              updateSource(baseSource);
              clearDraft(draftKey);
              setVisualEpoch((epoch) => epoch + 1);
            }}
            className="underline text-osu-l2 hover:text-osu-c1 cursor-pointer"
          >
            Discard draft
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
              title="Close"
              aria-label="Close"
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
                {uploadStatus.kind === "uploading" ? (
                  <>
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
                    Uploading image to catbox.moe...
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
          data-placeholder="Write your page here. Select text and use the toolbar to format it. Right-click for more, or paste an image to add it."
          style={{ paddingBottom: surfacePadBottom, scrollPaddingBottom: surfacePadBottom }}
          className={`${paneHeightClass} bbcode-content bbcode-editor-surface overflow-y-auto px-4 py-3 text-sm text-osu-l2 focus:outline-none`}
        />
      ) : (
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
              <textarea
                ref={textareaRef}
                value={source}
                onChange={(event) => {
                  updateSource(event.target.value);
                  setCaretOffset(event.target.selectionStart);
                }}
                onSelect={(event) => setCaretOffset(event.currentTarget.selectionStart)}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                spellCheck={false}
                placeholder="Write BBCode here, or paste your current me! page source..."
                style={{ paddingBottom: surfacePadBottom }}
                className={`${paneHeightClass} w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed font-mono text-osu-l2 placeholder:text-osu-f1 focus:outline-none`}
              />
            </div>
            <div className={`${mobilePane === "preview" ? "block" : "hidden"} lg:block bg-osu-b5/40`}>
              <div
                style={{ paddingBottom: surfacePadBottom }}
                className={`${paneHeightClass} bbcode-content bbcode-preview-surface overflow-y-auto px-4 py-3 text-sm text-osu-l2`}
              >
                <BBCodePreview
                  source={deferredSource}
                  highlightOffset={deferredCaretOffset}
                  onSelectSourceSpan={selectSourceSpan}
                />
              </div>
            </div>
          </div>
        </>
      )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-osu-b3/30 text-[12px] text-osu-f1">
        <span>{charCount.toLocaleString()} characters</span>
        <span className="hidden sm:inline">Draft autosaves locally</span>
        {pendingImageCount > 0 ? (
          <span className="text-osu-c1">
            {pendingImageCount} image{pendingImageCount > 1 ? "s" : ""} upload on copy
          </span>
        ) : null}
        {hasCapturedFormat ? (
          <span className="hidden sm:inline text-osu-c1">formatting copied - right-click text to paste</span>
        ) : null}
        <button
          type="button"
          onClick={resetToProfile}
          className={`ml-auto cursor-pointer transition-colors ${
            confirmReset ? "text-osu-red font-semibold" : "text-osu-f1 hover:text-osu-l2 underline"
          }`}
        >
          {confirmReset
            ? (baseSource ? "Click again to discard edits" : "Click again to clear")
            : (baseSource ? "Reset to current page" : "Clear editor")}
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
