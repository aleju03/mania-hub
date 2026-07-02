import { AnimatePresence, motion } from "framer-motion";
import { Upload, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { importReplaySkinFromOsk, type ReplaySkinImportResult } from "../../lib/replay-skin-import";
import { loadSkinPreviewBackground, renderSkinPreview } from "../../lib/skin-preview-render";
import {
  finishSkinUpload,
  formatSkinFileSize,
  SKIN_DESCRIPTION_MAX_LENGTH,
  SKIN_MAX_SCREENSHOTS,
  SKIN_OSK_MAX_BYTES,
  SKIN_SCREENSHOT_MAX_BYTES,
  SkinUploadError,
  startSkinUpload,
  uploadErrorMessage,
  uploadSkinPart,
  type SkinSummary,
} from "../../lib/skins";

// The publish flow, entirely client-driven: parse the .osk in the browser
// (jszip via the replay-skin importer), compose the preview on a canvas, then
// stream preview + screenshots + the .osk itself straight to the live backend
// against a ticket minted through the authenticated server fn. Lives in a
// centered modal so opening it never reflows the browse grid underneath.

type UploadStep = "pick" | "form" | "uploading" | "done";

interface ProcessedScreenshot {
  blob: Blob;
  width: number;
  height: number;
  url: string;
}

interface RenderedPreview {
  blob: Blob;
  width: number;
  height: number;
  url: string;
  accent: string;
}

interface UploadTicket {
  id: string;
  token: string;
}

// Canvas port of lazer's Triangles drawable (osu.Game/Graphics/Backgrounds/
// Triangles.cs): a dense field of equilateral triangles, sizes normally
// distributed around a 100px base, each an opaque shade between a dark and a
// light colour, drifting up at a speed proportional to size and respawning
// below the bottom edge. Drag hover swaps in a pinker palette and speeds the
// drift up. Static under reduced motion.
const TRI_BASE_SIZE = 100;
const TRI_BASE_VELOCITY = 50;
const TRI_EQUILATERAL = 0.866;
// Global scale: bigger triangles, correspondingly fewer (lazer's TriangleScale).
const TRI_SCALE = 1.6;
// Thin the field out versus lazer's default density (its SpawnRatio).
const TRI_SPAWN_RATIO = 0.4;
const TRI_MAX_COUNT = 320;

interface DriftTriangle {
  x: number; // relative 0..1
  y: number; // relative 0..1, the top vertex
  scale: number;
  shade: number; // 0..1 between the dark and light palette colours
}

function randomNormal(): number {
  const u1 = 1 - Math.random();
  const u2 = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
}

function DropTriangles({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The osu colour tokens are @theme inline (no runtime CSS vars), so the
    // palettes are rebuilt from the theme hue/sat the way styles.css does.
    // Resting: shades just above the b4 surface. Dragging: unmistakably pink.
    const rootStyles = getComputedStyle(document.documentElement);
    const parsedHue = parseFloat(rootStyles.getPropertyValue("--theme-hue"));
    const parsedSat = parseFloat(rootStyles.getPropertyValue("--theme-sat"));
    const hue = Number.isFinite(parsedHue) ? parsedHue : 333;
    const sat = Number.isFinite(parsedSat) ? parsedSat : 1;
    const shadeAt = (shade: number, dark: [number, number], light: [number, number]) =>
      `hsl(${hue}, ${(dark[0] + (light[0] - dark[0]) * shade) * sat}%, ${dark[1] + (light[1] - dark[1]) * shade}%)`;
    const restingColour = (shade: number) => shadeAt(shade, [10, 17], [13, 23.5]);
    const draggingColour = (shade: number) => shadeAt(shade, [30, 20], [48, 34]);

    let width = 0;
    let height = 0;
    let triangles: DriftTriangle[] = [];
    let colours: { resting: string; dragging: string }[] = [];
    let frame = 0;
    let last = performance.now();

    const createTriangle = (randomY: boolean): DriftTriangle => {
      const scale = Math.max(TRI_SCALE * (0.5 + 0.16 * randomNormal()), 0.1);
      // Spawns may sit slightly above the top so the field has no bare edge.
      const maxOffset = (TRI_BASE_SIZE * scale * TRI_EQUILATERAL) / height;
      return {
        x: Math.random(),
        y: randomY ? -maxOffset + Math.random() * (1 + maxOffset) : 1,
        scale,
        shade: Math.random(),
      };
    };

    const reset = () => {
      const aimCount = Math.min(TRI_MAX_COUNT, Math.ceil(((width * height) * 0.002 * TRI_SPAWN_RATIO) / (TRI_SCALE * TRI_SCALE)));
      triangles = Array.from({ length: aimCount }, () => createTriangle(true));
      // Large triangles behind, small in front, lazer's draw order.
      triangles.sort((a, b) => b.scale - a.scale);
      colours = triangles.map((triangle) => ({
        resting: restingColour(triangle.shade),
        dragging: draggingColour(triangle.shade),
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const dragging = activeRef.current;
      for (let index = 0; index < triangles.length; index += 1) {
        const triangle = triangles[index];
        const size = TRI_BASE_SIZE * triangle.scale;
        const px = triangle.x * width;
        const py = triangle.y * height;
        ctx.fillStyle = dragging ? colours[index].dragging : colours[index].resting;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - size / 2, py + size * TRI_EQUILATERAL);
        ctx.lineTo(px + size / 2, py + size * TRI_EQUILATERAL);
        ctx.closePath();
        ctx.fill();
      }
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      reset();
      draw();
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const velocity = activeRef.current ? 1.8 : 0.6;
      const movedDistance = (dt * velocity * TRI_BASE_VELOCITY) / (height * TRI_SCALE);
      for (const triangle of triangles) {
        // Speed scales with size: smaller triangles drift more slowly.
        triangle.y -= Math.max(0.5, triangle.scale) * movedDistance;
        const bottomY = triangle.y + (TRI_BASE_SIZE * triangle.scale * TRI_EQUILATERAL) / height;
        if (bottomY < 0) {
          triangle.y = 1;
          triangle.x = Math.random();
        }
      }
      draw();
      frame = requestAnimationFrame(tick);
    };

    resize();
    if (!reduceMotion) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />;
}

export function SkinUploadModal({
  open,
  onClose,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  onPublished: (skin: SkinSummary) => void;
}) {
  const [step, setStep] = useState<UploadStep>("pick");
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [imported, setImported] = useState<ReplaySkinImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedKeymode, setSelectedKeymode] = useState(4);
  // One rendered playfield per keymode; the selected keymode is the cover.
  const [previews, setPreviews] = useState<Map<number, RenderedPreview>>(new Map());
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewUrlsRef = useRef<string[]>([]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [screenshots, setScreenshots] = useState<ProcessedScreenshot[]>([]);
  const screenshotUrlsRef = useRef<string[]>([]);

  const ticketRef = useRef<UploadTicket | null>(null);
  // One random map cover per picked file, shared by every keymode render so
  // switching keymodes never swaps the backdrop.
  const backgroundRef = useRef<Promise<HTMLImageElement | null> | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
  const [published, setPublished] = useState<SkinSummary | null>(null);

  const [bodyLockActive, setBodyLockActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotInputRef = useRef<HTMLInputElement>(null);

  const revokeAllUrls = useCallback(() => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = [];
    screenshotUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    screenshotUrlsRef.current = [];
  }, []);

  useEffect(() => revokeAllUrls, [revokeAllUrls]);

  const resetAll = useCallback(() => {
    revokeAllUrls();
    setStep("pick");
    setDragActive(false);
    setFile(null);
    setImported(null);
    setError(null);
    setPreviews(new Map());
    setName("");
    setDescription("");
    setScreenshots([]);
    setPublished(null);
    ticketRef.current = null;
    backgroundRef.current = null;
  }, [revokeAllUrls]);

  // Closing mid-form keeps the picked file for a reopen; closing the done
  // screen resets so the next open starts fresh. Errors describe the attempt
  // being abandoned, so they never survive a close.
  const handleDismiss = useCallback(() => {
    if (step === "uploading") return;
    if (step === "done") resetAll();
    else setError(null);
    onClose();
  }, [step, onClose, resetAll]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, handleDismiss]);

  // Engage the body lock synchronously on open (scrollbar gone and gutter
  // compensated before the first painted frame); release it only after the
  // exit fade so the page never reflows under the modal. Same recipe as the
  // maps details modal.
  useLayoutEffect(() => {
    if (open) setBodyLockActive(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!bodyLockActive) return;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const prevScrollbarCompensation = document.documentElement.style.getPropertyValue("--modal-scrollbar-compensation");
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const hasStableScrollbarGutter =
      typeof CSS !== "undefined" && CSS.supports?.("scrollbar-gutter", "stable");
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0 && !hasStableScrollbarGutter) {
      const currentPaddingRight = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
      document.documentElement.style.setProperty("--modal-scrollbar-compensation", `${scrollbarWidth}px`);
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
      if (prevScrollbarCompensation) {
        document.documentElement.style.setProperty("--modal-scrollbar-compensation", prevScrollbarCompensation);
      } else {
        document.documentElement.style.removeProperty("--modal-scrollbar-compensation");
      }
    };
  }, [bodyLockActive]);

  const handleOskFiles = useCallback(async (files: FileList | null) => {
    const picked = files?.[0];
    if (!picked) return;
    setError(null);
    if (picked.size > SKIN_OSK_MAX_BYTES) {
      setError(`This file is ${formatSkinFileSize(picked.size)}. The limit is 50 MB.`);
      return;
    }
    try {
      const result = await importReplaySkinFromOsk(picked, { targetKeyCount: 4 });
      setFile(picked);
      setImported(result);
      setName(result.summary.name.slice(0, 80));
      setDescription("");
      const keymodes = result.summary.keymodes;
      setSelectedKeymode(keymodes.includes(4) ? 4 : keymodes[0] ?? 4);
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current = [];
      setPreviews(new Map());
      ticketRef.current = null;
      backgroundRef.current = loadSkinPreviewBackground();
      setStep("form");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "This .osk could not be read.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  // Render every supported keymode once per picked file (4K first so the hero
  // fills fast); switching keymodes afterwards just swaps images.
  useEffect(() => {
    if (!imported) return;
    let cancelled = false;
    setPreviewBusy(true);
    (async () => {
      const background = await Promise.resolve(backgroundRef.current).catch(() => null);
      const keymodes = [...imported.summary.keymodes].sort((a, b) => (a === 4 ? -1 : b === 4 ? 1 : a - b));
      for (const keys of keymodes) {
        if (cancelled) return;
        const render = await renderSkinPreview(imported.settings, keys, { background });
        if (cancelled) return;
        const url = URL.createObjectURL(render.blob);
        previewUrlsRef.current.push(url);
        setPreviews((previous) => new Map(previous).set(keys, { blob: render.blob, width: render.width, height: render.height, url, accent: render.accent }));
      }
    })()
      .catch(() => {
        if (!cancelled) setError("The previews could not be rendered.");
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [imported]);

  const addScreenshots = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const room = SKIN_MAX_SCREENSHOTS - screenshots.length;
    const picked = [...files].slice(0, room);
    const processed: ProcessedScreenshot[] = [];
    for (const shot of picked) {
      const result = await processScreenshot(shot).catch(() => null);
      if (result) {
        processed.push(result);
        screenshotUrlsRef.current.push(result.url);
      } else {
        setError("A screenshot could not be read as a PNG, JPEG, or WebP under 4 MB.");
      }
    }
    if (processed.length > 0) setScreenshots((previous) => [...previous, ...processed]);
    if (screenshotInputRef.current) screenshotInputRef.current.value = "";
  }, [screenshots.length]);

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((previous) => {
      const removed = previous[index];
      if (removed) {
        URL.revokeObjectURL(removed.url);
        screenshotUrlsRef.current = screenshotUrlsRef.current.filter((url) => url !== removed.url);
      }
      return previous.filter((_, i) => i !== index);
    });
  }, []);

  const publish = useCallback(async () => {
    const previewEntries = [...previews.entries()].sort(([a], [b]) => a - b);
    if (!file || previewEntries.length === 0 || !previews.get(selectedKeymode)) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("The skin needs a name.");
      return;
    }
    setError(null);
    setProgress({ done: 0, total: 0, label: "Preparing the upload." });
    setStep("uploading");
    try {
      // Reuse a still-valid ticket across retries so a network blip does not
      // burn the per-user pending-upload budget.
      if (!ticketRef.current) {
        const started = await startSkinUpload({ data: { name: trimmedName, description: description.trim() } });
        if (!started.ok) {
          setStep("form");
          setError(startErrorMessage(started.error));
          return;
        }
        ticketRef.current = { id: started.id, token: started.token };
      }
      const ticket = ticketRef.current;
      const totalBytes = previewEntries.reduce((sum, [, preview]) => sum + preview.blob.size, 0)
        + screenshots.reduce((sum, shot) => sum + shot.blob.size, 0)
        + file.size;
      let doneBytes = 0;
      const report = (label: string, sent: number) => setProgress({ done: doneBytes + sent, total: totalBytes, label });

      for (const [keys, preview] of previewEntries) {
        const label = `Uploading the ${keys}K preview.`;
        report(label, 0);
        await uploadSkinPart({
          id: ticket.id,
          token: ticket.token,
          part: "preview",
          blob: preview.blob,
          width: preview.width,
          height: preview.height,
          keys,
          cover: keys === selectedKeymode,
          accent: keys === selectedKeymode ? preview.accent : undefined,
          onProgress: (sent) => report(label, sent),
        });
        doneBytes += preview.blob.size;
      }

      for (let index = 0; index < screenshots.length; index += 1) {
        const shot = screenshots[index];
        const label = `Uploading screenshot ${index + 1} of ${screenshots.length}.`;
        report(label, 0);
        await uploadSkinPart({
          id: ticket.id,
          token: ticket.token,
          part: "screenshot",
          blob: shot.blob,
          width: shot.width,
          height: shot.height,
          onProgress: (sent) => report(label, sent),
        });
        doneBytes += shot.blob.size;
      }

      const oskLabel = (sent: number) =>
        `Uploading the skin file, ${formatSkinFileSize(sent) || "0 MB"} of ${formatSkinFileSize(file.size)}.`;
      report(oskLabel(0), 0);
      await uploadSkinPart({
        id: ticket.id,
        token: ticket.token,
        part: "osk",
        blob: file,
        onProgress: (sent) => report(oskLabel(sent), sent),
      });
      doneBytes += file.size;
      report("Publishing.", 0);

      const skin = await finishSkinUpload(ticket.id, ticket.token);
      setPublished(skin);
      setStep("done");
      onPublished(skin);
    } catch (uploadError) {
      if (uploadError instanceof SkinUploadError) {
        if (uploadError.code === "invalid_ticket") ticketRef.current = null;
        setError(uploadError.message);
      } else {
        setError(uploadErrorMessage("upload_failed"));
      }
      setStep("form");
    }
  }, [file, name, description, onPublished, previews, screenshots, selectedKeymode]);

  const uploading = step === "uploading";

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setBodyLockActive(false)}>
      {open && (
        <motion.div
          key="skin-upload"
          className="fixed inset-0 z-[120] flex items-center justify-center py-3 pl-3 sm:py-6 sm:pl-6 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:pr-[calc(1.5rem+var(--modal-scrollbar-compensation,0px))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/85" onClick={handleDismiss} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Upload a skin"
            className="modal-card-mobile-safe relative isolate z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[880px] flex-col overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="pointer-events-none absolute inset-0 bg-osu-b5" aria-hidden="true" />
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-osu-b3/30 px-4 py-3 sm:px-5">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">upload a skin</span>
                {!uploading && (
                  <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Close"
                    className="grid h-7 w-7 place-items-center rounded-full text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white"
                  >
                    <X className="h-4 w-4" strokeWidth={2.4} />
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {step === "done" && published ? (
                  <DoneStep published={published} onUploadAnother={resetAll} />
                ) : step === "pick" ? (
                  <PickStep
                    dragActive={dragActive}
                    setDragActive={setDragActive}
                    error={error}
                    fileInputRef={fileInputRef}
                    onFiles={handleOskFiles}
                  />
                ) : (
                  <FormStep
                    imported={imported}
                    file={file}
                    uploading={uploading}
                    previews={previews}
                    previewBusy={previewBusy}
                    selectedKeymode={selectedKeymode}
                    setSelectedKeymode={setSelectedKeymode}
                    name={name}
                    setName={setName}
                    description={description}
                    setDescription={setDescription}
                    screenshots={screenshots}
                    screenshotInputRef={screenshotInputRef}
                    addScreenshots={addScreenshots}
                    removeScreenshot={removeScreenshot}
                    error={error}
                    progress={progress}
                    onPublish={() => void publish()}
                    onRepick={() => setStep("pick")}
                  />
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function PickStep({
  dragActive,
  setDragActive,
  error,
  fileInputRef,
  onFiles,
}: {
  dragActive: boolean;
  setDragActive: (active: boolean) => void;
  error: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => Promise<void>;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          void onFiles(event.dataTransfer.files);
        }}
        className={`relative block w-full overflow-hidden rounded-xl border transition-colors cursor-pointer ${
          dragActive ? "border-osu-pink/70 bg-osu-b5" : "border-osu-b3/60 bg-osu-b4 hover:border-osu-pink/45"
        }`}
      >
        <DropTriangles active={dragActive} />
        <div className="relative z-10 flex min-h-[240px] flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
          <Upload
            className={`h-8 w-8 transition-colors ${dragActive ? "text-osu-pink-light" : "text-osu-f1"}`}
            aria-hidden="true"
          />
          <div>
            <div className="text-sm font-semibold text-white">
              {dragActive ? "Drop to read it" : "Drop an .osk here, or click to browse"}
            </div>
            <div className="mt-1 text-[11px] text-osu-f1">Up to 50 MB.</div>
          </div>
        </div>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".osk,.zip,application/zip"
        className="sr-only"
        onChange={(event) => void onFiles(event.target.files)}
      />
      {error && <div className="mt-3 text-center text-[12px] font-semibold text-osu-red-light">{error}</div>}
    </>
  );
}

function DoneStep({ published, onUploadAnother }: { published: SkinSummary; onUploadAnother: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-5 text-center">
      {published.previewUrl && (
        <img
          src={published.previewUrl}
          alt={`${published.name} cover`}
          className="aspect-video w-full max-w-[420px] rounded-lg border border-osu-b3/30 object-cover"
        />
      )}
      <div className="text-sm font-bold text-white">{published.name} is live.</div>
      <div className="text-[12px] text-osu-f1">
        {published.keymodes.length > 1
          ? `Previews for ${published.keymodes.map((keys) => `${keys}K`).join(", ")} are on the skin page.`
          : "The skin page is ready to share."}
      </div>
      <div className="flex items-center gap-3">
        <a
          href={`/skins/${published.slug ?? published.id}`}
          className="rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition hover:brightness-110"
        >
          View the skin page
        </a>
        <button
          type="button"
          onClick={onUploadAnother}
          className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
        >
          Upload another
        </button>
      </div>
    </div>
  );
}

function FormStep({
  imported,
  file,
  uploading,
  previews,
  previewBusy,
  selectedKeymode,
  setSelectedKeymode,
  name,
  setName,
  description,
  setDescription,
  screenshots,
  screenshotInputRef,
  addScreenshots,
  removeScreenshot,
  error,
  progress,
  onPublish,
  onRepick,
}: {
  imported: ReplaySkinImportResult | null;
  file: File | null;
  uploading: boolean;
  previews: Map<number, RenderedPreview>;
  previewBusy: boolean;
  selectedKeymode: number;
  setSelectedKeymode: (keys: number) => void;
  name: string;
  setName: (name: string) => void;
  description: string;
  setDescription: (description: string) => void;
  screenshots: ProcessedScreenshot[];
  screenshotInputRef: React.RefObject<HTMLInputElement | null>;
  addScreenshots: (files: FileList | null) => Promise<void>;
  removeScreenshot: (index: number) => void;
  error: string | null;
  progress: { done: number; total: number; label: string };
  onPublish: () => void;
  onRepick: () => void;
}) {
  const keymodes = imported?.summary.keymodes ?? [];
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const heroPreview = previews.get(selectedKeymode);
  const summary = imported?.summary;
  const contentsLine = summary
    ? [
        `${summary.noteAssets} note images`,
        `${summary.receptorAssets} key images`,
        summary.comboDigits > 0 ? "combo font" : null,
        summary.judgementAssets > 0 ? "judgements" : null,
        summary.soundAssets > 0 ? `${summary.soundAssets} hitsounds` : null,
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <div className="relative overflow-hidden rounded-xl border border-osu-b3/30 bg-osu-b4">
          <div className="aspect-video w-full">
            {heroPreview ? (
              <img src={heroPreview.url} alt={`${selectedKeymode}K preview`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-osu-f1">Rendering the {selectedKeymode}K playfield...</div>
            )}
          </div>
        </div>
        {/* Every keymode read from the skin, rendered with the skin's own
            notes; the selected one becomes the browse-card cover. */}
        <div className="mt-2.5 flex flex-wrap items-start gap-2">
          {keymodes.map((keys) => {
            const preview = previews.get(keys);
            const selected = selectedKeymode === keys;
            return (
              <button
                key={keys}
                type="button"
                disabled={uploading}
                onClick={() => setSelectedKeymode(keys)}
                aria-pressed={selected}
                className={`w-[104px] overflow-hidden rounded-lg border text-left transition-colors duration-100 cursor-pointer disabled:cursor-default ${
                  selected ? "border-osu-pink" : "border-osu-b3/40 hover:border-osu-f1/40"
                }`}
              >
                <div className="aspect-video w-full bg-osu-b4">
                  {preview ? (
                    <img src={preview.url} alt={`${keys}K thumbnail`} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] text-osu-f1/60">rendering</div>
                  )}
                </div>
                <div className={`px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${selected ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"}`}>
                  {keys}K{selected ? " · cover" : ""}
                </div>
              </button>
            );
          })}
        </div>
        {contentsLine && (
          <div className="mt-2 text-[11px] text-osu-f1" title="Read from the skin file">
            {contentsLine}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            disabled={uploading}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13.5px] text-osu-l1 transition-colors focus:border-osu-pink/50 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
            Description <span className="normal-case tracking-normal text-osu-f1/70">(optional)</span>
          </span>
          <textarea
            value={description}
            maxLength={SKIN_DESCRIPTION_MAX_LENGTH}
            rows={3}
            disabled={uploading}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What the skin is for, what changed in this edit..."
            className="w-full resize-y rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] leading-relaxed text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
            Screenshots <span className="normal-case tracking-normal text-osu-f1/70">(optional, up to {SKIN_MAX_SCREENSHOTS})</span>
          </span>
          <div className="flex flex-wrap gap-2">
            {screenshots.map((shot, index) => (
              <div key={shot.url} className="relative h-14 w-[99px] overflow-hidden rounded-md border border-osu-b3/40">
                <img src={shot.url} alt={`Screenshot ${index + 1}`} className="h-full w-full object-cover" />
                {!uploading && (
                  <button
                    type="button"
                    onClick={() => removeScreenshot(index)}
                    aria-label={`Remove screenshot ${index + 1}`}
                    className="absolute right-0.5 top-0.5 rounded bg-osu-b5/85 p-0.5 text-osu-l2 transition-colors cursor-pointer hover:text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            {screenshots.length < SKIN_MAX_SCREENSHOTS && !uploading && (
              <button
                type="button"
                onClick={() => screenshotInputRef.current?.click()}
                className="flex h-14 w-[99px] items-center justify-center rounded-md border border-dashed border-osu-b3/60 text-[20px] font-light text-osu-f1 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-osu-l2"
                aria-label="Add screenshots"
              >
                +
              </button>
            )}
          </div>
          <input
            ref={screenshotInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="sr-only"
            onChange={(event) => void addScreenshots(event.target.files)}
          />
        </div>

        <div className="mt-auto flex flex-col gap-2.5 pt-1">
          {error && <div className="text-[12px] font-semibold text-osu-red-light">{error}</div>}
          {uploading ? (
            <div className="flex flex-col gap-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-osu-b4">
                <div className="h-full bg-osu-pink transition-[width] duration-150" style={{ width: `${percent}%` }} />
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[11.5px] text-osu-f1">
                <span className="truncate">{progress.label}</span>
                <span className="shrink-0 tabular-nums">{percent}%</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={onPublish}
                disabled={previewBusy || !heroPreview}
                className="rounded-full bg-osu-pink px-6 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-50"
              >
                Upload skin
              </button>
              <button
                type="button"
                onClick={onRepick}
                className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
              >
                Pick a different file
              </button>
              {file && <span className="text-[11px] text-osu-f1 tabular-nums">{formatSkinFileSize(file.size)}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function startErrorMessage(code: "not_logged_in" | "unavailable" | "storage_not_configured" | "invalid_name" | "pending_limit" | "skin_limit"): string {
  switch (code) {
    case "not_logged_in":
      return "The session expired. Log in with osu! again to publish.";
    case "invalid_name":
      return "The skin needs a name.";
    case "pending_limit":
      return "An upload is already in progress. Finish it or wait a few minutes.";
    case "skin_limit":
      return "The limit of 30 published skins per account is reached.";
    case "storage_not_configured":
      return "Skin storage is not configured on the server (R2 credentials are missing).";
    default:
      return "Uploads are not available right now.";
  }
}

async function processScreenshot(file: File): Promise<ProcessedScreenshot | null> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImage(sourceUrl);
    const scale = Math.min(1, 1920 / Math.max(1, image.naturalWidth));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((webp) => {
        if (webp && webp.type === "image/webp") resolve(webp);
        else canvas.toBlob((png) => resolve(png), "image/png");
      }, "image/webp", 0.85);
    });
    if (!blob || blob.size > SKIN_SCREENSHOT_MAX_BYTES) return null;
    return { blob, width, height, url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image."));
    image.src = src;
  });
}
