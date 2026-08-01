import JSZip from "jszip";
import { ChevronDown, ChevronLeft, ChevronRight, FolderOpen, ImageIcon, Loader2, Music, Pause, Play, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildSkinAssetGroups,
  extractSkinIniStageReferences,
  type SkinAssetEntry,
  type SkinAssetGroup,
  type SkinIniStageReference,
} from "../../lib/skin-asset-explorer";
import { formatSkinFileSize, skinOskFileUrl, type SkinSummary } from "../../lib/skins";

// "Inside the .osk": fetches the archive on demand (CORS-safe stream, not the
// counted download), lists every recognizable asset by osu!'s file names, and
// extracts thumbnails lazily per opened group so a 50 MB skin never decodes
// hundreds of images up front.

type ExplorerState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; zip: JSZip; groups: SkinAssetGroup[]; stageRefs: SkinIniStageReference[] };

const GROUP_HINTS: Record<string, string> = {
  notes: "mania-note art not tied to a keymode block",
  keys: "receptor art",
  stage: "mania-stage left / right / bottom / hint pieces",
  judgements: "hit result art",
  gameplay: "pause overlay, fail and section screens, countdown",
  hud: "score, combo and ranking fonts, health bar",
  lighting: "hit and hold lighting",
  other: "everything else the archive ships",
  sounds: "hitsounds and interface samples",
};

export function SkinAssetExplorer({ skin }: { skin: SkinSummary }) {
  const [state, setState] = useState<ExplorerState>({ phase: "idle" });
  // Collapsing keeps the parsed archive around, so reopening is instant.
  const [open, setOpen] = useState(false);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const oskUrl = skinOskFileUrl(skin);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // The uploader just shipped a newer build: what is parsed here belongs to
  // the file that is gone, so the strip closes back up and reads the new one
  // on the next click.
  useEffect(() => {
    setState({ phase: "idle" });
    setOpen(false);
    const urls = objectUrlsRef.current;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  }, [oskUrl]);

  // One object URL per zip path, shared by thumbs and the sound player;
  // everything gets revoked together when the page unmounts.
  const resolveObjectUrl = useCallback(async (zip: JSZip, path: string): Promise<string | null> => {
    const existing = objectUrlsRef.current.get(path);
    if (existing) return existing;
    const file = zip.file(path);
    if (!file) return null;
    try {
      const blob = await file.async("blob");
      const url = URL.createObjectURL(blob);
      const raced = objectUrlsRef.current.get(path);
      if (raced) {
        URL.revokeObjectURL(url);
        return raced;
      }
      objectUrlsRef.current.set(path, url);
      return url;
    } catch {
      return null;
    }
  }, []);

  const load = useCallback(async () => {
    if (!oskUrl) return;
    setState({ phase: "loading" });
    try {
      const response = await fetch(oskUrl, { credentials: "omit" });
      if (!response.ok) throw new Error(`Server ${response.status}`);
      const zip = await JSZip.loadAsync(await response.arrayBuffer());
      const files = Object.values(zip.files)
        .filter((file) => !file.dir)
        .map((file) => ({
          path: file.name,
          // jszip does not expose sizes pre-extraction on all sources; the
          // compressed size from the central directory is close enough for
          // the "is there anything here" filter.
          size: (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 1,
        }));
      const groups = buildSkinAssetGroups(files);
      const iniFile = zip.file(/(^|\/)skin\.ini$/i)[0];
      const ini = iniFile ? await iniFile.async("string").catch(() => "") : "";
      setState({ phase: "ready", zip, groups, stageRefs: ini ? extractSkinIniStageReferences(ini) : [] });
      setOpen(true);
    } catch {
      setState({ phase: "error" });
    }
  }, [oskUrl]);

  // What the archive turned out to hold, for the header line once it is open.
  const counts = useMemo(() => {
    if (state.phase !== "ready") return null;
    let images = 0;
    let sounds = 0;
    for (const group of state.groups) {
      for (const entry of group.entries) {
        if (entry.kind === "sound") sounds += 1;
        else images += 1;
      }
    }
    return { images, sounds };
  }, [state]);

  if (!oskUrl) return null;

  const loading = state.phase === "loading";
  const ready = state.phase === "ready";

  return (
    // One clickable strip that opens the archive and then toggles it, rather
    // than a header with a lone button floating at the far end of an empty row.
    <section className="mt-4 overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      <button
        type="button"
        disabled={loading}
        onClick={() => (ready ? setOpen((previous) => !previous) : void load())}
        aria-expanded={ready && open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer hover:bg-osu-b3/25 disabled:cursor-default"
      >
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors ${
          ready ? "bg-osu-pink/15 text-osu-pink-light" : "bg-osu-b5 text-osu-f1"
        }`}>
          {loading
            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <FolderOpen className="h-4 w-4" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold leading-tight text-white">Inside the .osk</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-osu-f1">
            {state.phase === "error" ? (
              <span className="font-semibold text-osu-red-light">The archive could not be read. Tap to try again.</span>
            ) : loading ? (
              <span>Reading the archive...</span>
            ) : counts ? (
              <>
                <span className="flex items-center gap-1">
                  <ImageIcon className="h-3 w-3" aria-hidden="true" />
                  <span className="tabular-nums">{counts.images}</span> images
                </span>
                <span className="flex items-center gap-1">
                  <Music className="h-3 w-3" aria-hidden="true" />
                  <span className="tabular-nums">{counts.sounds}</span> sounds
                </span>
              </>
            ) : (
              <span>Browse every image and sound this skin ships, without downloading it.</span>
            )}
          </span>
        </span>
        {skin.oskSizeBytes ? (
          <span className="shrink-0 text-[11.5px] text-osu-f1 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span>
        ) : null}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-osu-f1 transition-transform ${ready && open ? "" : "-rotate-90"}`}
          aria-hidden="true"
        />
      </button>
      {ready && open && (
        <div className="border-t border-osu-b3/25 px-4 pb-3">
          {state.groups.length === 0 ? (
            <p className="py-3 text-[12px] text-osu-f1">No images or sounds were found in the archive.</p>
          ) : (
            state.groups.map((group) => (
              <AssetGroupSection
                key={group.key}
                group={group}
                stageRefs={group.key === "stage" ? state.stageRefs : []}
                resolve={(path) => resolveObjectUrl(state.zip, path)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function AssetGroupSection({
  group,
  stageRefs,
  resolve,
}: {
  group: SkinAssetGroup;
  stageRefs: SkinIniStageReference[];
  resolve: (path: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const hint = GROUP_HINTS[group.key];

  return (
    <div className="border-b border-osu-b3/25 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-2.5 text-left cursor-pointer"
      >
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-osu-f1 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
        <span className="text-[13px] font-bold text-white">{group.title}</span>
        <span className="text-[12px] tabular-nums text-osu-f1">{group.entries.length}</span>
        {hint && <span className="ml-auto hidden text-[11px] text-osu-f1/70 sm:block">{hint}</span>}
      </button>
      {open && (
        <div className="pb-3">
          {stageRefs.length > 0 && (
            <p className="mb-2 text-[11.5px] text-osu-f1">
              skin.ini references:{" "}
              {stageRefs.map((ref, index) => (
                <span key={`${ref.property}-${index}`}>
                  {index > 0 && ", "}
                  <span className="font-semibold text-osu-l2">{ref.property}</span>
                  {ref.keys ? ` (${ref.keys}K)` : ""} → {ref.reference}
                </span>
              ))}
            </p>
          )}
          <SkinAssetTiles entries={group.entries} resolve={resolve} className="flex flex-wrap gap-2" />
        </div>
      )}
    </div>
  );
}

// A grid of asset tiles wired to the full-size viewer: clicking an image opens
// it big, and the viewer walks the rest of the grid from there. Sounds stay
// click-to-play. Shared by the skin page's explorer and the upload modal's
// "Detected in the .osk" expansion so both browse the same way.
export function SkinAssetTiles({
  entries,
  resolve,
  className,
}: {
  entries: SkinAssetEntry[];
  resolve: (path: string) => Promise<string | null>;
  className: string;
}) {
  const images = useMemo(() => entries.filter((entry) => entry.kind !== "sound"), [entries]);
  const [viewing, setViewing] = useState<number | null>(null);

  return (
    <>
      <div className={className}>
        {entries.map((entry) => (
          <SkinAssetTile
            key={entry.primaryPath}
            entry={entry}
            resolve={resolve}
            onOpen={entry.kind === "sound" ? undefined : () => setViewing(images.indexOf(entry))}
          />
        ))}
      </div>
      {viewing != null && images[viewing] && (
        <SkinAssetViewer
          entries={images}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          resolve={resolve}
        />
      )}
    </>
  );
}

type ViewerSurface = "checker" | "dark" | "light";

const SURFACE_STYLES: Record<ViewerSurface, React.CSSProperties> = {
  // Skin art is mostly transparent PNGs, and plenty of it is white-on-nothing
  // (stage light, hit lighting) or black-on-nothing. The checker reads both,
  // and the two flat surfaces are there to judge the art against what it
  // actually sits on in game.
  checker: {
    backgroundImage: "repeating-conic-gradient(#2b2530 0% 25%, #1a161f 0% 50%)",
    backgroundSize: "20px 20px",
  },
  dark: { backgroundColor: "#0f0c13" },
  light: { backgroundColor: "#e9e6ee" },
};

const FRAME_INTERVAL_MS = 90;

// Full-size look at one asset, with its frames if it animates. Rendered in a
// portal so it sits above the upload modal that may have opened it.
function SkinAssetViewer({
  entries,
  index,
  onIndex,
  onClose,
  resolve,
}: {
  entries: SkinAssetEntry[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  resolve: (path: string) => Promise<string | null>;
}) {
  const entry = entries[index];
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [surface, setSurface] = useState<ViewerSurface>("checker");
  const [actualSize, setActualSize] = useState(false);

  // Frames in the order they animate; a still asset is just its own path.
  const framePaths = useMemo(() => sortedFramePaths(entry), [entry]);
  const path = framePaths[Math.min(frame, framePaths.length - 1)] ?? entry.primaryPath;

  useEffect(() => {
    setFrame(0);
    setPlaying(false);
  }, [entry.primaryPath]);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void resolve(path).then((resolved) => {
      if (cancelled) return;
      if (resolved) setUrl(resolved);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [path, resolve]);

  useEffect(() => {
    if (!playing || framePaths.length < 2) return;
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % framePaths.length), FRAME_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, framePaths.length]);

  // Captured on document so the escape never reaches the upload modal behind
  // this one, which would close both at once.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowRight" && index < entries.length - 1) {
        event.stopPropagation();
        onIndex(index + 1);
      }
      if (event.key === "ArrowLeft" && index > 0) {
        event.stopPropagation();
        onIndex(index - 1);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [entries.length, index, onClose, onIndex]);

  if (typeof document === "undefined") return null;

  const caption = entry.frameCount > 1 ? `${entry.name} · ${entry.frameCount} frames` : entry.name;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${entry.name} preview`}
    >
      <div
        className="flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-bold text-white">{caption}</div>
            <div className="truncate text-[10.5px] text-osu-f1">{path}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto shrink-0 rounded p-1 text-osu-f1 transition-colors cursor-pointer hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="relative grid min-h-[240px] flex-1 place-items-center overflow-auto" style={SURFACE_STYLES[surface]}>
          {url && !failed ? (
            <img
              src={url}
              alt={entry.name}
              onLoad={(event) => setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
              onError={() => setFailed(true)}
              className={actualSize ? "max-w-none" : "max-h-[58vh] max-w-full object-contain"}
              style={actualSize && natural ? { width: natural.width, height: natural.height } : undefined}
            />
          ) : (
            <span className="text-[12px] text-osu-f1">{failed ? "This file could not be decoded." : "Loading..."}</span>
          )}
          {entries.length > 1 && (
            <>
              <ViewerArrow side="left" disabled={index === 0} onClick={() => onIndex(index - 1)} />
              <ViewerArrow side="right" disabled={index === entries.length - 1} onClick={() => onIndex(index + 1)} />
            </>
          )}
        </div>

        {framePaths.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto border-t border-osu-b3/40 px-3 py-2">
            <button
              type="button"
              onClick={() => setPlaying((previous) => !previous)}
              className="flex shrink-0 items-center gap-1 rounded border border-osu-b3/60 px-1.5 py-0.5 text-[10.5px] font-bold text-osu-l2 transition-colors cursor-pointer hover:text-white"
            >
              {playing ? <Pause size={10} aria-hidden="true" /> : <Play size={10} aria-hidden="true" />}
              {playing ? "pause" : "play"}
            </button>
            {framePaths.map((framePath, frameIndex) => (
              <button
                key={framePath}
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setFrame(frameIndex);
                }}
                aria-pressed={frameIndex === frame}
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums transition-colors cursor-pointer ${
                  frameIndex === frame ? "bg-osu-pink text-white" : "bg-osu-b5 text-osu-l2 hover:text-white"
                }`}
              >
                {frameIndex}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-osu-b3/40 px-4 py-2 text-[11px] text-osu-f1">
          <span className="tabular-nums">
            {natural ? `${natural.width} × ${natural.height}` : "—"}
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{formatSkinFileSize(entry.totalBytes)}</span>
          {entries.length > 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{index + 1} of {entries.length}</span>
            </>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setActualSize((previous) => !previous)}
              aria-pressed={actualSize}
              title={actualSize ? "Scale the image to fit" : "Show the image at its real pixel size"}
              className={`rounded border px-1.5 py-0.5 text-[10.5px] font-bold transition-colors cursor-pointer ${
                actualSize ? "border-osu-pink text-white" : "border-osu-b3/60 text-osu-l2 hover:text-white"
              }`}
            >
              1:1
            </button>
            <div className="flex overflow-hidden rounded border border-osu-b3/60">
              {(["checker", "dark", "light"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setSurface(option)}
                  aria-pressed={surface === option}
                  title={`View on a ${option} background`}
                  className={`px-1.5 py-0.5 text-[10.5px] font-bold transition-colors cursor-pointer ${
                    surface === option ? "bg-osu-pink text-white" : "text-osu-l2 hover:text-white"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ViewerArrow({ side, disabled, onClick }: { side: "left" | "right"; disabled: boolean; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "left" ? "Previous asset" : "Next asset"}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white/90 transition-opacity cursor-pointer hover:bg-black/75 disabled:cursor-default disabled:opacity-0 ${
        side === "left" ? "left-2" : "right-2"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

// Animation frames in play order. The entry keeps every path it absorbed,
// which for an animated asset is "name-0", "name-1", ... plus possibly a still
// and @2x copies; the numbered ones drive the animation, and anything without
// a frame index (or a duplicate index) is not part of it.
function sortedFramePaths(entry: SkinAssetEntry): string[] {
  if (entry.frameCount < 2) return [entry.primaryPath];
  const byFrame = new Map<number, string>();
  for (const path of entry.paths) {
    const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "");
    const match = /-(\d{1,3})(@2x)?$/i.exec(base);
    if (!match) continue;
    const frame = Number(match[1]);
    // @2x wins, matching the thumbnail's preference for the bigger art.
    if (!byFrame.has(frame) || match[2]) byFrame.set(frame, path);
  }
  const frames = [...byFrame.entries()].sort(([a], [b]) => a - b).map(([, path]) => path);
  return frames.length > 1 ? frames : [entry.primaryPath];
}

// One asset as a thumbnail (or a play chip for sounds); also used by the
// upload modal's "Detected in the .osk" expansion.
export function SkinAssetTile({
  entry,
  resolve,
  onOpen,
}: {
  entry: SkinAssetEntry;
  resolve: (path: string) => Promise<string | null>;
  onOpen?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isSound = entry.kind === "sound";
  const directory = useMemo(() => {
    const slash = entry.primaryPath.lastIndexOf("/");
    return slash >= 0 ? entry.primaryPath.slice(0, slash) : "";
  }, [entry.primaryPath]);

  useEffect(() => {
    if (isSound) return;
    let cancelled = false;
    void resolve(entry.primaryPath).then((resolved) => {
      if (cancelled) return;
      if (resolved) setUrl(resolved);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [entry.primaryPath, isSound, resolve]);

  const play = useCallback(async () => {
    const resolved = await resolve(entry.primaryPath);
    if (!resolved) return;
    const audio = new Audio(resolved);
    audio.volume = 0.6;
    void audio.play().catch(() => undefined);
  }, [entry.primaryPath, resolve]);

  const caption = directory ? `${directory}/${entry.name}` : entry.name;

  if (isSound) {
    return (
      <button
        type="button"
        onClick={() => void play()}
        title={`${caption} - click to play`}
        className="flex items-center gap-1.5 rounded-md border border-osu-b3/40 bg-osu-b5 px-2.5 py-1.5 text-[11.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-white"
      >
        <Volume2 className="h-3.5 w-3.5 text-osu-f1" aria-hidden="true" />
        {entry.name}
      </button>
    );
  }

  return (
    <figure className="w-[96px]" title={`${caption}${entry.frameCount > 1 ? ` - ${entry.frameCount} frames` : ""}${onOpen ? " - click to view" : ""}`}>
      <div
        // A plain div when nothing can open it, so the skin page keeps working
        // if a caller has no viewer to hand.
        {...(onOpen ? { role: "button", tabIndex: 0, onClick: onOpen, onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        } } : {})}
        className={`relative grid h-[72px] place-items-center overflow-hidden rounded-md border border-osu-b3/40 bg-osu-b5 ${
          onOpen ? "cursor-pointer transition-colors hover:border-osu-pink/45" : ""
        }`}
      >
        {url ? (
          <img src={url} alt={entry.name} loading="lazy" className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-[10px] text-osu-f1/50">{failed ? "unreadable" : "..."}</span>
        )}
        {entry.frameCount > 1 && (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-osu-b5/90 px-1 text-[9.5px] font-bold tabular-nums text-osu-l2">
            ×{entry.frameCount}
          </span>
        )}
      </div>
      <figcaption className="mt-0.5 truncate text-center text-[10.5px] text-osu-f1">{entry.name}</figcaption>
    </figure>
  );
}
