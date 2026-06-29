import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Crop,
  FlipHorizontal,
  FlipVertical,
  Link2,
  Loader2,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { fetchImageBlobViaProxy } from "../../../lib/catbox-upload";

export interface ImageEditorSource {
  /** A local blob (pasted/dropped/replaced) edits with no network round-trip. */
  blob?: Blob;
  /** A remote URL is re-fetched through our proxy so the canvas stays untainted. */
  url?: string;
}

interface Orientation {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_CROP = 12;

function exportType(sourceType: string | undefined): { mime: string; quality?: number } {
  const mime = (sourceType ?? "").split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg") return { mime: "image/jpeg", quality: 0.92 };
  if (mime === "image/webp") return { mime: "image/webp", quality: 0.95 };
  return { mime: "image/png" };
}

function buildOrientedCanvas(img: HTMLImageElement, o: Orientation): HTMLCanvasElement {
  const swap = o.rotation === 90 || o.rotation === 270;
  const w = swap ? img.naturalHeight : img.naturalWidth;
  const h = swap ? img.naturalWidth : img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((o.rotation * Math.PI) / 180);
    ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
  }
  return canvas;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Full-screen canvas crop + resize editor. Resolves an edited Blob via onApply. */
export function ImageEditorModal({
  source,
  onApply,
  onCancel,
  busy,
}: {
  source: ImageEditorSource;
  onApply: (blob: Blob) => void | Promise<void>;
  onCancel: () => void;
  /** External "uploading the result" state shown after Apply. */
  busy?: boolean;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<Orientation>({ rotation: 0, flipH: false, flipV: false });
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [output, setOutput] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [lockAspect, setLockAspect] = useState(true);
  const [exporting, setExporting] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stageBox, setStageBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const dragRef = useRef<
    | { mode: "move" | "draw" | Handle; startX: number; startY: number; start: CropRect; pointerId: number }
    | null
  >(null);
  const sourceTypeRef = useRef<string | undefined>(source.blob?.type);
  const prevDimsRef = useRef<{ w: number; h: number } | null>(null);
  const onStageMoveRef = useRef<(event: PointerEvent) => void>(() => {});
  const dragHandlersRef = useRef<{ move: (event: PointerEvent) => void; end: () => void } | null>(null);

  // --- load the source image ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setError(null);
    setImg(null);
    (async () => {
      try {
        let blob = source.blob ?? null;
        if (!blob && source.url) {
          // data:/blob: URLs are already same-origin; only remote URLs need the proxy.
          blob = /^(data:|blob:)/i.test(source.url)
            ? await (await fetch(source.url)).blob()
            : await fetchImageBlobViaProxy(source.url);
        }
        if (!blob) throw new Error("No image to edit.");
        sourceTypeRef.current = blob.type;
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
          if (cancelled) return;
          setImg(image);
        };
        image.onerror = () => {
          if (!cancelled) setError("Couldn't decode that image.");
        };
        image.src = objectUrl;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load that image.");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  const oriented = useMemo(() => (img ? buildOrientedCanvas(img, orientation) : null), [img, orientation]);
  const workW = oriented?.width ?? 0;
  const workH = oriented?.height ?? 0;

  // Reset the crop to the full frame only when the working dimensions change
  // (initial load, rotate). A flip keeps the dimensions, so the crop is kept.
  useEffect(() => {
    if (!oriented) return;
    const dims = { w: oriented.width, h: oriented.height };
    const prev = prevDimsRef.current;
    if (!prev || prev.w !== dims.w || prev.h !== dims.h) {
      setCrop({ x: 0, y: 0, w: dims.w, h: dims.h });
      setOutput({ w: dims.w, h: dims.h });
    }
    prevDimsRef.current = dims;
  }, [oriented]);

  // --- measure the stage ----------------------------------------------------
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setStageBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const displayScale = useMemo(() => {
    if (!workW || !workH || !stageBox.w || !stageBox.h) return 1;
    // Allow a modest upscale so tiny images are still big enough to crop.
    return Math.min(stageBox.w / workW, stageBox.h / workH, 3);
  }, [stageBox, workW, workH]);
  const dispW = Math.max(1, Math.round(workW * displayScale));
  const dispH = Math.max(1, Math.round(workH * displayScale));

  // --- paint the working frame ----------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !oriented) return;
    canvas.width = dispW;
    canvas.height = dispH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(oriented, 0, 0, dispW, dispH);
  }, [oriented, dispW, dispH]);

  // --- crop interaction -----------------------------------------------------
  const applyCrop = useCallback(
    (next: CropRect) => {
      const w = clamp(next.w, MIN_CROP, workW);
      const h = clamp(next.h, MIN_CROP, workH);
      const x = clamp(next.x, 0, workW - w);
      const y = clamp(next.y, 0, workH - h);
      const rounded = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      setCrop(rounded);
      setOutput({ w: rounded.w, h: rounded.h });
    },
    [workW, workH],
  );

  const onStageMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId || !displayScale) return;
      event.preventDefault();
      const dx = (event.clientX - drag.startX) / displayScale;
      const dy = (event.clientY - drag.startY) / displayScale;
      const s = drag.start;

      if (drag.mode === "move") {
        applyCrop({ ...s, x: s.x + dx, y: s.y + dy });
        return;
      }
      if (drag.mode === "draw") {
        const x = clamp(s.x, 0, workW);
        const y = clamp(s.y, 0, workH);
        const x2 = clamp(s.x + dx, 0, workW);
        const y2 = clamp(s.y + dy, 0, workH);
        applyCrop({ x: Math.min(x, x2), y: Math.min(y, y2), w: Math.abs(x2 - x), h: Math.abs(y2 - y) });
        return;
      }

      // Edge / corner resize.
      const dir = drag.mode;
      let left = s.x;
      let top = s.y;
      let right = s.x + s.w;
      let bottom = s.y + s.h;
      const symmetric = event.altKey;
      if (dir.includes("w")) left = s.x + dx;
      if (dir.includes("e")) right = s.x + s.w + dx;
      if (dir.includes("n")) top = s.y + dy;
      if (dir.includes("s")) bottom = s.y + s.h + dy;
      if (symmetric) {
        if (dir.includes("w")) right = s.x + s.w - dx;
        if (dir.includes("e")) left = s.x - dx;
        if (dir.includes("n")) bottom = s.y + s.h - dy;
        if (dir.includes("s")) top = s.y - dy;
      }
      let w = right - left;
      let h = bottom - top;
      // Shift on a corner keeps the original crop aspect ratio.
      if (event.shiftKey && dir.length === 2 && s.h > 0) {
        const ratio = s.w / s.h;
        if (Math.abs(w) / ratio > Math.abs(h)) h = Math.sign(h || 1) * (Math.abs(w) / ratio);
        else w = Math.sign(w || 1) * (Math.abs(h) * ratio);
        if (symmetric) {
          // Keep the (already-centered) midpoint when Alt+Shift are combined.
          const cx = (left + right) / 2;
          const cy = (top + bottom) / 2;
          left = cx - w / 2;
          right = cx + w / 2;
          top = cy - h / 2;
          bottom = cy + h / 2;
        } else {
          if (dir.includes("w")) left = right - w;
          if (dir.includes("e")) right = left + w;
          if (dir.includes("n")) top = bottom - h;
          if (dir.includes("s")) bottom = top + h;
        }
      }
      applyCrop({ x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(w), h: Math.abs(h) });
    },
    [applyCrop, displayScale, workW, workH],
  );

  // Stable drag listeners that read the latest onStageMove through a ref, so a
  // mid-drag re-render (ResizeObserver changing displayScale) can't tear down
  // the active drag.
  onStageMoveRef.current = onStageMove;
  if (!dragHandlersRef.current) {
    const move = (event: PointerEvent) => onStageMoveRef.current(event);
    const end = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    dragHandlersRef.current = { move, end };
  }

  useEffect(() => () => dragHandlersRef.current?.end(), []);

  const startDrag = useCallback(
    (event: ReactPointerEvent, mode: "move" | "draw" | Handle) => {
      if (event.button !== 0 || !crop) return;
      event.preventDefault();
      event.stopPropagation();
      const startRect = mode === "draw"
        ? (() => {
            const wrapper = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - wrapper.left) / displayScale;
            const y = (event.clientY - wrapper.top) / displayScale;
            return { x, y, w: 0, h: 0 };
          })()
        : crop;
      dragRef.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        start: startRect,
        pointerId: event.pointerId,
      };
      const handlers = dragHandlersRef.current;
      if (!handlers) return;
      window.addEventListener("pointermove", handlers.move);
      window.addEventListener("pointerup", handlers.end);
      window.addEventListener("pointercancel", handlers.end);
    },
    [crop, displayScale],
  );

  // --- output size inputs ---------------------------------------------------
  const cropAspect = crop && crop.h > 0 ? crop.w / crop.h : 1;
  const setOutputWidth = (value: number) => {
    const w = clamp(Math.round(value || 0), 1, 8192);
    setOutput(lockAspect ? { w, h: Math.max(1, Math.round(w / cropAspect)) } : { w, h: output.h });
  };
  const setOutputHeight = (value: number) => {
    const h = clamp(Math.round(value || 0), 1, 8192);
    setOutput(lockAspect ? { w: Math.max(1, Math.round(h * cropAspect)), h } : { w: output.w, h });
  };

  const rotate = (delta: 90 | -90) =>
    setOrientation((o) => ({ ...o, rotation: (((o.rotation + delta + 360) % 360) as Orientation["rotation"]) }));
  const reset = () => setOrientation({ rotation: 0, flipH: false, flipV: false });

  // --- apply ----------------------------------------------------------------
  const handleApply = useCallback(async () => {
    if (!oriented || !crop) return;
    setExporting(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, output.w);
      canvas.height = Math.max(1, output.h);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable.");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(oriented, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      const { mime, quality } = exportType(sourceTypeRef.current);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
      if (!blob) throw new Error("Couldn't export the image.");
      await onApply(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't export the image.");
    } finally {
      setExporting(false);
    }
  }, [crop, onApply, oriented, output.w, output.h]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !exporting && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exporting, busy, onCancel]);

  if (typeof document === "undefined") return null;

  const working = exporting || busy;
  const cropStyle = crop
    ? {
        left: crop.x * displayScale,
        top: crop.y * displayScale,
        width: crop.w * displayScale,
        height: crop.h * displayScale,
      }
    : undefined;

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4"
      onPointerDown={() => {
        if (!working) onCancel();
      }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b4 shadow-2xl"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-osu-b3/30 px-4 py-3">
          <Crop size={16} className="text-osu-pink" />
          <div className="text-[13px] font-bold text-osu-c1">Edit image</div>
          {img ? (
            <div className="text-[12px] text-osu-f1">
              {crop ? `crop ${crop.w}×${crop.h}` : ""}
              {crop && (output.w !== crop.w || output.h !== crop.h) ? ` → ${output.w}×${output.h}` : ""}
            </div>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            disabled={working}
            title="Close"
            aria-label="Close"
            className="ml-auto grid h-7 w-7 place-items-center rounded-full text-osu-f1 hover:bg-osu-b3/50 hover:text-white cursor-pointer disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>

        {/* Tools */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-osu-b3/30 px-4 py-2">
          <ToolbarButton label="Rotate left" onClick={() => rotate(-90)} disabled={!img || working}><RotateCcw size={15} /></ToolbarButton>
          <ToolbarButton label="Rotate right" onClick={() => rotate(90)} disabled={!img || working}><RotateCw size={15} /></ToolbarButton>
          <ToolbarButton
            label="Flip horizontal"
            onClick={() => setOrientation((o) => ({ ...o, flipH: !o.flipH }))}
            disabled={!img || working}
            active={orientation.flipH}
          ><FlipHorizontal size={15} /></ToolbarButton>
          <ToolbarButton
            label="Flip vertical"
            onClick={() => setOrientation((o) => ({ ...o, flipV: !o.flipV }))}
            disabled={!img || working}
            active={orientation.flipV}
          ><FlipVertical size={15} /></ToolbarButton>
          <div className="mx-1 h-5 w-px bg-osu-b3/60" />
          <button
            type="button"
            onClick={() => oriented && applyCrop({ x: 0, y: 0, w: workW, h: workH })}
            disabled={!img || working}
            className="rounded-md px-2 py-1 text-[12px] text-osu-l2 hover:bg-osu-b3/60 hover:text-osu-c1 cursor-pointer disabled:opacity-50"
          >
            Reset crop
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={!img || working}
            className="rounded-md px-2 py-1 text-[12px] text-osu-l2 hover:bg-osu-b3/60 hover:text-osu-c1 cursor-pointer disabled:opacity-50"
          >
            Reset orientation
          </button>
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-osu-f1 sm:flex">
            <span>drag to crop</span>·<span>Shift = lock ratio</span>·<span>Alt = from center</span>
          </span>
        </div>

        {/* Stage */}
        <div
          ref={stageRef}
          className="relative min-h-[240px] flex-1 overflow-hidden bg-[repeating-conic-gradient(var(--color-osu-b5)_0_25%,var(--color-osu-b6)_0_50%)] bg-[length:24px_24px]"
          style={{ touchAction: "none" }}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            {error ? (
              <div className="px-6 text-center text-[13px] text-osu-red">{error}</div>
            ) : !img ? (
              <div className="flex items-center gap-2 text-[13px] text-osu-f1">
                <Loader2 size={16} className="animate-spin" /> Loading image…
              </div>
            ) : (
              <div className="relative" style={{ width: dispW, height: dispH }}>
                <canvas ref={canvasRef} className="block h-full w-full" />
                {/* Empty-area pointer target draws a fresh crop. */}
                <div className="absolute inset-0" onPointerDown={(event) => startDrag(event, "draw")} />
                {crop ? (
                  <div
                    className="absolute cursor-move border border-osu-pink shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
                    style={cropStyle}
                    onPointerDown={(event) =>
                      startDrag(event, crop.w >= workW && crop.h >= workH ? "draw" : "move")
                    }
                  >
                    {HANDLES.map((handle) => (
                      <span
                        key={handle}
                        data-handle={handle}
                        onPointerDown={(event) => startDrag(event, handle)}
                        className={`absolute h-3 w-3 rounded-full border-2 border-osu-pink bg-osu-b6 ${handleClass(handle)}`}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* Footer: output size + apply */}
        <div className="flex flex-wrap items-center gap-3 border-t border-osu-b3/30 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1">Output</span>
            <input
              type="number"
              min={1}
              value={output.w || ""}
              onChange={(event) => setOutputWidth(Number(event.target.value))}
              disabled={!img || working}
              className="w-20 rounded-md border border-osu-b3/50 bg-osu-b5 px-2 py-1 text-[13px] text-osu-c1 focus:border-osu-h1/40 focus:outline-none"
            />
            <span className="text-osu-f1">×</span>
            <input
              type="number"
              min={1}
              value={output.h || ""}
              onChange={(event) => setOutputHeight(Number(event.target.value))}
              disabled={!img || working}
              className="w-20 rounded-md border border-osu-b3/50 bg-osu-b5 px-2 py-1 text-[13px] text-osu-c1 focus:border-osu-h1/40 focus:outline-none"
            />
            <span className="text-[11px] text-osu-f1">px</span>
          </div>
          <button
            type="button"
            onClick={() => setLockAspect((value) => !value)}
            title={lockAspect ? "Aspect ratio locked" : "Aspect ratio unlocked"}
            className={`grid h-8 w-8 place-items-center rounded-md border transition-colors cursor-pointer ${
              lockAspect
                ? "border-osu-h1/40 bg-osu-h1/20 text-osu-c1"
                : "border-osu-b3/50 bg-osu-b5 text-osu-f1 hover:text-osu-c1"
            }`}
          >
            <Link2 size={15} />
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={working}
              className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-osu-l2 hover:text-osu-c1 cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!img || !crop || working}
              className="flex items-center gap-1.5 rounded-md border border-osu-h1/40 bg-osu-h1/20 px-3 py-1.5 text-[12px] font-semibold text-osu-c1 hover:bg-osu-h1/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
            >
              {working ? <Loader2 size={14} className="animate-spin" /> : null}
              {working ? "Uploading…" : "Apply & upload"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function handleClass(handle: Handle): string {
  switch (handle) {
    case "nw": return "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize";
    case "n": return "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize";
    case "ne": return "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize";
    case "e": return "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize";
    case "se": return "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize";
    case "s": return "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize";
    case "sw": return "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize";
    case "w": return "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize";
  }
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-8 w-8 place-items-center rounded-md border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default ${
        active
          ? "border-osu-h1/40 bg-osu-h1/20 text-osu-c1"
          : "border-transparent text-osu-l2 hover:bg-osu-b3/60 hover:text-osu-c1"
      }`}
    >
      {children}
    </button>
  );
}
