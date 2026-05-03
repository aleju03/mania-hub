import { createFileRoute, notFound, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getReplayParsed, getBeatmapFile, getScore, getUserScoresBest, getUserScoresFirsts, getUserScoresPinned, getUserScoresRecent, searchUsers, searchBeatmaps, getBeatmapScores, getRankings, getBeatmapScoreLookupStatus, getPartialBeatmapScores } from "../lib/osu";
import { parseManiaBeatmap } from "../lib/beatmap-parser";
import { filterBeatmapSearchResults } from "../lib/beatmap-search";
import { getScoreDisplayValues, getScoreRate, scoreHasReplay } from "../lib/score";
import { useAppStore, useSelectedCountry } from "../store";
import { PageHeader } from "../components/layout/PageHeader";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { ReplayBrowseView } from "../components/replay/ReplayBrowseView";
import type { ReplayBrowseMode } from "../components/replay/ReplayBrowseView";
import { ReplayControls } from "../components/replay/ReplayControls";
import { ReplayInfo } from "../components/replay/ReplayInfo";
import { ReplaySkinSettingsModal } from "../components/replay/ReplaySkinSettingsModal";
import { track } from "../lib/posthog";
import { withTimeout } from "../lib/promise-timeout";
import {
  normalizeReplaySkinSettings,
  readReplaySkinSettings,
  writeReplaySkinSettings,
} from "../lib/replay-skin";
import { normalizeReplayPlayerParam, shouldStartReplayPlayerLoad } from "../lib/replay-player-autoload";
import { getReplayBackNavigation } from "../lib/replay-navigation";
import { unpackReplayFrames } from "../lib/replay-frames";
import { parseReplayScoreInput } from "../lib/replay-score-input";
import { getReplayScoreAvailability } from "../lib/replay-score-availability";
import { DEFAULT_REPLAY_SCROLL_SPEED, normalizeReplayScrollSpeed, readReplayScrollSpeed, writeReplayScrollSpeed } from "../lib/replay-scroll-speed";
import type { ManiaBeatmap } from "../lib/beatmap-parser";
import type { ReplaySkinSettings } from "../lib/replay-skin";
import type { BeatmapScoreLookupStatus, OsuScore, OsuBeatmapset, OsuBeatmap } from "../lib/types";
import type { ReplayRendererLike, ServerReplay } from "../lib/replay-types";
import { getScoreExpectedCounts } from "../lib/replay-types";
import { pageSeo } from "../lib/seo";

const REPLAY_VOLUME_STORAGE_KEY = "mania-hub-replay-volume";
const REPLAY_INPUT_OVERLAY_STORAGE_KEY = "mania-hub-replay-input-overlay";
const REPLAY_INPUT_ONLY_STORAGE_KEY = "mania-hub-replay-input-only";
const REPLAY_INPUT_COLOR_STORAGE_KEY = "mania-hub-replay-input-color";
const REPLAY_BG_DIM_STORAGE_KEY = "mania-hub-replay-bg-dim";

interface ReplaySearch {
  scoreId?: number;
  beatmapsetId?: number;
  t?: number; // timestamp in seconds to seek to on load
  tab?: "player" | "beatmap";
  player?: string; // selected player username (for URL state)
}

export const Route = createFileRoute("/replay")({
  head: ({ match }) =>
    pageSeo({
      title: "Replay viewer",
      description: "Watch osu!mania .osr replays in your browser.",
      path: "/replay",
      origin: match.context.origin,
      social: false,
      noindex: true,
    }),
  beforeLoad: () => {
    if (typeof window !== "undefined") {
      const host = window.location.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const isDevMode = import.meta.env.VITE_DEV_MODE === "1";
      if (!isLocal && !isDevMode) throw notFound();
    } else if (process.env.VITE_DEV_MODE !== "1" && process.env.NODE_ENV === "production") {
      throw notFound();
    }
  },
  component: ReplayPage,
  validateSearch: (s: Record<string, unknown>): ReplaySearch => ({
    scoreId: Number(s.scoreId) || undefined,
    beatmapsetId: Number(s.beatmapsetId) || undefined,
    t: Number(s.t) || undefined,
    tab: s.tab === "beatmap" ? "beatmap" : undefined,
    player: (s.player as string) || undefined,
  }),
});

function mergeScoresById(...groups: OsuScore[][]): OsuScore[] {
  const byId = new Map<number, OsuScore>();
  for (const group of groups) {
    for (const score of group) byId.set(score.id, score);
  }
  return Array.from(byId.values());
}

function ReplayPage() {
  const { scoreId, beatmapsetId, t: initialTime, tab, player: playerParam } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const selectedCountry = useSelectedCountry();
  const cachedRankings = useAppStore((s) => s.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((s) => s.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((s) => s.setRankings);
  const [replay, setReplay] = useState<ServerReplay | null>(null);
  const [beatmap, setBeatmap] = useState<ManiaBeatmap | null>(null);
  const [scoreInfo, setScoreInfo] = useState<OsuScore | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playerSearchQuery, setPlayerSearchQuery] = useState("");
  const [scorePreview, setScorePreview] = useState<OsuScore | null>(null);
  const [scorePreviewLoading, setScorePreviewLoading] = useState(false);
  const [scorePreviewError, setScorePreviewError] = useState<string | null>(null);

  // Player browse state
  const [playerScoreGroups, setPlayerScoreGroups] = useState<{ best: OsuScore[]; firsts: OsuScore[]; pinned: OsuScore[]; recent: OsuScore[] } | null>(null);
  const [loadingScores, setLoadingScores] = useState(false);
  const [playerLookupUserId, setPlayerLookupUserId] = useState<number | null>(null);
  const [loadedPlayerParam, setLoadedPlayerParam] = useState<string | null>(null);
  const loadingPlayerParamRef = useRef<string | null>(null);

  // Browse mode
  const [browseMode, setBrowseMode] = useState<ReplayBrowseMode>(tab === "beatmap" ? "beatmap" : "player");

  // Beatmap browse state
  const [beatmapQuery, setBeatmapQuery] = useState("");
  const [beatmapResults, setBeatmapResults] = useState<OsuBeatmapset[]>([]);
  const [beatmapSearchLoading, setBeatmapSearchLoading] = useState(false);
  const [selectedBeatmapset, setSelectedBeatmapset] = useState<OsuBeatmapset | null>(null);
  const [selectedDiffId, setSelectedDiffId] = useState<number | null>(null);
  const [rawBeatmapScores, setRawBeatmapScores] = useState<OsuScore[]>([]);
  const [partialBeatmapScores, setPartialBeatmapScores] = useState<OsuScore[]>([]);
  const [beatmapScoreLookupStatus, setBeatmapScoreLookupStatus] = useState<BeatmapScoreLookupStatus | null>(null);
  const [beatmapScorePage, setBeatmapScorePage] = useState(1);
  const [loadingBeatmapScores, setLoadingBeatmapScores] = useState(false);
  const beatmapTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const beatmapScoreRequestRef = useRef(0);
  const scorePreviewTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const visibleRawBeatmapScores = loadingBeatmapScores && partialBeatmapScores.length > 0
    ? mergeScoresById(beatmapScorePage > 1 ? rawBeatmapScores : [], partialBeatmapScores)
    : rawBeatmapScores;

  const beatmapScores = useMemo(
    () => visibleRawBeatmapScores.filter((s) => scoreHasReplay(s)),
    [visibleRawBeatmapScores],
  );
  const normalizedPlayerParam = normalizeReplayPlayerParam(playerParam);
  const playerSearchScoreId = parseReplayScoreInput(playerSearchQuery);

  const loadReplay = useCallback(async (sid: number) => {
    setError(null);
    setLoading(true);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);

    try {
      // Fetch score first to get key count (beatmap.cs) for correct replay parsing
      const score = await getScore({ data: { scoreId: sid, mode: "mania" } }).catch(() => null);
      if (score) {
        const availability = getReplayScoreAvailability(score);
        if (!availability.available) {
          throw new Error(availability.message);
        }

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

      setReplay({
        header: parsed.header,
        frames: unpackReplayFrames(parsed.framesPacked),
        lifeBarFrames: parsed.lifeBarFrames ?? [],
        keyCount: parsed.keyCount,
      });
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
    setPlayerSearchQuery("");
    setScorePreview(null);
    setScorePreviewLoading(false);
    setScorePreviewError(null);
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
        const res = await searchBeatmaps({ data: { query: beatmapQuery, sort: "relevance_desc" } });
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
    if (parseReplayScoreInput(q)) return [];

    const res = await searchUsers({ data: { query: q } });
    return (res.user?.data ?? []).slice(0, 6).map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code,
    }));
  };

  const loadPlayerScores = useCallback(async (userId: number) => {
    setLoadingScores(true);
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
      const nextGroups = { best: bestFiltered, firsts: firstsFiltered, pinned: pinnedFiltered, recent: recentFiltered };
      setPlayerScoreGroups(nextGroups);
    } catch { setPlayerScoreGroups({ best: [], firsts: [], pinned: [], recent: [] }); }
    finally { setLoadingScores(false); }
  }, []);

  const handleSelectPlayer = async (user: { id: number; username: string }) => {
    navigate({ to: "/replay", search: { player: user.username } });
    setPlayerScoreGroups(null);
    setPlayerLookupUserId(user.id);
    setLoadedPlayerParam(null);
  };

  const handlePlayerSearchSubmit = (query: string) => {
    const parsedScoreId = parseReplayScoreInput(query);
    if (!parsedScoreId) return;
    navigate({ to: "/replay", search: { scoreId: parsedScoreId } });
  };

  const handleOpenScorePreview = () => {
    const parsedScoreId = parseReplayScoreInput(playerSearchQuery);
    if (!parsedScoreId) return;
    navigate({ to: "/replay", search: { scoreId: parsedScoreId } });
  };

  useEffect(() => {
    clearTimeout(scorePreviewTimerRef.current);

    if (!playerSearchScoreId || scoreId || browseMode !== "player") {
      setScorePreview(null);
      setScorePreviewLoading(false);
      setScorePreviewError(null);
      return;
    }

    setScorePreview(null);
    setScorePreviewError(null);
    setScorePreviewLoading(true);

    let cancelled = false;
    scorePreviewTimerRef.current = setTimeout(async () => {
      try {
        const score = await getScore({ data: { scoreId: playerSearchScoreId, mode: "mania" } });
        if (cancelled) return;
        setScorePreview(score);
        setScorePreviewError(null);
      } catch {
        if (cancelled) return;
        setScorePreview(null);
        setScorePreviewError("Couldn't find score details");
      } finally {
        if (!cancelled) setScorePreviewLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(scorePreviewTimerRef.current);
    };
  }, [browseMode, playerSearchScoreId, scoreId]);

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
        cover_url: entry.user.cover_url,
        global_rank: entry.global_rank,
      })),
    [cachedRankings],
  );

  // Auto-load player scores when arriving via URL with ?player=
  useEffect(() => {
    if (scoreId) return;
    if (!normalizedPlayerParam) {
      setPlayerScoreGroups(null);
      setPlayerLookupUserId(null);
      setLoadedPlayerParam(null);
      loadingPlayerParamRef.current = null;
      return;
    }
    if (!shouldStartReplayPlayerLoad({
      normalizedPlayerParam,
      loadedPlayerParam,
      loadingPlayerParam: loadingPlayerParamRef.current,
      hasScoreId: Boolean(scoreId),
    })) return;

    setPlayerScoreGroups(null);
    setLoadedPlayerParam(null);
    loadingPlayerParamRef.current = normalizedPlayerParam;
    let cancelled = false;
    (async () => {
      try {
        const res = await searchUsers({ data: { query: playerParam! } });
        const match = (res.user?.data ?? []).find(
          (u: { username: string }) => u.username.toLowerCase() === normalizedPlayerParam,
        );
        if (cancelled) return;

        if (match) {
          setPlayerLookupUserId(match.id);
          await loadPlayerScores(match.id);
          if (!cancelled) setLoadedPlayerParam(normalizedPlayerParam);
          return;
        }

        setPlayerLookupUserId(null);
        setPlayerScoreGroups({ best: [], firsts: [], pinned: [], recent: [] });
        setLoadedPlayerParam(normalizedPlayerParam);
      } catch { /* ignore */ }
      finally {
        if (loadingPlayerParamRef.current === normalizedPlayerParam) {
          loadingPlayerParamRef.current = null;
        }
      }
    })();
    return () => {
      cancelled = true;
      if (loadingPlayerParamRef.current === normalizedPlayerParam) {
        loadingPlayerParamRef.current = null;
      }
    };
  }, [normalizedPlayerParam, playerParam, scoreId, loadedPlayerParam, loadPlayerScores]);

  const loadBeatmapScorePage = async (bm: OsuBeatmap, nextPage: number) => {
    const requestId = beatmapScoreRequestRef.current + 1;
    beatmapScoreRequestRef.current = requestId;
    setSelectedDiffId(bm.id);
    setBeatmapScorePage(nextPage);
    setLoadingBeatmapScores(true);
    if (nextPage === 1) setRawBeatmapScores([]);
    setPartialBeatmapScores([]);
    setBeatmapScoreLookupStatus(null);
    try {
      const res = await getBeatmapScores({ data: { beatmapId: bm.id, country: selectedCountry, page: nextPage } });
      if (beatmapScoreRequestRef.current !== requestId) return;
      setRawBeatmapScores((current) => nextPage > 1 ? mergeScoresById(current, res.scores) : res.scores);
    } catch {
      if (beatmapScoreRequestRef.current !== requestId) return;
      if (nextPage === 1) setRawBeatmapScores([]);
    } finally {
      if (beatmapScoreRequestRef.current === requestId) {
        setLoadingBeatmapScores(false);
        setBeatmapScoreLookupStatus(null);
      }
    }
  };

  const handleSelectDifficulty = async (bm: OsuBeatmap) => {
    await loadBeatmapScorePage(bm, 1);
  };

  const handleLoadMoreBeatmapScores = async () => {
    const beatmap = selectedBeatmapset?.beatmaps?.find((b) => b.id === selectedDiffId);
    if (!beatmap || beatmapScorePage >= 2 || loadingBeatmapScores) return;
    const nextPage = 2;
    await loadBeatmapScorePage(beatmap, nextPage);
  };

  useEffect(() => {
    if (!loadingBeatmapScores || !selectedDiffId) return;

    let cancelled = false;
    const requestId = beatmapScoreRequestRef.current;
    const poll = async () => {
      try {
        const [status, partial] = await Promise.all([
          getBeatmapScoreLookupStatus({ data: { beatmapId: selectedDiffId, country: selectedCountry, page: beatmapScorePage } }),
          getPartialBeatmapScores({ data: { beatmapId: selectedDiffId, country: selectedCountry, page: beatmapScorePage } }),
        ]);
        if (cancelled || beatmapScoreRequestRef.current !== requestId) return;
        setBeatmapScoreLookupStatus(status);
        if (partial.length > 0) {
          setPartialBeatmapScores(partial);
        }
      } catch {
        // The full lookup is still authoritative; polling is just progressive UI.
      }
    };

    poll();
    const id = window.setInterval(poll, 750);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [beatmapScorePage, loadingBeatmapScores, selectedDiffId, selectedCountry]);

  const handleClearReplay = () => {
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);

    const backNavigation = getReplayBackNavigation({ canGoBack, playerParam, tab: tab === "beatmap" ? "beatmap" : undefined });
    if (backNavigation.type === "history") {
      router.history.back();
      return;
    }

    navigate({ to: "/replay", search: backNavigation.search });
  };

  return (
    <div className="flex-1">
      <div className={replay ? "hidden sm:block" : ""}>
        <PageHeader iconSrc="/images/icons/home.svg" title="mania replay viewer" />
      </div>

      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="max-w-[1200px] mx-auto px-3 py-3 sm:px-5 sm:py-6">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-20">
                <div className="w-10 h-10 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin mb-4" />
                <p className="text-sm text-osu-f1">Loading replay & beatmap...</p>
              </motion.div>
            ) : replay ? (
              <motion.div key="viewer" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <ReplayInfo replay={replay} score={scoreInfo} beatmap={beatmap} onClear={handleClearReplay} />
                <ReplayViewer replay={replay} beatmap={beatmap} scoreInfo={scoreInfo} fallbackBeatmapsetId={beatmapsetId} initialTime={initialTime} />
              </motion.div>
            ) : (
              <ReplayBrowseView
                mode={browseMode}
                error={error}
                selectedCountry={selectedCountry}
                onModeChange={(mode) => {
                  setBrowseMode(mode);
                  setPlayerScoreGroups(null);
                  setBeatmapResults([]);
                  setRawBeatmapScores([]);
                  setPartialBeatmapScores([]);
                  setBeatmapScoreLookupStatus(null);
                  setBeatmapScorePage(1);
                  setSelectedBeatmapset(null);
                  setSelectedDiffId(null);
                  setBeatmapQuery("");
                  setError(null);
                  navigate({ to: "/replay", search: mode === "beatmap" ? { tab: "beatmap" } : {}, replace: true });
                }}
                onPlayerSearch={handlePlayerSearch}
                onSelectPlayer={handleSelectPlayer}
                onPlayerSearchSubmit={handlePlayerSearchSubmit}
                onPlayerQueryChange={setPlayerSearchQuery}
                playerSearchScoreId={playerSearchScoreId}
                scorePreview={scorePreview}
                scorePreviewLoading={scorePreviewLoading}
                scorePreviewError={scorePreviewError}
                onOpenScorePreview={handleOpenScorePreview}
                loadingScores={loadingScores}
                playerScoreGroups={playerScoreGroups}
                playerLookupUserId={playerLookupUserId}
                playerParam={playerParam}
                suggestionPlayers={suggestionPlayers}
                onOpenPlayerScore={(score) => navigate({ to: "/replay", search: { scoreId: score.id, beatmapsetId: score.beatmapset?.id, player: playerParam } })}
                beatmapQuery={beatmapQuery}
                beatmapResults={beatmapResults}
                beatmapSearchLoading={beatmapSearchLoading}
                selectedBeatmapset={selectedBeatmapset}
                selectedDiffId={selectedDiffId}
                beatmapScores={beatmapScores}
                visibleRawBeatmapScores={visibleRawBeatmapScores}
                loadingBeatmapScores={loadingBeatmapScores}
                beatmapScorePage={beatmapScorePage}
                beatmapScoreLookupStatus={beatmapScoreLookupStatus}
                onBeatmapQueryChange={(query) => {
                  setBeatmapQuery(query);
                  setSelectedDiffId(null);
                  setRawBeatmapScores([]);
                  setPartialBeatmapScores([]);
                  setBeatmapScoreLookupStatus(null);
                  setBeatmapScorePage(1);
                }}
                onSelectBeatmapset={setSelectedBeatmapset}
                onSelectDifficulty={handleSelectDifficulty}
                onOpenBeatmapScore={(score) => navigate({ to: "/replay", search: { scoreId: score.id, beatmapsetId: selectedBeatmapset?.id, tab: "beatmap" } })}
                onLoadMoreBeatmapScores={handleLoadMoreBeatmapScores}
              />
            )}
          </AnimatePresence>
        </div>
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
  const displayScoreValues = useMemo(
    () => (scoreInfo ? getScoreDisplayValues(scoreInfo) : null),
    [scoreInfo],
  );
  const modRate = getScoreRate(scoreInfo?.mods);
  const effectiveRate = speed * modRate;
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
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
  const [inputOverlayOnly, setInputOverlayOnly] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem(REPLAY_INPUT_ONLY_STORAGE_KEY);
    return stored == null ? false : stored === "true";
  });
  const [inputOverlayColor, setInputOverlayColor] = useState(() => {
    if (typeof window === "undefined") return "#a855f7";
    return normalizeReplayInputColor(window.localStorage.getItem(REPLAY_INPUT_COLOR_STORAGE_KEY));
  });
  const [skinSettings, setSkinSettings] = useState(readReplaySkinSettings);
  const [skinSettingsOpen, setSkinSettingsOpen] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [pendingPlay, setPendingPlay] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [bgSrc, setBgSrc] = useState<string | null>(null);
  const scrubbingRef = useRef(false);
  const scrubResumeOnReleaseRef = useRef(false);
  // Refs mirror state for the renderer's external clock callback so it always
  // reads the latest values without needing to be re-registered on every
  // React re-render.
  const audioEnabledRef = useRef(true);
  const audioUrlActiveRef = useRef(false);
  const showInputOverlayRef = useRef(false);
  const inputOverlayOnlyRef = useRef(false);
  const inputOverlayColorRef = useRef("#a855f7");
  const scrollSpeedRef = useRef(DEFAULT_REPLAY_SCROLL_SPEED);
  const skinSettingsRef = useRef<ReplaySkinSettings>(skinSettings);
  const shouldResumeAudioRef = useRef(false);
  const applyScrollSpeed = useCallback((next: number, persist = false) => {
    const normalized = normalizeReplayScrollSpeed(next);
    setScrollSpeed(normalized);
    if (persist) writeReplayScrollSpeed(normalized);
  }, []);

  const applySkinSettings = useCallback((next: ReplaySkinSettings) => {
    const normalized = normalizeReplaySkinSettings(next);
    skinSettingsRef.current = normalized;
    setSkinSettings(normalized);
    rendererRef.current?.setSkinSettings(normalized);
    writeReplaySkinSettings(normalized);
  }, []);

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
    setAudioReady(false);
    setBuffering(false);
    shouldResumeAudioRef.current = false;
    audioUrlActiveRef.current = !!audioUrl;
  }, [audioUrl]);

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
  }, [audioEnabled]);

  useEffect(() => {
    showInputOverlayRef.current = showInputOverlay;
    if (rendererRef.current) {
      rendererRef.current.setShowInputOverlay(showInputOverlay);
    }
  }, [showInputOverlay]);

  useEffect(() => {
    inputOverlayOnlyRef.current = inputOverlayOnly;
    inputOverlayColorRef.current = inputOverlayColor;
    rendererRef.current?.setInputOverlayOptions({ only: inputOverlayOnly, color: inputOverlayColor });
  }, [inputOverlayOnly, inputOverlayColor]);

  useEffect(() => {
    scrollSpeedRef.current = scrollSpeed;
    if (rendererRef.current) {
      rendererRef.current.setScrollSpeed(scrollSpeed);
    }
  }, [scrollSpeed]);

  useEffect(() => {
    skinSettingsRef.current = skinSettings;
    if (rendererRef.current) {
      rendererRef.current.setSkinSettings(skinSettings);
    }
  }, [skinSettings]);

  // Create renderer
  useEffect(() => {
    if (!canvasRef.current || replay.frames.length === 0) return;

    let cancelled = false;
    let renderer: ReplayRendererLike | null = null;
    let handleResize: (() => void) | null = null;
    setRendererError(null);

    void (async () => {
      try {
        const { ManiaReplayRenderer } = await withTimeout(
          import("../components/replay/ReplayCanvas"),
          8000,
          "Timed out loading the replay renderer.",
        );
        if (cancelled || !canvasRef.current) return;

        renderer = new ManiaReplayRenderer(
          canvasRef.current,
          replay.frames,
          replay.keyCount,
          beatmap?.notes ?? [],
          {
            isConvert: scoreInfo?.beatmap?.convert ?? false,
            isLazer: displayScoreValues?.isLazer ?? false,
            od: beatmap?.od,
            showInputOverlay: showInputOverlayRef.current,
            mods: modAcronyms,
            speedMultiplier: modRate,
            transparentBackground: true,
            scrollVelocities: beatmap?.scrollVelocities,
            expectedCounts: getScoreExpectedCounts(scoreInfo, replay),
            lifeBarFrames: replay.lifeBarFrames,
            skinSettings: skinSettingsRef.current,
            inputOverlayOnly: inputOverlayOnlyRef.current,
            inputOverlayColor: inputOverlayColorRef.current,
          },
        ) as ReplayRendererLike;

        await withTimeout(
          renderer.ready(),
          8000,
          "Timed out starting the replay renderer.",
        );

        if (cancelled) {
          renderer.destroy();
          return;
        }

        renderer.setScrollSpeed(scrollSpeedRef.current);
        renderer.setShowInputOverlay(showInputOverlayRef.current);
        renderer.setInputOverlayOptions({ only: inputOverlayOnlyRef.current, color: inputOverlayColorRef.current });
        renderer.setSkinSettings(skinSettingsRef.current);
        rendererRef.current = renderer;

        // Install the audio-driven clock. When audio is enabled and actually
        // making sound, the renderer derives currentTime from audio.currentTime
        // (i.e. audio is the master). When audio is seeking/buffering we
        // freeze the renderer so it can't drift ahead of the song. When audio
        // is disabled we return null and the renderer falls back to wall clock.
        renderer.setExternalClock(() => {
          if (!audioEnabledRef.current || !audioUrlActiveRef.current) return null;
          const audio = audioRef.current;
          if (!audio) return null;
          const stalled =
            audio.paused ||
            audio.seeking ||
            audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
          return { time: audio.currentTime * 1000, stalled };
        });

        if (initialTime != null && initialTime > 0) {
          const gameTimeMs = initialTime * 1000 * modRate;
          renderer.seek(gameTimeMs);
          // ReplayProgressBar polls the renderer on an interval, so it will pick
          // up the seeked position on its next tick.
        }

        handleResize = () => renderer?.resize();
        window.addEventListener("resize", handleResize);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to start the replay renderer.";
        console.error("Replay renderer failed to start", e);
        renderer?.destroy();
        renderer = null;
        if (!cancelled) {
          rendererRef.current = null;
          setIsPlaying(false);
          setRendererError(message);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
  }, [replay, beatmap, initialTime, modRate, modAcronyms, displayScoreValues, scoreInfo?.beatmap?.convert]);

  // Detect when the renderer reaches the end on its own (no more frames) and
  // flip isPlaying back. ReplayProgressBar polls the renderer independently
  // for its slider; this effect just handles the "playback ended" transition.
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      if (!r.isPlaying) setIsPlaying(false);
    }, 250);
    return () => clearInterval(id);
  }, [isPlaying]);

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
    window.localStorage.setItem(REPLAY_INPUT_ONLY_STORAGE_KEY, String(inputOverlayOnly));
  }, [inputOverlayOnly]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REPLAY_INPUT_COLOR_STORAGE_KEY, inputOverlayColor);
  }, [inputOverlayColor]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REPLAY_BG_DIM_STORAGE_KEY, String(bgDim));
  }, [bgDim]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const resumeAudioIfNeeded = () => {
      if (!audioEnabled || !isPlaying) return;
      const renderer = rendererRef.current;
      if (audio.ended || !renderer?.isPlaying || renderer.time >= renderer.duration) {
        shouldResumeAudioRef.current = false;
        setBuffering(false);
        setIsPlaying(false);
        audio.pause();
        return;
      }
      if (!audio.paused) return;
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      shouldResumeAudioRef.current = false;
      audio.playbackRate = effectiveRate;
      audio.volume = volume;
      audio.play().catch(() => {
        shouldResumeAudioRef.current = true;
      });
    };

    const updateBuffering = () => {
      if (!isPlaying || !audioEnabled) {
        setBuffering(false);
        return;
      }
      setBuffering(
        audio.paused ||
          audio.seeking ||
          audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      );
    };

    const handleCanPlay = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleCanPlayThrough = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleSeeked = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleLoadedData = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleLoadedMetadata = () => { setAudioReady(true); updateBuffering(); };
    const handlePlaying = () => updateBuffering();
    const handleWaiting = () => updateBuffering();
    const handleStalled = () => updateBuffering();
    const handleSeeking = () => updateBuffering();
    const handleEnded = () => {
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.seek(renderer.duration);
        renderer.pause();
      }
      shouldResumeAudioRef.current = false;
      setBuffering(false);
      setIsPlaying(false);
    };
    // We deliberately don't try to auto-resume from the "pause" event — user
    // pauses (togglePlay, scrub) fire this synchronously, and resuming here
    // would immediately undo them. Browser-initiated background-tab pauses
    // are picked up by the visibilitychange handler below instead.
    const handlePause = () => updateBuffering();

    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("canplaythrough", handleCanPlayThrough);
    audio.addEventListener("seeked", handleSeeked);
    audio.addEventListener("loadeddata", handleLoadedData);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("stalled", handleStalled);
    audio.addEventListener("seeking", handleSeeking);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("pause", handlePause);

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) setAudioReady(true);
    updateBuffering();

    // When the tab becomes visible again, some browsers leave the audio
    // paused. Resume it so the renderer (which waits on the audio clock)
    // can start advancing again.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      resumeAudioIfNeeded();
      updateBuffering();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("canplaythrough", handleCanPlayThrough);
      audio.removeEventListener("seeked", handleSeeked);
      audio.removeEventListener("loadeddata", handleLoadedData);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("stalled", handleStalled);
      audio.removeEventListener("seeking", handleSeeking);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("pause", handlePause);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [audioEnabled, isPlaying, effectiveRate, volume, audioUrl]);

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
    // Audio is expected but hasn't loaded metadata yet — queue the play.
    if (audioEnabled && audioUrl && !audioReady && !audioError) {
      setPendingPlay(true);
      return;
    }
    startPlayback();
  };

  // Auto-start playback once the audio has metadata (or failed, or audio was
  // disabled) after the user already clicked play.
  useEffect(() => {
    if (!pendingPlay || isPlaying) return;
    if (audioEnabled && audioUrl && !audioReady && !audioError) return;
    setPendingPlay(false);
    startPlayback();
  }, [pendingPlay, isPlaying, audioEnabled, audioUrl, audioReady, audioError, startPlayback]);

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


  const handleAudioError = () => {
    setAudioError("Couldn't load the song audio for this replay.");
    shouldResumeAudioRef.current = false;
  };

  const handleProgressPointerDown = () => {
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
  };

  const handleProgressPointerUp = () => {
    const r = rendererRef.current;
    if (!r) {
      scrubbingRef.current = false;
      scrubResumeOnReleaseRef.current = false;
      return;
    }
    scrubbingRef.current = false;
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
  };

  const handleProgressSeek = (timeMs: number) => {
    rendererRef.current?.seek(timeMs);
    // During an active pointer scrub, don't touch audio — it's synced once on
    // release. Keyboard/accessibility scrubs still go through the audio sync.
    if (!scrubbingRef.current) {
      syncAudioTime(timeMs);
    }
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
        <canvas ref={canvasRef} className="relative z-10 h-[calc(100dvh-315px)] min-h-[390px] max-h-[560px] w-full sm:h-[min(70vh,600px)] sm:min-h-0 sm:max-h-none" />
        {rendererError && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 px-6 text-center">
            <div className="max-w-md rounded-lg border border-red-400/30 bg-red-950/70 px-4 py-3 text-sm font-semibold text-red-100">
              {rendererError}
            </div>
          </div>
        )}
      </div>

      {/* Audio element (hidden) — streamed from /api/audio with Range requests so the browser only pulls what it plays */}
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onError={handleAudioError}
        />
      )}

      <ReplayControls
        rendererRef={rendererRef}
        audioUrl={audioUrl}
        audioError={audioError}
        isPlaying={isPlaying}
        buffering={buffering}
        pendingPlay={pendingPlay}
        speed={speed}
        modRate={modRate}
        audioEnabled={audioEnabled}
        volume={volume}
        showInputOverlay={showInputOverlay}
        inputOverlayOnly={inputOverlayOnly}
        inputOverlayColor={inputOverlayColor}
        skinSettingsOpen={skinSettingsOpen}
        scrollSpeed={scrollSpeed}
        bgDim={bgDim}
        onTogglePlay={togglePlay}
        onSetSpeed={(nextSpeed) => {
          setSpeed(nextSpeed);
          rendererRef.current?.setSpeed(nextSpeed);
          if (audioRef.current) audioRef.current.playbackRate = nextSpeed * modRate;
        }}
        onToggleAudio={toggleAudio}
        onSetVolume={(nextVolume) => {
          setVolume(nextVolume);
          if (!audioEnabled && nextVolume > 0) setAudioEnabled(true);
          if (audioRef.current) audioRef.current.volume = nextVolume;
        }}
        onToggleInputOverlay={() => setShowInputOverlay((value) => !value)}
        onToggleInputOverlayOnly={() => setInputOverlayOnly((value) => !value)}
        onSetInputOverlayColor={(color) => setInputOverlayColor(normalizeReplayInputColor(color))}
        onOpenSkinSettings={() => setSkinSettingsOpen(true)}
        onSetScrollSpeed={(nextSpeed) => {
          applyScrollSpeed(nextSpeed, true);
          rendererRef.current?.setScrollSpeed(nextSpeed);
        }}
        onSetBgDim={(nextDim) => {
          setBgDim(nextDim);
          rendererRef.current?.setBackgroundDim(nextDim);
        }}
        onPointerDown={handleProgressPointerDown}
        onPointerUp={handleProgressPointerUp}
        onSeek={handleProgressSeek}
        onContextMenu={() => {}}
      />

      <AnimatePresence>
        {skinSettingsOpen && (
          <ReplaySkinSettingsModal
            settings={skinSettings}
            keyCount={replay.keyCount}
            onSave={applySkinSettings}
            onClose={() => setSkinSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function normalizeEditableHex(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  return null;
}

function normalizeReplayInputColor(value: string | null): string {
  return normalizeEditableHex(value ?? "") ?? "#a855f7";
}
