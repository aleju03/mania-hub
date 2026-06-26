import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
  Code,
  Copy,
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
  Plus,
  Rainbow,
  Strikethrough,
  TextQuote,
  Trash2,
  Underline,
  Unlink,
  UserRound,
  X,
  Youtube,
} from "lucide-react";
import { buildGradientBBCode, gradientCharColors, normalizeHexColor, parseYoutubeInput, type BBSourceSpan } from "../../../lib/bbcode";
import {
  bbcodeToEditableHtml,
  editableWrapMarkup,
  escapeBBHtml,
  serializeBBCodeDom,
  type EditableWrapKind,
} from "../../../lib/bbcode-dom";
import { getUser, searchUsers } from "../../../lib/osu";
import { SearchInput } from "../../ui/SearchInput";
import { BBCodePreview } from "./BBCodePreview";

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
  // Caret offset in the raw-source textarea; the preview highlights its node.
  const [caretOffset, setCaretOffset] = useState<number | null>(null);
  // Bumped whenever the visual surface must be rebuilt from `source`.
  const [visualEpoch, setVisualEpoch] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const visualRef = useRef<HTMLDivElement | null>(null);
  const imagemapElementRef = useRef<HTMLElement | null>(null);
  const imagemapDragRef = useRef<ImagemapDragState | null>(null);
  const linkElementRef = useRef<HTMLAnchorElement | null>(null);
  const sourceRef = useRef(source);
  const selectionRef = useRef<SelectionSnapshot>({ start: 0, end: 0, text: "" });
  const visualRangeRef = useRef<Range | null>(null);
  const visualSyncHandle = useRef<number | null>(null);
  const deferredSource = useDeferredValue(source);
  const deferredCaretOffset = useDeferredValue(caretOffset);

  // Dialog form state. One dialog is open at a time, so shared fields are fine.
  const [urlField, setUrlField] = useState("");
  const [textField, setTextField] = useState("");
  const [hexField, setHexField] = useState("#FF66AA");
  const [gradientStops, setGradientStops] = useState<string[]>(["#B14DE8", "#FF9ECF"]);
  const [gradientMirror, setGradientMirror] = useState(false);
  const [customSize, setCustomSize] = useState("100");

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
    setImagemapSelection(null);
    setLinkSelection(null);
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
    if (!mapEl || !root.contains(mapEl)) {
      if (imagemapSelection && root.contains(target)) clearImagemapSelection();
      const anchor = target.closest<HTMLAnchorElement>("a");
      const linkKind = anchor?.getAttribute("data-bb");
      if (anchor && root.contains(anchor) && (!linkKind || linkKind === "url")) {
        event.preventDefault();
        selectLink(anchor);
      } else if (linkSelection && root.contains(target)) {
        clearLinkSelection();
      }
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
    clearImagemapSelection,
    clearLinkSelection,
    handleImagemapPointerMove,
    imagemapSelection,
    linkSelection,
    pickImagemapAreaAtPoint,
    selectImagemapArea,
    selectLink,
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
    const handle = window.setTimeout(() => writeDraft(draftKey, source), DRAFT_SAVE_DEBOUNCE_MS);
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

  // Reflect the caret's inline formatting in the toolbar while visually editing.
  useEffect(() => {
    if (editMode !== "visual") return;
    const handler = () => {
      const el = visualRef.current;
      const selection = window.getSelection();
      if (!el || !selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) return;
      try {
        setInlineStates({
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          underline: document.queryCommandState("underline"),
          strike: document.queryCommandState("strikeThrough"),
        });
      } catch {
        // queryCommandState can throw on detached selections; keep last state.
      }
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [editMode]);

  const switchMode = useCallback((next: EditMode) => {
    if (next === editMode) return;
    if (editMode === "visual") flushVisual();
    setDialog(null);
    setEditMode(next);
  }, [editMode, flushVisual]);

  // ---- visual-mode selection helpers -------------------------------------

  const ensureVisualSelection = useCallback(() => {
    const el = visualRef.current;
    if (!el) return;
    el.focus();
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
    el.focus();
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

  const wrapVisual = useCallback((kind: EditableWrapKind, param: string | undefined, placeholder: string) => {
    ensureVisualSelection();
    const inner = visualSelectionHtml() || escapeBBHtml(placeholder);
    const { open, close } = editableWrapMarkup(kind, param);
    insertVisualHtml(open + inner + close);
  }, [ensureVisualSelection, insertVisualHtml, visualSelectionHtml]);

  const execVisual = useCallback((command: string) => {
    ensureVisualSelection();
    try {
      document.execCommand(command);
    } catch {
      // Unsupported command; nothing sensible to fall back to.
    }
    scheduleVisualSync();
  }, [ensureVisualSelection, scheduleVisualSync]);

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

  const copyBBCode = useCallback(() => {
    const value = editMode === "visual" ? flushVisual() : sourceRef.current;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => {});
    }
  }, [editMode, flushVisual]);

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

  const charCount = source.length;

  const renderImagemapInspector = (): ReactNode => {
    if (!imagemapSelection) return null;
    return (
      <div className="flex flex-wrap items-end gap-2.5 px-4 py-3 border-b border-osu-b3/30 bg-osu-b5/50">
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
      <div className="flex flex-wrap items-end gap-2.5 px-4 py-3 border-b border-osu-b3/30 bg-osu-b5/50">
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
          applyAndClose(() => applyWrap("color", color, `[color=${color}]`, "[/color]", "text"));
        return (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const color = normalizeHexColor(hexField);
              if (color) applyColor(color);
            }}
          >
            <div className="flex items-center gap-1.5">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  title={swatch}
                  onClick={() => applyColor(swatch)}
                  className="w-6 h-6 rounded-md border border-osu-b3/60 cursor-pointer hover:scale-110 transition-transform"
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
                {username}'s osu! page
              </a>
            ) : (
              "your osu! profile page"
            )}.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={copyBBCode}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors cursor-pointer ${
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
        <ToolButton label="Text color" active={dialog === "color"} onClick={() => openDialog("color")}><Palette size={15} /></ToolButton>
        <ToolButton label="Gradient text" active={dialog === "gradient"} onClick={() => openDialog("gradient")}><Rainbow size={15} /></ToolButton>
        <ToolButton label="Text size" active={dialog === "size"} onClick={() => openDialog("size")}><ALargeSmall size={15} /></ToolButton>
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

      {renderImagemapInspector()}
      {renderLinkInspector()}

      {/* Tool dialog */}
      {dialog ? (
        <div className="px-4 py-3 border-b border-osu-b3/30 bg-osu-b5/50">{renderDialog()}</div>
      ) : null}

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

      {editMode === "visual" ? (
        <div
          ref={visualRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onPointerDown={handleVisualPointerDown}
          onInput={scheduleVisualSync}
          onBlur={() => flushVisual()}
          data-placeholder="Write your page here. Select text and use the toolbar to format it."
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
                spellCheck={false}
                placeholder="Write BBCode here, or paste your current me! page source..."
                className={`${paneHeightClass} w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed font-mono text-osu-l2 placeholder:text-osu-f1 focus:outline-none`}
              />
            </div>
            <div className={`${mobilePane === "preview" ? "block" : "hidden"} lg:block bg-osu-b5/40`}>
              <div className={`${paneHeightClass} bbcode-content bbcode-preview-surface overflow-y-auto px-4 py-3 text-sm text-osu-l2`}>
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

      {/* Footer */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-osu-b3/30 text-[12px] text-osu-f1">
        <span>{charCount.toLocaleString()} characters</span>
        <span className="hidden sm:inline">Draft autosaves locally</span>
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
    </div>
  );
}

export default BBCodeEditor;
