import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import JSZip from "jszip";
import { Check, ChevronDown, Copy, Star, Upload, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { skinEventProperties } from "../../lib/analytics-skins";
import { track } from "../../lib/analytics";
import { importReplaySkinFromOsk, type ReplaySkinImportResult } from "../../lib/replay-skin-import";
import { buildSkinAssetGroups, type SkinAssetGroup } from "../../lib/skin-asset-explorer";
import { SkinAssetTiles } from "./SkinAssetExplorer";
import { SkinCard } from "./SkinCard";
import type { SkinBackdropRowPool } from "./SkinBackdropPicker";
import { useSkinPatternPool, type SkinPatternPool } from "./SkinPatternPicker";
import { SkinPreviewPickers } from "./SkinPreviewPickers";
import type { SkinPreviewChartSnippet } from "../../lib/skin-preview-patterns";
import {
  applyBackdropPick,
  backdropForKeymode,
  type BackdropScope,
  drawSkinPreviewBackdrops,
  type PreviewBackdrop,
  replaceBackdrop,
  type SkinBackdropCandidate,
} from "../../lib/skin-preview-backdrops";
import { loadSkinPreviewBackgroundForSet, renderSkinPreview } from "../../lib/skin-preview-render";
import { processScreenshot, type DraftScreenshot } from "../../lib/skin-screenshot-process";
import { SkinScreenshotFields } from "./SkinScreenshotFields";
import {
  type DuplicateSkinRef,
  finishSkinUpload,
  formatSkinFileSize,
  hashOskFile,
  markSkinsListStale,
  normalizeSkinResolution,
  SKIN_DESCRIPTION_MAX_LENGTH,
  SKIN_MAX_SCREENSHOTS,
  SKIN_AUTHOR_MAX_LENGTH,
  SKIN_OSK_MAX_BYTES,
  SKIN_RESOLUTION_PRESETS,
  SkinUploadError,
  startSkinUpload,
  uploadErrorMessage,
  uploadSkinPart,
  uploadSkinPreviewsParallel,
  skinPreviewUploadLabel,
  type SkinSummary,
  type SkinVisibility,
} from "../../lib/skins";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";


const VISIBILITY_CHOICES: ReadonlyArray<{ value: SkinVisibility; label: string; hint: string }> = [
  { value: "public", label: "Everyone", hint: "On /skins, anyone can download the .osk." },
  { value: "private", label: "Only me", hint: "Off the list, no download. Your replays still play in it." },
];

// The publish flow, entirely client-driven: parse the .osk in the browser
// (jszip via the replay-skin importer), compose the preview on a canvas, then
// stream preview + screenshots + the .osk itself straight to the live backend
// against a ticket minted through the authenticated server fn. Lives in a
// centered modal so opening it never reflows the browse grid underneath.

type UploadStep = "pick" | "form" | "uploading" | "done";

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

function randomPoolPick(pool: SkinBackdropCandidate[]): PreviewBackdrop {
  return pool[Math.floor(Math.random() * pool.length)]?.setId ?? "flat";
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
  // Set when the .osk being published is already on the site, so the error can
  // link to it. Cleared alongside every other error.
  const [duplicate, setDuplicate] = useState<DuplicateSkinRef | null>(null);
  // Local parse progress after a drop: extracting and decoding the skin's
  // assets takes seconds on big .osk files. percent is null until the archive
  // is open and the reference count is known.
  const [reading, setReading] = useState<{ name: string; percent: number | null } | null>(null);

  const [selectedKeymode, setSelectedKeymode] = useState(4);
  // Which keymode's render becomes the browse-card cover. Separate from the
  // keymode being viewed: clicking through the previews used to retarget the
  // cover, so looking at 1K published a 1K card.
  const [coverKeymode, setCoverKeymode] = useState(4);
  // One rendered playfield per keymode; the selected keymode is the cover.
  const [previews, setPreviews] = useState<Map<number, RenderedPreview>>(new Map());
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewUrlsRef = useRef<string[]>([]);

  const [name, setName] = useState("");
  // Who made the skin, prefilled from skin.ini's Author; the browse cards
  // credit this instead of the uploader.
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  // The resolution the skin is made for, the uploader's optional word; the
  // /skins display filter matches on it. Free-typed, normalized server-side.
  const [resolution, setResolution] = useState("");
  // Public puts the skin on /skins for anyone to download; private keeps it to
  // the uploader and lets it front their replays without leaving the server.
  const [visibility, setVisibility] = useState<SkinVisibility>("public");
  const [screenshots, setScreenshots] = useState<DraftScreenshot[]>([]);
  // A screenshot the uploader would rather have on the browse card than any of
  // the rendered playfields; null leaves the card to the cover keymode.
  const [coverShot, setCoverShot] = useState<number | null>(null);
  const screenshotUrlsRef = useRef<string[]>([]);

  // What the archive ships, grouped by osu!'s known asset names; shown under
  // the previews so uploaders can sanity-check what was detected. The zip
  // stays around so a chip can expand into the actual thumbnails.
  const [assetGroups, setAssetGroups] = useState<SkinAssetGroup[] | null>(null);
  const assetZipRef = useRef<JSZip | null>(null);
  const assetUrlsRef = useRef<Map<string, string>>(new Map());

  const revokeAssetUrls = useCallback(() => {
    assetUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    assetUrlsRef.current.clear();
  }, []);

  // Same one-object-URL-per-path registry as the skin page explorer.
  const resolveAssetUrl = useCallback(async (path: string): Promise<string | null> => {
    const existing = assetUrlsRef.current.get(path);
    if (existing) return existing;
    const entry = assetZipRef.current?.file(path);
    if (!entry) return null;
    try {
      const blob = await entry.async("blob");
      const url = URL.createObjectURL(blob);
      const raced = assetUrlsRef.current.get(path);
      if (raced) {
        URL.revokeObjectURL(url);
        return raced;
      }
      assetUrlsRef.current.set(path, url);
      return url;
    } catch {
      return null;
    }
  }, []);

  const ticketRef = useRef<UploadTicket | null>(null);
  // Screenshots the current ticket already carries, by object URL, and which
  // of them claimed the card. Retries reuse the ticket, and screenshots append
  // rather than replace, so without this a retry after a later failure (the
  // 50MB .osk is the usual one) would put a second copy of every shot in the
  // gallery. Both are cleared with the ticket.
  const uploadedShotsRef = useRef<Set<string>>(new Set());
  const coverShotUrlRef = useRef<string | null>(null);
  const oskHashRef = useRef<{ file: File; hash: Promise<string | null> } | null>(null);
  // Whether the current file has previews on screen. Gates the flat-first
  // render pass: it is there so a slow cover never leaves the form blank, and
  // it must not fire once there is something to look at.
  const hasRenderedRef = useRef(false);
  // What each keymode's image was last drawn from, backdrop and notes both, so
  // a change only re-renders the keymodes it actually touches.
  const renderedRef = useRef<Map<number, string>>(new Map());
  // The backdrop behind the rendered previews: one of the map covers on offer
  // or the flat triangle fallback. The offer itself is drawn fresh from the
  // map catalog each upload session (and again on every shuffle), so skins
  // stop sharing one fixed handful of covers; the draw starts empty and the
  // first arrival picks the default. Keymodes share that default until one is
  // given its own cover, which is what backdropOverrides holds. Covers memoize
  // per set: the promise map dedupes in-flight loads, the image map records
  // settled results so the render effect can tell "already decoded" apart from
  // "still downloading" without awaiting.
  const [backdropPool, setBackdropPool] = useState<SkinBackdropCandidate[]>([]);
  const backdropPoolRef = useRef<SkinBackdropCandidate[]>([]);
  const [backdropDrawing, setBackdropDrawing] = useState(false);
  const [backdrop, setBackdrop] = useState<PreviewBackdrop>("flat");
  const [backdropOverrides, setBackdropOverrides] = useState<Map<number, PreviewBackdrop>>(new Map());
  // Whether a pick retargets every keymode or only the one on screen.
  const [backdropScope, setBackdropScope] = useState<BackdropScope>("all");
  const backgroundPromisesRef = useRef<Map<number, Promise<HTMLImageElement | null>>>(new Map());
  const backgroundImagesRef = useRef<Map<number, HTMLImageElement | null>>(new Map());
  // A draw in flight owns the default pick; a user click during it does not
  // get overwritten when the covers land.
  const backdropTouchedRef = useRef(false);
  const drawInFlightRef = useRef(false);

  const ensureBackdropImage = useCallback((setId: number): Promise<HTMLImageElement | null> => {
    let promise = backgroundPromisesRef.current.get(setId);
    if (!promise) {
      promise = loadSkinPreviewBackgroundForSet(setId).catch(() => null);
      backgroundPromisesRef.current.set(setId, promise);
      void promise.then((image) => backgroundImagesRef.current.set(setId, image));
    }
    return promise;
  }, []);

  // Draws a new set of covers to choose from, skipping the ones already on
  // offer so a shuffle visibly changes the row.
  const drawBackdrops = useCallback(async (exclude: number[]) => {
    setBackdropDrawing(true);
    try {
      const pool = await drawSkinPreviewBackdrops({ exclude });
      backdropPoolRef.current = pool;
      setBackdropPool(pool);
      return pool;
    } finally {
      setBackdropDrawing(false);
    }
  }, []);

  // One draw per upload session: opening the modal fills the picker, and a
  // reset clears the pool so the next upload gets different covers. Kicking it
  // off at open time means the covers are usually chosen and warm before the
  // .osk has finished parsing.
  useEffect(() => {
    if (!open || backdropPool.length > 0 || drawInFlightRef.current) return;
    drawInFlightRef.current = true;
    void drawBackdrops([])
      .then((pool) => {
        if (!backdropTouchedRef.current) setBackdrop(randomPoolPick(pool));
      })
      .catch(() => {})
      .finally(() => {
        drawInFlightRef.current = false;
      });
  }, [open, backdropPool.length, drawBackdrops]);

  // A pick lands on the keymode on screen or on all of them, per the scope.
  // "all" also drops the per-keymode overrides: it would not be all otherwise,
  // and it doubles as the way back to one shared backdrop.
  const pickBackdrop = useCallback((choice: PreviewBackdrop) => {
    backdropTouchedRef.current = true;
    const next = applyBackdropPick(
      { shared: backdrop, overrides: backdropOverrides },
      { scope: backdropScope, keymode: selectedKeymode, choice },
    );
    setBackdrop(next.shared);
    setBackdropOverrides(next.overrides);
  }, [backdrop, backdropOverrides, backdropScope, selectedKeymode]);

  const shuffleBackdrops = useCallback(() => {
    backdropTouchedRef.current = true;
    drawInFlightRef.current = true;
    void drawBackdrops(backdropPool.map((candidate) => candidate.setId))
      .then((pool) => pickBackdrop(randomPoolPick(pool)))
      .catch(() => {})
      .finally(() => {
        drawInFlightRef.current = false;
      });
  }, [backdropPool, drawBackdrops, pickBackdrop]);

  // Hovering a thumbnail starts its download, so the click usually lands on an
  // already-decoded cover and re-renders without a wait.
  const prefetchBackdrop = useCallback((setId: number) => {
    void ensureBackdropImage(setId);
  }, [ensureBackdropImage]);

  // A cover with no art on assets.ppy.sh drops out of the picker instead of
  // showing a broken thumbnail, and anything rendering against it moves to
  // another cover from the row. Only a dead cover triggers this: a shuffle
  // replaces the row without disturbing keymodes that already picked, so
  // covers stay in use after they leave the offer.
  const dropBackdropCandidate = useCallback((setId: number) => {
    const remaining = backdropPoolRef.current.filter((candidate) => candidate.setId !== setId);
    // Mirrored eagerly so a second dead thumbnail in the same tick filters the
    // already-shortened row instead of resurrecting this one.
    backdropPoolRef.current = remaining;
    setBackdropPool(remaining);
    const next = replaceBackdrop(
      { shared: backdrop, overrides: backdropOverrides },
      setId,
      randomPoolPick(remaining),
    );
    setBackdrop(next.shared);
    setBackdropOverrides(next.overrides);
  }, [backdrop, backdropOverrides]);

  // The shape the shared picker row reads, out of the backdrop state this
  // modal keeps itself.
  const backdropRowPool = useMemo<SkinBackdropRowPool>(() => ({
    candidates: backdropPool,
    drawing: backdropDrawing,
    shuffle: shuffleBackdrops,
    drop: dropBackdropCandidate,
    prefetch: prefetchBackdrop,
  }), [backdropPool, backdropDrawing, shuffleBackdrops, dropBackdropCandidate, prefetchBackdrop]);

  const backdropFor = useCallback(
    (keys: number): PreviewBackdrop => backdropForKeymode({ shared: backdrop, overrides: backdropOverrides }, keys),
    [backdrop, backdropOverrides],
  );

  // The notes on each keymode's field. A snippet only fits the keymode it was
  // cut from, so there is no shared pick here: every keymode is dealt its own
  // chart as soon as its pool lands, and a manual pick replaces it. An entry
  // set to null is the built-in layout, chosen on purpose.
  const [patterns, setPatterns] = useState<Map<number, SkinPreviewChartSnippet | null>>(new Map());
  const patternPool = useSkinPatternPool(open, selectedKeymode);
  const patternEnsure = patternPool.ensure;

  const pickPattern = useCallback((choice: SkinPreviewChartSnippet | null) => {
    setPatterns((previous) => new Map(previous).set(selectedKeymode, choice));
  }, [selectedKeymode]);

  // Deals every keymode the .osk ships a chart of its own, which is what stops
  // a page of browse cards being the same notes over and over. Keymodes the
  // uploader already picked for are left alone.
  useEffect(() => {
    if (!open || !imported) return;
    let cancelled = false;
    for (const keys of imported.summary.keymodes) {
      void patternEnsure(keys).then((pool) => {
        if (cancelled || pool.length === 0) return;
        setPatterns((previous) => {
          if (previous.has(keys)) return previous;
          return new Map(previous).set(keys, pool[Math.floor(Math.random() * pool.length)]);
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [open, imported, patternEnsure]);

  // Warm the chosen covers as soon as they are picked: picking and parsing the
  // .osk takes a while, which hides the download so the first render rarely
  // has to wait for it.
  useEffect(() => {
    if (!open) return;
    for (const choice of [backdrop, ...backdropOverrides.values()]) {
      if (choice !== "flat") void ensureBackdropImage(choice);
    }
  }, [open, backdrop, backdropOverrides, ensureBackdropImage]);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
  const [published, setPublished] = useState<SkinSummary | null>(null);

  const [bodyLockActive, setBodyLockActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const revokeAllUrls = useCallback(() => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = [];
    screenshotUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    screenshotUrlsRef.current = [];
    revokeAssetUrls();
  }, [revokeAssetUrls]);

  useEffect(() => revokeAllUrls, [revokeAllUrls]);

  const resetAll = useCallback(() => {
    revokeAllUrls();
    setStep("pick");
    setDragActive(false);
    setFile(null);
    setImported(null);
    setError(null);
    setDuplicate(null);
    setPreviews(new Map());
    hasRenderedRef.current = false;
    renderedRef.current.clear();
    setPatterns(new Map());
    setName("");
    setAuthor("");
    setDescription("");
    setScreenshots([]);
    setCoverShot(null);
    setPublished(null);
    setAssetGroups(null);
    // Emptying the pool makes the next open draw a fresh one.
    setBackdropPool([]);
    backdropPoolRef.current = [];
    setBackdrop("flat");
    setBackdropOverrides(new Map());
    setBackdropScope("all");
    backdropTouchedRef.current = false;
    ticketRef.current = null;
    uploadedShotsRef.current.clear();
    coverShotUrlRef.current = null;
    assetZipRef.current = null;
  }, [revokeAllUrls]);

  // Closing mid-form keeps the picked file for a reopen; closing the done
  // screen resets so the next open starts fresh. Errors describe the attempt
  // being abandoned, so they never survive a close.
  const handleDismiss = useCallback(() => {
    if (step === "uploading") return;
    if (step === "done") resetAll();
    else {
      setError(null);
      setDuplicate(null);
    }
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

  useBodyScrollLock(bodyLockActive);

  const handleOskFiles = useCallback(async (files: FileList | null) => {
    const picked = files?.[0];
    if (!picked) return;
    setError(null);
    setDuplicate(null);
    if (picked.size > SKIN_OSK_MAX_BYTES) {
      setError(`This file is ${formatSkinFileSize(picked.size)}. The limit is 50 MB.`);
      return;
    }
    setReading({ name: picked.name, percent: null });
    try {
      let lastPercent = -1;
      const result = await importReplaySkinFromOsk(picked, {
        targetKeyCount: 4,
        onProgress: (done, total) => {
          // State updates only on whole-percent changes; a big skin ticks
          // hundreds of times.
          const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          if (percent !== lastPercent) {
            lastPercent = percent;
            setReading({ name: picked.name, percent });
          }
        },
      });
      setFile(picked);
      setImported(result);
      // Hashing starts here, while the uploader is still filling the form, so
      // the publish click can ask the backend whether these exact bytes are
      // already on the site before it starts transferring them. Kept as the
      // promise, tagged with its file: publish awaits it if it has not settled
      // yet, and a re-pick makes the older one irrelevant rather than racing.
      oskHashRef.current = { file: picked, hash: hashOskFile(picked) };
      setName(result.summary.name.slice(0, 80));
      setAuthor((result.summary.author ?? "").slice(0, SKIN_AUTHOR_MAX_LENGTH));
      setDescription("");
      const keymodes = result.summary.keymodes;
      // 4K is the keymode people recognise a skin by, so it fronts the card
      // whenever the skin ships it.
      const defaultKeymode = keymodes.includes(4) ? 4 : keymodes[0] ?? 4;
      setSelectedKeymode(defaultKeymode);
      setCoverKeymode(defaultKeymode);
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current = [];
      setPreviews(new Map());
      hasRenderedRef.current = false;
      renderedRef.current.clear();
      // A different .osk is a different set of keymodes, so its patterns are
      // dealt afresh rather than inherited from the file just dropped.
      setPatterns(new Map());
      ticketRef.current = null;
      setStep("form");
      // Asset detection reads only the zip's central directory plus name
      // matching, so it fills in quickly after the form appears.
      setAssetGroups(null);
      revokeAssetUrls();
      assetZipRef.current = null;
      void JSZip.loadAsync(picked)
        .then((zip) => {
          const files = Object.values(zip.files)
            .filter((entry) => !entry.dir)
            .map((entry) => ({
              path: entry.name,
              size: (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 1,
            }));
          assetZipRef.current = zip;
          setAssetGroups(buildSkinAssetGroups(files));
        })
        .catch(() => setAssetGroups([]));
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "This .osk could not be read.");
    } finally {
      setReading(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [revokeAssetUrls]);

  // Render every supported keymode once per picked file and again whenever its
  // backdrop changes (4K first so the hero fills fast); switching keymodes
  // afterwards just swaps images. Only the keymodes whose backdrop actually
  // moved are redrawn, so retargeting one leaves the rest untouched.
  useEffect(() => {
    if (!imported) return;
    const keymodes = [...imported.summary.keymodes].sort((a, b) => (a === 4 ? -1 : b === 4 ? 1 : a - b));
    const patternFor = (keys: number) => patterns.get(keys) ?? null;
    const signatureFor = (keys: number) => `${backdropFor(keys)}|${patternFor(keys)?.beatmapId ?? "builtin"}`;
    const pending = keymodes.filter((keys) => renderedRef.current.get(keys) !== signatureFor(keys));
    if (pending.length === 0) return;
    let cancelled = false;
    setPreviewBusy(true);
    const renderOne = async (keys: number, background: HTMLImageElement | null) => {
      const render = await renderSkinPreview(imported.settings, keys, { background, pattern: patternFor(keys) });
      if (cancelled) return;
      const url = URL.createObjectURL(render.blob);
      previewUrlsRef.current.push(url);
      setPreviews((previous) => {
        const replaced = previous.get(keys);
        if (replaced) {
          URL.revokeObjectURL(replaced.url);
          previewUrlsRef.current = previewUrlsRef.current.filter((candidate) => candidate !== replaced.url);
        }
        return new Map(previous).set(keys, { blob: render.blob, width: render.width, height: render.height, url, accent: render.accent });
      });
      hasRenderedRef.current = true;
    };
    // A settled cover renders straight away; an unsettled one is awaited, so a
    // preview already on screen is held rather than flashing the flat backdrop.
    // A cover that fails to load resolves null and stays flat, no retry.
    const backgroundFor = async (choice: PreviewBackdrop): Promise<HTMLImageElement | null> => {
      if (choice === "flat") return null;
      if (backgroundImagesRef.current.has(choice)) return backgroundImagesRef.current.get(choice) ?? null;
      return ensureBackdropImage(choice);
    };
    (async () => {
      // Nothing on screen yet and the first cover is still downloading: draw
      // the whole set flat so the form fills immediately, then let each
      // keymode swap to its own cover below as it resolves.
      const first = backdropFor(pending[0]);
      if (!hasRenderedRef.current && first !== "flat" && !backgroundImagesRef.current.has(first)) {
        for (const keys of pending) {
          if (cancelled) return;
          await renderOne(keys, null);
        }
      }
      for (const keys of pending) {
        if (cancelled) return;
        const signature = signatureFor(keys);
        const background = await backgroundFor(backdropFor(keys));
        if (cancelled) return;
        await renderOne(keys, background);
        renderedRef.current.set(keys, signature);
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
  }, [imported, backdropFor, patterns, ensureBackdropImage]);

  const addScreenshots = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const room = SKIN_MAX_SCREENSHOTS - screenshots.length;
    const picked = [...files].slice(0, room);
    const processed: DraftScreenshot[] = [];
    for (const shot of picked) {
      const result = await processScreenshot(shot).catch(() => null);
      if (result) {
        processed.push({ ...result, label: "" });
        screenshotUrlsRef.current.push(result.url);
      } else {
        setError("A screenshot could not be read as a PNG, JPEG, or WebP under 4 MB.");
      }
    }
    if (processed.length > 0) setScreenshots((previous) => [...previous, ...processed]);
  }, [screenshots.length]);

  const renameScreenshot = useCallback((index: number, label: string) => {
    setScreenshots((previous) => previous.map((shot, i) => (i === index ? { ...shot, label } : shot)));
  }, []);

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((previous) => {
      const removed = previous[index];
      if (removed) {
        URL.revokeObjectURL(removed.url);
        screenshotUrlsRef.current = screenshotUrlsRef.current.filter((url) => url !== removed.url);
      }
      return previous.filter((_, i) => i !== index);
    });
    // The cover follows the shots it sits among: one removed above it shifts
    // it up, and removing the cover itself hands the card back to a keymode.
    setCoverShot((previous) => (previous == null || previous === index ? null : previous > index ? previous - 1 : previous));
  }, []);

  const publish = useCallback(async () => {
    const previewEntries = [...previews.entries()].sort(([a], [b]) => a - b);
    if (!file || previewEntries.length === 0 || !previews.get(coverKeymode)) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("The skin needs a name.");
      return;
    }
    setError(null);
    setDuplicate(null);
    setProgress({ done: 0, total: 0, label: "Preparing the upload." });
    setStep("uploading");
    try {
      // Reuse a still-valid ticket across retries so a network blip does not
      // burn the per-user pending-upload budget.
      if (!ticketRef.current) {
        const oskSha256 = oskHashRef.current?.file === file ? await oskHashRef.current.hash : null;
        const started = await startSkinUpload({
          data: { name: trimmedName, author: author.trim(), description: description.trim(), oskSha256, visibility, resolution: resolution.trim() },
        });
        if (!started.ok) {
          setStep("form");
          setError(startErrorMessage(started.error));
          if (started.error === "duplicate") setDuplicate(started.duplicate);
          return;
        }
        ticketRef.current = { id: started.id, token: started.token };
      }
      const ticket = ticketRef.current;
      // A shot the ticket already carries is not sent again, and not counted.
      // The exception is a shot starred since the last attempt: a pending row's
      // cover only moves by an upload claiming it, so that one goes up again.
      const starredUrl = coverShot != null ? screenshots[coverShot]?.url ?? null : null;
      const pendingShots = screenshots.filter((shot) => (
        !uploadedShotsRef.current.has(shot.url)
        || (shot.url === starredUrl && coverShotUrlRef.current !== starredUrl)
      ));
      const totalBytes = previewEntries.reduce((sum, [, preview]) => sum + preview.blob.size, 0)
        + pendingShots.reduce((sum, shot) => sum + shot.blob.size, 0)
        + file.size;
      let doneBytes = 0;
      const report = (label: string, sent: number) => setProgress({ done: doneBytes + sent, total: totalBytes, label });

      const previewBytes = previewEntries.reduce((sum, [, preview]) => sum + preview.blob.size, 0);
      await uploadSkinPreviewsParallel(
        previewEntries.map(([keys, preview]) => ({ keys, sizeBytes: preview.blob.size, preview })),
        ({ keys, preview }, onProgress) => uploadSkinPart({
          id: ticket.id,
          token: ticket.token,
          part: "preview",
          blob: preview.blob,
          width: preview.width,
          height: preview.height,
          keys,
          // A starred screenshot is the cover, and it says so itself when it
          // uploads below. Claiming it here too would hand the card back to a
          // render on a retry that skips the screenshot it already sent.
          cover: coverShot == null && keys === coverKeymode,
          accent: keys === coverKeymode ? preview.accent : undefined,
          onProgress,
        }),
        ({ sentBytes, activeKeys, completed, total }) => setProgress({
          done: sentBytes,
          total: totalBytes,
          label: skinPreviewUploadLabel(activeKeys, completed, total),
        }),
      );
      doneBytes = previewBytes;

      for (let index = 0; index < pendingShots.length; index += 1) {
        const shot = pendingShots[index];
        const step = `Uploading screenshot ${index + 1} of ${pendingShots.length}.`;
        report(step, 0);
        await uploadSkinPart({
          id: ticket.id,
          token: ticket.token,
          part: "screenshot",
          blob: shot.blob,
          width: shot.width,
          height: shot.height,
          label: shot.label,
          // Screenshots upload after the renders, so a starred one is the last
          // word on what fronts the card.
          cover: shot.url === starredUrl,
          onProgress: (sent) => report(step, sent),
        });
        uploadedShotsRef.current.add(shot.url);
        if (shot.url === starredUrl) coverShotUrlRef.current = starredUrl;
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

      const skin = await finishSkinUpload(
        ticket.id,
        ticket.token,
        previewEntries.map(([keys]) => ({
          keys,
          recipe: {
            backdrop: backdropFor(keys),
            pattern: patterns.get(keys) ?? null,
          },
        })),
      );
      track("skin_upload_published", skinEventProperties(skin));
      markSkinsListStale();
      setPublished(skin);
      setStep("done");
      onPublished(skin);
    } catch (uploadError) {
      // What visitors trip over on the way to publishing is worth knowing;
      // the reason travels, the file does not.
      track("skin_upload_failed", {
        skin_upload_error: uploadError instanceof SkinUploadError ? uploadError.code : "unexpected",
      });
      if (uploadError instanceof SkinUploadError) {
        // A dead ticket means a fresh row next time, which carries none of the
        // screenshots the old one did.
        if (uploadError.code === "invalid_ticket") {
          ticketRef.current = null;
          uploadedShotsRef.current.clear();
          coverShotUrlRef.current = null;
        }
        if (uploadError.code === "duplicate") setDuplicate(uploadError.duplicate ?? null);
        setError(uploadError.message);
      } else {
        setError(uploadErrorMessage("upload_failed"));
      }
      setStep("form");
    }
  }, [file, name, author, description, resolution, visibility, onPublished, previews, screenshots, coverKeymode, coverShot, backdropFor, patterns]);

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
                  <DoneStep published={published} onUploadAnother={resetAll} onDismiss={handleDismiss} />
                ) : step === "pick" ? (
                  <PickStep
                    dragActive={dragActive}
                    setDragActive={setDragActive}
                    error={error}
                    reading={reading}
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
                    backdrop={backdropFor(selectedKeymode)}
                    pickBackdrop={pickBackdrop}
                    backdropScope={backdropScope}
                    setBackdropScope={setBackdropScope}
                    overriddenKeymodes={backdropOverrides}
                    backdropPool={backdropRowPool}
                    patternPool={patternPool}
                    pattern={patterns.get(selectedKeymode) ?? null}
                    pickPattern={pickPattern}
                    assetGroups={assetGroups}
                    resolveAssetUrl={resolveAssetUrl}
                    selectedKeymode={selectedKeymode}
                    setSelectedKeymode={setSelectedKeymode}
                    coverKeymode={coverKeymode}
                    setCoverKeymode={(keys) => {
                      setCoverKeymode(keys);
                      // Starring a keymode is how the card goes back to a
                      // rendered playfield after a screenshot took it.
                      setCoverShot(null);
                    }}
                    name={name}
                    setName={setName}
                    author={author}
                    setAuthor={setAuthor}
                    description={description}
                    setDescription={setDescription}
                    resolution={resolution}
                    setResolution={setResolution}
                    visibility={visibility}
                    setVisibility={setVisibility}
                    screenshots={screenshots}
                    addScreenshots={addScreenshots}
                    renameScreenshot={renameScreenshot}
                    removeScreenshot={removeScreenshot}
                    coverShot={coverShot}
                    setCoverShot={setCoverShot}
                    error={error}
                    duplicate={duplicate}
                    progress={progress}
                    onPublish={() => void publish()}
                    onRepick={() => setStep("pick")}
                    onDismiss={handleDismiss}
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
  reading,
  fileInputRef,
  onFiles,
}: {
  dragActive: boolean;
  setDragActive: (active: boolean) => void;
  error: string | null;
  reading: { name: string; percent: number | null } | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => Promise<void>;
}) {
  const busy = reading !== null;
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (!busy) void onFiles(event.dataTransfer.files);
        }}
        className={`relative block w-full overflow-hidden rounded-xl border transition-colors ${
          busy
            ? "border-osu-b3/60 bg-osu-b4 cursor-default"
            : dragActive
              ? "border-osu-pink/70 bg-osu-b5 cursor-pointer"
              : "border-osu-b3/60 bg-osu-b4 cursor-pointer hover:border-osu-pink/45"
        }`}
      >
        <DropTriangles active={dragActive} />
        <div className="relative z-10 flex min-h-[240px] flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
          {reading ? (
            <div className="w-full max-w-[340px]">
              <div className="truncate text-sm font-semibold text-white">Reading {reading.name}</div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-osu-b5">
                <div
                  className="h-full bg-osu-pink transition-[width] duration-100"
                  style={{ width: `${reading.percent ?? 2}%` }}
                />
              </div>
              <div className="mt-1.5 text-[11px] tabular-nums text-osu-f1">
                {reading.percent == null ? "Opening the archive..." : `Decoding the skin's images, ${reading.percent}%`}
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}
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

// The publish confirmation. It shows the real browse card rather than a bare
// preview: what lands here is exactly what everyone else sees on /skins, which
// is the thing an uploader wants to check before walking away.
function DoneStep({
  published,
  onUploadAnother,
  onDismiss,
}: {
  published: SkinSummary;
  onUploadAnother: () => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const isPrivate = published.visibility === "private";
  const path = `/skins/${published.slug ?? published.id}`;
  // Absolute, because the point of the button is pasting it somewhere else.
  const shareUrl = typeof window === "undefined" ? path : `${window.location.origin}${path}`;

  useEffect(() => () => {
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions, insecure context): the url is printed
      // under the card, so it can still be copied by hand.
    }
  }, [shareUrl]);

  const previewCount = published.previews.length || (published.previewUrl ? 1 : 0);
  const facts = [
    published.keymodes.length > 0 ? `${published.keymodes.map((keys) => `${keys}K`).join(", ")}` : null,
    previewCount > 0 ? `${previewCount} preview${previewCount === 1 ? "" : "s"}` : null,
    published.oskSizeBytes ? formatSkinFileSize(published.oskSizeBytes) : null,
    published.screenshots.length > 0
      ? `${published.screenshots.length} screenshot${published.screenshots.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <div className="flex flex-col items-center gap-1">
        <span className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.1em] text-osu-green">
          <Check size={13} aria-hidden="true" />
          {isPrivate ? "saved" : "published"}
        </span>
        <h3 className="text-[17px] font-bold leading-tight text-white">
          {published.name} is {isPrivate ? "yours" : "live"}
        </h3>
        <p className="text-[12px] text-osu-f1">
          {isPrivate
            ? "Nobody else can open it. Set it as your replay skin and it plays in your replays."
            : "This is how it looks on the skins page."}
        </p>
      </div>

      <div className="w-full max-w-[340px] text-left">
        <SkinCard skin={published} onClick={onDismiss} />
      </div>

      {facts.length > 0 && (
        <p className="max-w-[420px] text-[11.5px] text-osu-f1">{facts.join(" · ")}</p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Link
          to="/skins/$id"
          params={{ id: published.slug ?? published.id }}
          onClick={onDismiss}
          className="rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition hover:brightness-110"
        >
          View the skin page
        </Link>
        {/* A private skin's link 404s for whoever it is sent to, so there is
            nothing here worth copying. */}
        {!isPrivate && (
          <button
            type="button"
            onClick={() => void copyLink()}
            className="flex items-center gap-1.5 rounded-full border border-osu-b3/40 px-4 py-2 text-[12.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:border-osu-f1/40 hover:text-osu-l1"
          >
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? "Link copied" : "Copy link"}
          </button>
        )}
        <button
          type="button"
          onClick={onUploadAnother}
          className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
        >
          Upload another
        </button>
      </div>

      {!isPrivate && <code className="max-w-full truncate text-[10.5px] text-osu-f1/60">{shareUrl}</code>}
    </div>
  );
}

function FormStep({
  imported,
  file,
  uploading,
  previews,
  previewBusy,
  backdrop,
  pickBackdrop,
  backdropScope,
  setBackdropScope,
  overriddenKeymodes,
  backdropPool,
  patternPool,
  pattern,
  pickPattern,
  assetGroups,
  resolveAssetUrl,
  selectedKeymode,
  setSelectedKeymode,
  coverKeymode,
  setCoverKeymode,
  name,
  setName,
  author,
  setAuthor,
  description,
  setDescription,
  resolution,
  setResolution,
  visibility,
  setVisibility,
  screenshots,
  addScreenshots,
  renameScreenshot,
  removeScreenshot,
  coverShot,
  setCoverShot,
  error,
  duplicate,
  progress,
  onPublish,
  onRepick,
  onDismiss,
}: {
  imported: ReplaySkinImportResult | null;
  file: File | null;
  uploading: boolean;
  previews: Map<number, RenderedPreview>;
  previewBusy: boolean;
  // The backdrop behind the keymode on screen, which is what the picker marks
  // as selected; other keymodes can be on a different one.
  backdrop: PreviewBackdrop;
  pickBackdrop: (backdrop: PreviewBackdrop) => void;
  backdropScope: BackdropScope;
  setBackdropScope: (scope: BackdropScope) => void;
  overriddenKeymodes: Map<number, PreviewBackdrop>;
  backdropPool: SkinBackdropRowPool;
  patternPool: SkinPatternPool;
  // The chart the keymode on screen renders its notes from; null is the
  // built-in layout.
  pattern: SkinPreviewChartSnippet | null;
  pickPattern: (pattern: SkinPreviewChartSnippet | null) => void;
  assetGroups: SkinAssetGroup[] | null;
  resolveAssetUrl: (path: string) => Promise<string | null>;
  selectedKeymode: number;
  setSelectedKeymode: (keys: number) => void;
  coverKeymode: number;
  setCoverKeymode: (keys: number) => void;
  name: string;
  setName: (name: string) => void;
  author: string;
  setAuthor: (author: string) => void;
  description: string;
  setDescription: (description: string) => void;
  resolution: string;
  setResolution: (resolution: string) => void;
  visibility: SkinVisibility;
  setVisibility: (visibility: SkinVisibility) => void;
  screenshots: DraftScreenshot[];
  addScreenshots: (files: FileList | null) => Promise<void>;
  renameScreenshot: (index: number, label: string) => void;
  removeScreenshot: (index: number) => void;
  // The screenshot that fronts the browse card, when the uploader picked one
  // over the rendered playfields.
  coverShot: number | null;
  setCoverShot: (index: number | null) => void;
  error: string | null;
  // The already-published skin behind a duplicate error, linked from it.
  duplicate: DuplicateSkinRef | null;
  progress: { done: number; total: number; label: string };
  onPublish: () => void;
  onRepick: () => void;
  onDismiss: () => void;
}) {
  const keymodes = imported?.summary.keymodes ?? [];
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const heroPreview = previews.get(selectedKeymode);
  // Publishing needs the cover's render, which is not always the one on screen.
  const coverPreview = previews.get(coverKeymode);
  // Keymodes whose [Mania] block resolved no note images render with flat
  // colour fallbacks; flag them so a broken block is obvious before publish.
  const keymodesWithoutNoteArt = useMemo(() => {
    if (!imported) return new Set<number>();
    const missing = new Set<number>();
    for (const keys of imported.summary.keymodes) {
      const profile = imported.settings.keymodeProfiles[String(keys)];
      const hasNoteArt = profile?.assets.columns.some((column) => column.tap || column.lnHead || column.lnBody);
      if (!hasNoteArt) missing.add(keys);
    }
    return missing;
  }, [imported]);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <div className="relative overflow-hidden rounded-xl border border-osu-b3/30 bg-osu-b4">
          <div className="aspect-video w-full">
            {heroPreview ? (
              <img src={heroPreview.url} alt={`${selectedKeymode}K preview`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-osu-f1">Rendering the {selectedKeymode}K playfield...</div>
            )}
          </div>
          {/* The previews on screen stay put while a new backdrop decodes, so
              the wait needs saying out loud instead of showing as a flash. */}
          {heroPreview && previewBusy && (
            <div className="pointer-events-none absolute right-2 top-2 rounded bg-osu-b5/85 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2">
              updating
            </div>
          )}
        </div>
        {/* Which keymode fronts the browse card is its own choice: clicking
            through the previews only changes what is on screen. A starred
            screenshot outranks all of them, so the star moves down there. */}
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
          <span className="text-osu-f1">Viewing <span className="font-bold text-osu-l2 tabular-nums">{selectedKeymode}K</span></span>
          {selectedKeymode === coverKeymode && coverShot == null ? (
            <span className="flex items-center gap-1 font-bold text-osu-pink">
              <Star size={11} aria-hidden="true" />
              card cover
            </span>
          ) : (
            <button
              type="button"
              disabled={uploading}
              onClick={() => setCoverKeymode(selectedKeymode)}
              className="flex items-center gap-1 font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1 disabled:cursor-default"
            >
              <Star size={11} aria-hidden="true" />
              Use {selectedKeymode}K as the card cover
            </button>
          )}
        </div>
        {/* Every keymode read from the skin, rendered with the skin's own
            notes; the starred one is what the browse card shows. */}
        <div className="mt-2 flex flex-wrap items-start gap-2">
          {keymodes.map((keys) => {
            const preview = previews.get(keys);
            const selected = selectedKeymode === keys;
            const isCover = coverKeymode === keys && coverShot == null;
            const missingNoteArt = keymodesWithoutNoteArt.has(keys);
            return (
              <button
                key={keys}
                type="button"
                disabled={uploading}
                onClick={() => setSelectedKeymode(keys)}
                aria-pressed={selected}
                title={missingNoteArt ? `The ${keys}K block resolves no note images; the preview shows flat colours.` : undefined}
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
                <div className={`flex items-center gap-1 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${selected ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"}`}>
                  {keys}K
                  {isCover && <Star size={9} className={selected ? "text-white" : "text-osu-pink"} aria-label="card cover" />}
                  {/* Its backdrop was set on its own, so an "all keymodes"
                      pick is what puts it back with the rest. */}
                  {overriddenKeymodes.has(keys) && (
                    <span className={selected ? "text-white/80" : "text-osu-f1/70"} title="Has its own backdrop" aria-hidden="true">*</span>
                  )}
                  {missingNoteArt && <span className={selected ? "text-white/80" : "text-osu-yellow"} aria-hidden="true">!</span>}
                </div>
              </button>
            );
          })}
        </div>
        {keymodesWithoutNoteArt.has(selectedKeymode) && (
          <p className="mt-2 text-[11px] font-semibold text-osu-yellow">
            The {selectedKeymode}K block resolves no note images, so this preview uses flat colours.
          </p>
        )}

        {/* The backdrop behind the field, and the notes on it: a pattern is cut
            from a real chart of this keymode, and each keymode is dealt its
            own so the previews of one upload are not the same frame three
            times. */}
        <SkinPreviewPickers
          disabled={uploading || previewBusy}
          backdrop={{
            pool: backdropPool,
            selected: backdrop,
            onPick: pickBackdrop,
            scope: backdropScope,
            onScopeChange: setBackdropScope,
            keymodeLabel: `${selectedKeymode}K`,
            hint: overriddenKeymodes.size > 0 ? (
              <span className="text-[10px] text-osu-f1/55">
                {[...overriddenKeymodes.keys()].sort((a, b) => a - b).map((keys) => `${keys}K`).join(", ")} on their own
              </span>
            ) : null,
          }}
          pattern={{ pool: patternPool, selected: pattern, onPick: pickPattern }}
        />

        {assetGroups && assetGroups.length > 0 && (
          <DetectedAssets groups={assetGroups} resolve={resolveAssetUrl} />
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
            Made by <span className="normal-case tracking-normal text-osu-f1/70">(from skin.ini, credited on the card)</span>
          </span>
          <input
            type="text"
            value={author}
            maxLength={SKIN_AUTHOR_MAX_LENGTH}
            disabled={uploading}
            onChange={(event) => setAuthor(event.target.value)}
            placeholder="The skin's original creator"
            className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13.5px] text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
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
            placeholder="A line about the skin"
            className="w-full resize-y rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] leading-relaxed text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
            Made for <span className="normal-case tracking-normal text-osu-f1/70">(resolution, optional)</span>
          </span>
          <input
            type="text"
            value={resolution}
            maxLength={12}
            disabled={uploading}
            list="skin-resolution-presets"
            onChange={(event) => setResolution(event.target.value)}
            placeholder="1920x1080"
            className={`w-full rounded-lg border bg-osu-b4 px-3 py-2 text-[13.5px] text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:outline-none ${
              resolution.trim() && !normalizeSkinResolution(resolution)
                ? "border-osu-red-light/60 focus:border-osu-red-light/60"
                : "border-osu-b3/30 focus:border-osu-pink/50"
            }`}
          />
          <datalist id="skin-resolution-presets">
            {SKIN_RESOLUTION_PRESETS.map((preset) => (
              <option key={preset} value={preset} />
            ))}
          </datalist>
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Visibility</span>
          <div className="flex gap-2">
            {VISIBILITY_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                disabled={uploading}
                onClick={() => setVisibility(choice.value)}
                aria-pressed={visibility === choice.value}
                className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer disabled:opacity-50 ${
                  visibility === choice.value
                    ? "border-osu-pink/55 bg-osu-pink/10"
                    : "border-osu-b3/30 bg-osu-b4 hover:border-osu-f1/40"
                }`}
              >
                <span className={`block text-[12.5px] font-bold ${visibility === choice.value ? "text-white" : "text-osu-l2"}`}>
                  {choice.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-osu-f1">{choice.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <SkinScreenshotFields
          screenshots={screenshots}
          onAdd={(files) => void addScreenshots(files)}
          onRename={renameScreenshot}
          onRemove={removeScreenshot}
          cover={coverShot}
          onCover={setCoverShot}
          disabled={uploading}
        />

        <div className="mt-auto flex flex-col gap-2.5 pt-1">
          {error && (
            <div className="text-[12px] font-semibold text-osu-red-light">
              {error}
              {duplicate && (
                <>
                  {" "}
                  <Link
                    to="/skins/$id"
                    params={{ id: duplicate.slug ?? duplicate.id }}
                    onClick={onDismiss}
                    className="underline underline-offset-2 hover:text-osu-l1"
                  >
                    {duplicate.name || "View it"}
                  </Link>
                  {duplicate.ownerUsername ? ` (uploaded by ${duplicate.ownerUsername})` : ""}
                </>
              )}
            </div>
          )}
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
                disabled={previewBusy || !heroPreview || !coverPreview}
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

// What the archive holds, as one line most uploaders can skip past. Opening it
// lists a chip per group, and a chip expands into the same asset tiles the skin
// page explorer renders, so anyone who wants to can inspect every file before
// publishing.
function DetectedAssets({
  groups,
  resolve,
}: {
  groups: SkinAssetGroup[];
  resolve: (path: string) => Promise<string | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const open = groups.find((group) => group.key === openGroup) ?? null;
  const files = groups.reduce((total, group) => total + group.entries.length, 0);

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => {
          setExpanded(!expanded);
          setOpenGroup(null);
        }}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 self-start text-osu-f1/55 transition-colors cursor-pointer hover:text-osu-l2"
      >
        <span className="text-[10px] font-bold uppercase tracking-[0.08em]">Detected in the .osk</span>
        <span className="text-[11px] tabular-nums">
          {files} files in {groups.length} groups
        </span>
        <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="flex flex-wrap gap-1.5" title="Grouped by osu!'s known asset names; click a group to see its files">
          {groups.map((group) => {
            const selected = group.key === openGroup;
            return (
              <button
                key={group.key}
                type="button"
                onClick={() => setOpenGroup(selected ? null : group.key)}
                aria-pressed={selected}
                className={`rounded px-2 py-0.5 text-[11px] transition-colors cursor-pointer ${
                  selected ? "bg-osu-pink text-white" : "bg-osu-b5 text-osu-l2 hover:text-white"
                }`}
              >
                {group.title.toLowerCase()}{" "}
                <span className={`font-bold tabular-nums ${selected ? "text-white" : "text-osu-l1"}`}>{group.entries.length}</span>
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <SkinAssetTiles
          entries={open.entries}
          resolve={resolve}
          className="mt-1 flex max-h-[240px] flex-wrap gap-2 overflow-y-auto rounded-lg border border-osu-b3/30 bg-osu-b5/40 p-2.5"
        />
      )}
    </div>
  );
}

function startErrorMessage(code: "not_logged_in" | "unavailable" | "storage_not_configured" | "invalid_name" | "pending_limit" | "skin_limit" | "duplicate"): string {
  switch (code) {
    case "not_logged_in":
      return "The session expired. Log in with osu! again to publish.";
    case "duplicate":
      return "This exact .osk is already published on the site.";
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
