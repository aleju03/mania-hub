import { Link } from "@tanstack/react-router";
import { ChevronLeft, LoaderCircle, Maximize2, Minimize2, Pause, Play, SlidersHorizontal, Smartphone, Volume2, VolumeX } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { getBeatmapAudioUrl, getInlineBackgroundUrl } from "../../lib/audio-url";
import type { ManiaBeatmap } from "../../lib/beatmap-parser";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { formatDate } from "../../lib/format";
import { useViewerTimeZone } from "../../lib/use-viewer-time-zone";
import {
  exitNativeFullscreen,
  getNativeFullscreenElement,
  lockLandscapeOrientation,
  requestNativeFullscreen,
  unlockOrientation,
} from "../../lib/fullscreen";
import { formatLazerScore, formatStableScore } from "../../lib/mania-score-simulation";
import { calculateManiaStarRating } from "../../lib/mania-star-rating";
import { getBeatmapFile, getReplayParsed, getScore } from "../../lib/osu";
import { parseCachedManiaBeatmap } from "../../lib/parsed-beatmap-cache";
import { withTimeout } from "../../lib/promise-timeout";
import { unpackReplayFrames } from "../../lib/replay-frames";
import { buildKeypressHeatmap } from "../../lib/replay-keypress-heatmap";
import {
  readReplayBackgroundDim,
  readReplayStoryboardEnabled,
  readReplayVolume,
  writeReplayBackgroundDim,
  writeReplayStoryboardEnabled,
} from "../../lib/replay-preferences";
import { readReplayScrollSpeed } from "../../lib/replay-scroll-speed";
import {
  SIDE_BY_SIDE_PORTRAIT_PHONE_QUERY,
  SIDE_BY_SIDE_SHORT_VIEWPORT_QUERY,
  SIDE_BY_SIDE_TOUCH_QUERY,
  formatSideBySideIssue,
  getSideBySideIssue,
  resolveSideBySideLayout,
  type SideBySideViewport,
} from "../../lib/replay-side-by-side";
import { readReplaySkinSettings } from "../../lib/replay-skin";
import { loadReplayStoryboard, type LoadedReplayStoryboard } from "../../lib/replay-storyboard";
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
   middle column, where the two runs sit on the same line. Combo and the
   judgement pop stay, because both belong over the notes rather than to the
   chrome - a stage that never tells you what a hit was judged as is not a
   replay you can read.

   The two stages have no frames of their own: they are transparent canvases
   over one full-bleed map background, each drawing nothing but its own black
   playfield, pulled toward the middle column (playfieldAlign) so the pair
   reads as one screen instead of two panels pushed to opposite edges.

   Phones get the whole screen: on a touch device the stage covers the navbar
   the moment it opens, and the first play asks for real fullscreen plus a
   landscape lock (best effort - iPhone Safari has neither, hence the overlay
   underneath it). Short viewports switch to a compact chrome so the two
   playfields, not the headers, own the height. Rotating never remounts: a
   portrait phone parks the loaded replays behind a rotate prompt instead of
   tearing them down, so turning back is instant and costs no refetch. */

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.5, 2];

// Close enough to the transport that re-seeking the track would cost more (an
// audible seek) than the offset does.
const AUDIO_SEEK_EPSILON_MS = 40;
// The track is treated as spent this far from its end: seeking to within a
// frame of the end lands on it, and an ended element rewinds itself on play().
const AUDIO_TAIL_GUARD_MS = 40;
// How long both playfields may sit on the audio's stall before the run is
// handed to the wall clock and carries on silently. Long enough for ordinary
// buffering to recover, short enough that an interruption never looks frozen.
const AUDIO_STALL_GIVE_UP_MS = 2500;

interface SideBySideSide {
  score: OsuScore;
  replay: ServerReplay;
  beatmap: ManiaBeatmap | null;
  /* Mod rate (DT 1.5 / HT 0.75 / lazer custom). */
  rate: number;
  usesLazerScoring: boolean;
}

const SIDE_ACCENTS = [
  { text: "text-osu-pink-light" },
  { text: "text-osu-blue" },
] as const;

// How far each playfield is pushed toward the stats column, as a share of the
// slack in its half (0 = flush left, 1 = flush right). Short of the edge, so
// the two runs sit next to the numbers rather than against them.
const SIDE_PLAYFIELD_ALIGN = [0.88, 0.12] as const;

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
  const { t, i18n } = useLingui();
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasLeftRef = useRef<HTMLCanvasElement>(null);
  const canvasRightRef = useRef<HTMLCanvasElement>(null);
  const storyboardCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderersRef = useRef<ReplayRendererLike[]>([]);
  /* The full-bleed storyboard layer, when one is loaded and switched on. It
     follows the same clock as the two stages but draws no playfield. */
  const storyboardRendererRef = useRef<ReplayRendererLike | null>(null);
  const masterRendererRef = useRef<ReplayRendererLike | null>(null);
  /* Shared map-time clock both renderers follow via setExternalClock. */
  const clockRef = useRef({ anchorPerf: 0, anchorTime: 0, playing: false, speed: 1, rate: 1 });
  const maxDurationRef = useRef(0);
  const scrubResumeRef = useRef(false);

  const [sides, setSides] = useState<[SideBySideSide, SideBySideSide] | null>(null);
  /* Raw .osu text of the (shared) chart: the storyboard loader reads the
     embedded [Events] and the widescreen flag out of it. */
  const [beatmapFileContent, setBeatmapFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioEnabledRef = useRef(true);
  const audioFailedRef = useRef(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [audioFailed, setAudioFailed] = useState(false);
  const [buffering, setBuffering] = useState(false);

  const viewport = useSideBySideViewport();
  const [fullscreen, setFullscreen] = useState(false);
  const layout = resolveSideBySideLayout(viewport, fullscreen);
  // Real fullscreen needs a user gesture, so the first play doubles as one.
  // Once per mount only: leaving fullscreen and hitting play again must not
  // drag the phone back in.
  const autoFullscreenRef = useRef(false);

  /* THE CLOCK. When the track is playable it is the clock: audio.currentTime
     is map time (the chart is timed against this file), it advances at
     playbackRate = transport speed x mod rate, and it is the one timeline that
     cannot be argued with. The playfields follow it, exactly as the single
     replay viewer does.

     Chasing it the other way round - a performance.now() clock with the audio
     seeked back onto it - is what made this stutter: writing currentTime mid
     playback IS an audible seek, and the latency of the seek itself puts the
     drift straight back over any threshold, so the corrections never stop.
     Nothing here writes currentTime while playing except a user seek.

     The wall clock below stays as the understudy for the runs with no track,
     a muted transport, or a file that failed. */
  const audioMasterRef = useRef(false);
  /* performance.now() of the first tick that found the master clock stalled;
     0 while it is running. */
  const audioStalledSinceRef = useRef(0);

  const readWallClockTime = useCallback(() => {
    const clock = clockRef.current;
    if (!clock.playing) return clock.anchorTime;
    return clock.anchorTime + (performance.now() - clock.anchorPerf) * clock.speed * clock.rate;
  }, []);

  /* What every renderer on this screen - both stages and the storyboard layer
     - reads its time from. */
  const readSharedClock = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audioMasterRef.current) {
      return {
        time: audio.currentTime * 1000,
        stalled: audio.paused || audio.seeking || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      };
    }
    return { time: readWallClockTime(), stalled: !clockRef.current.playing };
  }, [readWallClockTime]);

  const readClockTime = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audioMasterRef.current) return audio.currentTime * 1000;
    return readWallClockTime();
  }, [readWallClockTime]);

  /* Hands the timeline back to the wall clock, so a mute, a failed file, an
     interruption or a refused play() never strands the transport (a stalled
     master clock freezes both playfields indefinitely). Takes the position to
     resume from, because the caller sometimes knows it better than the track
     does - past the end of the audio, currentTime has been clamped. */
  const releaseAudioClock = useCallback((atMs?: number) => {
    if (!audioMasterRef.current) return;
    const clock = clockRef.current;
    clock.anchorTime = atMs ?? readClockTime();
    clock.anchorPerf = performance.now();
    audioMasterRef.current = false;
  }, [readClockTime]);

  /* Puts the track where the transport is and decides who owns the clock.

     The guard that matters: a chart outlives its mp3 more often than not
     (totalDuration runs to the last frame plus a miss window, the audio is cut
     at the last note), and play() on an element sitting at its end is spec'd to
     rewind it to zero. Handing the clock to that would drag both playfields
     back to the start mid-run. Past the end of the track, only the wall clock
     can carry the tail - which is exactly what it already does after `ended`. */
  const alignAudio = useCallback((timeMs: number, resume: boolean) => {
    const audio = audioRef.current;
    if (!audio || !audioEnabledRef.current || audioFailedRef.current) return;
    const endMs = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : Infinity;
    if (timeMs >= endMs - AUDIO_TAIL_GUARD_MS) {
      releaseAudioClock(timeMs);
      audio.pause();
      return;
    }
    if (Math.abs(audio.currentTime * 1000 - timeMs) > AUDIO_SEEK_EPSILON_MS) {
      audio.currentTime = Math.max(0, timeMs / 1000);
    }
    if (!resume) return;
    // Authority passes to the track now, before it has actually started: until
    // it does it reports stalled, which holds both playfields on this frame.
    // Running them off the wall clock for those first tens of milliseconds
    // would only make them snap back when the sound arrives.
    audioMasterRef.current = true;
    audioStalledSinceRef.current = 0;
    // Refused (autoplay policy, no gesture, decode failure): the wall clock
    // keeps the run going silently rather than freezing both playfields on a
    // clock that will never tick.
    void audio.play().catch(() => releaseAudioClock());
  }, [releaseAudioClock]);

  // The rate-match guard means both players heard the same song at the same
  // rate, so one audio track is correct for both sides.
  const audioUrl = useMemo(() => {
    const setId = sides?.[0]?.score.beatmapset?.id;
    const filename = sides?.[0]?.beatmap?.audioFilename;
    return setId && filename ? getBeatmapAudioUrl(setId, filename) : null;
  }, [sides]);

  useEffect(() => {
    audioMasterRef.current = false;
    audioFailedRef.current = false;
    setAudioFailed(false);
  }, [audioUrl]);

  const beatmapsetId = sides?.[0]?.score.beatmapset?.id;
  const backgroundFilename = sides?.[0]?.beatmap?.backgroundFilename;

  /* The map's own background, full bleed behind both stages - the same image
     the single viewer puts behind its playfield, at the dim set here (shared
     with that viewer's setting). The archive copy is the real thing; the set
     cover (same proxy, no filename) covers maps whose archive we can't read. */
  const [coverFallback, setCoverFallback] = useState(false);
  const [backgroundLoaded, setBackgroundLoaded] = useState(false);
  const backgroundUrl = useMemo(() => {
    if (!beatmapsetId) return null;
    const base = `/api/background?beatmapsetId=${encodeURIComponent(String(beatmapsetId))}`;
    return backgroundFilename && !coverFallback
      ? `${base}&filename=${encodeURIComponent(backgroundFilename)}`
      : base;
  }, [backgroundFilename, beatmapsetId, coverFallback]);
  useEffect(() => {
    setCoverFallback(false);
    setBackgroundLoaded(false);
  }, [beatmapsetId, backgroundFilename]);

  const [backgroundDim, setBackgroundDim] = useState(readReplayBackgroundDim);
  // Read when the storyboard layer is built, which can happen long after the
  // slider was last moved.
  const dimRef = useRef(backgroundDim);
  useEffect(() => {
    dimRef.current = backgroundDim;
    writeReplayBackgroundDim(backgroundDim);
    // Only the storyboard layer draws its own background; the two stages are
    // transparent and take the dim from the DOM layer underneath them.
    storyboardRendererRef.current?.setBackgroundDim(backgroundDim);
  }, [backgroundDim]);

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
    setBeatmapFileContent(null);
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
      if (!scoreLeft || !scoreRight) throw new Error(t`Couldn't load one of the scores.`);
      const issue = getSideBySideIssue(scoreLeft, scoreRight);
      if (issue) throw new Error(formatSideBySideIssue(issue, i18n));
      const beatmapId = scoreLeft.beatmap!.id;
      const beatmapFilePromise = getBeatmapFile({
        data: { beatmapId, beatmapsetId: scoreLeft.beatmapset?.id, checksum: scoreLeft.beatmap?.checksum },
      }).catch(() => null);
      const [sideLeft, sideRight, beatmapFile] = await Promise.all([
        loadSide(scoreLeft, beatmapFilePromise),
        loadSide(scoreRight, beatmapFilePromise),
        beatmapFilePromise,
      ]);
      if (cancelled) return;
      setBeatmapFileContent(beatmapFile?.content ?? null);
      setSides([sideLeft, sideRight]);
    })()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t`Failed to load the replays.`);
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

    void (async () => {
      try {
        const { ManiaReplayRenderer } = await withTimeout(
          import("./ReplayCanvas"),
          8000,
          t`Timed out loading the replay renderer.`,
        );
        if (cancelled) return;
        const skinSettings = readReplaySkinSettings();
        const scrollSpeed = readReplayScrollSpeed();
        const canvases = [canvasLeftRef.current, canvasRightRef.current];
        const created: ReplayRendererLike[] = [];
        for (const [index, side] of sides.entries()) {
          const canvas = canvases[index];
          if (!canvas) throw new Error(t`The side-by-side playfields failed to mount.`);
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
              // The map's background is one image under both canvases, and the
              // lanes are solid black over it, the way the game draws them:
              // the notes have to read at a glance on both stages at once.
              transparentBackground: true,
              blackPlayfield: true,
              // Bare stages: the middle column is the HUD here, and two copies
              // of every overlay (keypresses included) would just crowd the
              // playfields. Combo and the judgement pop stay, since both belong
              // over the notes.
              hideHud: true,
              showCombo: true,
              showJudgements: true,
              // Pulled toward the middle so the runs sit beside the numbers.
              playfieldAlign: SIDE_PLAYFIELD_ALIGN[index],
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
          t`Timed out starting the replay renderers.`,
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
          // Always an object, never null: null would let each renderer free-run
          // on its own internal clock, and two runs on two clocks is the one
          // thing this view cannot ship. While the audio buffers or seeks it
          // reports stalled, which holds BOTH playfields on the same frame
          // instead of letting them run ahead of the sound.
          renderer.setExternalClock(readSharedClock);
          // playbackSpeed only feeds the renderer's clock smoothing; matching
          // each side's effective rate to the shared clock keeps the
          // prediction drift-free.
          renderer.setSpeed((clock.speed * sides[0].rate) / sides[index].rate);
          renderer.seek(0);
        }
        renderersRef.current = created;
        masterRendererRef.current = created[0] ?? null;
        maxDurationRef.current = Math.max(...created.map((renderer) => renderer.duration));
        setSpeed(1);
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t`Failed to start the replay renderers.`);
      }
    })();

    return () => {
      cancelled = true;
      for (const renderer of renderersRef.current) renderer.destroy();
      renderersRef.current = [];
      masterRendererRef.current = null;
      setReady(false);
      setIsPlaying(false);
    };
  }, [readSharedClock, sides]);

  /* Storyboard. Fetched once per map (the bundle plus the .osu-embedded
     events), kept across toggles so switching it back on costs no refetch and
     no reparse, and drawn by one full-bleed renderer behind both stages: a
     storyboard is authored for a screen, and a copy squeezed into each half
     would be centred on neither playfield. */
  const [storyboardEnabled, setStoryboardEnabled] = useState(readReplayStoryboardEnabled);
  const [storyboardData, setStoryboardData] = useState<LoadedReplayStoryboard | null>(null);
  const [storyboardStatus, setStoryboardStatus] = useState<"idle" | "loading" | "active" | "unavailable" | "error">("idle");

  useEffect(() => {
    writeReplayStoryboardEnabled(storyboardEnabled);
  }, [storyboardEnabled]);

  // The object URLs behind the sprites belong to the handle, so the one that
  // is being replaced (new map) or dropped (unmount) has to free them.
  useEffect(() => () => storyboardData?.dispose(), [storyboardData]);

  useEffect(() => {
    setStoryboardData(null);
    setStoryboardStatus("idle");
  }, [leftScoreId, rightScoreId]);

  useEffect(() => {
    if (!storyboardEnabled || !sides) return;
    if (storyboardData) return;
    if (beatmapFileContent == null && beatmapsetId == null) {
      setStoryboardStatus("unavailable");
      return;
    }
    let cancelled = false;
    setStoryboardStatus("loading");
    void loadReplayStoryboard({
      beatmapsetId: beatmapsetId ?? null,
      osuFileContent: beatmapFileContent,
      backgroundFilename: backgroundFilename ?? null,
      notes: sides[0].beatmap?.notes ?? null,
      // The storyboard backdrop becomes a WebGL texture, so it needs
      // same-origin bytes rather than a 302 to signed storage.
      backgroundImageUrl: getInlineBackgroundUrl(backgroundUrl),
    })
      .then((loaded) => {
        if (cancelled) {
          loaded?.dispose();
          return;
        }
        if (!loaded) {
          setStoryboardStatus("unavailable");
          return;
        }
        setStoryboardData(loaded);
      })
      .catch(() => {
        if (!cancelled) setStoryboardStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [backgroundFilename, backgroundUrl, beatmapFileContent, beatmapsetId, sides, storyboardData, storyboardEnabled]);

  // The storyboard layer itself: created only once there is something to draw,
  // torn down the moment the toggle goes off, so a run without it costs no
  // extra WebGL context. It carries no replay of its own - empty frames over
  // the chart's notes give it the right duration and nothing to judge.
  useEffect(() => {
    if (!ready || !sides || !storyboardEnabled || !storyboardData) return;
    let cancelled = false;
    void (async () => {
      try {
        const { ManiaReplayRenderer } = await import("./ReplayCanvas");
        const canvas = storyboardCanvasRef.current;
        if (cancelled || !canvas) return;
        const renderer = new ManiaReplayRenderer(canvas, [], sides[0].replay.keyCount, sides[0].beatmap?.notes ?? [], {
          storyboardOnly: true,
          transparentBackground: true,
          hideHud: true,
          showHealthBar: false,
          hidePerformanceStats: true,
          backgroundDim: dimRef.current,
          mods: sides[0].score.mods,
          speedMultiplier: sides[0].rate,
          timingPoints: sides[0].beatmap?.timingPoints,
        }) as ReplayRendererLike;
        await renderer.ready();
        if (cancelled) {
          renderer.destroy();
          return;
        }
        renderer.setStoryboard?.(storyboardData.data);
        renderer.setExternalClock(readSharedClock);
        renderer.setSpeed(clockRef.current.speed);
        renderer.seek(readClockTime());
        if (clockRef.current.playing) renderer.play();
        storyboardRendererRef.current = renderer;
        const texturesReady = renderer.storyboardReady?.();
        if (!texturesReady) {
          setStoryboardStatus("active");
          return;
        }
        void texturesReady.then(() => {
          if (!cancelled) setStoryboardStatus("active");
        });
      } catch {
        if (!cancelled) setStoryboardStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      storyboardRendererRef.current?.destroy();
      storyboardRendererRef.current = null;
    };
  }, [readClockTime, readSharedClock, ready, sides, storyboardData, storyboardEnabled]);

  const storyboardActive = storyboardEnabled && storyboardStatus === "active";

  /* Everything the transport drives: the two stages, plus the storyboard layer
     when one is up. They all read the same clock, so they all have to be
     started, stopped and seeked together. */
  const allRenderers = useCallback((): ReplayRendererLike[] => {
    const storyboardRenderer = storyboardRendererRef.current;
    return storyboardRenderer ? [...renderersRef.current, storyboardRenderer] : renderersRef.current;
  }, []);

  const resizeRenderers = useCallback(() => {
    for (const renderer of allRenderers()) renderer.resize();
  }, [allRenderers]);

  const enterFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // The overlay goes up first and stands on its own if the request is
    // refused: iPhone Safari has no element fullscreen to give.
    setFullscreen(true);
    void (async () => {
      const entered = await requestNativeFullscreen(container).catch(() => false);
      if (entered) {
        await lockLandscapeOrientation();
        return;
      }
      // Refused, and a phone is already showing the overlay: drop the flag so
      // the button doesn't offer an exit from something that never happened.
      if (viewport.touch) setFullscreen(false);
    })();
  }, [viewport.touch]);

  const exitFullscreen = useCallback(() => {
    setFullscreen(false);
    unlockOrientation();
    if (getNativeFullscreenElement()) void exitNativeFullscreen().catch(() => {});
  }, []);

  // The browser's own exits - Esc, the Android back gesture, the swipe-down
  // pill - have to put the button and the layout back in sync.
  useEffect(() => {
    const onFullscreenChange = () => {
      if (getNativeFullscreenElement()) return;
      setFullscreen(false);
      unlockOrientation();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  // Leaving the comparison must never strand the phone fullscreen or locked
  // to landscape. The node is captured on mount: by cleanup time the ref may
  // already be detached.
  useEffect(() => {
    const container = containerRef.current;
    return () => {
      unlockOrientation();
      if (container && getNativeFullscreenElement() === container) void exitNativeFullscreen().catch(() => {});
    };
  }, []);

  // Nothing behind the overlay should scroll or rubber-band under a finger.
  useEffect(() => {
    if (!layout.overlay || typeof document === "undefined") return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overscrollBehavior = previousOverscroll;
    };
  }, [layout.overlay]);

  // A rotation, the mobile browser chrome sliding away, entering fullscreen:
  // each one changes the canvas box, and the renderers only re-measure when
  // told to. Watching the stage catches every cause in one place.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stage = stageRef.current;
    if (stage && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => window.requestAnimationFrame(resizeRenderers));
      observer.observe(stage);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", resizeRenderers);
    return () => window.removeEventListener("resize", resizeRenderers);
  }, [ready, resizeRenderers]);

  // Phones report the pre-rotation viewport for a beat afterwards, so measure
  // again once it has settled.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const timeouts: number[] = [];
    const onOrientationChange = () => {
      window.requestAnimationFrame(resizeRenderers);
      timeouts.push(window.setTimeout(resizeRenderers, 200), window.setTimeout(resizeRenderers, 500));
    };
    const orientation = window.screen?.orientation;
    window.addEventListener("orientationchange", onOrientationChange);
    orientation?.addEventListener("change", onOrientationChange);
    return () => {
      for (const id of timeouts) window.clearTimeout(id);
      window.removeEventListener("orientationchange", onOrientationChange);
      orientation?.removeEventListener("change", onOrientationChange);
    };
  }, [resizeRenderers]);

  const pause = useCallback(() => {
    const clock = clockRef.current;
    clock.anchorTime = Math.min(readClockTime(), maxDurationRef.current);
    clock.playing = false;
    for (const renderer of allRenderers()) renderer.pause();
    // Left where it is, not rewound: resuming then costs no seek at all.
    audioRef.current?.pause();
    setIsPlaying(false);
  }, [allRenderers, readClockTime]);

  // Turning the phone upright parks the playfields behind the rotate prompt;
  // stop the transport there instead of letting it run on blind.
  useEffect(() => {
    if (layout.rotatePrompt) pause();
  }, [layout.rotatePrompt, pause]);

  const play = useCallback(() => {
    if (renderersRef.current.length === 0) return;
    // This tap is the gesture fullscreen needs, and a phone watching two
    // playfields wants every pixel of the screen.
    if (viewport.touch && !autoFullscreenRef.current) {
      autoFullscreenRef.current = true;
      enterFullscreen();
    }
    const clock = clockRef.current;
    // Replaying from the end restarts the run.
    const restart = readClockTime() >= maxDurationRef.current - 1;
    const startAt = restart ? 0 : readClockTime();
    if (restart) {
      for (const renderer of allRenderers()) renderer.seek(0);
    }
    clock.anchorTime = startAt;
    clock.anchorPerf = performance.now();
    clock.playing = true;
    for (const renderer of allRenderers()) renderer.play();
    alignAudio(startAt, true);
    setIsPlaying(true);
  }, [alignAudio, allRenderers, enterFullscreen, readClockTime, viewport.touch]);

  const seekBoth = useCallback((timeMs: number) => {
    const clock = clockRef.current;
    const clamped = Math.max(0, Math.min(timeMs, maxDurationRef.current));
    clock.anchorTime = clamped;
    clock.anchorPerf = performance.now();
    for (const renderer of allRenderers()) {
      renderer.seek(clamped);
      // The shorter run stops its own frame loop the moment it reaches its end
      // (ReplayCanvas.tick). Seeking back inside it has to restart that loop,
      // or it sits frozen beside a playfield that is still moving.
      if (clock.playing) renderer.play();
    }
    // The one place that writes currentTime mid-run, because the user asked for
    // it. Both playfields hold on `stalled` until the seek settles.
    alignAudio(clamped, clock.playing);
  }, [alignAudio, allRenderers]);

  const applySpeed = useCallback((next: number) => {
    if (!sides) return;
    const clock = clockRef.current;
    clock.anchorTime = readClockTime();
    clock.anchorPerf = performance.now();
    clock.speed = next;
    for (const [index, renderer] of renderersRef.current.entries()) {
      renderer.setSpeed((next * sides[0].rate) / sides[index].rate);
    }
    // The storyboard layer runs on the shared clock's own rate.
    storyboardRendererRef.current?.setSpeed(next);
    // playbackRate alone: the track keeps playing from where it is, and the
    // renderers' clock smoothing re-anchors on the new rate by itself.
    const audio = audioRef.current;
    if (audio) audio.playbackRate = next * clock.rate;
    setSpeed(next);
  }, [readClockTime, sides]);

  const toggleAudio = useCallback(() => {
    setAudioEnabled((enabled) => {
      const next = !enabled;
      audioEnabledRef.current = next;
      const audio = audioRef.current;
      if (audio) {
        if (next && !audioFailedRef.current) {
          // Unmuting mid-run: the one moment the track has to be put back onto
          // the transport, and a deliberate user action rather than a chase.
          alignAudio(readClockTime(), clockRef.current.playing);
        } else {
          releaseAudioClock();
          audio.pause();
        }
      }
      return next;
    });
  }, [alignAudio, readClockTime, releaseAudioClock]);

  // The shorter replay freezes on its last frame; stop the transport once the
  // longer one ends too. The same tick reads whether the track is holding both
  // playfields, which is the honest thing to show while it buffers - the
  // alternative, running the visuals on ahead of the sound, is the desync this
  // clock exists to prevent.
  useEffect(() => {
    if (!isPlaying) {
      setBuffering(false);
      audioStalledSinceRef.current = 0;
      return;
    }
    const id = window.setInterval(() => {
      const audio = audioRef.current;
      const stalled = Boolean(audio && audioMasterRef.current
        && (audio.paused || audio.seeking || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA));
      setBuffering(stalled);
      if (stalled && audio) {
        const now = performance.now();
        if (audioStalledSinceRef.current === 0) audioStalledSinceRef.current = now;
        // A pause nobody asked for - a call taking audio focus, a media key, a
        // backgrounded tab - stops the clock both playfields wait on. Every
        // pause of ours clears `playing` or mastership first, so anything that
        // reaches here is an interruption: try to take it back.
        if (audio.paused && !audio.seeking && !audio.ended
          && (typeof document === "undefined" || document.visibilityState === "visible")) {
          void audio.play().catch(() => {});
        }
        // Still nothing. Rather than hold the comparison on a frame forever,
        // carry on off the wall clock from where the sound got to; it plays on
        // silently instead of looking broken.
        if (now - audioStalledSinceRef.current > AUDIO_STALL_GIVE_UP_MS) releaseAudioClock();
      } else {
        audioStalledSinceRef.current = 0;
      }
      if (readClockTime() >= maxDurationRef.current) pause();
    }, 200);
    return () => {
      window.clearInterval(id);
      setBuffering(false);
    };
  }, [isPlaying, pause, readClockTime, releaseAudioClock]);

  // A track shorter than the longer replay must not take the run down with it,
  // and a file that fails mid-run must not freeze it: both hand the tail back
  // to the wall clock, which picks up from wherever the audio got to. Wrapped
  // rather than passed straight to onEnded, which would hand the DOM event in
  // as the resume position.
  const handleAudioEnded = useCallback(() => releaseAudioClock(), [releaseAudioClock]);

  const handleAudioError = useCallback(() => {
    audioFailedRef.current = true;
    releaseAudioClock();
    setAudioFailed(true);
  }, [releaseAudioClock]);

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

  // Escape leaves the overlay the same way it leaves real fullscreen; when the
  // browser gave us the real thing it fires fullscreenchange and this is a
  // no-op on top of it.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitFullscreen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitFullscreen, fullscreen]);

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

  const compact = layout.compact;

  // One root for every state - loading, failed, playing - because swapping the
  // wrapper out mid-flight would take the canvases (and both replays) with it.
  // The overlay/inline choice is a class on it, never a different tree.
  return (
    <div
      ref={containerRef}
      className={`flex flex-col overflow-hidden overscroll-none bg-[#07070b] ${
        layout.overlay ? "fixed inset-0 z-[100] h-[100dvh] w-screen" : "relative h-[calc(100dvh-60px)]"
      }`}
      // Notched phones in landscape put the camera cutout over the left or
      // right edge, exactly where a playfield would sit.
      style={layout.overlay
        ? { paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }
        : undefined}
    >
      {/* The map, once, behind everything. A live storyboard draws its own
          backdrop, background and dim on its canvas, so the still image and
          the DOM dim stand down the moment it is up. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {backgroundUrl && !storyboardActive && (
          <img
            key={backgroundUrl}
            src={backgroundUrl}
            alt=""
            onLoad={() => setBackgroundLoaded(true)}
            onError={() => setCoverFallback(true)}
            className={`absolute inset-0 h-full w-full scale-[1.02] select-none object-cover transition-opacity duration-500 ${
              backgroundLoaded ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
        {!storyboardActive && <div className="absolute inset-0 bg-black" style={{ opacity: backgroundDim / 100 }} />}
        {storyboardEnabled && storyboardData && (
          <canvas ref={storyboardCanvasRef} className="absolute inset-0 block h-full w-full" />
        )}
      </div>

      {/* Both interstitials fill the same stage the comparison will, so the
          page doesn't jump when the replays land. */}
      {loading && (
        <div className="relative flex flex-1 flex-col items-center justify-center px-4 text-center">
          <div className="mb-4 h-10 w-10 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
          <p className="text-sm font-semibold text-osu-l2">{t`Loading both replays...`}</p>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-osu-f1">{t`Fetching the two runs and the beatmap.`}</p>
          <button
            type="button"
            onClick={onExit}
            className="mt-5 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-white/20 hover:text-white cursor-pointer"
          >
            {t`Cancel`}
          </button>
        </div>
      )}

      {!loading && (error || !sides) && (
        <div className="relative flex flex-1 flex-col items-center justify-center px-4 text-center">
          <div className="text-sm font-bold text-white">{t`Couldn't start the comparison`}</div>
          <div className="mt-2 max-w-[460px] text-[12px] text-osu-f1">{error ?? t`Something went wrong.`}</div>
          <button
            type="button"
            onClick={onExit}
            className="mt-5 rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white hover:brightness-110 transition cursor-pointer"
          >
            {t`Pick two scores`}
          </button>
        </div>
      )}

      {sides && !error && (
        <div className={`relative flex min-h-0 flex-1 flex-col ${compact ? "px-1.5" : "px-2 sm:px-3"}`}>
          {/* The scoreboard block carries its own scrim: names, map and scores
              have to read over any map, and a gradient that ends inside the
              block does that without drawing a panel around it. */}
          <div
            className={`shrink-0 bg-gradient-to-b from-black/85 via-black/60 to-transparent ${
              compact ? "flex flex-col gap-1 pt-1 pb-2" : "flex flex-col gap-2 pt-2 pb-4"
            }`}
          >
            <div className={`grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] ${compact ? "items-center gap-1.5" : "items-start gap-2"}`}>
              <PlayerHeader side={sides[0]} accentIndex={0} compact={compact} />
              <MapHeader side={sides[0]} stars={stars} compact={compact} onExit={onExit} />
              <PlayerHeader side={sides[1]} accentIndex={1} compact={compact} align="right" />
            </div>

            <ScoreLeadBar sides={sides} stats={stats} compact={compact} />
          </div>

          <div
            ref={stageRef}
            // The middle column is the whole gap between the two runs now that
            // the playfields lean into it, so it stays as narrow as the numbers
            // allow rather than growing with the screen.
            className={`relative grid min-h-0 flex-1 gap-1 ${
              compact
                ? "grid-cols-[minmax(0,1fr)_minmax(160px,196px)_minmax(0,1fr)]"
                : "grid-cols-[minmax(0,1fr)_minmax(236px,268px)_minmax(0,1fr)]"
            }`}
          >
            <Stage canvasRef={canvasLeftRef} ready={ready} onToggle={toggle} />
            <StatsColumn stats={stats} compact={compact} />
            <Stage canvasRef={canvasRightRef} ready={ready} onToggle={toggle} />
            {buffering && (
              <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
                <span className="flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold text-white/80">
                  <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {t`Buffering audio`}
                </span>
              </div>
            )}
          </div>

          <div
            className={`shrink-0 bg-gradient-to-t from-black/85 via-black/60 to-transparent ${
              compact ? "px-0.5 pt-3 pb-1" : "px-1 pt-5 pb-2"
            }`}
          >
            <div className={`flex items-center ${compact ? "gap-2" : "gap-3"}`}>
              <button
                type="button"
                onClick={() => (isPlaying ? pause() : play())}
                disabled={!ready}
                aria-label={isPlaying ? t`Pause both replays` : t`Play both replays`}
                className={`flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-osu-pink text-white transition hover:bg-osu-pink-light active:scale-95 disabled:opacity-50 ${
                  compact ? "h-8 w-8" : "h-9 w-9"
                }`}
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
                  // A thumb sized for a mouse is a poor scrub handle for a finger.
                  sliderClass={viewport.touch ? "[&::-webkit-slider-thumb]:!h-4 [&::-webkit-slider-thumb]:!w-4" : ""}
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
              <div className={`hidden items-center sm:flex ${compact ? "gap-0" : "gap-1"}`}>
                {SPEED_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => applySpeed(option)}
                    className={`rounded font-semibold tabular-nums transition-colors cursor-pointer ${
                      compact ? "px-1 py-0.5 text-[10px]" : "px-1.5 py-0.5 text-[11px]"
                    } ${speed === option ? "bg-osu-pink/20 text-osu-pink-light" : "text-osu-f1 hover:text-white"}`}
                  >
                    {option}x
                  </button>
                ))}
              </div>
              <VisualSettings
                dim={backgroundDim}
                onSetDim={setBackgroundDim}
                storyboardOn={storyboardEnabled}
                storyboardStatus={storyboardStatus}
                onToggleStoryboard={() => setStoryboardEnabled((on) => !on)}
              />
              <button
                type="button"
                onClick={fullscreen ? exitFullscreen : enterFullscreen}
                title={fullscreen ? t`Exit fullscreen` : t`Fullscreen`}
                aria-label={fullscreen ? t`Exit fullscreen` : t`Fullscreen`}
                aria-pressed={fullscreen}
                className="shrink-0 rounded p-1 text-osu-f1 hover:text-white transition-colors cursor-pointer"
              >
                {fullscreen
                  ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
                  : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
            {audioUrl && !audioFailed && (
              <audio
                ref={audioRef}
                src={audioUrl}
                preload="auto"
                onEnded={handleAudioEnded}
                onError={handleAudioError}
              />
            )}
            {!compact && <MapFacts side={sides[0]} className="mt-2 hidden sm:flex" />}
          </div>
        </div>
      )}

      {/* Portrait: a cover, not a branch. The replays underneath stay loaded
          and paused, so turning back costs nothing. */}
      {layout.rotatePrompt && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[#07070b]/95 px-6 text-center">
          <Smartphone className="mb-2 h-10 w-10 rotate-90 text-osu-pink" aria-hidden="true" />
          <p className="text-sm font-semibold text-osu-l2">{t`Rotate your phone to watch both`}</p>
          <button
            type="button"
            onClick={onExit}
            className="mt-3 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-osu-f1 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
          >
            {t`Pick two scores`}
          </button>
        </div>
      )}
    </div>
  );
}

/* Live viewport facts the stage reacts to. All three are media queries rather
   than measurements so a rotation is one state update, not a resize storm. */
function useSideBySideViewport(): SideBySideViewport {
  const [viewport, setViewport] = useState<SideBySideViewport>({
    portraitPhone: false,
    shortViewport: false,
    touch: false,
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const queries = [
      window.matchMedia(SIDE_BY_SIDE_PORTRAIT_PHONE_QUERY),
      window.matchMedia(SIDE_BY_SIDE_SHORT_VIEWPORT_QUERY),
      window.matchMedia(SIDE_BY_SIDE_TOUCH_QUERY),
    ];
    const update = () => setViewport({
      portraitPhone: queries[0].matches,
      shortViewport: queries[1].matches,
      touch: queries[2].matches,
    });
    update();
    for (const query of queries) query.addEventListener("change", update);
    return () => {
      for (const query of queries) query.removeEventListener("change", update);
    };
  }, []);

  return viewport;
}

/* Everything about how the screen looks, behind one button: the dim the map
   is watched at and whether its storyboard runs. Two settings do not earn a
   permanent strip across a transport this narrow, and both are set once and
   left alone. */
function VisualSettings({ dim, onSetDim, storyboardOn, storyboardStatus, onToggleStoryboard }: {
  dim: number;
  onSetDim: (value: number) => void;
  storyboardOn: boolean;
  storyboardStatus: "idle" | "loading" | "active" | "unavailable" | "error";
  onToggleStoryboard: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Stopped here: Escape also leaves fullscreen, and closing the panel is
      // the nearer thing to have meant.
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const storyboardLabel = storyboardStatus === "loading" && storyboardOn
    ? t`Loading...`
    : storyboardOn && (storyboardStatus === "unavailable" || storyboardStatus === "error")
      ? storyboardStatus === "error" ? t`Failed` : t`None on this map`
      : null;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={t`Background dim and storyboard`}
        aria-label={t`Background dim and storyboard`}
        aria-expanded={open}
        className={`rounded p-1 transition-colors cursor-pointer ${open ? "text-white" : "text-osu-f1 hover:text-white"}`}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-2 w-56 rounded-lg border border-white/10 bg-[#0b0b12]/95 p-3 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between text-[11px] font-semibold text-white/70">
            <span>{t`Background dim`}</span>
            <span className="tabular-nums text-white">{dim}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={dim}
            onChange={(event) => onSetDim(Number(event.target.value))}
            aria-label={t`Background dim`}
            className="mt-2 w-full"
          />
          <button
            type="button"
            onClick={onToggleStoryboard}
            aria-pressed={storyboardOn}
            className={`mt-3 flex w-full items-center justify-between rounded px-2 py-1.5 text-[11px] font-semibold transition-colors cursor-pointer ${
              storyboardOn ? "bg-osu-pink text-white" : "bg-white/10 text-osu-f1 hover:bg-white/20 hover:text-white"
            }`}
          >
            <span>{t`Storyboard`}</span>
            {storyboardLabel && <span className="text-[10px] font-medium opacity-75">{storyboardLabel}</span>}
          </button>
        </div>
      )}
    </div>
  );
}

// The stats tick 10 times a second; memoised so that never touches the two
// canvases sitting either side of it.
const Stage = memo(function Stage({ canvasRef, ready, onToggle }: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  ready: boolean;
  onToggle: () => void;
}) {
  // No frame, no fill: the stage is the map's background with a playfield
  // drawn on it. Which run is which is answered by the headers and the score
  // line above, not by a box around each canvas.
  return (
    <div className="relative min-h-0 overflow-hidden">
      {/* touch-manipulation: a tap is play/pause, so it must not wait on a
          double-tap-to-zoom that would also zoom the stage out of the screen. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full touch-manipulation select-none"
        onClick={onToggle}
      />
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
function ScoreLeadBar({ sides, stats, compact }: {
  sides: [SideBySideSide, SideBySideSide];
  stats: (ReplayLiveStats | null)[];
  compact: boolean;
}) {
  const { t } = useLingui();
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
      <div className={`relative w-full overflow-hidden rounded-full bg-osu-b4 ${compact ? "h-1" : "h-1.5"}`}>
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
      <div className={`flex items-baseline justify-center ${compact ? "mt-0.5 gap-2" : "mt-1.5 gap-3"}`}>
        <LeadScore
          side={sides[0]}
          stats={stats[0]}
          accentIndex={0}
          state={leader == null ? "tied" : leader === 0 ? "leading" : "trailing"}
          delta={leader === 1 ? deltaLabel : null}
          compact={compact}
          align="right"
        />
        <span className={`uppercase tracking-[0.2em] text-white/30 ${compact ? "text-[8px]" : "text-[9px]"}`}>{t`Score`}</span>
        <LeadScore
          side={sides[1]}
          stats={stats[1]}
          accentIndex={1}
          state={leader == null ? "tied" : leader === 1 ? "leading" : "trailing"}
          delta={leader === 0 ? deltaLabel : null}
          compact={compact}
          align="left"
        />
      </div>
    </div>
  );
}

function LeadScore({ side, stats, accentIndex, state, delta, compact, align }: {
  side: SideBySideSide;
  stats: ReplayLiveStats | null;
  accentIndex: 0 | 1;
  state: "leading" | "trailing" | "tied";
  /** Only set on the side that is behind. */
  delta: string | null;
  compact: boolean;
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
    <span className={`flex min-w-0 flex-1 items-baseline ${compact ? "gap-1.5" : "gap-2"} ${align === "right" ? "justify-end" : "flex-row-reverse justify-end"}`}>
      {delta && <span className={`font-semibold tabular-nums text-white/35 ${compact ? "text-[10px]" : "text-[11px]"}`}>{delta}</span>}
      <span className={`truncate tabular-nums transition-colors ${compact ? "text-[17px]" : "text-[26px]"} ${tone}`}>{value}</span>
    </span>
  );
}

function PlayerHeader({ side, accentIndex, compact, align = "left" }: {
  side: SideBySideSide;
  accentIndex: 0 | 1;
  compact: boolean;
  align?: "left" | "right";
}) {
  const accent = SIDE_ACCENTS[accentIndex];
  const score = side.score;
  const name = score.user?.username ?? side.replay.header.playerName ?? "Unknown";
  const playedAt = getScoreTimestamp(score);
  const viewerTimeZone = useViewerTimeZone();
  const mods = getModDisplayList(score.mods);
  const right = align === "right";
  const nameNode = score.user?.username ? (
    <Link
      to="/player/$username"
      params={{ username: score.user.username }}
      target="_blank"
      rel="noopener noreferrer"
      className={`truncate font-bold ${compact ? "text-[13px]" : "text-[17px]"} ${accent.text} hover:underline underline-offset-2`}
    >
      {name}
    </Link>
  ) : (
    <span className={`truncate font-bold text-white ${compact ? "text-[13px]" : "text-[17px]"}`}>{name}</span>
  );

  // Compact folds the two rows into one and drops the date: on a landscape
  // phone every line here is a line the playfields don't get.
  // justify-end on both sides packs each player toward the middle column (in a
  // row-reverse row, main-end is the left edge), so the two names sit either
  // side of the map title, over the playfields they belong to, instead of at
  // opposite edges of the screen.
  if (compact) {
    return (
      <div className={`flex min-w-0 items-center justify-end gap-1.5 ${right ? "flex-row-reverse text-right" : "text-left"}`}>
        <GradeImg grade={getDisplayedRank(score)} size={20} />
        <CountryFlag code={score.user?.country_code} size="sm" decorative />
        {nameNode}
        {mods.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            {mods.map((mod, index) => (
              <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.6} />
            ))}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex min-w-0 items-center justify-end gap-2.5 ${right ? "flex-row-reverse text-right" : "text-left"}`}>
      <GradeImg grade={getDisplayedRank(score)} size={32} />
      <div className={`min-w-0 ${right ? "items-end" : "items-start"} flex flex-col gap-0.5`}>
        <div className={`flex min-w-0 items-center gap-1.5 ${right ? "flex-row-reverse" : ""}`}>
          <CountryFlag code={score.user?.country_code} size="md" decorative />
          {nameNode}
        </div>
        <div className={`flex items-center gap-2 ${right ? "flex-row-reverse" : ""}`}>
          {playedAt && <span className="text-[12px] tabular-nums text-white/55">{formatDate(playedAt, viewerTimeZone)}</span>}
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

function MapHeader({ side, stars, compact, onExit }: {
  side: SideBySideSide;
  stars: number | null;
  compact: boolean;
  onExit: () => void;
}) {
  const { t } = useLingui();
  const set = side.score.beatmapset;
  const title = set?.title ?? side.beatmap?.title ?? t`Unknown map`;
  const artist = set?.artist ?? side.beatmap?.artist;
  const version = side.score.beatmap?.version ?? side.beatmap?.version;
  const beatmapsetId = set?.id;
  const mapUrl = beatmapsetId
    ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}${side.score.beatmap?.id ? `#mania/${side.score.beatmap.id}` : ""}`
    : null;
  const fullTitle = `${artist ? `${artist} - ` : ""}${title}`;

  // Compact runs the whole header on one line, and the title stops being a
  // link: it sits under a thumb mid-run, and a stray tap that opens osu! would
  // throw the phone out of fullscreen.
  if (compact) {
    return (
      <div className="flex min-w-0 max-w-[46vw] items-center justify-center gap-1.5 px-1">
        <button
          type="button"
          onClick={onExit}
          aria-label={t`Back to the picker`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/20 bg-white/15 text-white transition-colors hover:bg-white/25 cursor-pointer"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {stars != null && <StarRatingBadge stars={stars} size={1.1} />}
        <span className="min-w-0 truncate text-[11px] font-semibold text-white" title={`${fullTitle} [${version ?? ""}]`}>
          {fullTitle}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-[520px] flex-col items-center gap-1 px-2 text-center">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onExit}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-white/20 bg-white/15 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-white/25 cursor-pointer"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t`Back`}
        </button>
        {stars != null && <StarRatingBadge stars={stars} size={1.45} />}
      </div>
      {mapUrl ? (
        <a
          href={mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-[14px] font-semibold text-white transition-colors hover:text-osu-pink-light"
          title={`${fullTitle} [${version ?? ""}]`}
        >
          {fullTitle}
        </a>
      ) : (
        <span className="min-w-0 truncate text-[14px] font-semibold text-white">{fullTitle}</span>
      )}
      {version && <span className="min-w-0 truncate text-[12px] text-white/55">[{version}]</span>}
    </div>
  );
}

// Chart facts both runs share, so they sit once under the transport instead of
// twice in the header. Rate mods move BPM and length, so apply the rate.
function MapFacts({ side, className = "" }: { side: SideBySideSide; className?: string }) {
  const { t } = useLingui();
  const apiBeatmap = side.score.beatmap;
  const rate = side.rate;
  const keyCount = side.replay.keyCount;
  const bpm = apiBeatmap?.bpm ?? side.beatmap?.bpm;
  const lengthSeconds = apiBeatmap?.total_length ?? (side.beatmap ? side.beatmap.totalLength / 1000 : undefined);
  const od = apiBeatmap?.accuracy ?? side.beatmap?.od;
  const facts: { label: string; value: string }[] = [
    { label: t`Keys`, value: `${keyCount}K` },
    ...(od != null ? [{ label: t`OD`, value: od.toFixed(1) }] : []),
    ...(apiBeatmap?.drain != null ? [{ label: t`HP`, value: apiBeatmap.drain.toFixed(1) }] : []),
    ...(bpm != null ? [{ label: t`BPM`, value: String(Math.round(bpm * rate)) }] : []),
    ...(lengthSeconds != null ? [{ label: t`Length`, value: formatLength(lengthSeconds / rate) }] : []),
    ...(side.beatmap ? [{ label: t`Notes`, value: side.beatmap.notes.length.toLocaleString("en-US") }] : []),
    ...(rate !== 1 ? [{ label: t`Rate`, value: `${rate}x` }] : []),
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
  label: MessageDescriptor;
  labelClass?: string;
  format: (stats: ReplayLiveStats) => string;
  /** Raw value the two sides are ranked on; omit for rows with no winner. */
  rank?: (stats: ReplayLiveStats) => number;
  better?: "higher" | "lower";
  valueClass?: string;
  /** Used on short viewports, where the default sizes would overflow. */
  compactValueClass?: string;
}

const JUDGEMENT_ROWS: StatRow[] = [
  { label: msg`MAX`, labelClass: "text-osu-yellow", format: (s) => String(s.counts[1]), rank: (s) => s.counts[1], better: "higher" },
  { label: msg`300`, labelClass: "text-osu-blue", format: (s) => String(s.counts[2]), rank: (s) => s.counts[2], better: "lower" },
  { label: msg`200`, labelClass: "text-osu-green-light", format: (s) => String(s.counts[3]), rank: (s) => s.counts[3], better: "lower" },
  { label: msg`100`, labelClass: "text-osu-green", format: (s) => String(s.counts[4]), rank: (s) => s.counts[4], better: "lower" },
  { label: msg`50`, labelClass: "text-osu-orange", format: (s) => String(s.counts[5]), rank: (s) => s.counts[5], better: "lower" },
  { label: msg`MISS`, labelClass: "text-osu-red-light", format: (s) => String(s.counts[6]), rank: (s) => s.counts[6], better: "lower" },
];

const TIMING_ROWS: StatRow[] = [
  { label: msg`Early`, format: (s) => String(s.early) },
  { label: msg`Late`, format: (s) => String(s.late) },
  { label: msg`Mean`, format: (s) => `${s.meanOffsetMs >= 0 ? "+" : ""}${s.meanOffsetMs.toFixed(1)}ms`, rank: (s) => Math.abs(s.meanOffsetMs), better: "lower" },
  // MAX-to-300 ratio, the number mania players quote for how clean the taps
  // were. Undefined until the run has dropped a 300.
  { label: msg`Ratio`, format: (s) => (s.counts[2] > 0 ? (s.counts[1] / s.counts[2]).toFixed(2) : "-"), rank: (s) => (s.counts[2] > 0 ? s.counts[1] / s.counts[2] : 0), better: "higher" },
  { label: msg`Judged`, format: (s) => String(s.totalJudgements) },
];

const HEADLINE_ROWS: StatRow[] = [
  // "Acc", not "Accuracy": at this size the label was taking the width the two
  // percentages needed, and both were truncating to "100.0...".
  { label: msg`Acc`, format: (s) => `${s.accuracy.toFixed(2)}%`, rank: (s) => s.accuracy, better: "higher", valueClass: "text-[24px]", compactValueClass: "text-[16px]" },
  { label: msg`UR`, format: (s) => s.unstableRate.toFixed(2), rank: (s) => s.unstableRate, better: "lower", valueClass: "text-[19px]", compactValueClass: "text-[13px]" },
];

const PP_ROWS: StatRow[] = [
  {
    label: msg`PP`,
    format: (s) => (s.maxPp > 0 ? `${Math.round(s.pp)}/${Math.round(s.maxPp)}` : String(Math.round(s.pp))),
    rank: (s) => s.pp,
    better: "higher",
    valueClass: "text-[18px]",
    compactValueClass: "text-[13px]",
  },
];

// Deliberately unboxed: the stages either side carry their own frames, so
// panelling these numbers as well just stacks borders in the middle of the
// screen. One centred block, hairlines between the groups.
//
// Compact drops the timing group rather than letting the column scroll: a
// readout you have to swipe through mid-run is worse than one that shows
// fewer numbers, and accuracy/judgements/pp are what the runs are read on.
function StatsColumn({ stats, compact }: { stats: (ReplayLiveStats | null)[]; compact: boolean }) {
  const left = stats[0] ?? null;
  const right = stats[1] ?? null;

  return (
    // The scrim is a sibling, not a background on the scroller: masking the
    // element that holds the numbers would fade the outermost digits with it.
    // It reaches past the column into both stages so its edges have room to
    // disappear instead of drawing a band down the middle of the screen.
    <div className="relative flex min-h-0 flex-col">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 -left-8 -right-8 bg-black/45 backdrop-blur-[3px] [mask-image:linear-gradient(to_right,transparent,black_24%,black_76%,transparent)]"
      />
      {/* min-h-full on the inner column, not justify-center on the scroller: a
          centred flex child that outgrows its scroll box clips its own top away
          with no way to scroll back up to it. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className={`flex min-h-full flex-col justify-center ${compact ? "gap-1.5 px-0.5" : "gap-3.5 px-1 py-2"}`}>
        <StatGroup rows={HEADLINE_ROWS} left={left} right={right} compact={compact} />
        <StatGroup rows={JUDGEMENT_ROWS} left={left} right={right} compact={compact} divider />
        {!compact && <StatGroup rows={TIMING_ROWS} left={left} right={right} compact={compact} divider />}
        <StatGroup rows={PP_ROWS} left={left} right={right} compact={compact} divider />
      </div>
      </div>
    </div>
  );
}

function StatGroup({ rows, left, right, compact, divider = false }: {
  rows: StatRow[];
  left: ReplayLiveStats | null;
  right: ReplayLiveStats | null;
  compact: boolean;
  divider?: boolean;
}) {
  return (
    <div className={divider ? `border-t border-white/[0.07] ${compact ? "pt-1.5" : "pt-3.5"}` : ""}>
      {rows.map((row) => (
        <StatLine key={String(row.label.id)} row={row} left={left} right={right} compact={compact} />
      ))}
    </div>
  );
}

function StatLine({ row, left, right, compact }: {
  row: StatRow;
  left: ReplayLiveStats | null;
  right: ReplayLiveStats | null;
  compact: boolean;
}) {
  const { i18n } = useLingui();
  // Whoever is ahead on this line right now reads bright; the other dims. It
  // is the whole point of the column, so it has to be legible at a glance.
  let leader: 0 | 1 | null = null;
  if (left && right && row.rank && row.better) {
    const a = row.rank(left);
    const b = row.rank(right);
    if (a !== b) leader = (row.better === "higher") === (a > b) ? 0 : 1;
  }
  const size = compact ? row.compactValueClass ?? "text-[13px]" : row.valueClass ?? "text-[18px]";
  const valueClass = (index: 0 | 1) =>
    `truncate font-bold tabular-nums ${size} ${
      leader == null ? "text-white/85" : leader === index ? "text-white" : "text-white/40"
    }`;

  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline ${compact ? "gap-x-1.5 py-0" : "gap-x-3 py-[3px]"}`}>
      <span className={`${valueClass(0)} text-right`}>{left ? row.format(left) : "-"}</span>
      <span className={`font-semibold uppercase tracking-[0.1em] ${compact ? "text-[9px]" : "text-[11px]"} ${row.labelClass ?? "text-white/45"}`}>{i18n._(row.label)}</span>
      <span className={`${valueClass(1)} text-left`}>{right ? row.format(right) : "-"}</span>
    </div>
  );
}
