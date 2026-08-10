import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import { formatDuration } from "../../lib/format";
import { readReplayVolume, subscribeReplayVolume, writeReplayVolume } from "../../lib/replay-preferences";

// Per-card map preview playback (b.ppy.sh set previews) for the search grid:
// a single shared <audio> element so starting one card stops the previous one.
// Old sets have no preview file; a 404 marks the set unavailable so the button
// flips to a "no preview" state instead of retrying.

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

// One row of the player bar's track list: what it shows, and the order its
// skip buttons walk.
export interface MapPreviewTrack {
  beatmapsetId: number;
  title: string;
  artist: string;
  coverUrl: string;
}

export interface MapPreviewAudio {
  playingSetId: number | null;
  loadingSetId: number | null;
  pausedSetId: number | null;
  // Whichever set the player bar is currently about, in any of those states.
  activeSetId: number | null;
  volume: number;
  looping: boolean;
  isUnavailable: (beatmapsetId: number) => boolean;
  toggle: (beatmapsetId: number) => void;
  stop: () => void;
  getAudio: () => HTMLAudioElement | null;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleLoop: () => void;
  seek: (seconds: number) => void;
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
  const [pausedSetId, setPausedSetId] = useState<number | null>(null);
  const [unavailableIds, setUnavailableIds] = useState<ReadonlySet<number>>(() => new Set());
  // The site's one "Default volume" (settings > viewer), so a change there
  // reaches a preview that is already playing and a change here is what the
  // next replay or preview opens at. A stored 0 really is silence: the player
  // bar carries the slider that undoes it.
  const [volume, setVolumeState] = useState(readReplayVolume);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const lastNonZeroVolumeRef = useRef(volume > 0 ? volume : 0.5);
  const [looping, setLooping] = useState(false);
  const loopingRef = useRef(looping);
  loopingRef.current = looping;

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
    setPausedSetId(null);
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

  useEffect(
    () =>
      subscribeReplayVolume((next) => {
        setVolumeState(next);
        if (next > 0) lastNonZeroVolumeRef.current = next;
        if (audioRef.current) audioRef.current.volume = next;
      }),
    [],
  );

  const setVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    setVolumeState(clamped);
    if (clamped > 0) lastNonZeroVolumeRef.current = clamped;
    if (audioRef.current) audioRef.current.volume = clamped;
    writeReplayVolume(clamped);
  }, []);

  const toggleMute = useCallback(() => {
    setVolume(volumeRef.current > 0 ? 0 : lastNonZeroVolumeRef.current || 0.5);
  }, [setVolume]);

  const toggleLoop = useCallback(() => {
    setLooping((prev) => {
      const next = !prev;
      if (audioRef.current) audioRef.current.loop = next;
      return next;
    });
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const duration = audio.duration;
    const max = Number.isFinite(duration) && duration > 0 ? duration : seconds;
    try {
      audio.currentTime = Math.min(max, Math.max(0, seconds));
    } catch {
      // Seeking before metadata lands throws in some browsers; nothing to do.
    }
  }, []);

  const toggle = useCallback(
    (beatmapsetId: number) => {
      const audio = audioRef.current;
      // Same card again: pause and resume in place rather than tearing the
      // preview down, so the player bar keeps its position. A set still
      // loading has nothing to pause, so that one cancels as it always did.
      if (activeSetIdRef.current === beatmapsetId) {
        if (audio && playingSetId === beatmapsetId) {
          audio.pause();
          setPlayingSetId(null);
          setPausedSetId(beatmapsetId);
        } else if (audio && pausedSetId === beatmapsetId) {
          setPausedSetId(null);
          setPlayingSetId(beatmapsetId);
          audio.play().catch(() => {
            if (activeSetIdRef.current !== beatmapsetId) return;
            setPlayingSetId(null);
            setPausedSetId(beatmapsetId);
          });
        } else {
          stop();
        }
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
        setPausedSetId(null);
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
      setPausedSetId(null);
      setLoadingSetId(beatmapsetId);
      element.volume = volumeRef.current;
      element.loop = loopingRef.current;
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
    [markUnavailable, pausedSetId, playingSetId, stop, teardown],
  );

  const isUnavailable = useCallback((beatmapsetId: number) => unavailableIds.has(beatmapsetId), [unavailableIds]);
  const getAudio = useCallback(() => audioRef.current, []);

  return {
    playingSetId,
    loadingSetId,
    pausedSetId,
    activeSetId: playingSetId ?? loadingSetId ?? pausedSetId,
    volume,
    looping,
    isUnavailable,
    toggle,
    stop,
    getAudio,
    setVolume,
    toggleMute,
    toggleLoop,
    seek,
  };
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
  const paused = preview.pausedSetId === beatmapsetId;

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
        playing || loading || paused ? "text-osu-pink-light" : "text-osu-l2 hover:text-white"
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
        {(playing || paused) && <PreviewProgressRing getAudio={preview.getAudio} />}
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

// Seek bar for the player bar. Position and the time readout are written
// straight to the DOM from one rAF loop (the preview runs ~10s and would
// otherwise re-render the whole bar every frame); only a drag is React state.
function PreviewSeekBar({
  getAudio,
  onSeek,
}: {
  getAudio: () => HTMLAudioElement | null;
  onSeek: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const dragRatioRef = useRef<number | null>(dragRatio);
  dragRatioRef.current = dragRatio;

  useEffect(() => {
    let raf = 0;
    let lastLabel = "";
    const tick = () => {
      const audio = getAudio();
      const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const played = audio ? audio.currentTime : 0;
      const ratio = dragRatioRef.current ?? (duration > 0 ? Math.min(1, Math.max(0, played / duration)) : 0);
      const percent = `${ratio * 100}%`;
      if (fillRef.current) fillRef.current.style.width = percent;
      if (handleRef.current) handleRef.current.style.left = percent;
      const shown = dragRatioRef.current != null ? dragRatioRef.current * duration : played;
      const label = `${formatDuration(Math.floor(shown))} / ${formatDuration(Math.floor(duration))}`;
      if (timeRef.current && label !== lastLabel) {
        timeRef.current.textContent = label;
        lastLabel = label;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getAudio]);

  const ratioFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const commit = useCallback(
    (ratio: number) => {
      const audio = getAudio();
      const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      if (duration > 0) onSeek(ratio * duration);
    },
    [getAudio, onSeek],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragRatio(ratioFromClientX(e.clientX));
    },
    [ratioFromClientX],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRatioRef.current == null) return;
      setDragRatio(ratioFromClientX(e.clientX));
    },
    [ratioFromClientX],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRatioRef.current == null) return;
      const ratio = ratioFromClientX(e.clientX);
      setDragRatio(null);
      commit(ratio);
    },
    [commit, ratioFromClientX],
  );

  const dragging = dragRatio != null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDragRatio(null)}
        className="group relative flex h-4 flex-1 cursor-pointer touch-none select-none items-center"
        role="slider"
        aria-label="Preview position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((dragRatio ?? 0) * 100)}
        tabIndex={-1}
      >
        <div className="absolute inset-x-0 h-1 rounded-full bg-osu-b3" />
        <div
          ref={fillRef}
          className={`absolute left-0 h-1 rounded-full ${dragging ? "bg-osu-pink" : "bg-osu-pink/80 group-hover:bg-osu-pink"}`}
          style={{ width: 0 }}
        />
        <div
          ref={handleRef}
          className={`absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-osu-pink transition-opacity ${
            dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          style={{ left: 0 }}
        />
      </div>
      <span ref={timeRef} className="shrink-0 text-[10px] tabular-nums text-osu-f1">
        0:00 / 0:00
      </span>
    </div>
  );
}

function PlayerIconButton({
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
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md transition-colors hover:bg-osu-b3/60 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent ${
        active ? "text-osu-pink-light" : "text-osu-l2"
      }`}
    >
      {children}
    </button>
  );
}

// Floating transport for whatever preview is playing: which song, where it is,
// and the volume that every preview and replay opens at. Skips walk the same
// order the grid shows, stepping over sets with no preview file.
export function MapPreviewPlayerBar({
  preview,
  tracks,
  // Phone layout only: the bar spans the width there, so it has to sit above
  // the sticky pagination row instead of on top of it.
  clearsStickyBar = false,
}: {
  preview: MapPreviewAudio;
  tracks: readonly MapPreviewTrack[];
  clearsStickyBar?: boolean;
}) {
  const { activeSetId, playingSetId, volume, looping, isUnavailable } = preview;

  // A set can appear on more than one row (one per matching difficulty); the
  // skip order is over sets.
  const uniqueTracks = useMemo(() => {
    const seen = new Set<number>();
    return tracks.filter((track) => {
      if (seen.has(track.beatmapsetId)) return false;
      seen.add(track.beatmapsetId);
      return true;
    });
  }, [tracks]);

  const index = activeSetId == null ? -1 : uniqueTracks.findIndex((t) => t.beatmapsetId === activeSetId);
  const track = index >= 0 ? uniqueTracks[index] : null;

  const adjacent = useCallback(
    (direction: 1 | -1) => {
      if (index < 0) return null;
      for (let i = index + direction; i >= 0 && i < uniqueTracks.length; i += direction) {
        if (!isUnavailable(uniqueTracks[i].beatmapsetId)) return uniqueTracks[i];
      }
      return null;
    },
    [index, isUnavailable, uniqueTracks],
  );

  const previous = adjacent(-1);
  const next = adjacent(1);
  const playing = activeSetId != null && playingSetId === activeSetId;

  return (
    <AnimatePresence>
      {activeSetId != null && (
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 14 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className={`fixed left-3 right-3 z-40 rounded-xl border border-osu-b3/40 bg-osu-b5/95 px-3 py-2.5 shadow-xl shadow-black/40 backdrop-blur-md sm:left-auto sm:bottom-4 sm:right-4 sm:w-[380px] ${
            clearsStickyBar ? "bottom-16" : "bottom-3"
          }`}
          style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <div className="flex items-center gap-2.5">
            {track ? (
              <img
                src={track.coverUrl}
                alt=""
                loading="lazy"
                className="h-9 w-9 shrink-0 rounded-md object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-osu-l1">{track?.title ?? "Preview"}</div>
              <div className="truncate text-[10px] text-osu-f1">{track?.artist ?? ""}</div>
            </div>
            <PlayerIconButton
              label={volume === 0 ? "Unmute" : "Mute"}
              onClick={preview.toggleMute}
            >
              {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </PlayerIconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => preview.setVolume(Number(e.target.value))}
              aria-label="Preview volume"
              title="Default volume"
              className="h-1 w-14 shrink-0 cursor-pointer appearance-none rounded-full bg-osu-b3 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink"
            />
            <PlayerIconButton label="Close player" onClick={preview.stop}>
              <X className="h-3.5 w-3.5" />
            </PlayerIconButton>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <PlayerIconButton
              label="Previous preview"
              onClick={() => previous && preview.toggle(previous.beatmapsetId)}
              disabled={!previous}
            >
              <SkipBack className="h-3.5 w-3.5 fill-current" />
            </PlayerIconButton>
            <PlayerIconButton
              label={playing ? "Pause preview" : "Play preview"}
              onClick={() => preview.toggle(activeSetId)}
            >
              {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
            </PlayerIconButton>
            <PlayerIconButton
              label="Next preview"
              onClick={() => next && preview.toggle(next.beatmapsetId)}
              disabled={!next}
            >
              <SkipForward className="h-3.5 w-3.5 fill-current" />
            </PlayerIconButton>
            <PlayerIconButton
              label={looping ? "Stop repeating" : "Repeat preview"}
              onClick={preview.toggleLoop}
              active={looping}
            >
              <Repeat className="h-3.5 w-3.5" />
            </PlayerIconButton>
            <PreviewSeekBar getAudio={preview.getAudio} onSeek={preview.seek} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
