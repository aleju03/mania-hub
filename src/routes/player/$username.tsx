import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getUser,
  getUserProfileInsights,
  getUserScoresBestWindow,
  getUserScoresRecent,
} from "../../lib/osu";
import {
  formatNumber,
  formatAccuracy,
  formatTimeAgo,
  formatDate,
  formatPP,
} from "../../lib/format";
import {
  getBeatmapUrl,
  getModAcronyms,
  getModDisplayList,
  getScoreDisplayValues,
  getScoreIdentity,
  getScoreTimeMs,
  getScoreTimestamp,
  getScoreUrl,
  scoreHasReplay,
} from "../../lib/score";
import { GradeImg } from "../../components/ui/GradeImg";
import { ModBadge } from "../../components/ui/ModBadge";
import { LazerBadge } from "../../components/ui/LazerBadge";
import { ScoreRowSkeleton, Skeleton } from "../../components/ui/LoadingSkeleton";
import { UsernameText } from "../../components/ui/UsernameText";
import type { OsuScore, OsuUser, UserProfileInsights, InsightScoreSnapshot } from "../../lib/types";
import { pageSeo } from "../../lib/seo";
import { getRankTierClass } from "../../lib/rankings";

const userRequestCache = new Map<string, Promise<OsuUser>>();
const userRecentRequestCache = new Map<number, Promise<OsuScore[]>>();
const userBestWindowRequestCache = new Map<number, Promise<OsuScore[]>>();
const userProfileInsightsRequestCache = new Map<number, Promise<UserProfileInsights>>();
const userDataCache = new Map<string, { data: OsuUser; expiresAt: number }>();
const userRecentDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
const userBestWindowDataCache = new Map<number, { data: OsuScore[]; expiresAt: number }>();
const userProfileInsightsDataCache = new Map<number, { data: UserProfileInsights; expiresAt: number }>();
const USER_CLIENT_CACHE_TTL = 2 * 60 * 1000;
const USER_RECENT_CLIENT_CACHE_TTL = 60 * 1000;
const USER_BEST_WINDOW_CLIENT_CACHE_TTL = 60 * 1000;
const USER_PROFILE_INSIGHTS_CLIENT_CACHE_TTL = 10 * 60 * 1000;
const INITIAL_SCORE_BATCH_SIZE = 5;
const SHOW_MORE_BATCH_SIZE = 50;
const BEST_SCORES_WINDOW_SIZE = 200;
type PlayerTab = "best" | "recent" | "about";

export const Route = createFileRoute("/player/$username")({
  head: ({ params, match }) =>
    pageSeo({
      title: `${params.username}`,
      description: `${params.username}'s osu!mania profile: best plays, recent scores, insights, and grade breakdown.`,
      path: `/player/${encodeURIComponent(params.username)}`,
      origin: match.context.origin,
      type: "profile",
      noindex: true,
    }),
  component: PlayerPage,
});

type KeyFilter = "all" | string;
type ModFilterMode = "include" | "exclude";
type ModFilterState = Record<string, ModFilterMode>;
type BestSort = "pp" | "newest" | "oldest";

// Synthetic chip used to filter for scores submitted without any mods.
const NO_MOD_KEY = "NM";

// DT and NC apply the same 1.5x rate (NC is DT with an audio swap); HT and DC
// are the same 0.75x rate. Scores carry one or the other, so collapse them into
// a single filter chip that matches either mod in the group.
const MOD_ALIAS_GROUPS: readonly { readonly key: string; readonly mods: readonly string[] }[] = [
  { key: "DT|NC", mods: ["DT", "NC"] },
  { key: "HT|DC", mods: ["HT", "DC"] },
];

function getModFilterKey(mod: string): string {
  for (const group of MOD_ALIAS_GROUPS) {
    if (group.mods.includes(mod)) return group.key;
  }
  return mod;
}

function getModFilterGroup(key: string): readonly string[] | null {
  const group = MOD_ALIAS_GROUPS.find((g) => g.key === key);
  return group?.mods ?? null;
}

function matchesKeyFilter(score: OsuScore, keyFilter: KeyFilter): boolean {
  if (keyFilter === "all") return true;
  return score.beatmap?.cs === Number(keyFilter.replace("k", ""));
}

function getAvailableKeyModes(scores: OsuScore[]): string[] {
  const keys = new Set<number>();
  for (const score of scores) {
    if (score.beatmap?.cs != null) keys.add(score.beatmap.cs);
  }
  return Array.from(keys).sort((a, b) => a - b).map((k) => `${k}k`);
}

function matchesModFilter(score: OsuScore, modFilter: ModFilterState): boolean {
  const entries = Object.entries(modFilter);
  if (entries.length === 0) return true;

  const scoreMods = new Set(getModAcronyms(score.mods));
  const hasNoMods = scoreMods.size === 0;

  for (const [key, mode] of entries) {
    let present: boolean;
    if (key === NO_MOD_KEY) {
      present = hasNoMods;
    } else {
      const group = getModFilterGroup(key);
      present = group ? group.some((m) => scoreMods.has(m)) : scoreMods.has(key);
    }
    if (mode === "include" && !present) return false;
    if (mode === "exclude" && present) return false;
  }
  return true;
}

function sortBestScores(scores: OsuScore[], sort: BestSort): OsuScore[] {
  if (sort === "pp") return scores;
  const copy = [...scores];
  copy.sort((a, b) => {
    const diff = getScoreTimeMs(b) - getScoreTimeMs(a);
    return sort === "newest" ? diff : -diff;
  });
  return copy;
}

function cycleModFilterMode(current: ModFilterMode | undefined): ModFilterMode | undefined {
  if (current === undefined) return "include";
  if (current === "include") return "exclude";
  return undefined;
}

function getRelevantMods(scores: OsuScore[]): string[] {
  const counts = new Map<string, number>();
  let noModCount = 0;
  for (const score of scores) {
    const mods = getModAcronyms(score.mods);
    if (mods.length === 0) {
      noModCount += 1;
      continue;
    }
    // Collapse DT/NC and HT/DC into a single key per score so the count reflects
    // the number of scores matched by the chip, not double-counted aliases.
    const seenKeys = new Set<string>();
    for (const mod of mods) {
      const key = getModFilterKey(mod);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);

  if (noModCount > 0) sorted.unshift(NO_MOD_KEY);
  return sorted;
}

function dedupeScores(scores: OsuScore[]): OsuScore[] {
  const seen = new Set<string>();
  const unique: OsuScore[] = [];

  for (const score of scores) {
    const identity = getScoreIdentity(score);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(score);
  }

  return unique;
}

function loadUserCached(username: string): Promise<OsuUser> {
  const now = Date.now();
  const cachedData = userDataCache.get(username);
  if (cachedData && cachedData.expiresAt > now) {
    return Promise.resolve(cachedData.data);
  }
  if (cachedData) {
    userDataCache.delete(username);
  }

  const cached = userRequestCache.get(username);
  if (cached) return cached;

  const request = getUser({ data: { key: username } })
    .then((user) => {
      userDataCache.set(username, {
        data: user,
        expiresAt: Date.now() + USER_CLIENT_CACHE_TTL,
      });
      return user;
    })
    .finally(() => {
      userRequestCache.delete(username);
    });

  userRequestCache.set(username, request);
  return request;
}

function loadUserRecentCached(userId: number): Promise<OsuScore[]> {
  const now = Date.now();
  const cachedData = userRecentDataCache.get(userId);
  if (cachedData && cachedData.expiresAt > now) {
    return Promise.resolve(cachedData.data);
  }
  if (cachedData) {
    userRecentDataCache.delete(userId);
  }

  const cached = userRecentRequestCache.get(userId);
  if (cached) return cached;

  const request = getUserScoresRecent({
    data: { userId, limit: INITIAL_SCORE_BATCH_SIZE, offset: 0, include_fails: true },
  })
    .then((scores) => {
      userRecentDataCache.set(userId, {
        data: scores,
        expiresAt: Date.now() + USER_RECENT_CLIENT_CACHE_TTL,
      });
      return scores;
    })
    .finally(() => {
      userRecentRequestCache.delete(userId);
    });

  userRecentRequestCache.set(userId, request);
  return request;
}

function loadUserBestWindowCached(userId: number): Promise<OsuScore[]> {
  const now = Date.now();
  const cachedData = userBestWindowDataCache.get(userId);
  if (cachedData && cachedData.expiresAt > now) {
    return Promise.resolve(cachedData.data);
  }
  if (cachedData) {
    userBestWindowDataCache.delete(userId);
  }

  const cached = userBestWindowRequestCache.get(userId);
  if (cached) return cached;

  const request = getUserScoresBestWindow({ data: { userId, totalLimit: BEST_SCORES_WINDOW_SIZE } })
    .then((scores) => {
      userBestWindowDataCache.set(userId, {
        data: scores,
        expiresAt: Date.now() + USER_BEST_WINDOW_CLIENT_CACHE_TTL,
      });
      return scores;
    })
    .finally(() => {
      userBestWindowRequestCache.delete(userId);
    });

  userBestWindowRequestCache.set(userId, request);
  return request;
}

function loadUserProfileInsightsCached(userId: number): Promise<UserProfileInsights> {
  const now = Date.now();
  const cachedData = userProfileInsightsDataCache.get(userId);
  if (cachedData && cachedData.expiresAt > now) {
    return Promise.resolve(cachedData.data);
  }
  if (cachedData) {
    userProfileInsightsDataCache.delete(userId);
  }

  const cached = userProfileInsightsRequestCache.get(userId);
  if (cached) return cached;

  const request = getUserProfileInsights({ data: { userId } })
    .then((insights) => {
      userProfileInsightsDataCache.set(userId, {
        data: insights,
        expiresAt: Date.now() + USER_PROFILE_INSIGHTS_CLIENT_CACHE_TTL,
      });
      return insights;
    })
    .finally(() => {
      userProfileInsightsRequestCache.delete(userId);
    });

  userProfileInsightsRequestCache.set(userId, request);
  return request;
}

function PlayerPage() {
  const { username } = Route.useParams();
  const [user, setUser] = useState<OsuUser | null>(null);
  const [best, setBest] = useState<OsuScore[]>([]);
  const [recent, setRecent] = useState<OsuScore[]>([]);
  const [profileInsights, setProfileInsights] = useState<UserProfileInsights | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingInsights, setLoadingInsights] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);
  const [bestError, setBestError] = useState<string | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [tab, setTab] = useState<PlayerTab>("best");
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [bestModFilter, setBestModFilter] = useState<ModFilterState>({});
  const [bestSort, setBestSort] = useState<BestSort>("pp");
  const [bestWindowLoaded, setBestWindowLoaded] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [modModalOpen, setModModalOpen] = useState(false);
  const [hoveredMod, setHoveredMod] = useState<string | null>(null);
  const [bpmModalOpen, setBpmModalOpen] = useState(false);
  const [recentHasMore, setRecentHasMore] = useState(true);
  const [loadingMoreRecent, setLoadingMoreRecent] = useState(false);
  const [bestVisibleCount, setBestVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);
  const [recentVisibleCount, setRecentVisibleCount] = useState(INITIAL_SCORE_BATCH_SIZE);

  useEffect(() => {
    if (!avatarOpen && !modModalOpen && !bpmModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAvatarOpen(false);
        setModModalOpen(false);
        setBpmModalOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [avatarOpen, modModalOpen, bpmModalOpen]);

  useEffect(() => {
    let cancelled = false;

    setUser(null);
    setBest([]);
    setRecent([]);
    setProfileInsights(null);
    setTab("best");
    setKeyFilter("all");
    setBestModFilter({});
    setBestSort("pp");
    setBestWindowLoaded(false);
    setUserError(null);
    setBestError(null);
    setRecentError(null);
    setInsightsError(null);
    setLoadingUser(true);
    setLoadingRecent(true);
    setLoadingInsights(true);
    setRecentHasMore(true);
    setLoadingMoreRecent(false);
    setBestVisibleCount(INITIAL_SCORE_BATCH_SIZE);
    setRecentVisibleCount(INITIAL_SCORE_BATCH_SIZE);

    loadUserCached(username)
      .then((result) => {
        if (cancelled) return;
        setUser(result);
        setUserError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setUserError("Couldn't load this player right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingUser(false);
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    setLoadingRecent(true);

    loadUserRecentCached(user.id)
      .then((recentScores) => {
        if (cancelled) return;
        setRecent(dedupeScores(recentScores));
        setRecentHasMore(recentScores.length === INITIAL_SCORE_BATCH_SIZE);
        setRecentError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setRecentError("Couldn't load recent scores right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingRecent(false);
      });

    // Single source of truth for the Best tab: the 200-score window also
    // backs the initial 5-row paint. Skeleton stays up until this resolves.
    loadUserBestWindowCached(user.id)
      .then((windowScores) => {
        if (cancelled) return;
        setBest(windowScores);
        setBestWindowLoaded(true);
        setBestError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setBestError("Couldn't load top plays right now.");
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    setLoadingInsights(true);

    loadUserProfileInsightsCached(user.id)
      .then((insights) => {
        if (cancelled) return;
        setProfileInsights(insights);
        setInsightsError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setInsightsError("Couldn't load profile insights right now.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingInsights(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Safety: if we're on the About tab but the user has no page content, fall back to Best
  useEffect(() => {
    if (tab === "about" && !user?.page?.html) setTab("best");
  }, [tab, user]);

  const fetchMoreRecent = useCallback(async () => {
    if (!user || loadingMoreRecent) return;

    setLoadingMoreRecent(true);

    try {
      const nextScores = await getUserScoresRecent({
        data: {
          userId: user.id,
          limit: SHOW_MORE_BATCH_SIZE,
          offset: recent.length,
          include_fails: true,
        },
      });

      setRecent((prev) => dedupeScores([...prev, ...nextScores]));
      setRecentHasMore(nextScores.length === SHOW_MORE_BATCH_SIZE);
    } catch {
      setRecentError("Couldn't load more scores right now.");
    } finally {
      setLoadingMoreRecent(false);
    }
  }, [loadingMoreRecent, recent, user]);

  useEffect(() => {
    setBestVisibleCount(INITIAL_SCORE_BATCH_SIZE);
    setRecentVisibleCount(INITIAL_SCORE_BATCH_SIZE);
  }, [keyFilter]);

  useEffect(() => {
    setBestVisibleCount(INITIAL_SCORE_BATCH_SIZE);
  }, [bestModFilter, bestSort]);

  const handleShowMore = useCallback(() => {
    if (tab === "best") {
      setBestVisibleCount((count) => count + SHOW_MORE_BATCH_SIZE);
      return;
    }

    setRecentVisibleCount((count) => count + SHOW_MORE_BATCH_SIZE);
  }, [tab]);

  useEffect(() => {
    if (tab !== "recent") return;
    const filteredScores = recent.filter((score) => matchesKeyFilter(score, keyFilter));

    if (loadingRecent || recentError || loadingMoreRecent) return;
    if (filteredScores.length >= recentVisibleCount) return;
    if (!recentHasMore) return;

    void fetchMoreRecent();
  }, [
    fetchMoreRecent,
    keyFilter,
    loadingMoreRecent,
    loadingRecent,
    recent,
    recentError,
    recentHasMore,
    recentVisibleCount,
    tab,
  ]);

  const relevantBestMods = useMemo(() => getRelevantMods(best), [best]);

  const availableKeyModes = useMemo(
    () => getAvailableKeyModes([...best, ...recent]),
    [best, recent],
  );

  const cycleBestMod = useCallback((mod: string) => {
    setBestModFilter((prev) => {
      const next = { ...prev };
      const cycled = cycleModFilterMode(prev[mod]);
      if (cycled === undefined) {
        delete next[mod];
      } else {
        next[mod] = cycled;
      }
      return next;
    });
  }, []);

  if (loadingUser && !user) {
    return <PlayerPageSkeleton />;
  }

  if (userError || !user) {
    return (
      <div className="flex-1 bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 py-16 text-center text-sm text-osu-f1">
          {userError ?? "Player not found."}
        </div>
      </div>
    );
  }

  const stats = user.statistics;
  const currentScores = tab === "best" ? best : recent;
  const currentVisibleCount = tab === "best" ? bestVisibleCount : recentVisibleCount;
  const keyFilteredScores = currentScores.filter((score) => matchesKeyFilter(score, keyFilter));
  const filteredScores = tab === "best"
    ? sortBestScores(
      keyFilteredScores.filter((score) => matchesModFilter(score, bestModFilter)),
      bestSort,
    )
    : keyFilteredScores;
  const visibleScores = filteredScores.slice(0, currentVisibleCount);
  // Best is now backed entirely by the 200-score window, so its loading state
  // is just whether that window has resolved.
  const loadingBest = !bestWindowLoaded && !bestError;
  const loadingScores = tab === "best" ? loadingBest : loadingRecent;
  const scoresError = tab === "best" ? bestError : recentError;
  const currentHasMore = tab === "best" ? !bestWindowLoaded : recentHasMore;
  const isLoadingMoreCurrentTab = tab === "recent" && loadingMoreRecent;
  const canShowMore = tab === "best"
    ? bestWindowLoaded && filteredScores.length > visibleScores.length
    : filteredScores.length > visibleScores.length || recentHasMore;
  const isSettlingInitialFilteredView =
    !loadingScores &&
    currentVisibleCount === INITIAL_SCORE_BATCH_SIZE &&
    filteredScores.length < INITIAL_SCORE_BATCH_SIZE &&
    currentHasMore;
  const scoreListState = loadingScores
    ? "loading"
    : isSettlingInitialFilteredView
      ? "settling"
      : scoresError
        ? "error"
        : visibleScores.length > 0
          ? "loaded"
          : "empty";

  return (
    <div className="flex-1">
      {/* Avatar modal */}
      <AnimatePresence>
        {avatarOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center backdrop-blur-sm bg-black/75 cursor-pointer"
            onClick={() => setAvatarOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.img
              src={user.avatar_url}
              alt={`${user.username}'s avatar`}
              className="w-[300px] h-[300px] rounded-2xl shadow-[0_12px_60px_rgba(0,0,0,0.7)] object-cover"
              onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.85, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 500 }}
            />
            <motion.div
              className="mt-4 flex flex-col items-center gap-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15, delay: 0.05 }}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-white font-bold text-lg">{user.username}</span>
              <a
                href={`https://osu.ppy.sh/users/${user.id}/mania`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-osu-f1 hover:text-osu-l2 transition-colors"
              >
                View osu! profile
              </a>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mod breakdown modal */}
      <AnimatePresence>
        {modModalOpen && profileInsights?.modBreakdown && profileInsights.modBreakdown.length > 0 && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-black/75 cursor-pointer"
            onClick={() => { setModModalOpen(false); setHoveredMod(null); }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="relative bg-osu-b4 border border-osu-b3/20 rounded-2xl p-5 w-[380px] max-h-[85vh] overflow-y-auto shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
              onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 500 }}
            >
              <button
                type="button"
                onClick={() => { setModModalOpen(false); setHoveredMod(null); }}
                aria-label="Close"
                className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
              {(() => {
                const noModCount = profileInsights.sampleSize - (profileInsights.mostUsedMod?.total ?? 0);
                const entries = [
                  ...profileInsights.modBreakdown,
                  ...(noModCount > 0 ? [{ label: "NM", count: noModCount, total: profileInsights.sampleSize }] : []),
                ].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

                const palette = ["#ffcc22", "#66ccff", "#ff6f91", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#22d3ee"];
                let paletteIdx = 0;
                const colored = entries.map((e) => ({
                  ...e,
                  color: e.label === "NM" ? "#9ca3af" : palette[paletteIdx++ % palette.length],
                  pct: (e.count / profileInsights.sampleSize) * 100,
                }));

                const cx = 110, cy = 110, ro = 96, ri = 62;
                const polar = (r: number, deg: number) => {
                  const rad = ((deg - 90) * Math.PI) / 180;
                  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
                };
                const slicePath = (start: number, end: number, ringOuter: number, ringInner: number) => {
                  const so = polar(ringOuter, end);
                  const eo = polar(ringOuter, start);
                  const si = polar(ringInner, start);
                  const ei = polar(ringInner, end);
                  const large = end - start <= 180 ? 0 : 1;
                  return `M ${so.x} ${so.y} A ${ringOuter} ${ringOuter} 0 ${large} 0 ${eo.x} ${eo.y} L ${si.x} ${si.y} A ${ringInner} ${ringInner} 0 ${large} 1 ${ei.x} ${ei.y} Z`;
                };
                const fullDonut = `M ${cx - ro} ${cy} A ${ro} ${ro} 0 1 0 ${cx + ro} ${cy} A ${ro} ${ro} 0 1 0 ${cx - ro} ${cy} Z M ${cx - ri} ${cy} A ${ri} ${ri} 0 1 1 ${cx + ri} ${cy} A ${ri} ${ri} 0 1 1 ${cx - ri} ${cy} Z`;

                // Normalize slice angles by total mod-usages (not sampleSize): plays
                // can stack mods so counts can sum to >100%. Without this the last
                // slice wraps past 360° and overlaps the first one.
                const totalCount = colored.reduce((sum, e) => sum + e.count, 0) || 1;
                let acc = 0;
                const slices = colored.map((entry) => {
                  const start = (acc / totalCount) * 360;
                  acc += entry.count;
                  const end = (acc / totalCount) * 360;
                  return { ...entry, start, end };
                });
                const singleSlice = slices.length === 1;
                const focused = hoveredMod ? slices.find((s) => s.label === hoveredMod) : null;
                const HOVER_OFFSET = 8;
                const stacks = totalCount - profileInsights.sampleSize;

                return (
                  <>
                    <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">Mod Usage</div>
                    <div className="mt-0.5 text-[11px] text-osu-f1/60 flex items-center gap-1.5 flex-wrap">
                      <span>across {profileInsights.sampleSize} top plays</span>
                      {stacks > 0 && (
                        <span
                          className="px-1.5 py-[1px] rounded bg-osu-b3/40 text-[9px] font-semibold uppercase tracking-wider text-osu-f1 cursor-help"
                          title={`${stacks} extra mod-use${stacks === 1 ? "" : "s"} from plays that stack mods (e.g. DT+MR). Slice sizes show share of mod-uses; percentages show share of plays.`}
                        >
                          +{stacks} stacked
                        </span>
                      )}
                    </div>
                    <div className="mt-3 flex justify-center">
                      <svg viewBox="0 0 220 220" className="w-52 h-52" onMouseLeave={() => setHoveredMod(null)}>
                        {singleSlice ? (
                          <path d={fullDonut} fill={slices[0].color} fillRule="evenodd" />
                        ) : (
                          slices.map((s) => {
                            const isFocused = hoveredMod === s.label;
                            const dimmed = hoveredMod != null && !isFocused;
                            const midRad = (((s.start + s.end) / 2 - 90) * Math.PI) / 180;
                            const dx = isFocused ? Math.cos(midRad) * HOVER_OFFSET : 0;
                            const dy = isFocused ? Math.sin(midRad) * HOVER_OFFSET : 0;
                            return (
                              <path
                                key={s.label}
                                d={slicePath(s.start, s.end, ro, ri)}
                                fill={s.color}
                                stroke="var(--color-osu-b4)"
                                strokeWidth={2}
                                strokeLinejoin="round"
                                transform={`translate(${dx} ${dy})`}
                                style={{
                                  opacity: dimmed ? 0.25 : 1,
                                  transition: "opacity 150ms, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
                                  cursor: "pointer",
                                }}
                                onMouseEnter={() => setHoveredMod(s.label)}
                              />
                            );
                          })
                        )}
                        {focused ? (
                          <>
                            <text x={cx} y={cy - 14} textAnchor="middle" fill={focused.color} style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>
                              {focused.label}
                            </text>
                            <text x={cx} y={cy + 8} textAnchor="middle" fill="#fff" style={{ fontSize: 26, fontWeight: 800 }}>
                              {Math.round(focused.pct)}%
                            </text>
                            <text x={cx} y={cy + 24} textAnchor="middle" fill="var(--color-osu-f1)" style={{ fontSize: 10 }}>
                              {focused.count} of {profileInsights.sampleSize}
                            </text>
                          </>
                        ) : (
                          <>
                            <text x={cx} y={cy + 2} textAnchor="middle" fill="#fff" style={{ fontSize: 28, fontWeight: 800 }}>
                              {profileInsights.sampleSize}
                            </text>
                            <text x={cx} y={cy + 20} textAnchor="middle" fill="var(--color-osu-f1)" style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>
                              top plays
                            </text>
                          </>
                        )}
                      </svg>
                    </div>
                    <div className="mt-4 flex flex-col gap-1">
                      {slices.map((entry) => {
                        const isFocused = hoveredMod === entry.label;
                        const dimmed = hoveredMod != null && !isFocused;
                        return (
                          <button
                            key={entry.label}
                            type="button"
                            onMouseEnter={() => setHoveredMod(entry.label)}
                            onMouseLeave={() => setHoveredMod(null)}
                            className="group flex items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-osu-b3/30"
                            style={{ opacity: dimmed ? 0.4 : 1, transition: "opacity 150ms, background-color 150ms" }}
                          >
                            <span
                              className="h-7 w-1 rounded-full flex-shrink-0"
                              style={{ backgroundColor: entry.color, boxShadow: isFocused ? `0 0 8px ${entry.color}` : undefined }}
                            />
                            <ModBadge mod={entry.label} size={0.85} />
                            <div className="flex-1 h-1 rounded-full bg-osu-b3/40 overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${entry.pct}%`, backgroundColor: entry.color }} />
                            </div>
                            <div className="flex items-baseline gap-1.5 tabular-nums w-16 justify-end">
                              <span className="text-sm font-bold text-white">{Math.round(entry.pct)}%</span>
                              <span className="text-[10px] text-osu-f1/70">{entry.count}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* BPM breakdown modal */}
      <AnimatePresence>
        {bpmModalOpen && profileInsights && profileInsights.medianBpm != null && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-black/75 cursor-pointer p-4"
            onClick={() => setBpmModalOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="relative bg-osu-b4 border border-osu-b3/20 rounded-2xl p-5 w-[420px] max-w-full max-h-[85vh] overflow-y-auto shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
              onClick={(e) => e.stopPropagation()}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 500 }}
            >
              <button
                type="button"
                onClick={() => setBpmModalOpen(false)}
                aria-label="Close"
                className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
              <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">BPM Breakdown</div>
              <div className="mt-0.5 text-[11px] text-osu-f1/60">
                across {profileInsights.sampleSize} top plays · adjusted for rate mods
              </div>

              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-white">{Math.round(profileInsights.medianBpm)}</span>
                <span className="text-[11px] text-osu-f1">median BPM</span>
              </div>

              {profileInsights.bpmByKeyMode && profileInsights.bpmByKeyMode.length > 1 && (
                <div className="mt-4">
                  <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">Median by Keymode</div>
                  <div className="space-y-2">
                    {(() => {
                      const maxMedian = Math.max(...profileInsights.bpmByKeyMode.map((b) => b.median));
                      return profileInsights.bpmByKeyMode.map((bucket) => {
                        const pct = maxMedian > 0 ? (bucket.median / maxMedian) * 100 : 0;
                        return (
                          <div key={bucket.keyCount} className="flex items-center gap-2.5">
                            <span className="text-xs font-semibold text-white w-8 tabular-nums">{bucket.keyCount}K</span>
                            <div className="flex-1 h-1.5 rounded-full bg-osu-b3/40 overflow-hidden">
                              <div className="h-full rounded-full bg-osu-yellow" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-[11px] text-osu-f1 tabular-nums w-20 text-right">
                              {Math.round(bucket.median)} ({bucket.count})
                            </span>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}

              {profileInsights.bpmRange?.minScore && profileInsights.bpmRange?.maxScore && (
                <div className="mt-4">
                  <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">Range</div>
                  <div className="space-y-2">
                    <BpmExtremeRow label="Slowest" bpm={profileInsights.bpmRange.min} snapshot={profileInsights.bpmRange.minScore} />
                    <BpmExtremeRow label="Fastest" bpm={profileInsights.bpmRange.max} snapshot={profileInsights.bpmRange.maxScore} />
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cover + Avatar */}
      <div className="relative h-[220px] sm:h-[280px] overflow-hidden bg-osu-b4">
        <img
          src={user.cover?.url || user.cover_url}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ filter: "brightness(0.4) blur(1px)" }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-osu-b5" />
        <div className="absolute bottom-0 left-0 right-0">
          <div className="max-w-[1200px] mx-auto px-4 sm:px-5 pb-5 flex items-end gap-3 sm:gap-5">
            <button
              type="button"
              onClick={() => setAvatarOpen(true)}
              className="w-[80px] h-[80px] sm:w-[110px] sm:h-[110px] rounded-2xl overflow-hidden border-2 border-osu-b3/60 shadow-[0_4px_20px_rgba(0,0,0,0.5)] translate-y-4 flex-shrink-0 cursor-pointer hover:border-osu-l2/60 transition-colors duration-150"
            >
              <img
                src={user.avatar_url}
                alt={`${user.username}'s avatar`}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>
            <div className="pb-1 flex-1 min-w-0">
              <h1 className="text-3xl font-bold text-white truncate">
                <UsernameText username={user.username} avatarUrl={user.avatar_url} className="text-2xl sm:text-[34px] font-black text-white" />
              </h1>
              <div className="flex items-center gap-3 mt-1">
                <a
                  href={`https://osu.ppy.sh/users/${user.id}/mania`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2 py-0.5 rounded-full bg-osu-pink/20 text-[11px] font-semibold text-osu-pink-light hover:bg-osu-pink/35 transition-colors duration-150"
                >
                  osu! profile
                  <svg className="inline w-2.5 h-2.5 ml-0.5 -mt-px" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 1.5h7v7" /><path d="M10.5 1.5 1.5 10.5" /></svg>
                </a>
                {user.is_supporter && (
                  <span className="inline-flex items-center justify-center h-5 px-1.5 rounded-full bg-osu-pink" title="osu! Supporter">
                    <img src="/images/icons/supporter.svg" alt="Supporter" className="w-3 h-3 brightness-0 invert" />
                  </span>
                )}
                {user.is_online && (
                  <span className="w-2 h-2 rounded-full bg-osu-green" title="Online" />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-5 pt-8 pb-4">
          {/* Rank hero card: peak rank headliner with current + country + 90d sparkline baked in */}
          <RankHeroCard
            peakRank={user.rank_highest?.rank ?? null}
            peakRankDate={user.rank_highest?.updated_at ?? null}
            currentRank={stats.global_rank}
            countryRank={stats.country_rank}
            countryCode={user.country_code}
            rankHistory={user.rank_history?.data ?? null}
          />

          {/* Secondary stats strip: compact inline row for the remaining mirror stats */}
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <CompactStat label="PP" value={formatNumber(Math.round(stats.pp))} accent />
            <CompactStat label="Accuracy" value={formatAccuracy(stats.hit_accuracy / 100)} />
            <CompactStat label="Play Count" value={formatNumber(stats.play_count)} />
            <CompactStat label="Play Time" value={`${formatNumber(Math.floor((stats.play_time ?? 0) / 3600))}h`} />
          </div>

          {/* Profile insights */}
          <div className="mt-4">
            {loadingInsights ? (
              <InsightsSkeleton />
            ) : insightsError ? (
              <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-3 text-sm text-osu-f1">
                {insightsError}
              </div>
            ) : profileInsights && profileInsights.sampleSize > 0 ? (
              <div className="space-y-3">
                {/* Row 1: Key Split + Most Used Mod + BPM + PP Range */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <KeySplitCard keySplit={profileInsights.keySplit} sampleSize={profileInsights.sampleSize} />
                  <div
                    className={`bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 group ${profileInsights.mostUsedMod ? "cursor-pointer hover:border-osu-b3/50 transition-colors" : ""}`}
                    onClick={profileInsights.mostUsedMod ? () => setModModalOpen(true) : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Most Used Mod</div>
                      {profileInsights.mostUsedMod && <ExpandHint />}
                    </div>
                    {profileInsights.mostUsedMod ? (
                      <>
                        <div className="mt-1.5 flex items-center gap-2">
                          <ModBadge mod={profileInsights.mostUsedMod.label} />
                          <span className="text-lg font-bold text-white">{profileInsights.mostUsedMod.label}</span>
                        </div>
                        <div className="mt-1.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1 rounded-full bg-osu-b3/40 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-osu-yellow"
                                style={{ width: `${Math.round((profileInsights.mostUsedMod.count / profileInsights.mostUsedMod.total) * 100)}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-osu-f1 tabular-nums">
                              {Math.round((profileInsights.mostUsedMod.count / profileInsights.mostUsedMod.total) * 100)}%
                            </span>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="mt-1.5 text-sm text-osu-f1">No mod preference</div>
                    )}
                  </div>
                  <div
                    className={`bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 group ${profileInsights.medianBpm != null ? "cursor-pointer hover:border-osu-b3/50 transition-colors" : ""}`}
                    onClick={profileInsights.medianBpm != null ? () => setBpmModalOpen(true) : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Median BPM</div>
                      {profileInsights.medianBpm != null && <ExpandHint />}
                    </div>
                    {profileInsights.medianBpm != null ? (
                      <>
                        <div className="mt-1 flex items-baseline gap-2">
                          <span className="text-xl font-bold text-white">{Math.round(profileInsights.medianBpm)}</span>
                          <span className="text-xs text-osu-f1">BPM</span>
                        </div>
                        {profileInsights.bpmRange && (
                          <div className="mt-1 text-[11px] text-osu-f1 tabular-nums">
                            {Math.round(profileInsights.bpmRange.min)} - {Math.round(profileInsights.bpmRange.max)} range
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="mt-1.5 text-sm text-osu-f1">-</div>
                    )}
                  </div>
                  <div className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20">
                    <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">PP Range</div>
                    {profileInsights.ppRange ? (
                      <>
                        <div className="mt-1 flex items-baseline gap-1.5">
                          <span className="text-xl font-bold text-osu-pink-light">{Math.round(profileInsights.ppRange.top)}</span>
                          <span className="text-xs text-osu-f1">to</span>
                          <span className="text-xl font-bold text-white">{Math.round(profileInsights.ppRange.bottom)}</span>
                          <span className="text-xs text-osu-f1">pp</span>
                        </div>
                        <div className="mt-1 text-[11px] text-osu-f1">{Math.round(profileInsights.ppRange.top - profileInsights.ppRange.bottom)}pp spread</div>
                      </>
                    ) : (
                      <div className="mt-1.5 text-sm text-osu-f1">-</div>
                    )}
                  </div>
                </div>

                {/* Row 2: Newest + Oldest top play with map backgrounds */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TopPlayCard label="Newest Top Play" snapshot={profileInsights.newestTopPlay} />
                  <TopPlayCard label="Oldest Top Play" snapshot={profileInsights.oldestTopPlay} />
                </div>
              </div>
            ) : null}
          </div>

          {/* Grades */}
          <div className="mt-5 pt-4 border-t border-osu-b3/30 flex flex-wrap items-center gap-4">
            {([
              ["SSH", stats.grade_counts.ssh],
              ["SS", stats.grade_counts.ss],
              ["SH", stats.grade_counts.sh],
              ["S", stats.grade_counts.s],
              ["A", stats.grade_counts.a],
            ] as [string, number][]).map(([grade, count]) => (
              <div key={grade} className="flex items-center gap-1.5">
                <GradeImg grade={grade} size={28} />
                <span className="text-xs text-osu-f1 font-medium">{formatNumber(count)}</span>
              </div>
            ))}
            <div className="w-full sm:w-auto sm:ml-auto text-[11px] text-osu-f1 space-x-4">
              <span>
                Joined <strong className="text-osu-l2">{formatDate(user.join_date)}</strong>
              </span>
              {user.playstyle && (
                <span>
                  Plays with{" "}
                  <strong className="text-osu-l2">{user.playstyle.join(", ")}</strong>
                </span>
              )}
            </div>
          </div>

          {/* Player tabs */}
          <div className="mt-5 pt-1 border-t border-osu-b3/30 flex flex-wrap items-center justify-between gap-3">
            <div className="flex">
              {((["best", "recent", ...(user.page?.html ? ["about"] : [])]) as PlayerTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] capitalize ${
                    tab === t
                      ? "text-osu-c1 border-b-2 border-osu-h1"
                      : "text-osu-f1 hover:text-osu-l2"
                  }`}
                >
                  {t === "best" ? "Best Performance" : t === "recent" ? "Recent Plays" : "About"}
                </button>
              ))}
            </div>
            {tab !== "about" && availableKeyModes.length > 1 && (
              <div className="flex items-center gap-1 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-1">
                {[["all", "All"] as const, ...availableKeyModes.map((k) => [k, k.toUpperCase()] as const)].map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setKeyFilter(value)}
                    className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                      keyFilter === value
                        ? "bg-osu-pink/15 text-osu-pink-light"
                        : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {tab === "best" && bestWindowLoaded && best.length > 0 && (
            <BestScoresControlBar
              mods={relevantBestMods}
              modFilter={bestModFilter}
              onCycleMod={cycleBestMod}
              onClearMods={() => setBestModFilter({})}
              sort={bestSort}
              onChangeSort={setBestSort}
            />
          )}
        </div>
      </div>

      {/* Tab body: About card or scores list */}
      <div className="bg-osu-b5 border-t border-osu-b3/20">
        <div className="max-w-[1200px] mx-auto px-5 py-5 space-y-1.5">
          <AnimatePresence mode="wait" initial={false}>
            {tab === "about" && user.page?.html ? (
              <motion.div
                key="about"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
              >
                <PlayerAboutCard html={user.page.html} />
              </motion.div>
            ) : (
              <motion.div
                key={scoreListState}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
                className="space-y-1.5"
              >
                {scoreListState === "loading" ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <ScoreRowSkeleton key={i} />
                  ))
                ) : scoreListState === "settling" ? (
                  Array.from({ length: INITIAL_SCORE_BATCH_SIZE }).map((_, i) => (
                    <PlayerScoreRowSkeleton key={`settling-${i}`} />
                  ))
                ) : scoreListState === "error" ? (
                  <div className="text-center py-8 text-osu-f1 text-sm">{scoresError}</div>
                ) : scoreListState === "loaded" ? (
                  visibleScores.map((s: OsuScore, i: number) => (
                    <ScoreRow key={getScoreIdentity(s)} score={s} position={i + 1} />
                  ))
                ) : (
                  <div className="text-center py-8 text-osu-f1 text-sm">No scores found</div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {tab !== "about" && !loadingScores && !scoresError && canShowMore && (
            <div className="pt-3 flex justify-center">
              <button
                type="button"
                onClick={handleShowMore}
                disabled={isLoadingMoreCurrentTab}
                className="px-4 py-2 rounded-lg bg-osu-b4 text-[12px] font-semibold text-osu-l2 border border-osu-b3/30 hover:bg-osu-b3 transition-colors cursor-pointer disabled:cursor-default disabled:opacity-60"
              >
                {isLoadingMoreCurrentTab ? "Loading..." : "Show more"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayerPageSkeleton() {
  return (
    <div className="flex-1 bg-osu-b5">
      <div className="relative h-[220px] sm:h-[280px] overflow-hidden bg-osu-b4">
        <div className="absolute inset-0 bg-gradient-to-b from-osu-d5 to-osu-b5" />
        <div className="absolute bottom-0 left-0 right-0">
          <div className="max-w-[1200px] mx-auto px-4 sm:px-5 pb-5 flex items-end gap-3 sm:gap-5">
            <Skeleton className="w-[80px] h-[80px] sm:w-[110px] sm:h-[110px] rounded-2xl translate-y-4 flex-shrink-0" />
            <div className="pb-1 flex-1 min-w-0 space-y-2">
              <Skeleton className="h-6 sm:h-8 w-36 sm:w-48" />
              <Skeleton className="h-4 w-24 sm:w-28" />
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-5 pt-8 pb-5 space-y-3">
        {/* Rank hero skeleton */}
        <div className="bg-osu-b4 rounded-xl p-5 border border-osu-b3/20">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
            <div className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-10 w-32" />
              <Skeleton className="h-3 w-40" />
            </div>
            <div className="flex items-start gap-8">
              <div className="space-y-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-6 w-20" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-6 w-12" />
              </div>
            </div>
          </div>
        </div>

        {/* Compact stats strip skeleton */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-osu-b4 rounded-xl px-4 py-2.5 border border-osu-b3/20 flex items-center justify-between gap-3">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 h-[90px]">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-40 mt-2" />
                <Skeleton className="h-3 w-32 mt-1" />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <ScoreRowSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PlayerAboutCard({ html }: { html: string }) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Wire up osu's spoilerbox toggles + shorten raw URL link text. osu's own
  // JS isn't here, so we do the toggle behavior ourselves via event delegation
  // on the container (more robust than per-element handlers).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    // 1. Shorten raw-URL link text where the visible text equals the href
    root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
      const href = link.getAttribute("href") ?? "";
      const text = (link.textContent ?? "").trim();
      if (!text || text !== href || !/^https?:\/\//i.test(href)) return;
      try {
        const url = new URL(href);
        const host = url.hostname.replace(/^www\./, "");
        const path = url.pathname === "/" ? "" : url.pathname;
        const truncatedPath = path.length > 24 ? path.slice(0, 24) + "..." : path;
        link.textContent = host + truncatedPath;
        if (!link.getAttribute("title")) link.setAttribute("title", href);
      } catch {
        // Leave the link as-is if URL parsing fails
      }
    });

    // 2. Mark spoilerbox toggles as keyboard-accessible buttons
    root.querySelectorAll<HTMLElement>(".js-spoilerbox__link").forEach((el) => {
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
    });

    // 3. Delegated click/keyboard handler for spoilerbox toggles
    const toggleBox = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      const toggle = target.closest(".js-spoilerbox__link");
      if (!toggle) return false;
      const box = toggle.closest(".js-spoilerbox");
      if (box) box.classList.toggle("is-open");
      return true;
    };

    const onClick = (e: MouseEvent) => {
      if (toggleBox(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (toggleBox(e.target)) {
        e.preventDefault();
      }
    };

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [html]);

  return (
    <div className="bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
      <div
        ref={contentRef}
        className="bbcode-content px-4 py-3 text-sm text-osu-l2 max-h-[520px] overflow-y-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function BestScoresControlBar({
  mods,
  modFilter,
  onCycleMod,
  onClearMods,
  sort,
  onChangeSort,
}: {
  mods: string[];
  modFilter: ModFilterState;
  onCycleMod: (mod: string) => void;
  onClearMods: () => void;
  sort: BestSort;
  onChangeSort: (sort: BestSort) => void;
}) {
  const hasActiveFilter = Object.keys(modFilter).length > 0;

  return (
    <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold shrink-0">Mods</span>
        {mods.length === 0 ? (
          <span className="text-[11px] text-osu-f1">No mods in top plays</span>
        ) : (
          <>
            <div className="flex items-center gap-1 flex-wrap">
              {mods.map((mod) => (
                <ModFilterChip
                  key={mod}
                  mod={mod}
                  mode={modFilter[mod]}
                  onClick={() => onCycleMod(mod)}
                />
              ))}
            </div>
            {hasActiveFilter && (
              <button
                type="button"
                onClick={onClearMods}
                className="text-[10px] font-semibold text-osu-f1 hover:text-osu-l2 underline underline-offset-2 cursor-pointer"
              >
                Clear
              </button>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Sort</span>
        <div className="flex items-center gap-1 rounded-lg bg-osu-b4/60 border border-osu-b3/20 p-1">
          {([
            ["pp", "Top PP"],
            ["newest", "Newest"],
            ["oldest", "Oldest"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => onChangeSort(value)}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                sort === value
                  ? "bg-osu-pink/15 text-osu-pink-light"
                  : "text-osu-f1 hover:text-osu-l2 hover:bg-osu-b3/50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ModFilterChip({
  mod,
  mode,
  onClick,
}: {
  mod: string;
  mode: ModFilterMode | undefined;
  onClick: () => void;
}) {
  const groupMods = getModFilterGroup(mod);
  const label = mod === NO_MOD_KEY
    ? "NoMod"
    : groupMods
      ? groupMods.join(" or ")
      : mod;
  const title = mode === "include"
    ? `Showing only ${label}`
    : mode === "exclude"
      ? `Hiding ${label}`
      : `Click to require ${label}`;

  const ringClass = mode === "include"
    ? "border-osu-green-light bg-osu-green/15"
    : mode === "exclude"
      ? "border-osu-red-light bg-osu-red/15"
      : "border-osu-b3/30 bg-osu-b4/50 hover:bg-osu-b3/40";

  const contentDimClass = mode === "exclude" ? "opacity-40 saturate-50" : "";

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`relative flex items-center gap-1 rounded-md border px-1.5 py-1 transition-colors cursor-pointer ${ringClass}`}
    >
      <div className={`flex items-center transition-opacity ${contentDimClass}`}>
        {mod === NO_MOD_KEY ? (
          <span className="text-[10px] font-bold text-osu-l2 px-1">NoMod</span>
        ) : groupMods ? (
          <div className="flex items-center gap-0.5">
            {groupMods.map((m) => (
              <ModBadge key={m} mod={m} size={0.7} />
            ))}
          </div>
        ) : (
          <ModBadge mod={mod} size={0.8} />
        )}
      </div>
      {mode === "exclude" && (
        <span
          className="pointer-events-none absolute left-1 right-1 top-1/2 h-[2px] -translate-y-1/2 rotate-[-10deg] rounded-full bg-osu-red-light shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function CompactStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-osu-b4 rounded-xl px-4 py-2.5 border border-osu-b3/20 flex items-baseline justify-between gap-3">
      <span className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</span>
      <span className={`text-base font-bold tabular-nums ${accent ? "text-osu-yellow" : "text-white"}`}>{value}</span>
    </div>
  );
}

function RankHeroCard({
  peakRank,
  peakRankDate,
  currentRank,
  countryRank,
  countryCode,
  rankHistory,
}: {
  peakRank: number | null;
  peakRankDate: string | null;
  currentRank: number | null;
  countryRank: number | null;
  countryCode: string;
  rankHistory: number[] | null;
}) {
  const valid = (rankHistory ?? []).filter((d) => d > 0);
  const has90d = valid.length >= 2;
  const w = 800;
  const h = 60;
  let points = "";
  if (has90d) {
    const max = Math.max(...valid);
    const min = Math.min(...valid);
    const range = max - min || 1;
    points = valid
      .map((v, i) => {
        const x = (i / (valid.length - 1)) * w;
        const y = ((v - min) / range) * (h - 4) + 2;
        return `${x},${y}`;
      })
      .join(" ");
  }

  // Positive delta = rank improved (number went down)
  const delta90d = has90d ? valid[0] - valid[valid.length - 1] : null;
  const heroRank = peakRank ?? currentRank;

  return (
    <div className="relative bg-osu-b4 rounded-xl border border-osu-b3/20 overflow-hidden">
      {/* 90-day sparkline as background texture */}
      {has90d && (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="absolute inset-x-0 bottom-0 w-full h-[70%] pointer-events-none"
          aria-hidden
        >
          <defs>
            <linearGradient id="rankHeroGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "hsl(var(--theme-hue),calc(100% * var(--theme-sat)),70%)", stopOpacity: 0.28 }} />
              <stop offset="100%" style={{ stopColor: "hsl(var(--theme-hue),calc(100% * var(--theme-sat)),70%)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <polygon points={`0,${h} ${points} ${w},${h}`} fill="url(#rankHeroGrad)" />
          <polyline
            points={points}
            fill="none"
            style={{ stroke: "hsl(var(--theme-hue),calc(100% * var(--theme-sat)),70%)" }}
            strokeWidth="2"
            strokeOpacity="0.85"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {/* Foreground content */}
      <div className="relative px-5 py-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
        {/* Peak rank - hero */}
        <div className="min-w-0">
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
            {peakRank ? "Peak Rank" : "Global Rank"}
          </div>
          <div className={`mt-0.5 text-4xl sm:text-5xl font-extrabold leading-none tabular-nums ${heroRank ? getRankTierClass(heroRank) || "text-osu-yellow" : "text-osu-yellow"}`}>
            {heroRank ? `#${formatNumber(heroRank)}` : "-"}
          </div>
          {peakRank && peakRankDate && (
            <div className="mt-2 text-[10px] text-osu-f1">
              achieved <span className="text-osu-l2">{formatDate(peakRankDate)}</span> · {formatTimeAgo(peakRankDate)}
            </div>
          )}
        </div>

        {/* Secondary: current global + country + 90d delta */}
        <div className="flex items-start gap-6 sm:gap-8">
          {peakRank && (
            <div className="min-w-0">
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Current</div>
              <div className="mt-0.5 text-xl font-bold text-white tabular-nums">
                {currentRank ? `#${formatNumber(currentRank)}` : "-"}
              </div>
              {delta90d != null && delta90d !== 0 && (
                <div className={`mt-1 text-[10px] inline-flex items-center gap-1 ${delta90d > 0 ? "text-osu-green-light" : "text-osu-red-light"}`}>
                  <svg width="7" height="6" viewBox="0 0 7 6" className="flex-shrink-0" aria-hidden>
                    <path
                      d={delta90d > 0 ? "M3.5 0 L7 6 L0 6 Z" : "M3.5 6 L0 0 L7 0 Z"}
                      fill="currentColor"
                    />
                  </svg>
                  <span className="tabular-nums">{formatNumber(Math.abs(delta90d))}</span>
                  <span className="text-osu-f1">90d</span>
                </div>
              )}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Country</div>
            <div className="mt-0.5 text-xl font-bold text-osu-pink-light tabular-nums">
              {countryRank ? `#${formatNumber(countryRank)}` : "-"}
            </div>
            {countryCode && (
              <div className="mt-1 text-[10px] text-osu-f1 uppercase tracking-wider">{countryCode}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KeySplitCard({ keySplit, sampleSize }: { keySplit: UserProfileInsights["keySplit"]; sampleSize: number }) {
  const colors: Record<number, string> = { 4: "bg-osu-blue", 7: "bg-osu-pink", 6: "bg-osu-purple", 9: "bg-osu-orange" };
  const textColors: Record<number, string> = { 4: "text-osu-blue", 7: "text-osu-pink-light", 6: "text-osu-purple-light", 9: "text-osu-orange" };

  return (
    <div className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20">
      <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Key Split</div>
      {keySplit.length > 0 ? (
        <>
          <div className="mt-2 flex rounded-full h-2.5 overflow-hidden bg-osu-b3/40">
            {keySplit.map((b) => (
              <div
                key={b.keyCount}
                className={`${colors[b.keyCount] ?? "bg-osu-b1"} transition-all duration-300`}
                style={{ width: `${(b.count / sampleSize) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
            {keySplit.map((b) => (
              <div key={b.keyCount} className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${colors[b.keyCount] ?? "bg-osu-b1"}`} />
                <span className={`text-xs font-bold ${textColors[b.keyCount] ?? "text-osu-f1"}`}>{b.keyCount}K</span>
                <span className="text-[10px] text-osu-f1 tabular-nums">{Math.round((b.count / sampleSize) * 100)}%</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-1.5 text-sm text-osu-f1">No key data</div>
      )}
    </div>
  );
}

function ExpandHint() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-osu-f1/30 group-hover:text-osu-f1 group-hover:translate-x-0.5 transition-all duration-150 flex-shrink-0"
      aria-hidden
    >
      <path d="M3.5 2 6.5 5 3.5 8" />
    </svg>
  );
}

function BpmExtremeRow({ label, bpm, snapshot }: { label: string; bpm: number; snapshot: InsightScoreSnapshot }) {
  return (
    <a
      href={snapshot.beatmapUrl}
      target="_blank"
      rel="noreferrer"
      className="block relative rounded-lg overflow-hidden border border-osu-b3/20 hover:border-osu-pink/30 transition-colors"
    >
      {snapshot.coverUrl && (
        <img src={snapshot.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/60 to-black/80" />
      <div className="relative p-2.5 flex items-center gap-2.5">
        <div className="flex-shrink-0 text-center w-14">
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
          <div className="text-lg font-bold text-white leading-none tabular-nums mt-0.5">{Math.round(bpm)}</div>
          <div className="text-[9px] text-osu-f1">BPM</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-white truncate">{snapshot.title}</div>
          <div className="text-[10px] text-osu-l2 truncate">{snapshot.artist} [{snapshot.version}]</div>
          {snapshot.mods.length > 0 && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              {snapshot.mods.map((mod) => (
                <ModBadge key={mod} mod={mod} size={0.7} />
              ))}
            </div>
          )}
        </div>
      </div>
    </a>
  );
}

function TopPlayCard({ label, snapshot }: { label: string; snapshot: InsightScoreSnapshot | null }) {
  if (!snapshot) {
    return (
      <div className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20">
        <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
        <div className="mt-1.5 text-sm text-osu-f1">No data</div>
      </div>
    );
  }

  return (
    <a
      href={snapshot.beatmapUrl}
      target="_blank"
      rel="noreferrer"
      className="block relative rounded-xl overflow-hidden border border-osu-b3/20 hover:border-osu-pink/30 transition-colors group/topplay"
    >
      {snapshot.coverUrl && (
        <img
          src={snapshot.coverUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/50 to-black/75" />
      <div className="relative p-3.5 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
          <div className="mt-1 text-sm font-bold text-white truncate">{snapshot.title}</div>
          <div className="text-[10px] text-osu-l2 truncate">{snapshot.artist} [{snapshot.version}]</div>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <GradeImg grade={snapshot.rank} size={18} />
            {snapshot.mods.map((mod) => (
              <ModBadge key={mod} mod={mod} />
            ))}
            <span className="text-[10px] text-osu-f1">{formatTimeAgo(snapshot.date)}</span>
            {snapshot.date && (
              <span className="text-[10px] text-osu-f1 hidden sm:inline">{formatDate(snapshot.date)}</span>
            )}
          </div>
        </div>
        {snapshot.pp != null && (
          <div className="flex-shrink-0 text-right">
            <div className="text-xl font-bold text-osu-pink-light leading-none">{Math.round(snapshot.pp)}</div>
            <div className="text-[10px] text-osu-f1 mt-0.5">pp</div>
          </div>
        )}
      </div>
    </a>
  );
}

function InsightsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-osu-b4 rounded-xl p-3.5 border border-osu-b3/20 h-[90px]">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-40 mt-2" />
            <Skeleton className="h-3 w-32 mt-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayerScoreRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 min-h-[63px]">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Skeleton className="w-7 h-7 rounded-full flex-shrink-0" />
        <Skeleton className="w-12 h-8 rounded flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-64 max-w-[55%]" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-5 rounded" />
          </div>
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="flex gap-0.5 justify-end w-24">
          <Skeleton className="h-5 w-14 rounded" />
        </div>
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-10" />
        <Skeleton className="h-5 w-16" />
      </div>
    </div>
  );
}

function ScoreThumbnail({ score }: { score: OsuScore }) {
  const [failed, setFailed] = useState(false);
  const coverUrl = score.beatmapset?.covers?.list
    ?? (score.beatmapset?.id ? `/api/background?beatmapsetId=${score.beatmapset.id}` : null);

  if (coverUrl && !failed) {
    return (
      <img
        src={coverUrl}
        alt=""
        className="w-12 h-8 rounded object-cover flex-shrink-0"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="relative w-12 h-8 rounded flex-shrink-0 overflow-hidden border border-osu-b3/50 bg-osu-b4">
      <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.07),transparent_48%),radial-gradient(circle_at_85%_20%,rgba(255,102,170,0.16),transparent_38%)]" />
      <div className="absolute inset-0 flex items-center justify-center gap-0.5 opacity-65">
        {[0, 1, 2, 3].map((lane) => (
          <span key={lane} className="h-3 w-1 rounded-full bg-osu-f1/70" />
        ))}
      </div>
    </div>
  );
}

function ScoreRow({ score, position }: { score: OsuScore; position: number }) {
  const keys = score.beatmap?.cs;
  const linkUrl = getScoreUrl(score) ?? getBeatmapUrl(score);
  const canReplay = scoreHasReplay(score);
  const display = getScoreDisplayValues(score);
  const hasPp = score.pp != null;

  const content = (
    <>
      <GradeImg grade={display.rank} size={28} />
      <ScoreThumbnail score={score} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">
            {score.beatmapset?.title || "Unknown"}
          </span>
          <span className="text-[10px] text-osu-f1 truncate hidden sm:inline">
            [{score.beatmap?.version}]
          </span>
          {keys && (
            <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
              {keys}K
            </span>
          )}
        </div>
        <span className="text-[10px] text-osu-f1">
          {score.beatmapset?.artist} &middot; {formatTimeAgo(getScoreTimestamp(score))}
        </span>
        {/* Mobile-only metadata row */}
        <div className="flex items-center gap-2 mt-0.5 sm:hidden">
          <div className="flex gap-0.5">
            {getModDisplayList(score.mods).map((m) => (
              <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
            ))}
          </div>
          <span className="text-xs text-osu-l2">{formatAccuracy(display.accuracy)}</span>
          <span className="text-xs text-osu-f1">{formatNumber(score.max_combo)}x</span>
          {hasPp && <span className="text-sm font-bold ml-auto">{formatPP(score.pp)}</span>}
        </div>
      </div>
      {/* Desktop metadata */}
      <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
        <div className="flex gap-0.5 justify-end w-24">
          {getModDisplayList(score.mods).map((m) => (
            <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
          ))}
        </div>
        {display.isLazer && (
          <LazerBadge />
        )}
        <span className="text-xs text-osu-l2">{formatAccuracy(display.accuracy)}</span>
        <span className="text-xs text-osu-f1">{formatNumber(score.max_combo)}x</span>
        {hasPp && (
          <span className="text-sm font-bold">{formatPP(score.pp)}</span>
        )}
      </div>
    </>
  );

  return (
    <div className="relative group/score flex items-center gap-2 sm:gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms]">
      {/* Mobile inline position number */}
      <span className="sm:hidden text-xs text-osu-f1 font-bold flex-shrink-0">{position}.</span>
      {/* Desktop hover position number */}
      <div
        className="pointer-events-none absolute -left-14 top-1/2 -translate-y-1/2 w-10 text-right text-white/90 opacity-0 translate-x-2 transition-all duration-150 ease-out group-hover/score:opacity-100 group-hover/score:translate-x-0 hidden sm:block"
        style={{ fontFamily: "Venera" }}
      >
        <span className="block text-[24px] leading-none">{position}</span>
      </div>
      {linkUrl ? (
        <a
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0 cursor-pointer"
        >
          {content}
        </a>
      ) : (
        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
          {content}
        </div>
      )}
      {canReplay && (
        <Link
          to="/replay"
          search={{ scoreId: score.id, beatmapsetId: score.beatmapset?.id }}
          className="hidden sm:block px-2.5 py-1.5 rounded-md bg-osu-pink/15 text-[10px] font-semibold text-osu-pink-light border border-osu-pink/20 hover:bg-osu-pink/25 transition-colors flex-shrink-0"
        >
          Replay
        </Link>
      )}
    </div>
  );
}
