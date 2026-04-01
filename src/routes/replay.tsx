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
import type { ManiaBeatmap } from "../lib/beatmap-parser";
import type { OsuScore, ReplayFrame } from "../lib/types";

interface ReplaySearch {
  scoreId?: number;
  mode?: string;
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
  }),
});

function ReplayPage() {
  const { scoreId, mode } = Route.useSearch();
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
      // Fetch parsed replay + score info in parallel (parsing happens server-side)
      const [parsed, score] = await Promise.all([
        getReplayParsed({ data: { scoreId: sid, mode: m } }),
        getScore({ data: { scoreId: sid } }).catch(() => null),
      ]);

      setReplay(parsed);
      if (score) setScoreInfo(score);

      // Fetch beatmap .osu file if we have the beatmap ID
      const beatmapId = score?.beatmap?.id;
      if (beatmapId) {
        try {
          const bmFile = await getBeatmapFile({ data: { beatmapId } });
          setBeatmap(parseManiaBeatmap(bmFile.content));
        } catch { /* continue without notes */ }
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
                <ReplayViewer replay={replay} beatmap={beatmap} />
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
                        onClick={() => navigate({ to: "/replay", search: { scoreId: s.id, mode: "mania" } })}>
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

function ReplayInfo({ replay, score: _score, beatmap, onClear }: {
  replay: ServerReplay; score: OsuScore | null; beatmap: ManiaBeatmap | null; onClear: () => void;
}) {
  const h = replay.header;
  const totalHits = h.countGeki + h.count300 + h.countKatu + h.count100 + h.count50;
  const accuracy = totalHits + h.countMiss > 0
    ? ((h.countGeki * 320 + h.count300 * 300 + h.countKatu * 200 + h.count100 * 100 + h.count50 * 50) / ((totalHits + h.countMiss) * 320) * 100) : 0;

  return (
    <div className="bg-osu-b4 rounded-xl p-4 mb-4 border border-osu-b3/20">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Player</div><div className="text-sm font-bold text-white">{h.playerName}</div></div>
        {beatmap && <div><div className="text-[9px] uppercase tracking-wider text-osu-f1">Map</div><div className="text-sm font-medium text-osu-l2">{beatmap.title} [{beatmap.version}]</div></div>}
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

function ReplayViewer({ replay, beatmap }: { replay: ServerReplay; beatmap: ManiaBeatmap | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ManiaReplayRenderer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const [zoom, setZoom] = useState(0.5);
  const progressInterval = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    if (!canvasRef.current || replay.frames.length === 0) return;
    const renderer = new ManiaReplayRenderer(canvasRef.current, replay.frames, replay.keyCount, beatmap?.notes ?? []);
    rendererRef.current = renderer;
    const handleResize = () => renderer.resize();
    window.addEventListener("resize", handleResize);
    return () => { renderer.destroy(); window.removeEventListener("resize", handleResize); };
  }, [replay, beatmap]);

  useEffect(() => {
    if (progressInterval.current) clearInterval(progressInterval.current);
    if (isPlaying) {
      progressInterval.current = setInterval(() => {
        const r = rendererRef.current;
        if (r) { setProgress(r.time / r.duration); if (!r.isPlaying) setIsPlaying(false); }
      }, 50);
    }
    return () => { if (progressInterval.current) clearInterval(progressInterval.current); };
  }, [isPlaying]);

  const togglePlay = () => {
    const r = rendererRef.current;
    if (!r) return;
    if (isPlaying) { r.pause(); setIsPlaying(false); }
    else { if (r.time >= r.duration) r.seek(0); r.play(); setIsPlaying(true); }
  };

  const formatTime = (ratio: number) => {
    const ms = ratio * (rendererRef.current?.duration ?? 0);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  };

  return (
    <div className="space-y-3">
      <div className="rounded-xl overflow-hidden border border-osu-b3/20 bg-[#1a1016]">
        <canvas ref={canvasRef} className="w-full" style={{ height: 500 }} />
      </div>
      <div className="bg-osu-b4 rounded-xl p-4 border border-osu-b3/20 space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-osu-f1 w-10">{formatTime(progress)}</span>
          <input type="range" min={0} max={1} step={0.001} value={progress}
            onChange={(e) => { const v = Number(e.target.value); setProgress(v); rendererRef.current?.seek(v * (rendererRef.current?.duration ?? 0)); }}
            className="flex-1 h-1.5 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink" />
          <span className="text-[10px] text-osu-f1 w-10 text-right">{formatTime(1)}</span>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={togglePlay} className="w-10 h-10 rounded-full bg-osu-pink hover:bg-osu-pink-light transition-colors flex items-center justify-center cursor-pointer">
            <span className="text-white text-sm font-bold">{isPlaying ? "||" : ">"}</span>
          </button>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-osu-f1 mr-1">Speed:</span>
            {[0.25, 0.5, 1, 1.5, 2].map((s) => (
              <button key={s} onClick={() => { setSpeed(s); rendererRef.current?.setSpeed(s); }}
                className={`px-2 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors ${speed === s ? "bg-osu-pink text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white"}`}>{s}x</button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-[10px] text-osu-f1">Zoom:</span>
            <input type="range" min={0.1} max={1.5} step={0.05} value={zoom}
              onChange={(e) => { const v = Number(e.target.value); setZoom(v); rendererRef.current?.setZoom(v); }}
              className="w-24 h-1 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink" />
          </div>
        </div>
      </div>
    </div>
  );
}
