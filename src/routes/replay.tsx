import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getReplayParsed, getBeatmapFile, getScore, getUserScoresBest, searchUsers } from "../lib/osu";
import { parseManiaBeatmap } from "../lib/beatmap-parser";
import { scoreHasReplay } from "../lib/score";
import { PageHeader } from "../components/layout/PageHeader";
import { ManiaReplayRenderer } from "../components/replay/ReplayCanvas";
import { SearchInput } from "../components/ui/SearchInput";
import { GradeImg } from "../components/ui/GradeImg";
import { formatAccuracy, formatPP } from "../lib/format";
import { parseSkinFile, saveSkinToIDB, loadSkinFromIDB, removeSkinFromIDB } from "../lib/skin-parser";
import type { ManiaSkin } from "../lib/skin-parser";
import type { ManiaBeatmap } from "../lib/beatmap-parser";
import type { OsuScore, ReplayFrame } from "../lib/types";

const REPLAY_VOLUME_STORAGE_KEY = "mania-hub-replay-volume";
const REPLAY_INPUT_OVERLAY_STORAGE_KEY = "mania-hub-replay-input-overlay";

interface ReplaySearch {
  scoreId?: number;
  mode?: string;
  beatmapsetId?: number;
  t?: number; // timestamp in seconds to seek to on load
}

interface ServerReplay {
  header: {
    playerName: string;
    gameMode: number;
    totalScore: number;
    maxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countGeki: number;
    countKatu: number;
    countMiss: number;
    isPerfect: boolean;
  };
  frames: ReplayFrame[];
  keyCount: number;
}

export const Route = createFileRoute("/replay")({
  component: ReplayPage,
  validateSearch: (s: Record<string, unknown>): ReplaySearch => ({
    scoreId: Number(s.scoreId) || undefined,
    mode: (s.mode as string) || "mania",
    beatmapsetId: Number(s.beatmapsetId) || undefined,
    t: Number(s.t) || undefined,
  }),
});

function ReplayPage() {
  const { scoreId, mode, beatmapsetId, t: initialTime } = Route.useSearch();
  const navigate = useNavigate();
  const [replay, setReplay] = useState<ServerReplay | null>(null);
  const [beatmap, setBeatmap] = useState<ManiaBeatmap | null>(null);
  const [scoreInfo, setScoreInfo] = useState<OsuScore | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playerScores, setPlayerScores] = useState<OsuScore[]>([]);
  const [loadingScores, setLoadingScores] = useState(false);

  const loadReplay = useCallback(async (sid: number, m: string) => {
    setError(null);
    setLoading(true);
    setReplay(null);
    setBeatmap(null);

    try {
      // Fetch score first to get key count (beatmap.cs) for correct replay parsing
      const score = await getScore({ data: { scoreId: sid, mode: m } }).catch(() => null);
      if (score) setScoreInfo(score);

      // Fetch replay with key count from score API, and beatmap file in parallel
      const keyCount = score?.beatmap?.cs ? Math.round(score.beatmap.cs) : undefined;
      const [parsed, bmResult] = await Promise.all([
        getReplayParsed({ data: { scoreId: sid, mode: m, keyCount } }),
        score?.beatmap?.id
          ? getBeatmapFile({ data: { beatmapId: score.beatmap.id } }).catch(() => null)
          : Promise.resolve(null),
      ]);

      setReplay(parsed);
      if (bmResult) {
        setBeatmap(parseManiaBeatmap(bmResult.content));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load replay");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (scoreId) loadReplay(scoreId, mode ?? "mania");
  }, [scoreId, mode, loadReplay]);

  const handlePlayerSearch = async (q: string) => {
    const res = await searchUsers({ data: { query: q } });
    return (res.user?.data ?? []).slice(0, 6).map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code,
    }));
  };

  const handleSelectPlayer = async (user: { id: number }) => {
    setLoadingScores(true);
    try {
      const scores = await getUserScoresBest({ data: { userId: user.id, limit: 20 } });
      setPlayerScores(scores.filter((s: OsuScore) => scoreHasReplay(s)));
    } catch { setPlayerScores([]); }
    finally { setLoadingScores(false); }
  };

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/home.svg" title="mania replay viewer" />

      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="max-w-[1200px] mx-auto px-5 py-6">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-20">
                <div className="w-10 h-10 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin mb-4" />
                <p className="text-sm text-osu-f1">Loading replay & beatmap...</p>
              </motion.div>
            ) : replay ? (
              <motion.div key="viewer" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <ReplayInfo replay={replay} score={scoreInfo} beatmap={beatmap} onClear={() => {
                  setReplay(null); setBeatmap(null); setScoreInfo(null);
                  navigate({ to: "/replay", search: {} });
                }} />
                <ReplayViewer replay={replay} beatmap={beatmap} scoreInfo={scoreInfo} fallbackBeatmapsetId={beatmapsetId} initialTime={initialTime} />
              </motion.div>
            ) : (
              <motion.div key="browse" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="max-w-lg mx-auto mb-8">
                  <h3 className="text-sm font-semibold text-osu-f1 uppercase tracking-wider mb-3 text-center">
                    Search a player to view their replays
                  </h3>
                  <SearchInput placeholder="Search player..." onSearch={handlePlayerSearch} onSelect={handleSelectPlayer} />
                </div>

                {error && (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-xs text-osu-red-light bg-osu-red/10 px-4 py-2 rounded-lg text-center max-w-lg mx-auto mb-6">{error}</motion.p>
                )}

                {loadingScores && (
                  <div className="flex justify-center py-8">
                    <div className="w-6 h-6 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                  </div>
                )}

                {playerScores.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-2">
                      Scores with replays available ({playerScores.length})
                    </h4>
                    {playerScores.map((s: OsuScore, i: number) => (
                      <motion.div key={s.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}
                        className="flex items-center gap-3 py-2.5 px-4 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20"
                        onClick={() => navigate({ to: "/replay", search: { scoreId: s.id, mode: "mania", beatmapsetId: s.beatmapset?.id } })}>
                        <GradeImg grade={s.rank} size={26} />
                        {s.beatmapset?.covers?.list && (
                          <img src={s.beatmapset.covers.list} alt="" className="w-12 h-8 rounded object-cover flex-shrink-0" loading="lazy" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-white truncate">{s.beatmapset?.title}</div>
                          <div className="text-[10px] text-osu-f1">[{s.beatmap?.version}] {s.beatmap?.cs && `${s.beatmap.cs}K`}</div>
                        </div>
                        <span className="text-xs text-osu-l2">{formatAccuracy(s.accuracy)}</span>
                        <span className="text-sm font-bold">{formatPP(s.pp)}</span>
                        <span className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold">Watch</span>
                      </motion.div>
                    ))}
                  </div>
                )}

                {!loadingScores && playerScores.length === 0 && !error && (
                  <div className="text-center py-12 text-osu-f1 text-sm">
                    Search for a player above to browse their available replays
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ReplayInfo({ replay, score, beatmap, onClear }: {
  replay: ServerReplay; score: OsuScore | null; beatmap: ManiaBeatmap | null; onClear: () => void;
}) {
  const h = replay.header;
  const totalHits = h.countGeki + h.count300 + h.countKatu + h.count100 + h.count50;
  const accuracy = totalHits + h.countMiss > 0
    ? ((h.countGeki * 6 + h.count300 * 6 + h.countKatu * 4 + h.count100 * 2 + h.count50) / ((totalHits + h.countMiss) * 6) * 100) : 0;
  const beatmapsetId = score?.beatmapset?.id;
  const beatmapId = score?.beatmap?.id;
  const mapUrl = beatmapsetId ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}${beatmapId ? `#mania/${beatmapId}` : ""}` : null;

  return (
    <div className="bg-osu-b4 rounded-xl p-4 mb-4 border border-osu-b3/20">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Player</div><div className="text-sm font-bold text-white">{h.playerName}</div></div>
        {beatmap && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Map</div>{mapUrl ? <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-osu-l2 hover:text-osu-pink-light transition-colors">{beatmap.title} [{beatmap.version}]</a> : <div className="text-sm font-medium text-osu-l2">{beatmap.title} [{beatmap.version}]</div>}</div>}
        <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Keys</div><div className="text-sm font-bold text-osu-yellow">{replay.keyCount}K</div></div>
        <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Accuracy</div><div className="text-sm font-bold text-white">{accuracy.toFixed(2)}%</div></div>
        <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Score</div><div className="text-sm font-bold text-white">{h.totalScore.toLocaleString()}</div></div>
        <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Combo</div><div className="text-sm font-bold text-white">{h.maxCombo}x</div></div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-osu-f1">Judgments</div>
          <div className="text-xs text-osu-f1">
            <span className="text-osu-yellow">{h.countGeki}</span>/<span className="text-osu-blue">{h.count300}</span>/<span className="text-osu-green-light">{h.countKatu}</span>/<span className="text-osu-green">{h.count100}</span>/<span className="text-osu-orange">{h.count50}</span>/<span className="text-osu-red-light">{h.countMiss}</span>
          </div>
        </div>
        {beatmap && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Notes</div><div className="text-sm font-bold text-osu-f1">{beatmap.notes.length.toLocaleString()}</div></div>}
        <button onClick={onClear} className="ml-auto px-3 py-1.5 rounded-lg bg-osu-b3/50 text-xs text-osu-f1 hover:text-white hover:bg-osu-b2 transition-colors cursor-pointer">Back</button>
      </div>
    </div>
  );
}

function ReplayViewer({
  replay,
  beatmap,
  scoreInfo,
  fallbackBeatmapsetId,
  initialTime,
}: {
  replay: ServerReplay;
  beatmap: ManiaBeatmap | null;
  scoreInfo: OsuScore | null;
  fallbackBeatmapsetId?: number;
  initialTime?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ManiaReplayRenderer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const modAcronyms = (scoreInfo?.mods ?? []).map((m: any) => (typeof m === "string" ? m : m.acronym ?? "").toUpperCase());
  const modRate = modAcronyms.includes("DT") || modAcronyms.includes("NC") ? 1.5 : modAcronyms.includes("HT") ? 0.75 : 1;
  const effectiveRate = speed * modRate;
  const [progress, setProgress] = useState(0);
  const [scrollSpeed, setScrollSpeed] = useState(32);
  const [bgDim, setBgDim] = useState(80);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [volume, setVolume] = useState(() => {
    if (typeof window === "undefined") return 0.5;
    const stored = Number(window.localStorage.getItem(REPLAY_VOLUME_STORAGE_KEY));
    return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 0.5;
  });
  const [showInputOverlay, setShowInputOverlay] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(REPLAY_INPUT_OVERLAY_STORAGE_KEY);
    return stored == null ? true : stored === "true";
  });
  const [audioError, setAudioError] = useState<string | null>(null);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [skin, setSkin] = useState<ManiaSkin | null>(null);
  const [skinLoading, setSkinLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharePos, setSharePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const skinFileRef = useRef<HTMLInputElement>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval>>(undefined);
  const shouldResumeAudioRef = useRef(false);

  // Build full audio URL from Sayobot CDN using beatmapset ID + audio filename from .osu
  const effectiveBeatmapsetId = scoreInfo?.beatmapset?.id ?? fallbackBeatmapsetId;
  const audioUrl = effectiveBeatmapsetId && beatmap?.audioFilename
    ? `/api/audio?beatmapsetId=${encodeURIComponent(String(effectiveBeatmapsetId))}&filename=${encodeURIComponent(beatmap.audioFilename)}`
    : null;

  // Load background image from beatmapset cover
  useEffect(() => {
    const coverUrl = scoreInfo?.beatmapset?.covers?.["cover@2x"] || scoreInfo?.beatmapset?.covers?.cover;
    if (!coverUrl) return;
    const img = new Image();
    img.onload = () => setBgImage(img);
    img.src = coverUrl;
  }, [scoreInfo]);

  // Pass background image to renderer when it loads
  useEffect(() => {
    if (bgImage && rendererRef.current) {
      rendererRef.current.setBackgroundImage(bgImage);
    }
  }, [bgImage]);

  useEffect(() => {
    setAudioError(null);
    shouldResumeAudioRef.current = false;
  }, [audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    audio.load();
  }, [audioUrl]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setShowInputOverlay(showInputOverlay);
    }
  }, [showInputOverlay]);

  // Create renderer
  useEffect(() => {
    if (!canvasRef.current || replay.frames.length === 0) return;

    const renderer = new ManiaReplayRenderer(
      canvasRef.current,
      replay.frames,
      replay.keyCount,
      beatmap?.notes ?? [],
      {
        backgroundImage: bgImage ?? undefined,
        backgroundDim: bgDim,
        od: beatmap?.od,
        showInputOverlay,
        mods: modAcronyms,
      },
    );
    rendererRef.current = renderer;
    // Apply skin if already loaded
    if (skin) renderer.setSkin(skin);
    // Seek to initial timestamp from URL (t param, in seconds)
    if (initialTime != null && initialTime > 0) {
      const gameTimeMs = initialTime * 1000 * modRate;
      renderer.seek(gameTimeMs);
      setProgress(gameTimeMs / renderer.duration);
    }
    const handleResize = () => renderer.resize();
    window.addEventListener("resize", handleResize);
    return () => { renderer.destroy(); window.removeEventListener("resize", handleResize); };
  }, [replay, beatmap, scoreInfo]);

  // Pass skin to renderer when it changes
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setSkin(skin);
    }
  }, [skin]);

  // Load persisted skin from IndexedDB on mount
  useEffect(() => {
    loadSkinFromIDB().then(async (stored) => {
      if (!stored) return;
      try {
        const parsed = await parseSkinFile(stored.data, replay.keyCount);
        setSkin(parsed);
      } catch {
        // Stored skin may be corrupt or incompatible
        await removeSkinFromIDB();
      }
    });
  }, [replay.keyCount]);

  const handleSkinUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSkinLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseSkinFile(buffer, replay.keyCount);
      setSkin(parsed);
      await saveSkinToIDB(buffer, parsed.name);
    } catch (err) {
      console.error("Failed to parse skin:", err);
    } finally {
      setSkinLoading(false);
      // Reset file input so re-uploading the same file triggers onChange
      if (skinFileRef.current) skinFileRef.current.value = "";
    }
  };

  const handleRemoveSkin = async () => {
    setSkin(null);
    await removeSkinFromIDB();
  };

  // Progress polling + audio drift correction
  useEffect(() => {
    if (progressInterval.current) clearInterval(progressInterval.current);
    if (isPlaying) {
      let syncCounter = 0;
      progressInterval.current = setInterval(() => {
        const r = rendererRef.current;
        if (!r) return;
        setProgress(r.time / r.duration);
        if (!r.isPlaying) setIsPlaying(false);

        // Re-sync audio every ~2s if drifted more than 200ms
        syncCounter++;
        if (syncCounter >= 40 && audioRef.current && audioEnabled && !audioRef.current.paused) {
          syncCounter = 0;
          const drift = Math.abs(audioRef.current.currentTime - r.time / 1000);
          if (drift > 0.2) {
            audioRef.current.currentTime = r.time / 1000;
          }
        }
      }, 50);
    }
    return () => { if (progressInterval.current) clearInterval(progressInterval.current); };
  }, [isPlaying, audioEnabled]);

  // Sync audio with replay play/pause/seek
  useEffect(() => {
    if (!audioRef.current || !audioEnabled) return;
    audioRef.current.volume = volume;
    if (isPlaying) {
      audioRef.current.playbackRate = effectiveRate;
      if (audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        audioRef.current.play().catch(() => {});
      } else {
        shouldResumeAudioRef.current = true;
      }
    } else {
      shouldResumeAudioRef.current = false;
      audioRef.current.pause();
    }
  }, [isPlaying, audioEnabled, speed, volume]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REPLAY_VOLUME_STORAGE_KEY, String(volume));
  }, [volume]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REPLAY_INPUT_OVERLAY_STORAGE_KEY, String(showInputOverlay));
  }, [showInputOverlay]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const resumeAudioIfNeeded = () => {
      if (!audioEnabled || !isPlaying || !shouldResumeAudioRef.current) return;
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      shouldResumeAudioRef.current = false;
      audio.playbackRate = effectiveRate;
      audio.volume = volume;
      audio.play().catch(() => {
        shouldResumeAudioRef.current = true;
      });
    };

    const handleCanPlay = () => resumeAudioIfNeeded();
    const handleSeeked = () => resumeAudioIfNeeded();
    const handleLoadedData = () => resumeAudioIfNeeded();

    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("seeked", handleSeeked);
    audio.addEventListener("loadeddata", handleLoadedData);

    return () => {
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("seeked", handleSeeked);
      audio.removeEventListener("loadeddata", handleLoadedData);
    };
  }, [audioEnabled, isPlaying, speed, volume, audioUrl]);

  // Sync audio time on seek — pause first to force re-buffer, then resume
  const syncAudioTime = (timeMs: number) => {
    if (!audioRef.current || !audioEnabled) return;
    const wasPlaying = !audioRef.current.paused;
    shouldResumeAudioRef.current = wasPlaying || isPlaying;
    audioRef.current.pause();
    audioRef.current.currentTime = timeMs / 1000;
    if ((wasPlaying || isPlaying) && audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      shouldResumeAudioRef.current = false;
      audioRef.current.play().catch(() => {});
    }
  };

  const togglePlay = () => {
    const r = rendererRef.current;
    if (!r) return;
    if (isPlaying) { r.pause(); setIsPlaying(false); }
    else {
      if (r.time >= r.duration) r.seek(0);
      r.play();
      setIsPlaying(true);
      // Play audio directly from user gesture so browsers don't block it
      if (audioRef.current && audioEnabled) {
        audioRef.current.currentTime = r.time / 1000;
        audioRef.current.playbackRate = effectiveRate;
        audioRef.current.volume = volume;
        audioRef.current.play().catch(() => {
          shouldResumeAudioRef.current = true;
        });
      }
    }
  };

  const toggleAudio = () => {
    if (!audioRef.current) return;
    if (audioEnabled) {
      audioRef.current.pause();
      setAudioEnabled(false);
    } else {
      // Sync audio to current replay time
      const r = rendererRef.current;
      if (r) audioRef.current.currentTime = r.time / 1000;
      audioRef.current.playbackRate = effectiveRate;
      shouldResumeAudioRef.current = isPlaying;
      if (isPlaying && audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        shouldResumeAudioRef.current = false;
        audioRef.current.play().catch(() => {});
      }
      setAudioEnabled(true);
    }
  };

  const formatTime = (ratio: number) => {
    const ms = ratio * (rendererRef.current?.displayDuration ?? 0);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  };

  const sliderClass = "h-1 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink";

  const handleAudioError = () => {
    setAudioError("Couldn't load the song audio for this replay.");
    shouldResumeAudioRef.current = false;
  };

  return (
    <div className="space-y-3">
      {/* Canvas */}
      <div className="rounded-xl overflow-hidden border border-osu-b3/20 bg-[#0a0a18]">
        <canvas ref={canvasRef} className="w-full" style={{ height: "min(70vh, 600px)" }} />
      </div>

      {/* Audio element (hidden) — full song from Sayobot CDN */}
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="auto"
          onError={handleAudioError}
        />
      )}

      {/* Controls */}
      <div className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
        {audioError && (
          <div className="text-[11px] text-osu-yellow bg-osu-yellow/10 border-b border-osu-yellow/20 px-4 py-2">
            {audioError}
          </div>
        )}

        {/* Progress bar */}
        <div className="relative flex items-center gap-3 px-4 pt-3 pb-1"
          onContextMenu={(e) => {
            e.preventDefault();
            const wallSeconds = progress * (rendererRef.current?.displayDuration ?? 0) / 1000;
            const t = Math.round(wallSeconds * 10) / 10;
            const url = new URL(window.location.href);
            url.searchParams.set("t", String(t));
            setShareUrl(url.toString());
            setSharePos({ x: e.clientX, y: e.clientY });
            setCopied(false);
          }}
        >
          <span className="text-[10px] text-osu-f1 tabular-nums w-10">{formatTime(progress)}</span>
          <input type="range" min={0} max={1} step={0.001} value={progress}
            onChange={(e) => { const v = Number(e.target.value); setProgress(v); const t = v * (rendererRef.current?.duration ?? 0); rendererRef.current?.seek(t); syncAudioTime(t); }}
            className={`flex-1 h-1.5 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink`} />
          <span className="text-[10px] text-osu-f1 tabular-nums w-10 text-right">{formatTime(1)}</span>

          {/* Share timestamp tooltip */}
          <AnimatePresence>
            {shareUrl && (
              <>
                <div className="fixed inset-0 z-[99]" onClick={() => setShareUrl(null)} />
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.1 }}
                  style={{ left: Math.min(sharePos.x, window.innerWidth - 340), top: sharePos.y - 8 }}
                  className="fixed -translate-y-full z-[100] bg-osu-b3 border border-osu-b2 rounded-lg shadow-2xl p-2.5 w-80"
                >
                  <div className="text-[11px] text-osu-f1 mb-1.5">Copy URL at {formatTime(progress)}</div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      readOnly
                      value={shareUrl}
                      className="flex-1 min-w-0 bg-osu-b4 text-[10px] text-osu-f0 rounded px-2 py-1 border border-osu-b2 outline-none select-all"
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      onClick={() => { navigator.clipboard.writeText(shareUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="px-2.5 py-1 rounded bg-osu-pink hover:bg-osu-pink-light text-white text-[11px] font-medium transition-colors cursor-pointer shrink-0"
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
          {/* Play/Pause */}
          <button onClick={togglePlay} className="w-9 h-9 rounded-full bg-osu-pink hover:bg-osu-pink-light transition-colors flex items-center justify-center cursor-pointer shrink-0">
            {isPlaying ? (
              <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4 ml-0.5">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* Speed */}
          <div className="flex items-center gap-0.5">
            {[0.25, 0.5, 1, 1.5, 2].map((s) => (
              <button key={s} onClick={() => { setSpeed(s); rendererRef.current?.setSpeed(s); if (audioRef.current) audioRef.current.playbackRate = s * modRate; }}
                className={`px-2 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors ${speed === s ? "bg-osu-pink text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"}`}>{s}x</button>
            ))}
          </div>

          {/* Divider */}
          <div className="w-px h-5 bg-osu-b3/40" />

          {/* Volume */}
          {audioUrl && (
            <div className="flex items-center gap-1.5">
              <button onClick={toggleAudio}
                className="w-7 h-7 rounded flex items-center justify-center cursor-pointer transition-colors hover:bg-osu-b3/50">
                {!audioEnabled || volume === 0 ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-osu-f1">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-white">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-white">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                )}
              </button>
              <input type="range" min={0} max={1} step={0.05} value={audioEnabled ? volume : 0}
                onChange={(e) => { const v = Number(e.target.value); setVolume(v); if (!audioEnabled && v > 0) setAudioEnabled(true); if (audioRef.current) audioRef.current.volume = v; }}
                className={`w-16 ${sliderClass}`} />
            </div>
          )}

          {/* Divider */}
          <div className="w-px h-5 bg-osu-b3/40" />

          {/* Input overlay toggle */}
          <button
            onClick={() => setShowInputOverlay((value) => !value)}
            className={`px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
              showInputOverlay ? "bg-osu-pink text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"
            }`}
          >
            Input
          </button>

          {/* Scroll Speed */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-osu-f1 mr-0.5">Scroll</span>
            <button onClick={() => { const v = Math.max(1, scrollSpeed - 1); setScrollSpeed(v); rendererRef.current?.setScrollSpeed(v); }}
              className="w-5 h-5 rounded bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3 transition-colors cursor-pointer flex items-center justify-center text-xs leading-none">-</button>
            <span className="text-xs text-white font-bold w-5 text-center tabular-nums">{scrollSpeed}</span>
            <button onClick={() => { const v = Math.min(40, scrollSpeed + 1); setScrollSpeed(v); rendererRef.current?.setScrollSpeed(v); }}
              className="w-5 h-5 rounded bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3 transition-colors cursor-pointer flex items-center justify-center text-xs leading-none">+</button>
          </div>

          {/* Divider */}
          <div className="w-px h-5 bg-osu-b3/40" />

          {/* Skin upload */}
          <div className="flex items-center gap-1.5">
            <input ref={skinFileRef} type="file" accept=".osk,.zip" onChange={handleSkinUpload} className="hidden" />
            {skin ? (
              <>
                <span className="text-[10px] text-osu-green-light truncate max-w-24" title={skin.name}>{skin.name}</span>
                <button onClick={handleRemoveSkin}
                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition-colors bg-osu-b3/50 text-osu-f1 hover:text-osu-red-light hover:bg-osu-red/20">
                  &times;
                </button>
              </>
            ) : (
              <button onClick={() => skinFileRef.current?.click()} disabled={skinLoading}
                className="px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3 disabled:opacity-50">
                {skinLoading ? "Loading..." : "Skin"}
              </button>
            )}
          </div>

          {/* BG Dim — pushed right */}
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-[10px] text-osu-f1">BG Dim</span>
            <input type="range" min={0} max={100} step={5} value={bgDim}
              onChange={(e) => { const v = Number(e.target.value); setBgDim(v); rendererRef.current?.setBackgroundDim(v); }}
              className={`w-20 ${sliderClass}`} />
            <span className="text-[10px] text-osu-f1 tabular-nums w-7">{bgDim}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
