import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Gauge, Loader2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { getBeatmapFile } from "../../lib/osu";
import { getBeatmapAudioUrl } from "../../lib/audio-url";
import { parseCachedManiaBeatmap } from "../../lib/parsed-beatmap-cache";
import { REPLAY_SCROLL_SPEED_CHANGE_EVENT, normalizeReplayScrollSpeed, readReplayScrollSpeed, writeReplayScrollSpeed } from "../../lib/replay-scroll-speed";
import type { ReplaySkinSettings } from "../../lib/replay-skin";
import { useReplaySkinSettings } from "../../lib/use-replay-skin-settings";
import type { ManiaBeatmap, ManiaNote, ManiaScrollVelocity } from "../../lib/beatmap-parser";
import type { MapsFavouriteBeatmapset, ReplayFrame } from "../../lib/types";
import {
  RANDOM_REPLAY_PREVIEW_MS,
  buildAutoplayFrames,
  getChartPreviewPlaybackPlan,
  getPreviewInitialCombo,
  getPreviewNotes,
  getPreviewScrollVelocities,
  getSetPreviewReferenceBeatmap,
  isLikelyTimedRateVariantSet,
  parseSelectedDifficultyRate,
  resolveInitialChartPreviewAudioMode,
  shouldUseSetPreviewForReplayAudio,
} from "../../lib/chart-preview";
import { formatDuration } from "../../lib/format";
import { DEFAULT_REPLAY_VOLUME, readReplayVolume, subscribeReplayVolume, writeReplayVolume } from "../../lib/replay-preferences";

const SET_PREVIEW_WINDOW_MS = 40_000;
const AUDIO_METADATA_TIMEOUT_MS = 1500;
const SELECTED_AUDIO_METADATA_TIMEOUT_MS = 60_000;
const AUDIO_SEEK_SETTLE_TIMEOUT_MS = 1200;
const SELECTED_AUDIO_SEEK_SETTLE_TIMEOUT_MS = 5000;
const AUDIO_SEEK_TOLERANCE_SECONDS = 0.25;
const REPLAY_AUDIO_CLOCK_PROGRESS_EPSILON_SECONDS = 0.003;
const REPLAY_AUDIO_CLOCK_PROGRESS_GRACE_MS = 550;

type ReplayAudioMode = "set-preview" | "selected-file";

type ReplayAudioClockSample = {
  seconds: number;
  advancingUntil: number;
};

type ReplayAudioClockAnchor = {
  mediaSeconds: number;
  startedAtMs: number;
  playbackRate: number;
};

interface PreviewRendererLike {
  readonly isPlaying: boolean;
  readonly time: number;
  readonly duration: number;
  destroy: () => void;
  pause: () => void;
  play: () => void;
  ready: () => Promise<void>;
  resize: () => void;
  seek: (timeMs: number) => void;
  setPreviewData: (
    frames: ReplayFrame[],
    keyCount: number,
    notes: ManiaNote[],
    options: { od?: number; scrollVelocities?: ManiaScrollVelocity[]; initialCombo?: number },
  ) => void;
  setExternalClock: (cb: (() => { time: number; stalled: boolean } | null) | null) => void;
  setSkinSettings: (settings: ReplaySkinSettings) => void;
  setScrollSpeed: (value: number) => void;
}

export function ChartPreviewPanel({
  beatmapset,
  selectedBeatmapId,
  playbackRate = 1,
  className = "",
  flatBackdrop = false,
  skinSettingsOverride = null,
}: {
  beatmapset: MapsFavouriteBeatmapset;
  selectedBeatmapId: number | null;
  playbackRate?: number;
  className?: string;
  flatBackdrop?: boolean;
  // Render with these skin settings instead of the viewer's own replay skin
  // (the skin page previews an uploaded skin, not the local one).
  skinSettingsOverride?: ReplaySkinSettings | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioStartSecondsRef = useRef(0);
  const audioStartPendingRef = useRef(false);
  const audioReadyRef = useRef(false);
  const audioClockSampleRef = useRef<ReplayAudioClockSample | null>(null);
  const audioClockAnchorRef = useRef<ReplayAudioClockAnchor | null>(null);
  const playbackTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const previewEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The site's one "Default volume" (settings > viewer), shared with the
  // replay viewer and the search-grid previews.
  const [volume, setVolume] = useState(readReplayVolume);
  const lastNonZeroVolumeRef = useRef(volume > 0 ? volume : DEFAULT_REPLAY_VOLUME);
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
  const [scrollSpeedInput, setScrollSpeedInput] = useState(() => String(readReplayScrollSpeed()));
  const [editingScrollSpeed, setEditingScrollSpeed] = useState(false);
  const cancelScrollSpeedCommitRef = useRef(false);
  const [previewBeatmap, setPreviewBeatmap] = useState<ManiaBeatmap | null>(null);
  const [chartStartMs, setChartStartMs] = useState(0);
  const [chartPlaybackMs, setChartPlaybackMs] = useState(0);
  const [chartTimeScale, setChartTimeScale] = useState(1);
  // Rate to apply to selected-file audio. Rate-variant sets render the 1.0x
  // reference chart, whose own audio file is also 1.0x; playing the selected
  // diff means speeding both up by the plan's time scale.
  const [selectedFileAudioRate, setSelectedFileAudioRate] = useState(1);
  const [audioMode, setAudioMode] = useState<ReplayAudioMode>("set-preview");
  const [chartScrub, setChartScrub] = useState<{ ms: number; nonce: number } | null>(null);
  const [seekRevision, setSeekRevision] = useState(0);
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ending, setEnding] = useState(false);
  const [ready, setReady] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rawPreviewUrl = typeof beatmapset.previewUrl === "string" ? beatmapset.previewUrl : "";
  const previewUrl = rawPreviewUrl.startsWith("//") ? `https:${rawPreviewUrl}` : rawPreviewUrl;
  const maniaBeatmaps = useMemo(
    () => [...(beatmapset.maniaBeatmaps ?? [])].sort((a, b) => b.difficultyRating - a.difficultyRating),
    [beatmapset.maniaBeatmaps],
  );
  const selectedBeatmap = maniaBeatmaps.find((map) => map.id === selectedBeatmapId) ?? maniaBeatmaps[0] ?? null;
  const metadataBeatmapsetId = selectedBeatmap?.beatmapsetId ?? beatmapset.id;
  const audioBeatmapsetId = previewBeatmap?.beatmapsetId ?? metadataBeatmapsetId;
  const meaningfulBeatmaps = useMemo(() => maniaBeatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5), [maniaBeatmaps]);
  const selectedDifficultyRate = parseSelectedDifficultyRate(selectedBeatmap, meaningfulBeatmaps);
  const previewPlaybackRate = normalizePreviewPlaybackRate(playbackRate);
  const usesSetPreviewForAudio = useMemo(
    () => shouldUseSetPreviewForReplayAudio(beatmapset.title, maniaBeatmaps),
    [beatmapset.title, maniaBeatmaps],
  );
  const timedRateVariant = useMemo(() => isLikelyTimedRateVariantSet(maniaBeatmaps), [maniaBeatmaps]);
  const fullAudioUrl = previewBeatmap?.audioFilename
    ? getBeatmapAudioUrl(audioBeatmapsetId, previewBeatmap.audioFilename)
    : null;
  const audioUrl = audioMode === "set-preview" ? previewUrl : fullAudioUrl;
  const audioPlaybackRate = (audioMode === "set-preview" ? selectedDifficultyRate : selectedFileAudioRate) * previewPlaybackRate;
  const clockRateDivisor = audioPlaybackRate;
  const preserveAudioPitch = Math.abs(audioPlaybackRate - 1) < 0.001;
  const applyAudioPlaybackSettings = useCallback((audio: HTMLAudioElement) => {
    audio.volume = volume;
    audio.playbackRate = audioPlaybackRate;
    setAudioPreservesPitch(audio, preserveAudioPitch);
  }, [audioPlaybackRate, preserveAudioPitch, volume]);
  const audioStartSeconds = audioMode === "selected-file" ? Math.max(0, chartStartMs / 1000) : 0;
  const chartLengthMs = useMemo(() => {
    if (!previewBeatmap?.notes.length) return 0;
    let end = 0;
    for (const note of previewBeatmap.notes) {
      if (note.endTime > end) end = note.endTime;
    }
    return end;
  }, [previewBeatmap]);
  const density = useMemo(
    () => buildChartDensity(previewBeatmap?.notes ?? [], chartLengthMs),
    [chartLengthMs, previewBeatmap],
  );
  const previewWindowMs = audioMode === "set-preview"
    ? Math.min(SET_PREVIEW_WINDOW_MS, Math.max(RANDOM_REPLAY_PREVIEW_MS, chartLengthMs))
    : Math.max(
      RANDOM_REPLAY_PREVIEW_MS,
      chartLengthMs > 0 ? chartLengthMs - chartStartMs : RANDOM_REPLAY_PREVIEW_MS,
    );
  const canScrub = chartLengthMs > RANDOM_REPLAY_PREVIEW_MS
    && (audioMode === "selected-file" || Boolean(previewBeatmap?.audioFilename));
  const previewKeyCount = previewBeatmap?.keyCount ?? Math.round(selectedBeatmap?.cs ?? 0);
  const previewCanvasWidth = previewKeyCount >= 7
    ? 460
    : previewKeyCount >= 6
    ? 390
    : 300;

  const clearPreviewEndTimer = useCallback(() => {
    if (previewEndTimerRef.current) {
      clearTimeout(previewEndTimerRef.current);
      previewEndTimerRef.current = null;
    }
  }, []);

  const resetPreview = useCallback(() => {
    clearPreviewEndTimer();
    playbackTokenRef.current += 1;
    audioStartPendingRef.current = false;
    audioReadyRef.current = false;
    audioClockSampleRef.current = null;
    audioClockAnchorRef.current = null;
    audioStartSecondsRef.current = 0;
    setRequested(false);
    setPlaying(false);
    setEnding(false);
    setReady(false);
    setAudioLoading(false);
    setPreviewBeatmap(null);
    setChartStartMs(0);
    setChartPlaybackMs(0);
    setChartTimeScale(1);
    setSelectedFileAudioRate(1);
    setAudioMode("set-preview");
    setChartScrub(null);
    setSeekRevision(0);
    setError(null);
    resetAudioElement(audioRef.current);
  }, [clearPreviewEndTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPreviewEndTimer();
      playbackTokenRef.current += 1;
      audioStartPendingRef.current = false;
      audioReadyRef.current = false;
      audioClockSampleRef.current = null;
      audioClockAnchorRef.current = null;
      resetAudioElement(audioRef.current, true);
    };
  }, [clearPreviewEndTimer]);

  useEffect(() => {
    resetPreview();
  }, [metadataBeatmapsetId, resetPreview, selectedBeatmap?.id]);

  useEffect(() => {
    if (!selectedBeatmap || !requested) {
      setPreviewBeatmap(null);
      setChartStartMs(0);
      setChartPlaybackMs(0);
      setChartTimeScale(1);
      setSelectedFileAudioRate(1);
      setAudioMode("set-preview");
      setReady(false);
      audioReadyRef.current = false;
      audioClockSampleRef.current = null;
      audioClockAnchorRef.current = null;
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    setPlaying(false);
    setReady(false);
    setAudioLoading(false);
    setError(null);
    audioReadyRef.current = false;
    audioClockSampleRef.current = null;
    audioClockAnchorRef.current = null;

    const referenceBeatmap = usesSetPreviewForAudio ? getSetPreviewReferenceBeatmap(maniaBeatmaps) : null;
    const referenceBeatmapId = referenceBeatmap?.id && referenceBeatmap.id !== selectedBeatmap.id ? referenceBeatmap.id : null;

    Promise.all([
      getBeatmapFileWithRetry(selectedBeatmap.id, metadataBeatmapsetId),
      referenceBeatmapId ? getBeatmapFileWithRetry(referenceBeatmapId, metadataBeatmapsetId).catch(() => null) : Promise.resolve(null),
    ])
      .then(([selectedResult, referenceResult]) => {
        if (cancelled) return;
        const selectedParsed = parseCachedManiaBeatmap(selectedBeatmap.id, selectedResult.content);
        const referenceParsed = referenceResult && referenceBeatmapId
          ? parseCachedManiaBeatmap(referenceBeatmapId, referenceResult.content)
          : selectedParsed;
        const plan = getChartPreviewPlaybackPlan({
          selectedBeatmap: selectedParsed,
          referenceBeatmap: referenceParsed,
          usesSetPreviewForAudio,
          timedRateVariant,
          selectedDifficultyRate,
        });

        setPreviewBeatmap(plan.beatmap);
        // Whatever the mode, plan.beatmap's own audio file matches its note
        // times 1:1, so selected-file playback speeds up by the plan's scale
        // (the selected rate when the reference chart stands in, else 1).
        setSelectedFileAudioRate(plan.timeScale);
        const scrubMs = chartScrub?.ms ?? null;
        if (scrubMs != null) {
          let chartEnd = 0;
          for (const note of plan.beatmap.notes) {
            if (note.endTime > chartEnd) chartEnd = note.endTime;
          }
          const maxStart = Math.max(0, chartEnd - 2_000);
          const nextStartMs = Math.min(Math.max(0, scrubMs), maxStart);
          setChartStartMs(nextStartMs);
          setChartPlaybackMs(nextStartMs);
          setChartTimeScale(plan.timeScale * previewPlaybackRate);
          setAudioMode("selected-file");
        } else {
          setChartStartMs(plan.startTimeMs);
          setChartPlaybackMs(plan.startTimeMs);
          setChartTimeScale(plan.timeScale * previewPlaybackRate);
          setAudioMode(resolveInitialChartPreviewAudioMode({
            plannedAudioMode: plan.audioMode,
            hasSelectedAudioFile: Boolean(plan.beatmap.audioFilename),
            hasSetPreviewAudio: Boolean(previewUrl),
          }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewBeatmap(null);
        setReady(false);
        setError("Couldn't load chart preview");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    chartScrub,
    maniaBeatmaps,
    metadataBeatmapsetId,
    previewUrl,
    previewPlaybackRate,
    requested,
    selectedBeatmap,
    selectedDifficultyRate,
    timedRateVariant,
    usesSetPreviewForAudio,
  ]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [audioUrl, volume]);

  useEffect(() => {
    if (!editingScrollSpeed) setScrollSpeedInput(String(scrollSpeed));
  }, [editingScrollSpeed, scrollSpeed]);

  useEffect(() => {
    const refreshScrollSpeed = () => setScrollSpeed(readReplayScrollSpeed());
    window.addEventListener("storage", refreshScrollSpeed);
    window.addEventListener(REPLAY_SCROLL_SPEED_CHANGE_EVENT, refreshScrollSpeed);
    window.addEventListener("focus", refreshScrollSpeed);
    return () => {
      window.removeEventListener("storage", refreshScrollSpeed);
      window.removeEventListener(REPLAY_SCROLL_SPEED_CHANGE_EVENT, refreshScrollSpeed);
      window.removeEventListener("focus", refreshScrollSpeed);
    };
  }, []);

  const finishPreview = useCallback(() => {
    if (previewEndTimerRef.current) return;
    playbackTokenRef.current += 1;
    audioStartPendingRef.current = false;
    audioReadyRef.current = false;
    audioClockSampleRef.current = null;
    audioClockAnchorRef.current = null;
    audioStartSecondsRef.current = 0;
    setAudioLoading(false);
    setPlaying(false);
    setEnding(true);
    resetAudioElement(audioRef.current);
    previewEndTimerRef.current = setTimeout(() => {
      previewEndTimerRef.current = null;
      setRequested(false);
      setPlaying(false);
      setEnding(false);
      setReady(false);
      setAudioLoading(false);
    }, 220);
  }, []);

  const startPreviewAudio = useCallback(async (token: number) => {
    const audio = audioRef.current;
    const isCurrentRequest = () =>
      mountedRef.current &&
      playbackTokenRef.current === token &&
      audioRef.current === audio;

    if (!audioUrl) {
      if (playbackTokenRef.current === token) {
        audioStartPendingRef.current = false;
        audioReadyRef.current = false;
        audioClockSampleRef.current = null;
        audioClockAnchorRef.current = null;
        setAudioLoading(false);
        setError("Couldn't find chart preview audio");
      }
      return;
    }
    if (!audio) return;

    audioStartPendingRef.current = false;
    audioReadyRef.current = false;
    resetReplayAudioClockSample(audioClockSampleRef, audioStartSeconds);
    audioClockAnchorRef.current = null;
    setError(null);
    audioStartSecondsRef.current = audioStartSeconds;
    audio.pause();
    applyAudioPlaybackSettings(audio);

    try {
      setAudioLoading(audioMode === "selected-file");
      if (audioMode === "selected-file") {
        audio.preload = "auto";
        try {
          audio.load();
        } catch {
          // Browsers can reject load while React is swapping sources.
        }
      }
      try {
        audio.currentTime = audioStartSeconds;
      } catch {
        // Metadata may not be ready yet.
      }
      await seekAudioElement(audio, audioStartSeconds, audioMode === "selected-file"
        ? {
          metadataTimeoutMs: SELECTED_AUDIO_METADATA_TIMEOUT_MS,
          requireMetadata: true,
          seekSettleTimeoutMs: SELECTED_AUDIO_SEEK_SETTLE_TIMEOUT_MS,
        }
        : undefined);
      if (!isCurrentRequest()) {
        resetAudioElement(audio);
        return;
      }
      if (audioStartSeconds > 0.25 && Math.abs(audio.currentTime - audioStartSeconds) > 1) {
        throw new Error("Chart preview audio seek failed");
      }
      await audio.play();
      if (!isCurrentRequest()) {
        resetAudioElement(audio);
        return;
      }
      resetReplayAudioClockSample(audioClockSampleRef, audio.currentTime);
      audioClockAnchorRef.current = {
        mediaSeconds: audio.currentTime,
        startedAtMs: performance.now(),
        playbackRate: getReplayAudioPlaybackRate(audio, audioPlaybackRate),
      };
      audioReadyRef.current = true;
      setPlaying(true);
      setAudioLoading(false);
    } catch {
      if (isCurrentRequest()) {
        audioReadyRef.current = false;
        audioClockSampleRef.current = null;
        audioClockAnchorRef.current = null;
        setAudioLoading(false);
        setError("Couldn't play chart preview audio");
        setPlaying(false);
      }
    }
  }, [applyAudioPlaybackSettings, audioPlaybackRate, audioStartSeconds, audioUrl, volume]);

  const getChartPlaybackMs = useCallback(() => {
    const baseMs = Math.max(0, chartStartMs);
    const audio = audioRef.current;
    if (!audio || !audioReadyRef.current) {
      return Math.min(baseMs, Math.max(0, chartLengthMs));
    }

    const elapsedMediaMs = Math.max(0, (audio.currentTime - audioStartSecondsRef.current) * 1000);
    const displayMs = elapsedMediaMs / Math.max(0.1, clockRateDivisor);
    const chartMs = baseMs + (displayMs * Math.max(0.1, chartTimeScale));
    return Math.min(Math.max(0, chartMs), Math.max(0, chartLengthMs));
  }, [chartLengthMs, chartStartMs, chartTimeScale, clockRateDivisor]);

  useEffect(() => {
    if (!requested || ending) return;

    let frameId: number | null = null;
    const update = () => {
      const nextMs = getChartPlaybackMs();
      setChartPlaybackMs((currentMs) => (
        Math.abs(currentMs - nextMs) >= 16 ? nextMs : currentMs
      ));
      if (playing) frameId = window.requestAnimationFrame(update);
    };

    update();
    return () => {
      if (frameId != null) window.cancelAnimationFrame(frameId);
    };
  }, [ending, getChartPlaybackMs, playing, requested]);

  const getClock = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioReadyRef.current || audio.paused || audio.seeking) {
      return { time: 0, stalled: true };
    }
    const rate = Math.max(0.1, clockRateDivisor);
    const now = performance.now();
    const rawMediaSeconds = audio.currentTime;
    const anchor = audioClockAnchorRef.current;
    let mediaSeconds = rawMediaSeconds;
    if (anchor) {
      const predictedSeconds = anchor.mediaSeconds + ((now - anchor.startedAtMs) / 1000) * anchor.playbackRate;
      if (rawMediaSeconds > predictedSeconds + 0.12) {
        audioClockAnchorRef.current = {
          mediaSeconds: rawMediaSeconds,
          startedAtMs: now,
          playbackRate: getReplayAudioPlaybackRate(audio, audioPlaybackRate),
        };
        mediaSeconds = rawMediaSeconds;
      } else {
        mediaSeconds = Math.max(rawMediaSeconds, predictedSeconds);
      }
    }
    const elapsedSeconds = Math.max(0, mediaSeconds - audioStartSecondsRef.current);
    const lowReadyState = audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
    const audioClockIsMoving = anchor != null || hasRecentReplayAudioClockProgress(audioClockSampleRef, mediaSeconds);
    return {
      time: Math.min(previewWindowMs, (elapsedSeconds * 1000) / rate),
      stalled: lowReadyState && !audioClockIsMoving,
    };
  }, [audioPlaybackRate, clockRateDivisor, previewWindowMs]);

  const startPreview = useCallback(() => {
    const audio = audioRef.current;
    clearPreviewEndTimer();
    const token = playbackTokenRef.current + 1;
    playbackTokenRef.current = token;
    audioReadyRef.current = false;
    resetReplayAudioClockSample(audioClockSampleRef, audioStartSeconds);
    audioClockAnchorRef.current = null;
    setPlaying(false);
    setEnding(false);
    if (audio) {
      audio.pause();
      try {
        audio.currentTime = audioStartSeconds;
      } catch {
        // Best effort while the source is resolving.
      }
      applyAudioPlaybackSettings(audio);
    }
    audioStartSecondsRef.current = audioStartSeconds;
    setChartPlaybackMs(chartStartMs);
    setRequested(true);
    audioStartPendingRef.current = true;
    if (previewBeatmap && ready) {
      void startPreviewAudio(token);
    }
  }, [applyAudioPlaybackSettings, audioPlaybackRate, audioStartSeconds, chartStartMs, clearPreviewEndTimer, previewBeatmap, ready, startPreviewAudio]);

  useEffect(() => {
    if (requested && previewBeatmap && ready && !previewLoading && audioStartPendingRef.current) {
      void startPreviewAudio(playbackTokenRef.current);
    }
  }, [previewBeatmap, previewLoading, ready, requested, startPreviewAudio]);

  const seekChart = useCallback((targetMs: number) => {
    clearPreviewEndTimer();
    playbackTokenRef.current += 1;
    audioReadyRef.current = false;
    audioStartPendingRef.current = true;
    audioClockSampleRef.current = null;
    audioClockAnchorRef.current = null;
    resetAudioElement(audioRef.current);
    setPlaying(false);
    setReady(false);
    setEnding(false);
    setError(null);
    setRequested(true);
    const nextMs = Math.max(0, Math.round(targetMs));
    setChartPlaybackMs(nextMs);
    setChartScrub((prev) => ({
      ms: nextMs,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
    setSeekRevision((revision) => revision + 1);
  }, [clearPreviewEndTimer]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioReadyRef.current) return;
    if (playing) {
      setChartPlaybackMs(getChartPlaybackMs());
      audio.pause();
      audioClockAnchorRef.current = null;
      setPlaying(false);
      return;
    }
    resetReplayAudioClockSample(audioClockSampleRef, audio.currentTime);
    audioClockAnchorRef.current = {
      mediaSeconds: audio.currentTime,
      startedAtMs: performance.now(),
      playbackRate: getReplayAudioPlaybackRate(audio, audioPlaybackRate),
    };
    applyAudioPlaybackSettings(audio);
    void audio.play()
      .then(() => {
        if (audioRef.current !== audio) return;
        setPlaying(true);
      })
      .catch(() => {
        audioClockAnchorRef.current = null;
      });
  }, [applyAudioPlaybackSettings, audioPlaybackRate, getChartPlaybackMs, playing]);

  const markReady = useCallback(() => {
    setReady(true);
  }, []);

  const applyVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolume(clamped);
    if (audioRef.current) audioRef.current.volume = clamped;
    if (clamped > 0) lastNonZeroVolumeRef.current = clamped;
    writeReplayVolume(clamped);
  }, []);

  // Settings can be open over a running preview, and the slider there writes
  // the same stored volume this one does.
  useEffect(
    () =>
      subscribeReplayVolume((next) => {
        setVolume(next);
        if (next > 0) lastNonZeroVolumeRef.current = next;
        if (audioRef.current) audioRef.current.volume = next;
      }),
    [],
  );

  const toggleMute = useCallback(() => {
    applyVolume(volume > 0 ? 0 : lastNonZeroVolumeRef.current || DEFAULT_REPLAY_VOLUME);
  }, [applyVolume, volume]);

  const applyScrollSpeed = useCallback((value: number) => {
    const normalized = normalizeReplayScrollSpeed(value);
    setScrollSpeed(normalized);
    writeReplayScrollSpeed(normalized);
  }, []);

  const commitScrollSpeedInput = useCallback(() => {
    if (cancelScrollSpeedCommitRef.current) {
      cancelScrollSpeedCommitRef.current = false;
      setScrollSpeedInput(String(scrollSpeed));
      setEditingScrollSpeed(false);
      return;
    }

    const parsed = Number(scrollSpeedInput.trim());
    if (!Number.isFinite(parsed)) {
      setScrollSpeedInput(String(scrollSpeed));
      setEditingScrollSpeed(false);
      return;
    }

    const next = normalizeReplayScrollSpeed(parsed);
    setScrollSpeedInput(String(next));
    setEditingScrollSpeed(false);
    if (next !== scrollSpeed) applyScrollSpeed(next);
  }, [applyScrollSpeed, scrollSpeed, scrollSpeedInput]);

  const paused = requested && ready && audioReadyRef.current && !playing && !ending && !audioLoading && !error;
  const preparing = requested && !ending && !playing && !paused && !audioLoading && !error;
  const canToggle = requested && !ending && !audioLoading && (playing || ready);

  return (
    <div className={`relative min-h-[360px] overflow-hidden rounded-xl border ${flatBackdrop ? "border-transparent bg-transparent" : "border-osu-b3/30 bg-osu-b6"} ${className}`}>
      <div
        onClick={canToggle ? togglePlayback : undefined}
        className={`absolute inset-x-0 top-0 transition-opacity duration-200 ${
          canScrub ? "bottom-10" : "bottom-0"
        } ${
          previewBeatmap && !ending ? "opacity-100" : "opacity-0"
        } ${canToggle ? "cursor-pointer" : ""}`}
      >
        {previewBeatmap ? (
          <ChartPreviewRenderer
            key={selectedBeatmap?.id ?? "preview"}
            beatmap={previewBeatmap}
            startTimeMs={chartStartMs}
            timeScale={chartTimeScale}
            windowMs={previewWindowMs}
            isPlaying={playing}
            resetWhenIdle={!requested || ending}
            getClock={getClock}
            scrollSpeed={scrollSpeed}
            canvasWidth={previewCanvasWidth}
            readySignal={seekRevision}
            onReady={markReady}
            onEnded={finishPreview}
            skinSettingsOverride={skinSettingsOverride}
          />
        ) : null}
      </div>

      {!flatBackdrop ? (
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,102,170,0.12),transparent_36%),linear-gradient(180deg,rgba(21,24,42,0.35),rgba(7,9,18,0.76))]"
          aria-hidden="true"
        />
      ) : null}

      {audioLoading ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-osu-b5/45 backdrop-blur-[1px]">
          <div className="grid h-9 w-9 place-items-center rounded-md border border-osu-b3/50 bg-osu-b5/85 shadow-lg">
            <Loader2 className="h-4 w-4 animate-spin text-osu-pink" />
          </div>
        </div>
      ) : null}

      {preparing ? (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
          <div className="grid h-8 w-8 place-items-center rounded-md border border-osu-b3/40 bg-osu-b5/65 shadow-lg shadow-black/20 backdrop-blur-[1px]">
            <Loader2 className="h-4 w-4 animate-spin text-osu-pink" />
          </div>
        </div>
      ) : null}

      {paused ? (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
          <div className="grid h-11 w-11 place-items-center rounded-full border border-osu-f1/30 bg-osu-b5/70 shadow-lg shadow-black/20 backdrop-blur-[1px]">
            <Play className="ml-0.5 h-4 w-4 fill-current text-osu-l2" />
          </div>
        </div>
      ) : null}

      {selectedBeatmap ? (
        <button
          type="button"
          onClick={startPreview}
          className={`absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md border border-osu-f1/35 bg-osu-b5/70 px-3 py-1.5 text-[11px] font-semibold text-osu-l2 backdrop-blur-sm transition-all duration-200 hover:border-osu-l2/70 hover:bg-osu-b4/80 hover:text-white ${
            requested && !ending ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100"
          }`}
        >
          <Play className="h-3 w-3 fill-current" />
          <span>chart preview</span>
        </button>
      ) : null}

      {requested && !ending && canScrub ? (
        <div
          className="absolute bottom-10 left-1/2 z-30 w-full max-w-[calc(100%-2rem)] -translate-x-1/2"
          style={{ width: `${previewCanvasWidth}px` }}
        >
          <ChartPreviewTimeline
            positionMs={chartPlaybackMs}
            lengthMs={chartLengthMs}
            displayRate={chartTimeScale}
            density={density}
            onSeek={seekChart}
          />
        </div>
      ) : null}

      <div className={`absolute inset-x-0 bottom-0 z-30 flex min-h-10 items-center justify-between gap-3 border-t px-3 py-2 ${flatBackdrop ? "border-transparent bg-transparent" : "border-white/10 bg-osu-b5/80 backdrop-blur-md"}`}>
        <div className="min-w-0 truncate text-[11px] font-semibold text-osu-l2">
          {selectedBeatmap ? (
            <>
              <span className="text-osu-yellow">{selectedBeatmap.difficultyRating.toFixed(2)} ★</span>
              <span className="text-osu-f1"> / {Math.round(selectedBeatmap.cs)}K / {selectedBeatmap.version}</span>
            </>
          ) : (
            <span className="text-osu-f1">No mania difficulty selected</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md bg-osu-b6/35 px-1.5 py-1 text-osu-f1" title="Scroll speed">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            <input
              type="range"
              min={1}
              max={40}
              step={1}
              value={scrollSpeed}
              onChange={(e) => applyScrollSpeed(Number(e.target.value))}
              aria-label="Chart preview scroll speed"
              className="h-1 w-16 shrink-0 cursor-pointer appearance-none rounded-full bg-osu-b3 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-yellow"
            />
            <input
              type="text"
              inputMode="numeric"
              value={scrollSpeedInput}
              aria-label="Chart preview scroll speed value"
              onFocus={() => setEditingScrollSpeed(true)}
              onChange={(event) => setScrollSpeedInput(event.target.value.replace(/[^\d]/g, "").slice(0, 2))}
              onBlur={commitScrollSpeedInput}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  cancelScrollSpeedCommitRef.current = true;
                  setScrollSpeedInput(String(scrollSpeed));
                  setEditingScrollSpeed(false);
                  event.currentTarget.blur();
                }
              }}
              className="h-5 w-6 rounded bg-transparent text-center text-[10px] font-semibold tabular-nums text-osu-l2 outline-none transition-colors focus:bg-osu-b3/70 focus:text-white focus:ring-1 focus:ring-osu-yellow/40"
            />
          </div>
          {requested && !ending ? (
            <button
              type="button"
              onClick={togglePlayback}
              disabled={!canToggle}
              aria-label={playing ? "Pause chart preview" : "Resume chart preview"}
              className="grid h-7 w-7 place-items-center rounded-md bg-osu-b3/80 text-osu-l2 transition-colors hover:bg-osu-b2 hover:text-white disabled:cursor-default disabled:opacity-70 disabled:hover:bg-osu-b3/80 disabled:hover:text-osu-l2"
            >
              {!canToggle ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-osu-pink" />
              ) : playing ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={toggleMute}
            aria-label={volume === 0 ? "Unmute chart preview" : "Mute chart preview"}
            className="grid h-7 w-7 place-items-center rounded-md text-osu-f1 transition-colors hover:bg-osu-b3/70 hover:text-white"
          >
            {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => applyVolume(Number(e.target.value))}
            aria-label="Chart preview volume"
            className="h-1 w-16 shrink-0 cursor-pointer appearance-none rounded-full bg-osu-b3 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink"
          />
        </div>
      </div>

      {error && requested ? (
        <div className="absolute inset-x-3 top-3 z-40 rounded-md bg-black/65 px-2 py-1 text-[10px] text-rose-300">
          {error}
        </div>
      ) : null}

      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload={audioMode === "set-preview" ? "metadata" : "none"}
          onCanPlay={(e) => {
            applyAudioPlaybackSettings(e.currentTarget);
            setAudioLoading(false);
          }}
          onPlaying={(e) => {
            applyAudioPlaybackSettings(e.currentTarget);
            setAudioLoading(false);
          }}
          onTimeUpdate={(e) => {
            const audio = e.currentTarget;
            const maxSeconds = audioStartSecondsRef.current + ((previewWindowMs / 1000) * audioPlaybackRate);
            if (audio.currentTime >= maxSeconds) finishPreview();
          }}
          onEnded={finishPreview}
          onError={() => {
            setAudioLoading(false);
            setError("Couldn't load chart preview audio");
            setPlaying(false);
            audioStartPendingRef.current = false;
            audioReadyRef.current = false;
            audioClockSampleRef.current = null;
            audioClockAnchorRef.current = null;
          }}
        />
      ) : null}
    </div>
  );
}

function ChartPreviewTimeline({
  positionMs,
  lengthMs,
  displayRate,
  density,
  onSeek,
}: {
  positionMs: number;
  lengthMs: number;
  displayRate: number;
  density: number[];
  onSeek: (targetMs: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const labelRate = Math.max(0.1, displayRate);
  const maxStartMs = Math.max(0, lengthMs - 2_000);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [hovering, setHovering] = useState(false);
  const activeMs = dragMs ?? Math.min(positionMs, maxStartMs);
  const ratio = maxStartMs > 0 ? Math.min(1, Math.max(0, activeMs / maxStartMs)) : 0;

  const msFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const r = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    return r * maxStartMs;
  }, [maxStartMs]);

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragMs(msFromClientX(e.clientX));
  }, [msFromClientX]);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragMs == null) return;
    setDragMs(msFromClientX(e.clientX));
  }, [dragMs, msFromClientX]);

  const handlePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragMs == null) return;
    const target = msFromClientX(e.clientX);
    setDragMs(null);
    onSeek(target);
  }, [dragMs, msFromClientX, onSeek]);

  const dragging = dragMs != null;

  return (
    <div className="group flex items-center gap-2">
      <span className="w-9 shrink-0 text-right text-[9px] tabular-nums text-osu-f1/70">
        {formatDuration(Math.floor(activeMs / labelRate / 1000))}
      </span>
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDragMs(null)}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => {
          setHovering(false);
          if (dragMs == null) setDragMs(null);
        }}
        className="group/density relative flex h-5 flex-1 cursor-pointer touch-none select-none items-center"
      >
        <ChartDensityHeatmap density={density} visible={hovering || dragging} />
        <div className="absolute inset-x-0 h-px rounded-full bg-osu-f1/25" />
        <div
          className={`absolute left-0 h-px rounded-full transition-colors ${dragging ? "bg-osu-pink/80" : "bg-osu-f1/50 group-hover:bg-osu-pink/70"}`}
          style={{ width: `${ratio * 100}%` }}
        />
        <div
          className={`absolute h-2 w-2 -translate-x-1/2 rounded-full transition-all ${dragging ? "scale-125 bg-osu-pink" : "bg-osu-f1/80 group-hover:bg-osu-pink"}`}
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-left text-[9px] tabular-nums text-osu-f1/70">
        {formatDuration(Math.floor(lengthMs / labelRate / 1000))}
      </span>
    </div>
  );
}

function ChartDensityHeatmap({ density, visible }: { density: number[]; visible: boolean }) {
  const rawGradientId = useId();
  const gradientId = `chart-density-${rawGradientId.replace(/:/g, "")}`;
  const n = density.length;
  if (n === 0) return null;
  const width = 1000;
  const height = 100;
  const step = width / (n - 1 || 1);
  const points = density.map((value, index) => ({
    x: index * step,
    y: height - Math.max(0, Math.min(1, value)) * height,
  }));
  const first = `${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let curve = "";
  for (let i = 0; i < n - 1; i++) {
    const cur = points[i];
    const next = points[i + 1];
    const mx = (cur.x + next.x) / 2;
    const my = (cur.y + next.y) / 2;
    curve += ` Q ${cur.x.toFixed(2)} ${cur.y.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = `${points[n - 1].x.toFixed(2)} ${points[n - 1].y.toFixed(2)}`;
  const topD = `M ${first}${curve} L ${last}`;
  const fillD = `M 0 ${height} L ${first}${curve} L ${last} L ${width} ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`pointer-events-none absolute inset-x-0 bottom-full z-10 h-5 w-full text-osu-pink transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="45%" stopColor="currentColor" stopOpacity="0.08" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillD} fill={`url(#${gradientId})`} />
      <path
        d={topD}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ChartPreviewRenderer({
  beatmap,
  startTimeMs,
  timeScale,
  windowMs,
  isPlaying,
  resetWhenIdle,
  getClock,
  scrollSpeed,
  canvasWidth,
  readySignal,
  onReady,
  onEnded,
  skinSettingsOverride = null,
}: {
  beatmap: ManiaBeatmap | null;
  startTimeMs: number;
  timeScale: number;
  windowMs: number;
  skinSettingsOverride?: ReplaySkinSettings | null;
  isPlaying: boolean;
  resetWhenIdle: boolean;
  getClock: () => { time: number; stalled: boolean } | null;
  scrollSpeed: number;
  canvasWidth: number;
  readySignal: number;
  onReady: () => void;
  onEnded: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PreviewRendererLike | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const getClockRef = useRef(getClock);
  const scrollSpeedRef = useRef(scrollSpeed);
  const localSkinSettings = useReplaySkinSettings();
  const skinSettings = skinSettingsOverride ?? localSkinSettings;
  const skinSettingsRef = useRef(skinSettings);
  skinSettingsRef.current = skinSettings;
  const [canvasReady, setCanvasReady] = useState(false);
  const initialCombo = useMemo(() => beatmap ? getPreviewInitialCombo(beatmap, startTimeMs) : 0, [beatmap, startTimeMs]);
  const notes = useMemo(() => beatmap ? getPreviewNotes(beatmap, startTimeMs, timeScale, windowMs) : [], [beatmap, startTimeMs, timeScale, windowMs]);
  const scrollVelocities = useMemo(() => beatmap ? getPreviewScrollVelocities(beatmap, startTimeMs, timeScale, windowMs) : [], [beatmap, startTimeMs, timeScale, windowMs]);
  const frames = useMemo(() => beatmap ? buildAutoplayFrames(notes, beatmap.keyCount, windowMs) : [], [beatmap, notes, windowMs]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    getClockRef.current = getClock;
  }, [getClock]);

  useEffect(() => {
    scrollSpeedRef.current = scrollSpeed;
    rendererRef.current?.setScrollSpeed(scrollSpeed);
  }, [scrollSpeed]);

  useEffect(() => {
    rendererRef.current?.setSkinSettings(skinSettings);
  }, [skinSettings]);

  useEffect(() => {
    if (!canvasRef.current || !beatmap) return;

    let cancelled = false;
    let renderer: PreviewRendererLike | null = null;
    let handleResize: (() => void) | null = null;
    setCanvasReady(false);

    void import("../replay/ReplayCanvas").then(({ ManiaReplayRenderer }) => {
      if (cancelled || !canvasRef.current) return;
      renderer = new ManiaReplayRenderer(
        canvasRef.current,
        frames,
        beatmap.keyCount,
        notes,
        {
          od: beatmap.od,
          showInputOverlay: false,
          transparentBackground: true,
          hideHud: true,
          showCombo: true,
          initialCombo,
          barePlayfield: true,
          showHealthBar: false,
          scrollVelocities,
          skinSettings: skinSettingsRef.current,
        },
      ) as PreviewRendererLike;
      renderer.setScrollSpeed(scrollSpeedRef.current);
      renderer.setSkinSettings(skinSettingsRef.current);
      renderer.setExternalClock(() => getClockRef.current());
      rendererRef.current = renderer;
      handleResize = () => renderer?.resize();
      window.addEventListener("resize", handleResize);
      void renderer.ready().then(() => {
        if (cancelled || rendererRef.current !== renderer) return;
        setCanvasReady(true);
        onReady();
        const activeRenderer = rendererRef.current;
        if (isPlayingRef.current) activeRenderer?.play();
      });
    });

    return () => {
      cancelled = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, [beatmap]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !beatmap) return;
    renderer.setPreviewData(frames, beatmap.keyCount, notes, {
      od: beatmap.od,
      scrollVelocities,
      initialCombo,
    });
    if (canvasReady) onReady();
  }, [beatmap, canvasReady, frames, initialCombo, notes, onReady, scrollVelocities]);

  useEffect(() => {
    if (canvasReady && rendererRef.current) onReady();
  }, [canvasReady, onReady, readySignal]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (isPlaying) renderer.play();
    else renderer.pause();
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying && resetWhenIdle) rendererRef.current?.seek(0);
  }, [beatmap, isPlaying, resetWhenIdle]);

  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      if (!renderer.isPlaying || renderer.time >= renderer.duration) onEnded();
    }, 50);
    return () => clearInterval(id);
  }, [isPlaying, onEnded]);

  return (
    <div
      className="absolute inset-y-0 left-1/2 w-full max-w-full -translate-x-1/2"
      style={{ width: `${canvasWidth}px` }}
    >
      <canvas
        ref={canvasRef}
        className={`relative z-10 h-full w-full transition-opacity duration-75 ${canvasReady ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}

function resetReplayAudioClockSample(sampleRef: { current: ReplayAudioClockSample | null }, seconds: number): void {
  sampleRef.current = {
    seconds,
    advancingUntil: 0,
  };
}

function getReplayAudioPlaybackRate(audio: HTMLAudioElement, fallbackRate: number): number {
  const rate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
    ? audio.playbackRate
    : fallbackRate;
  return Math.max(0.1, rate);
}

function hasRecentReplayAudioClockProgress(sampleRef: { current: ReplayAudioClockSample | null }, seconds: number): boolean {
  const now = performance.now();
  const previous = sampleRef.current;
  if (!previous || seconds < previous.seconds - 0.05) {
    sampleRef.current = { seconds, advancingUntil: 0 };
    return false;
  }

  const advancingUntil = seconds > previous.seconds + REPLAY_AUDIO_CLOCK_PROGRESS_EPSILON_SECONDS
    ? now + REPLAY_AUDIO_CLOCK_PROGRESS_GRACE_MS
    : previous.advancingUntil;
  sampleRef.current = { seconds, advancingUntil };
  return now <= advancingUntil;
}

function setAudioPreservesPitch(audio: HTMLAudioElement, preservesPitch: boolean): void {
  const pitchAudio = audio as HTMLAudioElement & {
    mozPreservesPitch?: boolean;
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  pitchAudio.preservesPitch = preservesPitch;
  pitchAudio.mozPreservesPitch = preservesPitch;
  pitchAudio.webkitPreservesPitch = preservesPitch;
}

function resetAudioElement(audio: HTMLAudioElement | null, unload = false): void {
  if (!audio) return;
  audio.pause();
  audio.playbackRate = 1;
  setAudioPreservesPitch(audio, true);
  try {
    audio.currentTime = 0;
  } catch {
    // Some browsers reject seeks while the element is choosing a source.
  }
  if (unload) {
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      // Pausing above is the important cleanup.
    }
  }
}

function waitForAudioMetadata(
  audio: HTMLAudioElement,
  timeoutMs = AUDIO_METADATA_TIMEOUT_MS,
  requireMetadata = false,
): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null;
    const done = (loaded: boolean) => {
      if (timeoutId) window.clearTimeout(timeoutId);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
      if (loaded || !requireMetadata) resolve();
      else reject(new Error("Audio metadata did not load"));
    };
    const onLoadedMetadata = () => done(true);
    const onError = () => done(false);
    const onTimeout = () => done(audio.readyState >= HTMLMediaElement.HAVE_METADATA);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("error", onError);
    timeoutId = window.setTimeout(onTimeout, timeoutMs);
  });
}

function waitForAudioSeekSettle(
  audio: HTMLAudioElement,
  targetSeconds: number,
  timeoutMs = AUDIO_SEEK_SETTLE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let rafId: number | null = null;
    let timeoutId: number | null = null;
    let settledFrames = 0;
    const isCloseToTarget = () => Math.abs(audio.currentTime - targetSeconds) <= AUDIO_SEEK_TOLERANCE_SECONDS;

    const cleanup = () => {
      if (rafId != null) window.cancelAnimationFrame(rafId);
      if (timeoutId != null) window.clearTimeout(timeoutId);
      audio.removeEventListener("seeked", scheduleCheck);
      audio.removeEventListener("canplay", scheduleCheck);
      audio.removeEventListener("loadeddata", scheduleCheck);
      audio.removeEventListener("timeupdate", scheduleCheck);
      audio.removeEventListener("error", done);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const check = () => {
      rafId = null;
      if (audio.error) {
        done();
        return;
      }
      if (!audio.seeking && isCloseToTarget()) {
        settledFrames += 1;
        if (settledFrames >= 2) {
          done();
          return;
        }
      } else {
        settledFrames = 0;
      }
      scheduleCheck();
    };
    function scheduleCheck() {
      if (rafId == null) rafId = window.requestAnimationFrame(check);
    }

    audio.addEventListener("seeked", scheduleCheck);
    audio.addEventListener("canplay", scheduleCheck);
    audio.addEventListener("loadeddata", scheduleCheck);
    audio.addEventListener("timeupdate", scheduleCheck);
    audio.addEventListener("error", done);
    timeoutId = window.setTimeout(done, timeoutMs);
    scheduleCheck();
  });
}

async function seekAudioElement(
  audio: HTMLAudioElement,
  seconds: number,
  options?: { metadataTimeoutMs?: number; requireMetadata?: boolean; seekSettleTimeoutMs?: number },
): Promise<void> {
  const targetSeconds = Math.max(0, seconds);
  await waitForAudioMetadata(audio, options?.metadataTimeoutMs, options?.requireMetadata);
  try {
    audio.currentTime = targetSeconds;
  } catch {
    return;
  }
  await waitForAudioSeekSettle(audio, targetSeconds, options?.seekSettleTimeoutMs);
}

async function getBeatmapFileWithRetry(beatmapId: number, beatmapsetId?: number) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await getBeatmapFile({ data: { beatmapId, beatmapsetId } });
      if (!result.content.trim()) throw new Error("Empty beatmap file");
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePreviewPlaybackRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0.5, value));
}

function buildChartDensity(notes: ManiaNote[], lengthMs: number): number[] {
  if (!notes.length || lengthMs <= 0) return [];
  const buckets = 96;
  const bucketMs = Math.max(1, lengthMs / buckets);
  const counts = new Array<number>(buckets).fill(0);

  for (const note of notes) {
    const startBucket = Math.max(0, Math.min(buckets - 1, Math.floor(note.time / bucketMs)));
    counts[startBucket] += note.isHold ? 0.75 : 1;

    if (note.isHold && note.endTime > note.time) {
      const endBucket = Math.max(startBucket, Math.min(buckets - 1, Math.floor(note.endTime / bucketMs)));
      for (let i = startBucket; i <= endBucket; i++) {
        counts[i] += 0.18;
      }
    }
  }

  const smoothed = counts.map((value, index) => {
    const prev = counts[index - 1] ?? value;
    const next = counts[index + 1] ?? value;
    return (prev * 0.25) + (value * 0.5) + (next * 0.25);
  });
  const max = Math.max(...smoothed);
  if (max <= 0) return [];
  return smoothed.map((value) => Math.pow(value / max, 0.72));
}
