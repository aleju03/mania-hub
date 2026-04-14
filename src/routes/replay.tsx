import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getReplayParsed, getBeatmapFile, getScore, getUserScoresBest, getUserScoresFirsts, getUserScoresPinned, getUserScoresRecent, searchUsers, searchBeatmaps, getBeatmapScores, getRankings } from "../lib/osu";
import { parseManiaBeatmap } from "../lib/beatmap-parser";
import { filterBeatmapSearchResults } from "../lib/beatmap-search";
import { getDisplayedAccuracy, getDisplayedRank, scoreHasReplay } from "../lib/score";
import { useAppStore, useSelectedCountry } from "../store";
import { PageHeader } from "../components/layout/PageHeader";
import { SearchInput } from "../components/ui/SearchInput";
import { GradeImg } from "../components/ui/GradeImg";
import { formatAccuracy, formatPP } from "../lib/format";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { track } from "../lib/posthog";
import type { ManiaSkin } from "../lib/skin-parser";
import type { ManiaBeatmap } from "../lib/beatmap-parser";
import type { OsuScore, OsuBeatmapset, OsuBeatmap, ReplayFrame } from "../lib/types";

const REPLAY_VOLUME_STORAGE_KEY = "mania-hub-replay-volume";
const REPLAY_INPUT_OVERLAY_STORAGE_KEY = "mania-hub-replay-input-overlay";
const REPLAY_BG_DIM_STORAGE_KEY = "mania-hub-replay-bg-dim";
const REPLAY_PLAYER_SCROLL_STORAGE_KEY = "mania-hub-replay-player-scroll";

interface ReplaySearch {
  scoreId?: number;
  beatmapsetId?: number;
  t?: number; // timestamp in seconds to seek to on load
  tab?: "player" | "beatmap";
  player?: string; // selected player username (for URL state)
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
  replayScrollY?: number;
}

const REPLAY_SCROLL_CALIBRATION_SLOPE = 2.3819505316513596;
const REPLAY_SCROLL_CALIBRATION_INTERCEPT = -6.496179351347244;

function getReplayScrollSpeed(replay: ServerReplay): number | null {
  if (!Number.isFinite(replay.replayScrollY) || (replay.replayScrollY ?? 0) <= 0) return null;

  // Heuristic calibration from verified replay samples:
  // Aleju replay y=16.16162 -> 32 scroll
  // Anthony replay y=14.0625 -> 27 scroll
  const derived = Math.round(REPLAY_SCROLL_CALIBRATION_SLOPE * replay.replayScrollY! + REPLAY_SCROLL_CALIBRATION_INTERCEPT);
  return Math.max(1, Math.min(40, derived));
}

function readPlayerScrollOverrides(): Record<string, number> {
  if (typeof window === "undefined") return {};

  const raw = window.localStorage.getItem(REPLAY_PLAYER_SCROLL_STORAGE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => Number.isFinite(value)).map(([key, value]) => [
        key,
        Math.max(1, Math.min(40, Math.round(Number(value)))),
      ]),
    );
  } catch {
    return {};
  }
}

function writePlayerScrollOverride(userId: number, scrollSpeed: number) {
  if (typeof window === "undefined") return;

  const next = {
    ...readPlayerScrollOverrides(),
    [String(userId)]: Math.max(1, Math.min(40, Math.round(scrollSpeed))),
  };

  window.localStorage.setItem(REPLAY_PLAYER_SCROLL_STORAGE_KEY, JSON.stringify(next));
}

interface ReplayRendererLike {
  readonly duration: number;
  readonly displayDuration: number;
  readonly time: number;
  readonly isPlaying: boolean;
  destroy: () => void;
  pause: () => void;
  play: () => void;
  resize: () => void;
  seek: (timeMs: number) => void;
  setBackgroundDim: (value: number) => void;
  setBackgroundImage: (image: HTMLImageElement | null) => void;
  setScrollSpeed: (value: number) => void;
  setShowInputOverlay: (value: boolean) => void;
  setSkin: (skin: ManiaSkin | null) => void;
  setSpeed: (value: number) => void;
}

export const Route = createFileRoute("/replay")({
  component: ReplayPage,
  validateSearch: (s: Record<string, unknown>): ReplaySearch => ({
    scoreId: Number(s.scoreId) || undefined,
    beatmapsetId: Number(s.beatmapsetId) || undefined,
    t: Number(s.t) || undefined,
    tab: s.tab === "beatmap" ? "beatmap" : undefined,
    player: (s.player as string) || undefined,
  }),
});

type BrowseMode = "player" | "beatmap";

function ReplayPage() {
  const { scoreId, beatmapsetId, t: initialTime, tab, player: playerParam } = Route.useSearch();
  const navigate = useNavigate();
  const selectedCountry = useSelectedCountry();
  const cachedRankings = useAppStore((s) => s.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((s) => s.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((s) => s.setRankings);
  const [replay, setReplay] = useState<ServerReplay | null>(null);
  const [beatmap, setBeatmap] = useState<ManiaBeatmap | null>(null);
  const [scoreInfo, setScoreInfo] = useState<OsuScore | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Player browse state
  const [playerScoreGroups, setPlayerScoreGroups] = useState<{ best: OsuScore[]; firsts: OsuScore[]; pinned: OsuScore[]; recent: OsuScore[] } | null>(null);
  const [loadingScores, setLoadingScores] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [loadedPlayerParam, setLoadedPlayerParam] = useState<string | null>(null);

  // Browse mode
  const [browseMode, setBrowseMode] = useState<BrowseMode>(tab === "beatmap" ? "beatmap" : "player");

  // Beatmap browse state
  const [beatmapQuery, setBeatmapQuery] = useState("");
  const [beatmapResults, setBeatmapResults] = useState<OsuBeatmapset[]>([]);
  const [beatmapSearchLoading, setBeatmapSearchLoading] = useState(false);
  const [selectedBeatmapset, setSelectedBeatmapset] = useState<OsuBeatmapset | null>(null);
  const [selectedDiffId, setSelectedDiffId] = useState<number | null>(null);
  const [rawBeatmapScores, setRawBeatmapScores] = useState<OsuScore[]>([]);
  const [loadingBeatmapScores, setLoadingBeatmapScores] = useState(false);
  const beatmapTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const beatmapScores = useMemo(
    () => rawBeatmapScores.filter((s) => scoreHasReplay(s)),
    [rawBeatmapScores],
  );
  const normalizedPlayerParam = playerParam?.trim().toLowerCase() ?? null;

  const loadReplay = useCallback(async (sid: number) => {
    setError(null);
    setLoading(true);
    setReplay(null);
    setBeatmap(null);

    try {
      // Fetch score first to get key count (beatmap.cs) for correct replay parsing
      const score = await getScore({ data: { scoreId: sid, mode: "mania" } }).catch(() => null);
      if (score) {
        setScoreInfo(score);
        track("replay_view", {
          replay_score_id: String(sid),
          replay_beatmapset_id: score.beatmapset?.id,
          replay_beatmap_id: score.beatmap?.id,
          replay_title: score.beatmapset?.title,
          replay_artist: score.beatmapset?.artist,
          replay_difficulty: score.beatmap?.version,
          replay_creator: score.beatmapset?.creator,
          replay_player: score.user?.username,
          replay_cover_url: score.beatmapset?.covers?.list,
        });
      }

      // Fetch replay with key count from score API, and beatmap file in parallel
      const keyCount = score?.beatmap?.cs ? Math.round(score.beatmap.cs) : undefined;
      const [parsed, bmResult] = await Promise.all([
        getReplayParsed({ data: { scoreId: sid, mode: "mania", keyCount } }),
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
    if (scoreId) {
      loadReplay(scoreId);
      return;
    }

    setLoading(false);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);
    setError(null);
  }, [scoreId, loadReplay]);

  useEffect(() => {
    if (scoreId) return;
    setBrowseMode(tab === "beatmap" ? "beatmap" : "player");
  }, [scoreId, tab]);

  // Debounced beatmap search
  useEffect(() => {
    if (browseMode !== "beatmap") return;
    if (beatmapQuery.length < 2) {
      setBeatmapResults([]);
      return;
    }
    setBeatmapSearchLoading(true);
    clearTimeout(beatmapTimerRef.current);
    beatmapTimerRef.current = setTimeout(async () => {
      try {
        const res = await searchBeatmaps({ data: { query: beatmapQuery } });
        setBeatmapResults(filterBeatmapSearchResults(res.beatmapsets, beatmapQuery).slice(0, 12));
      } catch {
        setBeatmapResults([]);
      } finally {
        setBeatmapSearchLoading(false);
      }
    }, 350);
    return () => clearTimeout(beatmapTimerRef.current);
  }, [beatmapQuery, browseMode]);

  const handlePlayerSearch = async (q: string) => {
    const res = await searchUsers({ data: { query: q } });
    return (res.user?.data ?? []).slice(0, 6).map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code,
    }));
  };

  const loadPlayerScores = useCallback(async (userId: number) => {
    setLoadingScores(true);
    setExpandedSections({});
    try {
      const [best, firsts, pinned, recent] = await Promise.all([
        getUserScoresBest({ data: { userId, limit: 100 } }).catch(() => [] as OsuScore[]),
        getUserScoresFirsts({ data: { userId, limit: 100 } }).catch(() => [] as OsuScore[]),
        getUserScoresPinned({ data: { userId, limit: 50 } }).catch(() => [] as OsuScore[]),
        getUserScoresRecent({ data: { userId, limit: 50, include_fails: true } }).catch(() => [] as OsuScore[]),
      ]);
      const filterReplayable = (scores: OsuScore[]) => scores.filter((s) => scoreHasReplay(s));
      const pinnedFiltered = filterReplayable(pinned);
      const pinnedIds = new Set(pinnedFiltered.map((s) => s.id));
      const bestFiltered = filterReplayable(best).filter((s) => !pinnedIds.has(s.id));
      const bestIds = new Set(bestFiltered.map((s) => s.id));
      const firstsFiltered = filterReplayable(firsts).filter((s) => !pinnedIds.has(s.id) && !bestIds.has(s.id));
      // Recent is intentionally NOT deduped against the others — a recent play
      // that is also a best score is exactly what you want to see as "new".
      const recentFiltered = filterReplayable(recent);
      setPlayerScoreGroups({ best: bestFiltered, firsts: firstsFiltered, pinned: pinnedFiltered, recent: recentFiltered });
    } catch { setPlayerScoreGroups({ best: [], firsts: [], pinned: [], recent: [] }); }
    finally { setLoadingScores(false); }
  }, []);

  const handleSelectPlayer = async (user: { id: number; username: string }) => {
    navigate({ to: "/replay", search: { player: user.username } });
    setPlayerScoreGroups(null);
    setLoadedPlayerParam(null);
    await loadPlayerScores(user.id);
    setLoadedPlayerParam(user.username.trim().toLowerCase());
  };

  // Fetch country rankings to power the player suggestions grid (cached in store).
  useEffect(() => {
    if (browseMode !== "player") return;
    const stale = !cachedRankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);
    if (!stale) return;
    let cancelled = false;
    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((data) => {
        if (cancelled) return;
        setRankings(selectedCountry, data);
      })
      .catch(() => { /* suggestions are non-critical */ });
    return () => { cancelled = true; };
  }, [browseMode, cachedRankings, rankingsFetchedAt, selectedCountry, setRankings]);

  const suggestionPlayers = useMemo(
    () => (cachedRankings?.ranking ?? [])
      .filter((entry) => entry.user.is_active !== false)
      .slice(0, 12)
      .map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
        global_rank: entry.global_rank,
      })),
    [cachedRankings],
  );

  // Auto-load player scores when arriving via URL with ?player=
  useEffect(() => {
    if (scoreId) return;
    if (!normalizedPlayerParam) {
      setPlayerScoreGroups(null);
      setLoadedPlayerParam(null);
      setExpandedSections({});
      return;
    }
    if (loadingScores || loadedPlayerParam === normalizedPlayerParam) return;

    setPlayerScoreGroups(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await searchUsers({ data: { query: playerParam! } });
        const match = (res.user?.data ?? []).find(
          (u: { username: string }) => u.username.toLowerCase() === normalizedPlayerParam,
        );
        if (cancelled) return;

        if (match) {
          await loadPlayerScores(match.id);
          if (!cancelled) setLoadedPlayerParam(normalizedPlayerParam);
          return;
        }

        setPlayerScoreGroups({ best: [], firsts: [], pinned: [], recent: [] });
        setLoadedPlayerParam(normalizedPlayerParam);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [normalizedPlayerParam, playerParam, scoreId, loadingScores, loadedPlayerParam, loadPlayerScores]);

  const handleSelectDifficulty = async (bm: OsuBeatmap) => {
    setSelectedDiffId(bm.id);
    setLoadingBeatmapScores(true);
    setRawBeatmapScores([]);
    try {
      const res = await getBeatmapScores({ data: { beatmapId: bm.id, country: selectedCountry } });
      setRawBeatmapScores(res.scores);
    } catch {
      setRawBeatmapScores([]);
    } finally {
      setLoadingBeatmapScores(false);
    }
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
                  navigate({ to: "/replay", search: playerParam ? { player: playerParam } : tab === "beatmap" ? { tab: "beatmap" } : {} });
                }} />
                <ReplayViewer replay={replay} beatmap={beatmap} scoreInfo={scoreInfo} fallbackBeatmapsetId={beatmapsetId} initialTime={initialTime} />
              </motion.div>
            ) : (
              <motion.div key="browse" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {/* Tab toggle */}
                <div className="flex justify-center mb-6">
                  <div className="flex bg-osu-b4 rounded-lg border border-osu-b3/50 overflow-hidden">
                    {(["player", "beatmap"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          setBrowseMode(m);
                          setPlayerScoreGroups(null);
                          setBeatmapResults([]);
                          setRawBeatmapScores([]);
                          setSelectedBeatmapset(null);
                          setSelectedDiffId(null);
                          setBeatmapQuery("");
                          setError(null);
                          navigate({ to: "/replay", search: m === "beatmap" ? { tab: "beatmap" } : {}, replace: true });
                        }}
                        className={`px-5 py-2 text-xs font-semibold uppercase tracking-wider cursor-pointer transition-colors ${
                          browseMode === m
                            ? "bg-osu-pink/20 text-osu-pink-light"
                            : "text-osu-f1 hover:text-white"
                        }`}
                      >
                        {m === "player" ? "By Player" : "By Beatmap"}
                      </button>
                    ))}
                  </div>
                </div>

                {error && (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-xs text-osu-red-light bg-osu-red/10 px-4 py-2 rounded-lg text-center max-w-lg mx-auto mb-6">{error}</motion.p>
                )}

                {browseMode === "player" && (
                  <>
                    <div className="max-w-lg mx-auto mb-8">
                      <h3 className="text-sm font-semibold text-osu-f1 uppercase tracking-wider mb-3 text-center">
                        Search a player to view their replays
                      </h3>
                      <SearchInput placeholder="Search player..." onSearch={handlePlayerSearch} onSelect={handleSelectPlayer} />
                    </div>

                    {loadingScores && (
                      <div className="flex justify-center py-8">
                        <div className="w-6 h-6 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                      </div>
                    )}

                    {playerScoreGroups && (playerScoreGroups.best.length > 0 || playerScoreGroups.firsts.length > 0 || playerScoreGroups.pinned.length > 0 || playerScoreGroups.recent.length > 0) && (
                      <div className="space-y-5">
                        {([
                          { key: "pinned", label: "Pinned", scores: playerScoreGroups.pinned },
                          { key: "recent", label: "Recent Plays", scores: playerScoreGroups.recent },
                          { key: "best", label: "Best Scores", scores: playerScoreGroups.best },
                          { key: "firsts", label: "First Places", scores: playerScoreGroups.firsts },
                        ] as const).map(({ key, label, scores }) => {
                          if (scores.length === 0) return null;
                          const isExpanded = expandedSections[key];
                          const visible = isExpanded ? scores : scores.slice(0, 5);
                          const hasMore = scores.length > 5;
                          return (
                            <div key={key} className="space-y-1.5">
                              <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-2">
                                {label} ({scores.length})
                              </h4>
                              {visible.map((s: OsuScore, i: number) => (
                                <motion.div key={s.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}
                                  className="flex items-center gap-3 py-2.5 px-4 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20"
                                  onClick={() => navigate({ to: "/replay", search: { scoreId: s.id, beatmapsetId: s.beatmapset?.id, player: playerParam } })}>
                                  <GradeImg grade={getDisplayedRank(s)} size={26} />
                                  {s.beatmapset?.covers?.list && (
                                    <img src={s.beatmapset.covers.list} alt="" className="w-12 h-8 rounded object-cover flex-shrink-0" loading="lazy" />
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm text-white truncate">{s.beatmapset?.title}</div>
                                    <div className="text-[10px] text-osu-f1">[{s.beatmap?.version}] {s.beatmap?.cs && `${s.beatmap.cs}K`}</div>
                                  </div>
                                  <span className="text-xs text-osu-l2">{formatAccuracy(getDisplayedAccuracy(s))}</span>
                                  <span className="text-sm font-bold">{formatPP(s.pp)}</span>
                                  <span className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold">Watch</span>
                                </motion.div>
                              ))}
                              {hasMore && (
                                <button
                                  onClick={() => setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }))}
                                  className="w-full py-2 text-xs font-semibold text-osu-f1 hover:text-white transition-colors cursor-pointer"
                                >
                                  {isExpanded ? "Show Less" : `Show ${scores.length - 5} More`}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {!loadingScores && playerScoreGroups && playerScoreGroups.best.length === 0 && playerScoreGroups.firsts.length === 0 && playerScoreGroups.pinned.length === 0 && playerScoreGroups.recent.length === 0 && (
                      <div className="text-center py-8 text-osu-f1 text-sm">
                        No replays available for this player
                      </div>
                    )}

                    {!loadingScores && !playerScoreGroups && !error && (
                      suggestionPlayers.length > 0 ? (
                        <div>
                          <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-3 text-center">
                            Top {getCountryName(selectedCountry)} Players
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                            {suggestionPlayers.map((p, i) => (
                              <motion.button
                                key={p.id}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.02 }}
                                onClick={() => handleSelectPlayer(p)}
                                className="flex items-center gap-3 py-2.5 px-3 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20 text-left"
                              >
                                <img src={p.avatar_url} alt="" className="w-9 h-9 rounded-full flex-shrink-0 object-cover" loading="lazy" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-white truncate">{p.username}</div>
                                  <div className="text-[10px] text-osu-f1">#{p.global_rank.toLocaleString()}</div>
                                </div>
                              </motion.button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-12 text-osu-f1 text-sm">
                          Search for a player above to browse their available replays
                        </div>
                      )
                    )}
                  </>
                )}

                {browseMode === "beatmap" && (
                  <>
                    <div className="max-w-lg mx-auto mb-8">
                      <h3 className="text-sm font-semibold text-osu-f1 uppercase tracking-wider mb-3 text-center">
                        Search a beatmap, then pick a difficulty
                      </h3>
                      <div className="relative">
                        <input
                          type="text"
                          value={beatmapQuery}
                          onChange={(e) => {
                            setBeatmapQuery(e.target.value);
                            setSelectedDiffId(null);
                            setRawBeatmapScores([]);
                          }}
                          placeholder="Search beatmap..."
                          className="w-full px-4 py-2.5 rounded-lg bg-osu-b4 text-osu-c1 text-sm placeholder:text-osu-f1 border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none transition-colors duration-[120ms] shadow-[inset_0_1px_3px_rgba(0,0,0,0.3)]"
                        />
                        {beatmapSearchLoading && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <div className="w-4 h-4 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Beatmapset results */}
                    {beatmapResults.length > 0 && (
                      <div className="space-y-3 mb-4">
                        <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-2">
                          Beatmaps ({beatmapResults.length})
                        </h4>
                        {beatmapResults.map((bs, i) => {
                          const maniaDiffs = (bs.beatmaps ?? [])
                            .filter((b) => b.mode === "mania")
                            .sort((a, b) => a.cs - b.cs || a.difficulty_rating - b.difficulty_rating);
                          const coverUrl = bs.covers?.["cover@2x"] || bs.covers?.cover;
                          return (
                            <motion.div key={bs.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                              className="relative rounded-xl overflow-hidden border border-osu-b3/20">
                              {/* Background cover image */}
                              {coverUrl && (
                                <img src={coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                              )}
                              <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/75 to-black/50" />
                              <div className="relative z-10 px-4 py-3">
                                <div className="mb-2">
                                  <div className="text-sm font-semibold text-white truncate drop-shadow-sm">{bs.title}</div>
                                  <div className="text-[10px] text-white/60 truncate">{bs.artist} // {bs.creator}</div>
                                </div>
                                {maniaDiffs.length > 0 ? (
                                  <div className="flex flex-wrap gap-1.5">
                                    {maniaDiffs.map((b) => (
                                      <button
                                        key={b.id}
                                        onClick={() => {
                                          setSelectedBeatmapset(bs);
                                          handleSelectDifficulty(b);
                                        }}
                                        className={`px-2.5 py-1 rounded-md text-[11px] cursor-pointer transition-colors border backdrop-blur-sm ${
                                          selectedDiffId === b.id
                                            ? "bg-osu-pink/30 border-osu-pink/60 text-white"
                                            : "bg-black/40 hover:bg-black/60 border-white/10 text-white/90"
                                        }`}
                                      >
                                        <span className="text-osu-yellow font-semibold">{b.cs}K</span>{" "}
                                        <span className="opacity-70">{b.version.replace(/\s*\[\d+[Kk]\]\s*/g, " ").trim()}</span>{" "}
                                        <span className="text-osu-l2">&#9733;{b.difficulty_rating.toFixed(2)}</span>
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-xs text-white/40">No mania difficulties</div>
                                )}
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    )}

                    {/* Loading beatmap scores */}
                    {loadingBeatmapScores && (
                      <div className="flex justify-center py-8">
                        <div className="w-6 h-6 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                      </div>
                    )}

                    {/* Beatmap score results */}
                    {!loadingBeatmapScores && selectedDiffId && beatmapScores.length > 0 && (
                      <div className="space-y-1.5">
                        <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-2">
                          Replays available ({beatmapScores.length})
                        </h4>
                        {beatmapScores.map((s: OsuScore, i: number) => (
                          <motion.div key={s.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}
                            className="flex items-center gap-3 py-2.5 px-4 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20"
                            onClick={() => navigate({ to: "/replay", search: { scoreId: s.id, beatmapsetId: selectedBeatmapset?.id, tab: "beatmap" } })}>
                            <GradeImg grade={getDisplayedRank(s)} size={26} />
                            <img src={s.user?.avatar_url} alt="" className="w-7 h-7 rounded-full flex-shrink-0" loading="lazy" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-white truncate">{s.user?.username}</div>
                            </div>
                            <span className="text-xs text-osu-l2">{formatAccuracy(getDisplayedAccuracy(s))}</span>
                            <span className="text-sm font-bold">{formatPP(s.pp)}</span>
                            <span className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold">Watch</span>
                          </motion.div>
                        ))}
                      </div>
                    )}

                    {/* Empty states */}
                    {!loadingBeatmapScores && selectedDiffId && beatmapScores.length === 0 && rawBeatmapScores.length > 0 && (
                      <div className="text-center py-6 text-osu-f1 text-sm">
                        No replays available from {selectedCountry.toUpperCase()} players on this difficulty
                      </div>
                    )}
                    {!loadingBeatmapScores && selectedDiffId && rawBeatmapScores.length === 0 && (
                      <div className="text-center py-6 text-osu-f1 text-sm">
                        No scores found from {selectedCountry.toUpperCase()} players on this difficulty
                      </div>
                    )}

                    {!beatmapSearchLoading && beatmapResults.length === 0 && beatmapQuery.length < 2 && !selectedDiffId && (
                      <div className="text-center py-12 text-osu-f1 text-sm">
                        Search for a beatmap above to find replays
                      </div>
                    )}
                  </>
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
      <div className="flex flex-wrap items-center gap-x-4 sm:gap-x-6 gap-y-2">
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
  const rendererRef = useRef<ReplayRendererLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const modAcronyms = useMemo(
    () => (scoreInfo?.mods ?? []).map((m: any) => (typeof m === "string" ? m : m.acronym ?? "").toUpperCase()),
    [scoreInfo?.mods],
  );
  const modRate = modAcronyms.includes("DT") || modAcronyms.includes("NC") ? 1.5 : modAcronyms.includes("HT") ? 0.75 : 1;
  const effectiveRate = speed * modRate;
  const [progress, setProgress] = useState(0);
  const [scrollSpeed, setScrollSpeed] = useState(32);
  const [bgDim, setBgDim] = useState(() => {
    if (typeof window === "undefined") return 80;
    const raw = window.localStorage.getItem(REPLAY_BG_DIM_STORAGE_KEY);
    if (raw == null) return 80;
    const stored = Number(raw);
    return Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 80;
  });
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [volume, setVolume] = useState(() => {
    if (typeof window === "undefined") return 0.5;
    const raw = window.localStorage.getItem(REPLAY_VOLUME_STORAGE_KEY);
    if (raw == null) return 0.5;
    const stored = Number(raw);
    return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 0.5;
  });
  const [showInputOverlay, setShowInputOverlay] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem(REPLAY_INPUT_OVERLAY_STORAGE_KEY);
    return stored == null ? false : stored === "true";
  });
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [pendingPlay, setPendingPlay] = useState(false);
  const [bgSrc, setBgSrc] = useState<string | null>(null);
  const scrubbingRef = useRef(false);
  const scrubResumeOnReleaseRef = useRef(false);
  const [skin, setSkin] = useState<ManiaSkin | null>(null);
  const [skinLoading, setSkinLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharePos, setSharePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const skinFileRef = useRef<HTMLInputElement>(null);
  const progressInterval = useRef<ReturnType<typeof setInterval>>(undefined);
  const shouldResumeAudioRef = useRef(false);
  const applyScrollSpeed = useCallback((next: number, persistForPlayer = false) => {
    const normalized = Math.max(1, Math.min(40, Math.round(next)));
    setScrollSpeed(normalized);
    if (persistForPlayer && scoreInfo?.user_id) {
      writePlayerScrollOverride(scoreInfo.user_id, normalized);
    }
  }, [scoreInfo?.user_id]);

  // Build full audio URL from Sayobot CDN using beatmapset ID + audio filename from .osu
  const effectiveBeatmapsetId = scoreInfo?.beatmapset?.id ?? fallbackBeatmapsetId;
  const audioUrl = effectiveBeatmapsetId && beatmap?.audioFilename
    ? `/api/audio?beatmapsetId=${encodeURIComponent(String(effectiveBeatmapsetId))}&filename=${encodeURIComponent(beatmap.audioFilename)}`
    : null;
  const coverUrl = scoreInfo?.beatmapset?.covers?.["cover@2x"] || scoreInfo?.beatmapset?.covers?.cover || null;
  const beatmapBackgroundUrl = effectiveBeatmapsetId && beatmap?.backgroundFilename
    ? `/api/background?beatmapsetId=${encodeURIComponent(String(effectiveBeatmapsetId))}&filename=${encodeURIComponent(beatmap.backgroundFilename)}`
    : null;

  // Prefer the map's real background from the beatmap archive, then fall back to the set cover.
  useEffect(() => {
    let cancelled = false;

    if (!beatmapBackgroundUrl && !coverUrl) {
      setBgSrc(null);
      return () => {
        cancelled = true;
      };
    }

    if (coverUrl) {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (!cancelled) setBgSrc((current) => current ?? coverUrl);
      };
      img.src = coverUrl;
    }

    if (beatmapBackgroundUrl) {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (!cancelled) setBgSrc(beatmapBackgroundUrl);
      };
      img.src = beatmapBackgroundUrl;
    }

    return () => {
      cancelled = true;
    };
  }, [beatmapBackgroundUrl, coverUrl]);

  useEffect(() => {
    setAudioError(null);
    shouldResumeAudioRef.current = false;
    setAudioBlobUrl(null);

    if (!audioUrl) return;

    let cancelled = false;
    let createdBlobUrl: string | null = null;

    (async () => {
      try {
        const response = await fetch(audioUrl);
        if (!response.ok) {
          throw new Error(`Audio fetch failed (${response.status})`);
        }
        const blob = await response.blob();
        if (cancelled) return;
        createdBlobUrl = URL.createObjectURL(blob);
        setAudioBlobUrl(createdBlobUrl);
      } catch (err) {
        if (cancelled) return;
        setAudioError(err instanceof Error ? err.message : "Failed to load audio");
      }
    })();

    return () => {
      cancelled = true;
      if (createdBlobUrl) {
        URL.revokeObjectURL(createdBlobUrl);
      }
    };
  }, [audioUrl]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setShowInputOverlay(showInputOverlay);
    }
  }, [showInputOverlay]);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setScrollSpeed(scrollSpeed);
    }
  }, [scrollSpeed]);

  useEffect(() => {
    const userId = scoreInfo?.user_id;
    const storedOverrides = readPlayerScrollOverrides();

    if (userId && Number.isFinite(storedOverrides[String(userId)])) {
      applyScrollSpeed(storedOverrides[String(userId)]);
      return;
    }

    const replayScrollSpeed = getReplayScrollSpeed(replay);
    applyScrollSpeed(replayScrollSpeed ?? 32);
  }, [applyScrollSpeed, replay, scoreInfo?.user_id]);

  // Create renderer
  useEffect(() => {
    if (!canvasRef.current || replay.frames.length === 0) return;

    let cancelled = false;
    let renderer: ReplayRendererLike | null = null;
    let handleResize: (() => void) | null = null;

    void import("../components/replay/ReplayCanvas").then(({ ManiaReplayRenderer }) => {
      if (cancelled || !canvasRef.current) return;

      renderer = new ManiaReplayRenderer(
        canvasRef.current,
        replay.frames,
        replay.keyCount,
        beatmap?.notes ?? [],
        {
          od: beatmap?.od,
          showInputOverlay,
          mods: modAcronyms,
          transparentBackground: true,
        },
      ) as ReplayRendererLike;

      rendererRef.current = renderer;

      if (skin) renderer.setSkin(skin);
      if (initialTime != null && initialTime > 0) {
        const gameTimeMs = initialTime * 1000 * modRate;
        renderer.seek(gameTimeMs);
        setProgress(gameTimeMs / renderer.duration);
      }

      handleResize = () => renderer?.resize();
      window.addEventListener("resize", handleResize);
    });

    return () => {
      cancelled = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
  }, [replay, beatmap, initialTime, modRate, modAcronyms]);

  // Pass skin to renderer when it changes
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setSkin(skin);
    }
  }, [skin]);

  // Load persisted skin from IndexedDB on mount
  useEffect(() => {
    let cancelled = false;

    void import("../lib/skin-parser").then(async ({ loadSkinFromIDB, parseSkinFile, removeSkinFromIDB }) => {
      const stored = await loadSkinFromIDB();
      if (!stored || cancelled) return;

      try {
        const parsed = await parseSkinFile(stored.data, replay.keyCount);
        if (!cancelled) setSkin(parsed);
      } catch {
        await removeSkinFromIDB();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [replay.keyCount]);

  const handleSkinUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSkinLoading(true);
    try {
      const { parseSkinFile, saveSkinToIDB } = await import("../lib/skin-parser");
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
    const { removeSkinFromIDB } = await import("../lib/skin-parser");
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

        // Re-sync audio every ~2s if drifted more than 200ms.
        // Skip while the tab is hidden: rAF is paused so renderer.time is frozen,
        // but audio keeps playing normally — correcting here would yank audio
        // back to the frozen renderer time. When the tab returns, the next rAF
        // tick advances renderer.time by the elapsed wall clock, which matches
        // where the audio has played to, so both stay in sync automatically.
        syncCounter++;
        if (
          syncCounter >= 40 &&
          audioRef.current &&
          audioEnabled &&
          !audioRef.current.paused &&
          (typeof document === "undefined" || document.visibilityState === "visible")
        ) {
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
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REPLAY_BG_DIM_STORAGE_KEY, String(bgDim));
  }, [bgDim]);

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

  const startPlayback = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
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
  }, [audioEnabled, effectiveRate, volume]);

  const togglePlay = () => {
    const r = rendererRef.current;
    if (!r) return;
    if (isPlaying) {
      r.pause();
      setIsPlaying(false);
      setPendingPlay(false);
      return;
    }
    // Second click while already queued cancels the pending start
    if (pendingPlay) {
      setPendingPlay(false);
      return;
    }
    // Audio is expected but not ready yet — queue the play until the blob lands
    if (audioEnabled && audioUrl && !audioBlobUrl && !audioError) {
      setPendingPlay(true);
      return;
    }
    startPlayback();
  };

  // Auto-start playback once the audio blob finishes loading (or fails, or the
  // user disables audio) after the user already clicked play.
  useEffect(() => {
    if (!pendingPlay || isPlaying) return;
    if (audioEnabled && audioUrl && !audioBlobUrl && !audioError) return;
    setPendingPlay(false);
    startPlayback();
  }, [pendingPlay, isPlaying, audioEnabled, audioUrl, audioBlobUrl, audioError, startPlayback]);

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
      <div className="relative rounded-xl overflow-hidden border border-osu-b3/20 bg-[#0a0a18]">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(180deg, #0a0a18 0%, #1a1016 50%, #0c0c14 100%)" }}
        />
        <AnimatePresence>
          {bgSrc && (
            <motion.img
              key={bgSrc}
              src={bgSrc}
              alt=""
              className="absolute inset-0 h-full w-full object-cover pointer-events-none select-none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: "easeInOut" }}
            />
          )}
        </AnimatePresence>
        <div
          className="absolute inset-0 pointer-events-none bg-black transition-opacity"
          style={{ opacity: bgDim / 100 }}
        />
        <canvas ref={canvasRef} className="relative z-10 w-full" style={{ height: "min(70vh, 600px)" }} />
      </div>

      {/* Audio element (hidden) — full song fetched as a Blob for instant seek without Range requests */}
      {audioBlobUrl && (
        <audio
          ref={audioRef}
          src={audioBlobUrl}
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
            onPointerDown={() => {
              const r = rendererRef.current;
              if (!r) return;
              scrubbingRef.current = true;
              scrubResumeOnReleaseRef.current = r.isPlaying;
              if (r.isPlaying) {
                r.pause();
                setIsPlaying(false);
              }
              if (audioRef.current && !audioRef.current.paused) {
                audioRef.current.pause();
              }
            }}
            onPointerUp={() => {
              const r = rendererRef.current;
              if (!r) {
                scrubbingRef.current = false;
                scrubResumeOnReleaseRef.current = false;
                return;
              }
              scrubbingRef.current = false;
              // Sync audio to the renderer's final position once, on release
              if (audioRef.current && audioEnabled) {
                audioRef.current.currentTime = r.time / 1000;
                audioRef.current.playbackRate = effectiveRate;
                audioRef.current.volume = volume;
              }
              if (scrubResumeOnReleaseRef.current) {
                scrubResumeOnReleaseRef.current = false;
                r.play();
                setIsPlaying(true);
                if (audioRef.current && audioEnabled) {
                  if (audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
                    audioRef.current.play().catch(() => {
                      shouldResumeAudioRef.current = true;
                    });
                  } else {
                    shouldResumeAudioRef.current = true;
                  }
                }
              }
            }}
            onChange={(e) => {
              const v = Number(e.target.value);
              setProgress(v);
              const t = v * (rendererRef.current?.duration ?? 0);
              rendererRef.current?.seek(t);
              // During an active pointer scrub, don't touch audio — we sync
              // it once on release. Keyboard/accessibility scrubs still go
              // through the normal audio sync path.
              if (!scrubbingRef.current) {
                syncAudioTime(t);
              }
            }}
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
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 flex-wrap">
          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            title={pendingPlay ? "Waiting for audio to load..." : undefined}
            className="w-9 h-9 rounded-full bg-osu-pink hover:bg-osu-pink-light transition-colors flex items-center justify-center cursor-pointer shrink-0"
          >
            {pendingPlay ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" className="w-4 h-4 animate-spin">
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            ) : isPlaying ? (
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
                className={`px-1.5 sm:px-2 py-1 rounded text-[10px] font-semibold cursor-pointer transition-colors ${speed === s ? "bg-osu-pink text-white" : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"}`}>{s}x</button>
            ))}
          </div>

          {/* Divider */}
          <div className="w-px h-5 bg-osu-b3/40 hidden sm:block" />

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
                className={`w-12 sm:w-16 ${sliderClass}`} />
            </div>
          )}

          {/* Divider */}
          <div className="w-px h-5 bg-osu-b3/40 hidden sm:block" />

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
            <button onClick={() => { const v = Math.max(1, scrollSpeed - 1); applyScrollSpeed(v, true); rendererRef.current?.setScrollSpeed(v); }}
              className="w-5 h-5 rounded bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3 transition-colors cursor-pointer flex items-center justify-center text-xs leading-none">-</button>
            <span className="text-xs text-white font-bold w-5 text-center tabular-nums">{scrollSpeed}</span>
            <button onClick={() => { const v = Math.min(40, scrollSpeed + 1); applyScrollSpeed(v, true); rendererRef.current?.setScrollSpeed(v); }}
              className="w-5 h-5 rounded bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3 transition-colors cursor-pointer flex items-center justify-center text-xs leading-none">+</button>
          </div>

          {/* Divider */}
          <div className="w-px h-5 bg-osu-b3/40 hidden sm:block" />

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
          <div className="flex items-center gap-2 ml-0 sm:ml-auto w-full sm:w-auto">
            <span className="text-[10px] text-osu-f1">BG Dim</span>
            <input type="range" min={0} max={100} step={5} value={bgDim}
              onChange={(e) => { const v = Number(e.target.value); setBgDim(v); rendererRef.current?.setBackgroundDim(v); }}
              className={`w-16 sm:w-20 ${sliderClass}`} />
            <span className="text-[10px] text-osu-f1 tabular-nums w-7">{bgDim}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
