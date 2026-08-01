import { Link } from "@tanstack/react-router";
import { ChevronLeft, LoaderCircle, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { getBeatmapAudioUrl } from "../../lib/audio-url";
import type { ManiaBeatmap } from "../../lib/beatmap-parser";
import { formatDate } from "../../lib/format";
import { formatLazerScore, formatStableScore } from "../../lib/mania-score-simulation";
import { calculateManiaStarRating } from "../../lib/mania-star-rating";
import { getBeatmapFile, getReplayParsed, getScore } from "../../lib/osu";
import { parseCachedManiaBeatmap } from "../../lib/parsed-beatmap-cache";
import { withTimeout } from "../../lib/promise-timeout";
import { unpackReplayFrames } from "../../lib/replay-frames";
import { buildKeypressHeatmap } from "../../lib/replay-keypress-heatmap";
import { readReplayVolume } from "../../lib/replay-preferences";
import { readReplayScrollSpeed } from "../../lib/replay-scroll-speed";
import { getSideBySideIssue } from "../../lib/replay-side-by-side";
import { readReplaySkinSettings } from "../../lib/replay-skin";
import { getScoreExpectedCounts, type ReplayLiveStats, type ReplayRendererLike, type ServerReplay } from "../../lib/replay-types";
import {
  getDisplayedRank,
  getEffectiveManiaKeyCount,
  getManiaParseKeyCount,
  getModDisplayList,
  getScoreDisplayValues,
  getScoreRate,
  getScoreTimestamp,
  modShiftsPitchWithRate,
} from "../../lib/score";
import type { OsuScore } from "../../lib/types";
import { CountryFlag } from "../ui/CountryFlag";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { StarRatingBadge } from "../maps/SearchCard";
import { ReplayProgressBar } from "./ReplayControls";

/* Two runs of one chart, playing at once. Both playfields follow a single
   MAP-TIME clock and the stats column between them is read straight off the
   renderers, so the numbers can never drift from what the stages are showing.
   The pair is rate-matched (see replay-side-by-side.ts), which keeps that
   shared clock honest and lets one audio track serve both sides: the track
   runs at transport speed x mod rate and follows the clock with periodic
   drift correction.

   The playfields deliberately run without the HUD: no keypresses, no
   leaderboard, no accuracy readout. Everything worth comparing lives in the
   middle column, where the two runs sit on the same line. */

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2];

interface SideBySideSide {
  score: OsuScore;
  replay: ServerReplay;
  beatmap: ManiaBeatmap | null;
  /* Mod rate (DT 1.5 / HT 0.75 / lazer custom). */
  rate: number;
  usesLazerScoring: boolean;
}

const SIDE_ACCENTS = [
  { text: "text-osu-pink-light", bar: "bg-osu-pink", ring: "ring-osu-pink/40" },
  { text: "text-osu-blue", bar: "bg-osu-blue", ring: "ring-osu-blue/40" },
] as const;

// Browsers default preservesPitch to true (the DT/HT behavior); NC/DC need
// the pitch to follow the playback rate. Vendor-prefixed for older Safari.
function setPreservesPitch(audio: HTMLAudioElement, preservesPitch: boolean): void {
  const pitchAudio = audio as HTMLAudioElement & {
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  pitchAudio.preservesPitch = preservesPitch;
  pitchAudio.webkitPreservesPitch = preservesPitch;
}

/* Pins each side's simulated score counter to what the play actually earned,
   the same way the single-replay viewer does. */
function getRealTotalScore(side: SideBySideSide): number | null {
  if (side.usesLazerScoring) return side.score.total_score ?? null;
  const stableTotal = side.score.legacy_total_score ?? side.score.score ?? side.replay.header.totalScore;
  return stableTotal != null && stableTotal > 0 ? stableTotal : null;
}

/* Mirrors the main viewer's lazer-scoring detection. */
function scoreUsesLazerScoring(score: OsuScore): boolean {
  if (score.legacy_score_id != null || (score.legacy_total_score != null && score.legacy_total_score > 0)) {
    return false;
  }
  return getScoreDisplayValues(score).isLazer;
}

async function loadSide(
  score: OsuScore,
  beatmapFilePromise: Promise<{ content: string } | null>,
): Promise<SideBySideSide> {
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

export function ReplaySideBySideView({
  leftScoreId,
  rightScoreId,
  onExit,
}: {
  leftScoreId: number;
  rightScoreId: number;
  onExit: () => void;
}) {
  const canvasLeftRef = useRef<HTMLCanvasElement>(null);
  const canvasRightRef = useRef<HTMLCanvasElement>(null);
  const renderersRef = useRef<ReplayRendererLike[]>([]);
  const masterRendererRef = useRef<ReplayRendererLike | null>(null);
  /* Shared map-time clock both renderers follow via setExternalClock. */
  const clockRef = useRef({ anchorPerf: 0, anchorTime: 0, playing: false, speed: 1, rate: 1 });
  const maxDurationRef = useRef(0);
  const scrubResumeRef = useRef(false);

  const [sides, setSides] = useState<[SideBySideSide, SideBySideSide] | null>(null);
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
    setPreservesPitch(audio, !modShiftsPitchWithRate(sides[0].score.mods));
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
      const [scoreLeft, scoreRight] = await Promise.all([
        getScore({ data: { scoreId: leftScoreId, mode: "mania" } }).catch(() => null),
        getScore({ data: { scoreId: rightScoreId, mode: "mania" } }).catch(() => null),
      ]);
      if (cancelled) return;
      if (!scoreLeft || !scoreRight) throw new Error("Couldn't load one of the scores.");
      const issue = getSideBySideIssue(scoreLeft, scoreRight);
      if (issue) throw new Error(issue.message);
      const beatmapId = scoreLeft.beatmap!.id;
      const beatmapFilePromise = getBeatmapFile({
        data: { beatmapId, beatmapsetId: scoreLeft.beatmapset?.id, checksum: scoreLeft.beatmap?.checksum },
      }).catch(() => null);
      const [sideLeft, sideRight] = await Promise.all([
        loadSide(scoreLeft, beatmapFilePromise),
        loadSide(scoreRight, beatmapFilePromise),
      ]);
      if (!cancelled) setSides([sideLeft, sideRight]);
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
  }, [leftScoreId, rightScoreId]);

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
        const canvases = [canvasLeftRef.current, canvasRightRef.current];
        const created: ReplayRendererLike[] = [];
        for (const [index, side] of sides.entries()) {
          const canvas = canvases[index];
          if (!canvas) throw new Error("The side-by-side playfields failed to mount.");
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
              // Bare stages: the middle column is the HUD here, and two copies
              // of every overlay (keypresses included) would just crowd the
              // playfields. Combo stays, since it belongs over the notes.
              hideHud: true,
              showCombo: true,
              showHealthBar: false,
              hidePerformanceStats: true,
              liveStats: true,
              scrollVelocities: side.beatmap?.scrollVelocities,
              expectedCounts: getScoreExpectedCounts(side.score, side.replay),
              realTotalScore: getRealTotalScore(side),
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
          // prediction drift-free.
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

  useEffect(() => {
    if (!ready) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (clockRef.current.playing) pause();
        else play();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBoth(readClockTime() - 2000);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekBoth(readClockTime() + 2000);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pause, play, readClockTime, ready, seekBoth]);

  const stats = useLiveStats(renderersRef, ready);
  const toggle = useCallback(() => {
    if (clockRef.current.playing) pause();
    else play();
  }, [pause, play]);

  const heatmap = useMemo(() => {
    const frames = sides?.[0]?.replay.frames ?? [];
    if (frames.length < 2) return [];
    return buildKeypressHeatmap(frames, frames[frames.length - 1].time);
  }, [sides]);

  // Rate-adjusted, so DT runs read as the chart the players actually saw.
  const stars = useMemo(() => {
    const side = sides?.[0];
    if (!side?.beatmap || side.beatmap.notes.length === 0) return null;
    return calculateManiaStarRating(side.beatmap.notes, side.beatmap.keyCount, side.rate);
  }, [sides]);

  // Both interstitials fill the same stage the comparison will, so the page
  // doesn't jump when the replays land.
  if (loading) {
    return (
      <div className="flex h-[calc(100dvh-60px)] flex-col items-center justify-center px-4 text-center">
        <div className="mb-4 h-10 w-10 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
        <p className="text-sm font-semibold text-osu-l2">Loading both replays...</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-osu-f1">Fetching the two runs and the beatmap.</p>
        <button
          type="button"
          onClick={onExit}
          className="mt-5 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-white/20 hover:text-white cursor-pointer"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (error || !sides) {
    return (
      <div className="flex h-[calc(100dvh-60px)] flex-col items-center justify-center px-4 text-center">
        <div className="text-sm font-bold text-white">Couldn't start the comparison</div>
        <div className="mt-2 max-w-[460px] text-[12px] text-osu-f1">{error ?? "Something went wrong."}</div>
        <button
          type="button"
          onClick={onExit}
          className="mt-5 rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white hover:brightness-110 transition cursor-pointer"
        >
          Pick two scores
        </button>
      </div>
    );
  }

  const beatmapsetId = sides[0].score.beatmapset?.id;
  const coverUrl = beatmapsetId ? `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/cover@2x.jpg` : null;

  return (
    <div className="relative flex h-[calc(100dvh-60px)] flex-col overflow-hidden bg-[#07070b]">
      {coverUrl && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute inset-0 scale-110 bg-cover bg-center blur-xl" style={{ backgroundImage: `url(${coverUrl})` }} />
          <div className="absolute inset-0 bg-[#07070b]/85" />
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col gap-2 px-2 py-2 sm:px-3">
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2">
          <PlayerHeader side={sides[0]} accentIndex={0} />
          <MapHeader side={sides[0]} stars={stars} onExit={onExit} />
          <PlayerHeader side={sides[1]} accentIndex={1} align="right" />
        </div>

        <ScoreLeadBar sides={sides} stats={stats} />

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(190px,250px)_minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(250px,300px)_minmax(0,1fr)]">
          <Stage canvasRef={canvasLeftRef} ready={ready} accentIndex={0} onToggle={toggle} />
          <StatsColumn stats={stats} />
          <Stage canvasRef={canvasRightRef} ready={ready} accentIndex={1} onToggle={toggle} />
        </div>

        <div className="shrink-0 border-t border-white/[0.07] px-1 pt-2">
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
                fillTrack
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
              {SPEED_OPTIONS.map((option) => (
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
          <MapFacts side={sides[0]} className="mt-2 hidden sm:flex" />
        </div>
      </div>
    </div>
  );
}

// The stats tick 10 times a second; memoised so that never touches the two
// canvases sitting either side of it.
const Stage = memo(function Stage({ canvasRef, ready, accentIndex, onToggle }: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  ready: boolean;
  accentIndex: 0 | 1;
  onToggle: () => void;
}) {
  return (
    <div className={`relative min-h-0 overflow-hidden rounded-lg bg-black/55 ring-1 ${SIDE_ACCENTS[accentIndex].ring}`}>
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" onClick={onToggle} />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-osu-pink" strokeWidth={2.4} />
        </div>
      )}
    </div>
  );
});

// A readout of the renderers, not its own simulation: it polls them on a slow
// tick instead of re-judging the replays.
function useLiveStats(renderersRef: RefObject<ReplayRendererLike[]>, ready: boolean): (ReplayLiveStats | null)[] {
  const [stats, setStats] = useState<(ReplayLiveStats | null)[]>([null, null]);

  useEffect(() => {
    if (!ready) return;
    const read = () => setStats(renderersRef.current.map((renderer) => renderer.getLiveStats?.() ?? null));
    read();
    const id = window.setInterval(read, 100);
    return () => window.clearInterval(id);
  }, [ready, renderersRef]);

  return stats;
}

// A lead of this much of the leader's score pushes the bar all the way over.
// Mania scores run close together, so a raw share of the total would sit
// pinned at the halfway mark all run.
const LEAD_BAR_FULL_SWING = 0.05;
const LEAD_BAR_MAX_TILT = 0.42;

// The tournament-overlay scoreboard: one bar whose split sits in the middle
// while the runs are level and slides toward whoever is behind, so the leader
// takes more of it. The scores read underneath, leader bright.
function ScoreLeadBar({ sides, stats }: { sides: [SideBySideSide, SideBySideSide]; stats: (ReplayLiveStats | null)[] }) {
  const leftScore = stats[0]?.score ?? 0;
  const rightScore = stats[1]?.score ?? 0;
  const lead = leftScore - rightScore;
  const reference = Math.max(leftScore, rightScore, 1) * LEAD_BAR_FULL_SWING;
  const tilt = Math.max(-1, Math.min(1, lead / reference));
  const leftShare = 0.5 + tilt * LEAD_BAR_MAX_TILT;
  const leader: 0 | 1 | null = lead === 0 ? null : lead > 0 ? 0 : 1;
  const deltaLabel = lead === 0 ? null : `-${Math.abs(Math.round(lead)).toLocaleString("en-US")}`;

  return (
    <div className="shrink-0">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-osu-b4">
        <div
          className="absolute inset-y-0 left-0 bg-osu-pink transition-[width] duration-300 ease-out"
          style={{ width: `${leftShare * 100}%` }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-osu-blue transition-[width] duration-300 ease-out"
          style={{ width: `${(1 - leftShare) * 100}%` }}
        />
        <div
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/80 transition-[left] duration-300 ease-out"
          style={{ left: `${leftShare * 100}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-center gap-3">
        <LeadScore
          side={sides[0]}
          stats={stats[0]}
          accentIndex={0}
          state={leader == null ? "tied" : leader === 0 ? "leading" : "trailing"}
          delta={leader === 1 ? deltaLabel : null}
          align="right"
        />
        <span className="text-[9px] uppercase tracking-[0.2em] text-white/30">Score</span>
        <LeadScore
          side={sides[1]}
          stats={stats[1]}
          accentIndex={1}
          state={leader == null ? "tied" : leader === 1 ? "leading" : "trailing"}
          delta={leader === 0 ? deltaLabel : null}
          align="left"
        />
      </div>
    </div>
  );
}

function LeadScore({ side, stats, accentIndex, state, delta, align }: {
  side: SideBySideSide;
  stats: ReplayLiveStats | null;
  accentIndex: 0 | 1;
  state: "leading" | "trailing" | "tied";
  /** Only set on the side that is behind. */
  delta: string | null;
  align: "left" | "right";
}) {
  const value = stats
    ? side.usesLazerScoring ? formatLazerScore(stats.score) : formatStableScore(stats.score)
    : side.usesLazerScoring ? "0" : "00000000";
  const tone = state === "leading"
    ? `font-black ${SIDE_ACCENTS[accentIndex].text}`
    : state === "tied"
      ? "font-bold text-white/75"
      : "font-bold text-white/45";
  return (
    <span className={`flex flex-1 items-baseline gap-2 ${align === "right" ? "justify-end" : "flex-row-reverse justify-end"}`}>
      {delta && <span className="text-[11px] font-semibold tabular-nums text-white/35">{delta}</span>}
      <span className={`text-[26px] tabular-nums transition-colors ${tone}`}>{value}</span>
    </span>
  );
}

function PlayerHeader({ side, accentIndex, align = "left" }: {
  side: SideBySideSide;
  accentIndex: 0 | 1;
  align?: "left" | "right";
}) {
  const accent = SIDE_ACCENTS[accentIndex];
  const score = side.score;
  const name = score.user?.username ?? side.replay.header.playerName ?? "Unknown";
  const playedAt = getScoreTimestamp(score);
  const mods = getModDisplayList(score.mods);
  const right = align === "right";
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${right ? "flex-row-reverse text-right" : "text-left"}`}>
      <GradeImg grade={getDisplayedRank(score)} size={32} />
      <div className={`min-w-0 ${right ? "items-end" : "items-start"} flex flex-col gap-0.5`}>
        <div className={`flex min-w-0 items-center gap-1.5 ${right ? "flex-row-reverse" : ""}`}>
          <CountryFlag code={score.user?.country_code} size="md" decorative />
          {score.user?.username ? (
            <Link
              to="/player/$username"
              params={{ username: score.user.username }}
              target="_blank"
              rel="noopener noreferrer"
              className={`truncate text-[17px] font-bold ${accent.text} hover:underline underline-offset-2`}
            >
              {name}
            </Link>
          ) : (
            <span className="truncate text-[17px] font-bold text-white">{name}</span>
          )}
        </div>
        <div className={`flex items-center gap-2 ${right ? "flex-row-reverse" : ""}`}>
          {playedAt && <span className="text-[12px] tabular-nums text-white/55">{formatDate(playedAt)}</span>}
          {mods.length > 0 && (
            <span className="flex shrink-0 items-center gap-0.5">
              {mods.map((mod, index) => (
                <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.8} />
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MapHeader({ side, stars, onExit }: { side: SideBySideSide; stars: number | null; onExit: () => void }) {
  const set = side.score.beatmapset;
  const title = set?.title ?? side.beatmap?.title ?? "Unknown map";
  const artist = set?.artist ?? side.beatmap?.artist;
  const version = side.score.beatmap?.version ?? side.beatmap?.version;
  const beatmapsetId = set?.id;
  const mapUrl = beatmapsetId
    ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}${side.score.beatmap?.id ? `#mania/${side.score.beatmap.id}` : ""}`
    : null;
  return (
    <div className="flex min-w-0 max-w-[520px] flex-col items-center gap-1 px-2 text-center">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onExit}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-white/20 bg-white/15 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-white/25 cursor-pointer"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back
        </button>
        {stars != null && <StarRatingBadge stars={stars} size={1.45} />}
      </div>
      {mapUrl ? (
        <a
          href={mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-[14px] font-semibold text-white transition-colors hover:text-osu-pink-light"
          title={`${artist ? `${artist} - ` : ""}${title} [${version ?? ""}]`}
        >
          {artist ? `${artist} - ` : ""}{title}
        </a>
      ) : (
        <span className="min-w-0 truncate text-[14px] font-semibold text-white">{artist ? `${artist} - ` : ""}{title}</span>
      )}
      {version && <span className="min-w-0 truncate text-[12px] text-white/55">[{version}]</span>}
    </div>
  );
}

// Chart facts both runs share, so they sit once under the transport instead of
// twice in the header. Rate mods move BPM and length, so apply the rate.
function MapFacts({ side, className = "" }: { side: SideBySideSide; className?: string }) {
  const apiBeatmap = side.score.beatmap;
  const rate = side.rate;
  const keyCount = side.replay.keyCount;
  const bpm = apiBeatmap?.bpm ?? side.beatmap?.bpm;
  const lengthSeconds = apiBeatmap?.total_length ?? (side.beatmap ? side.beatmap.totalLength / 1000 : undefined);
  const od = apiBeatmap?.accuracy ?? side.beatmap?.od;
  const facts: { label: string; value: string }[] = [
    { label: "Keys", value: `${keyCount}K` },
    ...(od != null ? [{ label: "OD", value: od.toFixed(1) }] : []),
    ...(apiBeatmap?.drain != null ? [{ label: "HP", value: apiBeatmap.drain.toFixed(1) }] : []),
    ...(bpm != null ? [{ label: "BPM", value: String(Math.round(bpm * rate)) }] : []),
    ...(lengthSeconds != null ? [{ label: "Length", value: formatLength(lengthSeconds / rate) }] : []),
    ...(side.beatmap ? [{ label: "Notes", value: side.beatmap.notes.length.toLocaleString() }] : []),
    ...(rate !== 1 ? [{ label: "Rate", value: `${rate}x` }] : []),
  ];
  return (
    <div className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 ${className}`}>
      {facts.map((fact) => (
        <span key={fact.label} className="text-[10px] uppercase tracking-[0.14em] text-white/35">
          {fact.label} <span className="ml-0.5 font-bold tabular-nums normal-case tracking-normal text-white/70">{fact.value}</span>
        </span>
      ))}
    </div>
  );
}

function formatLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

interface StatRow {
  label: string;
  labelClass?: string;
  format: (stats: ReplayLiveStats) => string;
  /** Raw value the two sides are ranked on; omit for rows with no winner. */
  rank?: (stats: ReplayLiveStats) => number;
  better?: "higher" | "lower";
  valueClass?: string;
}

const JUDGEMENT_ROWS: StatRow[] = [
  { label: "MAX", labelClass: "text-osu-yellow", format: (s) => String(s.counts[1]), rank: (s) => s.counts[1], better: "higher" },
  { label: "300", labelClass: "text-osu-blue", format: (s) => String(s.counts[2]), rank: (s) => s.counts[2], better: "lower" },
  { label: "200", labelClass: "text-osu-green-light", format: (s) => String(s.counts[3]), rank: (s) => s.counts[3], better: "lower" },
  { label: "100", labelClass: "text-osu-green", format: (s) => String(s.counts[4]), rank: (s) => s.counts[4], better: "lower" },
  { label: "50", labelClass: "text-osu-orange", format: (s) => String(s.counts[5]), rank: (s) => s.counts[5], better: "lower" },
  { label: "MISS", labelClass: "text-osu-red-light", format: (s) => String(s.counts[6]), rank: (s) => s.counts[6], better: "lower" },
];

const TIMING_ROWS: StatRow[] = [
  { label: "Early", format: (s) => String(s.early) },
  { label: "Late", format: (s) => String(s.late) },
  { label: "Mean", format: (s) => `${s.meanOffsetMs >= 0 ? "+" : ""}${s.meanOffsetMs.toFixed(1)}ms`, rank: (s) => Math.abs(s.meanOffsetMs), better: "lower" },
  // MAX-to-300 ratio, the number mania players quote for how clean the taps
  // were. Undefined until the run has dropped a 300.
  { label: "Ratio", format: (s) => (s.counts[2] > 0 ? (s.counts[1] / s.counts[2]).toFixed(2) : "-"), rank: (s) => (s.counts[2] > 0 ? s.counts[1] / s.counts[2] : 0), better: "higher" },
  { label: "Judged", format: (s) => String(s.totalJudgements) },
];

const HEADLINE_ROWS: StatRow[] = [
  { label: "Accuracy", format: (s) => `${s.accuracy.toFixed(2)}%`, rank: (s) => s.accuracy, better: "higher", valueClass: "text-[19px]" },
  { label: "UR", format: (s) => s.unstableRate.toFixed(2), rank: (s) => s.unstableRate, better: "lower", valueClass: "text-[16px]" },
];

const PP_ROWS: StatRow[] = [
  {
    label: "PP",
    format: (s) => (s.maxPp > 0 ? `${Math.round(s.pp)}/${Math.round(s.maxPp)}` : String(Math.round(s.pp))),
    rank: (s) => s.pp,
    better: "higher",
    valueClass: "text-[16px]",
  },
];

// Deliberately unboxed: the stages either side carry their own frames, so
// panelling these numbers as well just stacks borders in the middle of the
// screen. One centred block, hairlines between the groups.
function StatsColumn({ stats }: { stats: (ReplayLiveStats | null)[] }) {
  const left = stats[0] ?? null;
  const right = stats[1] ?? null;

  return (
    <div className="flex min-h-0 flex-col justify-center gap-3.5 overflow-y-auto px-1 py-2">
      <StatGroup rows={HEADLINE_ROWS} left={left} right={right} />
      <StatGroup rows={JUDGEMENT_ROWS} left={left} right={right} divider />
      <StatGroup rows={TIMING_ROWS} left={left} right={right} divider />
      <StatGroup rows={PP_ROWS} left={left} right={right} divider />
    </div>
  );
}

function StatGroup({ rows, left, right, divider = false }: {
  rows: StatRow[];
  left: ReplayLiveStats | null;
  right: ReplayLiveStats | null;
  divider?: boolean;
}) {
  return (
    <div className={divider ? "border-t border-white/[0.07] pt-3.5" : ""}>
      {rows.map((row) => (
        <StatLine key={row.label} row={row} left={left} right={right} />
      ))}
    </div>
  );
}

function StatLine({ row, left, right }: { row: StatRow; left: ReplayLiveStats | null; right: ReplayLiveStats | null }) {
  // Whoever is ahead on this line right now reads bright; the other dims. It
  // is the whole point of the column, so it has to be legible at a glance.
  let leader: 0 | 1 | null = null;
  if (left && right && row.rank && row.better) {
    const a = row.rank(left);
    const b = row.rank(right);
    if (a !== b) leader = (row.better === "higher") === (a > b) ? 0 : 1;
  }
  const valueClass = (index: 0 | 1) =>
    `truncate font-bold tabular-nums ${row.valueClass ?? "text-[15px]"} ${
      leader == null ? "text-white/85" : leader === index ? "text-white" : "text-white/40"
    }`;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline gap-x-2.5 py-[3px]">
      <span className={`${valueClass(0)} text-right`}>{left ? row.format(left) : "-"}</span>
      <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${row.labelClass ?? "text-white/40"}`}>{row.label}</span>
      <span className={`${valueClass(1)} text-left`}>{right ? row.format(right) : "-"}</span>
    </div>
  );
}
