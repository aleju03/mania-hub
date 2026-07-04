import { useCallback, useEffect, useRef, useState } from "react";

// Per-card map preview playback (b.ppy.sh set previews) for the search grid:
// a single shared <audio> element so starting one card stops the previous one.
// Old sets have no preview file; a 404 marks the set unavailable so the button
// flips to a "no preview" state instead of retrying.

const PREVIEW_VOLUME_STORAGE_KEY = "mania-hub-preview-volume-v1";
const DEFAULT_PREVIEW_VOLUME = 0.3;

function previewAudioUrl(beatmapsetId: number): string {
  return `https://b.ppy.sh/preview/${beatmapsetId}.mp3`;
}

// Same key the chart preview panel persists. A stored mute still plays at the
// default volume here: tapping play on a card means "let me hear it", and this
// surface has no volume control to undo a silent start.
function readPreviewVolume(): number {
  if (typeof window === "undefined") return DEFAULT_PREVIEW_VOLUME;
  try {
    const parsed = Number.parseFloat(window.localStorage.getItem(PREVIEW_VOLUME_STORAGE_KEY) ?? "");
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PREVIEW_VOLUME;
    return Math.min(1, parsed);
  } catch {
    return DEFAULT_PREVIEW_VOLUME;
  }
}

export interface MapPreviewAudio {
  playingSetId: number | null;
  loadingSetId: number | null;
  isUnavailable: (beatmapsetId: number) => boolean;
  toggle: (beatmapsetId: number) => void;
  stop: () => void;
  getAudio: () => HTMLAudioElement | null;
}

export function useMapPreviewAudio(): MapPreviewAudio {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeSetIdRef = useRef<number | null>(null);
  const [playingSetId, setPlayingSetId] = useState<number | null>(null);
  const [loadingSetId, setLoadingSetId] = useState<number | null>(null);
  const [unavailableIds, setUnavailableIds] = useState<ReadonlySet<number>>(() => new Set());

  const stop = useCallback(() => {
    activeSetIdRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setPlayingSetId(null);
    setLoadingSetId(null);
  }, []);

  const markUnavailable = useCallback(
    (beatmapsetId: number) => {
      setUnavailableIds((prev) => {
        if (prev.has(beatmapsetId)) return prev;
        const next = new Set(prev);
        next.add(beatmapsetId);
        return next;
      });
      stop();
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  const toggle = useCallback(
    (beatmapsetId: number) => {
      if (activeSetIdRef.current === beatmapsetId) {
        stop();
        return;
      }
      let audio = audioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        audio.addEventListener("playing", () => {
          const active = activeSetIdRef.current;
          if (active == null) return;
          setLoadingSetId(null);
          setPlayingSetId(active);
        });
        audio.addEventListener("ended", () => stop());
        audio.addEventListener("error", () => {
          const active = activeSetIdRef.current;
          if (active != null) markUnavailable(active);
        });
        audioRef.current = audio;
      }
      activeSetIdRef.current = beatmapsetId;
      setPlayingSetId(null);
      setLoadingSetId(beatmapsetId);
      audio.volume = readPreviewVolume();
      audio.src = previewAudioUrl(beatmapsetId);
      audio.play().catch(() => {
        // A rejection for a request we've since replaced or cancelled is just
        // the interrupted load, not a missing preview.
        if (activeSetIdRef.current !== beatmapsetId) return;
        markUnavailable(beatmapsetId);
      });
    },
    [markUnavailable, stop],
  );

  const isUnavailable = useCallback((beatmapsetId: number) => unavailableIds.has(beatmapsetId), [unavailableIds]);
  const getAudio = useCallback(() => audioRef.current, []);

  return { playingSetId, loadingSetId, isUnavailable, toggle, stop, getAudio };
}

export function MapPreviewButton({ beatmapsetId, preview }: { beatmapsetId: number; preview: MapPreviewAudio }) {
  const playing = preview.playingSetId === beatmapsetId;
  const loading = preview.loadingSetId === beatmapsetId;

  // Not a disabled <button>: a plain badge keeps the tooltip reliable and lets
  // the click fall through to the card like the rest of it.
  if (preview.isUnavailable(beatmapsetId)) {
    return (
      <span
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-osu-b3/30 text-osu-f1/40"
        title="No preview audio"
        aria-label="No preview audio"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4V5Z" />
          <path d="m16 9 5 6M21 9l-5 6" />
        </svg>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        preview.toggle(beatmapsetId);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      aria-label={playing ? "Pause preview" : "Play preview"}
      aria-pressed={playing}
      title={playing ? "Pause preview" : "Play preview"}
      className={`grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-full transition-colors ${
        playing || loading
          ? "bg-osu-pink/25 text-osu-pink-light hover:bg-osu-pink/35"
          : "bg-osu-b3/50 text-osu-l2 hover:bg-osu-b3 hover:text-white"
      }`}
    >
      {loading ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="h-3 w-3 animate-spin" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
      ) : playing ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
          <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3 translate-x-[1px]" aria-hidden="true">
          <path d="M8 5.14v13.72L19 12 8 5.14Z" />
        </svg>
      )}
    </button>
  );
}

// Thin bar along the bottom edge of the cover while this card's set is
// playing. Width is driven straight on the DOM node from a rAF loop, so only
// this component works per frame, not the whole grid.
export function MapPreviewProgressBar({ preview }: { preview: MapPreviewAudio }) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  const { getAudio } = preview;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const audio = getAudio();
      const fill = fillRef.current;
      if (audio && fill) {
        const duration = audio.duration;
        const ratio = Number.isFinite(duration) && duration > 0 ? Math.min(1, audio.currentTime / duration) : 0;
        fill.style.width = `${ratio * 100}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getAudio]);

  return (
    <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/45" aria-hidden="true">
      <div ref={fillRef} className="h-full bg-osu-pink-light" style={{ width: "0%" }} />
    </div>
  );
}
