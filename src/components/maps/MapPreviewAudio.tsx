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

// MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED; the constant is not worth reaching
// for a global that does not exist under SSR/jsdom.
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// Only a source the browser could not load at all means "this set has no
// preview". Network drops and decode hiccups are transient, and the
// unavailable mark is permanent for the session, so treating them as missing
// leaves a perfectly fine set crossed out until a reload.
function isMissingSource(audio: HTMLAudioElement): boolean {
  if (audio.error?.code !== MEDIA_ERR_SRC_NOT_SUPPORTED) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  return true;
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
  // Bumped per toggle so a late event from a superseded attempt can be told
  // apart from the current one, even when both are for the same set.
  const attemptRef = useRef(0);
  const detachRef = useRef<(() => void) | null>(null);
  const [playingSetId, setPlayingSetId] = useState<number | null>(null);
  const [loadingSetId, setLoadingSetId] = useState<number | null>(null);
  const [unavailableIds, setUnavailableIds] = useState<ReadonlySet<number>>(() => new Set());

  // Retires the current element for good: its listeners are dropped and its
  // load cancelled, so anything it fires afterwards reaches nobody.
  const teardown = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }, []);

  const stop = useCallback(() => {
    activeSetIdRef.current = null;
    teardown();
    setPlayingSetId(null);
    setLoadingSetId(null);
  }, [teardown]);

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

      // One element per attempt rather than one for the hook: a 404 or an
      // aborted fetch can fire `error` long after we moved to another card,
      // and on a shared element that event is indistinguishable from a failure
      // of the set now loading - which is how a set with a perfectly good
      // preview ended up crossed out. Retiring the element makes the late
      // event land on a dead handler instead. Constructing it inside the click
      // keeps the user gesture that iOS needs to unlock playback.
      teardown();
      const attempt = ++attemptRef.current;
      const element = new Audio();
      element.preload = "auto";
      audioRef.current = element;
      const isCurrent = () => attemptRef.current === attempt && activeSetIdRef.current === beatmapsetId;

      const onPlaying = () => {
        if (!isCurrent()) return;
        setLoadingSetId(null);
        setPlayingSetId(beatmapsetId);
      };
      const onEnded = () => {
        if (isCurrent()) stop();
      };
      const onError = () => {
        if (!isCurrent()) return;
        if (isMissingSource(element)) markUnavailable(beatmapsetId);
        else stop();
      };
      element.addEventListener("playing", onPlaying);
      element.addEventListener("ended", onEnded);
      element.addEventListener("error", onError);
      detachRef.current = () => {
        element.removeEventListener("playing", onPlaying);
        element.removeEventListener("ended", onEnded);
        element.removeEventListener("error", onError);
      };

      activeSetIdRef.current = beatmapsetId;
      setPlayingSetId(null);
      setLoadingSetId(beatmapsetId);
      element.volume = readPreviewVolume();
      element.src = previewAudioUrl(beatmapsetId);
      element.play().catch((err: unknown) => {
        // A rejection for a request we've since replaced or cancelled is just
        // the interrupted load, not a missing preview.
        if (!isCurrent()) return;
        const name = err instanceof Error ? err.name : "";
        // Autoplay blocks (NotAllowedError) and interrupted loads (AbortError)
        // say nothing about whether the file exists; only reset the button.
        if (name === "NotSupportedError") markUnavailable(beatmapsetId);
        else if (name !== "AbortError") stop();
      });
    },
    [markUnavailable, stop, teardown],
  );

  const isUnavailable = useCallback((beatmapsetId: number) => unavailableIds.has(beatmapsetId), [unavailableIds]);
  const getAudio = useCallback(() => audioRef.current, []);

  return { playingSetId, loadingSetId, isUnavailable, toggle, stop, getAudio };
}

// Circumference of the r=12.5 ring in the 28x28 button viewBox.
const RING_RADIUS = 12.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Progress arc around the play button while this set is playing, osu-web
// beatmapset-panel style. Driven straight on the DOM node from a rAF loop so
// only this circle updates per frame.
function PreviewProgressRing({ getAudio }: { getAudio: () => HTMLAudioElement | null }) {
  const arcRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const audio = getAudio();
      const arc = arcRef.current;
      if (audio && arc) {
        const duration = audio.duration;
        const ratio = Number.isFinite(duration) && duration > 0 ? Math.min(1, audio.currentTime / duration) : 0;
        arc.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - ratio)}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getAudio]);

  return (
    <circle
      ref={arcRef}
      cx="14"
      cy="14"
      r={RING_RADIUS}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray={RING_CIRCUMFERENCE}
      strokeDashoffset={RING_CIRCUMFERENCE}
    />
  );
}

export function MapPreviewButton({ beatmapsetId, preview }: { beatmapsetId: number; preview: MapPreviewAudio }) {
  const playing = preview.playingSetId === beatmapsetId;
  const loading = preview.loadingSetId === beatmapsetId;

  // Cached previews start playing within a frame or two, so an instantly
  // rendered loading arc just flashes; only show it once a load has stalled
  // long enough to be worth signalling.
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 200);
    return () => clearTimeout(timer);
  }, [loading]);

  // Not a disabled <button>: a plain badge keeps the tooltip reliable and lets
  // the click fall through to the card like the rest of it.
  if (preview.isUnavailable(beatmapsetId)) {
    return (
      <span
        className="relative grid h-7 w-7 shrink-0 place-items-center text-osu-f1/40"
        title="No preview audio"
        aria-label="No preview audio"
      >
        <svg viewBox="0 0 28 28" fill="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <circle cx="14" cy="14" r={RING_RADIUS} stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
        </svg>
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
      className={`relative grid h-7 w-7 shrink-0 cursor-pointer place-items-center transition-colors ${
        playing || loading ? "text-osu-pink-light" : "text-osu-l2 hover:text-white"
      }`}
    >
      <svg
        viewBox="0 0 28 28"
        fill="none"
        className={`absolute inset-0 h-full w-full -rotate-90 ${showLoading ? "animate-spin" : ""}`}
        aria-hidden="true"
      >
        <circle cx="14" cy="14" r={RING_RADIUS} stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
        {showLoading && (
          <circle
            cx="14"
            cy="14"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${RING_CIRCUMFERENCE * 0.25} ${RING_CIRCUMFERENCE * 0.75}`}
          />
        )}
        {playing && <PreviewProgressRing getAudio={preview.getAudio} />}
      </svg>
      {playing ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
          <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden="true">
          <path d="M8 5.14v13.72L19 12 8 5.14Z" />
        </svg>
      )}
    </button>
  );
}
