import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { getRankings, getCountryRecentScores, getUserScoresBest } from "../lib/osu";
import { formatNumber, formatAccuracy, formatTimeAgo, formatPP } from "../lib/format";
import { Avatar } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { PlayerCardSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";
import type { RankingsResponse, OsuScore } from "../lib/types";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  const [rankings, setRankings] = useState<RankingsResponse | null>(null);
  const [rankingsError, setRankingsError] = useState<string | null>(null);

  // Client-side: fetch recent scores
  const [recentScores, setRecentScores] = useState<OsuScore[]>([]);
  const [loadingScores, setLoadingScores] = useState(true);

  // Client-side: fetch popoffs (recent best scores from top 10)
  const [popoffs, setPopoffs] = useState<{ user: { username: string; avatar_url: string }; score: OsuScore }[]>([]);
  const [loadingPopoffs, setLoadingPopoffs] = useState(true);

  useEffect(() => {
    let cancelled = false;

    getRankings({ data: { type: "performance", page: 1, country: "CR" } })
      .then((data) => {
        if (cancelled) return;
        setRankings(data);
        setRankingsError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setRankingsError("Couldn't load the Costa Rica rankings right now.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!rankings) return;

    let cancelled = false;
    const userIds = rankings.ranking.map((entry: RankingsResponse["ranking"][number]) => entry.user.id);

    setLoadingScores(true);
    setRecentScores([]);

    getCountryRecentScores({ data: { userIds, batchSize: 10, batchIndex: 0 } })
      .then((scores) => {
        if (cancelled) return;
        setRecentScores(scores.slice(0, 5));
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingScores(false);
      });

    setLoadingPopoffs(true);
    setPopoffs([]);

    const top10 = rankings.ranking.slice(0, 10);
    Promise.allSettled(
      top10.map(async (entry: RankingsResponse["ranking"][number]) => {
        const scores = await getUserScoresBest({ data: { userId: entry.user.id, limit: 5 } });
        return scores
          .filter((s: OsuScore) => {
            const age = Date.now() - new Date(s.created_at).getTime();
            return age < 7 * 24 * 60 * 60 * 1000 && s.pp && s.pp > 0;
          })
          .map((s: OsuScore) => ({
            user: { username: entry.user.username, avatar_url: entry.user.avatar_url },
            score: s,
          }));
      }),
    )
      .then((results) => {
        if (cancelled) return;

        const all = results
          .filter((r): r is PromiseFulfilledResult<{ user: { username: string; avatar_url: string }; score: OsuScore }[]> => r.status === "fulfilled")
          .flatMap((r) => r.value)
          .sort((a, b) => new Date(b.score.created_at).getTime() - new Date(a.score.created_at).getTime())
          .slice(0, 5);

        setPopoffs(all);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingPopoffs(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rankings]);

  const topPlayers = rankings?.ranking.slice(0, 5) ?? [];

  return (
    <div className="flex-1 relative overflow-hidden min-h-[calc(100vh-60px)]">
      {/* Full-page background */}
      <div className="absolute inset-0 pointer-events-none">
        <img
          src="/images/layout/nav2-background-hue0.png"
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-15"
          style={{ filter: "hue-rotate(333deg) saturate(0.6)", transform: "scale(2.5)", transformOrigin: "center" }}
        />
        <ManiaRain />
      </div>

      {/* Hero */}
      <section className="relative py-14 px-5">
        <div className="max-w-[1200px] mx-auto text-center">
          <div className="flex items-center justify-center gap-3">
            <span className="mode-icon text-osu-pink text-4xl">{"\ue802"}</span>
            <h1 className="text-4xl font-bold text-white" style={{ fontFamily: "Venera" }}>mania CR</h1>
          </div>
        </div>
      </section>

      <div className="relative max-w-[1200px] mx-auto px-5 pb-8 grid grid-cols-1 lg:grid-cols-[1fr_1fr_1fr] gap-4">
        {/* CR Top 5 */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:row-span-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">CR Top 50</h2>
            <Link to="/rankings" className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
          </div>
          <div className="divide-y divide-osu-b3/15">
            {rankingsError ? (
              <div className="px-4 py-6 text-center text-xs text-osu-f1">{rankingsError}</div>
            ) : topPlayers.length > 0 ? (
              topPlayers.map((entry: RankingsResponse["ranking"][number], i: number) => (
                <motion.div key={entry.user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                  onClick={() => navigate({ to: "/player/$username", params: { username: entry.user.username } })}>
                  <span className="text-sm font-bold text-osu-f1 w-6 text-center">#{i + 1}</span>
                  <Avatar url={entry.user.avatar_url} size={30} />
                  <span className="text-sm font-medium text-white flex-1 truncate">{entry.user.username}</span>
                  <span className="text-xs font-bold text-right">{formatNumber(Math.round(entry.pp))}pp</span>
                </motion.div>
              ))
            ) : (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-3 py-1">
                  <PlayerCardSkeleton />
                </div>
              ))
            )}
          </div>
        </section>

        {/* Recent Pop-offs - featured */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Recent Pop-offs</h2>
            <Link to="/popoffs" className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
          </div>
          {loadingPopoffs ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-osu-b3/15">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-osu-b4 p-4 space-y-3">
                  <Skeleton className="h-8 w-16 mx-auto" />
                  <Skeleton className="h-8 w-8 rounded-full mx-auto" />
                  <Skeleton className="h-3 w-24 mx-auto" />
                  <Skeleton className="h-2.5 w-32 mx-auto" />
                </div>
              ))}
            </div>
          ) : popoffs.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-osu-b3/15">
              {popoffs.slice(0, 3).map((p, i) => (
                <motion.div key={p.score.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}
                  className="bg-osu-b4 p-4 hover:bg-osu-b3/50 transition-colors cursor-pointer text-center"
                  onClick={() => navigate({ to: "/player/$username", params: { username: p.user.username } })}>
                  <div className="text-2xl font-bold text-osu-pink mb-1" style={{ fontFamily: "Venera" }}>{Math.round(p.score.pp ?? 0)}pp</div>
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <GradeImg grade={p.score.rank} size={18} />
                    <Avatar url={p.user.avatar_url} size={24} />
                    <span className="text-xs font-medium text-white">{p.user.username}</span>
                  </div>
                  <div className="text-[10px] text-osu-f1 truncate">{p.score.beatmapset?.title}</div>
                  <div className="text-[10px] text-osu-f1 truncate">[{p.score.beatmap?.version}]</div>
                  <div className="text-[9px] text-osu-f1/60 mt-1">{formatTimeAgo(p.score.created_at)}</div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-center text-xs text-osu-f1">No recent pop-offs</div>
          )}
        </section>

        {/* Recent Scores */}
        <section className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-osu-b3/20">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">Recent Scores</h2>
            <Link to="/scores" className="text-[10px] text-osu-pink hover:text-osu-pink-light transition-colors">view all</Link>
          </div>
          <div className="divide-y divide-osu-b3/15">
            {loadingScores ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <Skeleton className="w-6 h-6 rounded" />
                  <Skeleton className="w-7 h-7 rounded-full" />
                  <div className="flex-1 space-y-1"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-2.5 w-48" /></div>
                  <Skeleton className="h-3.5 w-12" />
                </div>
              ))
            ) : recentScores.length > 0 ? (
              recentScores.map((s: OsuScore, i: number) => (
                <motion.div key={s.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-osu-b3/50 transition-colors cursor-pointer"
                  onClick={() => navigate({ to: "/player/$username", params: { username: s.user?.username } })}>
                  <GradeImg grade={s.rank} size={22} />
                  <Avatar url={s.user?.avatar_url} size={26} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{s.user?.username} <span className="text-osu-f1">on</span> {s.beatmapset?.title}</div>
                    <div className="text-[10px] text-osu-f1">[{s.beatmap?.version}] {s.beatmap?.cs && `${s.beatmap.cs}K`}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-osu-l2">{formatAccuracy(s.accuracy)}</span>
                    <span className="text-xs font-bold">{formatPP(s.pp)}</span>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="px-4 py-6 text-center text-xs text-osu-f1">No recent scores</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const NOTE_IMAGES = [
  "/images/notes/arrow-down-gray.png", "/images/notes/arrow-down-green.png",
  "/images/notes/arrow-left-gray.png", "/images/notes/arrow-left-pink.png",
  "/images/notes/arrow-right-gray.png", "/images/notes/arrow-right-green.png",
  "/images/notes/arrow-up-gray.png", "/images/notes/arrow-up-pink.png",
  "/images/notes/bar-blue.png", "/images/notes/bar-gray.png",
  "/images/notes/bar-red.png", "/images/notes/bar-yellow.png",
  "/images/notes/circle-blue.png", "/images/notes/circle-blue-light.png",
  "/images/notes/circle-gray.png", "/images/notes/circle-green.png",
  "/images/notes/circle-navy.png", "/images/notes/circle-pink.png",
  "/images/notes/circle-pink-glow.png", "/images/notes/circle-purple.png",
  "/images/notes/circle-violet.png", "/images/notes/circle-white.png",
];

interface FallingNote {
  x: number;
  y: number;
  speed: number;
  size: number;
  opacity: number;
  imgIndex: number;
  rotation: number;
  rotSpeed: number;
}

function createNote(canvasW: number, canvasH: number, startAbove: boolean): FallingNote {
  return {
    x: Math.random() * canvasW,
    y: startAbove ? -(Math.random() * canvasH) : Math.random() * canvasH,
    speed: 20 + Math.random() * 40,
    size: 20 + Math.random() * 20,
    opacity: 0.04 + Math.random() * 0.08,
    imgIndex: Math.floor(Math.random() * NOTE_IMAGES.length),
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.3,
  };
}

function ManiaRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const notesRef = useRef<FallingNote[]>([]);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.parentElement!.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    notesRef.current = Array.from({ length: 30 }, () =>
      createNote(canvas.width, canvas.height, false)
    );
  }, []);

  useEffect(() => {
    // Preload all note images
    imagesRef.current = NOTE_IMAGES.map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });

    init();

    const onResize = () => init();
    window.addEventListener("resize", onResize);

    const animate = (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dt = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0.016;
      lastTimeRef.current = time;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const note of notesRef.current) {
        note.y += note.speed * dt;
        note.rotation += note.rotSpeed * dt;

        // Seamless wrap: once fully off the bottom, reappear above
        if (note.y > canvas.height + note.size) {
          note.y = -note.size;
          note.x = Math.random() * canvas.width;
          note.imgIndex = Math.floor(Math.random() * NOTE_IMAGES.length);
        }

        const img = imagesRef.current[note.imgIndex];
        if (!img || !img.complete) continue;

        ctx.save();
        ctx.globalAlpha = note.opacity;
        ctx.translate(note.x, note.y);
        ctx.rotate(note.rotation);
        ctx.drawImage(img, -note.size / 2, -note.size / 2, note.size, note.size);
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [init]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  );
}
