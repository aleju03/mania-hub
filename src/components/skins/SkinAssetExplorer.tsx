import JSZip from "jszip";
import { ChevronDown, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const oskUrl = skinOskFileUrl(skin);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

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
    } catch {
      setState({ phase: "error" });
    }
  }, [oskUrl]);

  if (!oskUrl) return null;

  return (
    <section className="mt-4 rounded-xl border border-osu-b3/20 bg-osu-b4">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Inside the .osk</h2>
        {state.phase === "idle" && (
          <button
            type="button"
            onClick={() => void load()}
            className="ml-auto rounded-full border border-osu-b3/60 px-3.5 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-white"
          >
            Open the archive
            {skin.oskSizeBytes ? <span className="ml-1.5 text-osu-f1 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span> : null}
          </button>
        )}
        {state.phase === "loading" && <span className="ml-auto text-[12px] text-osu-f1">Reading the archive...</span>}
        {state.phase === "error" && (
          <span className="ml-auto flex items-center gap-2 text-[12px]">
            <span className="font-semibold text-osu-red-light">The archive could not be read.</span>
            <button type="button" onClick={() => void load()} className="font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1">
              Retry
            </button>
          </span>
        )}
      </div>
      {state.phase === "ready" && (
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
          <div className="flex flex-wrap gap-2">
            {group.entries.map((entry) => (
              <SkinAssetTile key={entry.primaryPath} entry={entry} resolve={resolve} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One asset as a thumbnail (or a play chip for sounds); also used by the
// upload modal's "Detected in the .osk" expansion.
export function SkinAssetTile({ entry, resolve }: { entry: SkinAssetEntry; resolve: (path: string) => Promise<string | null> }) {
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
    <figure className="w-[96px]" title={caption + (entry.frameCount > 1 ? ` - ${entry.frameCount} frames` : "")}>
      <div className="relative grid h-[72px] place-items-center overflow-hidden rounded-md border border-osu-b3/40 bg-osu-b5">
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
