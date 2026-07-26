import { Link } from "@tanstack/react-router";
import { ArrowLeftRight, LoaderCircle, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { getBeatmapAudioUrl } from "../../lib/audio-url";
import type { ManiaBeatmap } from "../../lib/beatmap-parser";
import { formatAccuracy, formatNumber, formatPP } from "../../lib/format";
import { getBeatmapFile, getReplayParsed, getScore } from "../../lib/osu";
import { parseCachedManiaBeatmap } from "../../lib/parsed-beatmap-cache";
import { withTimeout } from "../../lib/promise-timeout";
import { unpackReplayFrames } from "../../lib/replay-frames";
import { buildKeypressHeatmap } from "../../lib/replay-keypress-heatmap";
import { readReplayVolume } from "../../lib/replay-preferences";
import { getReplayScoreAvailability } from "../../lib/replay-score-availability";
import { parseReplayScoreInput } from "../../lib/replay-score-input";
import { readReplayScrollSpeed } from "../../lib/replay-scroll-speed";
import { readReplaySkinSettings } from "../../lib/replay-skin";
import { getScoreExpectedCounts, type ReplayRendererLike, type ServerReplay } from "../../lib/replay-types";
import {
  getDisplayedAccuracy,
  getDisplayedRank,
  getDisplayedTotalScore,
  getEffectiveManiaKeyCount,
  getManiaParseKeyCount,
  getModDisplayList,
  getScoreDisplayValues,
  getScoreRate,
  modShiftsPitchWithRate,
  scoreHasReplay,
} from "../../lib/score";
import type { OsuScore } from "../../lib/types";
import { avatarImageSrc } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { ReplayProgressBar } from "./ReplayControls";

/* Side-by-side playback of two replays on the same beatmap. Both playfields
   follow one shared MAP-TIME clock. Compare requires both runs to use the
   same mod rate, which keeps the shared clock honest (no side plays its
   frames at a different effective speed than the player heard) and lets the
   map's audio play for both: the track runs at transport speed x mod rate
   and follows the clock with periodic drift correction. */

const COMPARE_SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2];

interface CompareSide {
  score: OsuScore;
  replay: ServerReplay;
  beatmap: ManiaBeatmap | null;
  /* Mod rate (DT 1.5 / HT 0.75 / lazer custom). */
  rate: number;
  usesLazerScoring: boolean;
}

// Browsers default preservesPitch to true (the DT/HT behavior); NC/DC need
// the pitch to follow the playback rate. Vendor-prefixed for older Safari.
function setComparePreservesPitch(audio: HTMLAudioElement, preservesPitch: boolean): void {
  const pitchAudio = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  pitchAudio.preservesPitch = preservesPitch;
  pitchAudio.webkitPreservesPitch = preservesPitch;
}

/* Mirrors the main viewer's lazer-scoring detection. */
function scoreUsesLazerScoring(score: OsuScore): boolean {
  if (score.legacy_score_id != null || (score.legacy_total_score != null && score.legacy_total_score > 0)) {
    return false;
  }
  return getScoreDisplayValues(score).isLazer;
}

async function loadCompareSide(
  score: OsuScore,
  beatmapFilePromise: Promise<{ content: string } | null>,
): Promise<CompareSide> {
  const keyCount = score.beatmap ? getEffectiveManiaKeyCount(score.beatmap, score.mods) ?? undefined : undefined;
  const [parsed, beatmapFile] = await Promise.all([
    getReplayParsed({ data: { scoreId: score.id, mode: "mania", keyCount } }),
    beatmapFilePromise,
  ]);
  const parseKeyCount = score.beatmap ? getManiaParseKeyCount(score.beatmap, score.mods) ?? undefined : undefined;
  const parsedBeatmap = beatmapFile
    ? parseCachedManiaBeatmap(score.beatmap?.id ?? 0, beatmapFile.content, { keyCount: parseKeyCount })
    : null;
  return {
    score,
    replay: {
      header: parsed.header,
      frames: unpackReplayFrames(parsed.framesPacked),
      lifeBarFrames: parsed.lifeBarFrames ?? [],
      keyCount: parsedBeatmap?.keyCount ?? keyCount ?? parsed.keyCount,
      stableScrollSpeedScale: parsed.stableScrollSpeedScale,
    },
    beatmap: parsedBeatmap,
    rate: getScoreRate(score.mods),
    usesLazerScoring: scoreUsesLazerScoring(score),
  };
}

const SIDE_ACCENTS = [
  { border: "border-osu-pink/50", text: "text-osu-pink-light" },
  { border: "border-osu-blue/50", text: "text-osu-blue" },
] as const;

function CompareSideHeader({ side, accentIndex }: { side: CompareSide; accentIndex: 0 | 1 }) {
  const score = side.score;
  const accent = SIDE_ACCENTS[accentIndex];
  return (
    <div className={`rounded-t-lg border-t-2 ${accent.border} bg-osu-b4 px-2.5 py-2`}>
      <div className="flex items-center gap-1.5 min-w-0">
        {score.user?.country_code ? <CountryFlag code={score.user.country_code} size="xs" decorative /> : null}
        {score.user?.username ? (
          <Link
            to="/player/$username"
            params={{ username: score.user.username }}
            target="_blank"
            rel="noopener noreferrer"
            className={`truncate text-[13px] font-bold ${accent.text} hover:underline underline-offset-2`}
          >
            {score.user.username}
          </Link>
        ) : (
          <span className="truncate text-[13px] font-bold text-white">{side.replay.header.playerName || "Unknown"}</span>
        )}
        <span className="ml-auto shrink-0"><GradeImg grade={getDisplayedRank(score)} size={22} /></span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-osu-f1 tabular-nums">
        <span className="text-osu-l2">{formatAccuracy(getDisplayedAccuracy(score))}</span>
        <span className="font-bold text-white">{formatPP(score.pp)}</span>
        <span>{formatNumber(getDisplayedTotalScore(score) ?? 0)}</span>
        <span>{formatNumber(score.max_combo)}x</span>
        <span className="flex items-center gap-0.5">
          {getModDisplayList(score.mods).map((m) => (
            <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.7} />
          ))}
        </span>
      </div>
    </div>
  );
}

export function ReplayCompareView({
  scoreIdA,
  scoreIdB,
  onExit,
}: {
  scoreIdA: number;
  scoreIdB: number;
  onExit: () => void;
}) {
  const canvasARef = useRef<HTMLCanvasElement>(null);
  const canvasBRef = useRef<HTMLCanvasElement>(null);
  const renderersRef = useRef<ReplayRendererLike[]>([]);
  const masterRendererRef = useRef<ReplayRendererLike | null>(null);
  /* Shared map-time clock both renderers follow via setExternalClock. */
  const clockRef = useRef({ anchorPerf: 0, anchorTime: 0, playing: false, speed: 1, rate: 1 });
  const maxDurationRef = useRef(0);
  const scrubResumeRef = useRef(false);

  const [sides, setSides] = useState<[CompareSide, CompareSide] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioEnabledRef = useRef(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [audioFailed, setAudioFailed] = useState(false);

  const readClockTime = useCallback(() => {
    const clock = clockRef.current;
    if (!clock.playing) return clock.anchorTime;
    return clock.anchorTime + (performance.now() - clock.anchorPerf) * clock.speed * clock.rate;
  }, []);

  // The rate-match guard means both players heard the same song at the same
  // rate, so one audio track is correct for both sides. It follows the
  // transport clock (clock time is map time; audio.currentTime maps 1:1).
  const audioUrl = useMemo(() => {
    const setId = sides?.[0]?.score.beatmapset?.id;
    const filename = sides?.[0]?.beatmap?.audioFilename;
    return setId && filename ? getBeatmapAudioUrl(setId, filename) : null;
  }, [sides]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !sides) return;
    audio.volume = readReplayVolume();
    setComparePreservesPitch(audio, !modShiftsPitchWithRate(sides[0].score.mods));
    audio.playbackRate = speed * sides[0].rate;
  }, [sides, speed, audioUrl]);

  // Load both scores + replays and the (shared) beatmap file.
  useEffect(() => {
    let cancelled = false;
    setSides(null);
    setError(null);
    setReady(false);
    setIsPlaying(false);
    setLoading(true);
    (async () => {
      const [scoreA, scoreB] = await Promise.all([
        getScore({ data: { scoreId: scoreIdA, mode: "mania" } }).catch(() => null),
        getScore({ data: { scoreId: scoreIdB, mode: "mania" } }).catch(() => null),
      ]);
      if (cancelled) return;
      if (!scoreA || !scoreB) throw new Error("Couldn't load one of the scores.");
      if (scoreA.id === scoreB.id) throw new Error("That's the same score on both sides - pick a different replay to compare against.");
      for (const score of [scoreA, scoreB]) {
        const availability = getReplayScoreAvailability(score);
        if (!availability.available) {
          throw new Error(`${score.user?.username ?? "One of the players"}: ${availability.message}`);
        }
      }
      const beatmapId = scoreA.beatmap?.id;
      if (!beatmapId || scoreB.beatmap?.id !== beatmapId) {
        throw new Error("These scores are on different maps. Compare plays two replays of the same beatmap.");
      }
      // A rate mismatch would mean one side plays its frames faster than the
      // player heard them, and the audio could match neither run.
      const rateA = getScoreRate(scoreA.mods);
      const rateB = getScoreRate(scoreB.mods);
      if (rateA !== rateB) {
        throw new Error(`These runs used different rates (${rateA}x vs ${rateB}x). Compare needs both replays at the same rate.`);
      }
      const beatmapFilePromise = getBeatmapFile({
        data: { beatmapId, beatmapsetId: scoreA.beatmapset?.id, checksum: scoreA.beatmap?.checksum },
      }).catch(() => null);
      const [sideA, sideB] = await Promise.all([
        loadCompareSide(scoreA, beatmapFilePromise),
        loadCompareSide(scoreB, beatmapFilePromise),
      ]);
      if (!cancelled) setSides([sideA, sideB]);
    })()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the replays.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scoreIdA, scoreIdB]);

  // Create the two renderers once both sides are loaded.
  useEffect(() => {
    if (!sides) return;
    let cancelled = false;
    let handleResize: (() => void) | null = null;

    void (async () => {
      try {
        const { ManiaReplayRenderer } = await withTimeout(
          import("./ReplayCanvas"),
          8000,
          "Timed out loading the replay renderer.",
        );
        if (cancelled) return;
        const skinSettings = readReplaySkinSettings();
        const scrollSpeed = readReplayScrollSpeed();
        const canvases = [canvasARef.current, canvasBRef.current];
        const created: ReplayRendererLike[] = [];
        for (const [index, side] of sides.entries()) {
          const canvas = canvases[index];
          if (!canvas) throw new Error("The compare playfields failed to mount.");
          created.push(new ManiaReplayRenderer(
            canvas,
            side.replay.frames,
            side.replay.keyCount,
            side.beatmap?.notes ?? [],
            {
              isConvert: (side.score.beatmap?.convert ?? false) || (side.beatmap?.isConvert ?? false),
              isLazer: side.usesLazerScoring,
              od: side.beatmap?.od,
              mods: side.score.mods,
              speedMultiplier: side.rate,
              timingPoints: side.beatmap?.timingPoints,
              transparentBackground: true,
              hidePerformanceStats: true,
              scrollVelocities: side.beatmap?.scrollVelocities,
              expectedCounts: getScoreExpectedCounts(side.score, side.replay),
              lifeBarFrames: side.replay.lifeBarFrames,
              skinSettings,
            },
          ) as ReplayRendererLike);
        }
        await withTimeout(
          Promise.all(created.map((renderer) => renderer.ready())),
          12000,
          "Timed out starting the replay renderers.",
        );
        if (cancelled) {
          for (const renderer of created) renderer.destroy();
          return;
        }
        const clock = clockRef.current;
        clock.anchorPerf = performance.now();
        clock.anchorTime = 0;
        clock.playing = false;
        clock.speed = 1;
        clock.rate = sides[0].rate;
        for (const [index, renderer] of created.entries()) {
          renderer.setScrollSpeed(scrollSpeed);
          renderer.setExternalClock(() => ({ time: readClockTime(), stalled: !clockRef.current.playing }));
          // playbackSpeed only feeds the renderer's clock smoothing; matching
          // each side's effective rate to the shared clock keeps the
          // prediction drift-free even across DT-vs-nomod comparisons.
          renderer.setSpeed((clock.speed * sides[0].rate) / sides[index].rate);
          renderer.seek(0);
        }
        renderersRef.current = created;
        masterRendererRef.current = created[0] ?? null;
        maxDurationRef.current = Math.max(...created.map((renderer) => renderer.duration));
        handleResize = () => {
          for (const renderer of renderersRef.current) renderer.resize();
        };
        window.addEventListener("resize", handleResize);
        setSpeed(1);
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to start the replay renderers.");
      }
    })();

    return () => {
      cancelled = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      for (const renderer of renderersRef.current) renderer.destroy();
      renderersRef.current = [];
      masterRendererRef.current = null;
      setReady(false);
      setIsPlaying(false);
    };
  }, [readClockTime, sides]);

  const pause = useCallback(() => {
    const clock = clockRef.current;
    clock.anchorTime = Math.min(readClockTime(), maxDurationRef.current);
    clock.playing = false;
    for (const renderer of renderersRef.current) renderer.pause();
    audioRef.current?.pause();
    setIsPlaying(false);
  }, [readClockTime]);

  const play = useCallback(() => {
    if (renderersRef.current.length === 0) return;
    const clock = clockRef.current;
    // Replaying from the end restarts the run.
    if (readClockTime() >= maxDurationRef.current - 1) {
      clock.anchorTime = 0;
      for (const renderer of renderersRef.current) renderer.seek(0);
    } else {
      clock.anchorTime = readClockTime();
    }
    clock.anchorPerf = performance.now();
    clock.playing = true;
    for (const renderer of renderersRef.current) renderer.play();
    const audio = audioRef.current;
    if (audio && audioEnabledRef.current) {
      audio.currentTime = Math.max(0, clock.anchorTime / 1000);
      void audio.play().catch(() => {});
    }
    setIsPlaying(true);
  }, [readClockTime]);

  const seekBoth = useCallback((timeMs: number) => {
    const clock = clockRef.current;
    const clamped = Math.max(0, Math.min(timeMs, maxDurationRef.current));
    clock.anchorTime = clamped;
    clock.anchorPerf = performance.now();
    for (const renderer of renderersRef.current) renderer.seek(clamped);
    const audio = audioRef.current;
    if (audio) audio.currentTime = clamped / 1000;
  }, []);

  const applySpeed = useCallback((next: number) => {
    if (!sides) return;
    const clock = clockRef.current;
    clock.anchorTime = readClockTime();
    clock.anchorPerf = performance.now();
    clock.speed = next;
    for (const [index, renderer] of renderersRef.current.entries()) {
      renderer.setSpeed((next * sides[0].rate) / sides[index].rate);
    }
    const audio = audioRef.current;
    if (audio) {
      audio.playbackRate = next * clock.rate;
      audio.currentTime = clock.anchorTime / 1000;
    }
    setSpeed(next);
  }, [readClockTime, sides]);

  const toggleAudio = useCallback(() => {
    setAudioEnabled((enabled) => {
      const next = !enabled;
      audioEnabledRef.current = next;
      const audio = audioRef.current;
      if (audio) {
        if (next && clockRef.current.playing) {
          audio.currentTime = Math.max(0, readClockTime() / 1000);
          void audio.play().catch(() => {});
        } else {
          audio.pause();
        }
      }
      return next;
    });
  }, [readClockTime]);

  // The shorter replay freezes on its last frame; stop the transport once the
  // longer one ends too. The same tick nudges the audio back onto the clock
  // when it drifts (buffering hiccups, tab throttling).
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio && audioEnabledRef.current && !audio.paused) {
        const drift = Math.abs(audio.currentTime * 1000 - readClockTime());
        if (drift > 120) audio.currentTime = readClockTime() / 1000;
      }
      if (readClockTime() >= maxDurationRef.current) pause();
    }, 200);
    return () => window.clearInterval(id);
  }, [isPlaying, pause, readClockTime]);

  const heatmap = useMemo(() => {
    const frames = sides?.[0]?.replay.frames ?? [];
    if (frames.length < 2) return [];
    return buildKeypressHeatmap(frames, frames[frames.length - 1].time);
  }, [sides]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-20 text-center">
        <div className="mb-4 h-10 w-10 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
        <p className="text-sm font-semibold text-osu-l2">Loading both replays...</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-osu-f1">Fetching the two runs and the beatmap.</p>
      </div>
    );
  }

  if (error || !sides) {
    return (
      <div className="mx-auto max-w-[460px] px-4 py-16 text-center">
        <div className="text-sm font-bold text-white">Couldn't start the comparison</div>
        <div className="mt-2 text-[12px] text-osu-f1">{error ?? "Something went wrong."}</div>
        <button
          type="button"
          onClick={onExit}
          className="mt-5 rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white hover:brightness-110 transition cursor-pointer"
        >
          Back to the replay
        </button>
      </div>
    );
  }

  const mapTitle = sides[0].score.beatmapset?.title ?? "Unknown map";
  const mapVersion = sides[0].score.beatmap?.version;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <ArrowLeftRight className="h-4 w-4 shrink-0 text-osu-pink" />
        <div className="min-w-0 flex-1 truncate text-[13px] text-osu-l2">
          <span className="font-bold text-white">{mapTitle}</span>
          {mapVersion ? <span className="text-osu-f1"> [{mapVersion}]</span> : null}
        </div>
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1 rounded-lg border border-osu-b3/40 bg-osu-b4/50 px-2.5 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-white cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
          Exit compare
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {sides.map((side, index) => (
          <div key={side.score.id} className="min-w-0">
            <CompareSideHeader side={side} accentIndex={index as 0 | 1} />
            <div className="relative overflow-hidden rounded-b-lg bg-osu-b6/80">
              <canvas
                ref={index === 0 ? canvasARef : canvasBRef}
                className="block h-[46vh] w-full sm:h-[62vh]"
                onClick={() => (isPlaying ? pause() : play())}
              />
              {!ready && (
                <div className="absolute inset-0 grid place-items-center">
                  <LoaderCircle className="h-6 w-6 animate-spin text-osu-pink" strokeWidth={2.4} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-lg border border-osu-b3/20 bg-osu-b4 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => (isPlaying ? pause() : play())}
            disabled={!ready}
            aria-label={isPlaying ? "Pause both replays" : "Play both replays"}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-osu-pink text-white transition hover:bg-osu-pink-light active:scale-95 disabled:opacity-50"
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" fill="currentColor" strokeWidth={2.4} />
            ) : (
              <Play className="ml-0.5 h-4 w-4" fill="currentColor" strokeWidth={2.4} />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <ReplayProgressBar
              rendererRef={masterRendererRef}
              heatmap={heatmap}
              sliderClass=""
              className="!gap-2 !px-0 !pb-0 !pt-0"
              onPointerDown={() => {
                scrubResumeRef.current = isPlaying;
                if (isPlaying) pause();
              }}
              onPointerUp={() => {
                if (scrubResumeRef.current) play();
                scrubResumeRef.current = false;
              }}
              onSeek={seekBoth}
              onContextMenu={() => {}}
            />
          </div>
          {audioUrl && !audioFailed && (
            <button
              type="button"
              onClick={toggleAudio}
              title={audioEnabled ? "Mute" : "Unmute"}
              aria-pressed={!audioEnabled}
              className="shrink-0 rounded p-1 text-osu-f1 hover:text-white transition-colors cursor-pointer"
            >
              {audioEnabled ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : <VolumeX className="h-4 w-4" aria-hidden="true" />}
            </button>
          )}
          <div className="hidden items-center gap-1 sm:flex">
            {COMPARE_SPEED_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => applySpeed(option)}
                className={`rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums transition-colors cursor-pointer ${
                  speed === option ? "bg-osu-pink/20 text-osu-pink-light" : "text-osu-f1 hover:text-white"
                }`}
              >
                {option}x
              </button>
            ))}
          </div>
        </div>
        {audioUrl && !audioFailed && (
          <audio ref={audioRef} src={audioUrl} preload="auto" onError={() => setAudioFailed(true)} />
        )}
        <div className="mt-1.5 text-center text-[10px] text-osu-f1">
          Both playfields follow the same chart time.
        </div>
      </div>
    </div>
  );
}

/* Inline form revealed inside the score card when the compare action is
   toggled: paste another score's link (or id) from the same map to jump into
   compare mode. Collapsed by default so it doesn't compete with the score info. */
export function ReplayCompareEntry({
  onCompare,
  onClose,
  candidates,
  requiredRate,
}: {
  onCompare: (otherScoreId: number) => void;
  onClose: () => void;
  /** Leaderboard scores already loaded elsewhere on the page (browse tab).
      This component never fetches; without candidates it's just the form. */
  candidates?: OsuScore[];
  /** Compare only works between runs at the same mod rate. */
  requiredRate?: number;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = parseReplayScoreInput(value);
  const hasCandidates = (candidates?.length ?? 0) > 0;

  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed) {
      setInvalid(value.trim().length > 0);
      return;
    }
    setInvalid(false);
    onCompare(parsed);
  };

  return (
    <div ref={panelRef} className="mt-2 rounded-lg bg-osu-b5/55 p-2.5" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      {hasCandidates && (
        <div className="mb-2">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-osu-f1">Loaded scores on this map</div>
          <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto pr-1">
              {candidates!.map((entry, index) => {
                const hasReplay = scoreHasReplay(entry);
                const entryRate = getScoreRate(entry.mods);
                const rateMatches = requiredRate == null || entryRate === requiredRate;
                const entryMods = getModDisplayList(entry.mods);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={!hasReplay || !rateMatches}
                    title={!hasReplay
                      ? "No replay available for this score"
                      : !rateMatches
                        ? `Played at ${entryRate}x; compare needs a ${requiredRate}x run`
                        : undefined}
                    onClick={() => onCompare(entry.id)}
                    className="grid w-full grid-cols-[1.6rem_1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-osu-b4/70 disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
                  >
                    <span className="text-[10px] font-semibold tabular-nums text-osu-f1">#{index + 1}</span>
                    <img
                      src={avatarImageSrc(entry.user?.avatar_url, entry.user?.id)}
                      alt=""
                      loading="lazy"
                      className="h-5 w-5 rounded-full object-cover ring-1 ring-white/10"
                    />
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-[11px] font-semibold text-white">{entry.user?.username ?? "?"}</span>
                      {entryMods.length > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          {entryMods.map((mod, modIndex) => (
                            <ModBadge key={`${mod.acronym}-${modIndex}`} mod={mod.acronym} rate={mod.rate} size={0.5} />
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2 tabular-nums">
                      <span className="text-[11px] font-semibold text-osu-l2">{formatAccuracy(getDisplayedAccuracy(entry))}</span>
                      {entry.pp != null && (
                        <span className="w-14 text-right text-[11px] font-bold text-osu-pink-light">{formatPP(entry.pp)}</span>
                      )}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      )}
      <form onSubmit={submit} className="flex items-center gap-2">
        <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-osu-f1" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setInvalid(false);
          }}
          placeholder={hasCandidates ? "or paste a score link" : "Paste a link to another score on this map"}
          aria-label="Score link or id to compare against"
          enterKeyHint="go"
          // 16px on phones: anything smaller makes iOS Safari zoom the whole
          // page when the input gains focus.
          className={`h-9 sm:h-7 min-w-0 flex-1 rounded-md border bg-osu-b4/70 px-2 text-[16px] sm:text-[11px] text-white outline-none transition-colors placeholder:text-osu-f1/70 focus:border-osu-pink/40 ${
            invalid ? "border-osu-red/60" : "border-osu-b3/30"
          }`}
        />
        <button
          type="submit"
          disabled={!parsed}
          className="shrink-0 rounded-md bg-osu-pink/15 px-2.5 py-2 sm:py-1 text-[12px] sm:text-[11px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white disabled:opacity-40 cursor-pointer"
        >
          Compare
        </button>
      </form>
    </div>
  );
}
