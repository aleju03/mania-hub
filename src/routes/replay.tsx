import { createFileRoute, notFound, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings, X } from "lucide-react";
import { getReplayParsed, getBeatmapFile, getScore, getUserScoresBest, getUserScoresFirsts, getUserScoresPinned, getUserScoresRecent, searchUsers, searchBeatmaps, getBeatmapScores, getRankings, getBeatmapScoreLookupStatus, getPartialBeatmapScores } from "../lib/osu";
import { parseManiaBeatmap } from "../lib/beatmap-parser";
import { filterBeatmapSearchResults } from "../lib/beatmap-search";
import { getDisplayedAccuracy, getDisplayedRank, getModDisplayList, getScoreDisplayValues, scoreHasReplay } from "../lib/score";
import { useAppStore, useSelectedCountry } from "../store";
import { PageHeader } from "../components/layout/PageHeader";
import { SearchInput } from "../components/ui/SearchInput";
import { avatarImageSrc } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { formatAccuracy, formatPP } from "../lib/format";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { getCountryName } from "../lib/country";
import { track } from "../lib/posthog";
import { withTimeout } from "../lib/promise-timeout";
import type { ReplayHitCounts } from "../lib/replay-validation";
import { DEFAULT_REPLAY_SKIN_SETTINGS, normalizeReplaySkinSettings, readReplaySkinSettings, writeReplaySkinSettings } from "../lib/replay-skin";
import { normalizeReplayPlayerParam, shouldStartReplayPlayerLoad } from "../lib/replay-player-autoload";
import { getReplayBackNavigation } from "../lib/replay-navigation";
import { parseReplayScoreInput } from "../lib/replay-score-input";
import { getReplayScoreAvailability } from "../lib/replay-score-availability";
import type { ManiaBeatmap } from "../lib/beatmap-parser";
import type { ReplaySkinSettings, ReplaySkinStyle } from "../lib/replay-skin";
import type { BeatmapScoreLookupStatus, OsuScore, OsuBeatmapset, OsuBeatmap, ReplayFrame, ReplayLifeBarFrame } from "../lib/types";
import { pageSeo } from "../lib/seo";

const REPLAY_VOLUME_STORAGE_KEY = "mania-hub-replay-volume";
const REPLAY_INPUT_OVERLAY_STORAGE_KEY = "mania-hub-replay-input-overlay";
const REPLAY_BG_DIM_STORAGE_KEY = "mania-hub-replay-bg-dim";
const REPLAY_SCROLL_SPEED_STORAGE_KEY = "mania-hub-replay-scroll-speed";
const REPLAY_SCROLL_SPEED_MIGRATION_KEY = "mania-hub-replay-scroll-speed-v2";
const DEFAULT_REPLAY_SCROLL_SPEED = 20;

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
  lifeBarFrames: ReplayLifeBarFrame[];
  keyCount: number;
}

function getScoreExpectedCounts(score: OsuScore | null, replay: ServerReplay): ReplayHitCounts {
  const stats = score?.statistics ?? {};

  return {
    countGeki: stats.count_geki ?? stats.perfect ?? replay.header.countGeki,
    count300: stats.count_300 ?? stats.great ?? replay.header.count300,
    countKatu: stats.count_katu ?? stats.good ?? replay.header.countKatu,
    count100: stats.count_100 ?? stats.ok ?? replay.header.count100,
    count50: stats.count_50 ?? stats.meh ?? replay.header.count50,
    countMiss: stats.count_miss ?? stats.miss ?? replay.header.countMiss,
  };
}

// Server returns frames as two base64-packed typed arrays (Int32 times, Uint16 keys).
// Unpack into the ReplayFrame[] shape every consumer already expects.
function unpackReplayFrames(packed: { count: number; times: string; keys: string }): ReplayFrame[] {
  const timesBytes = base64ToBytes(packed.times);
  const keysBytes = base64ToBytes(packed.keys);
  const timesBuf = new ArrayBuffer(timesBytes.byteLength);
  new Uint8Array(timesBuf).set(timesBytes);
  const keysBuf = new ArrayBuffer(keysBytes.byteLength);
  new Uint8Array(keysBuf).set(keysBytes);
  const times = new Int32Array(timesBuf, 0, packed.count);
  const keys = new Uint16Array(keysBuf, 0, packed.count);
  const out = new Array<ReplayFrame>(packed.count);
  for (let i = 0; i < packed.count; i++) {
    out[i] = { time: times[i], keyState: keys[i] };
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function readReplayScrollSpeed(): number {
  if (typeof window === "undefined") return DEFAULT_REPLAY_SCROLL_SPEED;

  const raw = window.localStorage.getItem(REPLAY_SCROLL_SPEED_STORAGE_KEY);
  const migrated = window.localStorage.getItem(REPLAY_SCROLL_SPEED_MIGRATION_KEY) === "1";
  if (raw == null) return DEFAULT_REPLAY_SCROLL_SPEED;

  const stored = Number(raw);
  if (!Number.isFinite(stored)) return DEFAULT_REPLAY_SCROLL_SPEED;
  if (!migrated && Math.round(stored) === 1) return DEFAULT_REPLAY_SCROLL_SPEED;
  return Math.max(1, Math.min(40, Math.round(stored)));
}

function writeReplayScrollSpeed(scrollSpeed: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_SCROLL_SPEED_STORAGE_KEY, String(Math.max(1, Math.min(40, Math.round(scrollSpeed)))));
  window.localStorage.setItem(REPLAY_SCROLL_SPEED_MIGRATION_KEY, "1");
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
  setExternalClock: (cb: (() => { time: number; stalled: boolean } | null) | null) => void;
  setScrollSpeed: (value: number) => void;
  setShowInputOverlay: (value: boolean) => void;
  setSkinSettings: (settings: ReplaySkinSettings) => void;
  setSpeed: (value: number) => void;
  ready: () => Promise<void>;
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

type BrowseMode = "player" | "beatmap";

function mergeScoresById(...groups: OsuScore[][]): OsuScore[] {
  const byId = new Map<number, OsuScore>();
  for (const group of groups) {
    for (const score of group) byId.set(score.id, score);
  }
  return Array.from(byId.values());
}

function ScoreModBadges({
  score,
  className,
  hideWhenEmpty = false,
}: {
  score: OsuScore;
  className: string;
  hideWhenEmpty?: boolean;
}) {
  const mods = getModDisplayList(score.mods);
  if (hideWhenEmpty && mods.length === 0) return null;

  return (
    <div className={className}>
      {mods.map((m, index) => (
        <ModBadge key={`${m.acronym}-${index}`} mod={m.acronym} rate={m.rate} size={0.75} />
      ))}
    </div>
  );
}

function ScoreInputPreview({
  scoreId,
  score,
  loading,
  error,
  onOpen,
}: {
  scoreId: number;
  score: OsuScore | null;
  loading: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-osu-b4/70 border border-osu-b3/30 px-3 py-2 text-xs text-osu-f1">
        <div className="w-3.5 h-3.5 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
        Looking up score #{scoreId}
      </div>
    );
  }

  if (error) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="mt-2 w-full rounded-lg bg-osu-b4/70 hover:bg-osu-b3 border border-osu-b3/30 px-3 py-2 text-left text-xs text-osu-f1 hover:text-white transition-colors cursor-pointer"
      >
        {error}. Press Enter or click to try replay #{scoreId}.
      </button>
    );
  }

  if (!score) return null;

  const coverUrl = score.beatmapset?.covers?.list;
  const availability = getReplayScoreAvailability(score);
  const unavailable = !availability.available;
  return (
    <button
      type="button"
      onClick={unavailable ? undefined : onOpen}
      disabled={unavailable}
      className={`mt-2 w-full flex items-center gap-3 rounded-lg bg-osu-b4 border border-osu-b3/30 px-3 py-2 text-left transition-colors ${
        unavailable ? "cursor-default opacity-80" : "hover:bg-osu-b3 cursor-pointer"
      }`}
    >
      {coverUrl && (
        <img src={coverUrl} alt="" className="w-12 h-8 rounded object-cover flex-shrink-0" loading="lazy" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-white truncate">
          {score.beatmapset?.title ?? `Score #${scoreId}`}
        </div>
        <div className="text-[10px] text-osu-f1 truncate">
          {unavailable
            ? availability.message
            : `${score.user?.username ?? "Unknown player"}${score.beatmap?.version ? ` // [${score.beatmap.version}]` : ""}`}
        </div>
      </div>
      <ScoreModBadges score={score} className="hidden sm:flex flex-shrink-0 gap-0.5" hideWhenEmpty />
      <span className={`text-[10px] font-semibold uppercase tracking-wider flex-shrink-0 ${
        unavailable ? "text-osu-f1" : "text-osu-pink-light"
      }`}>
        {unavailable ? "Unavailable" : "Watch"}
      </span>
    </button>
  );
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
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [loadedPlayerParam, setLoadedPlayerParam] = useState<string | null>(null);
  const loadingPlayerParamRef = useRef<string | null>(null);

  // Browse mode
  const [browseMode, setBrowseMode] = useState<BrowseMode>(tab === "beatmap" ? "beatmap" : "player");

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
      setLoadedPlayerParam(null);
      loadingPlayerParamRef.current = null;
      setExpandedSections({});
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
          await loadPlayerScores(match.id);
          if (!cancelled) setLoadedPlayerParam(normalizedPlayerParam);
          return;
        }

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

    const backNavigation = getReplayBackNavigation({ canGoBack, playerParam, tab });
    if (backNavigation.type === "history") {
      router.history.back();
      return;
    }

    navigate({ to: "/replay", search: backNavigation.search });
  };

  const beatmapScoreProgressLabel = beatmapScoreLookupStatus
    ? `${beatmapScoreLookupStatus.current}/${beatmapScoreLookupStatus.total} players checked · ${beatmapScores.length} replays found`
    : `Checking players · ${beatmapScores.length} replays found`;

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
                <ReplayInfo replay={replay} score={scoreInfo} beatmap={beatmap} onClear={handleClearReplay} />
                <ReplayViewer replay={replay} beatmap={beatmap} scoreInfo={scoreInfo} fallbackBeatmapsetId={beatmapsetId} initialTime={initialTime} />
              </motion.div>
            ) : (
              <motion.div key="browse" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {/* Tab toggle */}
                <div className="flex justify-center mb-3">
                  <div className="flex bg-osu-b4 rounded-lg border border-osu-b3/50 overflow-hidden">
                    {(["player", "beatmap"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          setBrowseMode(m);
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
                        Search a player, or paste a score ID
                      </h3>
                      <SearchInput
                        placeholder="Search player... or score ID"
                        onSearch={handlePlayerSearch}
                        onSelect={handleSelectPlayer}
                        onSubmit={handlePlayerSearchSubmit}
                        onQueryChange={setPlayerSearchQuery}
                      />
                      {playerSearchScoreId && (
                        <ScoreInputPreview
                          scoreId={playerSearchScoreId}
                          score={scorePreview}
                          loading={scorePreviewLoading}
                          error={scorePreviewError}
                          onOpen={handleOpenScorePreview}
                        />
                      )}
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
                                    <ScoreModBadges score={s} className="mt-1 flex gap-0.5 sm:hidden" hideWhenEmpty />
                                  </div>
                                  <ScoreModBadges score={s} className="hidden sm:flex w-28 flex-shrink-0 justify-end gap-0.5" />
                                  <span className="text-xs text-osu-l2 flex-shrink-0">{formatAccuracy(getDisplayedAccuracy(s))}</span>
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
                                className="relative overflow-hidden flex items-center gap-3 py-2.5 px-3 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20 text-left"
                              >
                                {p.cover_url && (
                                  <div
                                    className="absolute inset-0 bg-cover bg-center opacity-35"
                                    style={{ backgroundImage: `url(${p.cover_url})` }}
                                    aria-hidden="true"
                                  />
                                )}
                                <div className="absolute inset-0 bg-osu-b4/80" aria-hidden="true" />
                                <img src={avatarImageSrc(p.avatar_url, p.id)} alt="" className="relative w-9 h-9 rounded-full flex-shrink-0 object-cover" loading="lazy" />
                                <div className="relative flex-1 min-w-0">
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
                            setPartialBeatmapScores([]);
                            setBeatmapScoreLookupStatus(null);
                            setBeatmapScorePage(1);
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
                      <div className="flex flex-col items-center justify-center gap-3 py-8">
                        <div className="w-6 h-6 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                        <div className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
                          {beatmapScoreProgressLabel}
                        </div>
                      </div>
                    )}

                    {/* Beatmap score results */}
                    {selectedDiffId && beatmapScores.length > 0 && (
                      <div className="space-y-1.5">
                        <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-2">
                          {loadingBeatmapScores ? "Replays available so far" : "Replays available"} ({beatmapScores.length})
                        </h4>
                        {beatmapScores.map((s: OsuScore, i: number) => (
                          <motion.div key={s.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}
                            className="flex items-center gap-3 py-2.5 px-4 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20"
                            onClick={() => navigate({ to: "/replay", search: { scoreId: s.id, beatmapsetId: selectedBeatmapset?.id, tab: "beatmap" } })}>
                            <GradeImg grade={getDisplayedRank(s)} size={26} />
                            <img src={avatarImageSrc(s.user?.avatar_url, s.user?.id)} alt="" className="w-7 h-7 rounded-full flex-shrink-0" loading="lazy" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-white truncate">{s.user?.username}</div>
                              <ScoreModBadges score={s} className="mt-1 flex gap-0.5 sm:hidden" hideWhenEmpty />
                            </div>
                            <ScoreModBadges score={s} className="hidden sm:flex w-28 flex-shrink-0 justify-end gap-0.5" />
                            <span className="text-xs text-osu-l2 flex-shrink-0">{formatAccuracy(getDisplayedAccuracy(s))}</span>
                            <span className="text-sm font-bold">{formatPP(s.pp)}</span>
                            <span className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold">Watch</span>
                          </motion.div>
                        ))}
                      </div>
                    )}

                    {!loadingBeatmapScores && selectedDiffId && beatmapScorePage < 2 && (
                      <div className="flex justify-center py-4">
                        <button
                          onClick={handleLoadMoreBeatmapScores}
                          className="px-3 py-1.5 rounded-lg bg-osu-b4 hover:bg-osu-b3 border border-osu-b3/40 text-xs font-semibold text-osu-f1 hover:text-white transition-colors cursor-pointer"
                        >
                          Load more
                        </button>
                      </div>
                    )}

                    {/* Empty states */}
                    {!loadingBeatmapScores && selectedDiffId && beatmapScores.length === 0 && visibleRawBeatmapScores.length > 0 && (
                      <div className="text-center py-6 text-osu-f1 text-sm">
                        No replays available from {selectedCountry.toUpperCase()} players on this difficulty
                      </div>
                    )}
                    {!loadingBeatmapScores && selectedDiffId && visibleRawBeatmapScores.length === 0 && (
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
  const accuracy = score
    ? getDisplayedAccuracy(score) * 100
    : totalHits + h.countMiss > 0
      ? ((h.countGeki * 6 + h.count300 * 6 + h.countKatu * 4 + h.count100 * 2 + h.count50) / ((totalHits + h.countMiss) * 6) * 100)
      : 0;
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

// Formats a positive millisecond count as m:ss. Shared between the progress
// bar and the share tooltip so both agree on the display.
function formatReplayMs(ms: number): string {
  const safe = Math.max(0, ms);
  const mins = Math.floor(safe / 60000);
  const secs = String(Math.floor((safe % 60000) / 1000)).padStart(2, "0");
  return `${mins}:${secs}`;
}

// Isolated progress bar. Owns its own `progress` state and polls the renderer
// on an interval — extracted so that the 10–20Hz slider update doesn't
// re-render the whole ReplayViewer (which has ~25 useState slots) every tick.
// Parent passes callbacks for seek/scrub/share so nothing leaks back up.
interface ReplayProgressBarProps {
  rendererRef: React.MutableRefObject<ReplayRendererLike | null>;
  sliderClass: string;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onSeek: (timeMs: number) => void;
  onContextMenu: (timeMsGame: number, clientX: number, clientY: number) => void;
  children?: React.ReactNode;
}

function ReplayProgressBar({
  rendererRef,
  sliderClass,
  onPointerDown,
  onPointerUp,
  onSeek,
  onContextMenu,
  children,
}: ReplayProgressBarProps) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const pollOnce = () => {
      const r = rendererRef.current;
      if (!r || r.duration <= 0) return;
      // setProgress with same value is a React bail-out; no re-render while paused.
      setProgress(r.time / r.duration);
    };
    pollOnce();
    const id = setInterval(pollOnce, 100);
    return () => clearInterval(id);
  }, [rendererRef]);

  const displayDuration = rendererRef.current?.displayDuration ?? 0;
  const leftLabel = formatReplayMs(progress * displayDuration);
  const rightLabel = formatReplayMs(displayDuration);

  return (
    <div
      className="relative flex items-center gap-3 px-4 pt-3 pb-1"
      onContextMenu={(e) => {
        e.preventDefault();
        const r = rendererRef.current;
        if (!r) return;
        onContextMenu(r.time, e.clientX, e.clientY);
      }}
    >
      <span className="text-[10px] text-osu-f1 tabular-nums w-10">{leftLabel}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={progress}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onChange={(e) => {
          const v = Number(e.target.value);
          setProgress(v);
          const r = rendererRef.current;
          if (r) onSeek(v * r.duration);
        }}
        className={`flex-1 h-1.5 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink ${sliderClass}`}
      />
      <span className="text-[10px] text-osu-f1 tabular-nums w-10 text-right">{rightLabel}</span>
      {children}
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
  const modRate = modAcronyms.includes("DT") || modAcronyms.includes("NC") ? 1.5 : modAcronyms.includes("HT") ? 0.75 : 1;
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
  const scrollSpeedRef = useRef(DEFAULT_REPLAY_SCROLL_SPEED);
  const skinSettingsRef = useRef<ReplaySkinSettings>(skinSettings);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharePos, setSharePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [shareLabel, setShareLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const shouldResumeAudioRef = useRef(false);
  const applyScrollSpeed = useCallback((next: number, persist = false) => {
    const normalized = Math.max(1, Math.min(40, Math.round(next)));
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
            transparentBackground: true,
            scrollVelocities: beatmap?.scrollVelocities,
            expectedCounts: getScoreExpectedCounts(scoreInfo, replay),
            lifeBarFrames: replay.lifeBarFrames,
            skinSettings: skinSettingsRef.current,
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

  const sliderClass = "h-1 appearance-none bg-osu-b3 rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-osu-pink";

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

  const handleProgressContextMenu = (timeMsGame: number, clientX: number, clientY: number) => {
    const wallMs = timeMsGame / modRate;
    const t = Math.round((wallMs / 1000) * 10) / 10;
    const url = new URL(window.location.href);
    url.searchParams.set("t", String(t));
    setShareUrl(url.toString());
    setSharePos({ x: clientX, y: clientY });
    setShareLabel(formatReplayMs(wallMs));
    setCopied(false);
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

      {/* Controls */}
      <div className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
        {audioError && (
          <div className="text-[11px] text-osu-yellow bg-osu-yellow/10 border-b border-osu-yellow/20 px-4 py-2">
            {audioError}
          </div>
        )}

        {/* Progress bar (isolated so slider updates don't re-render the rest) */}
        <ReplayProgressBar
          rendererRef={rendererRef}
          sliderClass=""
          onPointerDown={handleProgressPointerDown}
          onPointerUp={handleProgressPointerUp}
          onSeek={handleProgressSeek}
          onContextMenu={handleProgressContextMenu}
        >
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
                  <div className="text-[11px] text-osu-f1 mb-1.5">Copy URL at {shareLabel}</div>
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
        </ReplayProgressBar>

        {/* Controls row */}
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 flex-wrap">
          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            title={pendingPlay ? "Waiting for audio to load..." : isPlaying && buffering ? "Buffering..." : undefined}
            className="w-9 h-9 rounded-full bg-osu-pink hover:bg-osu-pink-light transition-colors flex items-center justify-center cursor-pointer shrink-0"
          >
            {pendingPlay || (isPlaying && buffering) ? (
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

          {/* Skin settings */}
          <button
            onClick={() => setSkinSettingsOpen(true)}
            aria-label="Replay skin settings"
            title="Replay skin settings"
            className={`w-7 h-7 rounded flex items-center justify-center cursor-pointer transition-colors ${
              skinSettingsOpen
                ? "bg-osu-pink text-white"
                : "bg-osu-b3/50 text-osu-f1 hover:text-white hover:bg-osu-b3"
            }`}
          >
            <Settings className="h-4 w-4" strokeWidth={2.2} />
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

      <AnimatePresence>
        {skinSettingsOpen && (
          <ReplaySkinSettingsModal
            settings={skinSettings}
            onChange={applySkinSettings}
            onClose={() => setSkinSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ReplaySkinSettingsModal({
  settings,
  onChange,
  onClose,
}: {
  settings: ReplaySkinSettings;
  onChange: (settings: ReplaySkinSettings) => void;
  onClose: () => void;
}) {
  const update = (patch: Partial<ReplaySkinSettings>) => {
    onChange({ ...settings, ...patch, version: 1 });
  };
  const updateStyle = (style: ReplaySkinStyle) => update({ style });
  const updateColor = (key: "tapColor" | "lnHeadColor" | "lnBodyColor", value: string) => {
    onChange({ ...settings, [key]: value, version: 1 });
  };

  return (
    <>
      <motion.div
        className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onClick={onClose}
      />
      <motion.div
        className="fixed inset-x-4 top-1/2 z-[111] mx-auto max-w-2xl rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        initial={{ opacity: 0, y: "-48%", scale: 0.98 }}
        animate={{ opacity: 1, y: "-50%", scale: 1 }}
        exit={{ opacity: 0, y: "-48%", scale: 0.98 }}
        transition={{ duration: 0.14 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-osu-b3/50 px-4 py-3">
          <div>
            <h3 className="text-sm font-bold text-white">Replay skin</h3>
            <div className="text-[10px] uppercase tracking-wider text-osu-f1">{settings.style === "circles" ? "Circle playfield" : "Bar playfield"}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close replay skin settings"
            className="ml-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-osu-b3/50 text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">Style</div>
              <div className="grid grid-cols-2 gap-2">
                {(["bars", "circles"] as const).map((style) => (
                  <button
                    key={style}
                    onClick={() => updateStyle(style)}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      settings.style === style
                        ? "border-osu-pink/70 bg-osu-pink/15 text-white"
                        : "border-osu-b3/50 bg-osu-b5/50 text-osu-f1 hover:border-osu-b2 hover:text-white"
                    }`}
                  >
                    <div className="mb-2 flex h-10 items-end justify-center gap-2">
                      {style === "bars" ? (
                        <>
                          <span className="h-2 w-7 rounded bg-[#5a8fff]" />
                          <span className="h-8 w-7 rounded bg-[#8b8b93]" />
                          <span className="h-2 w-7 rounded bg-white" />
                        </>
                      ) : (
                        <>
                          <span className="h-8 w-8 rounded-full bg-[#9cf2ae] ring-2 ring-white/55" />
                          <span className="relative h-9 w-5 rounded-t-full rounded-b bg-[#8b8b93]">
                            <span className="absolute -bottom-1 left-1/2 h-8 w-8 -translate-x-1/2 rounded-full bg-[#dfffe6] ring-2 ring-white/55" />
                          </span>
                          <span className="h-8 w-8 rounded-full border-[3px] border-white/50" />
                        </>
                      )}
                    </div>
                    <div className="text-xs font-bold capitalize">{style}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">Colors</div>
              <div className="grid gap-2 sm:grid-cols-3">
                <ReplaySkinColorControl label="Tap notes" value={settings.tapColor} onChange={(value) => updateColor("tapColor", value)} />
                <ReplaySkinColorControl label="LN head" value={settings.lnHeadColor} onChange={(value) => updateColor("lnHeadColor", value)} />
                <ReplaySkinColorControl label="LN body" value={settings.lnBodyColor} onChange={(value) => updateColor("lnBodyColor", value)} />
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-osu-b3/40 bg-osu-b5/45 px-3 py-2.5">
              <input
                type="checkbox"
                checked={settings.percy}
                onChange={(e) => update({ percy: e.target.checked })}
                className="h-4 w-4 accent-osu-pink"
              />
              <span className="text-sm font-bold text-white">Percy</span>
            </label>
          </div>

          <div className="relative min-h-56 overflow-hidden rounded-lg border border-osu-b3/40 bg-[#0b0a12]">
            <div className="absolute inset-0 bg-gradient-to-b from-[#050509] to-[#12101d]" />
            {settings.style === "circles" ? (
              <>
                <div className="absolute bottom-6 left-8 h-10 w-10 rounded-full border-[3px] border-white/50" />
                <div className="absolute bottom-6 left-[88px] h-10 w-10 rounded-full border-[3px] border-white" />
                <div className="absolute bottom-6 left-[148px] h-10 w-10 rounded-full border-[3px] border-white/50" />
                <div className="absolute left-9 top-12 h-8 w-8 rounded-full ring-2 ring-white/55" style={{ backgroundColor: settings.tapColor }} />
                <div className="absolute left-[94px] top-6 h-32 w-7 rounded-t-full rounded-b-md" style={{ backgroundColor: settings.lnBodyColor }} />
                <div className="absolute left-[88px] top-[126px] h-10 w-10 rounded-full ring-2 ring-white/55" style={{ backgroundColor: settings.lnHeadColor }} />
                <div className="absolute left-[152px] top-20 h-8 w-8 rounded-full ring-2 ring-white/55" style={{ backgroundColor: settings.tapColor }} />
              </>
            ) : (
              <>
                <div className="absolute inset-x-8 bottom-16 h-0.5 bg-white/70" />
                <div className="absolute bottom-[66px] left-9 h-2.5 w-10 rounded bg-[#5a8fff]" />
                <div className="absolute bottom-[66px] left-[94px] h-24 w-9 rounded bg-[#8b8b93]" />
                <div className="absolute bottom-[66px] left-[150px] h-2.5 w-10 rounded bg-white" />
                <div className="absolute bottom-12 left-9 h-2 w-10 rounded bg-white/20" />
                <div className="absolute bottom-12 left-[94px] h-2 w-9 rounded bg-white/20" />
                <div className="absolute bottom-12 left-[150px] h-2 w-10 rounded bg-white/20" />
              </>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-osu-b3/50 px-4 py-3">
          <button
            onClick={() => onChange(DEFAULT_REPLAY_SKIN_SETTINGS)}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-3 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-osu-pink px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-osu-pink-light"
          >
            Close
          </button>
        </div>
      </motion.div>
    </>
  );
}

function ReplaySkinColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block rounded-lg border border-osu-b3/40 bg-osu-b5/45 p-2.5">
      <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-osu-f1">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-9 shrink-0 cursor-pointer rounded border border-osu-b3/60 bg-transparent p-0.5"
        />
        <input
          type="text"
          value={value}
          readOnly
          className="min-w-0 flex-1 rounded-md border border-osu-b3/50 bg-osu-b4 px-2 py-1.5 font-mono text-[11px] text-osu-c1 outline-none transition-colors focus:border-osu-pink/60"
        />
      </span>
    </label>
  );
}
